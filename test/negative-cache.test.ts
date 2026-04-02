import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  NegativeResponseCache,
  parseRetryAfter,
  estimateEntrySize,
  serializeHeaders,
  STICKY_INITIAL_TTL_MS,
  STICKY_MAX_TTL_MS,
  FALLBACK_TTL_MS,
  PROBE_GRACE_PERIOD_MS,
  WARN_MEMORY_BYTES,
  MAX_MEMORY_BYTES,
  DEFAULT_CACHEABLE_STATUSES,
} from '../src/negative-cache'

function createResponseHeaders(
  init?: Record<string, string>,
): Headers {
  return new Headers(init)
}

describe('NegativeResponseCache', () => {
  let cache: NegativeResponseCache

  beforeEach(() => {
    cache = new NegativeResponseCache()
  })

  describe('buildCacheKey', () => {
    it('包含 accountId、method、path 和 search', () => {
      expect(cache.buildCacheKey('abc123', 'GET', '/v1/chat', '?model=gpt-4'))
        .toBe('abc123:GET:/v1/chat?model=gpt-4')
    })

    it('不同 method 产生不同 key', () => {
      const get = cache.buildCacheKey('abc', 'GET', '/path', '')
      const post = cache.buildCacheKey('abc', 'POST', '/path', '')
      expect(get).not.toBe(post)
    })

    it('不同 query 产生不同 key', () => {
      const a = cache.buildCacheKey('abc', 'GET', '/path', '?a=1')
      const b = cache.buildCacheKey('abc', 'GET', '/path', '?b=2')
      expect(a).not.toBe(b)
    })

    it('不同 account 产生不同 key', () => {
      const a = cache.buildCacheKey('user1', 'GET', '/path', '')
      const b = cache.buildCacheKey('user2', 'GET', '/path', '')
      expect(a).not.toBe(b)
    })
  })

  describe('isCacheableStatus', () => {
    it.each([401, 403, 404, 405, 410, 429])('状态码 %d 可缓存', (status) => {
      expect(cache.isCacheableStatus(status)).toBe(true)
    })

    it.each([200, 201, 301, 400, 408, 500, 502, 503])('状态码 %d 不可缓存', (status) => {
      expect(cache.isCacheableStatus(status)).toBe(false)
    })
  })

  describe('基础缓存：recordResponse + lookup', () => {
    it.each([401, 403, 404, 405, 410, 429])('缓存 %d 响应并命中', (status) => {
      const key = 'acc:GET:/path'
      const body = new TextEncoder().encode('error body').buffer

      cache.recordResponse(key, status, createResponseHeaders({ 'x-test': 'val' }), body, true)

      const entry = cache.lookup(key)
      expect(entry).not.toBeNull()
      expect(entry!.status).toBe(status)
      expect(entry!.headers).toContainEqual(['x-test', 'val'])
      expect(new Uint8Array(entry!.body)).toEqual(new TextEncoder().encode('error body'))
    })

    it('非可缓存状态码不被缓存', () => {
      const key = 'acc:GET:/path'
      cache.recordResponse(key, 200, createResponseHeaders(), new ArrayBuffer(0), true)
      expect(cache.lookup(key)).toBeNull()
    })

    it('非可缓存状态码删除已有条目', () => {
      const key = 'acc:GET:/path'
      cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)
      expect(cache.lookup(key)).not.toBeNull()

      cache.recordResponse(key, 200, createResponseHeaders(), new ArrayBuffer(0), true)
      expect(cache.lookup(key)).toBeNull()
    })
  })

  describe('createCachedResponse', () => {
    it('返回与原始响应一致的 status、headers、body', async () => {
      const key = 'acc:GET:/path'
      const bodyText = '{"error":"not found"}'
      const body = new TextEncoder().encode(bodyText).buffer

      cache.recordResponse(
        key,
        404,
        createResponseHeaders({ 'content-type': 'application/json' }),
        body,
        true,
      )

      const entry = cache.lookup(key)!
      const response = cache.createCachedResponse(entry)

      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(await response.text()).toBe(bodyText)
    })
  })

  describe('TTL 过期与探测', () => {
    it('TTL 过期后第一个请求放行（返回 null）', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)

        // TTL 内命中
        expect(cache.lookup(key)).not.toBeNull()

        // 推进到过期
        vi.advanceTimersByTime(STICKY_INITIAL_TTL_MS + 1)
        expect(cache.lookup(key)).toBeNull() // 放行探测
      } finally {
        vi.useRealTimers()
      }
    })

    it('探测期间其他请求仍走缓存', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)

        vi.advanceTimersByTime(STICKY_INITIAL_TTL_MS + 1)

        // 第一个请求放行
        expect(cache.lookup(key)).toBeNull()

        // 第二个请求在宽限期内仍走缓存
        expect(cache.lookup(key)).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('宽限期也过期后删除条目', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)

        // 推进到 TTL 过期
        vi.advanceTimersByTime(STICKY_INITIAL_TTL_MS + 1)
        cache.lookup(key) // 标记 probing

        // 推进到宽限期也过期
        vi.advanceTimersByTime(PROBE_GRACE_PERIOD_MS + 1)
        expect(cache.lookup(key)).toBeNull()
        expect(cache.entries.size).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('指数退避（accountBound = true）', () => {
    it('探测返回相同状态码 → TTL ×2', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)

        const entry1 = cache.lookup(key)!
        expect(entry1.currentTtlMs).toBe(STICKY_INITIAL_TTL_MS)

        // 过期 → 探测 → 相同状态码
        vi.advanceTimersByTime(STICKY_INITIAL_TTL_MS + 1)
        cache.lookup(key) // 放行探测
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)

        const entry2 = cache.lookup(key)!
        expect(entry2.currentTtlMs).toBe(STICKY_INITIAL_TTL_MS * 2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('连续升级直到 24h 上限', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        cache.recordResponse(key, 404, createResponseHeaders(), new ArrayBuffer(0), true)

        let expectedTtl = STICKY_INITIAL_TTL_MS

        // 1h → 2h → 4h → 8h → 16h → 24h → 24h
        for (let i = 0; i < 7; i++) {
          vi.advanceTimersByTime(expectedTtl + 1)
          cache.lookup(key) // 放行探测
          cache.recordResponse(key, 404, createResponseHeaders(), new ArrayBuffer(0), true)

          expectedTtl = Math.min(expectedTtl * 2, STICKY_MAX_TTL_MS)
          const entry = cache.lookup(key)!
          expect(entry.currentTtlMs).toBe(expectedTtl)
        }

        // 确认上限为 24h
        expect(cache.lookup(key)!.currentTtlMs).toBe(STICKY_MAX_TTL_MS)
      } finally {
        vi.useRealTimers()
      }
    })

    it('探测返回不同可缓存状态码 → 重置初始 TTL', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)

        // 退避到 2h
        vi.advanceTimersByTime(STICKY_INITIAL_TTL_MS + 1)
        cache.lookup(key)
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)
        expect(cache.lookup(key)!.currentTtlMs).toBe(STICKY_INITIAL_TTL_MS * 2)

        // 探测返回 403（不同状态码）→ 重置
        vi.advanceTimersByTime(STICKY_INITIAL_TTL_MS * 2 + 1)
        cache.lookup(key)
        cache.recordResponse(key, 403, createResponseHeaders(), new ArrayBuffer(0), true)

        expect(cache.lookup(key)!.currentTtlMs).toBe(STICKY_INITIAL_TTL_MS)
        expect(cache.lookup(key)!.status).toBe(403)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('固定 TTL（accountBound = false）', () => {
    it('TTL 始终 30s', () => {
      const key = 'site:GET:/path'
      cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), false)
      expect(cache.lookup(key)!.currentTtlMs).toBe(FALLBACK_TTL_MS)
    })

    it('重复记录不升级 TTL', () => {
      vi.useFakeTimers()

      try {
        const key = 'site:GET:/path'
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), false)

        vi.advanceTimersByTime(FALLBACK_TTL_MS + 1)
        cache.lookup(key) // 放行探测
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), false)

        expect(cache.lookup(key)!.currentTtlMs).toBe(FALLBACK_TTL_MS)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('429 Retry-After 特殊处理', () => {
    it('429 + Retry-After 秒数 → TTL 取该秒数', () => {
      const key = 'acc:GET:/path'
      const headers = createResponseHeaders({ 'retry-after': '120' })
      cache.recordResponse(key, 429, headers, new ArrayBuffer(0), true)

      const entry = cache.lookup(key)!
      expect(entry.currentTtlMs).toBe(120 * 1000)
      expect(entry.retryAfterOverride).toBe(true)
    })

    it('429 + Retry-After HTTP-date → TTL 取 date - now', () => {
      vi.useFakeTimers()

      try {
        const now = Date.now()
        const futureDate = new Date(now + 300_000).toUTCString() // 5 分钟后
        const key = 'acc:GET:/path'
        const headers = createResponseHeaders({ 'retry-after': futureDate })
        cache.recordResponse(key, 429, headers, new ArrayBuffer(0), true)

        const entry = cache.lookup(key)!
        // 允许 1 秒误差
        expect(entry.currentTtlMs).toBeGreaterThanOrEqual(299_000)
        expect(entry.currentTtlMs).toBeLessThanOrEqual(301_000)
        expect(entry.retryAfterOverride).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('429 无 Retry-After → fallback 到标准初始 TTL', () => {
      const key = 'acc:GET:/path'
      cache.recordResponse(key, 429, createResponseHeaders(), new ArrayBuffer(0), true)

      expect(cache.lookup(key)!.currentTtlMs).toBe(STICKY_INITIAL_TTL_MS)
      expect(cache.lookup(key)!.retryAfterOverride).toBe(false)
    })

    it('retryAfterOverride 条目过期后不参与指数退避', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        const headers = createResponseHeaders({ 'retry-after': '60' })
        cache.recordResponse(key, 429, headers, new ArrayBuffer(0), true)

        expect(cache.lookup(key)!.retryAfterOverride).toBe(true)

        // 过期后重新记录相同 429
        vi.advanceTimersByTime(61_000)
        cache.lookup(key) // 放行探测
        cache.recordResponse(key, 429, createResponseHeaders(), new ArrayBuffer(0), true)

        // 无 Retry-After → fallback 到初始 TTL，不是 ×2
        expect(cache.lookup(key)!.currentTtlMs).toBe(STICKY_INITIAL_TTL_MS)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('缓存清除', () => {
    it('探测返回非可缓存状态码 → 条目删除', () => {
      vi.useFakeTimers()

      try {
        const key = 'acc:GET:/path'
        cache.recordResponse(key, 401, createResponseHeaders(), new ArrayBuffer(0), true)

        vi.advanceTimersByTime(STICKY_INITIAL_TTL_MS + 1)
        cache.lookup(key) // 放行探测
        cache.recordResponse(key, 200, createResponseHeaders(), new ArrayBuffer(0), true)

        expect(cache.lookup(key)).toBeNull()
        expect(cache.entries.size).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('内存管理', () => {
    it('累计超 256MB 触发 warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        // 创建一个大体积条目逼近 256MB
        const bigBody = new ArrayBuffer(WARN_MEMORY_BYTES)
        cache.recordResponse('k1', 401, createResponseHeaders(), bigBody, true)

        expect(warnSpy).toHaveBeenCalledWith(
          '[negative-cache] 内存使用接近上限',
          expect.objectContaining({ warnThreshold: WARN_MEMORY_BYTES }),
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('累计超 512MB 触发 evict，最早过期的条目被淘汰', () => {
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        // 先插入一个小条目（将最早过期）
        cache.recordResponse('old', 401, createResponseHeaders(), new ArrayBuffer(1024), true)

        vi.advanceTimersByTime(1000)

        // 插入大条目超 512MB
        const bigBody = new ArrayBuffer(MAX_MEMORY_BYTES)
        cache.recordResponse('new', 404, createResponseHeaders(), bigBody, true)

        // old 条目应被淘汰
        expect(cache.entries.has('old')).toBe(false)
        expect(cache.entries.has('new')).toBe(true)
      } finally {
        warnSpy.mockRestore()
        vi.useRealTimers()
      }
    })

    it('evict 后 totalBytes 回落', () => {
      vi.useFakeTimers()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        const quarterSize = Math.floor(WARN_MEMORY_BYTES / 2)
        cache.recordResponse('a', 401, createResponseHeaders(), new ArrayBuffer(quarterSize), true)

        vi.advanceTimersByTime(1000)
        cache.recordResponse('b', 403, createResponseHeaders(), new ArrayBuffer(quarterSize), true)

        vi.advanceTimersByTime(1000)
        // 这个会触发 evict
        cache.recordResponse('c', 404, createResponseHeaders(), new ArrayBuffer(quarterSize), true)

        expect(cache.totalBytes).toBeLessThan(MAX_MEMORY_BYTES)
      } finally {
        warnSpy.mockRestore()
        vi.useRealTimers()
      }
    })
  })
})

describe('parseRetryAfter', () => {
  it('解析秒数', () => {
    expect(parseRetryAfter('120', Date.now())).toBe(120_000)
  })

  it('解析 HTTP-date', () => {
    const now = Date.now()
    const future = new Date(now + 600_000).toUTCString()
    const result = parseRetryAfter(future, now)
    expect(result).toBeGreaterThanOrEqual(599_000)
    expect(result).toBeLessThanOrEqual(601_000)
  })

  it('null 输入返回 null', () => {
    expect(parseRetryAfter(null, Date.now())).toBeNull()
  })

  it('无效值返回 null', () => {
    expect(parseRetryAfter('abc', Date.now())).toBeNull()
  })

  it('负数秒返回 null', () => {
    expect(parseRetryAfter('-1', Date.now())).toBeNull()
  })

  it('过去的 HTTP-date 返回 null', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(parseRetryAfter(past, Date.now())).toBeNull()
  })
})

describe('serializeHeaders', () => {
  it('序列化 Headers 为二元组数组', () => {
    const headers = new Headers({ 'content-type': 'text/plain', 'x-foo': 'bar' })
    const result = serializeHeaders(headers)
    expect(result).toContainEqual(['content-type', 'text/plain'])
    expect(result).toContainEqual(['x-foo', 'bar'])
  })
})

describe('estimateEntrySize', () => {
  it('计算体积包含 body + headers + 开销', () => {
    const headers: [string, string][] = [['content-type', 'text/plain']]
    const body = new ArrayBuffer(1000)
    const size = estimateEntrySize(headers, body)
    // 1000 + (12 + 10) * 2 + 256 = 1300
    expect(size).toBe(1000 + (12 + 10) * 2 + 256)
  })
})
