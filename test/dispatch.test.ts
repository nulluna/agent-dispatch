import { describe, expect, it, vi } from 'vitest'

import { handleDispatchRequest, type DispatchEnv } from '../src/dispatch'
import { createDispatchState } from '../src/strategy'

function createRequest(input: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${input}`, init)
}

function createEnv(overrides: Partial<DispatchEnv> = {}): DispatchEnv {
  return {
    AGENTPROXY_POOL: 'https://proxy-a.internal',
    DISPATCH_SECRET: 'relay-secret',
    DISPATCH_STRATEGY: 'poll',
    RELAY_CONNECT_TIMEOUT_MS: '10000',
    RELAY_RESPONSE_TIMEOUT_MS: '30000',
    ...overrides,
  }
}

function createDebugEnv(
  overrides: Partial<DispatchEnv> = {},
): DispatchEnv & { LOG_LEVEL: string } {
  return Object.assign(createEnv(overrides), { LOG_LEVEL: 'debug' })
}

function readSetCookies(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie

  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers)
  }

  const singleValue = headers.get('set-cookie')

  return singleValue ? [singleValue] : []
}

function readRelayBackend(call: unknown[] | undefined): string {
  if (!call) {
    throw new Error('expected relay call to exist')
  }

  const [request] = call as [Request]

  if (!(request instanceof Request)) {
    throw new Error('expected relay request to be a Request instance')
  }

  return `${new URL(request.url).origin}/`
}

describe('handleDispatchRequest', () => {
  it('rewrites an HTTPS ingress path to the internal relay URL', async () => {
    const fetchSpy = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        'https://proxy-a.internal/relay/relay-secret/s/api.openai.com/v1/responses?model=gpt-4.1',
      )
      expect(request.method).toBe('POST')
      expect(request.headers.get('authorization')).toBe('Bearer abc')
      expect(request.headers.get('user-agent')).toBe('dispatch-test')
      expect(await request.text()).toBe('{"prompt":"hello"}')

      return new Response('relay-ok', { status: 201 })
    })

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses?model=gpt-4.1', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer abc',
          'Content-Type': 'application/json',
          'User-Agent': 'dispatch-test',
          Connection: 'keep-alive',
        },
        body: '{"prompt":"hello"}',
      }),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('relay-ok')
  })

  it('rewrites an HTTP ingress path to the internal proxy relay URL', async () => {
    const fetchSpy = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        'https://proxy-a.internal/relay/relay-secret/h/example.com/search?q=test',
      )

      return new Response('http-ok', { status: 200 })
    })

    const response = await handleDispatchRequest(
      createRequest('/h/example.com/search?q=test'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('http-ok')
  })

  it('preserves a trailing slash when relaying ingress paths', async () => {
    const fetchSpy = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        'https://proxy-a.internal/relay/relay-secret/s/anyrouter.top/api/token/?p=0&size=100',
      )

      return new Response('slash-ok', { status: 200 })
    })

    const response = await handleDispatchRequest(
      createRequest('/s/anyrouter.top/api/token/?p=0&size=100'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('slash-ok')
  })

  it('rejects the former /ssl ingress path as an invalid protocol code', async () => {
    const fetchSpy = vi.fn()

    const response = await handleDispatchRequest(
      createRequest('/ssl/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_PROTOCOL_CODE',
      },
    })
  })

  it('rejects the former implicit http ingress path as an invalid protocol code', async () => {
    const fetchSpy = vi.fn()

    const response = await handleDispatchRequest(
      createRequest('/example.com/search?q=test'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_PROTOCOL_CODE',
      },
    })
  })

  it('reuses the challenge backend for hash token requests with the same challenge cookie', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(async () => {
      if (fetchSpy.mock.calls.length === 1) {
        const headers = new Headers({
          'content-type': 'application/json',
        })
        headers.append('set-cookie', 'acw_tc=challenge-x; Path=/; HttpOnly')
        headers.append('set-cookie', 'cdn_sec_tc=challenge-x; Path=/; HttpOnly')

        return new Response('challenge unauthorized', {
          status: 401,
          headers,
        })
      }

      return new Response('token-ok', { status: 200 })
    })

    const env = createEnv({
      AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
      DISPATCH_STRATEGY: 'hash',
    })

    const challengeResponse = await handleDispatchRequest(
      createRequest('/s/anyrouter.top/api/token/?p=0&size=100'),
      env,
      fetchSpy,
      state,
    )
    const challengeBackend = readRelayBackend(fetchSpy.mock.calls.at(0))

    expect(challengeResponse.status).toBe(401)
    expect(readSetCookies(challengeResponse.headers)).toEqual([
      'acw_tc=challenge-x; Path=/; HttpOnly',
      'cdn_sec_tc=challenge-x; Path=/; HttpOnly',
    ])

    const tokenResponse = await handleDispatchRequest(
      createRequest('/s/anyrouter.top/api/token/?p=0&size=100', {
        headers: {
          Cookie: 'acw_tc=challenge-x; cdn_sec_tc=challenge-x',
        },
      }),
      env,
      fetchSpy,
      state,
    )
    const tokenBackend = readRelayBackend(fetchSpy.mock.calls.at(1))

    expect(tokenResponse.status).toBe(200)
    expect(challengeBackend).toBe(tokenBackend)
  })

  it('reuses the challenge backend for poll token requests even after the site poll cache expires', async () => {
    vi.useFakeTimers()

    try {
      const state = createDispatchState()
      const fetchSpy = vi.fn(async () => {
        if (fetchSpy.mock.calls.length === 1) {
          const headers = new Headers({
            'content-type': 'application/json',
          })
          headers.append('set-cookie', 'acw_tc=challenge-x; Path=/; HttpOnly')
          headers.append('set-cookie', 'cdn_sec_tc=challenge-x; Path=/; HttpOnly')

          return new Response('challenge unauthorized', {
            status: 401,
            headers,
          })
        }

        return new Response('token-ok', { status: 200 })
      })

      const env = createEnv({
        AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
        DISPATCH_STRATEGY: 'poll',
      })

      const challengeResponse = await handleDispatchRequest(
        createRequest('/s/anyrouter.top/api/token/?p=0&size=100'),
        env,
        fetchSpy,
        state,
      )
      const challengeBackend = readRelayBackend(fetchSpy.mock.calls.at(0))

      expect(challengeResponse.status).toBe(401)
      expect(readSetCookies(challengeResponse.headers)).toEqual([
        'acw_tc=challenge-x; Path=/; HttpOnly',
        'cdn_sec_tc=challenge-x; Path=/; HttpOnly',
      ])

      vi.advanceTimersByTime(8_001)

      const tokenResponse = await handleDispatchRequest(
        createRequest('/s/anyrouter.top/api/token/?p=0&size=100', {
          headers: {
            Cookie: 'acw_tc=challenge-x; cdn_sec_tc=challenge-x',
          },
        }),
        env,
        fetchSpy,
        state,
      )
      const tokenBackend = readRelayBackend(fetchSpy.mock.calls.at(1))

      expect(tokenResponse.status).toBe(200)
      expect(challengeBackend).toBe(tokenBackend)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs the selected dispatch strategy and backend at info level', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('logged-ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses'),
        createEnv({ DISPATCH_STRATEGY: 'hash' }),
        fetchSpy,
      )

      expect(response.status).toBe(200)
      expect(infoSpy).toHaveBeenCalledWith(
        '[agent-dispatch] selected backend',
        expect.objectContaining({
          strategy: 'hash',
          backend: 'https://proxy-a.internal/',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('logs protocol, model id, and user-agent for recognized requests on successful responses', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200, statusText: 'OK' }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'dispatch-test',
          },
          body: JSON.stringify({
            model: 'gpt-5',
            input: 'hello',
          }),
        }),
        createEnv(),
        fetchSpy,
      )

      expect(response.status).toBe(200)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[wrangler:info\] POST \/s\/api\.openai\.com\/v1\/responses 200 OK \(\d+ms\)$/,
        ),
        expect.objectContaining({
          protocol: 'openai-responses',
          modelId: 'gpt-5',
          userAgent: 'dispatch-test',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('does not log request headers or hash details below debug level', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('logged-ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses', {
          headers: {
            Authorization: 'Bearer abc',
            'User-Agent': 'dispatch-test',
            'X-Trace-Id': 'trace-1',
          },
        }),
        createEnv({
          AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
          DISPATCH_STRATEGY: 'hash',
        }),
        fetchSpy,
      )

      expect(response.status).toBe(200)
      expect(debugSpy).not.toHaveBeenCalled()
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('logs redacted request headers and hash routing details at debug level', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('logged-ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses?stream=true', {
          headers: {
            Authorization: 'Bearer abc',
            'User-Agent': 'dispatch-test',
            'X-Trace-Id': 'trace-1',
          },
        }),
        createDebugEnv({
          AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
          DISPATCH_STRATEGY: 'hash',
        }),
        fetchSpy,
      )

      expect(response.status).toBe(200)
      expect(debugSpy).toHaveBeenCalledWith(
        '[agent-dispatch] debug request',
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer a***',
            'user-agent': 'dispatch-test',
            'x-trace-id': 'trace-1',
          }),
          selection: expect.objectContaining({
            strategy: 'hash',
            stickySource: 'auth-authorization',
            accountHash: expect.stringMatching(/^[0-9a-f]{8}$/),
            hashValue: expect.any(Number),
            selectedIndex: expect.any(Number),
            poolLength: 2,
          }),
        }),
      )

      const debugPayload = debugSpy.mock.calls.at(0)?.[1]

      expect(debugPayload).toBeDefined()
      expect(debugPayload?.headers).not.toBeInstanceOf(Headers)
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('prefers new-api-user over lower-priority sticky headers when building the hash input', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('logged-ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses?stream=true', {
          headers: {
            'New-Api-User': 'user-123',
            Authorization: 'Bearer abc',
            'X-Auth-Token': 'token-123',
            Cookie: 'theme=dark; session=session-123',
            'User-Agent': 'dispatch-test',
          },
        }),
        createDebugEnv({
          AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
          DISPATCH_STRATEGY: 'hash',
        }),
        fetchSpy,
      )

      expect(response.status).toBe(200)
      expect(debugSpy).toHaveBeenCalledWith(
        '[agent-dispatch] debug request',
        expect.objectContaining({
          selection: expect.objectContaining({
            strategy: 'hash',
            stickySource: 'auth-new-api-user',
            accountHash: expect.stringMatching(/^[0-9a-f]{8}$/),
          }),
        }),
      )
    } finally {
      debugSpy.mockRestore()
    }
  })

  it('logs ignored auth-like headers at info level when hash routing falls back to site scope', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses', {
          headers: {
            'X-Access-Token': 'secret-token',
            'Proxy-Authorization': 'internal-proxy-token',
          },
        }),
        createEnv({
          AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
          DISPATCH_STRATEGY: 'hash',
        }),
        fetchSpy,
      )

      expect(response.status).toBe(200)
      expect(infoSpy).toHaveBeenCalledWith(
        '[agent-dispatch] sticky auth-like headers ignored',
        expect.objectContaining({
          targetAuthority: 'api.openai.com',
          headers: expect.objectContaining({
            'x-access-token': 'secret-t***',
            'proxy-authorization': 'internal***',
          }),
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it.each(['/', '/s', '/h'])(
    'rejects a missing authority before contacting agentproxy: %s',
    async (path) => {
      const fetchSpy = vi.fn()

      const response = await handleDispatchRequest(
        createRequest(path),
        createEnv(),
        fetchSpy,
      )

      expect(response.status).toBe(400)
      expect(fetchSpy).not.toHaveBeenCalled()
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'MISSING_AUTHORITY',
        },
      })
    },
  )

  it('rejects malformed target authorities before relay', async () => {
    const fetchSpy = vi.fn()

    const response = await handleDispatchRequest(
      createRequest('/s/https:%2F%2Fbad/v1/chat'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_AUTHORITY',
      },
    })
  })

  it('rejects a non-https proxy pool configuration', async () => {
    const fetchSpy = vi.fn()

    const response = await handleDispatchRequest(
      createRequest('/s/example.com'),
      createEnv({ AGENTPROXY_POOL: 'http://proxy-a.internal' }),
      fetchSpy,
    )

    expect(response.status).toBe(500)
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INVALID_CONFIGURATION',
      },
    })
  })

  it('relays status, repeated Set-Cookie values and streaming bodies transparently', async () => {
    const encoder = new TextEncoder()
    const relayBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
        controller.enqueue(encoder.encode('data: second\n\n'))
        controller.close()
      },
    })

    const fetchSpy = vi.fn(async () => {
      const headers = new Headers({
        'content-type': 'text/event-stream',
      })

      headers.append('set-cookie', 'a=1; Path=/; HttpOnly')
      headers.append('set-cookie', 'b=2; Path=/; Secure')

      return new Response(relayBody, {
        status: 202,
        headers,
      })
    })

    const response = await handleDispatchRequest(
      createRequest('/s/stream.example.com/events'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(readSetCookies(response.headers)).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Path=/; Secure',
    ])
    expect(await response.text()).toBe('data: first\n\ndata: second\n\n')
  })

  it('rewrites an absolute https Location through CURRENT_DOMAIN', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: 'https://login.example.com/oauth/start?client_id=abc',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      'http://dispatch.example.com/s/login.example.com/oauth/start?client_id=abc',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rewrites an absolute http Location through CURRENT_DOMAIN with /h', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: 'http://legacy.example.com/signin?from=dispatch',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/account/profile'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      'http://dispatch.example.com/h/legacy.example.com/signin?from=dispatch',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rewrites a relative Location through CURRENT_DOMAIN using the current upstream site', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: '../login?next=%2Fhome',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/account/profile'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      'http://dispatch.example.com/s/api.openai.com/login?next=%2Fhome',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rewrites the url target inside a Refresh header through CURRENT_DOMAIN', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            Refresh: '0; url="https://login.example.com/oauth/start?client_id=abc"',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('refresh')).toBe(
      '0; url="http://dispatch.example.com/s/login.example.com/oauth/start?client_id=abc"',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps relative dispatch rewriting when CURRENT_DOMAIN is not configured', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: '../login?next=%2Fhome',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/account/profile'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      '/s/api.openai.com/login?next=%2Fhome',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps non-http Location values unchanged', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: 'mailto:support@example.com',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/account/profile'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('mailto:support@example.com')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not double-wrap an already dispatched https Location', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: '/s/login.example.com/oauth/start?client_id=abc',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      'http://dispatch.example.com/s/login.example.com/oauth/start?client_id=abc',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('preserves 301 status without following redirects server-side', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: 'https://login.example.com/oauth/start?client_id=abc',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('sends a single relay request for a normal 200 response', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }))

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('sends a single relay request for a 301 response', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: 'https://login.example.com/oauth/start?client_id=abc',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv({ CURRENT_DOMAIN: 'dispatch.example.com' }),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns a cached negative response without contacting relay again', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(async () => new Response('not found', { status: 404 }))
    const env = createEnv({
      DISPATCH_STRATEGY: 'hash',
      DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
      AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
    })

    const first = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/models', {
        headers: { Authorization: 'Bearer abc' },
      }),
      env,
      fetchSpy,
      state,
    )
    const second = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/models', {
        headers: { Authorization: 'Bearer abc' },
      }),
      env,
      fetchSpy,
      state,
    )

    expect(first.status).toBe(404)
    expect(second.status).toBe(404)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('sends a probe request after a cached negative response expires', async () => {
    vi.useFakeTimers()

    try {
      const state = createDispatchState()
      const fetchSpy = vi.fn(async () => new Response('not found', { status: 404 }))
      const env = createEnv({
        DISPATCH_STRATEGY: 'hash',
        DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
        AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
      })

      await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/models', {
          headers: { Authorization: 'Bearer abc' },
        }),
        env,
        fetchSpy,
        state,
      )

      vi.advanceTimersByTime(60 * 60 * 1000 + 1)

      await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/models', {
          headers: { Authorization: 'Bearer abc' },
        }),
        env,
        fetchSpy,
        state,
      )

      expect(fetchSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs a readable info line for 301 responses with rewritten location', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 301,
          headers: {
            Location: 'https://login.example.com/oauth/start?client_id=abc',
          },
        }),
    )

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses'),
        createEnv(),
        fetchSpy,
      )

      expect(response.status).toBe(301)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[wrangler:info\] GET \/s\/api\.openai\.com\/v1\/responses 301 Moved Permanently \(\d+ms\)$/,
        ),
        expect.objectContaining({
          location: '/s/login.example.com/oauth/start?client_id=abc',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('preserves a Refresh header without url unchanged', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            Refresh: '5',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('refresh')).toBe('5')
  })

  it('logs local 400 DispatchError details in a readable info line', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      const response = await handleDispatchRequest(
        createRequest('/s'),
        createEnv(),
      )

      expect(response.status).toBe(400)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[wrangler:info\] GET \/s 400 Bad Request \(\d+ms\)$/,
        ),
        expect.objectContaining({
          error: 'MISSING_AUTHORITY',
          message: '缺少上游 authority',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('logs upstream 401 error details in a readable info line', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_api_key',
              message: 'Invalid API key',
            },
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        ),
    )

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses'),
        createEnv(),
        fetchSpy,
      )

      expect(response.status).toBe(401)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[wrangler:info\] GET \/s\/api\.openai\.com\/v1\/responses 401 Unauthorized \(\d+ms\)$/,
        ),
        expect.objectContaining({
          error: 'invalid_api_key',
          message: 'Invalid API key',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('merges protocol fields into readable info logs for recognized error responses', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_api_key',
              message: 'Invalid API key',
            },
          }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        ),
    )

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'dispatch-test',
          },
          body: JSON.stringify({
            model: 'gpt-4.1',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        }),
        createEnv(),
        fetchSpy,
      )

      expect(response.status).toBe(401)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[wrangler:info\] POST \/s\/api\.openai\.com\/v1\/chat\/completions 401 Unauthorized \(\d+ms\)$/,
        ),
        expect.objectContaining({
          protocol: 'openai-chat-completions',
          modelId: 'gpt-4.1',
          userAgent: 'dispatch-test',
          error: 'invalid_api_key',
          message: 'Invalid API key',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('logs upstream 502 error details in a readable info line', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'upstream_unavailable',
              message: 'Upstream temporarily unavailable',
            },
          }),
          {
            status: 502,
            headers: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        ),
    )

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/api.openai.com/v1/responses'),
        createEnv(),
        fetchSpy,
      )

      expect(response.status).toBe(502)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[wrangler:info\] GET \/s\/api\.openai\.com\/v1\/responses 502 Bad Gateway \(\d+ms\)$/,
        ),
        expect.objectContaining({
          error: 'upstream_unavailable',
          message: 'Upstream temporarily unavailable',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('logs local 502 relay fetch failure details in a readable info line', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => {
      throw new Error('selected proxy failed')
    })

    try {
      const response = await handleDispatchRequest(
        createRequest('/s/example.com/v1/chat'),
        createEnv(),
        fetchSpy,
      )

      expect(response.status).toBe(502)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[wrangler:info\] GET \/s\/example\.com\/v1\/chat 502 Bad Gateway \(\d+ms\)$/,
        ),
        expect.objectContaining({
          error: 'RELAY_FETCH_FAILED',
          message: '内部 relay 请求失败',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('does not switch to another proxy when the selected node fails', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(async (_request: Request) => {
      throw new Error('selected proxy failed')
    })

    const response = await handleDispatchRequest(
      createRequest('/s/example.com/v1/chat'),
      createEnv({
        AGENTPROXY_POOL: 'https://proxy-a.internal,https://proxy-b.internal',
      }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(502)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const firstCall = fetchSpy.mock.calls.at(0)

    expect(firstCall).toBeDefined()

    if (!firstCall) {
      throw new Error('expected first relay call to exist')
    }

    const [relayRequest] = firstCall

    expect(relayRequest).toBeInstanceOf(Request)
    expect(new URL(relayRequest.url).host).toBe('proxy-a.internal')
  })

  it('returns a timeout error when the relay connection exceeds the configured limit after all retries', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined))

    const response = await handleDispatchRequest(
      createRequest('/s/example.com/v1/chat'),
      createEnv({ RELAY_CONNECT_TIMEOUT_MS: '5' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(504)
    // 1 initial + 3 retries (delays: 0ms, 500ms, 1000ms)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'RELAY_CONNECT_TIMEOUT',
      },
    })
    // (c) 验证 timeout 失败计数
    expect(state.relayStats.timeoutFailures).toBe(4)
    expect(state.relayStats.retrySuccesses).toBe(0)
  })

  it('tracks relay stats when retry succeeds after timeout failures', async () => {
    const state = createDispatchState()
    let callCount = 0

    const fetchSpy = vi.fn(async () => {
      callCount++
      if (callCount <= 2) {
        return new Promise<Response>(() => undefined)
      }
      return new Response('ok', { status: 200 })
    })

    const response = await handleDispatchRequest(
      createRequest('/s/example.com/v1/chat'),
      createEnv({ RELAY_CONNECT_TIMEOUT_MS: '5' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(200)
    expect(state.relayStats.timeoutFailures).toBe(2)
    expect(state.relayStats.retrySuccesses).toBe(1)
  })

  it('applies DNS resolution when DNS_RESOLVE is configured', async () => {
    const state = createDispatchState()
    let capturedUrl = ''

    const fetchSpy = vi.fn(async (request: Request) => {
      capturedUrl = request.url
      return new Response('ok', { status: 200 })
    })

    const response = await handleDispatchRequest(
      createRequest('/s/example.com/v1/chat'),
      createEnv({ DNS_RESOLVE: 'proxy-a.internal=1.2.3.4' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(200)
    expect(capturedUrl).toContain('1.2.3.4')

    const firstCall = fetchSpy.mock.calls.at(0)

    expect(firstCall).toBeDefined()

    if (!firstCall) {
      throw new Error('expected DNS-resolved relay call to exist')
    }

    const [relayRequest] = firstCall as [Request]
    expect(relayRequest.headers.get('host')).toBe('proxy-a.internal')
  })

  it('skips DNS resolution when no mapping matches the relay host', async () => {
    const state = createDispatchState()
    let capturedUrl = ''

    const fetchSpy = vi.fn(async (request: Request) => {
      capturedUrl = request.url
      return new Response('ok', { status: 200 })
    })

    const response = await handleDispatchRequest(
      createRequest('/s/example.com/v1/chat'),
      createEnv({ DNS_RESOLVE: 'unrelated.host=1.2.3.4' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(200)
    expect(capturedUrl).toContain('proxy-a.internal')
    expect(capturedUrl).not.toContain('1.2.3.4')
  })

  it('does not apply DNS resolution when DNS_RESOLVE is empty', async () => {
    const state = createDispatchState()
    let capturedUrl = ''

    const fetchSpy = vi.fn(async (request: Request) => {
      capturedUrl = request.url
      return new Response('ok', { status: 200 })
    })

    const response = await handleDispatchRequest(
      createRequest('/s/example.com/v1/chat'),
      createEnv(),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(200)
    expect(capturedUrl).toContain('proxy-a.internal')
  })

  it('fails the client stream when the relay response body exceeds the configured timeout', async () => {
    const state = createDispatchState()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
            },
          },
        ),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/example.com/stream'),
      createEnv({ RELAY_RESPONSE_TIMEOUT_MS: '5' }),
      fetchSpy,
      state,
    )

    try {
      expect(response.status).toBe(200)
      await expect(response.text()).rejects.toThrow('内部 relay 响应超时')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        '[agent-dispatch] relay response bridge failed',
        expect.objectContaining({
          requestPath: '/s/example.com/stream',
          upstreamUrl: 'https://example.com/stream',
          status: 200,
          contentType: 'text/event-stream',
          error: '内部 relay 响应超时',
        }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps relay response timeout for ndjson streaming responses', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/x-ndjson',
            },
          },
        ),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/ollama.local/api/generate'),
      createEnv({ RELAY_RESPONSE_TIMEOUT_MS: '5' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toThrow('内部 relay 响应超时')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not apply relay response timeout to slow non-streaming JSON error bodies', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"error":{"message":"An error occurred while processing'),
              )

              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(
                    ' your request.","request_id":"req_123"}}',
                  ),
                )
                controller.close()
              }, 20)
            },
          }),
          {
            status: 500,
            headers: {
              'content-type': 'application/json; charset=utf-8',
            },
          },
        ),
    )

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv({ RELAY_RESPONSE_TIMEOUT_MS: '5' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toContain('An error occurred while processing your request.')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('skips ingress auth when DISPATCH_INGRESS_KEY is not configured', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }))

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects requests without an ingress token when ingress auth is enabled', async () => {
    const fetchSpy = vi.fn()

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses'),
      createEnv({ DISPATCH_INGRESS_KEY: 'correct-key' }),
      fetchSpy,
    )

    expect(response.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INGRESS_UNAUTHORIZED' },
    })
  })

  it('rejects requests with a wrong ingress token when ingress auth is enabled', async () => {
    const fetchSpy = vi.fn()

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses', {
        headers: { 'x-dispatch-token': 'wrong-key' },
      }),
      createEnv({ DISPATCH_INGRESS_KEY: 'correct-key' }),
      fetchSpy,
    )

    expect(response.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INGRESS_UNAUTHORIZED' },
    })
  })

  it('allows requests with the correct ingress token', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }))

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses', {
        headers: {
          'x-dispatch-token': 'correct-key',
          Authorization: 'Bearer abc',
        },
      }),
      createEnv({ DISPATCH_INGRESS_KEY: 'correct-key' }),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('uses a custom ingress header name when configured', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }))

    const response = await handleDispatchRequest(
      createRequest('/s/api.openai.com/v1/responses', {
        headers: {
          'x-my-project-auth': 'correct-key',
          Authorization: 'Bearer abc',
        },
      }),
      createEnv({
        DISPATCH_INGRESS_KEY: 'correct-key',
        DISPATCH_INGRESS_HEADER: 'X-My-Project-Auth',
      }),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // --- 负向缓存集成测试 ---

  it('does not use negative cache under hash strategy when cache is not explicitly enabled', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = createDispatchState()
    let callCount = 0

    const fetchSpy = vi.fn(async () => {
      callCount++
      return new Response('unauthorized', { status: 401 })
    })

    const env = createEnv({
      DISPATCH_STRATEGY: 'hash',
      AGENTPROXY_POOL: 'https://proxy-a.internal',
    })

    const makeRequest = () =>
      createRequest('/s/api.openai.com/v1/responses?model=gpt-4', {
        headers: { Authorization: 'Bearer test-key' },
      })

    try {
      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(401)
      expect(await response1.text()).toBe('unauthorized')
      expect(callCount).toBe(1)

      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(401)
      expect(await response2.text()).toBe('unauthorized')
      expect(callCount).toBe(2)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('caches a 401 response under hash strategy when negative cache is explicitly enabled', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = createDispatchState()
    let callCount = 0

    const fetchSpy = vi.fn(async () => {
      callCount++
      return new Response('unauthorized', { status: 401 })
    })

    const env = {
      ...createEnv({
        DISPATCH_STRATEGY: 'hash',
        AGENTPROXY_POOL: 'https://proxy-a.internal',
      }),
      DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
    } as DispatchEnv & { DISPATCH_NEGATIVE_CACHE_ENABLED: string }

    const makeRequest = () =>
      createRequest('/s/api.openai.com/v1/responses?model=gpt-4', {
        headers: { Authorization: 'Bearer test-key' },
      })

    try {
      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(401)
      expect(await response1.text()).toBe('unauthorized')
      expect(callCount).toBe(1)

      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(401)
      expect(await response2.text()).toBe('unauthorized')
      expect(callCount).toBe(1)

      expect(infoSpy).toHaveBeenCalledWith(
        '[agent-dispatch] negative cache hit',
        expect.objectContaining({ status: 401 }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('does not cache challenge-shaped 401 responses under hash strategy', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = createDispatchState()
    let callCount = 0

    const fetchSpy = vi.fn(async () => {
      callCount++

      const headers = new Headers({
        'content-type': 'application/json',
      })
      headers.append('set-cookie', 'acw_tc=challenge-1; Path=/; HttpOnly')
      headers.append('set-cookie', 'cdn_sec_tc=challenge-1; Path=/; HttpOnly')

      return new Response('challenge unauthorized', {
        status: 401,
        headers,
      })
    })

    const env = createEnv({
      DISPATCH_STRATEGY: 'hash',
      AGENTPROXY_POOL: 'https://proxy-a.internal',
      DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
    })

    const makeRequest = () =>
      createRequest('/s/anyrouter.top/v1/models', {
        headers: { Authorization: 'Bearer test-key' },
      })

    try {
      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(401)
      expect(await response1.text()).toBe('challenge unauthorized')
      expect(callCount).toBe(1)

      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(401)
      expect(await response2.text()).toBe('challenge unauthorized')
      expect(callCount).toBe(2)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('caches a 404 response under hash site-fallback with 30s TTL', async () => {
    vi.useFakeTimers()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      const state = createDispatchState()
      let callCount = 0

      const fetchSpy = vi.fn(async () => {
        callCount++
        return new Response('not found', { status: 404 })
      })

      const env = createEnv({
        DISPATCH_STRATEGY: 'hash',
        AGENTPROXY_POOL: 'https://proxy-a.internal',
        DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
      })

      // 无 auth header → site-fallback 模式
      const makeRequest = () => createRequest('/s/api.example.com/v1/resource')

      // 第一次请求
      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(404)
      expect(callCount).toBe(1)

      // 10s 后：仍在 30s TTL 内，走缓存
      vi.advanceTimersByTime(10_000)
      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(404)
      expect(callCount).toBe(1)

      // 31s 后：TTL 过期，放行探测
      vi.advanceTimersByTime(21_000)
      const response3 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response3.status).toBe(404)
      expect(callCount).toBe(2) // 探测请求被转发
    } finally {
      infoSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not cache a site-fallback 401 response without an account-bound identifier', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = createDispatchState()
    let callCount = 0

    const fetchSpy = vi.fn(async () => {
      callCount++
      return new Response('unauthorized', { status: 401 })
    })

    const env = createEnv({
      DISPATCH_STRATEGY: 'hash',
      AGENTPROXY_POOL: 'https://proxy-a.internal',
      DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
    })

    const makeRequest = () => createRequest('/s/anyrouter.top/api/user/self')

    try {
      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(401)
      expect(await response1.text()).toBe('unauthorized')
      expect(callCount).toBe(1)

      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(401)
      expect(await response2.text()).toBe('unauthorized')
      expect(callCount).toBe(2)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('caches 429 response and respects Retry-After header', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = createDispatchState()
    let callCount = 0

    const fetchSpy = vi.fn(async () => {
      callCount++
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })
    })

    const env = createEnv({
      DISPATCH_STRATEGY: 'hash',
      AGENTPROXY_POOL: 'https://proxy-a.internal',
      DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
    })

    const makeRequest = () =>
      createRequest('/s/api.openai.com/v1/responses', {
        headers: { Authorization: 'Bearer test-key' },
      })

    try {
      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(429)
      expect(callCount).toBe(1)

      // 缓存命中
      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(429)
      expect(await response2.text()).toBe('rate limited')
      expect(callCount).toBe(1)

      // 验证 Retry-After 头也被缓存
      expect(response2.headers.get('retry-after')).toBe('60')
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('cached response matches original upstream status, headers, and body', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = createDispatchState()

    const fetchSpy = vi.fn(async () => {
      return new Response('{"error":"forbidden"}', {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-abc-123',
        },
      })
    })

    const env = createEnv({
      DISPATCH_STRATEGY: 'hash',
      AGENTPROXY_POOL: 'https://proxy-a.internal',
      DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
    })

    const makeRequest = () =>
      createRequest('/s/api.openai.com/v1/chat', {
        headers: { Authorization: 'Bearer test-key' },
      })

    try {
      await handleDispatchRequest(makeRequest(), env, fetchSpy, state)

      // 第二次请求走缓存
      const cached = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(cached.status).toBe(403)
      expect(cached.headers.get('content-type')).toBe('application/json')
      expect(cached.headers.get('x-request-id')).toBe('req-abc-123')
      expect(await cached.text()).toBe('{"error":"forbidden"}')
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('does not use negative cache under poll strategy', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = createDispatchState()
    let callCount = 0

    const fetchSpy = vi.fn(async () => {
      callCount++
      return new Response('not found', { status: 404 })
    })

    const env = createEnv({
      DISPATCH_STRATEGY: 'poll',
      AGENTPROXY_POOL: 'https://proxy-a.internal',
    })

    const makeRequest = () =>
      createRequest('/s/api.openai.com/v1/responses', {
        headers: { Authorization: 'Bearer test-key' },
      })

    try {
      await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      await handleDispatchRequest(makeRequest(), env, fetchSpy, state)

      // poll 策略不缓存，两次都转发
      expect(callCount).toBe(2)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('clears negative cache when probe returns a successful response', async () => {
    vi.useFakeTimers()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      const state = createDispatchState()
      let callCount = 0

      const fetchSpy = vi.fn(async () => {
        callCount++
        // 第一次返回 401，第二次（探测）返回 200
        if (callCount <= 1) {
          return new Response('unauthorized', { status: 401 })
        }
        return new Response('ok', { status: 200 })
      })

      const env = createEnv({
        DISPATCH_STRATEGY: 'hash',
        AGENTPROXY_POOL: 'https://proxy-a.internal',
        DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
      })

      const makeRequest = () =>
        createRequest('/s/api.openai.com/v1/responses', {
          headers: { Authorization: 'Bearer test-key' },
        })

      // 第一次请求，缓存 401
      await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(callCount).toBe(1)

      // TTL 过期 → 探测放行
      vi.advanceTimersByTime(60 * 60 * 1000 + 1)
      const probeResponse = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(probeResponse.status).toBe(200)
      expect(await probeResponse.text()).toBe('ok')
      expect(callCount).toBe(2)

      // 缓存已清除，后续请求直接转发
      const response3 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response3.status).toBe(200)
      expect(callCount).toBe(3)
    } finally {
      infoSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('clears stale negative cache entries when a probe returns a challenge response', async () => {
    vi.useFakeTimers()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      const state = createDispatchState()
      let callCount = 0

      const fetchSpy = vi.fn(async () => {
        callCount++

        if (callCount === 1) {
          return new Response('unauthorized', { status: 401 })
        }

        const headers = new Headers({
          'content-type': 'application/json',
        })
        headers.append('set-cookie', 'acw_tc=challenge-2; Path=/; HttpOnly')
        headers.append('set-cookie', 'cdn_sec_tc=challenge-2; Path=/; HttpOnly')

        return new Response('challenge unauthorized', {
          status: 401,
          headers,
        })
      })

      const env = createEnv({
        DISPATCH_STRATEGY: 'hash',
        AGENTPROXY_POOL: 'https://proxy-a.internal',
        DISPATCH_NEGATIVE_CACHE_ENABLED: 'true',
      })

      const makeRequest = () =>
        createRequest('/s/anyrouter.top/v1/models', {
          headers: { Authorization: 'Bearer test-key' },
        })

      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(401)
      expect(await response1.text()).toBe('unauthorized')
      expect(callCount).toBe(1)

      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(401)
      expect(await response2.text()).toBe('unauthorized')
      expect(callCount).toBe(1)

      vi.advanceTimersByTime(60 * 60 * 1000 + 1)

      const probeResponse = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(probeResponse.status).toBe(401)
      expect(await probeResponse.text()).toBe('challenge unauthorized')
      expect(callCount).toBe(2)

      const response4 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response4.status).toBe(401)
      expect(await response4.text()).toBe('challenge unauthorized')
      expect(callCount).toBe(3)
    } finally {
      infoSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
