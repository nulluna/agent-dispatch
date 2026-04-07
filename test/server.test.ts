import http, { type Server } from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { createServer } from '../src/server.js'

type ProxyEnv = {
  ROUTE_BASE_PATH?: string
  SELF_HOSTNAMES?: string
  DISPATCH_SECRET?: string
}

type HandleProxyRequest = (
  request: Request,
  env?: ProxyEnv,
  fetchImplementation?: (request: Request) => Promise<Response>,
) => Promise<Response>

const servers: Server[] = []

async function listen(server: Server): Promise<number> {
  servers.push(server)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('failed to get server port')
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

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()

    if (server) {
      await close(server)
    }
  }
})

function createNodeRequest(req: http.IncomingMessage): Promise<Request> {
  return (async () => {
    const protocol =
      (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http'
    const host = req.headers.host ?? 'localhost'
    const url = new URL(req.url ?? '/', `${protocol}://${host}`)
    const method = req.method ?? 'GET'

    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers: Object.entries(req.headers).flatMap(([key, value]) => {
        if (typeof value === 'undefined') {
          return []
        }

        return Array.isArray(value)
          ? value.map((item) => [key, item] as [string, string])
          : [[key, value] as [string, string]]
      }),
    }

    if (method !== 'GET' && method !== 'HEAD') {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>
      init.duplex = 'half'
    }

    return new Request(url, init)
  })()
}

async function writeNodeResponse(response: Response, res: http.ServerResponse): Promise<void> {
  res.statusCode = response.status

  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() === 'set-cookie') {
      continue
    }

    res.setHeader(name, value)
  }

  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie
  const setCookieValues =
    typeof getSetCookie === 'function'
      ? getSetCookie.call(response.headers)
      : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : [])

  if (setCookieValues.length > 0) {
    res.setHeader('set-cookie', setCookieValues)
  }

  res.end(await response.text())
}

function createProxyEnv(): ProxyEnv {
  return {
    ROUTE_BASE_PATH: '',
    SELF_HOSTNAMES: '',
    DISPATCH_SECRET: 'relay-secret',
  }
}

function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs)
    }),
  ])
}

