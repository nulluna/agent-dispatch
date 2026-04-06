import http, { type Server } from 'node:http'
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
    const chunks: Buffer[] = []

    if (method !== 'GET' && method !== 'HEAD') {
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
    }

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

    if (chunks.length > 0) {
      init.body = Buffer.concat(chunks)
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

  const setCookie = response.headers.get('set-cookie')
  if (setCookie) {
    res.setHeader('set-cookie', setCookie)
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

describe('server', () => {
  it('returns health check response', async () => {
    const dispatchServer = createServer({
      config: {
        port: 0,
        dispatchSecret: 'relay-secret',
        proxyUrls: [new URL('http://127.0.0.1:1')],
        requestTimeoutMs: 1000,
        failoverCooldownMs: 1000,
      },
    })

    const dispatchPort = await listen(dispatchServer)
    const response = await fetch(`http://127.0.0.1:${dispatchPort}/healthz`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('proxies through local agent-proxy backend and rewrites redirects', async () => {
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
        res.end(JSON.stringify({ ok: true, path: req.url, body: Buffer.concat(chunks).toString('utf8') }))
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
        const url = new URL(proxyRequest.url)
        const rewritten = new URL(proxyRequest.url)
        rewritten.protocol = 'http:'
        rewritten.hostname = '127.0.0.1'
        rewritten.port = String(upstreamPort)

        const init: RequestInit & { duplex?: 'half' } = {
          method: proxyRequest.method,
          headers: proxyRequest.headers,
          redirect: 'manual',
        }

        if (proxyRequest.body !== null && proxyRequest.method !== 'GET' && proxyRequest.method !== 'HEAD') {
          init.body = proxyRequest.body
          init.duplex = 'half'
        }

        return fetch(new Request(rewritten, init))
      })

      await writeNodeResponse(response, res)
    })

    const proxyPort = await listen(proxyServer)

    const dispatchServer = createServer({
      config: {
        port: 0,
        dispatchSecret: 'relay-secret',
        proxyUrls: [new URL(`http://127.0.0.1:${proxyPort}`)],
        requestTimeoutMs: 1000,
        failoverCooldownMs: 1000,
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

    const redirectResponse = await fetch(
      `http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/redirect`,
      { redirect: 'manual' },
    )

    expect(redirectResponse.status).toBe(302)
    expect(redirectResponse.headers.get('location')).toBe(
      `http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/done?ok=1`,
    )

    const streamResponse = await fetch(
      `http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/stream`,
    )

    expect(streamResponse.status).toBe(200)
    expect(streamResponse.headers.get('content-type')).toBe('text/event-stream')
    expect(await streamResponse.text()).toBe('data: first\n\ndata: second\n\n')

    const uploadResponse = await fetch(
      `http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/upload`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
        },
        body: 'stream-upload-body',
      },
    )

    expect(uploadResponse.status).toBe(200)
    await expect(uploadResponse.json()).resolves.toEqual({
      ok: true,
      path: '/upload',
      body: 'stream-upload-body',
    })

    const encodedResponse = await fetch(
      `http://127.0.0.1:${dispatchPort}/s/${upstreamHost}/encoded`,
    )

    expect(encodedResponse.status).toBe(200)
    expect(encodedResponse.headers.get('content-encoding')).toBeNull()
    expect(await encodedResponse.text()).toBe('<html>plain body</html>')
  })
})
