<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { StatusBarState } from '@/preload/types'

const state = reactive<StatusBarState>({
  theme: 'dark',
  metrics: {
    sessionId: null,
    status: 'offline',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    lastSpeed: 0,
    lastDuration: 0,
  },
  quota: {
    authorized: false,
    authorizing: false,
    balance: null,
    fiveHourPct: null,
    fiveHourResetAt: null,
    weekPct: null,
    weekResetAt: null,
  },
})

onMounted(() => {
  window.kimiStatusbar?.onState((next) => {
    Object.assign(state, next)
  })
})

// 额度重置倒计时需要定时刷新显示
const now = ref(Date.now())
let tickTimer: number | undefined
onMounted(() => {
  tickTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onUnmounted(() => {
  if (tickTimer) window.clearInterval(tickTimer)
})

const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  thinking: '思考中',
  running: '运行中',
  offline: '未连接',
}

const statusText = computed(() => STATUS_TEXT[state.metrics.status] ?? state.metrics.status)

const cachePct = computed(() => {
  const m = state.metrics
  const totalInput = m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens
  return totalInput > 0 ? `${Math.round((m.cacheReadTokens / totalInput) * 100)}%` : '--'
})

const perfText = computed(() => {
  const m = state.metrics
  const parts: string[] = []
  parts.push(m.lastSpeed > 0 ? `${m.lastSpeed} tok/s` : '--')
  if (m.lastDuration > 0) parts.push(`上轮 ${fmtDuration(m.lastDuration)}`)
  return parts.join(' · ')
})

function fmtNum(value: number): string {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

function clampPct(pct: number | null): number {
  return Math.max(0, Math.min(100, Math.round(pct ?? 0)))
}

function progressClass(pct: number | null): string {
  const p = clampPct(pct)
  if (p >= 80) return 'high'
  if (p >= 50) return 'mid'
  return 'low'
}

/** hover 时显示在百分比位置上的倒计时 */
function hoverResetText(resetAt: number | null): string {
  if (!resetAt) return ''
  const diff = resetAt - now.value
  const totalMin = Math.floor(diff / 60_000)
  if (totalMin < 1) return '即将'
  const hours = Math.floor(totalMin / 60)
  if (hours < 1) return `${totalMin}m后`
  const days = Math.floor(hours / 24)
  if (days >= 1) return `${days}d后`
  return `${hours}h后`
}

const hoveredKey = ref<'5h' | 'week' | null>(null)

const balanceText = computed(() => {
  const b = state.quota.balance
  return b == null ? '余额 --' : `¥${b.toFixed(2)}`
})

function refresh() {
  window.kimiStatusbar?.refresh()
}

function authorize() {
  window.kimiStatusbar?.authorize()
}

function openQuotaPage() {
  window.kimiStatusbar?.openQuotaPage()
}
</script>

<template>
  <div class="sb" :class="state.theme">
    <div class="group status" title="点击重置并重新拉取数据" @click="refresh">
      <span class="led" :class="state.metrics.status"></span>
      <span class="status-text">{{ statusText }}</span>
    </div>
    <div class="sep"></div>

    <template v-if="state.metrics.sessionId">
      <div class="group hide-sm">
        <span>输入</span>
        <span class="num">{{ fmtNum(state.metrics.inputTokens) }}</span>
      </div>
      <div class="group hide-sm">
        <span>输出</span>
        <span class="num">{{ fmtNum(state.metrics.outputTokens) }}</span>
      </div>
      <div class="group hide-md">
        <span>缓存命中</span>
        <span class="num accent">{{ cachePct }}</span>
      </div>
      <div class="sep hide-md"></div>
      <div class="group hide-lg">
        <span class="num">{{ perfText }}</span>
      </div>
    </template>
    <div v-else class="group dim">无会话</div>

    <div class="spacer"></div>

    <template v-if="state.quota.authorized">
      <div class="group quota" @mouseenter="hoveredKey = '5h'" @mouseleave="hoveredKey = null">
        <span>5h</span>
        <span class="bar"><i :class="progressClass(state.quota.fiveHourPct)" :style="{ width: clampPct(state.quota.fiveHourPct) + '%' }"></i></span>
        <span class="num pct">{{ hoveredKey === '5h' ? hoverResetText(state.quota.fiveHourResetAt) : (state.quota.fiveHourPct == null ? '--' : clampPct(state.quota.fiveHourPct) + '%') }}</span>
      </div>
      <div class="group quota" @mouseenter="hoveredKey = 'week'" @mouseleave="hoveredKey = null">
        <span>本周</span>
        <span class="bar"><i :class="progressClass(state.quota.weekPct)" :style="{ width: clampPct(state.quota.weekPct) + '%' }"></i></span>
        <span class="num pct">{{ hoveredKey === 'week' ? hoverResetText(state.quota.weekResetAt) : (state.quota.weekPct == null ? '--' : clampPct(state.quota.weekPct) + '%') }}</span>
      </div>
    </template>
    <div v-else class="group auth" :class="{ working: state.quota.authorizing }" title="授权后显示额度与余额" @click="authorize">
      {{ state.quota.authorizing ? '授权中…' : '点击授权额度查询' }}
    </div>

    <div class="sep"></div>
    <div class="group balance" title="查看 / 充值额度" @click="openQuotaPage">{{ balanceText }}</div>
  </div>
</template>

<style>
html,
body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}
</style>

<style scoped>
.sb {
  --bg: #f6f8fa;
  --border: #d0d7de;
  --text: #57606a;
  --num: #1f2328;
  --dim: #8c959f;
  --accent: #0969da;
  --green: #1a7f37;
  --amber: #9a6700;
  --red: #cf222e;
  --track: #d8dee4;

  height: 100vh;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Segoe UI', sans-serif;
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border-top: 1px solid var(--border);
  user-select: none;
  white-space: nowrap;
}

.sb.dark {
  --bg: #161b22;
  --border: #30363d;
  --text: #8b949e;
  --num: #c9d1d9;
  --dim: #6e7681;
  --accent: #58a6ff;
  --green: #3fb950;
  --amber: #d29922;
  --red: #f85149;
  --track: #30363d;
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.num {
  color: var(--num);
  font-variant-numeric: tabular-nums;
}

.accent {
  color: var(--accent);
}

.dim {
  color: var(--dim);
}

.num.pct {
  text-align: right;
}

.sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  flex: none;
}

.spacer {
  flex: 1;
}

.status {
  cursor: pointer;
}

.led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dim);
  flex: none;
}

.led.thinking {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}

.led.running {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}

.led.offline {
  background: var(--red);
}

.status-text {
  color: var(--num);
}

.bar {
  width: 56px;
  height: 4px;
  border-radius: 2px;
  background: var(--track);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.bar i.low {
  background: var(--green);
}

.bar i.mid {
  background: var(--amber);
}

.bar i.high {
  background: var(--red);
}

.auth {
  color: var(--accent);
  cursor: pointer;
}

.auth.working {
  color: var(--dim);
  cursor: default;
}

.balance {
  color: var(--green);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

@media (max-width: 1100px) {
  .hide-lg {
    display: none;
  }
}

@media (max-width: 900px) {
  .hide-md {
    display: none;
  }
}

@media (max-width: 820px) {
  .hide-sm {
    display: none;
  }
}
</style>
