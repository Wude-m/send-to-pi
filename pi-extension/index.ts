/**
 * send-to-pi Extension for Pi Coding Agent
 *
 * Dynamically binds to an available internal port (18091 ~ 18095).
 * Updates ~/.pi/send-to-pi.json with the active session metadata.
 * Prefills incoming payloads into terminal input without immediate execution.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_START_PORT = 18091;
const PORT_RANGE = 5; // 18091 ~ 18095

function getPiHomeDir(): string {
  const dir = path.join(os.homedir(), ".pi");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
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

function recordActiveSession(port: number, workDir: string) {
  try {
    const sessionFile = getActiveSessionFilePath();
    const data = {
      pid: process.pid,
      port,
      workdir: workDir,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2), "utf8");
  } catch (err: any) {
    console.error("[SendToPi] Failed to write active session file:", err.message);
  }
}

function clearActiveSession() {
  try {
    const sessionFile = getActiveSessionFilePath();
    if (fs.existsSync(sessionFile)) {
      const content = fs.readFileSync(sessionFile, "utf8");
      const parsed = JSON.parse(content);
      if (parsed.pid === process.pid) {
        fs.unlinkSync(sessionFile);
      }
    }
  } catch {}
}

export default function (pi: ExtensionAPI) {
  let server: http.Server | null = null;
  let activeCtx: ExtensionContext | null = null;
  let activePort: number | null = null;

  function prefillEditor(ctx: ExtensionContext, textToInsert: string) {
    if (!ctx || !ctx.ui) return;
    try {
      const current = ctx.ui.getEditorText ? ctx.ui.getEditorText() : "";
      const finalContent =
        current && current.trim().length > 0
          ? `${current.trim()}\n\n${textToInsert}`
          : textToInsert;

      ctx.ui.setEditorText(finalContent);
      ctx.ui.notify("🚀 已将浏览器内容填入输入框，可补充指令或直接回车！", "info");
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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "alive",
              port,
              pid: process.pid,
              workdir: ctx?.cwd || process.cwd(),
              updatedAt: Date.now(),
            })
          );
          return;
        }

        if (req.method === "POST" && req.url === "/receive") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", () => {
            try {
              const data = JSON.parse(body || "{}");
              const { content } = data;

              if (content && activeCtx) {
                prefillEditor(activeCtx, content);
              }

              // 每次成功接收更新活跃时间
              recordActiveSession(port, ctx?.cwd || process.cwd());

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: true, mode: "prefilled", port }));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
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

    // 检查是否有冷启动唤醒时暂存的内容
    for (const pendingFile of getPendingFilePaths()) {
      if (fs.existsSync(pendingFile)) {
        try {
          const content = fs.readFileSync(pendingFile, "utf8");
          fs.unlinkSync(pendingFile);
          setTimeout(() => {
            prefillEditor(ctx, content);
          }, 800);
          break;
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

  pi.on("session_shutdown", async () => {
    if (server) {
      server.close();
      server = null;
    }
    clearActiveSession();
    activeCtx = null;
    activePort = null;
  });

  process.on("exit", () => {
    clearActiveSession();
  });
}
