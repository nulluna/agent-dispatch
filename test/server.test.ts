import http, { type IncomingHttpHeaders, type Server } from 'node:http'
import net from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createServer } from '../src/server.js'
import { handleProxyRequest, type ProxyEnv } from '../../agent-proxy/src/proxy.js'

function createEnv(overrides: Partial<Record<string, string>> = {}) {
  return {
    DISPATCH_SECRET: 'relay-secret',
    AGENT_PROXY_URLS: 'https://proxy-a.example,https://proxy-b.example',
    ...overrides,
  }
}

function createProxyEnv(overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    ROUTE_BASE_PATH: '',
    SELF_HOSTNAMES: '',
    DISPATCH_SECRET: 'relay-secret',
    ...overrides,
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('无法获取监听端口')
  }

  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function closeAll(servers: Server[]): Promise<void> {
  for (const server of servers) {
    await close(server)
  }
}

async function sendRawHttpRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let response = ''

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
    socket.write(payload)
    socket.end()
  })
}

async function sendHttpRequest(options: {
  port: number
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<{
  statusCode: number
  headers: IncomingHttpHeaders
  body: string
  completed: boolean
  aborted: boolean
  closeHadError: boolean
  timedOut: boolean
  errorMessage: string | null
}> {
  const { port, path, method = 'GET', headers = {}, body, timeoutMs = 200 } = options

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
    })

    request.on('error', reject)
    if (body) {
      request.write(body)
    }
    request.end()

    request.on('response', (response) => {
      let responseBody = ''
      let completed = false
      let aborted = false
      let closeHadError = false
      let timedOut = false
      let errorMessage: string | null = null

      response.setEncoding('utf8')
      response.setTimeout(timeoutMs, () => {
        timedOut = true
        response.destroy()
      })
      response.on('data', (chunk) => {
        responseBody += chunk
      })
      response.on('aborted', () => {
        aborted = true
      })
      response.on('end', () => {
        completed = true
      })
      response.on('close', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: responseBody,
          completed,
          aborted,
          closeHadError,
          timedOut,
          errorMessage,
        })
      })
      response.on('error', (error) => {
        closeHadError = true
        errorMessage = error.message
      })
    })
  })
}

function getSetCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers)
  }

  const single = headers.get('set-cookie')
  return single ? [single] : []
}

function createProxyServer(options: {
  env?: ProxyEnv
  fetchImplementation?: (request: Request) => Promise<Response>
} = {}): Server {
  const env = options.env ?? createProxyEnv()
  const fetchImplementation = options.fetchImplementation ?? ((request: Request) => fetch(request))

  return http.createServer((req, res) => {
    void (async () => {
      const protocol =
        (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http'
      const host = req.headers.host ?? 'localhost'
      const url = new URL(req.url ?? '/', `${protocol}://${host}`)
      const method = req.method ?? 'GET'
      const chunks: Buffer[] = []

      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      const body = method !== 'GET' && method !== 'HEAD' && chunks.length > 0 ? Buffer.concat(chunks) : null
      const proxyRequest = new Request(url, {
        method,
        headers: Object.entries(req.headers).flatMap(([key, value]) => {
          if (typeof value === 'undefined') {
            return []
          }
          return Array.isArray(value)
            ? value.map((item) => [key, item] as [string, string])
            : [[key, value] as [string, string]]
        }),
        body: body ? new Uint8Array(body) : null,
        duplex: body ? 'half' : undefined,
      } as RequestInit & { duplex?: 'half' })

      const response = await handleProxyRequest(proxyRequest, env, fetchImplementation)
      res.statusCode = response.status
      res.statusMessage = response.statusText

      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') {
          res.setHeader(key, value)
        }
      })

      const setCookies = getSetCookieValues(response.headers)
      if (setCookies.length > 0) {
        res.setHeader('set-cookie', setCookies)
      }

      if (!response.body) {
        res.end()
        return
      }

      const reader = response.body.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) {
          break
        }
        res.write(Buffer.from(chunk.value))
      }
      res.end()
    })().catch((error) => {
      res.statusCode = 500
      res.end(error instanceof Error ? error.message : 'proxy error')
    })
  })
}

function logicalUpstreamHost(upstreamPort: number): string {
  return `upstream.test:${upstreamPort}`
}

function makeLocalProxyFetch(upstreamPort: number) {
  return async (request: Request): Promise<Response> => {
    const upstreamUrl = new URL(request.url)
    const originalHost = upstreamUrl.host
    upstreamUrl.protocol = 'http:'
    upstreamUrl.hostname = '127.0.0.1'
    upstreamUrl.port = String(upstreamPort)

    const headers = new Headers(request.headers)
    headers.set('host', originalHost)

    return fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.body,
      duplex: request.body ? 'half' : undefined,
      redirect: 'manual',
    } as RequestInit & { duplex?: 'half' })
  }
}

