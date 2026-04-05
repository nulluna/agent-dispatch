import { describe, expect, it } from 'vitest'

import { getRuntimeConfig } from '../src/config.js'

describe('getRuntimeConfig', () => {
  it('parses proxy urls and defaults timeout to 5000', () => {
    const config = getRuntimeConfig({
      DISPATCH_SECRET: 'relay-secret',
      AGENT_PROXY_URLS: 'https://proxy-a.example, https://proxy-b.example',
    })

    expect(config.dispatchSecret).toBe('relay-secret')
    expect(config.proxyUrls.map((item: URL) => item.toString())).toEqual([
      'https://proxy-a.example/',
      'https://proxy-b.example/',
    ])
    expect(config.requestTimeoutMs).toBe(5000)
    expect(config.socks5Proxy).toBeNull()
    expect(config.port).toBe(8787)
  })

  it('parses socks5 proxy when host and port are configured', () => {
    const config = getRuntimeConfig({
      DISPATCH_SECRET: 'relay-secret',
      AGENT_PROXY_URLS: 'https://proxy-a.example',
      SOCKS5_PROXY_HOST: '127.0.0.1',
      SOCKS5_PROXY_PORT: '1080',
      SOCKS5_PROXY_USERNAME: 'u',
      SOCKS5_PROXY_PASSWORD: 'p',
    })

    expect(config.socks5Proxy).toEqual({
      type: 5,
      host: '127.0.0.1',
      port: 1080,
      userId: 'u',
      password: 'p',
    })
  })

  it('fails fast for invalid socks5 config', () => {
    expect(() =>
      getRuntimeConfig({
        DISPATCH_SECRET: 'relay-secret',
        AGENT_PROXY_URLS: 'https://proxy-a.example',
        SOCKS5_PROXY_HOST: '127.0.0.1',
        SOCKS5_PROXY_PORT: '0',
      }),
    ).toThrow(/SOCKS5/)
  })
})
