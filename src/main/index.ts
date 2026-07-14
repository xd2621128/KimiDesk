import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import log from 'electron-log/main'
import { join } from 'node:path'
import { appStore } from './store'
import { KimiWebManager } from './kimi-web'
import { createMainWindow, loadSplashScreen, type WindowState } from './window'
import { createTray, destroyTray } from './tray'

// Configure logging before anything else
log.initialize()
log.transports.file.level = 'info'

const kimiWeb = new KimiWebManager()
let mainWindow: BrowserWindow | null = null
let authToken: string | undefined
let isQuitting = false

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  log.warn('Another instance is already running, quitting')
  app.quit()
} else {
  app.on('second-instance', () => {
    log.info('Second instance detected, focusing existing window')
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function setupAuthHeader(): void {
  if (!authToken) return

  const filter = { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*', 'ws://127.0.0.1:*/*', 'ws://localhost:*/*'] }

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const existing = details.requestHeaders.Authorization ?? details.requestHeaders.authorization
    if (!existing) {
      details.requestHeaders.Authorization = `Bearer ${authToken}`
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

function setupNotificationHandling(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'notifications') {
      callback(true)
    } else {
      callback(false)
    }
  })

  app.on('web-contents-created', (_, wc) => {
    wc.on('notification-click' as never, () => {
      const win = BrowserWindow.fromWebContents(wc)
      if (win) {
        win.show()
        win.focus()
      }
    })
  })
}

function saveWindowState(window: BrowserWindow): void {
  const bounds = window.getBounds()
  appStore.setWindowState({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
  })
}

async function startApp(): Promise<void> {
  const windowState = appStore.getWindowState()
  mainWindow = createMainWindow(windowState)
  createTray(mainWindow)
  setupNotificationHandling()

  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault()
      saveWindowState(mainWindow!)
      mainWindow?.hide()
    } else {
      saveWindowState(mainWindow!)
    }
  })

  mainWindow.on('moved', () => saveWindowState(mainWindow!))
  mainWindow.on('resized', () => saveWindowState(mainWindow!))

  await loadSplashScreen(mainWindow)
  mainWindow.show()

  try {
    const { url, token } = await kimiWeb.start()
    log.info(`[main] kimi web ready: ${url}`)
    authToken = token
    setupAuthHeader()

    await mainWindow.loadURL(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('[main] failed to start kimi web:', message)
    dialog.showErrorBox('KimiDesk 启动失败', message)
    if (mainWindow) {
      mainWindow.webContents.send('kimi-web-error', message)
    }
  }
}

app.whenReady().then(startApp)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow(appStore.getWindowState())
  } else {
    mainWindow?.show()
  }
})

app.on('before-quit', (event) => {
  event.preventDefault()
  isQuitting = true
  cleanupAndExit()
})

process.on('SIGTERM', () => {
  isQuitting = true
  cleanupAndExit()
})

process.on('SIGINT', () => {
  isQuitting = true
  cleanupAndExit()
})

async function cleanupAndExit(): Promise<void> {
  destroyTray()
  await kimiWeb.stop()
  app.exit(0)
}

app.on('web-contents-created', (_, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
})

ipcMain.handle('get-app-version', () => app.getVersion())
