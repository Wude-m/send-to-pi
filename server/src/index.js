/**
 * send-to-pi Bridge Daemon (v1.4.1)
 *
 * Listens on: 127.0.0.1:18090 (receives Chrome extension requests)
 * Dynamically discovers active Pi sessions (18091 ~ 18095 or ~/.pi/send-to-pi/sessions.json)
 * Supports smart long-content file offload, 4-layer adaptive cold-start launch, and clipboard fallback.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  BRIDGE_PORT,
  PI_INTERNAL_PORT,
  PI_INTERNAL_PORT_START,
  PI_INTERNAL_PORT_END,
  INBOX_DIR,
  ACTIVE_SESSION_FILE,
  SESSION_REGISTRY_FILE,
  PENDING_FILE,
  loadUserConfig,
  getWorkDir,
  readLastTerminal,
  shouldFocusOnSend,
} = require('./config');
const { launchTerminal, focusTerminal } = require('./launchers');
const { copyToClipboard } = require('./clipboard');

const INBOX_MAX_FILES = 50;
const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

function cleanShortTitle(title, maxLen = 80) {
  const s = String(title || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1).trimEnd() + '…';
}

function formatCharCount(count, isZh) {
  if (count >= 1000) {
    const k = (count / 1000).toFixed(1).replace(/\.0$/, '');
    return isZh ? `约 ${k}k 字` : `~${k}k chars`;
  }
  return isZh ? `${count} 字` : `${count} chars`;
}

function buildSafeSlug(title, url) {
  let hostPart = '';
  let pathPart = '';
  try {
    if (url) {
      const parsed = new URL(url);
      hostPart = parsed.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9]+/g, '-');
      pathPart = parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('-').replace(/[^a-zA-Z0-9]+/g, '-');
    }
  } catch {}

  const titleAscii = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const combined = [hostPart, pathPart || titleAscii]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);

  return combined || 'clip';
}

function pruneInbox(inboxDir) {
  try {
    const now = Date.now();
    const entries = fs
      .readdirSync(inboxDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => {
        const fullPath = path.join(inboxDir, name);
        try {
          return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    entries.forEach((entry, idx) => {
      if (idx >= INBOX_MAX_FILES || now - entry.mtimeMs > INBOX_MAX_AGE_MS) {
        try {
          fs.unlinkSync(entry.fullPath);
        } catch {}
      }
    });
  } catch {}
}

function saveToInboxFile({ title, url, type, markdownBody }) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const baseName = `${stamp}-${buildSafeSlug(title, url)}`;

  let targetPath = path.join(INBOX_DIR, `${baseName}.md`);
  let seq = 2;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(INBOX_DIR, `${baseName}-${seq++}.md`);
  }

  const lines = [
    `# ${title || 'Web Clip'}`,
    '',
    ...(url ? [`- Source: ${url}`] : []),
    `- Captured: ${now.toISOString()}`,
    ...(type ? [`- Type: ${type}`] : []),
    '',
    '---',
    '',
    markdownBody.trim(),
    '',
  ];
  fs.writeFileSync(targetPath, lines.join('\n'), 'utf8');
  pruneInbox(INBOX_DIR);
  return targetPath;
}

function formatContent(payload) {
  const { type, text, title, url, lang } = payload;
  const isZh = lang === 'zh';
  const shortTitle = cleanShortTitle(title);

  if (type === 'selection') {
    const label = isZh ? '【来源】' : '[Source]';
    return `${label}: ${shortTitle || (isZh ? '网页摘录' : 'Web Snippet')} (${url || ''})\n\n${text}\n\n`;
  }
  if (type === 'article') {
    const titleLabel = isZh ? '【网页文章】' : '[Web Article]';
    const linkLabel = isZh ? '【网页链接】' : '[Link]';
    return `${titleLabel}: ${shortTitle || (isZh ? '正文' : 'Article')}\n${linkLabel}: ${url || ''}\n\n${text}\n\n`;
  }
  if (type === 'link') {
    const label = isZh ? '【网页链接】' : '[Link]';
    return `${label}: ${url}\n\n`;
  }
  const titleLabel = isZh ? '【网页标题】' : '[Title]';
  const linkLabel = isZh ? '【网页链接】' : '[Link]';
  return `${titleLabel}: ${shortTitle || (isZh ? '网页' : 'Page')}\n${linkLabel}: ${url || ''}\n\n`;
}

function prepareColdStartContent(payload, inlineContent) {
  const cfg = loadUserConfig();
  const mode = ['smart', 'inline', 'link'].includes(payload.deliveryMode)
    ? payload.deliveryMode
    : cfg.deliveryMode;
  const rawLimit = Number(payload.inlineLimit) || cfg.inlineLimit;
  const inlineLimit = Number.isFinite(rawLimit) && rawLimit >= 200 ? Math.floor(rawLimit) : 1500;
  const isZh = payload.lang === 'zh';
  const shortTitle = cleanShortTitle(payload.title);
  const url = String(payload.url || '');
  const body = typeof payload.text === 'string' && payload.text.trim() ? payload.text.trim() : '';

  if (mode === 'link' && payload.type === 'article' && url) {
    const titleLabel = isZh ? '【网页标题】' : '[Title]';
    const linkLabel = isZh ? '【网页链接】' : '[Link]';
    return {
      text: `${titleLabel}: ${shortTitle || (isZh ? '网页' : 'Page')}\n${linkLabel}: ${url}\n\n`,
      delivery: 'link',
      savedFile: null,
    };
  }

  if (mode === 'smart' && body.length > inlineLimit) {
    const savedFile = saveToInboxFile({
      title: payload.title || (isZh ? '网页内容' : 'Web Clip'),
      url,
      type: payload.type || 'article',
      markdownBody: body,
    });
    const headerLabel =
      payload.type === 'selection'
        ? isZh ? '【来源】' : '[Source]'
        : isZh ? '【网页文章】' : '[Web Article]';
    const linkLabel = isZh ? '【网页链接】' : '[Link]';
    const fileLabel = isZh ? '【本地正文】' : '[Saved Content]';
    const lines = [
      `${headerLabel}: ${shortTitle || (isZh ? '网页内容' : 'Web Clip')}`,
      ...(url ? [`${linkLabel}: ${url}`] : []),
      `${fileLabel}: @${savedFile} (${formatCharCount(body.length, isZh)})`,
      '',
      '',
    ];
    return { text: lines.join('\n'), delivery: 'file', savedFile };
  }

  return { text: inlineContent, delivery: 'inline', savedFile: null };
}

function forwardToPi(port, payload, content) {
  return new Promise((resolve, reject) => {
    const cfg = loadUserConfig();
    const data = JSON.stringify({
      content,
      type: payload.type,
      text: payload.text,
      title: payload.title,
      url: payload.url,
      lang: payload.lang,
      deliveryMode: payload.deliveryMode || cfg.deliveryMode,
      inlineLimit: payload.inlineLimit || cfg.inlineLimit,
    });
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
        timeout: 1800,
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

function createBridgeServer(deps = {}) {
  const launch = deps.launchTerminal || launchTerminal;
  const focus = deps.focusTerminal || focusTerminal;
  const clipboard = deps.copyToClipboard || copyToClipboard;
  const discover = deps.findActivePi || findActivePi;
  const discoverAll = deps.discoverAllActivePis || discoverAllActivePis;
  const pendingFile = deps.pendingFile || PENDING_FILE;

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
      const cfg = loadUserConfig();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          version: '1.4.1',
          platform: process.platform,
          bridgePort: BRIDGE_PORT,
          defaultInternalPort: PI_INTERNAL_PORT,
          deliveryMode: cfg.deliveryMode,
          inlineLimit: cfg.inlineLimit,
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
              const reply = await forwardToPi(activePi.port, payload, content);
              const sessionMeta = { ...(activePi.session || {}), ...(reply || {}) };
              if (shouldFocusOnSend()) {
                focus(sessionMeta).catch(() => {});
              }
              console.log(`[Bridge] Forwarded content to Pi on port ${activePi.port} (${sessionMeta.terminal || 'unknown'}, delivery=${reply.delivery || 'inline'}).`);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(
                JSON.stringify({
                  success: true,
                  mode: 'prefilled',
                  delivery: reply.delivery || 'inline',
                  savedFile: reply.savedFile || null,
                  charCount: reply.charCount || content.length,
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

          // 2. Cold-start flow: smart-offload long content before writing pending file.
          console.log('[Bridge] No active Pi detected. Writing pending file and launching terminal...');
          const prepared = prepareColdStartContent(payload, content);
          fs.writeFileSync(pendingFile, prepared.text, 'utf8');

          const workDir = getWorkDir();
          const launchResult = await launch(workDir);

          if (launchResult && launchResult.success) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                success: true,
                mode: 'launched',
                delivery: prepared.delivery,
                savedFile: prepared.savedFile,
                terminal: launchResult.terminal || 'Default Terminal',
                message: '已启动终端唤醒 Pi，内容已在输入框备好！',
              })
            );
            return;
          }

          // Launch failed — remove pending file immediately so it never ghosts into a future session.
          try {
            if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
          } catch (_cleanupErr) {}

          // 3. Layer 4 fallback: copy formatted Markdown to clipboard so content is never lost.
          const copied = await clipboard(prepared.text);
          if (copied) {
            console.warn('[Bridge] Terminal launch failed; copied content to system clipboard as fallback.');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                success: true,
                mode: 'clipboard',
                delivery: prepared.delivery,
                savedFile: prepared.savedFile,
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
    console.log(`🚀 send-to-pi Bridge Daemon v1.4.1 is running!`);
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
  prepareColdStartContent,
};
