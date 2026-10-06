#!/usr/bin/env node

/**
 * CLI Entry point for send-to-pi
 */

const { startDaemon } = require('../src/index');
const http = require('http');
const { BRIDGE_PORT } = require('../src/config');

const args = process.argv.slice(2);
const command = args[0] || 'start';

if (command === 'status' || command === 'check') {
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path: '/health',
      method: 'GET',
      timeout: 1500,
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          console.log(`✅ send-to-pi daemon is running healthy on http://127.0.0.1:${BRIDGE_PORT}`);
          console.log(JSON.stringify(info, null, 2));
        } catch {
          console.log(`✅ Daemon is alive (status ${res.statusCode})`);
        }
        process.exit(0);
      });
    }
  );

  req.on('error', () => {
    console.log(`❌ send-to-pi daemon is NOT running on port ${BRIDGE_PORT}`);
    process.exit(1);
  });

  req.on('timeout', () => {
    console.log(`⚠️ Connection to daemon timed out`);
    req.destroy();
    process.exit(1);
  });

  req.end();
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
Usage: send-to-pi [command] [options]

Commands:
  start          Start the bridge daemon (default)
  status         Check if the bridge daemon is running
  help           Show this help message

Options via Environment Variables:
  PI_BRIDGE_PORT     Daemon listening port (default: 18090)
  PI_INTERNAL_PORT   Pi session receiver port (default: 18091)
  PI_WORKDIR         Working directory to launch Pi terminal in
  PI_TERMINAL        Preferred terminal emulator (e.g. ghostty, iterm2, alacritty)
`);
  process.exit(0);
} else {
  startDaemon();
}
