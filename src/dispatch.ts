import { type Dispatcher } from 'undici'

import type { RuntimeConfig } from './config.js'
import { DispatchError } from './errors.js'
import { type LogWriter } from './logging.js'
import type { ProxyRoute } from './routing.js'
import { buildUpstreamUrlFromRoute, rewriteResponseHeaders } from './rewrite.js'
import {
  closeProxyDispatcher,
  createProxyDispatcher,
  dispatchAcrossProxies,
  type ProxyDispatchResult,
  type ProxyFetchImplementation,
  type ProxyFetchInit,
  type ProxyFetchResponse,
  type ReplayableRequest,
} from './proxy-dispatcher.js'

export type FetchImplementation = (input: URL | string, init?: RequestInit) => Promise<Response>

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
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

export function buildRelayUrl(proxyBaseUrl: URL, secret: string, route: ProxyRoute): URL {
  validateRelayPart(secret, 'dispatchSecret')
  validateRelayPart(route.protocolCode, 'shortCode')
  validateRelayPart(route.targetHost, 'targetHost')

  const relayUrl = new URL(proxyBaseUrl)
  const proxyBasePath = trimTrailingSlash(relayUrl.pathname)
  const encodedSecret = encodeURIComponent(secret)
  const encodedShortCode = encodeURIComponent(route.protocolCode)
  const encodedHost = encodeURIComponent(route.targetHost)
  const encodedPath = encodeRelayPath(route.targetPathname)

  relayUrl.pathname = encodedPath
    ? `${proxyBasePath}/relay/${encodedSecret}/${encodedShortCode}/${encodedHost}/${encodedPath}`
    : `${proxyBasePath}/relay/${encodedSecret}/${encodedShortCode}/${encodedHost}`
  relayUrl.search = normalizeSearch(route.targetSearch)

  return relayUrl
}

export async function dispatchRequest(
  request: Request,
  route: ProxyRoute,
  config: RuntimeConfig,
  fetchImplementation: FetchImplementation = fetch,
  logWriter?: LogWriter,
): Promise<Response> {
  const dispatcher = createProxyDispatcher(config.socks5Proxy)
  const cleanupDispatcher = createDispatcherCleanup(dispatcher)

  try {
    const proxyDispatchResult = await dispatchAcrossProxies({
      proxyUrls: config.proxyUrls,
      buildRelayUrl: (proxyUrl: URL) =>
        buildRelayUrl(proxyUrl, config.dispatchSecret, route),
      request: await createReplayableRequest(request),
      timeoutMs: config.requestTimeoutMs,
      signal: request.signal,
      dispatcher,
      fetchImplementation: createProxyFetchAdapter(fetchImplementation),
      logWriter,
    })

    return createRelayResponse({
      request,
      route,
      proxyDispatchResult,
      cleanupDispatcher,
    })
  } catch (error) {
    await cleanupDispatcher()
    throw error
  }
}

async function createReplayableRequest(request: Request): Promise<ReplayableRequest> {
  return {
    method: request.method,
    headers: filterForwardHeaders(request.headers),
    body: await readReplayableBody(request),
  }
}

function createRelayResponse(options: {
  request: Request
  route: ProxyRoute
  proxyDispatchResult: ProxyDispatchResult
  cleanupDispatcher: () => Promise<void>
}): Response {
  const { request, route, proxyDispatchResult, cleanupDispatcher } = options
  const { response } = proxyDispatchResult
  const upstreamUrl = buildUpstreamUrlFromRoute(route)
  const dispatchUrl = new URL(request.url)
  const headers = rewriteResponseHeaders(new Headers(response.headers), upstreamUrl, dispatchUrl)
  const body = wrapResponseBody(response.body, cleanupDispatcher)

  if (body === null) {
    queueMicrotask(() => {
      void cleanupDispatcher()
    })
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function filterForwardHeaders(headers: Headers): Headers {
  const forwarded = new Headers()

  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwarded.set(key, value)
    }
  })

  return forwarded
}

async function readReplayableBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.body === null || request.method === 'GET' || request.method === 'HEAD') {
    return undefined
  }

  const buffer = await request.arrayBuffer()
  if (buffer.byteLength === 0) {
    return undefined
  }

  return buffer.slice(0)
}

function createProxyFetchAdapter(fetchImplementation: FetchImplementation): ProxyFetchImplementation {
  return async (input: URL | string, init?: ProxyFetchInit): Promise<ProxyFetchResponse> => {
    const response = await fetchImplementation(input, normalizeRequestInit(init))

    return {
      status: response.status,
      statusText: response.statusText,
      headers: toHeaderEntries(response.headers),
      body: response.body,
    }
  }
}

function toHeaderEntries(headers: Headers): Array<[string, string]> {
  const normalized = new Headers()

  headers.forEach((value, key) => {
    normalized.append(key, value)
  })

  return Array.from(normalized.entries())
}

function normalizeRequestInit(init: ProxyFetchInit | undefined): RequestInit | undefined {
  if (!init) {
    return undefined
  }

  const requestInit: RequestInit & { duplex?: 'half' } = {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    duplex: init.duplex,
  }

  return requestInit
}

function wrapResponseBody(
  body: ReadableStream | null,
  cleanupDispatcher: () => Promise<void>,
): ReadableStream<Uint8Array> | null {
  if (body === null) {
    return null
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()

        if (result.done) {
          controller.close()
          await cleanupDispatcher()
          return
        }

        controller.enqueue(result.value)
      } catch (error) {
        controller.error(error)
        await cleanupDispatcher()
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await cleanupDispatcher()
      }
    },
  })
}

function createDispatcherCleanup(dispatcher: Dispatcher | null): () => Promise<void> {
  let closed = false

  return async () => {
    if (closed) {
      return
    }

    closed = true
    await closeProxyDispatcher(dispatcher)
  }
}

function encodeRelayPath(pathname: string): string {
  const normalizedPathname = normalizePathname(pathname)

  if (normalizedPathname === '/') {
    return ''
  }

  return normalizedPathname
    .slice(1)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function normalizePathname(pathname: string): string {
  if (!pathname) {
    return '/'
  }

  return pathname.startsWith('/') ? pathname : `/${pathname}`
}

function normalizeSearch(search: string): string {
  if (!search) {
    return ''
  }

  return search.startsWith('?') ? search : `?${search}`
}

function trimTrailingSlash(pathname: string): string {
  if (!pathname || pathname === '/') {
    return ''
  }

  return pathname.replace(/\/+$/, '')
}

function validateRelayPart(value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new DispatchError(500, 'INVALID_RELAY_ROUTE', `${fieldName} 不能为空`)
  }
}
