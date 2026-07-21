import { contextBridge, ipcRenderer } from 'electron'
import type { StatusBarState } from './types'

contextBridge.exposeInMainWorld('kimiStatusbar', {
  onState: (callback: (state: StatusBarState) => void) => {
    ipcRenderer.on('monitor:state', (_event, state) => callback(state))
  },
  refresh: () => ipcRenderer.send('monitor:refresh'),
  authorize: () => ipcRenderer.send('monitor:authorize'),
  openQuotaPage: () => ipcRenderer.send('monitor:open-quota-page'),
})
