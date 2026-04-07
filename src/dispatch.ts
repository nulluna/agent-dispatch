import type { BackendSelectionStrategy, RuntimeConfig } from './config.js'
import { DispatchError } from './errors.js'
import type { ProxyRoute } from './routing.js'
import { buildUpstreamUrlFromRoute, rewriteResponseHeaders } from './rewrite.js'

export type FetchImplementation = (request: Request) => Promise<Response>

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const INTERNAL_PROXY_HEADERS = new Set([
  'forwarded',
  'via',
  'x-dispatch-target-host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
])

const RESPONSE_HEADERS_TO_DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
])

function collectDebugHeaders(headers: Headers): Record<string, string | null> {
  return {
    'content-type': headers.get('content-type'),
    'content-encoding': headers.get('content-encoding'),
    'content-length': headers.get('content-length'),
    'transfer-encoding': headers.get('transfer-encoding'),
    location: headers.get('location'),
  }
}

function logDispatch(stage: string, payload: Record<string, unknown>): void {
  console.info(`[agent-dispatch] ${stage}`, JSON.stringify(payload))
}

function logDispatchResponseHeaders(stage: string, headers: Headers): void {
  logDispatch(stage, { headers: collectDebugHeaders(headers) })
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

let nextProxyIndex = 0
const unhealthyUntil = new Map<string, number>()

interface ReplayableRequest {
  method: string
  headers: Headers
  body?: ArrayBuffer
}

interface StreamForwardRequest {
  method: string
  headers: Headers
  body: ReadableStream<Uint8Array>
}

type ForwardRequest = ReplayableRequest | StreamForwardRequest

interface AttemptControllerState {
  signal: AbortSignal
  cleanup: () => void
  timedOut: () => boolean
  abortedByCaller: () => boolean
}

export function resetProxyRotation(): void {
  nextProxyIndex = 0
  unhealthyUntil.clear()
}

function reserveStartIndex(proxyCount: number): number {
  const index = nextProxyIndex % proxyCount
  nextProxyIndex = (nextProxyIndex + 1) % proxyCount

  return index
}

function hashString(value: string): number {
  let hash = 0x811c9dc5

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return hash >>> 0
}

function buildConsistentHashKey(route: ProxyRoute): string {
  return `${route.protocolCode}:${route.targetHost}:${route.targetPathname}`
}

function selectStartIndex(options: {
  strategy: BackendSelectionStrategy
  route: ProxyRoute
  preferredCount: number
}): number {
  const { strategy, route, preferredCount } = options

  if (strategy === 'round-robin') {
    return reserveStartIndex(preferredCount)
  }

  return hashString(buildConsistentHashKey(route)) % preferredCount
}

function trimTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function normalizeSearch(search: string): string {
  return search ? (search.startsWith('?') ? search : `?${search}`) : ''
}

function normalizeTargetPath(pathname: string): string {
  return pathname.startsWith('/') ? pathname : `/${pathname}`
}

function validateRelayPart(value: string, fieldName: string): void {
  if (!value || value.includes('/')) {
    throw new DispatchError(500, 'INVALID_RELAY_PART', `${fieldName} 无法编码到 relay path`)
  }
}

function getSetCookieValues(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie

  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers)
  }

  const singleValue = headers.get('set-cookie')

  return singleValue ? [singleValue] : []
}

function cloneResponseHeaders(response: Response): Headers {
  const headers = new Headers()

  for (const [name, value] of response.headers.entries()) {
    const lowerName = name.toLowerCase()

    if (lowerName === 'set-cookie' || RESPONSE_HEADERS_TO_DROP.has(lowerName)) {
      continue
    }

    headers.append(name, value)
  }

  for (const value of getSetCookieValues(response.headers)) {
    headers.append('set-cookie', value)
  }

  return headers
}

function filterForwardHeaders(headers: Headers): Headers {
  const forwarded = new Headers()

  for (const [name, value] of headers.entries()) {
    const lowerName = name.toLowerCase()

    if (HOP_BY_HOP_HEADERS.has(lowerName) || INTERNAL_PROXY_HEADERS.has(lowerName)) {
      continue
    }

    forwarded.append(name, value)
  }

  return forwarded
}

