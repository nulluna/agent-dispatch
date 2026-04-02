import { DispatchError } from './errors'

export interface DispatchEnv {
  AGENTPROXY_POOL?: string
  DISPATCH_SECRET?: string
  DISPATCH_STRATEGY?: string
  LOG_LEVEL?: string
  RELAY_CONNECT_TIMEOUT_MS?: string
  RELAY_RESPONSE_TIMEOUT_MS?: string
}

export type DispatchStrategy = 'poll' | 'hash'
export type LogLevel = 'info' | 'debug'

export interface RuntimeConfig {
  agentproxyPool: URL[]
  dispatchSecret: string
  dispatchStrategy: DispatchStrategy
  logLevel: LogLevel
  relayConnectTimeoutMs: number
  relayResponseTimeoutMs: number
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

function parseLogLevel(value?: string): LogLevel {
  const normalized = value?.trim().toLowerCase() ?? 'info'

  if (normalized === 'info' || normalized === 'debug') {
    return normalized
  }

  throw new DispatchError(500, 'INVALID_CONFIGURATION', 'LOG_LEVEL 配置无效')
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
    logLevel: parseLogLevel(env.LOG_LEVEL),
    relayConnectTimeoutMs: parsePositiveInteger(env.RELAY_CONNECT_TIMEOUT_MS, 10_000),
    relayResponseTimeoutMs: parsePositiveInteger(env.RELAY_RESPONSE_TIMEOUT_MS, 30_000),
  }
}
