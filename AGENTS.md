# KimiDesk 项目指南

本文件供 AI Agent 协作使用，说明项目结构、开发流程和关键实现细节。

## 项目简介

KimiDesk 是 Kimi Code Web UI（`kimi web`）的桌面端 wrapper。核心目标：

1. 启动 `kimi web` 服务；
2. 在 Electron 窗口中加载 Kimi Web UI；
3. 退出时安全关闭由本应用启动的 `kimi web`；
4. 自动处理认证 token，无需用户手动输入。

## 技术栈

- Electron 43
- Vue 3 + TypeScript
- Vite 8
- pnpm
- electron-builder

## 常用命令

```bash
# 安装依赖
pnpm install

# 开发运行
pnpm run dev

# 构建（renderer / preload / main）
pnpm run build

# 打包应用
pnpm run dist

# 单独构建各进程
pnpm run build:renderer
pnpm run build:preload
pnpm run build:main
```

## 项目结构

```
KimiDesk/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── index.ts       # 主进程入口
│   │   ├── kimi-web.ts    # kimi web 子进程管理（启动/停止/token/复用）
│   │   ├── monitor.ts     # 当前会话指标采集（REST 快照 + WebSocket 订阅）
│   │   ├── quota.ts       # 额度/加油包余额（Device OAuth + usages API）
│   │   ├── updater.ts     # 启动时 kimi code 更新检查与升级
│   │   ├── window.ts      # BrowserWindow + 双 WebContentsView 布局
│   │   └── tray.ts        # macOS 状态栏图标
│   ├── preload/           # 安全桥接脚本
│   │   ├── index.ts       # kimi web 页面桥接 + 主题上报
│   │   ├── statusbar.ts   # 状态栏页面桥接
│   │   └── types.d.ts     # 共享类型（SessionMetrics / QuotaState / StatusBarState / UpdateState）
│   └── renderer/          # Vue 3 渲染进程
│       ├── main.ts
│       ├── App.vue
│       ├── index.html
│       ├── statusbar.ts   # 底部状态栏入口
│       ├── StatusBar.vue  # 底部状态栏组件（明/暗双主题）
│       └── statusbar.html
├── assets/                # 静态资源（logo、tray 图标）
├── build/                 # electron-builder 使用的应用图标
├── dist/                  # TypeScript/Vite 编译输出
├── release/               # electron-builder 打包输出
├── .plan/plan.md          # 原始开发计划
├── README.md
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.main.json
├── tsconfig.preload.json
└── electron-builder.json
```

## 关键实现

### 启动时 kimi code 更新检查

实现文件：`src/main/updater.ts`、`src/main/index.ts`、`src/renderer/App.vue`

- 时机：`startApp()` 中 splash 显示之后、`kimiWeb.start()` 之前；
- 检查：并行执行 `kimi --version`（当前版本）和
  `GET https://code.kimi.com/kimi-code/latest`（最新版本，纯文本），各 5s 超时；
  任何失败（断网、命令缺失、超时）都静默跳过，不阻塞启动；
- 有更新时 splash 页面展示更新卡片（`v当前 → v最新`，「立即更新并重启」/「暂不更新」），
  用户确认后先执行 `kimi upgrade`（就地升级 `~/.kimi-code`，300s 超时），
  然后必须重新校验 `kimi --version` 是否达到目标版本：
  kimi 0.28.1 的 upgrade 会把平台误识别为 `native (windows)` 并拒绝自升级，
  但仍以 exit 0 退出，只看退出码会被误判为成功、陷入「重启后仍提示更新」循环；
- 校验不通过时回退执行官方安装脚本（macOS/Linux）：
  下载 `https://code.kimi.com/kimi-code/install.sh` 到临时文件后以
  `KIMI_NO_MODIFY_PATH=1 KIMI_INSTALL_DIR=<kimi home>` 运行，再次校验版本，
  仍不达标才进入 error 状态；Windows 无安装脚本兜底，直接报错提示手动升级；
- 成功后 `app.relaunch()` + `app.exit(0)`（`app.exit` 不触发 `before-quit`，
  不会被 quit 拦截逻辑影响）；失败可重试或跳过；
- 状态机：`idle → checking → available → updating → done/error`，
  主进程保存最新 `UpdateState` 并推送到 splash；
- IPC：`update:state`（主→渲染推送）、`update:get-state`（挂载时拉取，
  消除推送时序竞争）、`update:confirm`、`update:skip`（均校验 sender 是 content view）；
- 边界：复用用户自启的 kimi web 服务时，升级只替换二进制，
  运行中的旧版服务不受影响，也不会被杀掉。

### kimi web 服务管理

实现文件：`src/main/kimi-web.ts`

