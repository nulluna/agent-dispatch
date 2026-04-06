import { describe, expect, it, vi } from 'vitest'

import { handleProxyRequest, type ProxyEnv } from '../../agent-proxy/src/proxy.js'
import { dispatchRequest, type FetchImplementation } from '../src/dispatch.js'
import type { RuntimeConfig } from '../src/config.js'
import type { ProxyRoute } from '../src/routing.js'

function createConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    port: 8787,
    dispatchSecret: 'relay-secret',
    proxyUrls: [new URL('https://proxy-a.example'), new URL('https://proxy-b.example')],
    requestTimeoutMs: 1000,
    socks5Proxy: null,
    ...overrides,
  }
}

function createRoute(overrides: Partial<ProxyRoute> = {}): ProxyRoute {
  return {
    kind: 'proxy',
    protocolCode: 's',
    protocol: 'https',
    targetHost: 'www.google.com',
    targetPathname: '/search',
    targetSearch: '?q=1',
    ...overrides,
  }
}

function createFetchResponse(body: string, status: number): Response {
  return new Response(body, { status })
}

function createProxyEnv(overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    ROUTE_BASE_PATH: '',
    SELF_HOSTNAMES: '',
    DISPATCH_SECRET: 'relay-secret',
    ...overrides,
  }
}

function createRelayFetchImplementation(options: {
  failingProxyHosts?: string[]
  upstreamStatus?: number
  upstreamBody?: string
} = {}): FetchImplementation {
  const {
    failingProxyHosts = [],
    upstreamStatus = 200,
    upstreamBody = 'proxy-upstream-ok',
  } = options
  const failingHosts = new Set(failingProxyHosts)

  return async (input, init) => {
    const relayUrl = new URL(input.toString())

    if (failingHosts.has(relayUrl.host)) {
      throw Object.assign(new Error(`connect failed: ${relayUrl.host}`), { code: 'ECONNRESET' })
    }

    return handleProxyRequest(
      new Request(relayUrl, init),
      createProxyEnv(),
      async (upstreamRequest: Request) => {
        return new Response(`${upstreamBody}:${upstreamRequest.url}`, {
          status: upstreamStatus,
          headers: {
            'x-upstream-host': new URL(upstreamRequest.url).host,
          },
        })
      },
    )
  }
}

describe('dispatchRequest', () => {
  it('forwards /s requests to the first proxy relay url', async () => {
    const fetchSpy = vi.fn<FetchImplementation>(async (input) => {
      expect(input.toString()).toBe('https://proxy-a.example/relay/relay-secret/s/www.google.com/search?q=1')
      return createFetchResponse('ok', 200)
    })

    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('fails over to the next proxy when the first proxy throws', async () => {
    const fetchSpy = vi.fn<FetchImplementation>()
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    fetchSpy.mockResolvedValueOnce(createFetchResponse('ok-from-b', 200))

    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok-from-b')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does not fail over on 4xx/5xx responses', async () => {
    const fetchSpy = vi.fn<FetchImplementation>(async () => createFetchResponse('bad gateway', 502))

    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig(),
      fetchSpy,
    )

    expect(response.status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns the first 5xx response without failing over across three proxies', async () => {
    const fetchSpy = vi.fn<FetchImplementation>()
    fetchSpy.mockResolvedValueOnce(createFetchResponse('first-5xx', 503))
    fetchSpy.mockResolvedValueOnce(createFetchResponse('should-not-reach-b', 200))
    fetchSpy.mockResolvedValueOnce(createFetchResponse('should-not-reach-c', 200))

    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig({
        proxyUrls: [
          new URL('https://proxy-a.example'),
          new URL('https://proxy-b.example'),
          new URL('https://proxy-c.example'),
        ],
      }),
      fetchSpy,
    )

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('first-5xx')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[0].toString()).toBe(
      'https://proxy-a.example/relay/relay-secret/s/www.google.com/search?q=1',
    )
  })

  it('fails over in proxy order across three nodes on network errors', async () => {
    const fetchSpy = vi.fn<FetchImplementation>()
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('first reset'), { code: 'ECONNRESET' }))
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error('second timeout'), { code: 'ETIMEDOUT' }))
    fetchSpy.mockResolvedValueOnce(createFetchResponse('ok-from-c', 200))

    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig({
        proxyUrls: [
          new URL('https://proxy-a.example'),
          new URL('https://proxy-b.example'),
          new URL('https://proxy-c.example'),
        ],
      }),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok-from-c')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(fetchSpy.mock.calls.map(([input]) => input.toString())).toEqual([
      'https://proxy-a.example/relay/relay-secret/s/www.google.com/search?q=1',
      'https://proxy-b.example/relay/relay-secret/s/www.google.com/search?q=1',
      'https://proxy-c.example/relay/relay-secret/s/www.google.com/search?q=1',
    ])
  })

  it('relays through the first proxy node to the real proxy handler path', async () => {
    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig({
        proxyUrls: [
          new URL('https://proxy-a.example'),
          new URL('https://proxy-b.example'),
          new URL('https://proxy-c.example'),
        ],
      }),
      createRelayFetchImplementation({ upstreamBody: 'relayed-by-a' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-upstream-host')).toBe('www.google.com')
    expect(await response.text()).toBe('relayed-by-a:https://www.google.com/search?q=1')
  })

  it('relays through the third proxy node after two network failures', async () => {
    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig({
        proxyUrls: [
          new URL('https://proxy-a.example'),
          new URL('https://proxy-b.example'),
          new URL('https://proxy-c.example'),
        ],
      }),
      createRelayFetchImplementation({
        failingProxyHosts: ['proxy-a.example', 'proxy-b.example'],
        upstreamBody: 'relayed-by-c',
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-upstream-host')).toBe('www.google.com')
    expect(await response.text()).toBe('relayed-by-c:https://www.google.com/search?q=1')
  })

  it('does not fail over to later proxy nodes when the first relay returns 5xx', async () => {
    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/www.google.com/search?q=1'),
      createRoute(),
      createConfig({
        proxyUrls: [
          new URL('https://proxy-a.example'),
          new URL('https://proxy-b.example'),
          new URL('https://proxy-c.example'),
        ],
      }),
      createRelayFetchImplementation({
        upstreamStatus: 502,
        upstreamBody: 'first-proxy-5xx',
      }),
    )

    expect(response.status).toBe(502)
    expect(response.headers.get('x-upstream-host')).toBe('www.google.com')
    expect(await response.text()).toBe('first-proxy-5xx:https://www.google.com/search?q=1')
  })

  it('preserves the encoded relay path when routing to the proxy handler', async () => {
    const response = await dispatchRequest(
      new Request('http://dispatch.example/s/example.com:8443/v1/chat/completions?trace=1'),
      createRoute({
        targetHost: 'example.com:8443',
        targetPathname: '/v1/chat/completions',
        targetSearch: '?trace=1',
      }),
      createConfig({
        proxyUrls: [new URL('https://proxy-a.example')],
      }),
      createRelayFetchImplementation({ upstreamBody: 'encoded-host-ok' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-upstream-host')).toBe('example.com:8443')
    expect(await response.text()).toBe('encoded-host-ok:https://example.com:8443/v1/chat/completions?trace=1')
  })

  it('returns gateway error when all proxies fail by network error', async () => {
    const fetchSpy = vi.fn<FetchImplementation>()
    fetchSpy.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNRESET' }))

    await expect(
      dispatchRequest(
        new Request('http://dispatch.example/s/www.google.com/search?q=1'),
        createRoute(),
        createConfig(),
        fetchSpy,
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: 'PROXY_DISPATCH_FAILED',
    })
  })
})
