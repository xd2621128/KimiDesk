import { spawn } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import log from 'electron-log/main'
import { findKimiExecutable, getKimiCodeHome } from './kimi-web'

const LATEST_VERSION_URL = 'https://code.kimi.com/kimi-code/latest'
const INSTALL_SCRIPT_URL = 'https://code.kimi.com/kimi-code/install.sh'
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

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let settled = false

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: platform() === 'win32',
      env: env ? { ...process.env, ...env } : undefined,
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

/** 升级是否生效：重新读取当前版本，达到 latest 即视为成功 */
async function isUpgraded(command: string, latest: string): Promise<boolean> {
  try {
    const current = await readCurrentVersion(command)
    log.info(`[update] verify: current=${current} target=${latest}`)
    return compareVersions(current, latest) >= 0
  } catch (error) {
    log.warn('[update] verify failed:', error instanceof Error ? error.message : error)
    return false
  }
}

/**
 * `kimi upgrade` 失效时的兜底：执行官方安装脚本（仅 macOS/Linux）。
 * kimi 0.28.1 的 upgrade 会把平台误识别为 "native (windows)" 并拒绝自升级，
 * 但仍以 exit 0 退出，因此必须靠版本校验发现问题再走到这里。
 */
async function runInstallScript(): Promise<string> {
  const response = await fetch(INSTALL_SCRIPT_URL, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`install script fetch failed: HTTP ${response.status}`)
  const scriptPath = join(tmpdir(), `kimi-code-install-${Date.now()}.sh`)
  writeFileSync(scriptPath, await response.text(), { mode: 0o755 })
  try {
    return await runCommand('bash', [scriptPath], UPGRADE_TIMEOUT_MS, {
      // 已安装过，无需再改 shell rc；安装目录与 findKimiExecutable 保持一致
      KIMI_NO_MODIFY_PATH: '1',
      KIMI_INSTALL_DIR: getKimiCodeHome(),
    })
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {
      // 临时文件清理失败可忽略
    }
  }
}

/**
 * 升级 kimi code 到 latest。先尝试 `kimi upgrade`，随后重新校验版本
 * （0.28.1 的 upgrade 会拒绝自升级但仍 exit 0，不校验就会被误判为成功）；
 * 校验不通过时回退到官方安装脚本；最终版本仍不达标则 reject。
 */
export async function runKimiUpgrade(latest: string): Promise<void> {
  const command = findKimiExecutable()
  log.info(`[update] running: ${command} upgrade`)
  try {
    const out = await runCommand(command, ['upgrade'], UPGRADE_TIMEOUT_MS)
    log.info(`[update] upgrade output: ${out.trim()}`)
  } catch (error) {
    log.warn('[update] kimi upgrade failed:', error instanceof Error ? error.message : error)
  }
  if (await isUpgraded(command, latest)) return

  if (platform() === 'win32') {
    throw new Error('kimi upgrade 未能完成更新，请手动升级 kimi code')
  }
  log.info('[update] falling back to official install script')
  const out = await runInstallScript()
  log.info(`[update] install script output: ${out.trim()}`)
  if (await isUpgraded(command, latest)) return
  throw new Error(`更新未生效，请手动运行: curl -fsSL ${INSTALL_SCRIPT_URL} | bash`)
}
