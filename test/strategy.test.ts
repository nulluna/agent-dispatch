import { describe, expect, it } from 'vitest'

import { createDispatchState, selectAgentproxyIndex } from '../src/strategy'

describe('selectAgentproxyIndex', () => {
  it('advances poll routing in pool order and wraps within the same local instance', () => {
    const state = createDispatchState()

    expect(selectAgentproxyIndex('poll', 3, 'example.com', '', state)).toBe(0)
    expect(selectAgentproxyIndex('poll', 3, 'example.com', '', state)).toBe(1)
    expect(selectAgentproxyIndex('poll', 3, 'example.com', '', state)).toBe(2)
    expect(selectAgentproxyIndex('poll', 3, 'example.com', '', state)).toBe(0)
  })

  it('keeps hash routing stable for the same site and authorization', () => {
    const state = createDispatchState()

    const first = selectAgentproxyIndex(
      'hash',
      3,
      'api.openai.com',
      'Bearer abc',
      state,
    )
    const second = selectAgentproxyIndex(
      'hash',
      3,
      'api.openai.com',
      'Bearer abc',
      state,
    )

    expect(first).toBe(second)
  })

  it('treats a missing Authorization header the same as an empty string under hash routing', () => {
    const state = createDispatchState()

    expect(selectAgentproxyIndex('hash', 3, 'api.openai.com', undefined, state)).toBe(
      selectAgentproxyIndex('hash', 3, 'api.openai.com', '', state),
    )
  })
})
