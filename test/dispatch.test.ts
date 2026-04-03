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

describe('handleDispatchRequest', () => {
  it('rewrites an HTTPS ingress path to the internal relay URL', async () => {
    const fetchSpy = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        'https://proxy-a.internal/relay/relay-secret/proxyssl/api.openai.com/v1/responses?model=gpt-4.1',
      )
      expect(request.method).toBe('POST')
      expect(request.headers.get('authorization')).toBe('Bearer abc')
      expect(request.headers.get('user-agent')).toBe('dispatch-test')
      expect(await request.text()).toBe('{"prompt":"hello"}')

      return new Response('relay-ok', { status: 201 })
    })

    const response = await handleDispatchRequest(
      createRequest('/ssl/api.openai.com/v1/responses?model=gpt-4.1', {
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
        'https://proxy-a.internal/relay/relay-secret/proxy/example.com/search?q=test',
      )

      return new Response('http-ok', { status: 200 })
    })

    const response = await handleDispatchRequest(
      createRequest('/example.com/search?q=test'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('http-ok')
  })

  it('logs the selected dispatch strategy and backend at info level', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('logged-ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/ssl/api.openai.com/v1/responses'),
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

  it('does not log request headers or hash details below debug level', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('logged-ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/ssl/api.openai.com/v1/responses', {
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
        createRequest('/ssl/api.openai.com/v1/responses?stream=true', {
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

  it('prefers the session cookie over authorization when building the sticky hash input', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const fetchSpy = vi.fn(async () => new Response('logged-ok', { status: 200 }))

    try {
      const response = await handleDispatchRequest(
        createRequest('/ssl/api.openai.com/v1/responses?stream=true', {
          headers: {
            Authorization: 'Bearer abc',
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
            stickySource: 'cookie-session',
            accountHash: expect.stringMatching(/^[0-9a-f]{8}$/),
          }),
        }),
      )
    } finally {
      debugSpy.mockRestore()
    }
  })

  it.each(['/', '/ssl'])(
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
      createRequest('/ssl/https:%2F%2Fbad/v1/chat'),
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
      createRequest('/ssl/example.com'),
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
      createRequest('/ssl/stream.example.com/events'),
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

  it('preserves 301 while rewriting an absolute https Location through agent-dispatch', async () => {
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
      createRequest('/ssl/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      '/ssl/login.example.com/oauth/start?client_id=abc',
    )
  })

  it('preserves 301 while rewriting a relative Location through agent-dispatch', async () => {
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
      createRequest('/ssl/api.openai.com/account/profile'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(
      '/ssl/api.openai.com/login?next=%2Fhome',
    )
  })

  it('rewrites the url target inside a Refresh header through agent-dispatch', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            Refresh: '0; url=https://login.example.com/oauth/start?client_id=abc',
          },
        }),
    )

    const response = await handleDispatchRequest(
      createRequest('/ssl/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('refresh')).toBe(
      '0; url=/ssl/login.example.com/oauth/start?client_id=abc',
    )
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
      createRequest('/ssl/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('refresh')).toBe('5')
  })

  it('does not switch to another proxy when the selected node fails', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(async (_request: Request) => {
      throw new Error('selected proxy failed')
    })

    const response = await handleDispatchRequest(
      createRequest('/ssl/example.com/v1/chat'),
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
      createRequest('/ssl/example.com/v1/chat'),
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
      createRequest('/ssl/example.com/v1/chat'),
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
      createRequest('/ssl/example.com/v1/chat'),
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
      createRequest('/ssl/example.com/v1/chat'),
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
      createRequest('/ssl/example.com/v1/chat'),
      createEnv(),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(200)
    expect(capturedUrl).toContain('proxy-a.internal')
  })

  it('fails the client stream when the relay response body exceeds the configured timeout', async () => {
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
              'content-type': 'text/event-stream',
            },
          },
        ),
    )

    const response = await handleDispatchRequest(
      createRequest('/ssl/example.com/stream'),
      createEnv({ RELAY_RESPONSE_TIMEOUT_MS: '5' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toThrow('内部 relay 响应超时')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('skips ingress auth when DISPATCH_INGRESS_KEY is not configured', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }))

    const response = await handleDispatchRequest(
      createRequest('/ssl/api.openai.com/v1/responses'),
      createEnv(),
      fetchSpy,
    )

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects requests without an ingress token when ingress auth is enabled', async () => {
    const fetchSpy = vi.fn()

    const response = await handleDispatchRequest(
      createRequest('/ssl/api.openai.com/v1/responses'),
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
      createRequest('/ssl/api.openai.com/v1/responses', {
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
      createRequest('/ssl/api.openai.com/v1/responses', {
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
      createRequest('/ssl/api.openai.com/v1/responses', {
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

  it('caches a 401 response under hash strategy and serves from cache on second request', async () => {
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
      createRequest('/ssl/api.openai.com/v1/responses?model=gpt-4', {
        headers: { Authorization: 'Bearer test-key' },
      })

    try {
      // 第一次请求：转发到上游，收到 401
      const response1 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response1.status).toBe(401)
      expect(await response1.text()).toBe('unauthorized')
      expect(callCount).toBe(1)

      // 第二次请求：命中缓存，不转发
      const response2 = await handleDispatchRequest(makeRequest(), env, fetchSpy, state)
      expect(response2.status).toBe(401)
      expect(await response2.text()).toBe('unauthorized')
      expect(callCount).toBe(1) // fetchSpy 未被再次调用

      expect(infoSpy).toHaveBeenCalledWith(
        '[agent-dispatch] negative cache hit',
        expect.objectContaining({ status: 401 }),
      )
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
      })

      // 无 auth header → site-fallback 模式
      const makeRequest = () => createRequest('/ssl/api.example.com/v1/resource')

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
    })

    const makeRequest = () =>
      createRequest('/ssl/api.openai.com/v1/responses', {
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
    })

    const makeRequest = () =>
      createRequest('/ssl/api.openai.com/v1/chat', {
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
      createRequest('/ssl/api.openai.com/v1/responses', {
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
      })

      const makeRequest = () =>
        createRequest('/ssl/api.openai.com/v1/responses', {
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
})
