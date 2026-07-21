import log from 'electron-log/main'
import type { AgentStatus, SessionMetrics } from '../preload/types'

const WS_RECONNECT_DELAY_MS = 3_000
const SNAPSHOT_TIMEOUT_MS = 15_000
const SESSION_URL_REGEX = /^\/sessions\/([^/?#]+)/

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
  private lastSeq = 0
  private snapshotRequestId = 0
  private disposed = false

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
  }

  /** 页面导航（含 SPA 内跳转）时调用，跟踪当前会话 */
  handleNavigate(url: string): void {
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
    this.disconnectWebSocket()
  }

  private emit(): void {
    this.listener?.({ ...this.metrics })
  }

  private setStatus(status: AgentStatus): void {
    this.metrics.status = status
    this.emit()
  }

  private startSession(sessionId: string | null): void {
    this.snapshotRequestId += 1
    this.disconnectWebSocket()
    this.metrics = emptyMetrics()
    this.metrics.sessionId = sessionId
    this.lastSeq = 0
    this.emit()

    if (!sessionId || !this.baseUrl) return
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

  private handleWsMessage(message: WsEvent): void {
    if (message.type === 'server_hello') {
      this.reconnectAttempts = 0
      if (this.metrics.status === 'offline') this.setStatus('idle')
      this.sendFrame({
        type: 'client_hello',
        id: `kimidesk-${Date.now()}`,
        payload: {
          client_id: 'kimidesk-statusbar',
          subscriptions: [this.metrics.sessionId],
          cursors: { [this.metrics.sessionId as string]: { seq: this.lastSeq } },
        },
      })
      return
    }

    if (message.type === 'ping') {
      const nonce = (message.payload as Record<string, unknown> | undefined)?.nonce
      this.sendFrame({ type: 'pong', payload: { nonce } })
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
