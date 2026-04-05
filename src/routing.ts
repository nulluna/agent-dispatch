import { DispatchError } from './errors.js'

export type ProtocolCode = 's' | 'h'
export type UpstreamProtocol = 'http' | 'https'
export type InvalidRouteReason = 'missing_protocol_code'

export interface ProxyRoute {
  kind: 'proxy'
  protocolCode: ProtocolCode
  protocol: UpstreamProtocol
  targetHost: string
  targetPathname: string
  targetSearch: string
}

export interface InvalidRoute {
  kind: 'invalid'
  reason: InvalidRouteReason
}

export type DispatchRoute = ProxyRoute | InvalidRoute

function mapProtocol(protocolCode: ProtocolCode): UpstreamProtocol {
  return protocolCode === 's' ? 'https' : 'http'
}

function mapProtocolCode(protocol: UpstreamProtocol): ProtocolCode {
  return protocol === 'https' ? 's' : 'h'
}

function decodeHost(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new DispatchError(400, 'INVALID_HOST', '目标 host 编码无效')
  }
}

function validateHost(value: string): string {
  const normalized = value.trim()

  if (
    !normalized ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized.includes('@') ||
    /\s/.test(normalized) ||
    normalized.includes('://')
  ) {
    throw new DispatchError(400, 'INVALID_HOST', '目标 host 非法')
  }

  try {
    const parsed = new URL(`https://${normalized}`)
    if (!parsed.hostname || parsed.pathname !== '/') {
      throw new Error('invalid')
    }
  } catch {
    throw new DispatchError(400, 'INVALID_HOST', '目标 host 非法')
  }

  return normalized
}

function getRouteRemainder(pathname: string, protocolCode: string, targetHost: string): string {
  const prefix = `/${protocolCode}/${targetHost}`
  const remainder = pathname.slice(prefix.length)
  return remainder || '/'
}

export function getProtocolCode(protocol: UpstreamProtocol): ProtocolCode {
  return mapProtocolCode(protocol)
}

export function buildDispatchPath(
  protocol: UpstreamProtocol,
  targetHost: string,
  targetPathname: string,
): string {
  const pathname = targetPathname.startsWith('/') ? targetPathname : `/${targetPathname}`
  return `/${getProtocolCode(protocol)}/${encodeURIComponent(targetHost)}${pathname}`
}

export function parseDispatchRoute(requestUrl: URL): DispatchRoute {
  const segments = requestUrl.pathname.split('/')
  const protocolCodeRaw = segments[1]

  if (!protocolCodeRaw || (protocolCodeRaw !== 's' && protocolCodeRaw !== 'h')) {
    return {
      kind: 'invalid',
      reason: 'missing_protocol_code',
    }
  }

  const targetHostRaw = segments[2]

  if (!targetHostRaw) {
    throw new DispatchError(400, 'MISSING_HOST', '缺少目标 host')
  }

  const targetHost = validateHost(decodeHost(targetHostRaw))
  const targetPathname = getRouteRemainder(requestUrl.pathname, protocolCodeRaw, targetHostRaw)

  return {
    kind: 'proxy',
    protocolCode: protocolCodeRaw,
    protocol: mapProtocol(protocolCodeRaw),
    targetHost,
    targetPathname,
    targetSearch: requestUrl.search,
  }
}
