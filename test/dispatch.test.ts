import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type RuntimeConfig } from '../src/config.js'
import { buildRelayUrl, dispatchRequest, resetProxyRotation } from '../src/dispatch.js'
import type { ProxyRoute } from '../src/routing.js'

const route: ProxyRoute = {
  kind: 'proxy',
  routingMode: 'explicit',
  protocolCode: 's',
  protocol: 'https',
  targetHost: 'example.com:8443',
  targetPathname: '/v1/chat/completions',
  targetSearch: '?trace=1',
}

function createConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    port: 8787,
    transparentPort: null,
    dispatchSecret: 'relay-secret',
    proxyUrls: [new URL('https://proxy-a.example/base'), new URL('https://proxy-b.example')],
    requestTimeoutMs: 50,
    failoverCooldownMs: 3000,
    backendSelectionStrategy: 'consistent-hashing',
    ...overrides,
  }
}

describe('dispatch', () => {
  beforeEach(() => {
    resetProxyRotation()
  })

  it('builds relay url compatible with agent-proxy', () => {
    expect(
      buildRelayUrl(new URL('https://proxy-a.example/base/'), 'relay-secret', route).toString(),
    ).toBe(
      'https://proxy-a.example/base/relay/relay-secret/s/example.com%3A8443/v1/chat/completions?trace=1',
    )
  })

  it('rotates proxy starting point with round robin', async () => {
    const seen: string[] = []
    const fetchSpy = vi.fn(async (request: Request) => {
      seen.push(request.url)
      return new Response('ok', { status: 200 })
    })

    await dispatchRequest(
      new Request('https://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1'),
      route,
      createConfig({ backendSelectionStrategy: 'round-robin' }),
      fetchSpy,
    )

    await dispatchRequest(
      new Request('https://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1'),
      route,
      createConfig({ backendSelectionStrategy: 'round-robin' }),
      fetchSpy,
    )

    expect(seen[0]).toContain('proxy-a.example/base/relay/relay-secret/s/example.com%3A8443')
    expect(seen[1]).toContain('proxy-b.example/relay/relay-secret/s/example.com%3A8443')
  })

  it('keeps the same backend for the same route with consistent hashing', async () => {
    const seen: string[] = []
    const fetchSpy = vi.fn(async (request: Request) => {
      seen.push(request.url)
      return new Response('ok', { status: 200 })
    })

    await dispatchRequest(
      new Request('https://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1'),
      route,
      createConfig({ backendSelectionStrategy: 'consistent-hashing' }),
      fetchSpy,
    )

    await dispatchRequest(
      new Request('https://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1'),
      route,
      createConfig({ backendSelectionStrategy: 'consistent-hashing' }),
      fetchSpy,
    )

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it('fails over to the next backend on retryable network error', async () => {
    const fetchSpy = vi
      .fn<(_: Request) => Promise<Response>>()
      .mockImplementationOnce(async () => {
        const error = new Error('socket reset') as Error & { code?: string }
        error.code = 'ECONNRESET'
        throw error
      })
      .mockImplementationOnce(async () => new Response('ok', { status: 200 }))

    const response = await dispatchRequest(
      new Request('https://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1'),
      route,
      createConfig(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('streams request body to one selected backend without failover', async () => {
    const seen: string[] = []
    const fetchSpy = vi.fn(async (request: Request) => {
      seen.push(request.url)
      expect(await request.text()).toBe('stream-body')
      return new Response('stream-ok', { status: 200 })
    })

    const response = await dispatchRequest(
      new Request('https://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
        },
        body: 'stream-body',
      }),
      route,
      createConfig({ backendSelectionStrategy: 'round-robin' }),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('stream-ok')
    expect(seen).toHaveLength(1)
  })

  it('rewrites redirects only for explicit proxy mode', async () => {
    const fetchSpy = vi.fn(async () => {
      const headers = new Headers({
        location: 'https://example.com:8443/login/next?step=2',
        refresh: '0; url=/login/final',
      })

      return new Response(null, {
        status: 302,
        headers,
      })
    })

    const explicitResponse = await dispatchRequest(
      new Request('https://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1'),
      route,
      createConfig(),
      fetchSpy,
    )

    expect(explicitResponse.headers.get('location')).toBe(
      'https://dispatch.local/s/example.com%3A8443/login/next?step=2',
    )
    expect(explicitResponse.headers.get('refresh')).toBe(
      '0; url=https://dispatch.local/s/example.com%3A8443/login/final',
    )

    const transparentResponse = await dispatchRequest(
      new Request('https://dispatch.local/login/start', { redirect: 'manual' }),
      {
        ...route,
        routingMode: 'transparent',
        targetPathname: '/login/start',
        targetSearch: '',
      },
      createConfig(),
      fetchSpy,
    )

    expect(transparentResponse.headers.get('location')).toBe(
      'https://example.com:8443/login/next?step=2',
    )
    expect(transparentResponse.headers.get('refresh')).toBe('0; url=/login/final')
  })
})
