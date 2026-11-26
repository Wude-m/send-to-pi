# send-to-pi: Pi Coding Agent Extension

这是 `send-to-pi` 运行在 Pi coding agent 端的核心扩展（v1.4.0）。

## 作用
1. 自动探测并监听本地内部端口 `127.0.0.1:18091~18095`，支持 **Chrome 扩展零 Daemon 直连**与 Bridge 转发两种模式；
2. 自动识别当前宿主终端（Rex、Ghostty、iTerm2、Warp、WezTerm、kitty、Alacritty、VS Code、Cursor、Windows Terminal、Terminal.app 等），将活跃会话写入 `~/.pi/send-to-pi/sessions.json`，并将最近使用的终端环境持久化到 `~/.pi/send-to-pi/last-terminal.json`；
3. 监听 `session_start`、`input`、`agent_start` 事件实时更新 `activeAt`，多开窗口时精准路由到用户刚刚交互的会话；
4. 收到内容后按智能长度分流（≤1500 字直填，超长自动落盘 `~/.pi/send-to-pi/inbox/*.md` 仅填 3 行 `@路径` 引用），通过 `ctx.ui.setEditorText()` **预填到终端输入框（Prefill 模式，绝不自动回车）**；
5. 会话启动时自动消费冷启动暂存文件（`~/.pi/pending-browser-input.txt`）。

## 安装方式

推荐直接使用 Pi 内置包管理器安装：

```bash
pi install npm:send-to-pi
```

或手动复制 `index.ts` 到 `~/.pi/agent/extensions/send-to-pi.ts` 后重启 `pi`。
