import { describe, expect, it } from 'vitest'

import { createProxyDispatcher } from '../src/proxy-dispatcher.js'

describe('createProxyDispatcher', () => {
  it('returns null dispatcher when socks5 is not configured', () => {
    const dispatcher = createProxyDispatcher({
      port: 8787,
      dispatchSecret: 'relay-secret',
      proxyUrls: [new URL('https://proxy-a.example')],
      requestTimeoutMs: 5000,
      socks5Proxy: null,
    })

    expect(dispatcher).toBeNull()
  })

  it('creates a socks dispatcher when socks5 is configured', () => {
    const dispatcher = createProxyDispatcher({
      port: 8787,
      dispatchSecret: 'relay-secret',
      proxyUrls: [new URL('https://proxy-a.example')],
      requestTimeoutMs: 5000,
      socks5Proxy: {
        type: 5,
        host: '127.0.0.1',
        port: 1080,
        userId: 'u',
        password: 'p',
      },
    })

    expect(dispatcher).toBeTruthy()
  })
})
