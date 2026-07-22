export {}

// 状态栏共享类型：main（采集）、preload（桥接）、renderer（展示）三方共用
export type AgentStatus = 'idle' | 'thinking' | 'running' | 'offline'

export interface SessionMetrics {
  sessionId: string | null
  status: AgentStatus
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 最近一步生成速度 tok/s，0 表示无数据 */
  lastSpeed: number
  /** 上一轮回复总耗时 ms，0 表示无数据 */
  lastDuration: number
}

export interface QuotaState {
  authorized: boolean
  authorizing: boolean
  /** 加油包余额（元），null 表示未知 */
  balance: number | null
  /** 5 小时窗口已用百分比 0-100 */
  fiveHourPct: number | null
  fiveHourResetAt: number | null
  /** 本周额度已用百分比 0-100 */
  weekPct: number | null
  weekResetAt: number | null
}

export interface StatusBarState {
  theme: 'light' | 'dark'
  metrics: SessionMetrics
  quota: QuotaState
}

/** 启动时 kimi code 更新检查的状态（main → splash 页面） */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'updating' | 'done' | 'error'
  current?: string
  latest?: string
  message?: string
}

declare global {
  interface Window {
    electronAPI?: {
      getAppVersion: () => Promise<string>
      onKimiWebError: (callback: (message: string) => void) => void
      getUpdateState: () => Promise<UpdateState>
      onUpdateState: (callback: (state: UpdateState) => void) => void
      confirmUpdate: () => void
      skipUpdate: () => void
    }
    kimiStatusbar?: {
      onState: (callback: (state: StatusBarState) => void) => void
      refresh: () => void
      authorize: () => void
      openQuotaPage: () => void
    }
  }
}
