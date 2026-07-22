import log from 'electron-log/main'
import type { AgentStatus, SessionMetrics } from '../preload/types'

const WS_RECONNECT_DELAY_MS = 3_000
const SNAPSHOT_TIMEOUT_MS = 15_000
const SESSION_URL_REGEX = /^\/sessions\/([^/?#]+)/
/** 启动后首个回退检查的延迟（给页面自动选中会话的导航事件留出时间） */
const FALLBACK_INITIAL_DELAY_MS = 2_500
/** 未跟踪到会话时的回退重试间隔 */
const FALLBACK_RETRY_MS = 10_000
/** 旧会话 resync（触发服务端驻留后重新订阅）的最大尝试次数（每次 WS 连接内） */
const RESYNC_MAX_ATTEMPTS = 2

function emptyMetrics(): SessionMetrics {
  return {
    sessionId: null,
    status: 'idle',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    lastSpeed: 0,
    lastDuration: 0,
  }
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

interface WsEvent {
  type: string
  seq?: number
  session_id?: string
  payload?: Record<string, unknown>
}

/**
 * 当前会话指标采集：跟踪 kimi web 页面 URL 中的 /sessions/{id}，
 * 先拉 REST 快照，再订阅 WebSocket 增量事件。
 * 参考 kimi-code-monitor 的 content.js，但本地 REST 响应有 {code,data} 包装，需解包。
 */
export class SessionMonitor {
  private baseUrl = ''
  private token = ''
  private metrics: SessionMetrics = emptyMetrics()
  private listener: ((metrics: SessionMetrics) => void) | null = null

  private ws: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private resyncAttempts = 0
  private lastSeq = 0
  private snapshotRequestId = 0
  private disposed = false
  /** 页面内导航（did-navigate-in-page）出现前，允许从会话列表回退选择跟踪目标 */
  private fallbackEnabled = false
  private fallbackTimer: NodeJS.Timeout | null = null

  onUpdate(listener: (metrics: SessionMetrics) => void): void {
    this.listener = listener
  }

  getMetrics(): SessionMetrics {
    return this.metrics
  }

  /** kimi web 就绪后调用，配置服务地址与凭据 */
  configure(baseUrl: string, token?: string): void {
    // kimi web 输出的 URL 带尾部斜杠，直接拼接会变成 //api/... 而被 SPA fallback 成 HTML
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token ?? ''
    if (this.metrics.sessionId) {
      this.startSession(this.metrics.sessionId)
    }
    // 启动时 kimi web 可能恢复上次会话而不产生页面内导航事件，
    // 启用回退跟踪：短时间内没有跟踪到会话时从会话列表自动选择
    this.fallbackEnabled = true
    this.scheduleFallbackCheck(FALLBACK_INITIAL_DELAY_MS)
  }

  /** 页面导航（含 SPA 内跳转）时调用，跟踪当前会话；inPage 表示 SPA 内跳转 */
  handleNavigate(url: string, inPage = false): void {
    if (inPage) {
      // 用户/页面有了明确的会话导航，回退机制让位
      this.stopFallback()
    }
    let pathname = ''
    try {
      pathname = new URL(url).pathname
    } catch {
      return
    }
    const sessionId = pathname.match(SESSION_URL_REGEX)?.[1] ?? null
    if (sessionId !== this.metrics.sessionId) {
      this.startSession(sessionId)
    }
  }

  /** 手动刷新：重置累计指标并重新拉快照 */
  refresh(): void {
    if (this.metrics.sessionId) {
      this.startSession(this.metrics.sessionId)
    }
  }

  dispose(): void {
    this.disposed = true
    this.snapshotRequestId += 1
    this.stopFallback()
    this.disconnectWebSocket()
  }

  private emit(): void {
    this.listener?.({ ...this.metrics })
  }

  private setStatus(status: AgentStatus): void {
    this.metrics.status = status
    this.emit()
  }

  private stopFallback(): void {
    this.fallbackEnabled = false
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }

  private scheduleFallbackCheck(delayMs: number): void {
    if (!this.fallbackEnabled || this.fallbackTimer || this.disposed) return
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      void this.runFallbackCheck()
    }, delayMs)
  }

  /**
   * 回退跟踪：kimi web 恢复上次会话时可能不产生页面内导航事件，
   * 导致启动后一直跟踪不到会话。此时从会话列表选一个目标：
   * 优先正在运行的会话，否则取最近更新的会话（列表按 updated_at 倒序）。
   */
  private async runFallbackCheck(): Promise<void> {
    if (!this.fallbackEnabled || this.disposed || this.metrics.sessionId || !this.baseUrl) return
    try {
      const headers: Record<string, string> = {}
      if (this.token) headers.Authorization = `Bearer ${this.token}`
      const response = await fetch(`${this.baseUrl}/api/v1/sessions`, {
        headers,
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as Record<string, unknown>
      const data = (json.data ?? json) as unknown
      const sessions = (Array.isArray(data) ? data : (data as Record<string, unknown>).sessions ?? []) as Record<string, unknown>[]
      const candidate = sessions.find((s) => s.busy || s.main_turn_active) ?? sessions[0]
      const candidateId = typeof candidate?.id === 'string' ? candidate.id : null
      if (candidateId && !this.metrics.sessionId) {
        log.info(`[monitor] no navigation observed, fallback tracking session ${candidateId}`)
        this.startSession(candidateId)
        return
      }
    } catch (error) {
      log.warn('[monitor] session fallback check failed:', error)
    }
    this.scheduleFallbackCheck(FALLBACK_RETRY_MS)
  }

  private startSession(sessionId: string | null): void {
    this.snapshotRequestId += 1
    this.disconnectWebSocket()
    this.metrics = emptyMetrics()
    this.metrics.sessionId = sessionId
    this.lastSeq = 0
    this.emit()

    if (!sessionId || !this.baseUrl) return
    log.info(`[monitor] tracking session ${sessionId}`)
    const requestId = this.snapshotRequestId
    void this.loadSessionSnapshot(sessionId, requestId).then(() => {
      if (!this.disposed && requestId === this.snapshotRequestId && this.metrics.sessionId === sessionId) {
        this.connectWebSocket()
      }
    })
  }

  private async loadSessionSnapshot(sessionId: string, requestId: number): Promise<void> {
    try {
      const headers: Record<string, string> = {}
      if (this.token) headers.Authorization = `Bearer ${this.token}`
      const response = await fetch(`${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
        headers,
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as Record<string, unknown>
      // 本地 REST 响应包装在 {code, msg, data} 中
      const data = (json.data ?? json) as Record<string, unknown>
      if (this.disposed || requestId !== this.snapshotRequestId || this.metrics.sessionId !== sessionId) return

      // 注意：REST 快照的 usage / last_seq 恒为 0（服务端不回填历史统计），
      // 真实 token 数据来自 WS 订阅后服务端回放的事件缓冲（见 handleAck）；
      // 这里主要取 busy / main_turn_active 状态
      const usage = (data.usage ?? {}) as Record<string, unknown>
      this.metrics.inputTokens = toNumber(usage.input_tokens)
      this.metrics.outputTokens = toNumber(usage.output_tokens)
      this.metrics.cacheReadTokens = toNumber(usage.cache_read_tokens)
      this.metrics.cacheCreationTokens = toNumber(usage.cache_creation_tokens)
      this.metrics.status = data.busy || data.main_turn_active ? 'running' : 'idle'
      this.lastSeq = toNumber(data.last_seq)
      this.emit()
    } catch (error) {
      log.warn('[monitor] session snapshot failed, falling back to live events:', error)
    }
  }

  private connectWebSocket(): void {
    if (this.disposed || !this.metrics.sessionId || !this.baseUrl || this.ws) return
    const sessionId = this.metrics.sessionId
    this.resyncAttempts = 0
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/ws?client_id=kimidesk-statusbar`
    const protocols = this.token ? [`kimi-code.bearer.${this.token}`] : undefined

    let ws: WebSocket
    try {
      ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl)
    } catch (error) {
      log.warn('[monitor] WebSocket creation failed:', error)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onmessage = (event) => {
      try {
        this.handleWsMessage(JSON.parse(String(event.data)) as WsEvent)
      } catch {
        // 忽略无法解析的消息
      }
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = null
      this.setStatus('offline')
      log.warn(`[monitor] WebSocket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`)
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose 会随后触发，统一在那里处理
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || !this.metrics.sessionId) return
    this.reconnectAttempts += 1
    const exponential = Math.min(30_000, WS_RECONNECT_DELAY_MS * 2 ** Math.min(this.reconnectAttempts, 4))
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectWebSocket()
    }, delay)
  }

  private sendFrame(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  private sendClientHello(): void {
    this.sendFrame({
      type: 'client_hello',
      id: `kimidesk-${Date.now()}`,
      payload: {
        client_id: 'kimidesk-statusbar',
        subscriptions: [this.metrics.sessionId],
        cursors: { [this.metrics.sessionId as string]: { seq: this.lastSeq } },
      },
    })
  }

  /**
   * 订阅 ack：未驻留服务端的旧会话会被放入 resync_required（不接受订阅、无事件回放）。
   * 此时拉一条消息触发服务端加载会话，再重新订阅即可拿到事件回放，
   * 否则旧会话的状态栏一直是 0，要第二次进入才有数据。
   */
  private handleAck(payload: Record<string, unknown>): void {
    const resync = payload.resync_required
    const sessionId = this.metrics.sessionId
    if (!sessionId || !Array.isArray(resync) || !resync.includes(sessionId)) return
    if (this.resyncAttempts >= RESYNC_MAX_ATTEMPTS) {
      log.warn(`[monitor] session ${sessionId} still requires resync after ${RESYNC_MAX_ATTEMPTS} attempts`)
      return
    }
    this.resyncAttempts += 1
    log.info(`[monitor] session ${sessionId} requires resync, triggering server-side load`)
    void this.resyncSession(sessionId)
  }

  private async resyncSession(sessionId: string): Promise<void> {
    try {
      const headers: Record<string, string> = {}
      if (this.token) headers.Authorization = `Bearer ${this.token}`
      // limit=1 即可让服务端把会话加载进内存（事件缓冲），无需拉全量历史
      await fetch(`${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=1`, {
        headers,
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      })
    } catch (error) {
      log.warn('[monitor] resync fetch failed:', error)
    }
    if (!this.disposed && this.metrics.sessionId === sessionId && this.ws?.readyState === WebSocket.OPEN) {
      this.sendClientHello()
    }
  }

  private handleWsMessage(message: WsEvent): void {
    if (message.type === 'server_hello') {
      this.reconnectAttempts = 0
      if (this.metrics.status === 'offline') this.setStatus('idle')
      this.sendClientHello()
      return
    }

    if (message.type === 'ping') {
      const nonce = (message.payload as Record<string, unknown> | undefined)?.nonce
      this.sendFrame({ type: 'pong', payload: { nonce } })
      return
    }

    if (message.type === 'ack') {
      this.handleAck(message.payload ?? {})
      return
    }

    if (message.session_id && message.session_id !== this.metrics.sessionId) return
    if (message.seq != null) {
      const seq = Number(message.seq)
      if (Number.isFinite(seq)) {
        if (seq <= this.lastSeq) return
        this.lastSeq = seq
      }
    }
    const payload = message.payload ?? {}

    // 同一会话的 WS 会广播所有 agent（含子 agent agent-N）的 turn 事件，
    // 只统计主 agent，否则子 agent 的 turn.ended 会覆盖耗时并把状态误置为空闲
    if (message.type.startsWith('turn.') && payload.agentId != null && payload.agentId !== 'main') return

    switch (message.type) {
      case 'turn.started':
        this.setStatus('running')
        break
      case 'turn.step.started':
        this.setStatus('thinking')
        break
      case 'turn.step.completed':
        this.handleStepCompleted(payload)
        // step 间隙通常在执行工具
        this.setStatus('running')
        break
      case 'turn.ended':
      case 'turn.completed':
        this.metrics.lastDuration = toNumber(payload.durationMs ?? payload.duration_ms ?? payload.duration)
        this.setStatus('idle')
        break
      case 'event.session.work_changed':
        this.setStatus(payload.busy || payload.main_turn_active ? 'running' : 'idle')
        break
      case 'agent.status.updated': {
        const status = String(payload.status ?? payload.agent_status ?? '')
        if (status === 'thinking' || status === 'processing') this.setStatus('thinking')
        else if (status === 'running' || status === 'working') this.setStatus('running')
        else if (status === 'idle' || status === 'waiting') this.setStatus('idle')
        break
      }
    }
  }

  private handleStepCompleted(payload: Record<string, unknown>): void {
    const usage = (payload.usage ?? payload.token_usage ?? {}) as Record<string, unknown>
    const input = toNumber(usage.inputOther ?? usage.input_tokens ?? usage.prompt_tokens)
    const output = toNumber(usage.output ?? usage.output_tokens ?? usage.completion_tokens)
    const cacheRead = toNumber(usage.inputCacheRead ?? usage.cache_read_input_tokens ?? usage.cache_read_tokens)
    const cacheCreation = toNumber(usage.inputCacheCreation ?? usage.cache_creation_input_tokens)

    this.metrics.inputTokens += input
    this.metrics.outputTokens += output
    this.metrics.cacheReadTokens += cacheRead
    this.metrics.cacheCreationTokens += cacheCreation

    const streamDuration = toNumber(payload.llmStreamDurationMs ?? payload.duration_ms ?? payload.duration)
    if (streamDuration > 0 && output > 0) {
      this.metrics.lastSpeed = Math.round(output / (streamDuration / 1_000))
    }
    this.emit()
  }

  private disconnectWebSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = 0
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      try {
        ws.close(1000, 'session changed')
      } catch {
        // 忽略关闭异常
      }
    }
  }
}
