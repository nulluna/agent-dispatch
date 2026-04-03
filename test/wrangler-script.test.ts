import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '..')
const wranglerPackageJsonPath = resolve(
  projectRoot,
  'node_modules/wrangler/package.json',
)

function createWritableHome() {
  const root = mkdtempSync(join(tmpdir(), 'agent-dispatch-wrangler-test-'))
  const home = join(root, 'home')

  mkdirSync(home)

  return {
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
    home,
    xdgConfigHome: join(root, 'xdg-config'),
  }
}

describe('scripts/wrangler.mjs', () => {
  it('启动 wrangler CLI 并透传参数', () => {
    const expectedVersion = JSON.parse(
      readFileSync(wranglerPackageJsonPath, 'utf8'),
    ).version as string
    const envDir = createWritableHome()

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/wrangler.mjs', '--version'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: envDir.home,
            XDG_CONFIG_HOME: envDir.xdgConfigHome,
          },
        },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(expectedVersion)
    } finally {
      envDir.cleanup()
    }
  })

  it('设置 DNS_SERVER 后仍会继续启动 wrangler CLI', () => {
    const expectedVersion = JSON.parse(
      readFileSync(wranglerPackageJsonPath, 'utf8'),
    ).version as string
    const envDir = createWritableHome()

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/wrangler.mjs', '--version'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            DNS_SERVER: '8.8.8.8',
            HOME: envDir.home,
            XDG_CONFIG_HOME: envDir.xdgConfigHome,
          },
        },
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('[agent-dispatch] dns servers set: 8.8.8.8')
      expect(result.stdout).toContain(expectedVersion)
    } finally {
      envDir.cleanup()
    }
  })
})
