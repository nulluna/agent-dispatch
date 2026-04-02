import { getRuntimeConfig, type DispatchEnv } from './config'
import { DispatchError, jsonErrorResponse } from './errors'
import { createRelayHeaders, cloneResponseHeaders } from './headers'
import { resolveIngressRequest } from './routing'
import {
  createDispatchState,
  selectAgentproxy,
  type DispatchSelection,
  type DispatchState,
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

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])

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
  const relayPrefix = upstreamUrl.protocol === 'https:' ? 'proxyssl' : 'proxy'
  const relayUrl = new URL(proxyBaseUrl)
  const basePath = relayUrl.pathname === '/' ? '' : relayUrl.pathname.replace(/\/+$/g, '')

  relayUrl.pathname =
    `${basePath}/relay/${encodeURIComponent(dispatchSecret)}/${relayPrefix}/${targetAuthority}${upstreamUrl.pathname}` || '/'
  relayUrl.search = upstreamUrl.search

  return relayUrl
}

function createRelayRequest(
  request: Request,
  relayUrl: URL,
  signal: AbortSignal,
): Request {
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: createRelayHeaders(request.headers),
    redirect: 'manual',
    signal,
  }

  if (request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }

  return new Request(relayUrl, init)
}

function createTimedResponseBody(
  response: Response,
  timeoutMs: number,
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
        await reader.cancel(error).catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}

function createClientResponse(response: Response, timeoutMs: number): Response {
  return new Response(createTimedResponseBody(response, timeoutMs), {
    status: response.status,
    statusText: response.statusText,
    headers: cloneResponseHeaders(response),
  })
}

async function fetchRelayResponse(
  relayRequest: Request,
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  abortController: AbortController,
): Promise<Response> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    return await new Promise<Response>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort()
        reject(new DispatchError(504, 'RELAY_CONNECT_TIMEOUT', '内部 relay 连接超时'))
      }, timeoutMs)

      fetchImplementation(relayRequest).then(resolve, reject)
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function handleDispatchRequest(
  request: Request,
  env: DispatchEnv = {},
  fetchImplementation: FetchImplementation = fetch,
  state: DispatchState = defaultDispatchState,
): Promise<Response> {
  try {
    const requestUrl = new URL(request.url)
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

    const abortController = new AbortController()
    const relayUrl = buildRelayUrl(
      proxyBaseUrl,
      config.dispatchSecret,
      ingress.authority,
      ingress.upstreamUrl,
    )
    const relayRequest = createRelayRequest(request, relayUrl, abortController.signal)
    const relayResponse = await fetchRelayResponse(
      relayRequest,
      fetchImplementation,
      config.relayConnectTimeoutMs,
      abortController,
    )

    return createClientResponse(relayResponse, config.relayResponseTimeoutMs)
  } catch (error) {
    if (error instanceof DispatchError) {
      return error.toResponse()
    }

    return jsonErrorResponse(502, 'RELAY_FETCH_FAILED', '内部 relay 请求失败')
  }
}
