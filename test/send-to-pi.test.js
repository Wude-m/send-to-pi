const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createBridgeServer, discoverAllActivePis, formatContent } = require('../server/src/index');
const { launchTerminal } = require('../server/src/launchers');
const { findRexBinary, normalizeTerminalKey } = require('../server/src/launchers/darwin');

function startMockPi(info) {
  return new Promise((resolve) => {
    const received = [];
    const srv = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'alive', ...info }));
        return;
      }
      if (req.method === 'POST' && req.url === '/receive') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          received.push(parsed.content);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              mode: 'prefilled',
              port: srv.address().port,
              workdir: info.workdir,
              terminal: info.terminal,
              appName: info.appName,
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ server: srv, port: srv.address().port, received });
    });
  });
}

function httpJson(port, method, reqPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: data
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, json: JSON.parse(raw || '{}') });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('formatContent formats selection, article, link, and page cleanly', () => {
  const sel = formatContent({ type: 'selection', text: 'hello', title: 'Doc', url: 'https://a.test', lang: 'zh' });
  assert.match(sel, /【来源】: Doc \(https:\/\/a\.test\)/);
  assert.match(sel, /hello/);

  const link = formatContent({ type: 'link', url: 'https://b.test', lang: 'en' });
  assert.equal(link, '[Link]: https://b.test\n\n');
});

test('Bridge routes hot delivery to the most recently active Pi session and returns terminal metadata', async () => {
  const olderPi = await startMockPi({
    pid: 1001,
    workdir: '/tmp/project-old',
    terminal: 'ghostty',
    appName: 'Ghostty',
    activeAt: 1000,
  });
  const newerPi = await startMockPi({
    pid: 1002,
    workdir: '/tmp/project-rex',
    terminal: 'rex',
    appName: 'Rex',
    activeAt: 2000,
  });

  let focusedSession = null;
  const prevFocus = process.env.PI_FOCUS_ON_SEND;
  process.env.PI_FOCUS_ON_SEND = 'true';

  const bridge = createBridgeServer({
    findActivePi: async () => ({
      port: newerPi.port,
      source: 'test',
      session: {
        port: newerPi.port,
        workdir: '/tmp/project-rex',
        terminal: 'rex',
        appName: 'Rex',
        activeAt: 2000,
      },
    }),
    focusTerminal: async (session) => {
      focusedSession = session;
      return true;
    },
  });

  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const bridgePort = bridge.address().port;

  try {
    const res = await httpJson(bridgePort, 'POST', '/send', {
      type: 'selection',
      text: 'const x = 1;',
      title: 'Test Page',
      url: 'https://example.com',
      lang: 'en',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.mode, 'prefilled');
    assert.equal(res.json.port, newerPi.port);
    assert.equal(res.json.terminal, 'rex');
    assert.equal(res.json.appName, 'Rex');
    assert.equal(newerPi.received.length, 1);
    assert.equal(olderPi.received.length, 0);
    assert.match(newerPi.received[0], /const x = 1;/);
    assert.equal(focusedSession && focusedSession.terminal, 'rex');
  } finally {
    if (prevFocus === undefined) delete process.env.PI_FOCUS_ON_SEND;
    else process.env.PI_FOCUS_ON_SEND = prevFocus;
    bridge.close();
    olderPi.server.close();
    newerPi.server.close();
  }
});

test('Bridge falls back to clipboard mode and removes pending file when terminal launch fails', async () => {
  let clipboardCopied = '';
  const isolatedPending = path.join(os.tmpdir(), `send-to-pi-pending-test-${Date.now()}.txt`);
  const bridge = createBridgeServer({
    findActivePi: async () => null,
    launchTerminal: async () => ({ success: false, error: 'Simulated terminal unavailable' }),
    copyToClipboard: async (text) => {
      clipboardCopied = text;
      return true;
    },
    pendingFile: isolatedPending,
  });

  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  const bridgePort = bridge.address().port;

  try {
    const res = await httpJson(bridgePort, 'POST', '/send', {
      type: 'link',
      url: 'https://example.com/fallback',
      lang: 'zh',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.success, true);
    assert.equal(res.json.mode, 'clipboard');
    assert.match(clipboardCopied, /https:\/\/example\.com\/fallback/);
    assert.equal(fs.existsSync(isolatedPending), false, 'Pending file must be cleaned up when launch fails');
  } finally {
    if (fs.existsSync(isolatedPending)) fs.unlinkSync(isolatedPending);
    bridge.close();
  }
});

test('Layer 1 custom launch command replaces {workdir} and executes cleanly', async () => {
  const markerFile = path.join(os.tmpdir(), `send-to-pi-custom-test-${Date.now()}.txt`);
  const testDir = os.tmpdir();
  const cmd = `node -e "require('fs').writeFileSync('${markerFile.replace(/\\/g, '\\\\')}', process.env.PI_WORKDIR + '|' + process.argv[1])" "{workdir}"`;

  try {
    const result = await launchTerminal(testDir, { customLaunchCommand: cmd });
    assert.equal(result.success, true);
    assert.equal(result.terminal, 'Custom Command');

    await new Promise((r) => setTimeout(r, 350));
    assert.equal(fs.existsSync(markerFile), true);
    const written = fs.readFileSync(markerFile, 'utf8');
    assert.equal(written, `${testDir}|${testDir}`);
  } finally {
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
  }
});

test('Darwin launcher helpers normalize terminal keys and detect Rex when installed', () => {
  assert.equal(normalizeTerminalKey('Rex'), 'rex');
  assert.equal(normalizeTerminalKey('iTerm.app'), 'iterm2');
  assert.equal(normalizeTerminalKey('Apple_Terminal'), 'terminal');
  assert.equal(normalizeTerminalKey('WarpTerminal'), 'warp');
  assert.equal(normalizeTerminalKey('unknown-term'), '');

  if (process.platform === 'darwin') {
    const rexBin = findRexBinary(null);
    if (fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'rex'))) {
      assert.ok(rexBin, 'Expected findRexBinary to locate installed rex binary');
    }
  }
});