function createLocalDispatchPath(upstreamPort: number, page = '1'): string {
  return `/h/${encodeURIComponent(logicalUpstreamHost(upstreamPort))}/api/1.0/hlzs/pro/mistake/plan_topics?page=${page}`
}

function expectedRelayUrl(proxyPort: number, upstreamPort: number, page: string): string {
  return `http://127.0.0.1:${proxyPort}/relay/relay-secret/h/${encodeURIComponent(logicalUpstreamHost(upstreamPort))}/api/1.0/hlzs/pro/mistake/plan_topics?page=${page}`
}

function parseLogs(logs: string[]): Array<Record<string, unknown>> {
  return logs.map((entry) => JSON.parse(entry) as Record<string, unknown>)
}

function readNodeSetCookies(headers: IncomingHttpHeaders): string[] {
  const value = headers['set-cookie']
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('server write-back semantics', () => {
  it('triggers server-side write-back timeout for stalled streams', async () => {
    const realSetTimeout = globalThis.setTimeout
    const logs: string[] = []
    const encoder = new TextEncoder()

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        realSetTimeout(handler, timeout === 30_000 ? 5 : timeout, ...args)) as typeof setTimeout,
    )

    const server = createServer({
      env: createEnv(),
      logWriter: (entry: string) => logs.push(entry),
      fetchImplementation: vi.fn(async () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('partial-chunk'))
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
            },
          },
        )
      }),
    })

    try {
      const port = await listen(server)
      const response = await sendHttpRequest({
        port,
        path: '/s/www.google.com/search?q=1',
        timeoutMs: 200,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('partial-chunk')
      expect(response.completed).toBe(false)
      expect(response.aborted).toBe(true)
      expect(response.timedOut).toBe(false)
      expect(response.errorMessage).toBe('aborted')
      expect(logs.map((entry) => JSON.parse(entry).event)).toEqual(
        expect.arrayContaining([
          'dispatch.write_back_start',
          'dispatch.write_back_first_chunk',
          'dispatch.write_back_timeout',
        ]),
      )
      expect(logs.some((entry) => JSON.parse(entry).event === 'dispatch.write_back_finish')).toBe(false)
    } finally {
      await close(server)
    }
  })

  it('does not timeout while chunks keep flowing before idle timeout', async () => {
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        realSetTimeout(handler, timeout === 30_000 ? 20 : timeout, ...args)) as typeof setTimeout,
    )

    const encoder = new TextEncoder()
    const server = createServer({
      env: createEnv(),
      fetchImplementation: vi.fn(async () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('a'))
              realSetTimeout(() => controller.enqueue(encoder.encode('b')), 5)
              realSetTimeout(() => {
                controller.enqueue(encoder.encode('c'))
                controller.close()
              }, 10)
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
            },
          },
        )
      }),
    })

    try {
      const port = await listen(server)
      const response = await sendHttpRequest({
        port,
        path: '/s/www.google.com/search?q=1',
        timeoutMs: 200,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('abc')
      expect(response.completed).toBe(true)
      expect(response.aborted).toBe(false)
      expect(response.timedOut).toBe(false)
    } finally {
      await close(server)
    }
  })

  it('flushes headers early and uses chunked framing for streaming bodies without content-length', async () => {
    let releaseBody: (() => void) | null = null
    const server = createServer({
      env: createEnv(),
      fetchImplementation: vi.fn(async () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              releaseBody = () => {
                controller.enqueue(new TextEncoder().encode('delayed-body'))
                controller.close()
              }
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
            },
          },
        )
      }),
    })

    try {
      const port = await listen(server)
      const socket = net.connect(port, '127.0.0.1')
      let rawResponse = ''

      socket.setEncoding('utf8')
      const headersPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('headers not flushed in time')), 200)

        socket.on('data', (chunk) => {
          rawResponse += chunk
          if (rawResponse.includes('\r\n\r\n')) {
            clearTimeout(timeout)
            resolve(rawResponse)
          }
        })
        socket.on('error', reject)
      })
      const endPromise = new Promise<string>((resolve, reject) => {
        socket.on('end', () => resolve(rawResponse))
        socket.on('error', reject)
      })

      socket.write(
        'GET /s/www.google.com/search?q=1 HTTP/1.1\r\nHost: dispatch.example\r\nConnection: close\r\n\r\n',
      )

      const headerSnapshot = await headersPromise
      expect(headerSnapshot.toLowerCase()).toContain('transfer-encoding: chunked')
      expect(headerSnapshot.toLowerCase()).not.toContain('content-length:')
      expect(headerSnapshot).not.toContain('delayed-body')

      releaseBody?.()
      const fullResponse = await endPromise

      expect(fullResponse).toContain('delayed-body')
      expect(fullResponse).toContain('\r\n0\r\n\r\n')
    } finally {
      await close(server)
    }
  })

  it('preserves explicit content-length without adding chunked framing', async () => {
    const responseBody = 'fixed-body'
    const server = createServer({
      env: createEnv(),
      fetchImplementation: vi.fn(async () => {
        return new Response(responseBody, {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': String(Buffer.byteLength(responseBody)),
          },
        })
      }),
    })

    try {
      const port = await listen(server)
      const rawResponse = await sendRawHttpRequest(
        port,
        'GET /s/www.google.com/search?q=1 HTTP/1.1\r\nHost: dispatch.example\r\nConnection: close\r\n\r\n',
      )

      expect(rawResponse.toLowerCase()).toContain('\r\ncontent-length: 10\r\n')
      expect(rawResponse.toLowerCase()).not.toContain('transfer-encoding: chunked')
      expect(rawResponse).toContain(`\r\n\r\n${responseBody}`)
    } finally {
      await close(server)
    }
  })

  it('runs a real local dispatch -> proxy -> upstream flow for HAR-like POST traffic', async () => {
    const logs: string[] = []
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('x-upstream-ok', 'yes')
      res.setHeader('set-cookie', ['a=1; Path=/; HttpOnly', 'b=2; Path=/; Secure'])
      res.end(`ok:${Buffer.concat(chunks).toString('utf8')}`)
    })
    const upstreamPort = await listen(upstream)
    const proxyServer = createProxyServer({
      env: createProxyEnv({ SELF_HOSTNAMES: 'proxy.internal.test' }),
      fetchImplementation: makeLocalProxyFetch(upstreamPort),
    })
    const proxyPort = await listen(proxyServer)
    const dispatchServer = createServer({
      env: createEnv({ AGENT_PROXY_URLS: `http://127.0.0.1:${proxyPort}` }),
      logWriter: (entry: string) => logs.push(entry),
    })
    const dispatchPort = await listen(dispatchServer)
    const requestBody = JSON.stringify({ planId: 1, topicIds: [1, 2], page: 2 })

    try {
      const response = await sendHttpRequest({
        port: dispatchPort,
        path: createLocalDispatchPath(upstreamPort, '2'),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'session=abc',
          'user-agent': 'local-e2e',
        },
        body: requestBody,
        timeoutMs: 500,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe(`ok:${requestBody}`)
      expect(response.completed).toBe(true)
      expect(response.aborted).toBe(false)
      expect(response.timedOut).toBe(false)
      expect(response.headers['x-upstream-ok']).toBe('yes')
      expect(readNodeSetCookies(response.headers)).toEqual([
        'a=1; Path=/; HttpOnly',
        'b=2; Path=/; Secure',
      ])

      const entries = parseLogs(logs)
      expect(entries.find((entry) => entry.event === 'proxy.dispatch.success')).toMatchObject({
        phase: 'proxy',
      })
      expect(entries.find((entry) => entry.event === 'dispatch.response_ready')).toMatchObject({
        phase: 'request',
      })
      expect(entries.find((entry) => entry.event === 'dispatch.write_back_finish')).toMatchObject({
        phase: 'write_back',
        proxy: {
          proxyUrl: `http://127.0.0.1:${proxyPort}/`,
          relayUrl: expectedRelayUrl(proxyPort, upstreamPort, '2'),
          attemptCount: 1,
        },
      })
    } finally {
      await closeAll([dispatchServer, proxyServer, upstream])
    }
  })

  it('runs a real local dispatch -> proxy -> upstream streaming flow without client timeout', async () => {
    const logs: string[] = []
    const upstream = http.createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.write('a')
      setTimeout(() => res.write('b'), 5)
      setTimeout(() => {
        res.write('c')
        res.end()
      }, 10)
    })
    const upstreamPort = await listen(upstream)
    const proxyServer = createProxyServer({
      env: createProxyEnv({ SELF_HOSTNAMES: 'proxy.internal.test' }),
      fetchImplementation: makeLocalProxyFetch(upstreamPort),
    })
    const proxyPort = await listen(proxyServer)
    const dispatchServer = createServer({
      env: createEnv({ AGENT_PROXY_URLS: `http://127.0.0.1:${proxyPort}` }),
      logWriter: (entry: string) => logs.push(entry),
    })
    const dispatchPort = await listen(dispatchServer)

    try {
      const response = await sendHttpRequest({
        port: dispatchPort,
        path: createLocalDispatchPath(upstreamPort, '1'),
        method: 'GET',
        headers: {
          accept: 'text/plain',
        },
        timeoutMs: 500,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('abc')
      expect(response.completed).toBe(true)
      expect(response.aborted).toBe(false)
      expect(response.timedOut).toBe(false)

      const entries = parseLogs(logs)
      expect(entries.some((entry) => entry.event === 'dispatch.write_back_timeout')).toBe(false)
      expect(entries.find((entry) => entry.event === 'dispatch.write_back_finish')).toMatchObject({
        phase: 'write_back',
        proxy: {
          proxyUrl: `http://127.0.0.1:${proxyPort}/`,
          relayUrl: expectedRelayUrl(proxyPort, upstreamPort, '1'),
          attemptCount: 1,
        },
      })
    } finally {
      await closeAll([dispatchServer, proxyServer, upstream])
    }
  })
})
