import { socksDispatcher } from 'fetch-socks'
import {
  fetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici'

import type { RuntimeConfig, Socks5ProxyConfig } from './config.js'
import { DispatchError } from './errors.js'
import { createRequestLogContext, getRequestIdFromRequest, writeJsonLog, type LogWriter } from './logging.js'
import type { ProxyRoute } from './routing.js'

export interface ProxyFetchResponse {
  status: number
  statusText: string
  headers: Iterable<[string, string]>
  body: ReadableStream | null
}

export interface ProxyFetchInit {
  method: string
  headers?: Array<[string, string]>
  body?: ArrayBuffer
  duplex?: 'half'
  signal?: AbortSignal
  dispatcher?: Dispatcher
}

export type ProxyFetchImplementation = (
  input: URL | string,
  init?: ProxyFetchInit,
) => Promise<ProxyFetchResponse>

export interface ReplayableRequest {
  method: string
  headers: Headers
  body?: ArrayBuffer
}

export interface ProxyDispatchOptions {
  proxyUrls: readonly URL[]
  buildRelayUrl: (proxyUrl: URL) => URL
  request: ReplayableRequest
  requestInfo?: Request
  route?: ProxyRoute
  timeoutMs: number
  signal?: AbortSignal
  dispatcher?: Dispatcher | null
  fetchImplementation?: ProxyFetchImplementation
  logWriter?: LogWriter
}

export interface ProxyDispatchResult {
  response: Response
  proxyUrl: URL
  relayUrl: URL
  attemptCount: number
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

interface AttemptAbortController {
  signal: AbortSignal
  cleanup: () => void
  timedOut: () => boolean
  abortedByUpstream: () => boolean
}

export function createProxyDispatcher(
  configOrSocks5Proxy: RuntimeConfig | Socks5ProxyConfig | null,
): Dispatcher | null {
  const socks5Proxy = isRuntimeConfig(configOrSocks5Proxy)
    ? configOrSocks5Proxy.socks5Proxy
    : configOrSocks5Proxy

  if (!socks5Proxy) {
    return null
  }

  return socksDispatcher(socks5Proxy)
}

export async function closeProxyDispatcher(
  dispatcher: Dispatcher | null | undefined,
): Promise<void> {
  if (!dispatcher) {
    return
  }

  const closable = dispatcher as Dispatcher & {
    close?: () => Promise<unknown>
    destroy?: (error?: Error) => Promise<unknown> | void
  }

  if (typeof closable.close === 'function') {
    await closable.close()
    return
  }

  if (typeof closable.destroy === 'function') {
    await closable.destroy()
  }
}

export async function dispatchAcrossProxies(
  options: ProxyDispatchOptions,
): Promise<ProxyDispatchResult> {
  const {
    proxyUrls,
    buildRelayUrl,
    request,
    requestInfo,
    route,
    timeoutMs,
    signal,
    dispatcher,
    fetchImplementation = defaultProxyFetch,
    logWriter,
  } = options

  if (proxyUrls.length === 0) {
    throw new DispatchError(502, 'PROXY_DISPATCH_FAILED', '未配置可用的 proxy 节点')
  }

  let lastError: unknown = null
  let sawTimeout = false

  for (const [index, proxyUrl] of proxyUrls.entries()) {
    const relayUrl = buildRelayUrl(proxyUrl)
    const attemptAbort = createAttemptAbortController(signal, timeoutMs)
    const baseContext = createAttemptLogContext({
      requestInfo,
      route,
      attempt: index + 1,
      proxyUrl,
      relayUrl,
    })

    try {
      writeJsonLog(
        {
          level: 'info',
          event: 'proxy.dispatch.attempt',
          phase: 'proxy',
          ...baseContext,
        },
        logWriter,
      )

      const response = await fetchImplementation(relayUrl, buildFetchInit({
        request,
        dispatcher,
        signal: attemptAbort.signal,
      }))

      writeJsonLog(
        {
          level: 'info',
          event: 'proxy.dispatch.success',
          phase: 'proxy',
          ...baseContext,
          response: {
            status: response.status,
            statusText: response.statusText,
          },
        },
        logWriter,
      )

      return {
        response: toWebResponse(response),
        proxyUrl,
        relayUrl,
        attemptCount: index + 1,
      }
    } catch (error) {
      const timedOut = attemptAbort.timedOut()
      const upstreamAborted = attemptAbort.abortedByUpstream()
      const failover = shouldFailover(error, timedOut, upstreamAborted)
      const failureKind = classifyFailure(error, timedOut, upstreamAborted)

      if (timedOut) {
        sawTimeout = true
      }

      writeJsonLog(
        {
          level: failover ? 'warn' : 'error',
          event: 'proxy.dispatch.failure',
          phase: 'proxy',
          ...baseContext,
          timedOut,
          upstreamAborted,
          failover,
          failureKind,
          error: {
            code: getErrorCode(error),
            message: stringifyError(error),
          },
        },
        logWriter,
      )

      if (!failover) {
        throw error
      }

      lastError = error
    } finally {
      attemptAbort.cleanup()
    }
  }

  throw buildExhaustedProxyError(lastError, sawTimeout)
}

function createAttemptLogContext(options: {
  requestInfo?: Request
  route?: ProxyRoute
  attempt: number
  proxyUrl: URL
  relayUrl: URL
}): Record<string, unknown> {
  const { requestInfo, route, attempt, proxyUrl, relayUrl } = options
  const requestContext = requestInfo ? createRequestLogContext(requestInfo, route) : {}

  return {
    ...requestContext,
    requestId: requestInfo ? getRequestIdFromRequest(requestInfo) : 'unknown',
    proxy: {
      attempt,
      proxyUrl: proxyUrl.toString(),
      relayUrl: relayUrl.toString(),
    },
  }
}

function buildFetchInit(options: {
  request: ReplayableRequest
  signal: AbortSignal
  dispatcher?: Dispatcher | null
}): ProxyFetchInit {
  const { request, signal, dispatcher } = options
  const init: ProxyFetchInit = {
    method: request.method,
    headers: Array.from(request.headers.entries()),
    signal,
    dispatcher: dispatcher ?? undefined,
  }

  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body.slice(0)
    init.duplex = 'half'
  }

  return init
}

async function defaultProxyFetch(
  input: URL | string,
  init?: ProxyFetchInit,
): Promise<ProxyFetchResponse> {
  const response = await fetch(input, normalizeUndiciInit(init))

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers.entries(),
    body: response.body as ReadableStream<Uint8Array> | null,
  }
}

