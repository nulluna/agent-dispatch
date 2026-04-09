import { getRuntimeConfig, type DispatchEnv } from './config'
import { DispatchError, jsonErrorResponse } from './errors'
import { createRelayHeaders, cloneResponseHeaders } from './headers'
import { detectLlmRequestInfo, type LlmRequestInfo } from './request-protocol'
import { resolveIngressRequest } from './routing'
import {
  collectIgnoredAuthLikeHeaders,
  createDispatchState,
  recordChallengeAffinity,
  selectAgentproxy,
  type DispatchSelection,
  type DispatchState,
  type RelayStats,
  type StickyIdentifier,
} from './strategy'

export type { DispatchEnv } from './config'

export type FetchImplementation = (request: Request) => Promise<Response>

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }

  let mismatch = 0

  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return mismatch === 0
}

const defaultDispatchState = createDispatchState()
const RESPONSE_LOG_BODY_LIMIT = 512
const HTTP_STATUS_TEXTS = new Map<number, string>([
  [300, 'Multiple Choices'],
  [301, 'Moved Permanently'],
  [302, 'Found'],
  [303, 'See Other'],
  [304, 'Not Modified'],
  [307, 'Temporary Redirect'],
  [308, 'Permanent Redirect'],
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [402, 'Payment Required'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [406, 'Not Acceptable'],
  [407, 'Proxy Authentication Required'],
  [408, 'Request Timeout'],
  [409, 'Conflict'],
  [410, 'Gone'],
  [411, 'Length Required'],
  [412, 'Precondition Failed'],
  [413, 'Payload Too Large'],
  [414, 'URI Too Long'],
  [415, 'Unsupported Media Type'],
  [416, 'Range Not Satisfiable'],
  [417, 'Expectation Failed'],
  [418, "I'm a Teapot"],
  [421, 'Misdirected Request'],
  [422, 'Unprocessable Content'],
  [423, 'Locked'],
  [424, 'Failed Dependency'],
  [425, 'Too Early'],
  [426, 'Upgrade Required'],
  [428, 'Precondition Required'],
  [429, 'Too Many Requests'],
  [431, 'Request Header Fields Too Large'],
  [451, 'Unavailable For Legal Reasons'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
  [504, 'Gateway Timeout'],
])

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])
const CHALLENGE_SET_COOKIE_PATTERN = /(?:^|[;,]\s*)(acw_tc|cdn_sec_tc|acw_sc__v2)=/i

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name) || name.includes('token') || name.includes('secret')
}

function redactHeaderValue(value: string): string {
  if (value.length <= 8) {
    return '***'
  }

  return `${value.slice(0, 8)}***`
}

function serializeHeaders(headers: Headers): Record<string, string> {
  const serialized: Record<string, string> = {}

  for (const [name, value] of headers.entries()) {
    serialized[name] = isSensitiveHeader(name.toLowerCase())
      ? redactHeaderValue(value)
      : value
  }

  return serialized
}

function redactHeaderRecord(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {}

  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = redactHeaderValue(value)
  }

  return redacted
}

function getSetCookieHeaderValues(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie

  if (typeof getSetCookie === 'function') {
    const values = getSetCookie.call(headers)

    if (values.length > 0) {
      return values
    }
  }

  const singleValue = headers.get('set-cookie')

  return singleValue ? [singleValue] : []
}

function hasChallengeSetCookie(headers: Headers): boolean {
  return getSetCookieHeaderValues(headers).some(value => CHALLENGE_SET_COOKIE_PATTERN.test(value))
}

function parseCookieHeader(cookieHeader: string | null): Array<{ name: string; value: string }> {
  if (!cookieHeader) {
    return []
  }

  return cookieHeader
    .split(';')
    .map(segment => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => {
      const separatorIndex = segment.indexOf('=')

      if (separatorIndex <= 0) {
        return []
      }

      const name = segment.slice(0, separatorIndex).trim()
      const value = segment.slice(separatorIndex + 1).trim()

      if (!name || !value) {
        return []
      }

      return [{ name, value }]
    })
}

