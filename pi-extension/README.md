# send-to-pi: Pi Coding Agent Extension

这是 `send-to-pi` 运行在 Pi coding agent 端的核心扩展。

## 作用
1. 监听本地内部端口 `127.0.0.1:18091`，接收调度服务（Bridge Daemon）转发过来的网页摘录；
2. 收到内容后，通过 Pi 的原生 API `ctx.ui.setEditorText()` **预填到终端输入框（Prefill 模式）**；
3. **绝不自作主张自动回车发送**，光标停留在内容末尾，让开发者可以自由补充指令或微调内容；
4. 终端会话启动时，自动读取冷启动时暂存的文件（`~/.pi/pending-browser-input.txt`），无缝实现“唤醒终端并填入内容”。

## 安装方式

将 `index.ts` 复制或软链接到你的 Pi 扩展目录中：

### macOS / Linux
```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/send-to-pi.ts
```

### Windows (PowerShell)
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.pi\agent\extensions"
Copy-Item index.ts "$env:USERPROFILE\.pi\agent\extensions\send-to-pi.ts"
```

重启 `pi` 会话后即可自动加载！
