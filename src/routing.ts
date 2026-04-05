import { DispatchError } from './errors'

type UpstreamProtocol = 'http' | 'https'

export interface ResolvedIngress {
  protocol: UpstreamProtocol
  authority: string
  upstreamUrl: URL
}

function decodeAuthority(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new DispatchError(400, 'INVALID_AUTHORITY', '上游 authority 编码无效')
  }
}

function validateAuthority(authority: string, protocol: UpstreamProtocol): URL {
  if (!authority) {
    throw new DispatchError(400, 'MISSING_AUTHORITY', '缺少上游 authority')
  }

  if (
    authority.includes('://') ||
    authority.includes('/') ||
    authority.includes('\\') ||
    authority.includes('?') ||
    authority.includes('#') ||
    authority.includes('@') ||
    /\s/.test(authority)
  ) {
    throw new DispatchError(400, 'INVALID_AUTHORITY', '上游 authority 必须是 host 或 host:port')
  }

  let upstreamUrl: URL

  try {
    upstreamUrl = new URL(`${protocol}://${authority}/`)
  } catch {
    throw new DispatchError(400, 'INVALID_AUTHORITY', '上游 authority 无法解析')
  }

  if (!upstreamUrl.hostname || upstreamUrl.pathname !== '/') {
    throw new DispatchError(400, 'INVALID_AUTHORITY', '上游 authority 无效')
  }

  return upstreamUrl
}

export function resolveIngressRequest(requestUrl: URL): ResolvedIngress {
  const segments = requestUrl.pathname.split('/').filter(Boolean)
  const hasTrailingSlash = requestUrl.pathname.length > 1 && requestUrl.pathname.endsWith('/')

  if (segments.length === 0) {
    throw new DispatchError(400, 'MISSING_AUTHORITY', '缺少上游 authority')
  }

  const useHttps = segments[0] === 'ssl'
  const authoritySegment = useHttps ? segments[1] : segments[0]

  if (!authoritySegment) {
    throw new DispatchError(400, 'MISSING_AUTHORITY', '缺少上游 authority')
  }

  const protocol: UpstreamProtocol = useHttps ? 'https' : 'http'
  const authority = decodeAuthority(authoritySegment)
  const upstreamUrl = validateAuthority(authority, protocol)
  const pathStartIndex = useHttps ? 2 : 1
  const pathSegments = segments.slice(pathStartIndex)

  if (pathSegments.length === 0) {
    upstreamUrl.pathname = '/'
  } else {
    upstreamUrl.pathname = `/${pathSegments.join('/')}${hasTrailingSlash ? '/' : ''}`
  }

  upstreamUrl.search = requestUrl.search

  return {
    protocol,
    authority: upstreamUrl.host,
    upstreamUrl,
  }
}
