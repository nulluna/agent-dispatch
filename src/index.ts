import {
  getRuntimeConfig,
  loadEnvFromProcess,
  type DispatchEnv,
  type RuntimeConfig,
} from './config.js'
import { dispatchRequest, type FetchImplementation } from './dispatch.js'
import { DispatchError, jsonErrorResponse } from './errors.js'
import { createTransparentRoute, parseDispatchRoute, type RoutingMode } from './routing.js'

export interface AppOptions {
  env?: DispatchEnv
  config?: RuntimeConfig
  fetchImplementation?: FetchImplementation
  mode?: RoutingMode
}

export interface App {
  handle(request: Request): Promise<Response>
}

export function createRouteNotFoundResponse(): Response {
  return new Response('Not Found', { status: 404 })
}

function createHealthResponse(): Response {
  return Response.json({ ok: true })
}

function logDispatch(stage: string, payload: Record<string, unknown>): void {
  console.info(`[agent-dispatch] ${stage}`, JSON.stringify(payload))
}

function summarizeRequestHeaders(request: Request): Record<string, string | boolean | number | string[] | null> {
  const cookieHeader = request.headers.get('cookie')
  const cookieNames = cookieHeader
    ? cookieHeader
        .split(';')
        .map((part) => part.trim().split('=')[0])
        .filter(Boolean)
    : []

  return {
    host: request.headers.get('host'),
    accept: request.headers.get('accept'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    'user-agent': request.headers.get('user-agent'),
    'sec-fetch-site': request.headers.get('sec-fetch-site'),
    'sec-fetch-mode': request.headers.get('sec-fetch-mode'),
    'sec-fetch-dest': request.headers.get('sec-fetch-dest'),
    cookie_present: request.headers.has('cookie'),
    cookie_count: cookieNames.length,
    cookie_names: cookieNames,
    authorization_present: request.headers.has('authorization'),
  }
}

function summarizeSetCookieHeaders(headers: Headers): { set_cookie_count: number; set_cookie_names: string[] } {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = typeof getSetCookie === 'function'
    ? getSetCookie.call(headers)
    : (headers.get('set-cookie') ? [headers.get('set-cookie')!] : [])

  const names = values
    .map((value) => value.split(';')[0]?.split('=')[0]?.trim())
    .filter((value): value is string => Boolean(value))

  return {
    set_cookie_count: names.length,
    set_cookie_names: names,
  }
}

function summarizeResponseHeaders(headers: Headers): Record<string, unknown> {
  return {
    'content-type': headers.get('content-type'),
    'content-encoding': headers.get('content-encoding'),
    location: headers.get('location'),
    ...summarizeSetCookieHeaders(headers),
  }
}

function logResponseSummary(stage: string, response: Response): void {
  console.info(`[agent-dispatch] ${stage}`, JSON.stringify({
    status: response.status,
    headers: summarizeResponseHeaders(response.headers),
  }))
}

function isApiLikePath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/v1/')
}

function logApiHtmlMismatch(requestUrl: URL, response: Response): void {
  const contentType = response.headers.get('content-type') ?? ''

  if (!isApiLikePath(requestUrl.pathname) || !contentType.startsWith('text/html')) {
    return
  }

  console.warn('[agent-dispatch] api-html-mismatch', JSON.stringify({
    requestUrl: requestUrl.toString(),
    status: response.status,
    contentType,
    ...summarizeSetCookieHeaders(response.headers),
  }))
}

function resolveTransparentTargetHost(request: Request, requestUrl: URL): string {
  const directTargetHost = request.headers.get('x-dispatch-target-host')?.trim()

  if (directTargetHost) {
    return directTargetHost
  }

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim()

  if (forwardedHost) {
    return forwardedHost
  }

  return requestUrl.host
}

async function handleRequest(
  request: Request,
  config: RuntimeConfig,
  options: AppOptions,
): Promise<Response> {
  const mode = options.mode ?? 'explicit'
  const requestUrl = new URL(request.url)

  logDispatch('request-received', {
    mode,
    method: request.method,
    url: requestUrl.toString(),
    targetHost:
      mode === 'transparent'
        ? resolveTransparentTargetHost(request, requestUrl)
        : undefined,
    hasBody: request.body !== null,
    requestHeaders: summarizeRequestHeaders(request),
  })

  if (requestUrl.pathname === '/healthz' || requestUrl.pathname === '/readyz') {
    return createHealthResponse()
  }

  const route = mode === 'transparent'
    ? createTransparentRoute(requestUrl, resolveTransparentTargetHost(request, requestUrl))
    : parseDispatchRoute(requestUrl)

  if (route.kind === 'invalid') {
    return createRouteNotFoundResponse()
  }

  try {
    const response = await dispatchRequest(request, route, config, options.fetchImplementation)
    logResponseSummary('request-response-summary', response)
    logApiHtmlMismatch(requestUrl, response)
    return response
  } catch (error) {
    if (error instanceof DispatchError) {
      return error.toResponse()
    }

    return jsonErrorResponse(502, 'UPSTREAM_FETCH_FAILED', '上游请求失败')
  }
}

export async function handleRequestForApp(
  request: Request,
  config: RuntimeConfig,
  options: AppOptions,
): Promise<Response> {
  return handleRequest(request, config, options)
}

export function createApp(options: AppOptions = {}): App {
  const config =
    options.config ?? getRuntimeConfig(options.env ?? loadEnvFromProcess(process.env))

  return {
    async handle(request: Request): Promise<Response> {
      return handleRequest(request, config, options)
    },
  }
}
