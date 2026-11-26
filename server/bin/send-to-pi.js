#!/usr/bin/env node

/**
 * CLI Entry point for send-to-pi
 */

const { startDaemon, discoverAllActivePis } = require('../src/index');
const http = require('http');
const {
  BRIDGE_PORT,
  USER_CONFIG_FILE,
  LAST_TERMINAL_FILE,
  INBOX_DIR,
  loadUserConfig,
  readLastTerminal,
} = require('../src/config');

const args = process.argv.slice(2);
const command = args[0] || 'start';

function checkBridge() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: BRIDGE_PORT,
        path: '/health',
        method: 'GET',
        timeout: 1200,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ ok: true, statusCode: res.statusCode, info: JSON.parse(data) });
          } catch {
            resolve({ ok: true, statusCode: res.statusCode, info: null });
          }
        });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, timeout: true });
    });
    req.end();
  });
}

if (command === 'status' || command === 'check') {
  (async () => {
    const [bridge, directSessions] = await Promise.all([
      checkBridge(),
      discoverAllActivePis(),
    ]);

    if (bridge.ok) {
      console.log(`✅ Bridge daemon is running on http://127.0.0.1:${BRIDGE_PORT}`);
      if (bridge.info) {
        console.log(JSON.stringify(bridge.info, null, 2));
      }
    } else {
      console.log(`ℹ️  Bridge daemon is NOT running on port ${BRIDGE_PORT} (optional: needed only for cold-start launch).`);
    }

    if (directSessions.length > 0) {
      console.log(`\n✅ Active Pi sessions ready for zero-daemon direct send (${directSessions.length}):`);
      for (const s of directSessions) {
        const term = s.appName || s.terminal || 'unknown';
        console.log(`   - :${s.port}  [${term}]  ${s.workdir || ''}  (pid ${s.pid})`);
      }
      process.exit(0);
    } else {
      console.log('\n⚠️  No active Pi sessions detected on ports 18091~18095.');
      process.exit(bridge.ok ? 0 : 1);
    }
  })();
} else if (command === 'config') {
  const cfg = loadUserConfig();
  const last = readLastTerminal();
  console.log(`Config file:        ${USER_CONFIG_FILE}`);
  console.log(`Last terminal file: ${LAST_TERMINAL_FILE}`);
  console.log(`Inbox directory:    ${INBOX_DIR}`);
  console.log('\nEffective config:');
  console.log(JSON.stringify(cfg, null, 2));
  if (last) {
    console.log('\nLast detected Pi terminal:');
    console.log(JSON.stringify(last, null, 2));
  }
  console.log(`\nExample ${USER_CONFIG_FILE}:`);
  console.log(
    JSON.stringify(
      {
        deliveryMode: 'smart',
        inlineLimit: 1500,
        terminal: 'rex',
        launchCommand: 'rex run --interactive --cwd "{workdir}" --keep-open -- pi',
        focusOnSend: false,
      },
      null,
      2
    )
  );
  process.exit(0);
} else if (command === 'extension' || command === 'ext' || command === 'open-extension') {
  const path = require('path');
  const { spawn } = require('child_process');
  const extDir = path.resolve(__dirname, '../../chrome-extension');

  console.log(`\n📦 Chrome Extension folder:`);
  console.log(`   ${extDir}\n`);
  console.log(`👉 Quick steps to load into Chrome / Edge:`);
  console.log(`   1. Open chrome://extensions/ in your browser`);
  console.log(`   2. Toggle on "Developer mode" in the top-right corner`);
  console.log(`   3. Click "Load unpacked" and select the folder opened above!\n`);

  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [extDir], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [extDir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [extDir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_e) {}
  process.exit(0);
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
Usage: send-to-pi [command]

Commands:
  start          Start the bridge daemon (optional: enables cold-start launch)
  status         Check bridge daemon and active Pi sessions (direct mode)
  config         Show config file path and effective settings
  extension      Open the Chrome extension folder to load in browser
  help           Show this help message

Options via Environment Variables (or ~/.pi/send-to-pi/config.json):
  PI_BRIDGE_PORT     Daemon listening port (default: 18090)
  PI_INTERNAL_PORT   Pi session receiver start port (default: 18091)
  PI_DELIVERY_MODE   smart (default) | inline | link
  PI_INLINE_LIMIT    Char limit before smart mode saves to inbox @file (default: 1500)
  PI_WORKDIR         Working directory to launch Pi terminal in
  PI_TERMINAL        Preferred terminal (rex, ghostty, iterm2, warp, wezterm, kitty, alacritty, wt, terminal)
  PI_LAUNCH_CMD      Custom launch command template, supports {workdir}
  PI_FOCUS_ON_SEND   Set to "true" to focus the terminal app after sending (macOS)
`);
  process.exit(0);
} else {
  startDaemon();
}