启动流程：

1. 读取 `~/.kimi-code/server/instances/*.json`（kimi ≥ 0.28）和旧版 `~/.kimi-code/server/lock`，按心跳时间排序作为候选；
2. 逐个探测 `/api/v1/meta`，服务可达则直接复用，`reused = true`；
3. 若无可用服务，执行 `kimi web --no-open --dangerous-bypass-auth`；
   - kimi ≥ 0.28 已删除 `--foreground` / `--keep-alive`（默认前台运行），
     应用通过 `kimi web --help` 自动检测，仅旧版本才追加这两个参数；
   - kimi ≥ 0.28 在端口被占用时自动递增端口，不再输出 `server already running`；
4. 从 stdout 捕获 URL 和 token；
5. 若启动输出 `server already running`（旧版本），也按复用处理。

停止流程：

- 只有 `startedByUs = true` 时才会杀进程；
- 复用已有服务时不会关闭它；
- 关闭时先 `SIGTERM`，超时后 `SIGKILL`（Windows 用 `taskkill /T /F`）。

### 认证

实现文件：`src/main/index.ts`

- 从 `~/.kimi-code/server.token` 读取 token；
- 通过 `session.defaultSession.webRequest.onBeforeSendHeaders` 自动给 `127.0.0.1` / `localhost` 请求注入 `Authorization: Bearer <token>`；
- 因此用户无需在 Web UI 中手动输入 token。

### 底部状态栏（会话指标 + 额度）

实现文件：`src/main/monitor.ts`、`src/main/quota.ts`、`src/renderer/StatusBar.vue`

- 主窗口是两个 `WebContentsView`：上方 content view 加载 kimi web，下方 30px
  状态栏 view（`STATUSBAR_HEIGHT`，`src/main/window.ts`），互不影响 DOM；
- 会话指标（输入/输出 token、缓存命中率、生成速度、上轮耗时、忙闲状态）：
  - 通过 content view 的 `did-navigate` / `did-navigate-in-page` 跟踪 URL 中的
    `/sessions/{id}` 定位当前会话；
  - 注意：`history.replaceState` 不触发 `did-navigate-in-page`（kimi web 首次
    点开旧会话正是用 replaceState 更新 URL），因此 preload
    （`src/preload/index.ts` 的 `setupUrlReporter`）每 500ms 轮询
    `location.href`，变化时通过 `monitor:page-url` 上报给主进程，
    与导航事件一样走 `monitor.handleNavigate(url, true)`；
  - 回退跟踪：启动时 kimi web 恢复上次会话可能不产生页面内导航事件，
    导致一直跟踪不到会话；`configure()` 后 2.5s 起，若仍未跟踪到会话，
    轮询 `GET /api/v1/sessions`（按 updated_at 倒序）自动选择——优先
    busy 会话，否则最近更新的会话。一旦出现页面内导航（`inPage=true`），
    回退机制永久让位（如用户回到首页时不会强行重新跟踪）；
  - 先拉 `GET /api/v1/sessions/{id}` 快照（注意响应有 `{code,msg,data}` 包装），
    再连 `ws://.../api/v1/ws`（子协议 `kimi-code.bearer.<token>`）订阅增量事件，
    用 `last_seq` 游标去重；
  - 注意：REST 快照的 `usage` / `last_seq` 恒为 0（服务端不回填历史统计），
    真实 token 数据来自 WS 订阅后服务端回放的事件缓冲；未驻留的旧会话
    （服务启动后还没打开过）订阅 ack 会返回 `resync_required`，此时拉一次
    `GET /api/v1/sessions/{id}/messages?limit=1` 触发服务端加载会话，
    再重发 `client_hello` 重新订阅即可拿到回放（monitor.ts 的
    `handleAck` / `resyncSession`，每次 WS 连接最多重试 2 次）；
  - 速度 = `usage.output / llmStreamDurationMs`（来自 `turn.step.completed`），
    耗时 = `turn.ended` 的 `durationMs`；
  - 同一会话的 WS 会广播所有 agent（含子 agent `agent-N`）的 `turn.*` 事件，
    必须按 `payload.agentId` 过滤、只处理 `'main'`（缺失时按 main 对待），
    否则子 agent 的 `turn.ended` 会覆盖耗时并把状态误置为空闲；
  - 注意：kimi web 输出的 URL 带尾部斜杠，拼接 API 路径前必须去掉，
    否则 `//api/...` 会被 SPA fallback 成 HTML（monitor.ts 的 configure 已处理）；
  - 状态栏内的重置倒计时平时不显示，鼠标悬停在额度条上时，百分比数字会
    临时替换为倒计时（如 `5h [bar] 2h15m后`），移走恢复。没有 tooltip，
    没有覆盖层，不改动视图大小；