describe('server', () => {
  it('returns health check response', async () => {
    const dispatchServer = createServer('explicit', {
      config: {
        port: 0,
        transparentPort: null,
        dispatchSecret: 'relay-secret',
        proxyUrls: [new URL('http://127.0.0.1:1')],
        requestTimeoutMs: 1000,
        failoverCooldownMs: 1000,
        backendSelectionStrategy: 'consistent-hashing',
      },
    })

    const dispatchPort = await listen(dispatchServer)
    const response = await fetch(`http://127.0.0.1:${dispatchPort}/healthz`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('proxies through local agent-proxy backend and preserves transparent semantics', async () => {
    const proxyModuleUrl = new URL('../../agent-proxy/src/proxy.js', import.meta.url)
    const proxyModule = (await import(proxyModuleUrl.href)) as {
      handleProxyRequest: HandleProxyRequest
    }
    const { handleProxyRequest } = proxyModule
    const upstreamServer = http.createServer(async (req, res) => {
      if (req.url?.startsWith('/redirect')) {
        res.statusCode = 302
        res.setHeader('location', '/done?ok=1')
        res.end()
        return
      }

      if (req.url?.startsWith('/stream')) {
        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream')
        res.write('data: first\n\n')
        setTimeout(() => {
          res.end('data: second\n\n')
        }, 10)
        return
      }

      if (req.url?.startsWith('/encoded')) {
        const body = gzipSync(Buffer.from('<html>plain body</html>', 'utf8'))
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('content-encoding', 'gzip')
        res.setHeader('content-length', String(body.byteLength))
        res.end(body)
        return
      }

      if (req.method === 'POST' && req.url?.startsWith('/upload')) {
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }

        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ok: true,
            path: req.url,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        return
      }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })

    const upstreamPort = await listen(upstreamServer)

    const proxyServer = http.createServer(async (req, res) => {
      const request = await createNodeRequest(req)
      const response = await handleProxyRequest(request, createProxyEnv(), async (proxyRequest) => {
        const rewritten = new URL(proxyRequest.url)
        rewritten.protocol = 'http:'
        rewritten.hostname = '127.0.0.1'
        rewritten.port = String(upstreamPort)

        const init: RequestInit & { duplex?: 'half' } = {
          method: proxyRequest.method,
          headers: proxyRequest.headers,
          redirect: 'manual',
        }

        if (
          proxyRequest.body !== null &&
          proxyRequest.method !== 'GET' &&
          proxyRequest.method !== 'HEAD'
        ) {
          init.body = proxyRequest.body
          init.duplex = 'half'
        }

        return fetch(new Request(rewritten, init))
      })

      await writeNodeResponse(response, res)
    })

    const proxyPort = await listen(proxyServer)

    const dispatchServer = createServer('explicit', {
      config: {
        port: 0,
        transparentPort: null,
        dispatchSecret: 'relay-secret',
        proxyUrls: [new URL(`http://127.0.0.1:${proxyPort}`)],
        requestTimeoutMs: 1000,
        failoverCooldownMs: 1000,
        backendSelectionStrategy: 'consistent-hashing',
      },
    })

    const dispatchPort = await listen(dispatchServer)
    const upstreamHost = encodeURIComponent(`upstream.test:${upstreamPort}`)

    const okResponse = await fetch(
      `http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/v1/chat?from=dispatch`,
    )

    expect(okResponse.status).toBe(200)
    await expect(okResponse.json()).resolves.toEqual({
      ok: true,
      path: '/v1/chat?from=dispatch',
    })

    const redirectResponse = await fetch(`http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/redirect`, {
      redirect: 'manual',
    })

    expect(redirectResponse.status).toBe(302)
    expect(redirectResponse.headers.get('location')).toBe(
      `http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/done?ok=1`,
    )

    const streamResponse = await fetch(`http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/stream`)

    expect(streamResponse.status).toBe(200)
    expect(streamResponse.headers.get('content-type')).toBe('text/event-stream')
    expect(await streamResponse.text()).toBe('data: first\n\ndata: second\n\n')

    const uploadResponse = await fetch(`http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'stream-upload-body',
    })

    expect(uploadResponse.status).toBe(200)
    await expect(uploadResponse.json()).resolves.toEqual({
      ok: true,
      path: '/upload',
      body: 'stream-upload-body',
    })

    const encodedResponse = await fetch(`http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/encoded`)

    expect(encodedResponse.status).toBe(200)
    expect(encodedResponse.headers.get('content-encoding')).toBeNull()
    expect(await encodedResponse.text()).toBe('<html>plain body</html>')

    const transparentServer = createServer('transparent', {
      config: {
        port: null,
        transparentPort: 0,
        dispatchSecret: 'relay-secret',
        proxyUrls: [new URL(`http://127.0.0.1:${proxyPort}`)],
        requestTimeoutMs: 1000,
        failoverCooldownMs: 1000,
        backendSelectionStrategy: 'consistent-hashing',
      },
    })

    const transparentPort = await listen(transparentServer)

    const transparentRedirect = await fetch(`http://127.0.0.1:${transparentPort}/redirect`, {
      headers: {
        'x-dispatch-target-host': `upstream.test:${upstreamPort}`,
      },
      redirect: 'manual',
    })

    expect(transparentRedirect.status).toBe(302)
    expect(transparentRedirect.headers.get('location')).toBe('/done?ok=1')

    const transparentApi = await fetch(`http://127.0.0.1:${transparentPort}/api/user/self`, {
      headers: {
        'x-dispatch-target-host': `upstream.test:${upstreamPort}`,
      },
    })

    expect(transparentApi.status).toBe(200)
    await expect(transparentApi.json()).resolves.toEqual({
      ok: true,
      path: '/api/user/self',
    })
  })

  it('streams transparent request bodies through to agent-proxy before the client upload finishes', async () => {
    let firstChunkSeenResolve: (() => void) | null = null
    const firstChunkSeen = new Promise<void>((resolve) => {
      firstChunkSeenResolve = resolve
    })

    const upstreamServer = http.createServer(async (req, res) => {
      if (req.url !== '/stream-upload') {
        res.statusCode = 404
        res.end('not-found')
        return
      }

      const chunks: Buffer[] = []
      let seenFirstChunk = false

      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))

        if (!seenFirstChunk) {
          seenFirstChunk = true
          firstChunkSeenResolve?.()
        }
      })

      await new Promise<void>((resolve) => {
        req.on('end', () => resolve())
      })

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ body: Buffer.concat(chunks).toString('utf8') }))
    })

    const upstreamPort = await listen(upstreamServer)

    const proxyModuleUrl = new URL('../../agent-proxy/src/proxy.js', import.meta.url)
    const proxyModule = (await import(proxyModuleUrl.href)) as {
      handleProxyRequest: HandleProxyRequest
    }
    const { handleProxyRequest } = proxyModule

    const proxyServer = http.createServer(async (req, res) => {
      const request = await createNodeRequest(req)
      const response = await handleProxyRequest(request, createProxyEnv(), async (proxyRequest) => {
        const rewritten = new URL(proxyRequest.url)
        rewritten.protocol = 'http:'
        rewritten.hostname = '127.0.0.1'
        rewritten.port = String(upstreamPort)

        const init: RequestInit & { duplex?: 'half' } = {
          method: proxyRequest.method,
          headers: proxyRequest.headers,
          redirect: 'manual',
        }

        if (
          proxyRequest.body !== null &&
          proxyRequest.method !== 'GET' &&
          proxyRequest.method !== 'HEAD'
        ) {
          init.body = proxyRequest.body
          init.duplex = 'half'
        }

        return fetch(new Request(rewritten, init))
      })

      await writeNodeResponse(response, res)
    })

    const proxyPort = await listen(proxyServer)

    const transparentServer = createServer('transparent', {
      config: {
        port: null,
        transparentPort: 0,
        dispatchSecret: 'relay-secret',
        proxyUrls: [new URL(`http://127.0.0.1:${proxyPort}`)],
        requestTimeoutMs: 1000,
        failoverCooldownMs: 1000,
        backendSelectionStrategy: 'consistent-hashing',
      },
    })

    const transparentPort = await listen(transparentServer)

    const responsePromise = new Promise<{
      status: number
      body: string
    }>((resolve, reject) => {
      const clientRequest = http.request(
        {
          hostname: '127.0.0.1',
          port: transparentPort,
          path: '/stream-upload',
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
            'x-dispatch-target-host': `upstream.test:${upstreamPort}`,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          })
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        },
      )

      clientRequest.on('error', reject)

      clientRequest.write('first-')

      void (async () => {
        const firstChunkResult = await resolvesWithin(firstChunkSeen, 100)

        try {
          expect(firstChunkResult).toBe(true)
        } finally {
          clientRequest.end('second')
        }
      })().catch(reject)
    })

    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ body: 'first-second' })
  })

  it('preserves transparent request headers, query, body, and multiple set-cookie values', async () => {
    const upstreamServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []

      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.setHeader('set-cookie', [
        'a=1; Path=/; HttpOnly',
        'b=2; Path=/; Secure',
      ])
      res.end(
        JSON.stringify({
          path: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
          cookie: req.headers.cookie ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          dispatchTargetHost: req.headers['x-dispatch-target-host'] ?? null,
          forwardedHost: req.headers['x-forwarded-host'] ?? null,
          forwardedProto: req.headers['x-forwarded-proto'] ?? null,
          forwardedFor: req.headers['x-forwarded-for'] ?? null,
        }),
      )
    })

    const upstreamPort = await listen(upstreamServer)
    const proxyModuleUrl = new URL('../../agent-proxy/src/proxy.js', import.meta.url)
    const proxyModule = (await import(proxyModuleUrl.href)) as {
      handleProxyRequest: HandleProxyRequest
    }
    const { handleProxyRequest } = proxyModule

    const proxyServer = http.createServer(async (req, res) => {
      const request = await createNodeRequest(req)
      const response = await handleProxyRequest(request, createProxyEnv(), async (proxyRequest) => {
        const rewritten = new URL(proxyRequest.url)
        rewritten.protocol = 'http:'
        rewritten.hostname = '127.0.0.1'
        rewritten.port = String(upstreamPort)

        const init: RequestInit & { duplex?: 'half' } = {
          method: proxyRequest.method,
          headers: proxyRequest.headers,
          redirect: 'manual',
        }

        if (
          proxyRequest.body !== null &&
          proxyRequest.method !== 'GET' &&
          proxyRequest.method !== 'HEAD'
        ) {
          init.body = proxyRequest.body
          init.duplex = 'half'
        }

        return fetch(new Request(rewritten, init))
      })

      await writeNodeResponse(response, res)
    })

    const proxyPort = await listen(proxyServer)

    const transparentServer = createServer('transparent', {
      config: {
        port: null,
        transparentPort: 0,
        dispatchSecret: 'relay-secret',
        proxyUrls: [new URL(`http://127.0.0.1:${proxyPort}`)],
        requestTimeoutMs: 1000,
        failoverCooldownMs: 1000,
        backendSelectionStrategy: 'consistent-hashing',
      },
    })

    const transparentPort = await listen(transparentServer)

    const response = await new Promise<{
      status: number
      headers: http.IncomingHttpHeaders
      body: string
    }>((resolve, reject) => {
      const clientRequest = http.request(
        {
          hostname: '127.0.0.1',
          port: transparentPort,
          path: '/api/user/self?from=browser',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dispatch-target-host': `upstream.test:${upstreamPort}`,
            'x-forwarded-host': 'proxy-visible.example',
            'x-forwarded-proto': 'https',
            'x-forwarded-for': '127.0.0.1',
            cookie: 'session=abc',
            'user-agent': 'Browser UA',
          },
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          })
          incoming.on('end', () => {
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        },
      )

      clientRequest.on('error', reject)
      clientRequest.end('{"hello":"world"}')
    })

    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/; Secure',
    ])
    expect(JSON.parse(response.body)).toEqual({
      path: '/api/user/self?from=browser',
      body: '{"hello":"world"}',
      cookie: 'session=abc',
      userAgent: 'Browser UA',
      dispatchTargetHost: null,
      forwardedHost: null,
      forwardedProto: null,
      forwardedFor: null,
    })
  })
})
