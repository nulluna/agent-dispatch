import {
  getRuntimeConfig,
  loadEnvFromProcess,
  type DispatchEnv,
  type RuntimeConfig,
} from './config.js'
import { dispatchRequest, type FetchImplementation } from './dispatch.js'
import { DispatchError, jsonErrorResponse } from './errors.js'
import { parseDispatchRoute } from './routing.js'

export interface AppOptions {
  env?: DispatchEnv
  config?: RuntimeConfig
  fetchImplementation?: FetchImplementation
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

async function handleRequest(
  request: Request,
  config: RuntimeConfig,
  options: AppOptions,
): Promise<Response> {
  const requestUrl = new URL(request.url)

  logDispatch('request-received', {
    method: request.method,
    url: requestUrl.toString(),
    hasBody: request.body !== null,
  })

  if (requestUrl.pathname === '/healthz' || requestUrl.pathname === '/readyz') {
    return createHealthResponse()
  }

  const route = parseDispatchRoute(requestUrl)

  if (route.kind === 'invalid') {
    return createRouteNotFoundResponse()
  }

  try {
    return await dispatchRequest(request, route, config, options.fetchImplementation)
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
