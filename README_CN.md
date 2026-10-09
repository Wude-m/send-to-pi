# 🚀 send-to-pi (浏览器网页一键发送至 Pi Agent)

**简体中文** | [**English**](./README.md)

> 让你的网页浏览器与 [Pi 终端编程助手](https://github.com/earendil-works/pi-coding-agent) 无缝打通。在网页上选中文字、提取整页文章或捕获链接，一键直达终端输入框，自动排版并预填上下文。

[![npm version](https://img.shields.io/npm/v/send-to-pi.svg)](https://www.npmjs.com/package/send-to-pi)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D16-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-orange.svg)]()

---

## 💡 为什么需要 send-to-pi？

现代 AI Coding Agent（如 Pi、Claude Code、Aider 等）在命令行终端里表现极其出色，但日常开发中**绝大部分上下文其实都在浏览器里**——比如正在查阅的 GitHub Issue、PR 代码 Review、官方文档、Stack Overflow 问答、前端报错页面以及技术博文。

以往把网页内容喂给终端 Agent 的流程非常繁琐：
1. 鼠标划词复制
2. Alt+Tab 切到终端窗口
3. 粘贴进输入框
4. 代码缩进变形、表格散架、手动打字写“请参考以上网页/报错...”

**有了 `send-to-pi` 之后：**
在任何网页上划选文字、提取文章或点击链接 ➔ **内容自动携带网页标题与来源 URL，毫秒级预填进 Pi 终端输入框**。
- 🎯 **Prefill 预填模式（绝不自作主张回车）**：内容送到输入框后，光标停留在末尾，你可以从容补充具体指令（如“请根据这段代码重构...”），最后按回车自主发送。
- 📝 **HTML 智能转 Markdown（保留代码与表格格式）**：划词内容自动识别并还原 `<pre><code>` 语言/缩进、`<table>` 表格、列表、引用及超链接；页面受限时自动平滑降级。
- 📖 **整页正文提取（Readability 模式）**：右键点击“发送精简文章”，自动剔除页眉、页脚、侧边栏及广告噪声，将干净的正文转为 Markdown 一键交付，终端无需再额外发起网络请求。
- ⌨️ **快捷键一键直达**：支持全局划选快捷键（默认 <kbd>Alt+Shift+S</kbd> / Mac <kbd>Cmd+Shift+S</kbd>），无需右键鼠标二次点击。
- 🔄 **动态端口发现与防串台**：Pi 会话自动在 18091~18095 范围内探测可用端口，并通过 `~/.pi/send-to-pi.json` 维护活跃实例，多窗口共存不冲突。
- ⚡ **冷启动自动唤醒终端**：若当前未运行 Pi，自动为你拉起终端、启动 `pi`，并在会话初始化完成后自动填入内容！
- 🍏 **全平台终端适配**：原生支持 **macOS**（Terminal.app、iTerm2、Ghostty、WezTerm 等）、**Windows**（Windows Terminal、PowerShell）以及 **Linux**。
- 🔒 **纯本地与隐私安全**：全链路通过本地环回地址 `127.0.0.1` 传输，无云端中转，零数据收集。

---

## 🛠️ 系统架构与工作流程

```mermaid
sequenceDiagram
    autonumber
    actor User as 开发者
    participant Browser as Chrome 扩展
    participant Bridge as Bridge 守护进程 (:18090)
    participant Pi as 活跃 Pi 终端 (18091~18095)

    User->>Browser: 划选/文章提取 (右键或快捷键)
    Browser->>Bridge: HTTP POST /send (Markdown、URL、标题)
    alt 存在活跃 Pi 会话
        Bridge->>Bridge: 读取 ~/.pi/send-to-pi.json 或端口探测
        Bridge->>Pi: 转发至对应端口 /receive
        Pi->>Pi: ctx.ui.setEditorText() (预填到输入框)
        Bridge-->>Browser: 200 OK (已填入输入框)
    else Pi 未运行 (冷启动模式)
        Bridge->>Bridge: 写入暂存文件 ~/.pi/pending-browser-input.txt
        Bridge->>User: 自动拉起终端并运行 `pi`
        User->>Pi: 会话初始化完成
        Pi->>Pi: 读取暂存文件并填入输入框
        Bridge-->>Browser: 200 OK (已唤醒终端)
    end
```

---

## 📦 三步快速上手

### 第一步：安装 Pi 原生扩展
你可以直接使用 Pi 内置的包管理器一键安装：

```bash
pi install npm:send-to-pi
```

*(或者通过 GitHub 安装: `pi install git:github.com/Wude-m/send-to-pi`)*

### 第一步启动后，扩展会自动随 Pi 启动并在可用端口（18091~18095）监听接收。

### 第二步：启动 Bridge 守护进程
调度守护进程负责在后台监听浏览器请求并在需要时唤醒终端：

```bash
# 直接使用 npx 运行
npx send-to-pi start

# 或者克隆本仓库后运行
git clone https://github.com/Wude-m/send-to-pi.git
cd send-to-pi
npm start
```

> **后台常驻小提示**：
> - **macOS / Linux 用户**：直接运行 `bash scripts/start-mac.sh` 即可在后台静默运行。
> - **Windows 用户**：双击 `scripts/start-win.vbs` 即可无黑框后台静默运行。

### 第三步：加载 Chrome 浏览器扩展
你完全不需要手动去翻找目录，只需在终端运行：

```bash
npx send-to-pi extension
```

该命令会打印出扩展目录并**自动在系统文件管理器中打开该文件夹**。然后：
1. 打开 Chrome 或 Edge 浏览器，访问 `chrome://extensions/`；
2. 开启右上角的 **“开发者模式”**（Developer mode）；
3. 点击左上角的 **“加载已解压的扩展程序”**（Load unpacked），选择刚刚为你弹出的文件夹即可！

---

## ⌨️ 日常使用演示

1. **发送划选内容（Markdown 格式）**：
   - 网页上鼠标选中任何代码或文本 ➔ 右键 ➔ 点击 `🚀 发送选中内容给 Pi`；
   - 或划选后直接按下快捷键 <kbd>Alt+Shift+S</kbd>（Mac: <kbd>Cmd+Shift+S</kbd>）。
2. **发送精简正文（Readability 模式）**：
   - 在网页任意空白处 ➔ 右键 ➔ 点击 `🚀 发送精简文章给 Pi`；
   - 自动解析正文结构转为 Markdown，剔除无关导航和广告。
3. **发送超链接**：
   - 在任意超链接上 ➔ 右键 ➔ 点击 `🚀 发送此链接给 Pi`。

终端输入框中会立即呈现带有来源标题与 URL 的整洁 Markdown 内容：
```text
【来源】：GitHub - earendil-works/pi-coding-agent (https://github.com/...)

```typescript
export default function (pi: ExtensionAPI) { ... }
```
_ [光标停在此处，等待你补充提示词]
```

---

## ⚙️ 环境变量与终端自定义

支持通过环境变量调整守护进程行为：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PI_BRIDGE_PORT` | `18090` | Bridge 调度进程监听的端口 |
| `PI_INTERNAL_PORT` | `18091` | 活跃 Pi 会话内部起始端口（自动探测 18091~18095） |
| `PI_WORKDIR` | 当前目录 | 自动唤醒 Pi 时默认进入的工作目录 |
| `PI_TERMINAL` | 自动探测 | macOS/Linux 指定偏好终端（如 `iterm2`, `ghostty`, `terminal`, `alacritty`） |

macOS 示例：
```bash
PI_TERMINAL=ghostty PI_WORKDIR=~/mycode npx send-to-pi start
```

---

## 🤝 欢迎贡献

欢迎提交 PR 或 Issue！无论是：
- 适配 Firefox / Safari 扩展
- 支持更多小众终端仿真器
- 完善打包与系统服务脚本

---

## 📄 开源协议

基于 [MIT License](./LICENSE) 开源 © 2026 Wude
