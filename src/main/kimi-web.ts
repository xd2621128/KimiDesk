import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import log from 'electron-log/main'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export interface KimiWebInfo {
  url: string
  token?: string
  pid?: number
  reused: boolean
}

interface KimiLockFile {
  pid: number
  host: string
  port: number
  host_version: string
  entry: string
}

// kimi >= 0.28 records running servers here instead of the legacy server/lock file
interface KimiInstanceFile {
  server_id: string
  pid: number
  host: string
  port: number
  started_at: number
  heartbeat_at: number
  host_version: string
}

interface ServerCandidate {
  pid: number
  host: string
  port: number
}

const KIMI_SERVER_URL_REGEX = /(?:Kimi server|Local):\s+(https?:\/\/[^\s'"<>#]+)/
const GENERIC_URL_REGEX = /(https?:\/\/[^\s'"<>#]+)/
const ALREADY_RUNNING_REGEX = /server already running \(pid=(\d+), port=(\d+)/
const TOKEN_REGEX = /[#?&]token=([A-Za-z0-9_-]+)/i

function parseKimiServerUrl(output: string): { url: string; token?: string } | undefined {
  const kimiMatch = output.match(KIMI_SERVER_URL_REGEX)
  if (kimiMatch) {
    const url = kimiMatch[1]
    const tokenMatch = output.match(TOKEN_REGEX)
    return { url, token: tokenMatch ? tokenMatch[1] : undefined }
  }

  const genericMatch = output.match(GENERIC_URL_REGEX)
  if (genericMatch) {
    const url = genericMatch[1]
    const tokenMatch = output.match(TOKEN_REGEX)
    return { url, token: tokenMatch ? tokenMatch[1] : undefined }
  }

  return undefined
}

function getKimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
}

export function findKimiExecutable(): string {
  const candidates = [
    join(getKimiCodeHome(), 'bin', 'kimi'),
    join(homedir(), '.kimi-code', 'bin', 'kimi'),
    '/usr/local/bin/kimi',
    '/opt/homebrew/bin/kimi',
    '/usr/bin/kimi',
  ]

  for (const path of candidates) {
    if (existsSync(path)) {
      return path
    }
  }

  return 'kimi'
}

function readExistingToken(): string | undefined {
  try {
    const tokenPath = join(getKimiCodeHome(), 'server.token')
    return readFileSync(tokenPath, 'utf-8').trim()
  } catch {
    return undefined
  }
}

function readLockFile(): KimiLockFile | undefined {
  try {
    const lockPath = join(getKimiCodeHome(), 'server', 'lock')
    const content = readFileSync(lockPath, 'utf-8')
    return JSON.parse(content) as KimiLockFile
  } catch {
    return undefined
  }
}

function readInstanceFiles(): KimiInstanceFile[] {
  try {
    const dir = join(getKimiCodeHome(), 'server', 'instances')
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as KimiInstanceFile
        } catch {
          return undefined
        }
      })
      .filter((i): i is KimiInstanceFile => Boolean(i && i.pid && i.host && i.port))
      .sort((a, b) => (b.heartbeat_at ?? 0) - (a.heartbeat_at ?? 0))
  } catch {
    return []
  }
}

function readServerCandidates(): ServerCandidate[] {
  const candidates: ServerCandidate[] = readInstanceFiles()
  const lock = readLockFile()
  if (lock) candidates.push(lock)
  return candidates
}

async function probeExistingServer(info: ServerCandidate, token?: string): Promise<KimiWebInfo | undefined> {
  const url = `http://${info.host}:${info.port}`
  const metaUrl = `${url}/api/v1/meta`
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    const response = await fetch(metaUrl, { headers, signal: AbortSignal.timeout(3000) })
    if (response.ok) {
      return { url, token, pid: info.pid, reused: true }
    }
  } catch {
    // Server not reachable
  }
  return undefined
}

// kimi >= 0.28 removed `web --foreground` / `--keep-alive` (foreground is the
// default); detect support once from `kimi web --help` so older installs keep working.
let legacyWebFlags: boolean | undefined

async function detectLegacyWebFlags(command: string): Promise<boolean> {
  if (legacyWebFlags !== undefined) return legacyWebFlags
  try {
    const help = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, ['web', '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('timeout'))
      }, 10000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(out)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    legacyWebFlags = help.includes('--foreground')
  } catch {
    legacyWebFlags = false
  }
  return legacyWebFlags
}

function buildArgs(options: {
  bypassAuth: boolean
  port?: number
  host?: string
  legacyFlags: boolean
}): string[] {
  const args = ['web', '--no-open']
  if (options.legacyFlags) args.push('--foreground', '--keep-alive')
  if (options.bypassAuth) args.push('--dangerous-bypass-auth')
  if (options.port) args.push('--port', String(options.port))
  if (options.host) args.push('--host', options.host)
  return args
}

export class KimiWebManager {
  private process: ChildProcess | null = null
  private startedByUs = false
  private restartCount = 0
  private maxRestarts = 3

  async start(options: { bypassAuth?: boolean; port?: number; host?: string } = {}): Promise<KimiWebInfo> {
    const bypassAuth = options.bypassAuth ?? true

    const existingToken = readExistingToken()
    for (const candidate of readServerCandidates()) {
      const reused = await probeExistingServer(candidate, existingToken)
      if (reused) {
        log.info(`[kimi web] reusing existing server at ${reused.url}`)
        return reused
      }
    }

    return this.doStart({ bypassAuth, port: options.port, host: options.host })
  }

  private async doStart(options: {
    bypassAuth: boolean
    port?: number
    host?: string
  }): Promise<KimiWebInfo> {
    const command = findKimiExecutable()
    const legacyFlags = await detectLegacyWebFlags(command)
    const args = buildArgs({ ...options, legacyFlags })
    log.info(`[kimi web] spawning: ${command} ${args.join(' ')}`)

    return new Promise((resolve, reject) => {
      let outputBuffer = ''
      let resolved = false
      let timeout: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
      }

      const onResolve = (info: KimiWebInfo) => {
        if (resolved) return
        resolved = true
        cleanup()
        this.restartCount = 0
        resolve(info)
      }

      const onReject = async (error: Error) => {
        if (resolved) return
        resolved = true
        cleanup()
        this.process = null

        if (this.restartCount < this.maxRestarts) {
          this.restartCount++
          log.warn(`[kimi web] restart attempt ${this.restartCount}/${this.maxRestarts} after error: ${error.message}`)
          try {
            const info = await this.doStart(options)
            resolve(info)
            return
          } catch (retryError) {
            reject(retryError instanceof Error ? retryError : new Error(String(retryError)))
            return
          }
        }

        reject(error)
      }

      timeout = setTimeout(() => {
        onReject(new Error('Timeout waiting for kimi web to start'))
        this.stop().catch(() => {})
      }, 30000)

      try {
        this.process = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: platform() === 'win32',
          detached: false,
        })
      } catch (error) {
        onReject(new Error(`Failed to spawn kimi: ${error instanceof Error ? error.message : String(error)}`))
        return
      }

      if (!this.process.pid) {
        onReject(new Error(`Failed to start kimi web: no PID (command: ${command})`))
        return
      }

      this.startedByUs = true

      const handleOutput = (data: Buffer) => {
        const chunk = data.toString()
        outputBuffer += chunk
        log.info(`[kimi web] ${chunk.trim()}`)

        const alreadyRunning = outputBuffer.match(ALREADY_RUNNING_REGEX)
        if (alreadyRunning) {
          const pid = Number(alreadyRunning[1])
          const port = Number(alreadyRunning[2])
          this.startedByUs = false
          onResolve({
            url: `http://127.0.0.1:${port}`,
            token: readExistingToken(),
            pid,
            reused: true,
          })
          return
        }

        const parsed = parseKimiServerUrl(outputBuffer)
        if (parsed) {
          onResolve({
            url: parsed.url,
            token: parsed.token,
            pid: this.process?.pid ?? undefined,
            reused: false,
          })
        }
      }

      this.process.stdout?.on('data', handleOutput)
      this.process.stderr?.on('data', handleOutput)

      this.process.on('error', (error) => {
        onReject(new Error(`kimi web process error: ${error.message}`))
      })

      this.process.on('exit', (code, signal) => {
        if (!resolved) {
          onReject(new Error(`kimi web exited unexpectedly (code=${code}, signal=${signal})`))
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.process || !this.startedByUs) {
      this.process = null
      return
    }

    const pid = this.process.pid
    if (!pid) {
      this.process = null
      this.startedByUs = false
      return
    }

    const processToKill = this.process
    this.process = null
    this.startedByUs = false

    return new Promise((resolve) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        resolve()
      }

      processToKill.once('exit', finish)
      processToKill.kill('SIGTERM')

      setTimeout(() => {
        if (!processToKill.killed) {
          if (platform() === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: true })
          } else {
            try {
              process.kill(pid, 'SIGKILL')
            } catch {
              // Process already gone
            }
          }
        }
        finish()
      }, 5000).unref()
    })
  }
}
