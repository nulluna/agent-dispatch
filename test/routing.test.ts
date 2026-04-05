import { describe, expect, it } from 'vitest'

import { DispatchError } from '../src/errors.js'
import { parseDispatchRoute } from '../src/routing.js'

describe('parseDispatchRoute', () => {
  it('parses /s host and path into an https target', () => {
    const route = parseDispatchRoute(new URL('http://dispatch.example/s/www.google.com/search?q=1'))

    expect(route).toEqual({
      kind: 'proxy',
      protocolCode: 's',
      protocol: 'https',
      targetHost: 'www.google.com',
      targetPathname: '/search',
      targetSearch: '?q=1',
    })
  })

  it('parses /h host and path into an http target', () => {
    const route = parseDispatchRoute(new URL('http://dispatch.example/h/example.com/status'))

    expect(route).toEqual({
      kind: 'proxy',
      protocolCode: 'h',
      protocol: 'http',
      targetHost: 'example.com',
      targetPathname: '/status',
      targetSearch: '',
    })
  })

  it('returns invalid route for a path without protocol code', () => {
    expect(parseDispatchRoute(new URL('http://dispatch.example/www.google.com?q=1'))).toEqual({
      kind: 'invalid',
      reason: 'missing_protocol_code',
    })
  })

  it('throws on missing host for valid shortcode', () => {
    expect(() => parseDispatchRoute(new URL('http://dispatch.example/s'))).toThrow(DispatchError)
  })

  it('throws on invalid host', () => {
    expect(() => parseDispatchRoute(new URL('http://dispatch.example/s/https:%2F%2Fbad'))).toThrow(
      /目标 host 非法/,
    )
  })
})
