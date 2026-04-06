export type LogWriter = (entry: string) => void

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
} as const

export function writeJsonLog(entry: Record<string, unknown>, writer?: LogWriter): void {
  const serialized = JSON.stringify(entry)

  if (writer) {
    writer(serialized)
    return
  }

  console.log(shouldUsePrettyLogs() ? formatPrettyLog(entry) : serialized)
}

function shouldUsePrettyLogs(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NODE_ENV !== 'production'
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
