import http, { type IncomingHttpHeaders, type Server } from 'node:http'
import net from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
})
