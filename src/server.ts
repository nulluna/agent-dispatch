import http, { type IncomingHttpHeaders, type Server } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'

import { getRuntimeConfig, loadEnvFromProcess, type DispatchEnv } from './config.js'
import { createApp, type AppOptions } from './index.js'
import { jsonErrorResponse } from './errors.js'

function toHeaders(headers: IncomingHttpHeaders): HeadersInit {
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

async function readRequestBody(request: http.IncomingMessage): Promise<Uint8Array | null> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return null
  }

  return Buffer.concat(chunks)
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
  }

  if (body !== null) {
    init.body = Buffer.from(body)
    init.duplex = 'half'
  }

  return new Request(url, init)
}

function collectDebugHeaders(headers: Headers): Record<string, string | null> {
  return {
    'content-type': headers.get('content-type'),
    'content-encoding': headers.get('content-encoding'),
    'content-length': headers.get('content-length'),
    'transfer-encoding': headers.get('transfer-encoding'),
    location: headers.get('location'),
  }
}

async function writeResponse(response: Response, res: http.ServerResponse): Promise<void> {
  console.info(
    '[agent-dispatch] write-response',
    JSON.stringify({
      status: response.status,
      headers: collectDebugHeaders(response.headers),
    }),
  )

  res.statusCode = response.status

  if (response.statusText) {
    res.statusMessage = response.statusText
  }

  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() === 'set-cookie') {
      continue
    }

    res.setHeader(name, value)
  }

  const setCookieValues = getSetCookieValues(response.headers)

  if (setCookieValues.length > 0) {
    res.setHeader('set-cookie', setCookieValues)
  }

  if (!response.body) {
    res.end()
    return
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    const finish = (error?: Error) => {
      if (settled) {
        return
      }

      settled = true
      if (error) {
        reject(error)
        return
      }

      resolve()
    }

    const stream = Readable.fromWeb(response.body as NodeReadableStream)
    stream.on('error', finish)
    res.on('error', finish)
    res.on('finish', () => finish())
    res.on('close', () => finish())
    stream.pipe(res)
  })
}

export function createServer(options: AppOptions = {}): Server {
  const app = createApp(options)

  return http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req)
      const response = await app.handle(request)
      await writeResponse(response, res)
    } catch (error) {
      const response = jsonErrorResponse(
        500,
        'INTERNAL_SERVER_ERROR',
        error instanceof Error ? error.message : 'internal server error',
      )
      await writeResponse(response, res)
    }
  })
}

export async function startServer(env: DispatchEnv = loadEnvFromProcess(process.env)): Promise<Server> {
  const config = getRuntimeConfig(env)
  const server = createServer({ config })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return server
}

const currentFile = fileURLToPath(import.meta.url)

if (process.argv[1] && currentFile === process.argv[1]) {
  const config = getRuntimeConfig(loadEnvFromProcess(process.env))
  const server = createServer({ config })

  server.listen(config.port, () => {
    process.stdout.write(`agent-dispatch listening on ${config.port}\n`)
  })
}
