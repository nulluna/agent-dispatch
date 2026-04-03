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

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const require = createRequire(import.meta.url)
const wranglerCliPath = require.resolve('wrangler/wrangler-dist/cli.js')
const dnsPreloadPath = fileURLToPath(new URL('./wrangler-dns-preload.cjs', import.meta.url))
const child = spawn(
  process.execPath,
  [
    '--no-warnings',
    '--experimental-vm-modules',
    ...process.execArgv,
    ...(dnsServerValue ? ['--require', dnsPreloadPath] : []),
    wranglerCliPath,
    ...process.argv.slice(2),
  ],
  {
    env: dnsServerValue
      ? {
          ...process.env,
          AGENT_DISPATCH_DNS_SERVER: dnsServerValue,
        }
      : process.env,
    stdio: 'inherit',
  },
)

process.on('SIGINT', () => {
  child.kill('SIGINT')
})

process.on('SIGTERM', () => {
  child.kill('SIGTERM')
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})
