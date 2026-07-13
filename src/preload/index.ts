import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  onKimiWebError: (callback: (message: string) => void) => {
    ipcRenderer.on('kimi-web-error', (_, message) => callback(message))
  },
})
