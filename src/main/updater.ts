import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import log from 'electron-log/main'
import { findKimiExecutable } from './kimi-web'

const LATEST_VERSION_URL = 'https://code.kimi.com/kimi-code/latest'
const CHECK_TIMEOUT_MS = 5000
const UPGRADE_TIMEOUT_MS = 300_000

export interface KimiUpdateCheck {
  status: 'available' | 'none'
  current?: string
  latest?: string
}

function normalizeVersion(raw: string): string | undefined {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : undefined
}

/** a > b 返回正数，a < b 返回负数，相等返回 0 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let settled = false

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: platform() === 'win32',
    })

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(out)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`timeout: ${command} ${args.join(' ')}`))
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (error) => finish(error))
    child.on('exit', (code) => {
      if (code === 0) finish()
      else finish(new Error(`${command} ${args.join(' ')} exited with code ${code}: ${out.trim()}`))
    })
  })
}

async function readCurrentVersion(command: string): Promise<string> {
  const out = await runCommand(command, ['--version'], CHECK_TIMEOUT_MS)
  const version = normalizeVersion(out)
  if (!version) throw new Error(`unrecognized version output: ${out.trim()}`)
  return version
}

async function readLatestVersion(): Promise<string> {
  const response = await fetch(LATEST_VERSION_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`latest version fetch failed: HTTP ${response.status}`)
  const version = normalizeVersion(await response.text())
  if (!version) throw new Error('unrecognized latest version response')
  return version
}

/**
 * 检查 kimi code 是否有新版本。任何失败（网络、命令缺失、超时）都归为
 * `none`，调用方静默继续启动，不阻塞用户。
 */
export async function checkKimiCodeUpdate(): Promise<KimiUpdateCheck> {
  try {
    const command = findKimiExecutable()
    const [current, latest] = await Promise.all([readCurrentVersion(command), readLatestVersion()])
    log.info(`[update] current=${current} latest=${latest}`)
    if (compareVersions(latest, current) > 0) {
      return { status: 'available', current, latest }
    }
    return { status: 'none', current, latest }
  } catch (error) {
    log.warn('[update] check failed:', error instanceof Error ? error.message : error)
    return { status: 'none' }
  }
}

/** 执行 `kimi upgrade` 就地升级，exit code 非 0 或超时则 reject */
export async function runKimiUpgrade(): Promise<void> {
  const command = findKimiExecutable()
  log.info(`[update] running: ${command} upgrade`)
  const out = await runCommand(command, ['upgrade'], UPGRADE_TIMEOUT_MS)
  log.info(`[update] upgrade output: ${out.trim()}`)
}
