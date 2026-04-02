// 负向响应缓存 — 减少 proxy 节点的重复无效请求
// 对可缓存状态码（401/403/404/405/410/429）实施内存缓存 + 指数退避探测

const DEFAULT_CACHEABLE_STATUSES = new Set([401, 403, 404, 405, 410, 429])

const STICKY_INITIAL_TTL_MS = 60 * 60 * 1000         // 1 小时
const STICKY_MAX_TTL_MS = 24 * 60 * 60 * 1000        // 24 小时
const FALLBACK_TTL_MS = 30 * 1000                     // 30 秒
const PROBE_GRACE_PERIOD_MS = 30 * 1000               // 探测宽限期 30 秒
const WARN_MEMORY_BYTES = 256 * 1024 * 1024           // 256 MB
const MAX_MEMORY_BYTES = 512 * 1024 * 1024            // 512 MB
const ENTRY_OVERHEAD_BYTES = 256                      // 每条目固定开销估值

export interface NegativeCacheEntry {
  status: number
  headers: [string, string][]
  body: ArrayBuffer
  currentTtlMs: number
  expiresAt: number
  probing: boolean
  accountBound: boolean
  retryAfterOverride: boolean
  estimatedBytes: number
}

export class NegativeResponseCache {
  readonly entries = new Map<string, NegativeCacheEntry>()
  totalBytes = 0

  private readonly cacheableStatuses: Set<number>

  constructor(cacheableStatuses?: Set<number>) {
    this.cacheableStatuses = cacheableStatuses ?? DEFAULT_CACHEABLE_STATUSES
  }

  buildCacheKey(
    accountId: string,
    method: string,
    path: string,
    search: string,
  ): string {
    return `${accountId}:${method}:${path}${search}`
  }

  /**
   * 查找缓存条目。
   * - 命中且未过期 → 返回条目
   * - 已过期且未在探测 → 标记 probing，延长宽限期，返回 null（放行探测）
   * - 探测中且宽限期内 → 返回条目（其他请求继续走缓存）
   * - 不存在 → 返回 null
   */
  lookup(key: string): NegativeCacheEntry | null {
    const entry = this.entries.get(key)

    if (!entry) {
      return null
    }

    const now = Date.now()

    if (now < entry.expiresAt) {
      return entry
    }

    // 已过期
    if (entry.probing) {
      // 宽限期也过了，删除条目
      this.removeEntry(key, entry)
      return null
    }

    // 标记探测，设置宽限期
    entry.probing = true
    entry.expiresAt = now + PROBE_GRACE_PERIOD_MS

    return null
  }

  /**
   * 记录上游响应。
   * - 非可缓存状态码 → 删除已有条目
   * - 429 + Retry-After → TTL 取 Retry-After 值
   * - 已有条目 + 状态码相同 + accountBound → TTL ×2（上限 24h）
   * - 已有条目 + 状态码不同 → 重置 TTL
   * - 无条目 → 创建新条目
   */
  recordResponse(
    key: string,
    status: number,
    headers: Headers,
    body: ArrayBuffer,
    accountBound: boolean,
  ): void {
    const existing = this.entries.get(key)

    if (!this.cacheableStatuses.has(status)) {
      if (existing) {
        this.removeEntry(key, existing)
      }

      return
    }

    const serializedHeaders = serializeHeaders(headers)
    const estimatedBytes = estimateEntrySize(serializedHeaders, body)
    const now = Date.now()

    // 429 Retry-After 特殊处理
    const retryAfterMs = status === 429
      ? parseRetryAfter(headers.get('retry-after'), now)
      : null

    let ttlMs: number
    let retryAfterOverride = false

    if (retryAfterMs !== null && retryAfterMs > 0) {
      // 429 + 有效 Retry-After
      ttlMs = retryAfterMs
      retryAfterOverride = true
    } else if (!accountBound) {
      // site-fallback 固定 30s
      ttlMs = FALLBACK_TTL_MS
    } else if (existing && existing.status === status && !existing.retryAfterOverride) {
      // accountBound + 状态码相同 → 指数退避
      ttlMs = Math.min(existing.currentTtlMs * 2, STICKY_MAX_TTL_MS)
    } else if (existing && existing.status !== status) {
      // accountBound + 状态码不同 → 重置
      ttlMs = STICKY_INITIAL_TTL_MS
    } else {
      // 新条目或 retryAfterOverride 到期的 fallback
      ttlMs = STICKY_INITIAL_TTL_MS
    }

    // 移除旧条目内存
    if (existing) {
      this.removeEntry(key, existing)
    }

    // 内存检查 & 淘汰
    this.ensureMemoryBudget(estimatedBytes)

    const entry: NegativeCacheEntry = {
      status,
      headers: serializedHeaders,
      body,
      currentTtlMs: ttlMs,
      expiresAt: now + ttlMs,
      probing: false,
      accountBound,
      retryAfterOverride,
      estimatedBytes,
    }

    this.entries.set(key, entry)
    this.totalBytes += estimatedBytes
  }

