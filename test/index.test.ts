import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/index.js'
import { createServer } from '../src/server.js'

function createEnv() {
  return {
    DISPATCH_SECRET: 'relay-secret',
    AGENT_PROXY_URLS: 'https://proxy-a.example,https://proxy-b.example',
  }
}

describe('node bootstrap', () => {
  it('exports createApp and createServer', () => {
    expect(typeof createApp).toBe('function')
    expect(typeof createServer).toBe('function')
  })

  it('logs invalid route and returns 404', async () => {
    const logs: string[] = []
    const fetchSpy = vi.fn()
    const app = createApp({
      env: createEnv(),
      fetchImplementation: fetchSpy,
      logWriter: (entry: string) => logs.push(entry),
    })

    const response = await app.handle(new Request('http://dispatch.example/www.google.com?q=1'))

    expect(response.status).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.parse(logs[0])).toMatchObject({
      event: 'dispatch.invalid_route',
      reason: 'missing_protocol_code',
      pathname: '/www.google.com',
      search: '?q=1',
      method: 'GET',
    })
  })

  it('returns 404 for invalid paths without calling upstream fetch', async () => {
    const fetchSpy = vi.fn()
    const logs: string[] = []
    const app = createApp({
      env: createEnv(),
      fetchImplementation: fetchSpy,
      logWriter: (entry: string) => logs.push(entry),
    })

    const response = await app.handle(new Request('http://dispatch.example/without-code'))

    expect(response.status).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logs).toHaveLength(1)
  })
})
