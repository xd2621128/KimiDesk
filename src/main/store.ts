import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
}

interface AppStore {
  windowState: WindowState
}

const defaultStore: AppStore = {
  windowState: { width: 1400, height: 900 },
}

function getStorePath(): string {
  return join(homedir(), 'Library', 'Application Support', 'kimidesk', 'config.json')
}

function loadStore(): AppStore {
  try {
    const raw = readFileSync(getStorePath(), 'utf-8')
    return { ...defaultStore, ...JSON.parse(raw) }
  } catch {
    return defaultStore
  }
}

function saveStore(store: AppStore): void {
  try {
    writeFileSync(getStorePath(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    // Ignore save errors
  }
}

export const appStore = {
  getWindowState(): WindowState {
    return loadStore().windowState
  },
  setWindowState(state: WindowState): void {
    saveStore({ windowState: state })
  },
}
