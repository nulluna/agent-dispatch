import { DispatchError } from './errors'

export interface DispatchEnv {
  AGENTPROXY_POOL?: string
  DISPATCH_SECRET?: string
  DISPATCH_STRATEGY?: string
  DISPATCH_NEGATIVE_CACHE_ENABLED?: string
  LOG_LEVEL?: string
  RELAY_CONNECT_TIMEOUT_MS?: string
  RELAY_RESPONSE_TIMEOUT_MS?: string
  DISPATCH_INGRESS_KEY?: string
  DISPATCH_INGRESS_HEADER?: string
  DNS_RESOLVE?: string
  CURRENT_DOMAIN?: string
}

export type DispatchStrategy = 'poll' | 'hash'
export type LogLevel = 'info' | 'debug'

export interface RuntimeConfig {
  agentproxyPool: URL[]
  dispatchSecret: string
  dispatchStrategy: DispatchStrategy
  negativeCacheEnabled: boolean
  logLevel: LogLevel
  relayConnectTimeoutMs: number
  relayResponseTimeoutMs: number
  ingressKey: string
  ingressHeader: string
  dnsResolve: Map<string, string>
  currentDomain: string
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new DispatchError(500, 'INVALID_CONFIGURATION', '超时配置必须是正整数')
  }

  return parsed
}

function parseDispatchStrategy(value?: string): DispatchStrategy {
  const normalized = value?.trim().toLowerCase() ?? 'poll'

  if (normalized === 'poll' || normalized === 'hash') {
    return normalized
  }

  throw new DispatchError(500, 'INVALID_CONFIGURATION', 'DISPATCH_STRATEGY 配置无效')
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback
  }

  const normalized = value.trim().toLowerCase()

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  throw new DispatchError(500, 'INVALID_CONFIGURATION', '布尔配置必须是 true/false、1/0、yes/no 或 on/off')
}

function parseLogLevel(value?: string): LogLevel {
  const normalized = value?.trim().toLowerCase() ?? 'info'

  if (normalized === 'info' || normalized === 'debug') {
    return normalized
  }

  throw new DispatchError(500, 'INVALID_CONFIGURATION', 'LOG_LEVEL 配置无效')
}

function parseDnsResolve(value?: string): Map<string, string> {
  const result = new Map<string, string>()

  if (!value || value.trim() === '') {
    return result
  }

  for (const entry of value.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue

    const separatorIndex = trimmed.indexOf('=')

    if (separatorIndex <= 0) {
      throw new DispatchError(500, 'INVALID_CONFIGURATION', `DNS_RESOLVE 条目格式无效: ${trimmed}`)
    }

    const hostname = trimmed.slice(0, separatorIndex).trim().toLowerCase()
    const address = trimmed.slice(separatorIndex + 1).trim()

    if (!hostname || !address) {
      throw new DispatchError(500, 'INVALID_CONFIGURATION', `DNS_RESOLVE 条目不完整: ${trimmed}`)
    }

    result.set(hostname, address)
  }

  return result
}

function parseAgentproxyPool(value?: string): URL[] {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  if (entries.length === 0) {
    throw new DispatchError(500, 'INVALID_CONFIGURATION', 'AGENTPROXY_POOL 不能为空')
  }

  return entries.map((entry) => {
    let parsed: URL

    try {
      parsed = new URL(entry)
    } catch {
      throw new DispatchError(500, 'INVALID_CONFIGURATION', 'AGENTPROXY_POOL 包含无效 URL')
    }

    if (parsed.protocol !== 'https:') {
      throw new DispatchError(500, 'INVALID_CONFIGURATION', 'AGENTPROXY_POOL 只允许 https:// 节点')
    }

    return parsed
  })
}

export function getRuntimeConfig(env: DispatchEnv): RuntimeConfig {
  const dispatchSecret = env.DISPATCH_SECRET?.trim() ?? ''

  if (!dispatchSecret) {
    throw new DispatchError(500, 'INVALID_CONFIGURATION', 'DISPATCH_SECRET 不能为空')
  }

  return {
    agentproxyPool: parseAgentproxyPool(env.AGENTPROXY_POOL),
    dispatchSecret,
    dispatchStrategy: parseDispatchStrategy(env.DISPATCH_STRATEGY),
    negativeCacheEnabled: parseBooleanFlag(env.DISPATCH_NEGATIVE_CACHE_ENABLED, false),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    relayConnectTimeoutMs: parsePositiveInteger(env.RELAY_CONNECT_TIMEOUT_MS, 10_000),
    relayResponseTimeoutMs: parsePositiveInteger(env.RELAY_RESPONSE_TIMEOUT_MS, 30_000),
    ingressKey: env.DISPATCH_INGRESS_KEY?.trim() ?? '',
    ingressHeader: env.DISPATCH_INGRESS_HEADER?.trim().toLowerCase() || 'x-dispatch-token',
    dnsResolve: parseDnsResolve(env.DNS_RESOLVE),
    currentDomain: env.CURRENT_DOMAIN?.trim() ?? '',
  }
}
