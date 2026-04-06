import type { ProxyRoute } from './routing.js'

export type LogWriter = (entry: string) => void

export const INTERNAL_REQUEST_ID_HEADER = 'x-dispatch-request-id'

const SENSITIVE_KEY_PATTERN =
  /authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|session/i

const URL_SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'auth',
  'authorization',
  'cookie',
  'password',
  'passwd',
  'secret',
  'session',
  'token',
])

export function writeJsonLog(entry: Record<string, unknown>, writer?: LogWriter): void {
  const normalized = sanitizeLogEntry(entry)
  const serialized = JSON.stringify(normalized)

  if (writer) {
    writer(serialized)
    return
  }

  console.log(shouldUsePrettyLogs() ? formatPrettyLog(normalized) : serialized)
}

function formatPrettyLog(entry: Record<string, unknown>): string {
  const timestamp = new Date().toISOString()
  const level = normalizeLevel(entry.level)
  const event = stringifyValue(entry.event) || 'log'
  const details = Object.entries(entry)
    .filter(([key]) => key !== 'event' && key !== 'level')
    .map(([key, value]) => `${key}=${stringifyValue(value)}`)
    .join(' ')

  const parts = [
    colorize(timestamp, ANSI.dim),
    colorize(level.toUpperCase(), getLevelColor(level)),
    colorize(event, ANSI.bold),
  ]

  if (details) {
    parts.push(details)
  }

  return parts.join(' ')
}

function normalizeLevel(value: unknown): 'info' | 'warn' | 'error' {
  if (value === 'warn' || value === 'error') {
    return value
  }

  return 'info'
}

function getLevelColor(level: 'info' | 'warn' | 'error'): string {
  switch (level) {
    case 'warn':
      return ANSI.yellow
    case 'error':
      return ANSI.red
    default:
      return ANSI.green
  }
}

function colorize(value: string, color: string): string {
  return `${color}${value}${ANSI.reset}`
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return String(value)
  }

  return JSON.stringify(value)
}

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
} as const

export function getRequestIdFromRequest(request: Request): string {
  return request.headers.get(INTERNAL_REQUEST_ID_HEADER) ?? 'unknown'
}

export function createRequestLogContext(
  request: Request,
  route?: ProxyRoute,
): Record<string, unknown> {
  const requestUrl = new URL(request.url)
  const context: Record<string, unknown> = {
    requestId: getRequestIdFromRequest(request),
    request: {
      method: request.method,
      dispatch: {
        pathname: requestUrl.pathname,
        search: requestUrl.search,
      },
      headers: summarizeHeaders(request.headers),
    },
  }

  if (route) {
    context.target = {
      protocol: route.protocol,
      host: route.targetHost,
      pathname: route.targetPathname,
      search: route.targetSearch,
      upstreamUrl: `${route.protocol}://${route.targetHost}${route.targetPathname}${route.targetSearch}`,
    }
  }

  return context
}

function shouldUsePrettyLogs(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NODE_ENV !== 'production'
}

function summarizeHeaders(headers: Headers): Record<string, string> {
  const summarized: Record<string, string> = {}

  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase()

    if (
      normalizedKey === 'accept' ||
      normalizedKey === 'content-length' ||
      normalizedKey === 'content-type' ||
      normalizedKey === 'user-agent' ||
      normalizedKey === 'x-requested-with'
    ) {
      summarized[key] = value
      return
    }

    if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) {
      summarized[key] = '[REDACTED]'
    }
  })

  return summarized
}

function sanitizeLogEntry(entry: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(entry) as Record<string, unknown>
}

function sanitizeValue(value: unknown, keyName?: string): unknown {
  if (typeof keyName === 'string' && SENSITIVE_KEY_PATTERN.test(keyName)) {
    return '[REDACTED]'
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'string') {
    return redactString(value, keyName)
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, keyName))
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, key)]),
    )
  }

  return String(value)
}

function redactString(value: string, keyName?: string): string {
  if (keyName && SENSITIVE_KEY_PATTERN.test(keyName)) {
    return '[REDACTED]'
  }

  return redactUrlSecrets(value)
}

function redactUrlSecrets(value: string): string {
  if (!/^https?:\/\//i.test(value)) {
    return value
  }

  try {
    const parsed = new URL(value)
    let changed = false

    for (const key of parsed.searchParams.keys()) {
      if (URL_SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]')
        changed = true
      }
    }

    return changed ? parsed.toString() : value
  } catch {
    return value
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}
