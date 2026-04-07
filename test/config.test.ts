import { describe, expect, it } from 'vitest'

import { getRuntimeConfig } from '../src/config.js'

describe('config', () => {
  it('accepts explicit and transparent ports independently', () => {
    expect(
      getRuntimeConfig({
        PORT: '8787',
        TRANSPARENT_PORT: '8788',
        DISPATCH_SECRET: 'relay-secret',
        AGENT_PROXY_URLS: 'https://proxy-a.example,https://proxy-b.example/base',
      }),
    ).toMatchObject({
      port: 8787,
      transparentPort: 8788,
      dispatchSecret: 'relay-secret',
      requestTimeoutMs: 5000,
      failoverCooldownMs: 3000,
      backendSelectionStrategy: 'consistent-hashing',
    })
  })

  it('allows explicit and transparent listeners to be disabled independently', () => {
    expect(
      getRuntimeConfig({
        TRANSPARENT_PORT: '8788',
        DISPATCH_SECRET: 'relay-secret',
        AGENT_PROXY_URLS: 'https://proxy-a.example',
      }),
    ).toMatchObject({
      port: null,
      transparentPort: 8788,
    })

    expect(
      getRuntimeConfig({
        PORT: '8787',
        DISPATCH_SECRET: 'relay-secret',
        AGENT_PROXY_URLS: 'https://proxy-a.example',
      }),
    ).toMatchObject({
      port: 8787,
      transparentPort: null,
    })
  })

  it('rejects when both listeners are disabled', () => {
    expect(() =>
      getRuntimeConfig({
        DISPATCH_SECRET: 'relay-secret',
        AGENT_PROXY_URLS: 'https://proxy-a.example',
      }),
    ).toThrow('PORT 和 TRANSPARENT_PORT 不能同时为空')
  })

  it('rejects unsupported backend selection strategies', () => {
    expect(() =>
      getRuntimeConfig({
        PORT: '8787',
        DISPATCH_SECRET: 'relay-secret',
        AGENT_PROXY_URLS: 'https://proxy-a.example',
        BACKEND_SELECTION_STRATEGY: 'weighted',
      }),
    ).toThrow('BACKEND_SELECTION_STRATEGY 只允许 round-robin 或 consistent-hashing')
  })
})
