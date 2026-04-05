import { describe, expect, it, vi } from 'vitest'

import { createDispatchState, selectAgentproxyIndex } from '../src/strategy'

function createHeaders(init: Record<string, string> = {}): Headers {
  return new Headers(init)
}

describe('selectAgentproxyIndex', () => {
  it('keeps poll routing sticky per site for 8 seconds and refreshes on access', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'))

    try {
      const state = createDispatchState()

      expect(selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)).toBe(0)
      expect(selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)).toBe(0)

      vi.advanceTimersByTime(7_900)
      expect(selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)).toBe(0)

      vi.advanceTimersByTime(7_900)
      expect(selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)).toBe(0)

      vi.advanceTimersByTime(8_100)
      expect(selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses the same poll proxy for a site while its affinity is still valid', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'))

    try {
      const state = createDispatchState()
      const first = selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)

      vi.advanceTimersByTime(1_000)

      expect(selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)).toBe(first)
    } finally {
      vi.useRealTimers()
    }
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

  it('keeps hash routing stable for the same challenge cookie when auth and session are absent', () => {
    const state = createDispatchState()

    const challengeA = selectAgentproxyIndex(
      'hash',
      64,
      'anyrouter.top',
      createHeaders({
        Cookie: 'acw_tc=challenge-123; theme=dark',
      }),
      state,
    )
    const challengeB = selectAgentproxyIndex(
      'hash',
      64,
      'anyrouter.top',
      createHeaders({
        Cookie: 'acw_tc=challenge-123; locale=zh-CN',
      }),
      state,
    )
    const challengeIndexes = new Set(
      ['challenge-123', 'challenge-456', 'challenge-789', 'challenge-abc', 'challenge-def', 'challenge-ghi'].map(
        (challenge) =>
          selectAgentproxyIndex(
            'hash',
            64,
            'anyrouter.top',
            createHeaders({
              Cookie: `acw_tc=${challenge}; theme=dark`,
            }),
            state,
          ),
      ),
    )

    expect(challengeA).toBe(challengeB)
    expect(challengeIndexes.size).toBeGreaterThan(1)
  })

  it('keeps hash routing stable for the same fallback challenge cookie when auth and session are absent', () => {
    const state = createDispatchState()

    const challengeA = selectAgentproxyIndex(
      'hash',
      64,
      'anyrouter.top',
      createHeaders({
        Cookie: 'cdn_sec_tc=challenge-456; theme=dark',
      }),
      state,
    )
    const challengeB = selectAgentproxyIndex(
      'hash',
      64,
      'anyrouter.top',
      createHeaders({
        Cookie: 'cdn_sec_tc=challenge-456; locale=zh-CN',
      }),
      state,
    )
    const challengeIndexes = new Set(
      ['challenge-123', 'challenge-456', 'challenge-789', 'challenge-abc', 'challenge-def', 'challenge-ghi'].map(
        (challenge) =>
          selectAgentproxyIndex(
            'hash',
            64,
            'anyrouter.top',
            createHeaders({
              Cookie: `cdn_sec_tc=${challenge}; theme=dark`,
            }),
            state,
          ),
      ),
    )

    expect(challengeA).toBe(challengeB)
    expect(challengeIndexes.size).toBeGreaterThan(1)
  })

  it('prefers challenge affinity over active poll site cache for poll routing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'))

    try {
      const state = createDispatchState()
      const siteCachedIndex = selectAgentproxyIndex('poll', 3, 'any.top', createHeaders(), state)
      const challengeIndex = selectAgentproxyIndex(
        'hash',
        3,
        'any.top',
        createHeaders({
          Cookie: 'acw_tc=challenge-123; theme=dark',
        }),
        state,
      )

      expect(challengeIndex).not.toBe(siteCachedIndex)
      expect(
        selectAgentproxyIndex(
          'poll',
          3,
          'any.top',
          createHeaders({
            Cookie: 'acw_tc=challenge-123; locale=zh-CN',
          }),
          state,
        ),
      ).toBe(challengeIndex)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers session cookies over challenge cookies for hash routing', () => {
    const state = createDispatchState()

    expect(
      selectAgentproxyIndex(
        'hash',
        64,
        'anyrouter.top',
        createHeaders({
          Cookie: 'session=session-123; acw_tc=challenge-123; cdn_sec_tc=challenge-other',
        }),
        state,
      ),
    ).toBe(
      selectAgentproxyIndex(
        'hash',
        64,
        'anyrouter.top',
        createHeaders({
          Cookie: 'session=session-123; acw_tc=challenge-changed; cdn_sec_tc=challenge-next',
        }),
        state,
      ),
    )

    expect(
      new Set(
        ['session-123', 'session-456', 'session-789', 'session-abc', 'session-def', 'session-ghi'].map((session) =>
          selectAgentproxyIndex(
            'hash',
            64,
            'anyrouter.top',
            createHeaders({
              Cookie: `session=${session}; acw_tc=challenge-fixed; cdn_sec_tc=challenge-fixed-next`,
            }),
            state,
          ),
        ),
      ).size,
    ).toBeGreaterThan(1)
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
