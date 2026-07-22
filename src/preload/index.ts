import { contextBridge, ipcRenderer } from 'electron'
import type { UpdateState } from './types'

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onKimiWebError: (callback: (message: string) => void) => {
    ipcRenderer.on('kimi-web-error', (_, message) => callback(message))
  },
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  onUpdateState: (callback: (state: UpdateState) => void) => {
    ipcRenderer.on('update:state', (_, state) => callback(state))
  },
  confirmUpdate: () => ipcRenderer.send('update:confirm'),
  skipUpdate: () => ipcRenderer.send('update:skip'),
})

// kimi web 主题上报：页面通过 document.documentElement.dataset.colorScheme
// （light / dark / system，见 kimi web 的 /boot.js）+ prefers-color-scheme 决定明暗，
// 状态栏需要跟随页面主题。
function setupThemeReporter(): void {
  if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return

  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const report = () => {
    const scheme = document.documentElement.dataset.colorScheme
    const dark = scheme === 'dark' || (scheme !== 'light' && media.matches)
    ipcRenderer.send('monitor:page-theme', dark ? 'dark' : 'light')
  }

  new MutationObserver(report).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-color-scheme'],
  })
  media.addEventListener('change', report)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report, { once: true })
  } else {
    report()
  }
}

setupThemeReporter()

// kimi web URL 变化上报：首次点开旧会话时 kimi web 用 history.replaceState
// 更新 URL，Chromium 不会为此触发 did-navigate-in-page（第二次点击走
// pushState 才触发），导致主进程跟踪不到会话切换。这里从页面侧轮询
// location.href，任何方式（push/replace/popstate）的 URL 变化都能捕获。
function setupUrlReporter(): void {
  if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return

  let lastUrl = location.href
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      ipcRenderer.send('monitor:page-url', lastUrl)
    }
  }, 500)
}

setupUrlReporter()
