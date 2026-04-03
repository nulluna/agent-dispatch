import { describe, expect, it, vi } from 'vitest'

import { createDispatchState, selectAgentproxyIndex } from '../src/strategy'

function createHeaders(init: Record<string, string> = {}): Headers {
  return new Headers(init)
}

describe('selectAgentproxyIndex', () => {
  it('advances poll routing in pool order and wraps within the same local instance', () => {
    const state = createDispatchState()

    expect(selectAgentproxyIndex('poll', 3, 'example.com', createHeaders(), state)).toBe(0)
    expect(selectAgentproxyIndex('poll', 3, 'example.com', createHeaders(), state)).toBe(1)
    expect(selectAgentproxyIndex('poll', 3, 'example.com', createHeaders(), state)).toBe(2)
    expect(selectAgentproxyIndex('poll', 3, 'example.com', createHeaders(), state)).toBe(0)
  })

  it('keeps hash routing stable for the same site and new-api-user header', () => {
    const state = createDispatchState()

    const first = selectAgentproxyIndex(
      'hash',
      3,
      'api.openai.com',
      createHeaders({
        'New-Api-User': 'user-123',
        Cookie: 'session=session-123; theme=dark',
        Authorization: 'Bearer ignored',
      }),
      state,
    )
    const second = selectAgentproxyIndex(
      'hash',
      3,
      'api.openai.com',
      createHeaders({
        'New-Api-User': 'user-123',
        Cookie: 'session=session-123; locale=zh-CN',
        Authorization: 'Bearer changed',
      }),
      state,
    )

    expect(first).toBe(second)
  })

  it('uses a cookie field containing session when the exact session cookie is absent', () => {
    const state = createDispatchState()

    expect(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          Cookie: 'theme=dark; user_session=session-456',
        }),
        state,
      ),
    ).toBe(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          Cookie: 'user_session=session-456; theme=light',
        }),
        state,
      ),
    )
  })

  it('prefers authorization over session cookies', () => {
    const state = createDispatchState()

    expect(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          Authorization: 'Bearer abc',
          Cookie: 'session=session-123',
        }),
        state,
      ),
    ).toBe(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          Authorization: 'Bearer abc',
          Cookie: 'session=session-456',
        }),
        state,
      ),
    )
  })

  it('uses access-token before x-authorization and cookies', () => {
    const state = createDispatchState()

    expect(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          'Access-Token': 'access-123',
          'X-Authorization': 'x-auth-ignored',
          Cookie: 'session=session-ignored',
        }),
        state,
      ),
    ).toBe(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          'Access-Token': 'access-123',
          'X-Authorization': 'x-auth-changed',
          Cookie: 'session=session-changed',
        }),
        state,
      ),
    )
  })

  it('uses x-authorization when higher-priority sticky headers are absent', () => {
    const state = createDispatchState()

    expect(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          'X-Authorization': 'x-auth-123',
          Cookie: 'session=session-ignored',
        }),
        state,
      ),
    ).toBe(
      selectAgentproxyIndex(
        'hash',
        3,
        'api.openai.com',
        createHeaders({
          'X-Authorization': 'x-auth-123',
          Cookie: 'session=session-changed',
        }),
        state,
      ),
    )
  })

  it('keeps the same site fallback index for one hour and rotates after expiration', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'))

    try {
      const state = createDispatchState()

      expect(selectAgentproxyIndex('hash', 3, 'example.com', createHeaders(), state)).toBe(0)
      expect(selectAgentproxyIndex('hash', 3, 'example.com', createHeaders(), state)).toBe(0)

      vi.setSystemTime(new Date('2026-04-02T00:59:59.000Z'))
      expect(selectAgentproxyIndex('hash', 3, 'example.com', createHeaders(), state)).toBe(0)

      vi.setSystemTime(new Date('2026-04-02T01:00:01.000Z'))
      expect(selectAgentproxyIndex('hash', 3, 'example.com', createHeaders(), state)).toBe(1)

      vi.setSystemTime(new Date('2026-04-02T02:00:02.000Z'))
      expect(selectAgentproxyIndex('hash', 3, 'example.com', createHeaders(), state)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks site fallback rotation independently for each target site', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-02T00:00:00.000Z'))

    try {
      const state = createDispatchState()

      expect(selectAgentproxyIndex('hash', 3, 'example.com', createHeaders(), state)).toBe(0)
      expect(selectAgentproxyIndex('hash', 3, 'another.example.com', createHeaders(), state)).toBe(
        0,
      )

      vi.setSystemTime(new Date('2026-04-02T01:00:01.000Z'))

      expect(selectAgentproxyIndex('hash', 3, 'example.com', createHeaders(), state)).toBe(1)
      expect(selectAgentproxyIndex('hash', 3, 'another.example.com', createHeaders(), state)).toBe(
        1,
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
