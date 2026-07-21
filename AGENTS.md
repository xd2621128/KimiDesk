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
│   │   ├── window.ts      # BrowserWindow 创建与配置
│   │   └── tray.ts        # macOS 状态栏图标
│   ├── preload/           # 安全桥接脚本
│   │   ├── index.ts
│   │   └── types.d.ts
│   └── renderer/          # Vue 3 渲染进程
│       ├── main.ts
│       ├── App.vue
│       └── index.html
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
