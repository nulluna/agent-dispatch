import { randomUUID } from 'node:crypto'

import {
  createRequestLogContext,
  INTERNAL_REQUEST_ID_HEADER,
  writeJsonLog,
  type LogWriter,
} from './logging.js'
import {
  getRuntimeConfig,
  loadEnvFromProcess,
  type DispatchEnv,
  type RuntimeConfig,
} from './config.js'
import { dispatchRequest, type FetchImplementation } from './dispatch.js'
import { DispatchError } from './errors.js'
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
      phase: 'routing',
      reason,
      requestId: request.headers.get(INTERNAL_REQUEST_ID_HEADER) ?? 'unknown',
      method: request.method,
      pathname: requestUrl.pathname,
      search: requestUrl.search,
      request: {
        method: request.method,
        dispatch: {
          pathname: requestUrl.pathname,
          search: requestUrl.search,
        },
      },
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
  const startedAt = Date.now()
  const requestWithContext = attachRequestContext(request)
  const route = parseDispatchRoute(new URL(requestWithContext.url))

  if (route.kind === 'invalid') {
    return createRouteNotFoundResponse(requestWithContext, route.reason, options.logWriter)
  }

  const baseContext = createRequestLogContext(requestWithContext, route)

  writeJsonLog(
    {
      level: 'info',
      event: 'dispatch.request_received',
      phase: 'request',
      ...baseContext,
    },
    options.logWriter,
  )

  try {
    const response = await dispatchRequest(
      requestWithContext,
      route,
      config,
      options.fetchImplementation,
      options.logWriter,
    )

    writeJsonLog(
      {
        level: 'info',
        event: 'dispatch.request_completed',
        phase: 'request',
        ...baseContext,
        durationMs: Date.now() - startedAt,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: {
            'content-type': response.headers.get('content-type'),
            location: response.headers.get('location'),
          },
        },
      },
      options.logWriter,
    )

    return response
  } catch (error) {
    if (error instanceof DispatchError) {
      writeJsonLog(
        {
          level: 'error',
          event: 'dispatch.request_failed',
          phase: 'request',
          ...baseContext,
          durationMs: Date.now() - startedAt,
          error: {
            code: error.code,
            message: error.message,
            status: error.status,
          },
        },
        options.logWriter,
      )
      return error.toResponse()
    }

    writeJsonLog(
      {
        level: 'error',
        event: 'dispatch.request_failed',
        phase: 'request',
        ...baseContext,
        durationMs: Date.now() - startedAt,
        error: {
          code: 'UNEXPECTED_ERROR',
          message: error instanceof Error ? error.message : 'unknown error',
        },
      },
      options.logWriter,
    )

    return new Response('Bad Gateway', { status: 502 })
  }
}

function attachRequestContext(request: Request): Request {
  if (request.headers.has(INTERNAL_REQUEST_ID_HEADER)) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.set(INTERNAL_REQUEST_ID_HEADER, randomUUID())

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
  }

  if (request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
    init.duplex = 'half'
  }

  return new Request(request, init)
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