function resolveChallengeStickyIdentifier(headers: Headers): StickyIdentifier | undefined {
  const challengeCookieMatches = new Map<string, StickyIdentifier>()

  for (const cookie of parseCookieHeader(headers.get('cookie'))) {
    const normalizedName = cookie.name.toLowerCase()

    if (
      !challengeCookieMatches.has(normalizedName) &&
      (normalizedName === 'acw_tc' ||
        normalizedName === 'cdn_sec_tc' ||
        normalizedName === 'acw_sc__v2')
    ) {
      challengeCookieMatches.set(normalizedName, {
        source: `cookie-${normalizedName}`,
        hashValue: cookie.value,
      })
    }
  }

  return (
    challengeCookieMatches.get('acw_tc') ??
    challengeCookieMatches.get('cdn_sec_tc') ??
    challengeCookieMatches.get('acw_sc__v2')
  )
}

function getChallengeResponseStickyIdentifiers(
  requestHeaders: Headers,
  responseHeaders: Headers,
): StickyIdentifier[] {
  const identifiers = new Map<string, StickyIdentifier>()
  const requestIdentifier = resolveChallengeStickyIdentifier(requestHeaders)

  if (requestIdentifier) {
    identifiers.set(requestIdentifier.source, requestIdentifier)
  }

  for (const value of getSetCookieHeaderValues(responseHeaders)) {
    const separatorIndex = value.indexOf('=')

    if (separatorIndex <= 0) {
      continue
    }

    const rawName = value.slice(0, separatorIndex).trim()
    const normalizedName = rawName.toLowerCase()

    if (
      normalizedName !== 'acw_tc' &&
      normalizedName !== 'cdn_sec_tc' &&
      normalizedName !== 'acw_sc__v2'
    ) {
      continue
    }

    const cookieValue = value
      .slice(separatorIndex + 1)
      .split(';', 1)[0]
      ?.trim()

    if (!cookieValue) {
      continue
    }

    identifiers.set(`cookie-${normalizedName}`, {
      source: `cookie-${normalizedName}`,
      hashValue: cookieValue,
    })
  }

  return [...identifiers.values()]
}

function isChallengeResponse(response: Response): boolean {
  return response.headers.has('x-tengine-error') || hasChallengeSetCookie(response.headers)
}

function serializeSelection(selection: DispatchSelection): Record<string, number | string> {
  const baseSelection = {
    strategy: selection.strategy,
    poolLength: selection.poolLength,
    selectedIndex: selection.proxyIndex,
  }

  if (selection.strategy === 'hash') {
    if (selection.selectionMode === 'site-fallback') {
      return {
        ...baseSelection,
        stickySource: selection.stickySource,
        expiresAt: selection.expiresAt,
      }
    }

    return {
      ...baseSelection,
      stickySource: selection.stickySource,
      accountHash: selection.accountHash,
      hashValue: selection.hashValue,
    }
  }

  return baseSelection
}

function buildRelayUrl(
  proxyBaseUrl: URL,
  dispatchSecret: string,
  targetAuthority: string,
  upstreamUrl: URL,
): URL {
  const relayPrefix = upstreamUrl.protocol === 'https:' ? 's' : 'h'
  const relayUrl = new URL(proxyBaseUrl)
  const basePath = relayUrl.pathname === '/' ? '' : relayUrl.pathname.replace(/\/+$/g, '')

  relayUrl.pathname =
    `${basePath}/relay/${encodeURIComponent(dispatchSecret)}/${relayPrefix}/${targetAuthority}${upstreamUrl.pathname}` || '/'
  relayUrl.search = upstreamUrl.search

  return relayUrl
}

function createRelayRequestFactory(
  request: Request,
  relayUrl: URL,
  bufferedBody: ArrayBuffer | null,
): (signal: AbortSignal) => Request {
  const headers = createRelayHeaders(request.headers)
  const method = request.method

  return (signal: AbortSignal) => {
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      redirect: 'manual',
      signal,
    }

    if (bufferedBody !== null) {
      init.body = bufferedBody
      init.duplex = 'half'
    }

    return new Request(relayUrl, init)
  }
}

function createTimedResponseBody(
  response: Response,
  timeoutMs: number,
  context: {
    requestPath: string
    upstreamUrl: string
  },
): ReadableStream<Uint8Array> | null {
  if (response.body === null) {
    return null
  }

  const reader = response.body.getReader()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      try {
        const result = await new Promise<ReadableStreamReadResult<Uint8Array>>(
          (resolve, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error('内部 relay 响应超时'))
            }, timeoutMs)

            reader.read().then(resolve, reject)
          },
        )

        clearTimeout(timeoutId)

        if (result.done) {
          controller.close()
          return
        }

        controller.enqueue(result.value)
      } catch (error) {
        clearTimeout(timeoutId)
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.warn('[agent-dispatch] relay response bridge failed', {
          requestPath: context.requestPath,
          upstreamUrl: context.upstreamUrl,
          status: response.status,
          contentType: response.headers.get('content-type'),
          error: errorMessage,
        })
        await reader.cancel(error).catch(() => undefined)

        if (errorMessage === 'Network connection lost.') {
          try {
            controller.close()
          } catch {
            // 流已关闭时忽略，避免再把 bridge 错误升级为运行时未捕获异常。
          }
          return
        }

        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}

