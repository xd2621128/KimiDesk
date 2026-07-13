<script setup lang="ts">
import { onMounted, ref } from 'vue'

const error = ref('')
const version = ref('')
const status = ref('正在启动 Kimi Web...')

onMounted(async () => {
  if (window.electronAPI) {
    version.value = await window.electronAPI.getAppVersion()
    window.electronAPI.onKimiWebError((message) => {
      error.value = message
      status.value = '启动失败'
    })
  }
})
</script>

<template>
  <div class="app">
    <div v-if="error" class="error-panel">
      <div class="error-icon">⚠</div>
      <h2>启动失败</h2>
      <p>{{ error }}</p>
    </div>

    <div v-else class="splash">
      <div class="logo-wrap">
        <img src="../../assets/kimi-logo.svg" class="logo" alt="Kimi" />
      </div>
      <div class="spinner"></div>
      <p class="status">{{ status }}</p>
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
  background: radial-gradient(circle at 50% 30%, #161b22 0%, #0d1117 60%);
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.splash {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  animation: fadeIn 0.4s ease-out;
}

.logo-wrap {
  padding: 24px;
  border-radius: 24px;
  background: rgba(88, 166, 255, 0.08);
  box-shadow: 0 0 60px rgba(88, 166, 255, 0.12);
}

.logo {
  width: 80px;
  height: 56px;
  display: block;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(88, 166, 255, 0.2);
  border-top-color: #58a6ff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.status {
  font-size: 15px;
  color: #c9d1d9;
  margin: 0;
}

.version {
  font-size: 12px;
  color: #8b949e;
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

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
