import { BrowserWindow } from 'electron'
import { join } from 'node:path'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
}

export function createMainWindow(state: WindowState): BrowserWindow {
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 600,
    title: 'KimiDesk',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setMenuBarVisibility(false)

  return win
}

export function loadSplashScreen(window: BrowserWindow): Promise<void> {
  const splashPath = join(__dirname, '../renderer/index.html')
  return window.loadFile(splashPath)
}
