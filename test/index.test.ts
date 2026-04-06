import http, { type IncomingHttpHeaders, type Server } from 'node:http'
import net from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/index.js'
import { writeJsonLog } from '../src/logging.js'
import { createServer } from '../src/server.js'

function createEnv() {
  return {
    DISPATCH_SECRET: 'relay-secret',
    AGENT_PROXY_URLS: 'https://proxy-a.example,https://proxy-b.example',
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
  const { port, path, method = 'GET', timeoutMs = 200 } = options

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
    })

    request.on('error', reject)
    request.end()

    request.on('response', (response) => {
      let body = ''
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
        body += chunk
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
          body,
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

const originalStdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()

  if (originalStdoutIsTTYDescriptor) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTYDescriptor)
    return
  }

  Reflect.deleteProperty(process.stdout, 'isTTY')
})

describe('writeJsonLog', () => {
  it('keeps custom writers machine-readable', () => {
    const logs: string[] = []

    writeJsonLog(
      {
        event: 'proxy_dispatch_success',
        status: 200,
      },
      (entry: string) => logs.push(entry),
    )

    expect(logs).toEqual(['{"event":"proxy_dispatch_success","status":200}'])
  })

  it('uses colored pretty output for tty development logs', () => {
    setStdoutIsTTY(true)
    vi.stubEnv('NODE_ENV', 'development')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    writeJsonLog({
      level: 'warn',
      event: 'dispatch.invalid_route',
      reason: 'missing_protocol_code',
    })

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy.mock.calls[0]?.[0]).toContain('\u001b[')
    expect(logSpy.mock.calls[0]?.[0]).toContain('WARN')
    expect(logSpy.mock.calls[0]?.[0]).toContain('dispatch.invalid_route')
    expect(logSpy.mock.calls[0]?.[0]).toContain('reason=missing_protocol_code')
  })

  it('keeps default console logs as json in production', () => {
    setStdoutIsTTY(true)
    vi.stubEnv('NODE_ENV', 'production')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    writeJsonLog({
      event: 'proxy_dispatch_success',
      status: 200,
    })

    expect(logSpy).toHaveBeenCalledWith('{"event":"proxy_dispatch_success","status":200}')
  })
})

