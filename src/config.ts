export type BackendSelectionStrategy = 'round-robin' | 'consistent-hashing'

export interface DispatchEnv {
  PORT?: string
  DISPATCH_SECRET?: string
  AGENT_PROXY_URLS?: string
  REQUEST_TIMEOUT_MS?: string
  FAILOVER_COOLDOWN_MS?: string
  BACKEND_SELECTION_STRATEGY?: string
}

export interface RuntimeConfig {
  port: number
  dispatchSecret: string
  proxyUrls: URL[]
  requestTimeoutMs: number
  failoverCooldownMs: number
  backendSelectionStrategy: BackendSelectionStrategy
}

const DEFAULT_PORT = 8787
const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_FAILOVER_COOLDOWN_MS = 3000
const DEFAULT_BACKEND_SELECTION_STRATEGY: BackendSelectionStrategy = 'consistent-hashing'

function parsePositiveInteger(
  value: string | undefined,
  fieldName: string,
  defaultValue: number,
): number {
  const trimmed = value?.trim()

  if (!trimmed) {
    return defaultValue
  }

  const parsed = Number.parseInt(trimmed, 10)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} 必须是正整数`)
  }

  return parsed
}

function parseDispatchSecret(value?: string): string {
  const secret = value?.trim() ?? ''

  if (!secret) {
    throw new Error('DISPATCH_SECRET 必须配置')
  }

  return secret
}

function parseBackendSelectionStrategy(
  value?: string,
): BackendSelectionStrategy {
  const normalized = value?.trim().toLowerCase()

  if (!normalized) {
    return DEFAULT_BACKEND_SELECTION_STRATEGY
  }

  if (normalized === 'round-robin' || normalized === 'consistent-hashing') {
    return normalized
  }

  throw new Error('BACKEND_SELECTION_STRATEGY 只允许 round-robin 或 consistent-hashing')
}

function parseProxyUrls(value?: string): URL[] {
  const rawItems = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (rawItems.length === 0) {
    throw new Error('AGENT_PROXY_URLS 必须至少包含一个节点')
  }

  return rawItems.map((item) => {
    let parsed: URL

    try {
      parsed = new URL(item)
    } catch {
      throw new Error(`AGENT_PROXY_URLS 包含无效 URL: ${item}`)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`AGENT_PROXY_URLS 只允许 http/https URL: ${item}`)
    }

    return parsed
  })
}

export function loadEnvFromProcess(processEnv: NodeJS.ProcessEnv): DispatchEnv {
  return {
    PORT: processEnv.PORT,
    DISPATCH_SECRET: processEnv.DISPATCH_SECRET,
    AGENT_PROXY_URLS: processEnv.AGENT_PROXY_URLS,
    REQUEST_TIMEOUT_MS: processEnv.REQUEST_TIMEOUT_MS,
    FAILOVER_COOLDOWN_MS: processEnv.FAILOVER_COOLDOWN_MS,
    BACKEND_SELECTION_STRATEGY: processEnv.BACKEND_SELECTION_STRATEGY,
  }
}

export function getRuntimeConfig(env: DispatchEnv): RuntimeConfig {
  return {
    port: parsePositiveInteger(env.PORT, 'PORT', DEFAULT_PORT),
    dispatchSecret: parseDispatchSecret(env.DISPATCH_SECRET),
    proxyUrls: parseProxyUrls(env.AGENT_PROXY_URLS),
    requestTimeoutMs: parsePositiveInteger(
      env.REQUEST_TIMEOUT_MS,
      'REQUEST_TIMEOUT_MS',
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    failoverCooldownMs: parsePositiveInteger(
      env.FAILOVER_COOLDOWN_MS,
      'FAILOVER_COOLDOWN_MS',
      DEFAULT_FAILOVER_COOLDOWN_MS,
    ),
    backendSelectionStrategy: parseBackendSelectionStrategy(
      env.BACKEND_SELECTION_STRATEGY,
    ),
  }
}