const STREAMING_RESPONSE_CONTENT_TYPES = [
  'text/event-stream',
  'application/x-ndjson',
  'application/json-seq',
]

function shouldApplyRelayResponseTimeout(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''

  return STREAMING_RESPONSE_CONTENT_TYPES.some(type => contentType.startsWith(type))
}

function buildDispatchPathFromUrl(targetUrl: URL): string {
  const authority = encodeURIComponent(targetUrl.host)
  const prefix = targetUrl.protocol === 'https:' ? '/s' : '/h'

  return `${prefix}/${authority}${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
}

function isAlreadyDispatchedPath(location: string): boolean {
  return /^\/(?:s|h)\/[^/?#]+(?:[/?#]|$)/.test(location)
}

function toCurrentDomainUrl(path: string, currentDomain: string): string {
  return `http://${currentDomain}${path}`
}

function rewriteRedirectLocation(location: string, upstreamUrl: URL, currentDomain: string): string {
  if (isAlreadyDispatchedPath(location)) {
    return currentDomain ? toCurrentDomainUrl(location, currentDomain) : location
  }

  let redirectUrl: URL

  try {
    redirectUrl = new URL(location, upstreamUrl)
  } catch {
    return location
  }

  if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') {
    return location
  }

  const rewrittenPath = buildDispatchPathFromUrl(redirectUrl)

  return currentDomain ? toCurrentDomainUrl(rewrittenPath, currentDomain) : rewrittenPath
}

function rewriteRefreshHeader(refresh: string, upstreamUrl: URL, currentDomain: string): string {
  const match = refresh.match(/^(\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*)(.*?)(\s*)$/i)

  if (!match) {
    return refresh
  }

  const prefix = match[1] ?? ''
  const rawTarget = match[2] ?? ''
  const suffix = match[3] ?? ''
  let target: string = rawTarget
  let quote = ''

  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    quote = target[0] ?? ''
    target = target.slice(1, -1)
  }

  return `${prefix}${quote}${rewriteRedirectLocation(target, upstreamUrl, currentDomain)}${quote}${suffix}`
}

function createClientResponseHeaders(
  response: Response,
  upstreamUrl: URL,
  currentDomain: string,
): Headers {
  const headers = cloneResponseHeaders(response)
  const location = headers.get('location')
  const refresh = headers.get('refresh')

  if (location) {
    headers.set('location', rewriteRedirectLocation(location, upstreamUrl, currentDomain))
  }

  if (refresh) {
    headers.set('refresh', rewriteRefreshHeader(refresh, upstreamUrl, currentDomain))
  }

  return headers
}

function createClientResponse(
  response: Response,
  timeoutMs: number,
  requestPath: string,
  upstreamUrl: URL,
  currentDomain: string,
): Response {
  const body = shouldApplyRelayResponseTimeout(response)
    ? createTimedResponseBody(response, timeoutMs, {
        requestPath,
        upstreamUrl: upstreamUrl.toString(),
      })
    : response.body

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: createClientResponseHeaders(response, upstreamUrl, currentDomain),
  })
}

function formatRequestPath(requestUrl: URL): string {
  return `${requestUrl.pathname}${requestUrl.search}`
}

function getResponseStatusText(response: Response): string {
  return response.statusText || HTTP_STATUS_TEXTS.get(response.status) || `HTTP ${response.status}`
}