- 额度与加油包余额：`src/main/quota.ts` 走独立的 Kimi Device OAuth
  （`auth.kimi.com/api/oauth/device_authorization`，token 存
  `userData/quota-auth.json`，故意不碰 CLI 凭据），再请求
  `https://api.kimi.com/coding/v1/usages`，每 60s 轮询（30s 缓存）；
- 主题跟随：kimi web 用 `document.documentElement.dataset.colorScheme`
  （light/dark/system）+ `prefers-color-scheme` 决定明暗，preload
  （`src/preload/index.ts`）监听后通过 `monitor:page-theme` 上报给主进程，
  状态栏据此切换 CSS 变量；
- IPC：`monitor:state`（主→渲染推送全量状态）、`monitor:refresh`、
  `monitor:authorize`、`monitor:open-quota-page`、`monitor:page-url`
  （preload 上报页面 URL 变化）、`monitor:page-theme`（preload 上报主题）。

### 通知

实现文件：`src/main/index.ts`

- Kimi Web 使用浏览器原生 `Notification` API；
- 主进程自动授予 `notifications` 权限；
- 点击系统通知时聚焦主窗口。

### 状态栏图标

实现文件：`src/main/tray.ts`

- 使用 `assets/trayTemplate.png` / `assets/trayTemplate@2x.png`；
- 左键点击：显示/隐藏主窗口；
- 右键点击：弹出菜单（显示/隐藏、退出）。

### 外部链接

- Web UI 中的外部链接通过 `shell.openExternal` 在系统浏览器打开；
- 禁止在 Electron 窗口内打开新窗口。

## 图标资源

- `assets/kimi-logo.svg`：Kimi 小眼睛 logo 源文件，品牌色 `#58a6ff`，正方形 viewBox；
- `build/icon.png`：1024x1024 应用图标，electron-builder 使用；
- `assets/trayTemplate.png` / `assets/trayTemplate@2x.png`：状态栏图标，黑色 template 模式。

若修改 logo，需重新生成 `build/icon.png` 和 tray 图标。可使用 sharp：

```bash
node -e "
const fs = require('fs');
const sharp = require('sharp');
const svg = fs.readFileSync('assets/kimi-logo.svg', 'utf8').replace(/fill='#58a6ff'/g, \"fill='black'\");
Promise.all([
  sharp('assets/kimi-logo.svg').resize(1024, 1024).png().toFile('build/icon.png'),
  sharp(Buffer.from(svg)).resize(22, 22).png().toFile('assets/trayTemplate.png'),
  sharp(Buffer.from(svg)).resize(44, 44).png().toFile('assets/trayTemplate@2x.png'),
]).then(() => console.log('icons updated'));
"
```

## 开发注意事项

- 必须使用 pnpm，不要使用 npm；
- 主进程和 preload 使用 CommonJS/Node16 输出到 `dist/main` / `dist/preload`；
- 渲染进程使用 Vite 构建到 `dist/renderer`；
- `package.json` 的 `main` 指向 `dist/main/index.js`；
- 不要修改 `dist/` 下的文件，它们由构建生成；
- 新增 native 依赖后，electron-builder 的 `postinstall` 会自动重建。

## 打包配置

文件：`electron-builder.json`

- macOS: 输出 `.app`、`.dmg`、`.zip`；
- Windows: 输出 `.exe`（NSIS）、`.zip`；
- Linux: 输出 `.AppImage`、`.deb`；
- macOS 使用登录钥匙串中的自签名证书 `KimiDesk Local` 签名（`mac.identity`）。
  必须使用签名标识与 bundle id（`com.kimidesk.app`）一致的证书：
  electron-builder 默认的 ad-hoc 签名标识是 `Electron`，与 bundle id 不匹配，
  会被 macOS usernotificationsd 拒绝（`addRequest not allowed`），导致系统通知完全无法显示。
  若证书丢失需重建：`openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=KimiDesk Local" -addext "extendedKeyUsage=codeSigning" -addext "keyUsage=critical,digitalSignature"`，
  导出 p12 后 `security import` 导入登录钥匙串，再 `security add-trusted-cert -r trustRoot -p codeSign` 标记信任。
- 对已安装的未签名旧版 app，可手动重签修复通知：`codesign --force --deep -s - /Applications/KimiDesk.app`（需先退出 app）。

## 已知限制

- 当前主要适配 macOS，Windows/Linux 路径基本可用但未充分测试；
- 若 `kimi web` 的启动输出格式变化，可能需要调整 `src/main/kimi-web.ts` 中的正则解析；
- 系统通知需要用户在 macOS 通知设置中允许 KimiDesk。
