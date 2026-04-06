import { describe, expect, it } from 'vitest'

import { DispatchError } from '../src/errors.js'
import { buildDispatchPath, parseDispatchRoute } from '../src/routing.js'

describe('routing', () => {
  it('parses https route and preserves path and query', () => {
    const route = parseDispatchRoute(
      new URL('http://dispatch.local/s/example.com%3A8443/v1/chat/completions?trace=1'),
    )

    expect(route).toEqual({
      kind: 'proxy',
      protocolCode: 's',
      protocol: 'https',
      targetHost: 'example.com:8443',
      targetPathname: '/v1/chat/completions',
      targetSearch: '?trace=1',
    })
  })

  it('builds dispatch path from upstream target', () => {
    expect(buildDispatchPath('https', 'example.com:8443', '/v1/chat')).toBe(
      '/s/example.com%3A8443/v1/chat',
    )
    expect(buildDispatchPath('http', 'plain.example.com', 'status')).toBe(
      '/h/plain.example.com/status',
    )
  })

  it('returns invalid for non proxy route', () => {
    expect(parseDispatchRoute(new URL('http://dispatch.local/health'))).toEqual({
      kind: 'invalid',
      reason: 'missing_protocol_code',
    })
  })

  it('rejects missing host', () => {
    expect(() => parseDispatchRoute(new URL('http://dispatch.local/s'))).toThrowError(
      DispatchError,
    )
  })

  it('rejects malformed host', () => {
    expect(() => parseDispatchRoute(new URL('http://dispatch.local/s/https:%2F%2Fbad'))).toThrow(
      '目标 host 非法',
    )
  })
})
