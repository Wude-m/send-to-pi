/**
 * send-to-pi Bridge Daemon
 *
 * Listens on: 127.0.0.1:18090 (receives Chrome extension requests)
 * Dynamically discovers active Pi sessions (18091 ~ 18095 or ~/.pi/send-to-pi/sessions.json)
 * Supports 4-layer adaptive cold-start terminal launching & clipboard fallback.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  BRIDGE_PORT,
  PI_INTERNAL_PORT,
  PI_INTERNAL_PORT_START,
  PI_INTERNAL_PORT_END,
  ACTIVE_SESSION_FILE,
  SESSION_REGISTRY_FILE,
  PENDING_FILE,
  getWorkDir,
  readLastTerminal,
  shouldFocusOnSend,
} = require('./config');
const { launchTerminal, focusTerminal } = require('./launchers');
const { copyToClipboard } = require('./clipboard');

function checkPiHealth(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: 400,
      },
      (res) => {
        if (res.statusCode === 200) {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            try {
              const info = JSON.parse(raw);
              resolve({ ok: true, port, info });
            } catch {
              resolve({ ok: true, port });
            }
          });
        } else {
          resolve({ ok: false, port });
        }
      }
    );

    req.on('error', () => resolve({ ok: false, port }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, port });
    });
    req.end();
  });
}

function readSessionRegistry() {
  if (!fs.existsSync(SESSION_REGISTRY_FILE)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_REGISTRY_FILE, 'utf8'));
    const sessions = Array.isArray(parsed) ? parsed : parsed && parsed.sessions;
    if (!Array.isArray(sessions)) return null;
    return sessions.filter((session) => session && Number.isInteger(Number(session.port)));
  } catch (_e) {
    return null;
  }
}

function writeSessionRegistry(sessions) {
  try {
    const directory = path.dirname(SESSION_REGISTRY_FILE);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = `${SESSION_REGISTRY_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(
      temporaryFile,
      JSON.stringify({ version: 2, sessions }, null, 2),
      'utf8'
    );
    fs.renameSync(temporaryFile, SESSION_REGISTRY_FILE);
  } catch (_e) {
    // Registry cleanup is best effort.
  }
}

async function discoverAllActivePis(portStart = PI_INTERNAL_PORT_START, portEnd = PI_INTERNAL_PORT_END) {
  const byPort = new Map();

  // Probe full port range in parallel so no live Pi is ever missed.
  const ports = [];
  for (let p = portStart; p <= portEnd; p++) ports.push(p);

  const registeredSessions = readSessionRegistry() || [];
  for (const s of registeredSessions) {
    const p = Number(s.port);
    if (Number.isInteger(p) && !ports.includes(p)) ports.push(p);
  }

  const healthResults = await Promise.all(ports.map((p) => checkPiHealth(p)));
  const registryByPort = new Map(registeredSessions.map((s) => [Number(s.port), s]));

  for (const h of healthResults) {
    if (!h.ok) continue;
    const reg = registryByPort.get(h.port) || {};
    const merged = {
      ...reg,
      ...(h.info || {}),
      port: h.port,
      activeAt: Math.max(
        Number((h.info && (h.info.activeAt || h.info.updatedAt)) || 0),
        Number(reg.activeAt || reg.updatedAt || 0)
      ),
    };
    byPort.set(h.port, merged);
  }

  const alive = Array.from(byPort.values()).sort(
    (a, b) => Number(b.activeAt || b.updatedAt || 0) - Number(a.activeAt || a.updatedAt || 0)
  );

  // Clean stale dead sessions from registry if it existed.
  if (registeredSessions.length > 0 && alive.length !== registeredSessions.length) {
    writeSessionRegistry(alive);
  }

  return alive;
}

async function findActivePi() {
  const all = await discoverAllActivePis();
  if (all.length > 0) {
    return { port: all[0].port, source: 'active-discovery', session: all[0] };
  }

  // Legacy fallback file check (in case user runs on a custom port outside 18091~18095).
  if (fs.existsSync(ACTIVE_SESSION_FILE)) {
    try {
      const session = JSON.parse(fs.readFileSync(ACTIVE_SESSION_FILE, 'utf8'));
      if (session && session.port) {
        const health = await checkPiHealth(Number(session.port));
        if (health.ok) {
          return {
            port: Number(session.port),
            source: 'session-file',
            session: { ...session, ...(health.info || {}) },
          };
        }
      }
    } catch (_e) {}
  }

  return null;
}

function forwardToPi(port, content) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ content });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/receive',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 1500,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(raw || '{}'));
            } catch {
              resolve({ success: true, port });
            }
          } else {
            reject(new Error(`Pi receiver on port ${port} responded with HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Pi receiver on port ${port} timed out`));
    });

    req.write(data);
    req.end();
  });
}

function formatContent(payload) {
  const { type, text, title, url, lang } = payload;
  const isZh = lang === 'zh';

  if (type === 'selection') {
    const label = isZh ? '【来源】' : '[Source]';
    return `${label}: ${title || (isZh ? '网页摘录' : 'Web Snippet')} (${url || ''})\n\n${text}\n\n`;
  }
  if (type === 'article') {
    const titleLabel = isZh ? '【网页文章】' : '[Web Article]';
    const linkLabel = isZh ? '【网页链接】' : '[Link]';
    return `${titleLabel}: ${title || (isZh ? '正文' : 'Article')}\n${linkLabel}: ${url || ''}\n\n${text}\n\n`;
  }
  if (type === 'link') {
    const label = isZh ? '【网页链接】' : '[Link]';
    return `${label}: ${url}\n\n`;
  }
  const titleLabel = isZh ? '【网页标题】' : '[Title]';
  const linkLabel = isZh ? '【网页链接】' : '[Link]';
  return `${titleLabel}: ${title || (isZh ? '网页' : 'Page')}\n${linkLabel}: ${url || ''}\n\n`;
}

function createBridgeServer(deps = {}) {
  const launch = deps.launchTerminal || launchTerminal;
  const focus = deps.focusTerminal || focusTerminal;
  const clipboard = deps.copyToClipboard || copyToClipboard;
  const discover = deps.findActivePi || findActivePi;
  const discoverAll = deps.discoverAllActivePis || discoverAllActivePis;

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const sessions = await discoverAll();
      const activePi = sessions[0] || null;
      const lastTerminal = readLastTerminal();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          version: '1.3.0',
          platform: process.platform,
          bridgePort: BRIDGE_PORT,
          defaultInternalPort: PI_INTERNAL_PORT,
          activePi: activePi
            ? {
                port: activePi.port,
                workdir: activePi.workdir,
                terminal: activePi.terminal || null,
                appName: activePi.appName || null,
                activeAt: activePi.activeAt || null,
              }
            : null,
          sessions,
          lastTerminal,
          workDir: getWorkDir(),
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/send') {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
      });

      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const payload = JSON.parse(body || '{}');
          const content = formatContent(payload);

          // 1. Hot delivery to the most recently active Pi session (100% terminal-agnostic).
          const activePi = await discover();
          if (activePi) {
            try {
              const reply = await forwardToPi(activePi.port, content);
              const sessionMeta = { ...(activePi.session || {}), ...(reply || {}) };
              if (shouldFocusOnSend()) {
                focus(sessionMeta).catch(() => {});
              }
              console.log(`[Bridge] Forwarded content to Pi on port ${activePi.port} (${sessionMeta.terminal || 'unknown'}).`);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  success: true,
                  mode: 'prefilled',
                  port: activePi.port,
                  workdir: sessionMeta.workdir || null,
                  terminal: sessionMeta.terminal || null,
                  appName: sessionMeta.appName || null,
                  message: '已直接填入活跃的 Pi 输入框！',
                })
              );
              return;
            } catch (err) {
              console.warn(`[Bridge] Forward to port ${activePi.port} failed: ${err.message}, falling back to cold start.`);
            }
          }

          // 2. Cold-start flow: write pending file and launch terminal via 4-layer adaptive launcher.
          console.log('[Bridge] No active Pi detected. Writing pending file and launching terminal...');
          fs.writeFileSync(PENDING_FILE, content, 'utf8');

          const workDir = getWorkDir();
          const launchResult = await launch(workDir);

          if (launchResult && launchResult.success) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                success: true,
                mode: 'launched',
                terminal: launchResult.terminal || 'Default Terminal',
                message: '已启动终端唤醒 Pi，内容已在输入框备好！',
              })
            );
            return;
          }

          // 3. Layer 4 fallback: copy formatted Markdown to clipboard so content is never lost.
          const copied = await clipboard(content);
          if (copied) {
            console.warn('[Bridge] Terminal launch failed; copied content to system clipboard as fallback.');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                success: true,
                mode: 'clipboard',
                error: launchResult && launchResult.error,
                message: '未能自动拉起终端，已复制到剪贴板，请直接粘贴！',
              })
            );
            return;
          }

          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              success: false,
              error: (launchResult && launchResult.error) || 'Failed to launch terminal and clipboard fallback failed.',
            })
          );
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

function startDaemon() {
  const server = createBridgeServer();

  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`===============================================`);
    console.log(`🚀 send-to-pi Bridge Daemon v1.3.0 is running!`);
    console.log(`📡 Listening on: http://127.0.0.1:${BRIDGE_PORT}`);
    console.log(`💻 Platform:     ${process.platform}`);
    console.log(`📂 Work Dir:     ${getWorkDir()}`);
    console.log(`===============================================`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Bridge Error] Port ${BRIDGE_PORT} is already in use.`);
      console.error(`If a previous instance is already running, you can keep using it.`);
      process.exit(1);
    } else {
      console.error('[Bridge Error] Unexpected server error:', err);
    }
  });

  return server;
}

if (require.main === module) {
  startDaemon();
}

module.exports = {
  startDaemon,
  createBridgeServer,
  findActivePi,
  discoverAllActivePis,
  formatContent,
};
