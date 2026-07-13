# KimiDesk 开发计划

## 项目概述

基于 **Electron + Vue 3 + TypeScript** 开发一个桌面端 wrapper 应用。核心目标只有一个：

1. 在后台启动 `kimi web` 服务；
2. 自动捕获服务启动后输出的 URL，并在 Electron 窗口中打开；
3. 应用退出前安全关闭 `kimi web` 进程。

参考文档：[Kimi Code CLI - Web UI](https://moonshotai.github.io/kimi-cli/zh/reference/kimi-web.html)

---

## 核心结论（来自文档）

- 启动命令：`kimi web`
- 默认地址：`http://127.0.0.1:5494`
- 端口被占用时会自动尝试 `5494–5503`
- 默认监听 `127.0.0.1`，可配合 `--network` / `--host` 开放外部访问
- 默认会自动打开系统浏览器，可用 `--no-open` 关闭自动打开
- 默认有认证；本地受信任环境可用 `--dangerously-omit-auth` 跳过认证
- 可设置 `--auth-token <token>` 进行 Bearer Token 认证

---

## 技术方案

### 1. 启动 `kimi web`

在主进程（main process）中通过 Node.js 的 `spawn` 启动子进程：

```bash
kimi web --no-open --dangerously-omit-auth
```

参数说明：
- `--no-open`：避免 `kimi web` 自动唤起系统浏览器，由 Electron 窗口承载页面
- `--dangerously-omit-auth`：本地 wrapper 场景下，跳过 Web UI 的认证检查

备选方案（更安全）：
- 生成随机 token，通过 `--auth-token <token>` 启动
- 在 Electron 窗口加载 URL 时通过请求头或 URL 参数带上 token

### 2. 捕获启动 URL

监听子进程的 `stdout` / `stderr`，通过正则匹配 URL，例如：

```ts
const urlRegex = /(https?:\/\/127\.0\.0\.1:\d+)/
```

匹配到 URL 后，通知渲染进程或直接在主进程中调用 `BrowserWindow.loadURL(url)`。

需处理：
- 默认端口 `5494` 被占用时，`kimi web` 会自动尝试下一个端口
- 因此不能写死 `5494`，必须依赖日志输出中的真实地址
- 设置超时机制，若 N 秒内未捕获到 URL，则提示启动失败

### 3. 页面加载与渲染

使用 Electron `BrowserWindow` 加载捕获到的 `kimi web` URL：

```ts
const win = new BrowserWindow({
  width: 1400,
  height: 900,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
  },
})
win.loadURL(capturedUrl)
```

可选：加入启动加载页（splash screen），在 `kimi web` 未就绪前展示状态。

### 4. 退出时关闭 `kimi web`

监听 Electron 的 `before-quit` / `window-all-closed` 事件，在应用退出前主动 kill 子进程。

跨平台处理：
- macOS / Linux：`childProcess.kill('SIGTERM')` 或 `SIGKILL`
- Windows：由于 `spawn` 在 Windows 上可能产生子进程树，需使用 `taskkill /pid ${pid} /T /F`

清理逻辑：
1. 先尝试优雅退出（SIGTERM）
2. 等待一段时间后强制退出（SIGKILL / taskkill /F）
3. 确保进程已终止后再调用 `app.quit()`

### 5. 异常处理

- `kimi` 命令不存在：启动时检测 `kimi` 是否在 PATH 中，给出友好提示
- 端口全部被占用：超时提示用户检查是否有多个实例运行
- 子进程异常退出：弹出错误对话框，允许用户重试或退出
- 应用崩溃/强制退出：尽量通过 `app.on('quit')` 兜底清理子进程

---

## 项目结构

```
KimiDesk/
├── .plan/
│   └── plan.md
├── src/
│   ├── main/
│   │   ├── index.ts              # 主进程入口
│   │   ├── kimi-web.ts           # kimi web 子进程管理
│   │   └── window.ts             # BrowserWindow 创建与管理
│   ├── preload/
│   │   └── index.ts              # preload 脚本（如需要暴露安全 API）
│   └── renderer/
│       ├── main.ts               # Vue 渲染进程入口
│       ├── App.vue               # 根组件
│       └── components/           # 可选：启动页组件
├── electron-builder.json         # 打包配置
├── tsconfig.json
├── vite.config.ts
├── package.json
└── README.md
```

---

## 开发步骤

### 阶段一：项目脚手架

1. 初始化 npm 项目
2. 安装依赖：
   - `electron`
   - `vue`, `@vitejs/plugin-vue`
   - `typescript`, `vite`, `electron-builder`
   - 可选：`electron-vite` 或 `vite-plugin-electron`
3. 配置 TypeScript、Vite、Electron 多入口（main / preload / renderer）

### 阶段二：主进程核心逻辑

1. 实现 `kimi-web.ts`：
   - `startKimiWeb(): Promise<string>` 启动并返回 URL
   - `stopKimiWeb(): Promise<void>` 停止子进程
2. 实现 `window.ts`：创建并管理 BrowserWindow
3. 在 `index.ts` 中串联：
   - app ready → 启动 kimi web → 捕获 URL → 加载窗口
   - before-quit → 停止 kimi web → app.quit()

### 阶段三：渲染进程

1. 创建 Vue 3 应用
2. 实现启动等待页（可选）：展示 "正在启动 Kimi Web..."
3. 主窗口加载 `kimi web` 的 URL

### 阶段四：异常与体验优化

1. 添加错误处理与弹窗
2. 添加日志输出（electron-log 等）
3. 处理 Windows 下子进程残留问题
4. 添加 tray 图标、菜单栏等桌面应用基础能力

### 阶段五：构建与打包

1. 配置 `electron-builder` 或 `electron-forge`
2. 支持 macOS（.dmg / .app）、Windows（.exe / .msi）、Linux（.AppImage / .deb）
3. 验证打包后应用能否正常启动和退出

---

## 关键风险与应对

| 风险 | 应对 |
|------|------|
| `kimi web` 输出格式变化导致 URL 解析失败 | 同时监听 stdout/stderr，使用宽松正则，并支持默认回退地址 |
| Windows 子进程无法彻底关闭 | 使用 `taskkill /T /F` 杀进程树 |
| 认证问题导致页面无法加载 | 本地环境使用 `--dangerously-omit-auth`，或生成 token 注入 |
| 端口占用导致启动慢 | 监听端口切换日志，设置合理超时 |
| 用户未安装 `kimi` CLI | 启动前检查命令是否存在，给出下载/安装提示 |

---

## 验证清单

- [ ] 双击应用后自动启动 `kimi web`
- [ ] 自动在 Electron 窗口中打开 Kimi Web UI
- [ ] 不额外弹出系统浏览器
- [ ] 关闭应用后 `kimi web` 进程被彻底终止
- [ ] 未安装 `kimi` 时给出友好提示
- [ ] 打包后的应用在各目标平台可运行

---

## 下一步

确认本计划后，开始搭建 Electron + Vue 3 + TypeScript 项目脚手架，并实现主进程的 `kimi web` 启动与退出管理。
