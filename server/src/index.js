/**
 * send-to-pi Bridge Daemon
 *
 * Listens on: 127.0.0.1:18090 (receives Chrome extension requests)
 * Dynamically discovers active Pi sessions (18091 ~ 18095 or ~/.pi/send-to-pi.json)
 */

const http = require('http');
const fs = require('fs');
const {
  BRIDGE_PORT,
  PI_INTERNAL_PORT,
  PI_INTERNAL_PORT_START,
  PI_INTERNAL_PORT_END,
  ACTIVE_SESSION_FILE,
  PENDING_FILE,
  getWorkDir,
} = require('./config');
const { launchTerminal } = require('./launchers');

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

async function findActivePi() {
  // 1. 优先读取 ~/.pi/send-to-pi.json 活跃单例信息
  if (fs.existsSync(ACTIVE_SESSION_FILE)) {
    try {
      const raw = fs.readFileSync(ACTIVE_SESSION_FILE, 'utf8');
      const session = JSON.parse(raw);
      if (session && session.port) {
        const health = await checkPiHealth(session.port);
        if (health.ok) {
          return { port: session.port, source: 'session-file', session };
        }
      }
    } catch (_e) {
      // 忽略文件解析错误，继续范围扫描
    }
  }

  // 2. 备用兜底：顺序探测端口范围 (18091 ~ 18095)
  for (let port = PI_INTERNAL_PORT_START; port <= PI_INTERNAL_PORT_END; port++) {
    const health = await checkPiHealth(port);
    if (health.ok) {
      return { port, source: 'port-scan', session: health.info };
    }
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
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 1500,
      },
      (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          reject(new Error(`Pi receiver on port ${port} responded with HTTP ${res.statusCode}`));
        }
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

function createBridgeServer() {
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
      const activePi = await findActivePi();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          platform: process.platform,
          bridgePort: BRIDGE_PORT,
          defaultInternalPort: PI_INTERNAL_PORT,
          activePi: activePi ? { port: activePi.port, source: activePi.source } : null,
          workDir: getWorkDir(),
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const content = formatContent(payload);

          // 1. 尝试动态发现当前活跃的 Pi 实例并转发
          const activePi = await findActivePi();
          if (activePi) {
            try {
              await forwardToPi(activePi.port, content);
              console.log(`[Bridge] Successfully forwarded content to Pi terminal on port ${activePi.port}.`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: true,
                  mode: 'prefilled',
                  port: activePi.port,
                  message: '已直接填入活跃的 Pi 输入框！',
                })
              );
              return;
            } catch (err) {
              console.warn(`[Bridge] Forward to port ${activePi.port} failed: ${err.message}, falling back to cold start.`);
            }
          }

          // 2. 当前没有运行中的 Pi，进行冷启动唤醒流程
          console.log('[Bridge] No active Pi detected. Writing pending file and launching terminal...');
          fs.writeFileSync(PENDING_FILE, content, 'utf8');

          const workDir = getWorkDir();
          const launchResult = await launchTerminal(workDir);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              mode: 'launched',
              terminal: launchResult.terminal || 'Default Terminal',
              message: '已启动终端唤醒 Pi，内容已在输入框备好！',
            })
          );
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

function startDaemon() {
  const server = createBridgeServer();

  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`===============================================`);
    console.log(`🚀 send-to-pi Bridge Daemon is running!`);
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

module.exports = { startDaemon, createBridgeServer, findActivePi, formatContent };
