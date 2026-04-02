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

  it('returns a timeout error when the relay connection exceeds the configured limit', async () => {
    const state = createDispatchState()
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined))

    const response = await handleDispatchRequest(
      createRequest('/ssl/example.com/v1/chat'),
      createEnv({ RELAY_CONNECT_TIMEOUT_MS: '5' }),
      fetchSpy,
      state,
    )

    expect(response.status).toBe(504)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'RELAY_CONNECT_TIMEOUT',
      },
    })
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
})
