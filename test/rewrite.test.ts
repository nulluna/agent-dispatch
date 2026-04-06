import { describe, expect, it } from 'vitest'

import { rewriteLocation, rewriteRefresh, rewriteResponseHeaders } from '../src/rewrite.js'

describe('rewrite', () => {
  const upstreamUrl = new URL('https://example.com/login/start?from=app')
  const dispatchUrl = new URL('https://dispatch.local/s/example.com/login/start?from=app')

  it('rewrites absolute location to dispatch route', () => {
    expect(
      rewriteLocation('https://example.com/account/profile?tab=billing', upstreamUrl, dispatchUrl),
    ).toBe('https://dispatch.local/s/example.com/account/profile?tab=billing')
  })

  it('rewrites relative location against upstream url', () => {
    expect(rewriteLocation('../done?ok=1', upstreamUrl, dispatchUrl)).toBe(
      'https://dispatch.local/s/example.com/done?ok=1',
    )
  })

  it('keeps passthrough protocols unchanged', () => {
    expect(rewriteLocation('mailto:test@example.com', upstreamUrl, dispatchUrl)).toBe(
      'mailto:test@example.com',
    )
  })

  it('rewrites refresh header and preserves quotes', () => {
    expect(rewriteRefresh('0; url="/done?ok=1"', upstreamUrl, dispatchUrl)).toBe(
      '0; url="https://dispatch.local/s/example.com/done?ok=1"',
    )
  })

  it('does not rewrite an already proxied dispatch path', () => {
    expect(
      rewriteLocation('https://dispatch.local/s/example.com/account/profile', upstreamUrl, dispatchUrl),
    ).toBe('https://dispatch.local/s/example.com/account/profile')
  })

  it('rewrites location and refresh headers together', () => {
    const headers = new Headers({
      location: '/next',
      refresh: '5; url=/later',
    })

    const rewritten = rewriteResponseHeaders(headers, upstreamUrl, dispatchUrl)

    expect(rewritten.get('location')).toBe('https://dispatch.local/s/example.com/next')
    expect(rewritten.get('refresh')).toBe('5; url=https://dispatch.local/s/example.com/later')
  })
})