describe('node bootstrap', () => {
  it('exports createApp and createServer', () => {
    expect(typeof createApp).toBe('function')
    expect(typeof createServer).toBe('function')
  })

  it('logs invalid route and returns 404', async () => {
    const logs: string[] = []
    const fetchSpy = vi.fn()
    const app = createApp({
      env: createEnv(),
      fetchImplementation: fetchSpy,
      logWriter: (entry: string) => logs.push(entry),
    })

    const response = await app.handle(new Request('http://dispatch.example/www.google.com?q=1'))

    expect(response.status).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.parse(logs[0])).toMatchObject({
      event: 'dispatch.invalid_route',
      phase: 'routing',
      reason: 'missing_protocol_code',
      pathname: '/www.google.com',
      search: '?q=1',
      method: 'GET',
    })
  })

  it('returns 404 for invalid paths without calling upstream fetch', async () => {
    const fetchSpy = vi.fn()
    const logs: string[] = []
    const app = createApp({
      env: createEnv(),
      fetchImplementation: fetchSpy,
      logWriter: (entry: string) => logs.push(entry),
    })

    const response = await app.handle(new Request('http://dispatch.example/without-code'))

    expect(response.status).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logs).toHaveLength(1)
  })

  it('returns 404 for real absolute-form proxy requests over the node server entrypoint', async () => {
    const logs: string[] = []
    const fetchSpy = vi.fn()
    const server = createServer({
      env: createEnv(),
      fetchImplementation: fetchSpy,
      logWriter: (entry: string) => logs.push(entry),
    })

    try {
      const port = await listen(server)
      const rawResponse = await sendRawHttpRequest(
        port,
        'GET http://www.google.com/search?q=1 HTTP/1.1\r\nHost: www.google.com\r\nConnection: close\r\n\r\n',
      )

      expect(rawResponse).toContain('HTTP/1.1 404 Not Found')
      expect(rawResponse).toContain('\r\n\r\n9\r\nNot Found\r\n0\r\n\r\n')
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
        event: 'dispatch.invalid_route',
        phase: 'routing',
        reason: 'missing_protocol_code',
        pathname: '/search',
        search: '?q=1',
        method: 'GET',
      })
    } finally {
      await close(server)
    }
  })

  it('forwards real short-code requests over the node server entrypoint', async () => {
    const fetchSpy = vi.fn(async (input: URL | string) => {
      expect(input.toString()).toBe(
        'https://proxy-a.example/relay/relay-secret/s/www.google.com/search?q=1',
      )

      return new Response('proxy-ok', {
        status: 200,
        headers: {
          'x-proxy-node': 'proxy-a',
        },
      })
    })
    const server = createServer({
      env: createEnv(),
      fetchImplementation: fetchSpy,
    })

    try {
      const port = await listen(server)
      const rawResponse = await sendRawHttpRequest(
        port,
        'GET /s/www.google.com/search?q=1 HTTP/1.1\r\nHost: dispatch.example\r\nConnection: close\r\n\r\n',
      )

      expect(rawResponse).toContain('HTTP/1.1 200 OK')
      expect(rawResponse.toLowerCase()).toContain('x-proxy-node: proxy-a')
      expect(rawResponse).toContain('proxy-ok')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      await close(server)
    }
  })

  it('lets a real http client receive the full response body and completion signal', async () => {
    const logs: string[] = []
    const fetchSpy = vi.fn(async () => {
      const encoder = new TextEncoder()

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('chunk-1|'))
            controller.enqueue(encoder.encode('chunk-2|done'))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'x-proxy-node': 'proxy-a',
          },
        },
      )
    })
    const server = createServer({
      env: createEnv(),
      fetchImplementation: fetchSpy,
      logWriter: (entry: string) => logs.push(entry),
    })

    try {
      const port = await listen(server)
      const response = await sendHttpRequest({
        port,
        path: '/s/www.google.com/search?q=1',
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['x-proxy-node']).toBe('proxy-a')
      expect(response.body).toBe('chunk-1|chunk-2|done')
      expect(response.completed).toBe(true)
      expect(response.aborted).toBe(false)
      expect(response.closeHadError).toBe(false)
      expect(response.timedOut).toBe(false)
      expect(response.errorMessage).toBeNull()
      const parsedLogs = logs.map((entry) => JSON.parse(entry))
      expect(parsedLogs.map((entry) => entry.event)).toEqual(
        expect.arrayContaining([
          'dispatch.write_back_start',
          'dispatch.write_back_first_chunk',
          'dispatch.write_back_stream_end',
          'dispatch.write_back_finish',
        ]),
      )
      expect(parsedLogs.find((entry) => entry.event === 'dispatch.request_completed')).toMatchObject({
        phase: 'request',
        durationMs: expect.any(Number),
      })
    } finally {
      await close(server)
    }
  })

  it('lets a real http client observe stalled write-back via timeout and aborted close', async () => {
    const logs: string[] = []
    const fetchSpy = vi.fn(async () => {
      const encoder = new TextEncoder()

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('partial-chunk'))
          },
          cancel() {
            return undefined
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
          },
        },
      )
    })
    const server = createServer({
      env: createEnv(),
      fetchImplementation: fetchSpy,
      logWriter: (entry: string) => logs.push(entry),
    })

    try {
      const port = await listen(server)
      const response = await sendHttpRequest({
        port,
        path: '/s/www.google.com/search?q=1',
        timeoutMs: 50,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('partial-chunk')
      expect(response.completed).toBe(false)
      expect(response.aborted).toBe(true)
      expect(response.timedOut).toBe(true)
      expect(logs.map((entry) => JSON.parse(entry).event)).toEqual(
        expect.arrayContaining([
          'dispatch.write_back_start',
          'dispatch.write_back_first_chunk',
        ]),
      )
      expect(logs.some((entry) => JSON.parse(entry).event === 'dispatch.write_back_timeout')).toBe(false)
    } finally {
      await close(server)
    }
  })
})
