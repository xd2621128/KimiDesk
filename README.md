# KimiDesk

Kimi Code Web UI 的桌面端 wrapper，基于 Electron + Vue 3 + TypeScript。

## 功能

- 启动 `kimi web` 后台服务
- 在 Electron 窗口中加载 Kimi Web UI
- 自动读取 token 并注入 Authorization 请求头，无需手动认证
- macOS 状态栏图标支持（显示/隐藏窗口、右键退出）
- 支持系统通知，点击通知可聚焦窗口
- 退出应用时自动关闭由本应用启动的 `kimi web` 服务
- 若系统已有 `kimi web` 在运行，直接复用，不会重复启动

## 技术栈

- Electron 43
- Vue 3
- TypeScript 7
- Vite 8
- pnpm

## 环境要求

- Node.js 22+
- pnpm
- macOS / Windows / Linux（当前主要适配 macOS）

## 安装依赖

```bash
pnpm install
```

## 开发

```bash
pnpm run dev
```

启动后会自动打开 Electron 窗口并加载 Kimi Web UI。

## 构建

```bash
pnpm run build
```

## 打包

```bash
pnpm run dist
```

打包产物位于 `release/` 目录：

- macOS: `release/mac-arm64/KimiDesk.app`、`release/KimiDesk-1.0.0-arm64.dmg`
- Windows: `release/win-unpacked/`、`release/KimiDesk-1.0.0.exe`
- Linux: `release/linux-unpacked/`、`release/KimiDesk-1.0.0.AppImage`

## 项目结构

```
KimiDesk/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── index.ts       # 入口
│   │   ├── kimi-web.ts    # kimi web 服务管理
│   │   ├── window.ts      # BrowserWindow 创建
│   │   └── tray.ts        # 状态栏图标
│   ├── preload/           # preload 脚本
│   └── renderer/          # Vue 3 渲染进程
├── assets/                # 图标、图片资源
├── build/                 # 应用图标（electron-builder 使用）
├── dist/                  # 编译输出
├── release/               # 打包输出
├── .plan/                 # 开发计划
├── package.json
├── vite.config.ts
├── tsconfig*.json
└── electron-builder.json
```

## 图标

- SVG 源文件：`assets/kimi-logo.svg`
- 应用图标：`build/icon.png`
- 状态栏图标：`assets/trayTemplate.png`、`assets/trayTemplate@2x.png`

## 注意事项

- `kimi web` 默认端口为 `58627`，若被占用会复用已有服务。
- 应用退出时只会关闭由本应用启动的 `kimi web` 进程；复用已有服务时不会关闭它。
- macOS 首次运行需要在「系统设置 → 通知」中允许 KimiDesk 发送通知。

## 许可证

ISC
