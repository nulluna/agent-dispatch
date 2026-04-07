import type { ProxyRoute } from './routing.js'
import { buildDispatchPath } from './routing.js'

const PASSTHROUGH_PROTOCOLS = new Set(['mailto:', 'tel:', 'javascript:', 'data:'])

function buildDispatchUrl(dispatchUrl: URL, targetUrl: URL): string {
  const rewritten = new URL(dispatchUrl)
  rewritten.pathname = buildDispatchPath(
    targetUrl.protocol === 'https:' ? 'https' : 'http',
    targetUrl.host,
    targetUrl.pathname,
  )
  rewritten.search = targetUrl.search
  rewritten.hash = targetUrl.hash

  return rewritten.toString()
}

function resolveTargetUrl(value: string, upstreamUrl: URL): URL | null {
  try {
    const resolved = new URL(value, upstreamUrl)

    if (PASSTHROUGH_PROTOCOLS.has(resolved.protocol)) {
      return null
    }

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null
    }

    return resolved
  } catch {
    return null
  }
}

function isDispatchProxyPath(pathname: string): boolean {
  return /^\/(?:s|h)\//.test(pathname)
}

function unwrapQuotedValue(value: string): {
  quote: '"' | "'" | ''
  unwrapped: string
} {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return { quote: '"', unwrapped: value.slice(1, -1) }
  }

  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return { quote: "'", unwrapped: value.slice(1, -1) }
  }

  return { quote: '', unwrapped: value }
}

export function rewriteLocation(
  value: string,
  upstreamUrl: URL,
  dispatchUrl: URL,
): string {
  const resolved = resolveTargetUrl(value, upstreamUrl)

  if (!resolved) {
    return value
  }

  if (resolved.origin === dispatchUrl.origin && isDispatchProxyPath(resolved.pathname)) {
    return value
  }

  return buildDispatchUrl(dispatchUrl, resolved)
}

export function rewriteRefresh(
  value: string,
  upstreamUrl: URL,
  dispatchUrl: URL,
): string {
  const match = value.match(/^(\s*[^;]+\s*;\s*url\s*=\s*)(.+)$/i)

  if (!match) {
    return value
  }

  const prefix = match[1]
  const target = match[2].trim()
  const { quote, unwrapped } = unwrapQuotedValue(target)
  const rewritten = rewriteLocation(unwrapped, upstreamUrl, dispatchUrl)

  if (rewritten === unwrapped) {
    return value
  }

  return `${prefix}${quote}${rewritten}${quote}`
}

export function rewriteResponseHeaders(
  headers: Headers,
  upstreamUrl: URL,
  dispatchUrl: URL,
): Headers {
  const rewritten = new Headers(headers)
  const location = rewritten.get('location')
  const refresh = rewritten.get('refresh')

  if (location) {
    rewritten.set('location', rewriteLocation(location, upstreamUrl, dispatchUrl))
  }

  if (refresh) {
    rewritten.set('refresh', rewriteRefresh(refresh, upstreamUrl, dispatchUrl))
  }

  return rewritten
}

export function buildUpstreamUrlFromRoute(route: ProxyRoute): URL {
  const url = new URL(`${route.protocol}://${route.targetHost}`)
  url.pathname = route.targetPathname
  url.search = route.targetSearch

  return url
}
