import { describe, expect, it, vi } from 'vitest'

import { dispatchRequest, type FetchImplementation } from '../src/dispatch.js'
import type { RuntimeConfig } from '../src/config.js'
import type { ProxyRoute } from '../src/routing.js'

function createConfig(): RuntimeConfig {
  return {
    port: 8787,
    dispatchSecret: 'relay-secret',
    proxyUrls: [new URL('https://proxy-a.example'), new URL('https://proxy-b.example')],
    requestTimeoutMs: 1000,
    socks5Proxy: null,
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
