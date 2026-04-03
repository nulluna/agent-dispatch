#!/usr/bin/env node

/**
 * wrangler 启动引导脚本
 *
 * 支持通过 DNS_SERVER 指定自定义 DNS 服务器。
 * 读取优先级: 环境变量 > .dev.vars 文件
 * 未配置时直接透传启动 wrangler，零开销。
 *
 * 用法:
 *   DNS_SERVER=8.8.8.8,1.1.1.1 node scripts/wrangler.mjs dev
 *   # 或在 .dev.vars 中添加 DNS_SERVER=8.8.8.8,1.1.1.1
 *   node scripts/wrangler.mjs dev
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readDevVars(key) {
  try {
    const content = readFileSync(resolve(process.cwd(), '.dev.vars'), 'utf-8')

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const eqIndex = trimmed.indexOf('=')
      if (eqIndex <= 0) continue

      const k = trimmed.slice(0, eqIndex).trim()
      if (k !== key) continue

      // 去除可选引号
      let v = trimmed.slice(eqIndex + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }

      return v || undefined
    }
  } catch {
    // .dev.vars 不存在或不可读，静默跳过
  }

  return undefined
}

const dnsServerValue = process.env.DNS_SERVER?.trim() || readDevVars('DNS_SERVER')

if (dnsServerValue) {
  const dns = await import('node:dns')
  const servers = dnsServerValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (servers.length > 0) {
    dns.setServers(servers)
    console.info(`[agent-dispatch] dns servers set: ${servers.join(', ')}`)
  }
}

await import('wrangler/bin/wrangler.js')
