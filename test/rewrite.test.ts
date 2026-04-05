import { describe, expect, it } from 'vitest'

import { rewriteLocation, rewriteRefresh } from '../src/rewrite.js'

describe('rewriteLocation', () => {
  it('rewrites an absolute Location header to the dispatch entry', () => {
    const rewritten = rewriteLocation(
      'https://www.google.com/search?q=test',
      new URL('https://www.google.com/original'),
      new URL('http://dispatch.example/s/www.google.com/original'),
    )

    expect(rewritten).toBe('http://dispatch.example/s/www.google.com/search?q=test')
  })

  it('rewrites a relative Location header to the dispatch entry', () => {
    const rewritten = rewriteLocation(
      '/login?next=%2Fapp',
      new URL('https://example.com/account'),
      new URL('http://dispatch.example/s/example.com/account'),
    )

    expect(rewritten).toBe('http://dispatch.example/s/example.com/login?next=%2Fapp')
  })

  it('passes through a mailto Location unchanged', () => {
    const rewritten = rewriteLocation(
      'mailto:test@example.com',
      new URL('https://example.com/account'),
      new URL('http://dispatch.example/s/example.com/account'),
    )

    expect(rewritten).toBe('mailto:test@example.com')
  })
})

describe('rewriteRefresh', () => {
  it('rewrites an absolute Refresh target', () => {
    const rewritten = rewriteRefresh(
      '0; url=https://example.com/login',
      new URL('https://example.com/account'),
      new URL('http://dispatch.example/s/example.com/account'),
    )

    expect(rewritten).toBe('0; url=http://dispatch.example/s/example.com/login')
  })

  it('rewrites a relative Refresh target', () => {
    const rewritten = rewriteRefresh(
      '5; url=/login?next=%2Fapp',
      new URL('https://example.com/account'),
      new URL('http://dispatch.example/s/example.com/account'),
    )

    expect(rewritten).toBe('5; url=http://dispatch.example/s/example.com/login?next=%2Fapp')
  })
})