function truncateLogText(value: string): string {
  if (value.length <= RESPONSE_LOG_BODY_LIMIT) {
    return value
  }

  return `${value.slice(0, RESPONSE_LOG_BODY_LIMIT)}...`
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function extractErrorLogFields(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  const record = payload as Record<string, unknown>
  const nestedError = record.error

  if (nestedError && typeof nestedError === 'object') {
    const nestedRecord = nestedError as Record<string, unknown>
    const error = readStringField(nestedRecord, 'code')
      || readStringField(nestedRecord, 'error')
      || readStringField(nestedRecord, 'type')
    const message = readStringField(nestedRecord, 'message')
      || readStringField(record, 'message')

    return {
      ...(error ? { error } : {}),
      ...(message ? { message } : {}),
    }
  }

  const error = readStringField(record, 'code')
    || readStringField(record, 'error')
  const message = readStringField(record, 'message')

  return {
    ...(error ? { error } : {}),
    ...(message ? { message } : {}),
  }
}

async function buildErrorLogFields(response: Response): Promise<Record<string, string>> {
  if (response.body === null) {
    return {}
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''

  if (!contentType.includes('json') && !contentType.startsWith('text/')) {
    return {}
  }

  const bodyText = truncateLogText(await response.clone().text()).trim()

  if (!bodyText) {
    return {}
  }

  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(bodyText) as unknown
      const extracted = extractErrorLogFields(parsed)

      if (Object.keys(extracted).length > 0) {
        return extracted
      }
    } catch {
      // 解析失败时回退到纯文本摘要
    }
  }

  return { message: bodyText }
}

function build3xxLogFields(response: Response): Record<string, string> {
  const location = response.headers.get('location')
  const refresh = response.headers.get('refresh')

  return {
    ...(location ? { location } : {}),
    ...(refresh ? { refresh } : {}),
  }
}

function formatResponseInfoLine(
  request: Request,
  requestUrl: URL,
  response: Response,
  startedAtMs: number,
): string {
  const durationMs = Math.max(0, Date.now() - startedAtMs)

  return `[wrangler:info] ${request.method} ${formatRequestPath(requestUrl)} ${response.status} ${getResponseStatusText(response)} (${durationMs}ms)`
}

function buildRequestInfoLogFields(requestInfo: LlmRequestInfo | null): Record<string, string> {
  if (!requestInfo) {
    return {}
  }

  return {
    protocol: requestInfo.protocol,
    modelId: requestInfo.modelId,
    userAgent: requestInfo.userAgent,
  }
}

async function logFinalResponse(
  request: Request,
  requestUrl: URL,
  response: Response,
  startedAtMs: number,
  requestInfo: LlmRequestInfo | null = null,
): Promise<Response> {
  const requestInfoFields = buildRequestInfoLogFields(requestInfo)

  if (response.status >= 300 && response.status < 400) {
    const details = {
      ...requestInfoFields,
      ...build3xxLogFields(response),
    }

    if (Object.keys(details).length > 0) {
      console.info(formatResponseInfoLine(request, requestUrl, response, startedAtMs), details)
    }

    return response
  }

  if (response.status >= 400 && response.status < 600) {
    const details = {
      ...requestInfoFields,
      ...(await buildErrorLogFields(response)),
    }
    console.info(formatResponseInfoLine(request, requestUrl, response, startedAtMs), details)
    return response
  }

  if (Object.keys(requestInfoFields).length > 0) {
    console.info(formatResponseInfoLine(request, requestUrl, response, startedAtMs), requestInfoFields)
  }

  return response
}

const RELAY_RETRY_DELAYS_MS = [0, 500, 1000]

function createDnsResolveFetch(
  fetchImpl: FetchImplementation,
  dnsResolve: Map<string, string>,
): FetchImplementation {
  if (dnsResolve.size === 0) return fetchImpl

  return async (request: Request) => {
    const url = new URL(request.url)
    const resolved = dnsResolve.get(url.hostname)

    if (!resolved) return fetchImpl(request)

    const originalHostname = url.hostname
    const resolvedUrl = new URL(request.url)
    resolvedUrl.hostname = resolved

    const headers = new Headers(request.headers)
    headers.set('host', originalHostname)

    console.info('[agent-dispatch] dns resolve applied', {
      original: originalHostname,
      resolved,
    })

    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      redirect: request.redirect,
      signal: request.signal,
    }

    if (request.body) {
      init.body = request.body
      init.duplex = 'half'
    }

    return fetchImpl(new Request(resolvedUrl, init))
  }
}

