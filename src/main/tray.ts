import { app, Menu, Tray, type BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'

let tray: Tray | null = null

export function createTray(window: BrowserWindow): void {
  if (tray) return

  const iconPath = join(__dirname, '../../assets', 'trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('KimiDesk')

  tray.on('click', () => {
    if (window.isVisible()) {
      window.hide()
    } else {
      window.show()
      window.focus()
    }
  })

  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏',
        click: () => {
          if (window.isVisible()) {
            window.hide()
          } else {
            window.show()
            window.focus()
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => app.quit(),
      },
    ])
    tray?.popUpContextMenu(contextMenu)
  })
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
