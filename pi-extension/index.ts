/**
 * send-to-pi Extension for Pi Coding Agent (v1.4.0)
 *
 * Dynamically binds to an available internal port (18091 ~ 18095).
 * Registers active sessions in ~/.pi/send-to-pi/sessions.json (and legacy ~/.pi/send-to-pi.json),
 * persists the most recently used terminal profile in ~/.pi/send-to-pi/last-terminal.json,
 * and prefills incoming browser payloads into the Pi editor without auto-submitting.
 *
 * Smart delivery (v1.4.0):
 * - Short content (<= inlineLimit, default 1500 chars): prefilled directly into editor.
 * - Long content (> inlineLimit): saved as Markdown in ~/.pi/send-to-pi/inbox/ and prefilled
 *   as a clean 3-line @file reference so the terminal input stays concise and readable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_START_PORT = 18091;
const PORT_RANGE = 5; // 18091 ~ 18095
const DEFAULT_DELIVERY_MODE: DeliveryMode = "smart";
const DEFAULT_INLINE_LIMIT = 1500;
const INBOX_MAX_FILES = 50;
const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PENDING_MAX_AGE_MS = 2 * 60 * 1000; // 2 minutes TTL for cold-start pending file

type DeliveryMode = "smart" | "inline" | "link";

type TerminalInfo = {
  terminal: string | null;
  appName: string | null;
  window: string | null;
  rexBin?: string | null;
  termProgram?: string | null;
};

type SessionRecord = {
  id: string;
  pid: number;
  port: number;
  workdir: string;
  activeAt: number;
  startedAt: number;
  updatedAt: number;
  terminal: string | null;
  appName: string | null;
  window: string | null;
  rexBin?: string | null;
};

type LastTerminalRecord = {
  terminal: string | null;
  appName: string | null;
  workdir: string;
  rexBin?: string | null;
  platform: NodeJS.Platform;
  updatedAt: number;
};

type PreparedDelivery = {
  editorText: string;
  delivery: "inline" | "file" | "link";
  savedFile: string | null;
  charCount: number;
};

function getPiHomeDir(): string {
  const dir = path.join(os.homedir(), ".pi");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}

function getSendToPiDir(): string {
  const dir = path.join(getPiHomeDir(), "send-to-pi");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function getInboxDir(): string {
  const dir = path.join(getSendToPiDir(), "inbox");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function getUserConfigFilePath(): string {
  return path.join(getSendToPiDir(), "config.json");
}

function getSessionRegistryFilePath(): string {
  return path.join(getSendToPiDir(), "sessions.json");
}

function getLastTerminalFilePath(): string {
  return path.join(getSendToPiDir(), "last-terminal.json");
}

function getActiveSessionFilePath(): string {
  return path.join(getPiHomeDir(), "send-to-pi.json");
}

function getPendingFilePaths(): string[] {
  const piHome = getPiHomeDir();
  return [
    path.join(piHome, "pending-browser-input.txt"),
    path.join(os.tmpdir(), "pi-pending-browser-input.txt"),
  ];
}

function readUserConfig(): Record<string, any> {
  try {
    const file = getUserConfigFilePath();
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeDeliveryMode(val: any): DeliveryMode | null {
  const s = String(val || "").trim().toLowerCase();
  if (s === "smart" || s === "inline" || s === "link") return s;
  return null;
}

function resolveDeliverySettings(data: any): { mode: DeliveryMode; inlineLimit: number } {
  const cfg = readUserConfig();
  const mode =
    normalizeDeliveryMode(data?.deliveryMode) ||
    normalizeDeliveryMode(process.env.PI_DELIVERY_MODE) ||
    normalizeDeliveryMode(cfg.deliveryMode) ||
    DEFAULT_DELIVERY_MODE;

  const rawLimit =
    Number(data?.inlineLimit) ||
    Number(process.env.PI_INLINE_LIMIT) ||
    Number(cfg.inlineLimit) ||
    DEFAULT_INLINE_LIMIT;

  const inlineLimit =
    Number.isFinite(rawLimit) && rawLimit >= 200 ? Math.floor(rawLimit) : DEFAULT_INLINE_LIMIT;
  return { mode, inlineLimit };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err && err.code === "EPERM";
  }
}

function detectTerminalInfo(): TerminalInfo {
  const env = process.env;
  const termProgram = (env.TERM_PROGRAM || "").trim();
  const termProgramLower = termProgram.toLowerCase();
  const term = (env.TERM || "").toLowerCase();
  const explicit = (env.PI_TERMINAL || "").trim().toLowerCase();
  const windowId =
    env.PI_WINDOW_ID ||
    env.REX_BLOCK ||
    env.KITTY_WINDOW_ID ||
    env.WEZTERM_PANE ||
    env.ITERM_SESSION_ID ||
    env.WT_SESSION ||
    env.TMUX_PANE ||
    null;

  let rexBin: string | null = null;
  if (env.REX_BIN_DIR) {
    const candidate = path.join(env.REX_BIN_DIR, process.platform === "win32" ? "rex.exe" : "rex");
    if (fs.existsSync(candidate)) {
      rexBin = candidate;
    }
  }

  const knownApps: Record<string, string> = {
    rex: "Rex",
    ghostty: "Ghostty",
    iterm2: "iTerm",
    iterm: "iTerm",
    warp: "Warp",
    wezterm: "WezTerm",
    kitty: "kitty",
    alacritty: "Alacritty",
    terminal: "Terminal",
    vscode: "Visual Studio Code",
    cursor: "Cursor",
    zed: "Zed",
    tabby: "Tabby",
    hyper: "Hyper",
    wt: "Windows Terminal",
  };

  if (explicit) {
    return {
      terminal: explicit,
      appName: knownApps[explicit] || termProgram || explicit,
      window: windowId,
      rexBin,
      termProgram: termProgram || null,
    };
  }

  if (termProgramLower === "rex" || env.REX_SERVER || env.REX_BIN_DIR) {
    return { terminal: "rex", appName: "Rex", window: windowId, rexBin, termProgram: termProgram || "rex" };
  }
  if (termProgramLower === "ghostty" || env.GHOSTTY_RESOURCES_DIR) {
    return { terminal: "ghostty", appName: "Ghostty", window: windowId, termProgram: termProgram || "ghostty" };
  }
  if (termProgramLower === "iterm.app" || env.ITERM_SESSION_ID) {
    return { terminal: "iterm2", appName: "iTerm", window: windowId, termProgram: termProgram || "iTerm.app" };
  }
  if (termProgramLower === "warpterminal" || env.WARP_IS_LOCAL_SHELL_SESSION) {
    return { terminal: "warp", appName: "Warp", window: windowId, termProgram: termProgram || "WarpTerminal" };
  }
  if (termProgramLower === "wezterm" || env.WEZTERM_EXECUTABLE) {
    return { terminal: "wezterm", appName: "WezTerm", window: windowId, termProgram: termProgram || "WezTerm" };
  }
  if (env.KITTY_WINDOW_ID || term.includes("kitty")) {
    return { terminal: "kitty", appName: "kitty", window: windowId, termProgram: termProgram || "kitty" };
  }
  if (env.ALACRITTY_SOCKET || env.ALACRITTY_LOG || term === "alacritty") {
    return { terminal: "alacritty", appName: "Alacritty", window: windowId, termProgram: termProgram || "Alacritty" };
  }
  if (termProgramLower === "apple_terminal") {
    return { terminal: "terminal", appName: "Terminal", window: windowId, termProgram: termProgram || "Apple_Terminal" };
  }
  if (termProgramLower === "vscode" || env.VSCODE_IPC_HOOK_CLI) {
    const isCursor =
      Boolean(env.CURSOR_TRACE_ID) ||
      (env.VSCODE_GIT_ASKPASS_NODE || "").toLowerCase().includes("cursor") ||
      (env.TERM_PROGRAM_VERSION || "").toLowerCase().includes("cursor");
    return {
      terminal: isCursor ? "cursor" : "vscode",
      appName: isCursor ? "Cursor" : "Visual Studio Code",
      window: windowId,
      termProgram: termProgram || "vscode",
    };
  }
  if (termProgramLower === "zed") {
    return { terminal: "zed", appName: "Zed", window: windowId, termProgram };
  }
  if (termProgramLower === "tabby") {
    return { terminal: "tabby", appName: "Tabby", window: windowId, termProgram };
  }
  if (termProgramLower === "hyper") {
    return { terminal: "hyper", appName: "Hyper", window: windowId, termProgram };
  }
  if (env.WT_SESSION) {
    return { terminal: "wt", appName: "Windows Terminal", window: windowId, termProgram: termProgram || "wt" };
  }

  if (termProgram) {
    return {
      terminal: termProgramLower,
      appName: termProgram,
      window: windowId,
      termProgram,
    };
  }

  return { terminal: null, appName: null, window: windowId, termProgram: null };
}

function cleanTitle(raw: string | undefined, maxLen = 80): string {
  const singleLine = String(raw || "").replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 1).trimEnd() + "…";
}

function formatCharCount(count: number, isZh: boolean): string {
  if (count >= 1000) {
    const k = (count / 1000).toFixed(1).replace(/\.0$/, "");
    return isZh ? `约 ${k}k 字` : `~${k}k chars`;
  }
  return isZh ? `${count} 字` : `${count} chars`;
}

function buildSafeSlug(title: string, url: string): string {
  let hostPart = "";
  let pathPart = "";
  try {
    if (url) {
      const parsed = new URL(url);
      hostPart = parsed.hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9]+/g, "-");
      const segments = parsed.pathname.split("/").filter(Boolean).slice(0, 2).join("-");
      pathPart = segments.replace(/[^a-zA-Z0-9]+/g, "-");
    }
  } catch {}

  const titleAscii = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const combined = [hostPart, pathPart || titleAscii]
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);

  return combined || "clip";
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function pruneInbox(inboxDir: string, maxFiles = INBOX_MAX_FILES, maxAgeMs = INBOX_MAX_AGE_MS) {
  try {
    const now = Date.now();
    const entries = fs
      .readdirSync(inboxDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const fullPath = path.join(inboxDir, name);
        try {
          const stat = fs.statSync(fullPath);
          return { fullPath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { fullPath: string; mtimeMs: number } => Boolean(item))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    entries.forEach((entry, index) => {
      const tooOld = now - entry.mtimeMs > maxAgeMs;
      const overLimit = index >= maxFiles;
      if (tooOld || overLimit) {
        try {
          fs.unlinkSync(entry.fullPath);
        } catch {}
      }
    });
  } catch {}
}

function saveToInboxFile(opts: {
  title: string;
  url: string;
  type: string;
  markdownBody: string;
}): string {
  const inboxDir = getInboxDir();
  const now = new Date();
  const baseName = `${formatTimestamp(now)}-${buildSafeSlug(opts.title, opts.url)}`;

  let targetPath = path.join(inboxDir, `${baseName}.md`);
  let seq = 2;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(inboxDir, `${baseName}-${seq++}.md`);
  }

  const lines: string[] = [];
  lines.push(`# ${opts.title || "Web Clip"}`);
  lines.push("");
  if (opts.url) lines.push(`- Source: ${opts.url}`);
  lines.push(`- Captured: ${now.toISOString()}`);
  if (opts.type) lines.push(`- Type: ${opts.type}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(opts.markdownBody.trim());
  lines.push("");

  fs.writeFileSync(targetPath, lines.join("\n"), "utf8");
  pruneInbox(inboxDir);
  return targetPath;
}

function formatInlineText(data: any): string {
  if (typeof data?.content === "string" && data.content.length > 0) {
    return data.content;
  }
  const { type, text, title, url, lang } = data || {};
  const isZh = lang === "zh";
  const shortTitle = cleanTitle(title);

  if (type === "selection") {
    const label = isZh ? "【来源】" : "[Source]";
    return `${label}: ${shortTitle || (isZh ? "网页摘录" : "Web Snippet")} (${url || ""})\n\n${text || ""}\n\n`;
  }
  if (type === "article") {
    const titleLabel = isZh ? "【网页文章】" : "[Web Article]";
    const linkLabel = isZh ? "【网页链接】" : "[Link]";
    return `${titleLabel}: ${shortTitle || (isZh ? "正文" : "Article")}\n${linkLabel}: ${url || ""}\n\n${text || ""}\n\n`;
  }
  if (type === "link") {
    const label = isZh ? "【网页链接】" : "[Link]";
    return `${label}: ${url || ""}\n\n`;
  }
  if (url || title || text) {
    const titleLabel = isZh ? "【网页标题】" : "[Title]";
    const linkLabel = isZh ? "【网页链接】" : "[Link]";
    return `${titleLabel}: ${shortTitle || (isZh ? "网页" : "Page")}\n${linkLabel}: ${url || ""}\n\n${text ? `${text}\n\n` : ""}`;
  }
  return "";
}

function prepareDelivery(data: any): PreparedDelivery | null {
  const { mode, inlineLimit } = resolveDeliverySettings(data);
  const type = String(data?.type || "");
  const isZh =
    data?.lang === "zh" || (!data?.lang && /[\u4e00-\u9fa5]/.test(String(data?.content || data?.title || "")));
  const rawTitle = String(data?.title || "");
  const shortTitle = cleanTitle(rawTitle);
  const url = String(data?.url || "");
  const bodyText = typeof data?.text === "string" ? data.text.trim() : "";

  // Link-only explicit payload (menu: Send Link / Send Page Link)
  if (type === "link" || type === "page") {
    const titleLabel = isZh ? "【网页标题】" : "[Title]";
    const linkLabel = isZh ? "【网页链接】" : "[Link]";
    const editorText = shortTitle
      ? `${titleLabel}: ${shortTitle}\n${linkLabel}: ${url}\n\n`
      : `${linkLabel}: ${url}\n\n`;
    return { editorText, delivery: "link", savedFile: null, charCount: editorText.length };
  }

  // User configured Link-Only mode for article captures (selections still deliver selected text).
  if (mode === "link" && type === "article" && url) {
    const titleLabel = isZh ? "【网页标题】" : "[Title]";
    const linkLabel = isZh ? "【网页链接】" : "[Link]";
    const editorText = `${titleLabel}: ${shortTitle || (isZh ? "网页" : "Page")}\n${linkLabel}: ${url}\n\n`;
    return { editorText, delivery: "link", savedFile: null, charCount: editorText.length };
  }

  const inlineText = formatInlineText(data);
  if (!inlineText) return null;

  // Measure body length (fallback to full inline text if raw text wasn't sent separately).
  const bodyForFile = bodyText || inlineText;
  const charCount = bodyForFile.length;

  // Smart mode: offload long content to ~/.pi/send-to-pi/inbox/*.md and insert a clean @file reference.
  if (mode === "smart" && charCount > inlineLimit) {
    const savedFile = saveToInboxFile({
      title: rawTitle || (isZh ? "网页内容" : "Web Clip"),
      url,
      type: type || "clip",
      markdownBody: bodyForFile,
    });

    const headerLabel =
      type === "selection"
        ? isZh
          ? "【来源】"
          : "[Source]"
        : isZh
          ? "【网页文章】"
          : "[Web Article]";
    const linkLabel = isZh ? "【网页链接】" : "[Link]";
    const fileLabel = isZh ? "【本地正文】" : "[Saved Content]";
    const countLabel = formatCharCount(charCount, isZh);

    const lines = [
      `${headerLabel}: ${shortTitle || (isZh ? "网页内容" : "Web Clip")}`,
      ...(url ? [`${linkLabel}: ${url}`] : []),
      `${fileLabel}: @${savedFile} (${countLabel})`,
      "",
      "",
    ];

    return {
      editorText: lines.join("\n"),
      delivery: "file",
      savedFile,
      charCount,
    };
  }

  // Inline delivery (short content or mode === "inline")
  return {
    editorText: inlineText,
    delivery: "inline",
    savedFile: null,
    charCount,
  };
}

function readSessionRecords(): SessionRecord[] {
  try {
    const registryFile = getSessionRegistryFilePath();
    if (!fs.existsSync(registryFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    const sessions = Array.isArray(parsed) ? parsed : parsed?.sessions;
    if (!Array.isArray(sessions)) return [];
    return sessions.filter((s) => s && Number.isInteger(Number(s.port)) && isProcessAlive(Number(s.pid)));
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, payload: unknown) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const temporaryFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryFile, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(temporaryFile, filePath);
}

export default function (pi: ExtensionAPI) {
  let server: http.Server | null = null;
  let activeCtx: ExtensionContext | null = null;
  let activePort: number | null = null;
  const startedAt = Date.now();
  let lastActiveAt = startedAt;
  const terminalInfo = detectTerminalInfo();

  function recordActiveSession(port: number, workDir: string) {
    try {
      const now = Date.now();
      lastActiveAt = now;
      const sessionId = `${process.pid}-${port}`;
      const existingSessions = readSessionRecords();
      const sessions = existingSessions.filter((session) => session.id !== sessionId);
      const previous = existingSessions.find((session) => session.id === sessionId);

      const data: SessionRecord = {
        id: sessionId,
        pid: process.pid,
        port,
        workdir: workDir,
        activeAt: now,
        startedAt: previous ? previous.startedAt : startedAt,
        updatedAt: now,
        terminal: terminalInfo.terminal,
        appName: terminalInfo.appName,
        window: terminalInfo.window,
        ...(terminalInfo.rexBin ? { rexBin: terminalInfo.rexBin } : {}),
      };

      sessions.push(data);
      writeJsonAtomic(getSessionRegistryFilePath(), { version: 2, sessions });

      // Keep the pre-1.2.0 single-session file for older Bridge versions.
      fs.writeFileSync(getActiveSessionFilePath(), JSON.stringify(data, null, 2), "utf8");

      // Persist last known terminal & workdir so cold-start launches match the user's real client.
      const lastTerminal: LastTerminalRecord = {
        terminal: terminalInfo.terminal,
        appName: terminalInfo.appName,
        workdir: workDir,
        ...(terminalInfo.rexBin ? { rexBin: terminalInfo.rexBin } : {}),
        platform: process.platform,
        updatedAt: now,
      };
      writeJsonAtomic(getLastTerminalFilePath(), lastTerminal);
    } catch (err: any) {
      console.error("[SendToPi] Failed to write session registry:", err.message);
    }
  }

  function clearActiveSession(port: number | null) {
    try {
      const sessionId = port === null ? null : `${process.pid}-${port}`;
      const sessions = readSessionRecords().filter(
        (session) =>
          session.id !== sessionId && !(session.pid === process.pid && (port === null || session.port === port))
      );
      writeJsonAtomic(getSessionRegistryFilePath(), { version: 2, sessions });

      const sessionFile = getActiveSessionFilePath();
      if (fs.existsSync(sessionFile)) {
        const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
        if (parsed.pid === process.pid && (port === null || parsed.port === port)) {
          fs.unlinkSync(sessionFile);
        }
      }
    } catch {}
  }

  function prefillEditor(ctx: ExtensionContext, textToInsert: string, notifyMsg?: string) {
    if (!ctx || !ctx.ui) return;
    try {
      const current = ctx.ui.getEditorText ? ctx.ui.getEditorText() : "";
      const finalContent =
        current && current.trim().length > 0
          ? `${current.trim()}\n\n${textToInsert}`
          : textToInsert;

      ctx.ui.setEditorText(finalContent);
      ctx.ui.notify(
        notifyMsg || "🚀 已将浏览器内容填入输入框，可补充指令或直接回车！",
        "info"
      );
    } catch (e: any) {
      console.error("[SendToPi] setEditorText error:", e.message);
    }
  }

  function createServerInstance(ctx: ExtensionContext, port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const app = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "GET" && req.url === "/health") {
          const workdir = activeCtx?.cwd || ctx?.cwd || process.cwd();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              status: "alive",
              version: "1.4.1",
              port,
              pid: process.pid,
              workdir,
              activeAt: lastActiveAt,
              startedAt,
              updatedAt: lastActiveAt,
              terminal: terminalInfo.terminal,
              appName: terminalInfo.appName,
              window: terminalInfo.window,
            })
          );
          return;
        }

        if (req.method === "POST" && req.url === "/receive") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          req.on("end", () => {
            try {
              const body = Buffer.concat(chunks).toString("utf8");
              const data = JSON.parse(body || "{}");
              const prepared = prepareDelivery(data);

              if (!prepared) {
                res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: false, error: "Empty content" }));
                return;
              }

              const notifyMsg =
                prepared.delivery === "file"
                  ? `🚀 长文已存至本地文件并填入 @引用（${formatCharCount(prepared.charCount, true)}），可直接补充指令或回车！`
                  : prepared.delivery === "link"
                    ? "🚀 已将网页链接填入输入框，可补充指令或直接回车！"
                    : "🚀 已将浏览器内容填入输入框，可补充指令或直接回车！";

              if (activeCtx) {
                prefillEditor(activeCtx, prepared.editorText, notifyMsg);
              }

              const workdir = activeCtx?.cwd || ctx?.cwd || process.cwd();
              recordActiveSession(port, workdir);

              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(
                JSON.stringify({
                  success: true,
                  mode: "prefilled",
                  delivery: prepared.delivery,
                  savedFile: prepared.savedFile,
                  charCount: prepared.charCount,
                  port,
                  workdir,
                  terminal: terminalInfo.terminal,
                  appName: terminalInfo.appName,
                })
              );
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ success: false, error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Not Found" }));
      });

      const onError = (err: any) => {
        app.removeListener("listening", onListening);
        reject(err);
      };

      const onListening = () => {
        app.removeListener("error", onError);
        resolve(app);
      };

      app.once("error", onError);
      app.once("listening", onListening);
      app.listen(port, "127.0.0.1");
    });
  }

  async function startHttpServer(ctx: ExtensionContext): Promise<number> {
    const startPort = parseInt(process.env.PI_INTERNAL_PORT || "", 10) || DEFAULT_START_PORT;
    const endPort = startPort + PORT_RANGE - 1;

    for (let currentPort = startPort; currentPort <= endPort; currentPort++) {
      try {
        const boundServer = await createServerInstance(ctx, currentPort);
        server = boundServer;
        activePort = currentPort;
        return currentPort;
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          throw err;
        }
      }
    }
    throw new Error(`All ports in range ${startPort}-${endPort} are occupied.`);
  }

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;

    // 检查是否有冷启动唤醒时暂存的内容（超过 2 分钟的陈旧文件直接清理丢弃，防止误填入后续新会话）
    for (const pendingFile of getPendingFilePaths()) {
      if (fs.existsSync(pendingFile)) {
        try {
          const stat = fs.statSync(pendingFile);
          const ageMs = Date.now() - stat.mtimeMs;
          const content = fs.readFileSync(pendingFile, "utf8");
          fs.unlinkSync(pendingFile);
          if (ageMs <= PENDING_MAX_AGE_MS && content.trim().length > 0) {
            setTimeout(() => {
              prefillEditor(ctx, content);
            }, 800);
            break;
          }
        } catch (err: any) {
          console.error("[SendToPi] Failed to read pending file:", err.message);
        }
      }
    }

    if (!server) {
      try {
        const boundPort = await startHttpServer(ctx);
        recordActiveSession(boundPort, ctx?.cwd || process.cwd());
      } catch (err: any) {
        console.error("[SendToPi] Failed to bind internal port:", err.message);
      }
    } else if (activePort) {
      recordActiveSession(activePort, ctx?.cwd || process.cwd());
    }
  });

  // 实时追踪最近交互的会话，确保多窗口/多终端时精准路由到用户正在使用的窗口
  pi.on("input", async (_event, ctx) => {
    activeCtx = ctx;
    if (activePort) {
      recordActiveSession(activePort, ctx?.cwd || process.cwd());
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (activePort) {
      recordActiveSession(activePort, ctx?.cwd || process.cwd());
    }
  });

  pi.on("session_shutdown", async () => {
    if (server) {
      server.close();
      server = null;
    }
    clearActiveSession(activePort);
    activeCtx = null;
    activePort = null;
  });

  process.on("exit", () => {
    clearActiveSession(activePort);
  });
}
