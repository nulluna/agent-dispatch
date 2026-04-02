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

const RELAY_RETRY_DELAYS_MS = [0, 500, 1000]

async function fetchRelayResponse(
  createRequest: (signal: AbortSignal) => Request,
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
): Promise<Response> {
  const maxAttempts = RELAY_RETRY_DELAYS_MS.length + 1
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = RELAY_RETRY_DELAYS_MS[attempt - 1]
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      console.info('[agent-dispatch] relay connect retry', { attempt, delay })
    }

    const abortController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      return await new Promise<Response>((resolve, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort()
          reject(new DispatchError(504, 'RELAY_CONNECT_TIMEOUT', '内部 relay 连接超时'))
        }, timeoutMs)

        fetchImplementation(createRequest(abortController.signal)).then(resolve, reject)
      })
    } catch (error) {
      lastError = error
      // 仅对 relay 连接超时重试，其他错误立即抛出
      if (!(error instanceof DispatchError && error.code === 'RELAY_CONNECT_TIMEOUT')) {
        throw error
      }
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

    // 负向缓存：构建缓存 key
    const negativeCache = state.negativeCache
    let cacheKey: string | null = null
    let accountBound = false

    if (selection.strategy === 'hash') {
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

        return negativeCache.createCachedResponse(cached)
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
    const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'
    const bufferedBody = hasBody ? await new Response(request.body).arrayBuffer() : null
    const createRelayRequest = createRelayRequestFactory(request, relayUrl, bufferedBody)

    const relayResponse = await fetchRelayResponse(
      createRelayRequest,
      fetchImplementation,
      config.relayConnectTimeoutMs,
    )

    // 负向缓存：记录上游响应
    if (cacheKey) {
      if (negativeCache.isCacheableStatus(relayResponse.status)) {
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
        return new Response(clientBody, {
          status: relayResponse.status,
          statusText: relayResponse.statusText,
          headers: cloneResponseHeaders(relayResponse),
        })
      }

      // 非可缓存状态码：仅当存在缓存条目时才清除（探测成功场景）
      if (negativeCache.entries.has(cacheKey)) {
        negativeCache.recordResponse(
          cacheKey,
          relayResponse.status,
          relayResponse.headers,
          new ArrayBuffer(0),
          accountBound,
        )
      }
    }

    return createClientResponse(relayResponse, config.relayResponseTimeoutMs)
  } catch (error) {
    if (error instanceof DispatchError) {
      return error.toResponse()
    }

    return jsonErrorResponse(502, 'RELAY_FETCH_FAILED', '内部 relay 请求失败')
  }
}
