import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import { join } from 'node:path'
import { KimiWebManager } from './kimi-web'
import { createMainWindow } from './window'
import { createTray, destroyTray } from './tray'

const kimiWeb = new KimiWebManager()
let mainWindow: BrowserWindow | null = null
let authToken: string | undefined

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
  // Auto-grant notification permission for Kimi Web
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'notifications') {
      callback(true)
    } else {
      callback(false)
    }
  })

  // Focus window when notification is clicked
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

async function startApp(): Promise<void> {
  mainWindow = createMainWindow()
  createTray(mainWindow)
  setupNotificationHandling()

  try {
    const { url, token } = await kimiWeb.start()
    console.log(`[main] kimi web ready: ${url}`)
    authToken = token
    setupAuthHeader()

    await mainWindow.loadURL(url)
  } catch (error) {
    console.error('[main] failed to start kimi web:', error)
    if (mainWindow) {
      mainWindow.webContents.send(
        'kimi-web-error',
        error instanceof Error ? error.message : String(error),
      )
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
    mainWindow = createMainWindow()
  }
})

app.on('before-quit', async (event) => {
  event.preventDefault()
  await cleanupAndExit()
})

// Also handle SIGTERM/SIGINT for graceful shutdown when run from terminal
process.on('SIGTERM', async () => {
  await cleanupAndExit()
})

process.on('SIGINT', async () => {
  await cleanupAndExit()
})

async function cleanupAndExit(): Promise<void> {
  destroyTray()
  await kimiWeb.stop()
  app.exit(0)
}

// Open external links in system browser
app.on('web-contents-created', (_, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
})

ipcMain.handle('get-app-version', () => app.getVersion())
