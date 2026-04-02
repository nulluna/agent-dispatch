import type { DispatchStrategy } from './config'
import { NegativeResponseCache } from './negative-cache'

const SITE_FALLBACK_TTL_MS = 60 * 60 * 1000

export interface DispatchState {
  nextPollIndex: number
  siteFallbackSelections: Map<string, SiteFallbackSelectionState>
  negativeCache: NegativeResponseCache
}

interface SiteFallbackSelectionState {
  index: number
  expiresAt: number
}

export interface PollDispatchSelection {
  strategy: 'poll'
  poolLength: number
  proxyIndex: number
}

export interface StickyHashDispatchSelection {
  strategy: 'hash'
  selectionMode: 'sticky-hash'
  poolLength: number
  proxyIndex: number
  selectedIndex: number
  stickySource: string
  accountHash: string
  hashValue: number
}

export interface SiteFallbackDispatchSelection {
  strategy: 'hash'
  selectionMode: 'site-fallback'
  poolLength: number
  proxyIndex: number
  selectedIndex: number
  stickySource: 'site-fallback'
  expiresAt: number
}

export type DispatchSelection =
  | PollDispatchSelection
  | StickyHashDispatchSelection
  | SiteFallbackDispatchSelection

export function createDispatchState(): DispatchState {
  return {
    nextPollIndex: 0,
    siteFallbackSelections: new Map(),
    negativeCache: new NegativeResponseCache(),
  }
}

function hashString(value: string): number {
  let hash = 2_166_136_261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }

  return hash >>> 0
}

function parseCookieHeader(cookieHeader: string | null): Array<{ name: string; value: string }> {
  if (!cookieHeader) {
    return []
  }

  return cookieHeader
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => {
      const separatorIndex = segment.indexOf('=')

      if (separatorIndex <= 0) {
        return []
      }

      const name = segment.slice(0, separatorIndex).trim()
      const value = segment.slice(separatorIndex + 1).trim()

      if (!name || !value) {
        return []
      }

      return [{ name, value }]
    })
}

function resolveStickyCookie(headers: Headers): { source: string; value: string } | undefined {
  const cookies = parseCookieHeader(headers.get('cookie'))
  let fuzzyMatch: { source: string; value: string } | undefined

  for (const cookie of cookies) {
    const normalizedName = cookie.name.toLowerCase()

    if (normalizedName === 'session') {
      return {
        source: 'cookie-session',
        value: cookie.value,
      }
    }

    if (!fuzzyMatch && normalizedName.includes('session')) {
      fuzzyMatch = {
        source: 'cookie-fuzzy-session',
        value: cookie.value,
      }
    }
  }

  return fuzzyMatch
}

const preferredAuthHeaderNames = [
  'authorization',
  'x-authorization',
  'proxy-authorization',
  'x-auth-token',
  'auth-token',
  'x-api-key',
  'api-key',
] as const

function resolveStickyAuth(headers: Headers): { source: string; value: string } | undefined {
  for (const headerName of preferredAuthHeaderNames) {
    const value = headers.get(headerName)?.trim()

    if (value) {
      return {
        source: `auth-${headerName}`,
        value,
      }
    }
  }

  for (const [headerName, rawValue] of headers.entries()) {
    const normalizedName = headerName.toLowerCase()

    if (
      preferredAuthHeaderNames.includes(
        normalizedName as (typeof preferredAuthHeaderNames)[number],
      )
    ) {
      continue
    }

    const value = rawValue.trim()

    if (!value || !normalizedName.includes('auth')) {
      continue
    }

    return {
      source: `auth-${normalizedName}`,
      value,
    }
  }

  return undefined
}

function resolveStickyIdentifier(headers: Headers): { source: string; hashValue: string } | undefined {
  const cookieMatch = resolveStickyCookie(headers)

  if (cookieMatch) {
    return {
      source: cookieMatch.source,
      hashValue: cookieMatch.value,
    }
  }

  const authMatch = resolveStickyAuth(headers)

  if (authMatch) {
    return {
      source: authMatch.source,
      hashValue: authMatch.value,
    }
  }

  return undefined
}

function selectSiteFallback(
  poolLength: number,
  targetSite: string,
  state: DispatchState,
): SiteFallbackDispatchSelection {
  const now = Date.now()
  const cachedSelection = state.siteFallbackSelections.get(targetSite)

  if (!cachedSelection) {
    const createdSelection = {
      index: 0,
      expiresAt: now + SITE_FALLBACK_TTL_MS,
    }

    state.siteFallbackSelections.set(targetSite, createdSelection)

    return {
      strategy: 'hash',
      selectionMode: 'site-fallback',
      poolLength,
      proxyIndex: createdSelection.index,
      selectedIndex: createdSelection.index,
      stickySource: 'site-fallback',
      expiresAt: createdSelection.expiresAt,
    }
  }

  const normalizedIndex = cachedSelection.index % poolLength

  if (now < cachedSelection.expiresAt) {
    if (normalizedIndex !== cachedSelection.index) {
      state.siteFallbackSelections.set(targetSite, {
        index: normalizedIndex,
        expiresAt: cachedSelection.expiresAt,
      })
    }

    return {
      strategy: 'hash',
      selectionMode: 'site-fallback',
      poolLength,
      proxyIndex: normalizedIndex,
      selectedIndex: normalizedIndex,
      stickySource: 'site-fallback',
      expiresAt: cachedSelection.expiresAt,
    }
  }

  const nextIndex = (normalizedIndex + 1) % poolLength
  const refreshedSelection = {
    index: nextIndex,
    expiresAt: now + SITE_FALLBACK_TTL_MS,
  }

  state.siteFallbackSelections.set(targetSite, refreshedSelection)

  return {
    strategy: 'hash',
    selectionMode: 'site-fallback',
    poolLength,
    proxyIndex: refreshedSelection.index,
    selectedIndex: refreshedSelection.index,
    stickySource: 'site-fallback',
    expiresAt: refreshedSelection.expiresAt,
  }
}

export function selectAgentproxy(
  strategy: DispatchStrategy,
  poolLength: number,
  targetSite: string,
  headers: Headers,
  state: DispatchState,
): DispatchSelection {
  if (poolLength <= 0) {
    throw new RangeError('poolLength 必须大于 0')
  }

  if (strategy === 'poll') {
    const index = state.nextPollIndex % poolLength

    state.nextPollIndex = (index + 1) % poolLength

    return {
      strategy,
      poolLength,
      proxyIndex: index,
    }
  }

  const stickyIdentifier = resolveStickyIdentifier(headers)

  if (!stickyIdentifier) {
    return selectSiteFallback(poolLength, targetSite, state)
  }

  const hashInput = `${targetSite}\n${stickyIdentifier.hashValue}`
  const hashValue = hashString(hashInput)
  const selectedIndex = hashValue % poolLength

  return {
    strategy,
    selectionMode: 'sticky-hash',
    poolLength,
    proxyIndex: selectedIndex,
    selectedIndex,
    stickySource: stickyIdentifier.source,
    accountHash: hashString(stickyIdentifier.hashValue).toString(16).padStart(8, '0'),
    hashValue,
  }
}

export function selectAgentproxyIndex(
  strategy: DispatchStrategy,
  poolLength: number,
  targetSite: string,
  headers: Headers,
  state: DispatchState,
): number {
  return selectAgentproxy(strategy, poolLength, targetSite, headers, state).proxyIndex
}