function normalizeUndiciInit(init: ProxyFetchInit | undefined): UndiciRequestInit | undefined {
  if (!init) {
    return undefined
  }

  return {
    method: init.method,
    headers: init.headers,
    body: init.body,
    duplex: init.duplex,
    signal: init.signal,
    dispatcher: init.dispatcher,
  }
}

function cloneHeaders(headers: Iterable<[string, string]>): Headers {
  const cloned = new Headers()

  for (const [key, value] of headers) {
    cloned.append(key, value)
  }

  return cloned
}

function cloneBody(body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> | null {
  if (body === null) {
    return null
  }

  return body
}

function toWebResponse(response: ProxyFetchResponse): Response {
  return new Response(cloneBody(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders(response.headers),
  })
}

function shouldFailover(
  error: unknown,
  timedOut: boolean,
  upstreamAborted: boolean,
): boolean {
  if (error instanceof DispatchError) {
    return false
  }

  if (upstreamAborted) {
    return false
  }

  if (timedOut) {
    return true
  }

  const errorCode = getErrorCode(error)
  if (errorCode && RETRYABLE_NETWORK_ERROR_CODES.has(errorCode)) {
    return true
  }

  return isAbortError(error)
}

function classifyFailure(
  error: unknown,
  timedOut: boolean,
  upstreamAborted: boolean,
): 'timeout' | 'upstream_abort' | 'network' | 'dispatch_error' | 'abort' | 'unknown' {
  if (error instanceof DispatchError) {
    return 'dispatch_error'
  }

  if (upstreamAborted) {
    return 'upstream_abort'
  }

  if (timedOut) {
    return 'timeout'
  }

  const errorCode = getErrorCode(error)
  if (errorCode && RETRYABLE_NETWORK_ERROR_CODES.has(errorCode)) {
    return 'network'
  }

  if (isAbortError(error)) {
    return 'abort'
  }

  return 'unknown'
}

function buildExhaustedProxyError(
  lastError: unknown,
  sawTimeout: boolean,
): DispatchError {
  const suffix = stringifyError(lastError)

  if (sawTimeout) {
    return new DispatchError(
      502,
      'PROXY_DISPATCH_FAILED',
      suffix ? `所有 proxy 节点请求均超时: ${suffix}` : '所有 proxy 节点请求均超时',
    )
  }

  return new DispatchError(
    502,
    'PROXY_DISPATCH_FAILED',
    suffix ? `所有 proxy 节点都不可用: ${suffix}` : '所有 proxy 节点都不可用',
  )
}

function createAttemptAbortController(
  upstreamSignal: AbortSignal | undefined,
  timeoutMs: number,
): AttemptAbortController {
  const controller = new AbortController()
  let didTimeout = false
  let abortedByUpstream = false

  const abortFromUpstream = () => {
    abortedByUpstream = true
    controller.abort(upstreamSignal?.reason)
  }

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortFromUpstream()
    } else {
      upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true })
    }
  }

  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort(new Error('proxy dispatch timeout'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    },
    timedOut: () => didTimeout,
    abortedByUpstream: () => abortedByUpstream,
  }
}

function getErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null
  }

  const errorWithCode = error as Error & { code?: string }
  return errorWithCode.code ?? null
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isRuntimeConfig(
  value: RuntimeConfig | Socks5ProxyConfig | null,
): value is RuntimeConfig {
  return value !== null && 'proxyUrls' in value
}
