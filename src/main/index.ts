import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import log from 'electron-log/main'
import { appStore } from './store'
import { KimiWebManager } from './kimi-web'
import { SessionMonitor } from './monitor'
import { QuotaManager, QUOTA_PAGE_URL, QUOTA_POLL_INTERVAL_MS } from './quota'
import { createMainWindow, loadSplashScreen, type MainViews } from './window'
import { createTray, destroyTray } from './tray'
import { checkKimiCodeUpdate, runKimiUpgrade } from './updater'
import type { StatusBarState, UpdateState } from '../preload/types'

// Configure logging before anything else
log.initialize()
log.transports.file.level = 'info'

const kimiWeb = new KimiWebManager()
const monitor = new SessionMonitor()
const quota = new QuotaManager()
let views: MainViews | null = null
let authToken: string | undefined
let isQuitting = false
let pageTheme: 'light' | 'dark' = 'dark'
let updateState: UpdateState = { phase: 'idle' }
let relaunching = false

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  log.warn('Another instance is already running, quitting')
  app.quit()
} else {
  app.on('second-instance', () => {
    log.info('Second instance detected, focusing existing window')
    if (views) {
      if (views.window.isMinimized()) views.window.restore()
      views.window.show()
      views.window.focus()
    }
  })
}

function pushStatusBarState(): void {
  if (!views || views.statusbar.webContents.isDestroyed()) return
  const state: StatusBarState = {
    theme: pageTheme,
    metrics: monitor.getMetrics(),
    quota: quota.getState(),
  }
  views.statusbar.webContents.send('monitor:state', state)
}

function setUpdateState(state: UpdateState): void {
  updateState = state
  if (!views || views.content.webContents.isDestroyed()) return
  views.content.webContents.send('update:state', state)
}

/** 等待 splash 页面上的用户选择（立即更新 / 暂不更新） */
function waitUpdateChoice(): Promise<'update' | 'skip'> {
  return new Promise((resolve) => {
    const cleanup = () => {
      ipcMain.removeListener('update:confirm', onConfirm)
      ipcMain.removeListener('update:skip', onSkip)
    }
    const onConfirm = (event: Electron.IpcMainEvent) => {
      if (event.sender !== views?.content.webContents) return
      cleanup()
      resolve('update')
    }
    const onSkip = (event: Electron.IpcMainEvent) => {
      if (event.sender !== views?.content.webContents) return
      cleanup()
      resolve('skip')
    }
    ipcMain.on('update:confirm', onConfirm)
    ipcMain.on('update:skip', onSkip)
  })
}

/**
 * 启动时检查 kimi code 更新。有更新且用户确认时执行 `kimi upgrade`，
 * 成功后 relaunch 应用；检查失败/无更新/用户跳过都静默返回继续启动。
 */
async function maybeUpdateKimiCode(): Promise<void> {
  setUpdateState({ phase: 'checking' })
  const result = await checkKimiCodeUpdate()
  if (result.status !== 'available') {
    setUpdateState({ phase: 'idle' })
    return
  }

  const { current, latest } = result
  if (!current || !latest) {
    setUpdateState({ phase: 'idle' })
    return
  }
  setUpdateState({ phase: 'available', current, latest })
  let choice = await waitUpdateChoice()

  while (choice === 'update') {
    setUpdateState({ phase: 'updating', current, latest })
    try {
      await runKimiUpgrade(latest)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('[update] upgrade failed:', message)
      setUpdateState({ phase: 'error', message, current, latest })
      choice = await waitUpdateChoice()
      continue
    }

    log.info('[update] upgrade succeeded, relaunching')
    setUpdateState({ phase: 'done' })
    relaunching = true
    // 稍等片刻让用户看到「更新完成」提示；app.exit 不触发 before-quit
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 800)
    return
  }

  setUpdateState({ phase: 'idle' })
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

function setupStatusBarIpc(): void {
  monitor.onUpdate(pushStatusBarState)
  quota.onUpdate(pushStatusBarState)

  ipcMain.on('monitor:page-theme', (event, theme) => {
    if (event.sender !== views?.content.webContents) return
    const next = theme === 'light' ? 'light' : 'dark'
    if (next !== pageTheme) {
      pageTheme = next
      pushStatusBarState()
    }
  })

  // 页面侧轮询上报的 URL 变化（history.replaceState 不触发 did-navigate-in-page，
  // 见 preload/index.ts 的 setupUrlReporter）
  ipcMain.on('monitor:page-url', (event, url) => {
    if (event.sender !== views?.content.webContents) return
    if (typeof url !== 'string') return
    monitor.handleNavigate(url, true)
  })

  ipcMain.on('monitor:refresh', () => {
    monitor.refresh()
    quota.refresh().catch((error) => log.warn('[quota] refresh failed:', error))
  })

  ipcMain.on('monitor:authorize', () => {
    quota.authorize().catch((error) => log.warn('[quota] authorize failed:', error))
  })

  ipcMain.on('monitor:open-quota-page', () => {
    void shell.openExternal(QUOTA_PAGE_URL)
  })

}

async function startApp(): Promise<void> {
  views = createMainWindow(appStore.getWindowState())
  const { window: mainWindow, content, statusbar } = views
  createTray(mainWindow)
  setupNotificationHandling()

  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault()
      saveWindowState(mainWindow)
      mainWindow.hide()
    } else {
      saveWindowState(mainWindow)
    }
  })

  mainWindow.on('moved', () => saveWindowState(mainWindow))
  mainWindow.on('resized', () => saveWindowState(mainWindow))

  // 跟踪 kimi web 页面（SPA）路由变化，定位当前会话
  const trackNavigation = () => monitor.handleNavigate(content.webContents.getURL())
  content.webContents.on('did-navigate', trackNavigation)
  content.webContents.on('did-navigate-in-page', (_event, url) => monitor.handleNavigate(url, true))

  statusbar.webContents.on('did-finish-load', pushStatusBarState)

  await loadSplashScreen(views)
  mainWindow.show()

  // 先检查 kimi code 更新；若触发升级重启则不再继续启动
  await maybeUpdateKimiCode()
  if (relaunching) return

  try {
    const { url, token } = await kimiWeb.start()
    log.info(`[main] kimi web ready: ${url}`)
    authToken = token
    setupAuthHeader()
    monitor.configure(url, token)

    await content.webContents.loadURL(url)
    trackNavigation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('[main] failed to start kimi web:', message)
    dialog.showErrorBox('KimiDesk 启动失败', message)
    content.webContents.send('kimi-web-error', message)
  }
}

app.whenReady().then(() => {
  setupStatusBarIpc()
  void startApp()
  quota.init().catch((error) => log.warn('[quota] init failed:', error))
  setInterval(() => {
    quota.refresh().catch((error) => log.warn('[quota] poll failed:', error))
  }, QUOTA_POLL_INTERVAL_MS)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void startApp()
  } else {
    views?.window.show()
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
  monitor.dispose()
  quota.dispose()
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

// splash 挂载时拉取一次，消除 update:state 推送的时序竞争
ipcMain.handle('update:get-state', () => updateState)
