import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'node:path'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
}

export interface MainViews {
  window: BrowserWindow
  /** kimi web 内容区（启动时先显示 splash） */
  content: WebContentsView
  /** 底部状态栏 */
  statusbar: WebContentsView
}

export const STATUSBAR_HEIGHT = 30

export function createMainWindow(state: WindowState): MainViews {
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
  })

  const content = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  content.setBackgroundColor('#0d1117')

  const statusbar = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/statusbar.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  statusbar.setBackgroundColor('#161b22')

  win.contentView.addChildView(content)
  win.contentView.addChildView(statusbar)

  const layout = () => {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    content.setBounds({ x: 0, y: 0, width, height: Math.max(0, height - STATUSBAR_HEIGHT) })
    statusbar.setBounds({ x: 0, y: Math.max(0, height - STATUSBAR_HEIGHT), width, height: STATUSBAR_HEIGHT })
  }
  layout()
  win.on('resize', layout)

  void statusbar.webContents.loadFile(join(__dirname, '../renderer/statusbar.html'))

  win.setMenuBarVisibility(false)

  return { window: win, content, statusbar }
}

export function loadSplashScreen(views: MainViews): Promise<void> {
  const splashPath = join(__dirname, '../renderer/index.html')
  return views.content.webContents.loadFile(splashPath)
}
