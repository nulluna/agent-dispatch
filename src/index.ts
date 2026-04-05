import {
  getRuntimeConfig,
  loadEnvFromProcess,
  type DispatchEnv,
  type RuntimeConfig,
} from './config.js'
import { dispatchRequest, type FetchImplementation } from './dispatch.js'
import { DispatchError } from './errors.js'
import { writeJsonLog, type LogWriter } from './logging.js'
import { parseDispatchRoute, type InvalidRouteReason } from './routing.js'

export interface AppOptions {
  env?: DispatchEnv
  config?: RuntimeConfig
  fetchImplementation?: FetchImplementation
  logWriter?: LogWriter
}

export interface App {
  handle(request: Request): Promise<Response>
}

export function createRouteNotFoundResponse(
  request: Request,
  reason: InvalidRouteReason,
  logWriter?: LogWriter,
): Response {
  const requestUrl = new URL(request.url)

  writeJsonLog(
    {
      level: 'warn',
      event: 'dispatch.invalid_route',
      reason,
      pathname: requestUrl.pathname,
      search: requestUrl.search,
      method: request.method,
    },
    logWriter,
  )

  return new Response('Not Found', { status: 404 })
}

async function handleRequest(
  request: Request,
  config: RuntimeConfig,
  options: AppOptions,
): Promise<Response> {
  const requestUrl = new URL(request.url)
  const route = parseDispatchRoute(requestUrl)

  if (route.kind === 'invalid') {
    return createRouteNotFoundResponse(request, route.reason, options.logWriter)
  }

  try {
    return await dispatchRequest(request, route, config, options.fetchImplementation)
  } catch (error) {
    if (error instanceof DispatchError) {
      return error.toResponse()
    }

    return new Response('Bad Gateway', { status: 502 })
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
