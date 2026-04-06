import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

import { getRuntimeConfig, loadEnvFromProcess, type DispatchEnv } from './config.js'
import { createApp, type AppOptions } from './index.js'
import { writeJsonLog, type LogWriter } from './logging.js'

const RESPONSE_WRITE_TIMEOUT_MS = 30_000

function toHeaders(headers: http.IncomingHttpHeaders): HeadersInit {
  const normalized: Array<[string, string]> = []

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        normalized.push([key, item])
      }
      continue
    }

    normalized.push([key, value])
  }

  return normalized
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

async function readRequestBody(
  request: http.IncomingMessage,
): Promise<Uint8Array | null> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return null
  }

  return Buffer.concat(chunks)
}

async function writeResponseBody(
  response: Response,
  res: http.ServerResponse,
  logWriter?: LogWriter,
): Promise<void> {
  const startAt = Date.now()
  let settled = false
  let sawFirstChunk = false
  let responseFinished = false
  let responseErrored = false
  let requestAborted = false

  const logWriteBack = (event: string, extra: Record<string, unknown> = {}) => {
    writeJsonLog(
      {
        event,
        status: response.status,
        headersSent: res.headersSent,
        writableEnded: res.writableEnded,
        writableFinished: res.writableFinished,
        durationMs: Date.now() - startAt,
        ...extra,
      },
      logWriter,
    )
  }

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      res.off('finish', handleFinish)
      res.off('close', handleClose)
      res.off('error', handleError)
      res.req?.off('aborted', handleAborted)
      nodeStream?.off('data', handleFirstChunk)
      nodeStream?.off('error', handleStreamError)
      nodeStream?.off('end', handleStreamEnd)
      nodeStream?.off('close', handleStreamClose)

      if (error) {
        reject(error)
        return
      }

      resolve()
    }

    const handleFinish = () => {
      responseFinished = true
      logWriteBack('dispatch.write_back_finish')
      finish()
    }

    const handleClose = () => {
      logWriteBack('dispatch.write_back_close', {
        responseFinished,
        requestAborted,
        responseErrored,
      })

      if (responseFinished || requestAborted || responseErrored) {
        return
      }

      finish(new Error('response closed before finish'))
    }

    const handleError = (error: Error) => {
      responseErrored = true
      logWriteBack('dispatch.write_back_error', {
        error: error.message,
      })
      finish(error)
    }

    const handleAborted = () => {
      requestAborted = true
      logWriteBack('dispatch.write_back_aborted')
      if (nodeStream && !nodeStream.destroyed) {
        nodeStream.destroy()
      }
    }

    const handleFirstChunk = () => {
      if (sawFirstChunk) {
        return
      }

      sawFirstChunk = true
      logWriteBack('dispatch.write_back_first_chunk')
    }

    const handleStreamError = (error: Error) => {
      logWriteBack('dispatch.write_back_stream_error', {
        error: error.message,
      })
      finish(error)
    }

    const handleStreamEnd = () => {
      logWriteBack('dispatch.write_back_stream_end')
    }

    const handleStreamClose = () => {
      logWriteBack('dispatch.write_back_stream_close')
    }

    const timeout = setTimeout(() => {
      logWriteBack('dispatch.write_back_timeout')
      if (!res.writableEnded) {
        requestAborted = true
        res.destroy()
        return
      }

      finish(new Error('response write timeout'))
    }, RESPONSE_WRITE_TIMEOUT_MS)

    let nodeStream: Readable | null = null

    res.on('finish', handleFinish)
    res.on('close', handleClose)
    res.on('error', handleError)
    res.req?.on('aborted', handleAborted)

    logWriteBack('dispatch.write_back_start', {
      hasBody: Boolean(response.body),
    })
    res.flushHeaders()

    if (!response.body) {
      res.end()
      return
    }

    nodeStream = Readable.fromWeb(response.body as NodeReadableStream)
    nodeStream.on('data', handleFirstChunk)
    nodeStream.on('error', handleStreamError)
    nodeStream.on('end', handleStreamEnd)
    nodeStream.on('close', handleStreamClose)
    nodeStream.pipe(res)
  })
}

async function toRequest(request: http.IncomingMessage): Promise<Request> {
  const protocol =
    (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    'http'
  const host = request.headers.host ?? 'localhost'
  const url = new URL(request.url ?? '/', `${protocol}://${host}`)
  const method = request.method ?? 'GET'
  const body = method !== 'GET' && method !== 'HEAD' ? await readRequestBody(request) : null

  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: toHeaders(request.headers),
    body: body ? new Uint8Array(body) : null,
  }

  if (body) {
    init.duplex = 'half'
  }

  return new Request(url, init)
}

function applyResponseHeaders(response: Response, res: http.ServerResponse): void {
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      return
    }

    res.setHeader(key, value)
  })

  const setCookieValues = getSetCookieValues(response.headers)
  if (setCookieValues.length > 0) {
    res.setHeader('set-cookie', setCookieValues)
  }
}

export { toRequest, writeResponseBody }

export function createServer(options: AppOptions = {}): http.Server {
  const app = createApp(options)

  return http.createServer((req, res) => {
    void (async () => {
      try {
        const response = await app.handle(await toRequest(req))
        res.statusCode = response.status
        res.statusMessage = response.statusText
        applyResponseHeaders(response, res)
        await writeResponseBody(response, res, options.logWriter)
      } catch {
        if (!res.headersSent) {
          res.statusCode = 500
          res.end('Internal Server Error')
        } else {
          res.end()
        }
      }
    })()
  })
}

export async function startServer(
  options: AppOptions = {},
): Promise<http.Server> {
  const env = options.env ?? loadEnvFromProcess(process.env)
  const config = options.config ?? getRuntimeConfig(env)
  const server = createServer({ ...options, config })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return server
}

export async function startServerFromEnv(
  env: DispatchEnv,
  options: Omit<AppOptions, 'env' | 'config'> = {},
): Promise<http.Server> {
  const config = getRuntimeConfig(env)
  return startServer({ ...options, env, config })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void startServer().catch((error) => {
    const message = error instanceof Error ? error.message : '未知错误'
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'dispatch.server_start_failed',
        message,
      }),
    )
    process.exitCode = 1
  })
}