async function fetchRelayResponse(
  createRequest: (signal: AbortSignal) => Request,
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  backendInfo: { backend: string; proxyIndex: number },
  relayStats: RelayStats,
): Promise<Response> {
  const maxAttempts = RELAY_RETRY_DELAYS_MS.length + 1
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = RELAY_RETRY_DELAYS_MS[attempt - 1] ?? 0
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      // (a) 输出本次 retry 的 backend 信息
      console.info('[agent-dispatch] relay connect retry', {
        attempt,
        delay,
        backend: backendInfo.backend,
        proxyIndex: backendInfo.proxyIndex,
      })
    }

    // (b) 每次 retry 使用独立的 AbortController，确保新建连接
    const abortController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      const response = await new Promise<Response>((resolve, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort()
          reject(new DispatchError(504, 'RELAY_CONNECT_TIMEOUT', '内部 relay 连接超时'))
        }, timeoutMs)

        // (b) 每次调用 createRequest 生成新 Request 实例，避免复用被中止的连接
        fetchImplementation(createRequest(abortController.signal)).then(resolve, reject)
      })

      // (c) 记录 retry 成功
      if (attempt > 0) {
        relayStats.retrySuccesses++
        console.info('[agent-dispatch] relay retry succeeded', {
          attempt,
          backend: backendInfo.backend,
          totalTimeoutFailures: relayStats.timeoutFailures,
          totalRetrySuccesses: relayStats.retrySuccesses,
        })
      }

      return response
    } catch (error) {
      lastError = error
      // 仅对 relay 连接超时重试，其他错误立即抛出
      if (!(error instanceof DispatchError && error.code === 'RELAY_CONNECT_TIMEOUT')) {
        throw error
      }
      // (c) 记录 timeout 失败
      relayStats.timeoutFailures++
      console.warn('[agent-dispatch] relay connect timeout', {
        attempt,
        backend: backendInfo.backend,
        proxyIndex: backendInfo.proxyIndex,
        totalTimeoutFailures: relayStats.timeoutFailures,
        totalRetrySuccesses: relayStats.retrySuccesses,
      })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  throw lastError
}

