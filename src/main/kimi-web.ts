import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

const URL_REGEX = /(https?:\/\/[^\s'"<>]+)/
const ALREADY_RUNNING_REGEX = /server already running \(pid=(\d+), port=(\d+)/
const TOKEN_REGEX = /token[=:]([A-Za-z0-9_-]+)/i

function getKimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
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

async function probeExistingServer(info: KimiLockFile, token?: string): Promise<KimiWebInfo | undefined> {
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

function buildArgs(options: {
  bypassAuth: boolean
  port?: number
  host?: string
}): string[] {
  const args = ['web', '--foreground', '--no-open', '--keep-alive']
  if (options.bypassAuth) args.push('--dangerous-bypass-auth')
  if (options.port) args.push('--port', String(options.port))
  if (options.host) args.push('--host', options.host)
  return args
}

export class KimiWebManager {
  private process: ChildProcess | null = null
  private startedByUs = false

  async start(options: { bypassAuth?: boolean; port?: number; host?: string } = {}): Promise<KimiWebInfo> {
    const bypassAuth = options.bypassAuth ?? true

    // 1. If a server is already running, reuse it directly
    const lock = readLockFile()
    const existingToken = readExistingToken()
    if (lock) {
      const reused = await probeExistingServer(lock, existingToken)
      if (reused) {
        console.log(`[kimi web] reusing existing server at ${reused.url}`)
        return reused
      }
    }

    // 2. Otherwise, start a new one
    const args = buildArgs({ bypassAuth, port: options.port, host: options.host })

    return new Promise((resolve, reject) => {
      const command = 'kimi'
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
        resolve(info)
      }

      const onReject = (error: Error) => {
        if (resolved) return
        resolved = true
        cleanup()
        this.process = null
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
        onReject(new Error('Failed to start kimi web: no PID'))
        return
      }

      this.startedByUs = true

      const handleOutput = (data: Buffer) => {
        const chunk = data.toString()
        outputBuffer += chunk
        console.log(`[kimi web] ${chunk.trim()}`)

        const alreadyRunning = outputBuffer.match(ALREADY_RUNNING_REGEX)
        if (alreadyRunning) {
          const pid = Number(alreadyRunning[1])
          const port = Number(alreadyRunning[2])
          this.startedByUs = false
          onResolve({
            url: `http://127.0.0.1:${port}`,
            token: existingToken,
            pid,
            reused: true,
          })
          return
        }

        const urlMatch = outputBuffer.match(URL_REGEX)
        if (urlMatch) {
          const url = urlMatch[1]
          const tokenMatch = outputBuffer.match(TOKEN_REGEX) ?? url.match(/[?&]token=([^&]+)/)
          onResolve({
            url,
            token: tokenMatch ? tokenMatch[1] : undefined,
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

      // Try graceful shutdown first
      processToKill.once('exit', finish)
      processToKill.kill('SIGTERM')

      // Force kill after timeout
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
