/**
 * send-to-pi Extension for Pi Coding Agent
 *
 * Listens on 127.0.0.1:18091 for incoming browser payloads.
 * Automatically prefills text into the terminal editor with setEditorText()
 * without executing immediately, giving the user full control to refine prompts!
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const INTERNAL_PORT = parseInt(process.env.PI_INTERNAL_PORT || "", 10) || 18091;

function getPendingFilePaths(): string[] {
  const piHome = path.join(os.homedir(), ".pi");
  return [
    path.join(piHome, "pending-browser-input.txt"),
    path.join(os.tmpdir(), "pi-pending-browser-input.txt"),
  ];
}

export default function (pi: ExtensionAPI) {
  let server: http.Server | null = null;
  let activeCtx: ExtensionContext | null = null;

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

    if (server) return;

    server = http.createServer((req, res) => {
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
        res.end(JSON.stringify({ status: "alive", port: INTERNAL_PORT }));
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

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, mode: "prefilled" }));
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

    server.listen(INTERNAL_PORT, "127.0.0.1");

    server.on("error", (e: any) => {
      if (e.code !== "EADDRINUSE") {
        console.error("[SendToPi Internal Server Error]:", e);
      }
    });
  });

  pi.on("session_shutdown", async () => {
    if (server) {
      server.close();
      server = null;
    }
    activeCtx = null;
  });
}
