import { app, shell } from 'electron'
import log from 'electron-log/main'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import type { QuotaState } from '../preload/types'

const QUOTA_API = 'https://api.kimi.com/coding/v1/usages'
const AUTH_HOST = 'https://auth.kimi.com'
const DEVICE_AUTH_API = `${AUTH_HOST}/api/oauth/device_authorization`
const TOKEN_API = `${AUTH_HOST}/api/oauth/token`
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
export const QUOTA_PAGE_URL = 'https://www.kimi.com/membership/subscription?tab=quota'

const REFRESH_MARGIN_SECONDS = 300
const QUOTA_CACHE_TTL_MS = 30_000
export const QUOTA_POLL_INTERVAL_MS = 60_000

interface OAuthToken {
  access_token: string
  refresh_token: string
  expires_at: number
}

interface PendingAuthorization {
  deviceCode: string
  expiresAt: number
  intervalMs: number
}

interface QuotaAuthFile {
  token?: OAuthToken
  deviceId?: string
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function isTokenValid(token: unknown): token is OAuthToken {
  const t = token as OAuthToken | undefined
  return Boolean(t && typeof t.access_token === 'string' && t.access_token
    && typeof t.refresh_token === 'string' && t.refresh_token
    && Number.isFinite(t.expires_at))
}

/**
 * 额度与加油包余额：走独立的 Kimi Device OAuth（不碰 CLI 凭据，避免 refresh token
 * 轮换导致 CLI 掉线），再请求 https://api.kimi.com/coding/v1/usages。
 * 参考 kimi-code-monitor 的 background.js。
 */
export class QuotaManager {
  private state: QuotaState = {
    authorized: false,
    authorizing: false,
    balance: null,
    fiveHourPct: null,
    fiveHourResetAt: null,
    weekPct: null,
    weekResetAt: null,
  }

  private listener: ((state: QuotaState) => void) | null = null
  private token: OAuthToken | null = null
  private deviceId = ''
  private pending: PendingAuthorization | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private quotaCache: { fetchedAt: number; data: unknown } | null = null
  private quotaFetchPromise: Promise<void> | null = null
  private refreshPromise: Promise<OAuthToken | null> | null = null

  onUpdate(listener: (state: QuotaState) => void): void {
    this.listener = listener
  }

  getState(): QuotaState {
    return this.state
  }

  private get storagePath(): string {
    return join(app.getPath('userData'), 'quota-auth.json')
  }

  /** 应用启动时调用：加载已存 token 并拉一次额度 */
  async init(): Promise<void> {
    this.loadStorage()
    await this.fetchQuota()
  }

  /** 定时轮询入口（带 30s 缓存，重复调用开销低） */
  async refresh(): Promise<void> {
    this.quotaCache = null
    await this.fetchQuota()
  }

  /** 开始 Device OAuth 授权：打开授权页并轮询授权结果 */
  async authorize(): Promise<void> {
    if (this.state.authorizing) return
    this.setState({ authorizing: true })
    try {
      const response = await this.postForm(DEVICE_AUTH_API, { client_id: CLIENT_ID })
      if (!response.ok) throw await httpError('设备授权', response)
      const data = (await response.json()) as Record<string, unknown>
      if (!data.device_code) throw new Error('设备授权响应不完整')

      const expiresIn = toNumber(data.expires_in) || 900
      this.pending = {
        deviceCode: String(data.device_code),
        expiresAt: Date.now() + expiresIn * 1_000,
        intervalMs: Math.max(2_000, (toNumber(data.interval) || 5) * 1_000),
      }

      const authorizationUrl = String(data.verification_uri_complete || data.verification_uri || '')
      if (authorizationUrl) {
        await shell.openExternal(authorizationUrl)
      }
      this.schedulePoll(0)
    } catch (error) {
      log.warn('[quota] 授权启动失败:', error)
      this.pending = null
      this.setState({ authorizing: false })
    }
  }