async function readReplayableBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.body === null || request.method === 'GET' || request.method === 'HEAD') {
    return undefined
  }

  const body = await request.arrayBuffer()

  return body.byteLength > 0 ? body : undefined
}

async function createReplayableRequest(request: Request): Promise<ReplayableRequest> {
  return {
    method: request.method,
    headers: filterForwardHeaders(request.headers),
    body: await readReplayableBody(request),
  }
}

function createStreamForwardRequest(request: Request): StreamForwardRequest {
  if (request.body === null) {
    throw new DispatchError(500, 'MISSING_REQUEST_BODY', '流式请求缺少 body')
  }

  return {
    method: request.method,
    headers: filterForwardHeaders(request.headers),
    body: request.body,
  }
}

function canStreamRequestBody(request: Request): boolean {
  return request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'
}

function createAttemptController(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): AttemptControllerState {
  const controller = new AbortController()
  let timedOut = false
  let abortedByCaller = false

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('request timeout'))
  }, timeoutMs)

  const handleAbort = () => {
    abortedByCaller = true
    controller.abort(parentSignal?.reason)
  }

  if (parentSignal) {
    if (parentSignal.aborted) {
      handleAbort()
    } else {
      parentSignal.addEventListener('abort', handleAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      parentSignal?.removeEventListener('abort', handleAbort)
    },
    timedOut: () => timedOut,
    abortedByCaller: () => abortedByCaller,
  }
}

function createRelayRequest(
  relayUrl: URL,
  request: ForwardRequest,
  signal: AbortSignal,
): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: request.headers,
    redirect: 'manual',
    signal,
  }

  if ('body' in request && request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body instanceof ArrayBuffer ? request.body.slice(0) : request.body
    init.duplex = 'half'
  }

  return new Request(relayUrl, init)
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }

  const withCode = error as { code?: unknown }

  return typeof withCode.code === 'string' ? withCode.code : undefined
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return error.name === 'AbortError' || error.message === 'This operation was aborted'
}

function shouldFailover(error: unknown, state: AttemptControllerState): boolean {
  if (state.abortedByCaller()) {
    return false
  }

  if (state.timedOut()) {
    return true
  }

  if (isAbortError(error)) {
    return true
  }

  const code = getErrorCode(error)

  return code ? RETRYABLE_NETWORK_ERROR_CODES.has(code) : false
}

function markProxyUnhealthy(proxyUrl: URL, cooldownMs: number): void {
  unhealthyUntil.set(proxyUrl.toString(), Date.now() + cooldownMs)
}

function isProxyCoolingDown(proxyUrl: URL): boolean {
  const until = unhealthyUntil.get(proxyUrl.toString())

  if (!until) {
    return false
  }

  if (until <= Date.now()) {
    unhealthyUntil.delete(proxyUrl.toString())
    return false
  }

  return true
}

function getProxyCandidates(proxyUrls: URL[]): {
  candidates: URL[]
  preferredCount: number
} {
  const healthy: URL[] = []
  const cooling: URL[] = []

  for (const proxyUrl of proxyUrls) {
    if (isProxyCoolingDown(proxyUrl)) {
      cooling.push(proxyUrl)
    } else {
      healthy.push(proxyUrl)
    }
  }

  if (healthy.length > 0) {
    return {
      candidates: [...healthy, ...cooling],
      preferredCount: healthy.length,
    }
  }

  return {
    candidates: [...proxyUrls],
    preferredCount: proxyUrls.length,
  }
}

function buildExhaustedProxyError(lastError: unknown, sawTimeout: boolean): DispatchError {
  if (lastError instanceof DispatchError) {
    return lastError
  }

  if (sawTimeout) {
    return new DispatchError(504, 'UPSTREAM_TIMEOUT', '所有代理节点请求超时')
  }

  return new DispatchError(502, 'UPSTREAM_FETCH_FAILED', '所有代理节点请求失败')
}

export function buildRelayUrl(proxyBaseUrl: URL, secret: string, route: ProxyRoute): URL {
  validateRelayPart(secret, 'dispatchSecret')
  validateRelayPart(route.protocolCode, 'protocolCode')
  validateRelayPart(route.targetHost, 'targetHost')

  const relayUrl = new URL(proxyBaseUrl)
  const proxyBasePath = trimTrailingSlash(relayUrl.pathname)
  const targetPath = normalizeTargetPath(route.targetPathname)
  const encodedHost = encodeURIComponent(route.targetHost)

  relayUrl.pathname = `${proxyBasePath}/relay/${secret}/${route.protocolCode}/${encodedHost}${targetPath}`
  relayUrl.search = normalizeSearch(route.targetSearch)

  return relayUrl
}

