export interface DispatchEnv {
  PORT?: string
  DISPATCH_SECRET?: string
  AGENT_PROXY_URLS?: string
  REQUEST_TIMEOUT_MS?: string
  SOCKS5_PROXY_HOST?: string
  SOCKS5_PROXY_PORT?: string
  SOCKS5_PROXY_USERNAME?: string
  SOCKS5_PROXY_PASSWORD?: string
}

export interface Socks5ProxyConfig {
  type: 5
  host: string
  port: number
  userId?: string
  password?: string
}

export interface RuntimeConfig {
  port: number
  dispatchSecret: string
  proxyUrls: URL[]
  requestTimeoutMs: number
  socks5Proxy: Socks5ProxyConfig | null
}

const DEFAULT_PORT = 8787
const DEFAULT_REQUEST_TIMEOUT_MS = 5000

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

function parseSocks5Proxy(env: DispatchEnv): Socks5ProxyConfig | null {
  const host = env.SOCKS5_PROXY_HOST?.trim()
  const portRaw = env.SOCKS5_PROXY_PORT?.trim()

  if (!host && !portRaw) {
    return null
  }

  const port = Number.parseInt(portRaw ?? '', 10)

  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error('SOCKS5 代理配置无效')
  }

  return {
    type: 5,
    host,
    port,
    userId: env.SOCKS5_PROXY_USERNAME?.trim() || undefined,
    password: env.SOCKS5_PROXY_PASSWORD?.trim() || undefined,
  }
}

export function loadEnvFromProcess(processEnv: NodeJS.ProcessEnv): DispatchEnv {
  return {
    PORT: processEnv.PORT,
    DISPATCH_SECRET: processEnv.DISPATCH_SECRET,
    AGENT_PROXY_URLS: processEnv.AGENT_PROXY_URLS,
    REQUEST_TIMEOUT_MS: processEnv.REQUEST_TIMEOUT_MS,
    SOCKS5_PROXY_HOST: processEnv.SOCKS5_PROXY_HOST,
    SOCKS5_PROXY_PORT: processEnv.SOCKS5_PROXY_PORT,
    SOCKS5_PROXY_USERNAME: processEnv.SOCKS5_PROXY_USERNAME,
    SOCKS5_PROXY_PASSWORD: processEnv.SOCKS5_PROXY_PASSWORD,
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
    socks5Proxy: parseSocks5Proxy(env),
  }
}