  dispose(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  /* ---------- 授权轮询 ---------- */

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.pollDeviceAuthorization()
    }, delayMs)
  }

  private async pollDeviceAuthorization(): Promise<void> {
    const pending = this.pending
    if (!pending) return
    if (Date.now() >= pending.expiresAt) {
      this.pending = null
      this.setState({ authorizing: false })
      return
    }

    try {
      const response = await this.postForm(TOKEN_API, {
        client_id: CLIENT_ID,
        device_code: pending.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      })
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>

      if (!response.ok) {
        if (data.error === 'authorization_pending') {
          this.schedulePoll(pending.intervalMs)
          return
        }
        if (data.error === 'slow_down') {
          pending.intervalMs += 5_000
          this.schedulePoll(pending.intervalMs)
          return
        }
        throw new Error(`设备授权失败: ${String(data.error ?? response.status)}`)
      }

      this.token = this.normalizeToken(data)
      this.pending = null
      this.quotaCache = null
      this.saveStorage()
      log.info('[quota] 授权成功')
      this.setState({ authorizing: false })
      await this.fetchQuota()
    } catch (error) {
      log.warn('[quota] 授权轮询失败:', error)
      if (this.pending && Date.now() < this.pending.expiresAt) {
        this.schedulePoll(this.pending.intervalMs)
      } else {
        this.setState({ authorizing: false })
      }
    }
  }

  /* ---------- 额度查询 ---------- */

  private async fetchQuota(): Promise<void> {
    if (this.quotaCache && Date.now() - this.quotaCache.fetchedAt < QUOTA_CACHE_TTL_MS) {
      this.applyQuotaData(this.quotaCache.data)
      return
    }
    if (this.quotaFetchPromise) return this.quotaFetchPromise
    this.quotaFetchPromise = this.fetchQuotaFresh().finally(() => {
      this.quotaFetchPromise = null
    })
    return this.quotaFetchPromise
  }

  private async fetchQuotaFresh(): Promise<void> {
    const token = await this.getValidToken()
    if (!token) {
      this.setState({ authorized: false, balance: null, fiveHourPct: null, fiveHourResetAt: null, weekPct: null, weekResetAt: null })
      return
    }

    let response = await this.requestQuota(token.access_token)
    if (response.status === 401 || response.status === 403) {
      const refreshed = await this.refreshToken(token).catch(() => null)
      if (!refreshed) {
        this.token = null
        this.saveStorage()
        this.setState({ authorized: false })
        return
      }
      response = await this.requestQuota(refreshed.access_token)
    }
    if (!response.ok) throw await httpError('额度 API', response)

    const data = await response.json()
    this.quotaCache = { fetchedAt: Date.now(), data }
    this.applyQuotaData(data)
  }

  private applyQuotaData(raw: unknown): void {
    const data = (raw ?? {}) as Record<string, unknown>
    const next: QuotaState = { ...this.state, authorized: true }

    const wallet = data.boosterWallet as Record<string, unknown> | undefined
    const balance = wallet?.balance as Record<string, unknown> | undefined
    const amountLeft = Number(balance?.amountLeft)
    next.balance = Number.isFinite(amountLeft) ? Math.max(0, amountLeft / 100_000_000) : null

    const usage = data.usage as Record<string, unknown> | undefined
    next.weekPct = quotaPercentage(usage)
    next.weekResetAt = parseResetTime(usage?.resetTime)

    const limits = Array.isArray(data.limits) ? (data.limits as Record<string, unknown>[]) : []
    const fiveHour = limits.find((item) => toNumber((item.window as Record<string, unknown>)?.duration) === 300)
    const fiveHourDetail = fiveHour?.detail as Record<string, unknown> | undefined
    next.fiveHourPct = quotaPercentage(fiveHourDetail)
    next.fiveHourResetAt = parseResetTime(fiveHourDetail?.resetTime)

    this.setState(next)
  }

  private requestQuota(accessToken: string): Promise<Response> {
    return fetch(QUOTA_API, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    })
  }

  /* ---------- token 管理 ---------- */

  private async getValidToken(): Promise<OAuthToken | null> {
    if (!isTokenValid(this.token)) return null
    const now = Math.floor(Date.now() / 1_000)
    if (this.token.expires_at > now + REFRESH_MARGIN_SECONDS) return this.token
    return this.refreshToken(this.token).catch(() => null)
  }

  private refreshToken(token: OAuthToken): Promise<OAuthToken | null> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      const response = await this.postForm(TOKEN_API, {
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      })
      if (!response.ok) throw await httpError('token 刷新', response)
      const data = (await response.json()) as Record<string, unknown>
      this.token = this.normalizeToken(data, token.refresh_token)
      this.saveStorage()
      return this.token
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private normalizeToken(data: Record<string, unknown>, fallbackRefreshToken = ''): OAuthToken {
    const expiresIn = toNumber(data.expires_in)
    const refreshToken = String(data.refresh_token || fallbackRefreshToken)
    if (!data.access_token || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('Kimi token 响应不完整')
    }
    return {
      access_token: String(data.access_token),
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1_000) + expiresIn,
    }
  }

  /* ---------- 存储与请求 ---------- */

  private loadStorage(): void {
    try {
      const raw = readFileSync(this.storagePath, 'utf-8')
      const parsed = JSON.parse(raw) as QuotaAuthFile
      this.token = isTokenValid(parsed.token) ? parsed.token : null
      this.deviceId = parsed.deviceId || randomUUID()
    } catch {
      this.token = null
      this.deviceId = randomUUID()
    }
    if (!existsSync(this.storagePath)) this.saveStorage()
  }

  private saveStorage(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const content: QuotaAuthFile = { token: this.token ?? undefined, deviceId: this.deviceId }
      writeFileSync(this.storagePath, JSON.stringify(content, null, 2), 'utf-8')
    } catch (error) {
      log.warn('[quota] 保存授权信息失败:', error)
    }
  }

  private async postForm(url: string, parameters: Record<string, string>): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'X-Msh-Platform': 'kimi_code_cli',
        'X-Msh-Version': app.getVersion(),
        'X-Msh-Device-Id': this.deviceId,
        'X-Msh-Device-Name': 'KimiDesk',
        'X-Msh-Device-Model': process.platform,
        'X-Msh-Os-Version': release(),
      },
      body: new URLSearchParams(parameters).toString(),
      signal: AbortSignal.timeout(20_000),
    })
  }

  private setState(patch: Partial<QuotaState>): void {
    this.state = { ...this.state, ...patch }
    this.listener?.(this.state)
  }
}

function quotaPercentage(detail: Record<string, unknown> | undefined): number | null {
  if (!detail) return null
  const limit = toNumber(detail.limit)
  if (limit <= 0) return null
  const used = detail.used != null
    ? toNumber(detail.used)
    : Math.max(0, limit - toNumber(detail.remaining))
  return (used / limit) * 100
}

function parseResetTime(value: unknown): number | null {
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? time : null
}

async function httpError(label: string, response: Response): Promise<Error> {
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const detail = (data?.error as Record<string, unknown>)?.message ?? data?.error_description ?? data?.message ?? data?.error
  return new Error(`${label} HTTP ${response.status}${detail ? `: ${String(detail)}` : ''}`)
}
