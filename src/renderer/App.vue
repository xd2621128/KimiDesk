<script setup lang="ts">
import { onMounted, ref } from 'vue'

const error = ref('')
const version = ref('')

onMounted(async () => {
  if (window.electronAPI) {
    version.value = await window.electronAPI.getAppVersion()
    window.electronAPI.onKimiWebError((message) => {
      error.value = message
    })
  }
})
</script>

<template>
  <div class="app">
    <div v-if="error" class="error">
      <h2>启动失败</h2>
      <p>{{ error }}</p>
    </div>
    <div v-else class="loading">
      <img src="../../assets/kimi-logo.svg" class="logo" alt="Kimi" />
      <p>正在启动 Kimi Web...</p>
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
  background: #0d1117;
  color: #e6edf3;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.logo {
  width: 64px;
  height: 44px;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.version {
  font-size: 12px;
  color: #8b949e;
}

.error {
  text-align: center;
  padding: 24px;
}

.error h2 {
  color: #f85149;
}
</style>
