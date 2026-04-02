const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

function getSetCookieValues(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie

  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers)
  }

  return []
}

export function createRelayHeaders(headers: Headers): Headers {
  const relayHeaders = new Headers()

  for (const [name, value] of headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue
    }

    relayHeaders.append(name, value)
  }

  return relayHeaders
}

export function cloneResponseHeaders(response: Response): Headers {
  const headers = new Headers()

  for (const [name, value] of response.headers.entries()) {
    if (name.toLowerCase() === 'set-cookie') {
      continue
    }

    headers.append(name, value)
  }

  const setCookieValues = getSetCookieValues(response.headers)

  if (setCookieValues.length > 0) {
    for (const value of setCookieValues) {
      headers.append('set-cookie', value)
    }

    return headers
  }

  const singleSetCookie = response.headers.get('set-cookie')

  if (singleSetCookie) {
    headers.append('set-cookie', singleSetCookie)
  }

  return headers
}
