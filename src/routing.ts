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

function resolveProtocolFromCode(protocolCode: string): UpstreamProtocol {
  if (protocolCode === 's') {
    return 'https'
  }

  if (protocolCode === 'h') {
    return 'http'
  }

  throw new DispatchError(
    400,
    'INVALID_PROTOCOL_CODE',
    '入口路径必须以 /s/<authority>/... 或 /h/<authority>/... 开头',
  )
}

export function resolveIngressRequest(requestUrl: URL): ResolvedIngress {
  const segments = requestUrl.pathname.split('/').filter(Boolean)
  const hasTrailingSlash = requestUrl.pathname.length > 1 && requestUrl.pathname.endsWith('/')

  if (segments.length === 0) {
    throw new DispatchError(400, 'MISSING_AUTHORITY', '缺少上游 authority')
  }

  const protocol = resolveProtocolFromCode(segments[0] ?? '')
  const authoritySegment = segments[1]

  if (!authoritySegment) {
    throw new DispatchError(400, 'MISSING_AUTHORITY', '缺少上游 authority')
  }

  const authority = decodeAuthority(authoritySegment)
  const upstreamUrl = validateAuthority(authority, protocol)
  const pathSegments = segments.slice(2)

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