  createCachedResponse(entry: NegativeCacheEntry): Response {
    const headers = new Headers()

    for (const [name, value] of entry.headers) {
      headers.append(name, value)
    }

    return new Response(entry.body.slice(0), {
      status: entry.status,
      headers,
    })
  }

  isCacheableStatus(status: number): boolean {
    return this.cacheableStatuses.has(status)
  }

  private removeEntry(key: string, entry: NegativeCacheEntry): void {
    this.entries.delete(key)
    this.totalBytes -= entry.estimatedBytes
  }

  private ensureMemoryBudget(incomingBytes: number): void {
    const projectedTotal = this.totalBytes + incomingBytes

    if (projectedTotal >= WARN_MEMORY_BYTES && projectedTotal < MAX_MEMORY_BYTES) {
      console.warn(
        '[negative-cache] 内存使用接近上限',
        { totalBytes: projectedTotal, warnThreshold: WARN_MEMORY_BYTES },
      )
    }

    if (projectedTotal >= MAX_MEMORY_BYTES) {
      console.warn(
        '[negative-cache] 内存超限，执行淘汰',
        { totalBytes: projectedTotal, maxThreshold: MAX_MEMORY_BYTES },
      )
      this.evict(incomingBytes)
    }
  }

  private evict(incomingBytes: number): void {
    // 按 expiresAt 升序排序，优先淘汰最早过期的条目
    const sorted = [...this.entries.entries()].sort(
      ([, a], [, b]) => a.expiresAt - b.expiresAt,
    )

    for (const [key, entry] of sorted) {
      if (this.totalBytes + incomingBytes < WARN_MEMORY_BYTES) {
        break
      }

      this.removeEntry(key, entry)
    }
  }
}

function serializeHeaders(headers: Headers): [string, string][] {
  const result: [string, string][] = []

  for (const [name, value] of headers.entries()) {
    result.push([name, value])
  }

  return result
}

function estimateEntrySize(
  headers: [string, string][],
  body: ArrayBuffer,
): number {
  let headersSize = 0

  for (const [name, value] of headers) {
    headersSize += (name.length + value.length) * 2
  }

  return body.byteLength + headersSize + ENTRY_OVERHEAD_BYTES
}

/**
 * 解析 Retry-After 头。
 * 支持秒数（"120"）和 HTTP-date（"Wed, 21 Oct 2015 07:28:00 GMT"）。
 * 返回毫秒数，无效时返回 null。
 */
function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) {
    return null
  }

  const trimmed = value.trim()

  // 尝试秒数
  const seconds = Number.parseInt(trimmed, 10)

  if (Number.isFinite(seconds) && seconds > 0 && String(seconds) === trimmed) {
    return seconds * 1000
  }

  // 尝试 HTTP-date
  const dateMs = Date.parse(trimmed)

  if (Number.isFinite(dateMs)) {
    const deltaMs = dateMs - now

    return deltaMs > 0 ? deltaMs : null
  }

  return null
}

// 导出内部函数用于测试
export { parseRetryAfter, estimateEntrySize, serializeHeaders }
export { DEFAULT_CACHEABLE_STATUSES }
export {
  STICKY_INITIAL_TTL_MS,
  STICKY_MAX_TTL_MS,
  FALLBACK_TTL_MS,
  PROBE_GRACE_PERIOD_MS,
  WARN_MEMORY_BYTES,
  MAX_MEMORY_BYTES,
}
