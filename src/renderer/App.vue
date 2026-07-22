<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { UpdateState } from '@/preload/types'

const error = ref('')
const version = ref('')
const update = ref<UpdateState>({ phase: 'idle' })

const status = computed(() => {
  if (error.value) return '启动失败'
  switch (update.value.phase) {
    case 'checking':
      return '正在检查 Kimi Code 更新…'
    case 'updating':
      return '正在更新 Kimi Code，请稍候…'
    case 'done':
      return '更新完成，正在重启应用…'
    default:
      return '正在启动 Kimi Web...'
  }
})

/** 更新流程相关界面是否取代普通状态行 */
const showUpdatePanel = computed(() =>
  ['available', 'updating', 'done', 'error'].includes(update.value.phase),
)

onMounted(async () => {
  if (window.electronAPI) {
    version.value = await window.electronAPI.getAppVersion()
    window.electronAPI.onKimiWebError((message) => {
      error.value = message
    })
    update.value = await window.electronAPI.getUpdateState()
    window.electronAPI.onUpdateState((state) => {
      update.value = state
    })
  }
})

function confirmUpdate() {
  window.electronAPI?.confirmUpdate()
}

function skipUpdate() {
  window.electronAPI?.skipUpdate()
}
</script>

<template>
  <div class="app">
    <div v-if="error" class="error-panel">
      <div class="error-icon">⚠</div>
      <h2>启动失败</h2>
      <p>{{ error }}</p>
    </div>

    <div v-else class="splash">
      <div class="logo-glow">
        <svg
          class="logo"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Kimi Code"
        >
          <defs>
            <mask id="kimiEyes" maskUnits="userSpaceOnUse">
              <rect x="0" y="5" width="32" height="22" fill="#fff"/>
              <g class="ch-eyes" fill="#000">
                <rect class="ch-eye" x="11.8" y="12" width="2.8" height="8" rx="1.4"/>
                <rect class="ch-eye" x="17.4" y="12" width="2.8" height="8" rx="1.4"/>
              </g>
            </mask>
          </defs>
          <rect x="1" y="6" width="30" height="20" rx="6" fill="#58a6ff" mask="url(#kimiEyes)"/>
        </svg>
      </div>

      <div v-if="showUpdatePanel" class="update-panel">
        <template v-if="update.phase === 'available'">
          <h2 class="update-title">发现 Kimi Code 新版本</h2>
          <p class="update-versions">v{{ update.current }} → v{{ update.latest }}</p>
          <div class="update-actions">
            <button class="btn primary" @click="confirmUpdate">立即更新并重启</button>
            <button class="btn ghost" @click="skipUpdate">暂不更新</button>
          </div>
        </template>

        <template v-else-if="update.phase === 'error'">
          <h2 class="update-title failed">更新失败</h2>
          <p class="update-message">{{ update.message }}</p>
          <div class="update-actions">
            <button class="btn primary" @click="confirmUpdate">重试</button>
            <button class="btn ghost" @click="skipUpdate">暂不更新</button>
          </div>
        </template>

        <template v-else>
          <div class="update-working">
            <span v-if="update.phase === 'updating'" class="spinner"></span>
            <p class="status">{{ status }}</p>
          </div>
        </template>
      </div>

      <p v-else class="status">{{ status }}</p>

      <span v-if="version" class="version">KimiDesk v{{ version }}</span>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: radial-gradient(circle at 50% 35%, #1a2332 0%, #0d1117 55%);
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.splash {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
  animation: fadeIn 0.5s ease-out;
}

.logo-glow {
  padding: 40px;
  border-radius: 36px;
  background: rgba(88, 166, 255, 0.06);
  box-shadow:
    0 0 80px rgba(88, 166, 255, 0.15),
    inset 0 0 60px rgba(88, 166, 255, 0.04);
}

.logo {
  width: 120px;
  height: 84px;
  display: block;
}

.ch-eyes {
  animation: kimi-eye-look 16s ease-in-out infinite;
}

.ch-eye {
  transform-box: fill-box;
  transform-origin: center;
  animation: kimi-eye-blink 11s ease-in-out infinite;
}

@keyframes kimi-eye-look {
  0%, 42% { transform: translate(0); }
  84%, 90% { transform: translate(-2px); }
  95%, 100% { transform: translate(0); }
}

@keyframes kimi-eye-blink {
  0%, 94%, 100% { transform: scaleY(1); }
  96.5%, 98% { transform: scaleY(0.12); }
}

.status {
  font-size: 16px;
  color: #c9d1d9;
  margin: 0;
  letter-spacing: 0.02em;
}

.version {
  font-size: 12px;
  color: #8b949e;
}

.update-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 420px;
  text-align: center;
  animation: fadeIn 0.3s ease-out;
}

.update-title {
  margin: 0;
  font-size: 20px;
  color: #e6edf3;
}

.update-title.failed {
  color: #f85149;
}

.update-versions {
  margin: 0;
  font-size: 15px;
  color: #58a6ff;
  font-variant-numeric: tabular-nums;
}

.update-message {
  margin: 0;
  font-size: 13px;
  color: #8b949e;
  line-height: 1.6;
  word-break: break-word;
  max-height: 96px;
  overflow: hidden;
}

.update-actions {
  display: flex;
  gap: 12px;
  margin-top: 6px;
}

.btn {
  padding: 8px 20px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.btn.primary {
  background: #58a6ff;
  color: #0d1117;
  font-weight: 600;
}

.btn.primary:hover {
  background: #79b8ff;
}

.btn.ghost {
  background: transparent;
  color: #8b949e;
  border-color: #30363d;
}

.btn.ghost:hover {
  color: #c9d1d9;
  border-color: #8b949e;
}

.update-working {
  display: flex;
  align-items: center;
  gap: 12px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(88, 166, 255, 0.25);
  border-top-color: #58a6ff;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-panel {
  text-align: center;
  padding: 32px;
  max-width: 420px;
  animation: fadeIn 0.3s ease-out;
}

.error-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.error-panel h2 {
  color: #f85149;
  margin: 0 0 12px;
  font-size: 20px;
}

.error-panel p {
  color: #c9d1d9;
  line-height: 1.6;
  margin: 0;
  word-break: break-word;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .ch-eyes,
  .ch-eye,
  .splash,
  .update-panel {
    animation: none;
  }
}
</style>