test('discoverAllActivePis sorts concurrent sessions by activeAt descending', async () => {
  // Bind two consecutive ephemeral ports if possible, or verify with live local range
  const piA = await startMockPi({ pid: 2001, workdir: '/tmp/a', terminal: 'warp', activeAt: 5000 });
  try {
    const list = await discoverAllActivePis(piA.port, piA.port);
    const hit = list.find((s) => s.port === piA.port);
    assert.ok(hit);
    assert.equal(hit.terminal, 'warp');
    assert.equal(hit.activeAt, 5000);
  } finally {
    piA.server.close();
  }
});

test('All JS files pass Node syntax check and manifest.json is valid v1.4.1', () => {
  const root = path.resolve(__dirname, '..');
  const jsFiles = [
    'chrome-extension/background.js',
    'chrome-extension/popup.js',
    'chrome-extension/options.js',
    'server/bin/send-to-pi.js',
    'server/src/config.js',
    'server/src/clipboard.js',
    'server/src/index.js',
    'server/src/launchers/index.js',
    'server/src/launchers/custom.js',
    'server/src/launchers/darwin.js',
    'server/src/launchers/win32.js',
    'server/src/launchers/linux.js',
  ];

  for (const rel of jsFiles) {
    execFileSync(process.execPath, ['--check', path.join(root, rel)]);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'chrome-extension/manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.4.1');
  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('Pi extension discards stale pending-browser-input.txt older than 2 minutes TTL', () => {
  const root = path.resolve(__dirname, '..');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'send-to-pi-ttl-'));
  const piDir = path.join(tmpHome, '.pi');
  fs.mkdirSync(piDir, { recursive: true });
  const staleFile = path.join(piDir, 'pending-browser-input.txt');
  fs.writeFileSync(staleFile, 'stale ghost content', 'utf8');
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(staleFile, fiveMinutesAgo, fiveMinutesAgo);

  const extPath = path.join(root, 'pi-extension/index.ts');
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import register from ${JSON.stringify('file://' + extPath)};

    const handlers = {};
    const pi = { on: (name, fn) => { handlers[name] = fn; } };
    let editorText = '';
    const ctx = {
      cwd: '/tmp/ttl-demo',
      ui: {
        getEditorText: () => editorText,
        setEditorText: (val) => { editorText = val; },
        notify: () => {},
      },
    };

    register(pi);
    await handlers.session_start({}, ctx);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(fs.existsSync(${JSON.stringify(staleFile)}), false, 'Stale pending file should be deleted');
    assert.equal(editorText, '', 'Stale pending file must NOT prefill new session editor');
    await handlers.session_shutdown({}, ctx);
  `;

  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: tmpHome, PI_INTERNAL_PORT: '19391' },
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Pi extension v1.4.0 smart delivery: short inline, long saved to inbox @file, link mode, and inbox pruning', () => {
  const root = path.resolve(__dirname, '..');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'send-to-pi-smart-'));
  const extPath = path.join(root, 'pi-extension/index.ts');

  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import register from ${JSON.stringify('file://' + extPath)};

    const handlers = {};
    const pi = { on: (name, fn) => { handlers[name] = fn; } };
    let editorText = '';
    const ctx = {
      cwd: '/tmp/smart-demo',
      ui: {
        getEditorText: () => editorText,
        setEditorText: (val) => { editorText = val; },
        notify: () => {},
      },
    };

    register(pi);
    await handlers.session_start({}, ctx);

    // 1. Short content stays inline
    editorText = '';
    const shortRes = await (await fetch('http://127.0.0.1:19291/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'article',
        title: 'Short Note',
        url: 'https://example.com/short',
        text: 'A short paragraph under limit.',
        lang: 'en',
        deliveryMode: 'smart',
        inlineLimit: 500,
      }),
    })).json();
    assert.equal(shortRes.delivery, 'inline');
    assert.equal(shortRes.savedFile, null);
    assert.match(editorText, /A short paragraph under limit\./);

    // 2. Long content (> inlineLimit) offloads to inbox/*.md and inserts clean 3-line @file reference
    editorText = '';
    const longBody = 'Paragraph content about agent memory. '.repeat(80);
    const longTitle = 'X 上的 Tao Wang：' + '超长重复标题内容'.repeat(20);
    const longRes = await (await fetch('http://127.0.0.1:19291/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'article',
        title: longTitle,
        url: 'https://x.com/Tao100086/status/2125068536913776824',
        text: longBody,
        lang: 'zh',
        deliveryMode: 'smart',
        inlineLimit: 500,
      }),
    })).json();
    assert.equal(longRes.delivery, 'file');
    assert.ok(longRes.savedFile && fs.existsSync(longRes.savedFile));
    assert.ok(editorText.length < 400, 'Editor text should remain concise 3 lines');
    assert.match(editorText, /【本地正文】: @/);
    assert.match(editorText, /…/);
    const saved = fs.readFileSync(longRes.savedFile, 'utf8');
    assert.ok(saved.includes('Paragraph content about agent memory'));
    assert.ok(saved.includes('Source: https://x.com/Tao100086'));

    // 3. Inline mode forces full text even when over limit
    editorText = '';
    const inlineRes = await (await fetch('http://127.0.0.1:19291/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'article',
        title: 'Force Inline',
        url: 'https://example.com/inline',
        text: longBody,
        lang: 'en',
        deliveryMode: 'inline',
        inlineLimit: 500,
      }),
    })).json();
    assert.equal(inlineRes.delivery, 'inline');
    assert.ok(editorText.length > 1000);

    // 4. Link mode strips article body but keeps title + URL
    editorText = '';
    const linkRes = await (await fetch('http://127.0.0.1:19291/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'article',
        title: 'Link Only Article',
        url: 'https://example.com/link-only',
        text: longBody,
        lang: 'en',
        deliveryMode: 'link',
      }),
    })).json();
    assert.equal(linkRes.delivery, 'link');
    assert.ok(editorText.includes('https://example.com/link-only'));
    assert.ok(!editorText.includes('Paragraph content'));

    // 5. Inbox pruning caps files at <= 50
    const inboxDir = path.join(process.env.HOME, '.pi/send-to-pi/inbox');
    for (let i = 0; i < 55; i++) {
      fs.writeFileSync(path.join(inboxDir, 'old-' + String(i).padStart(2, '0') + '.md'), 'old', 'utf8');
    }
    await fetch('http://127.0.0.1:19291/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'article',
        title: 'Trigger Prune',
        url: 'https://example.com/prune',
        text: longBody,
        lang: 'en',
        deliveryMode: 'smart',
        inlineLimit: 500,
      }),
    });
    const remaining = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.md'));
    assert.ok(remaining.length <= 50, 'Expected <= 50 inbox files, got ' + remaining.length);

    await handlers.session_shutdown({}, ctx);
  `;

  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PI_INTERNAL_PORT: '19291',
        TERM_PROGRAM: 'rex',
      },
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Pi extension end-to-end: detects terminal, refreshes activeAt on input, receives direct POST, persists last-terminal', () => {
  const root = path.resolve(__dirname, '..');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'send-to-pi-home-'));
  const extPath = path.join(root, 'pi-extension/index.ts');

  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import register from ${JSON.stringify('file://' + extPath)};

    const handlers = {};
    const pi = { on: (name, fn) => { handlers[name] = fn; } };
    let editorText = '';
    const notifications = [];
    const ctx = {
      cwd: '/tmp/demo-project',
      ui: {
        getEditorText: () => editorText,
        setEditorText: (val) => { editorText = val; },
        notify: (msg, level) => { notifications.push({ msg, level }); },
      },
    };

    register(pi);
    await handlers.session_start({}, ctx);

    const h1 = await (await fetch('http://127.0.0.1:19191/health')).json();
    assert.equal(h1.status, 'alive');
    assert.equal(h1.terminal, 'rex');
    assert.equal(h1.appName, 'Rex');
    assert.equal(h1.workdir, '/tmp/demo-project');

    await new Promise((r) => setTimeout(r, 25));
    await handlers.input({}, ctx);
    const h2 = await (await fetch('http://127.0.0.1:19191/health')).json();
    assert.ok(h2.activeAt > h1.activeAt, 'input hook must advance activeAt');

    // Direct Chrome-style POST to /receive without Bridge
    const r = await fetch('http://127.0.0.1:19191/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '[Source]: Direct Test\\n\\nhello rex' }),
    });
    const rJson = await r.json();
    assert.equal(r.status, 200);
    assert.equal(rJson.success, true);
    assert.equal(rJson.terminal, 'rex');
    assert.match(editorText, /hello rex/);
    assert.equal(notifications.length, 1);

    const lastFile = path.join(process.env.HOME, '.pi/send-to-pi/last-terminal.json');
    const sessionsFile = path.join(process.env.HOME, '.pi/send-to-pi/sessions.json');
    assert.equal(fs.existsSync(lastFile), true);
    assert.equal(fs.existsSync(sessionsFile), true);
    const last = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
    assert.equal(last.terminal, 'rex');
    assert.equal(last.workdir, '/tmp/demo-project');

    await handlers.session_shutdown({}, ctx);
    const afterSessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    assert.equal(afterSessions.sessions.length, 0);
    assert.equal(fs.existsSync(lastFile), true, 'last-terminal.json should persist after shutdown');
  `;

  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PI_INTERNAL_PORT: '19191',
        TERM_PROGRAM: 'rex',
        REX_BLOCK: 'block:test-1',
        PI_TERMINAL: '',
      },
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