function createClientResponse(
  request: Request,
  route: ProxyRoute,
  response: Response,
): Response {
  const upstreamUrl = buildUpstreamUrlFromRoute(route)
  const dispatchUrl = new URL(request.url)

  logDispatchResponseHeaders('relay-upstream-response', response.headers)

  const headers =
    route.routingMode === 'transparent'
      ? cloneResponseHeaders(response)
      : rewriteResponseHeaders(cloneResponseHeaders(response), upstreamUrl, dispatchUrl)
  const clientResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })

  logDispatchResponseHeaders('relay-client-response', clientResponse.headers)

  return clientResponse
}

export async function dispatchRequest(
  request: Request,
  route: ProxyRoute,
  config: RuntimeConfig,
  fetchImplementation: FetchImplementation = (relayRequest) => fetch(relayRequest),
): Promise<Response> {
  if (canStreamRequestBody(request)) {
    const { candidates, preferredCount } = getProxyCandidates(config.proxyUrls)
    const startIndex = selectStartIndex({
      strategy: config.backendSelectionStrategy,
      route,
      preferredCount,
    })
    const proxyUrl = candidates[startIndex % candidates.length]
    const relayUrl = buildRelayUrl(proxyUrl, config.dispatchSecret, route)
    const controllerState = createAttemptController(request.signal, config.requestTimeoutMs)

    logDispatch('relay-request', {
      mode: 'stream',
      method: request.method,
      requestUrl: request.url,
      relayUrl: relayUrl.toString(),
      proxyUrl: proxyUrl.toString(),
      allowFailover: false,
      hasBody: true,
      strategy: config.backendSelectionStrategy,
    })

    try {
      const relayRequest = createRelayRequest(
        relayUrl,
        createStreamForwardRequest(request),
        controllerState.signal,
      )
      const response = await fetchImplementation(relayRequest)

      return createClientResponse(request, route, response)
    } catch (error) {
      if (controllerState.timedOut()) {
        markProxyUnhealthy(proxyUrl, config.failoverCooldownMs)
        throw buildExhaustedProxyError(error, true)
      }

      throw error
    } finally {
      controllerState.cleanup()
    }
  }

  const replayableRequest = await createReplayableRequest(request)
  const { candidates, preferredCount } = getProxyCandidates(config.proxyUrls)
  const startIndex = selectStartIndex({
    strategy: config.backendSelectionStrategy,
    route,
    preferredCount,
  })
  let lastError: unknown
  let sawTimeout = false

  logDispatch('relay-request', {
    mode: 'replayable',
    method: request.method,
    requestUrl: request.url,
    candidateCount: candidates.length,
    preferredCount,
    allowFailover: true,
    hasBody: replayableRequest.body !== undefined,
    strategy: config.backendSelectionStrategy,
  })

  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const proxyUrl = candidates[(startIndex + attempt) % candidates.length]
    const relayUrl = buildRelayUrl(proxyUrl, config.dispatchSecret, route)
    const controllerState = createAttemptController(request.signal, config.requestTimeoutMs)

    logDispatch('relay-attempt', {
      attempt: attempt + 1,
      strategy: config.backendSelectionStrategy,
      requestUrl: request.url,
      proxyUrl: proxyUrl.toString(),
      relayUrl: relayUrl.toString(),
    })

    try {
      const relayRequest = createRelayRequest(relayUrl, replayableRequest, controllerState.signal)
      const response = await fetchImplementation(relayRequest)

      return createClientResponse(request, route, response)
    } catch (error) {
      lastError = error

      if (controllerState.timedOut()) {
        sawTimeout = true
      }

      const shouldRetry = shouldFailover(error, controllerState)

      if (!shouldRetry) {
        throw error
      }

      markProxyUnhealthy(proxyUrl, config.failoverCooldownMs)
    } finally {
      controllerState.cleanup()
    }
  }

  throw buildExhaustedProxyError(lastError, sawTimeout)
}