export async function handleDispatchRequest(
  request: Request,
  env: DispatchEnv = {},
  fetchImplementation: FetchImplementation = fetch,
  state: DispatchState = defaultDispatchState,
): Promise<Response> {
  const startedAtMs = Date.now()
  const requestUrl = new URL(request.url)
  let requestInfo: LlmRequestInfo | null = null

  try {
    const config = getRuntimeConfig(env)

    if (config.ingressKey) {
      const clientToken = request.headers.get(config.ingressHeader)

      if (!clientToken || !timingSafeEqual(clientToken, config.ingressKey)) {
        throw new DispatchError(401, 'INGRESS_UNAUTHORIZED', '入口认证失败')
      }
    }

    const ingress = resolveIngressRequest(requestUrl)
    const selection = selectAgentproxy(
      config.dispatchStrategy,
      config.agentproxyPool.length,
      ingress.authority,
      request.headers,
      state,
    )

    if (selection.strategy === 'hash' && selection.selectionMode === 'site-fallback') {
      const ignoredAuthLikeHeaders = collectIgnoredAuthLikeHeaders(request.headers)

      if (Object.keys(ignoredAuthLikeHeaders).length > 0) {
        console.info('[agent-dispatch] sticky auth-like headers ignored', {
          targetAuthority: ingress.authority,
          headers: redactHeaderRecord(ignoredAuthLikeHeaders),
        })
      }
    }

    const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'
    const bufferedBody = hasBody ? await new Response(request.body).arrayBuffer() : null
    requestInfo = detectLlmRequestInfo(request, ingress.upstreamUrl, bufferedBody)

    // 负向缓存：构建缓存 key
    const negativeCache = state.negativeCache
    let cacheKey: string | null = null
    let accountBound = false

    if (config.negativeCacheEnabled && selection.strategy === 'hash') {
      const accountId = selection.selectionMode === 'sticky-hash'
        ? selection.accountHash
        : `__site:${ingress.authority}`

      accountBound = selection.selectionMode === 'sticky-hash'
      cacheKey = negativeCache.buildCacheKey(
        accountId,
        request.method,
        ingress.upstreamUrl.pathname,
        ingress.upstreamUrl.search,
      )

      const cached = negativeCache.lookup(cacheKey)

      if (cached) {
        console.info('[agent-dispatch] negative cache hit', {
          cacheKey,
          status: cached.status,
          expiresAt: cached.expiresAt,
        })

        return logFinalResponse(
          request,
          requestUrl,
          negativeCache.createCachedResponse(cached),
          startedAtMs,
          requestInfo,
        )
      }
    }

    const proxyIndex = selection.proxyIndex
    const proxyBaseUrl = config.agentproxyPool[proxyIndex]

    if (!proxyBaseUrl) {
      throw new DispatchError(500, 'INVALID_CONFIGURATION', '选中的 agentproxy 节点不存在')
    }

    if (config.logLevel === 'debug') {
      console.debug('[agent-dispatch] debug request', {
        headers: serializeHeaders(request.headers),
        selection: serializeSelection(selection),
        targetAuthority: ingress.authority,
      })
    }

    console.info('[agent-dispatch] selected backend', {
      strategy: config.dispatchStrategy,
      proxyIndex,
      backend: proxyBaseUrl.toString(),
      targetAuthority: ingress.authority,
    })

    const relayUrl = buildRelayUrl(
      proxyBaseUrl,
      config.dispatchSecret,
      ingress.authority,
      ingress.upstreamUrl,
    )
    const createRelayRequest = createRelayRequestFactory(request, relayUrl, bufferedBody)
    const resolvedFetch = createDnsResolveFetch(fetchImplementation, config.dnsResolve)

    const relayResponse = await fetchRelayResponse(
      createRelayRequest,
      resolvedFetch,
      config.relayConnectTimeoutMs,
      { backend: proxyBaseUrl.toString(), proxyIndex },
      state.relayStats,
    )
    const challengeResponse = isChallengeResponse(relayResponse)

    // 负向缓存：记录上游响应
    if (challengeResponse) {
      const challengeStickyIdentifiers = getChallengeResponseStickyIdentifiers(
        request.headers,
        relayResponse.headers,
      )

      for (const stickyIdentifier of challengeStickyIdentifiers) {
        recordChallengeAffinity(ingress.authority, stickyIdentifier, proxyIndex, state)
      }

      if (challengeStickyIdentifiers.length > 0) {
        console.info('[agent-dispatch] challenge affinity recorded', {
          targetAuthority: ingress.authority,
          proxyIndex,
          sources: challengeStickyIdentifiers.map(({ source }) => source),
        })
      }
    }

    if (cacheKey) {
      if (negativeCache.isCacheableResponse(relayResponse.status, accountBound) && !challengeResponse) {
        // 可缓存状态码：tee 流，一份缓存一份返回客户端
        const responseBody = relayResponse.body
        let cacheBody: ArrayBuffer
        let clientBody: ReadableStream<Uint8Array> | null

        if (responseBody) {
          const [clientStream, cacheStream] = responseBody.tee()
          cacheBody = await new Response(cacheStream).arrayBuffer()
          clientBody = clientStream
        } else {
          cacheBody = new ArrayBuffer(0)
          clientBody = null
        }

        negativeCache.recordResponse(
          cacheKey,
          relayResponse.status,
          relayResponse.headers,
          cacheBody,
          accountBound,
        )

        console.info('[agent-dispatch] negative cache recorded', {
          cacheKey,
          status: relayResponse.status,
          accountBound,
        })

        // body 已被 cacheStream 完整消费，clientStream 数据已就绪，无需超时保护
        return logFinalResponse(
          request,
          requestUrl,
          new Response(clientBody, {
            status: relayResponse.status,
            statusText: relayResponse.statusText,
            headers: createClientResponseHeaders(relayResponse, ingress.upstreamUrl, config.currentDomain),
          }),
          startedAtMs,
          requestInfo,
        )
      }

      if (challengeResponse) {
        negativeCache.delete(cacheKey)
      }

      // 非可缓存状态码：仅当存在缓存条目时才清除（探测成功场景）
      if (!challengeResponse && negativeCache.entries.has(cacheKey)) {
        negativeCache.recordResponse(
          cacheKey,
          relayResponse.status,
          relayResponse.headers,
          new ArrayBuffer(0),
          accountBound,
        )
      }
    }

    return logFinalResponse(
      request,
      requestUrl,
      createClientResponse(
        relayResponse,
        config.relayResponseTimeoutMs,
        formatRequestPath(requestUrl),
        ingress.upstreamUrl,
        config.currentDomain,
      ),
      startedAtMs,
      requestInfo,
    )
  } catch (error) {
    if (error instanceof DispatchError) {
      return logFinalResponse(
        request,
        requestUrl,
        error.toResponse(),
        startedAtMs,
        requestInfo,
      )
    }

    return logFinalResponse(
      request,
      requestUrl,
      jsonErrorResponse(502, 'RELAY_FETCH_FAILED', '内部 relay 请求失败'),
      startedAtMs,
      requestInfo,
    )
  }
}
