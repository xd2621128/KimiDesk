import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onKimiWebError: (callback: (message: string) => void) => {
    ipcRenderer.on('kimi-web-error', (_, message) => callback(message))
  },
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
