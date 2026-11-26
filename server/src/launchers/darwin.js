/**
 * macOS Adaptive Terminal Launcher for send-to-pi
 *
 * Resolution order:
 * 1. Explicit preference (PI_TERMINAL / config.json terminal)
 * 2. Last terminal that actually ran Pi (~/.pi/send-to-pi/last-terminal.json)
 * 3. Currently running supported terminal apps
 * 4. Installed supported terminals (Rex, Ghostty, WezTerm, Warp, kitty, Alacritty, iTerm2)
 * 5. macOS built-in Terminal.app fallback
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runCommand(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || '').trim()));
      } else {
        resolve((stdout || '').trim());
      }
    });
  });
}

function runAppleScript(script) {
  return runCommand('osascript', ['-e', script], 5000);
}

function shellQuoteSingle(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function spawnDetached(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      let failed = false;
      child.on('error', () => {
        failed = true;
        resolve(false);
      });
      child.unref();
      setTimeout(() => {
        if (!failed) resolve(true);
      }, 200);
    } catch (_err) {
      resolve(false);
    }
  });
}

function findRexBinary(lastTerminal) {
  const candidates = [];
  if (lastTerminal && lastTerminal.rexBin) {
    candidates.push(lastTerminal.rexBin);
  }
  if (process.env.REX_BIN_DIR) {
    candidates.push(path.join(process.env.REX_BIN_DIR, 'rex'));
  }
  const home = os.homedir();
  candidates.push(path.join(home, '.local', 'bin', 'rex'));
  candidates.push('/usr/local/bin/rex');

  // Scan RexServer Versions directory (prefer Current or highest numeric build).
  const versionsDir = path.join(
    home,
    'Library',
    'Application Support',
    'com.superlogical.rex',
    'RexServer',
    'Versions'
  );
  if (fs.existsSync(versionsDir)) {
    candidates.push(path.join(versionsDir, 'Current', 'Rex Server.app', 'Contents', 'MacOS', 'rex'));
    try {
      const entries = fs
        .readdirSync(versionsDir)
        .filter((name) => /^\d+$/.test(name))
        .sort((a, b) => Number(b) - Number(a));
      for (const ver of entries) {
        candidates.push(path.join(versionsDir, ver, 'Rex Server.app', 'Contents', 'MacOS', 'rex'));
      }
    } catch (_err) {}
  }

  for (const binPath of candidates) {
    if (binPath && fs.existsSync(binPath)) {
      return binPath;
    }
  }
  return null;
}

async function getRunningAppNames() {
  try {
    const out = await runAppleScript(
      'tell application "System Events" to get name of every application process whose background only is false'
    );
    return new Set(
      out
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  } catch (_err) {
    return new Set();
  }
}

function hasApp(appNames) {
  const list = Array.isArray(appNames) ? appNames : [appNames];
  const homeApps = path.join(os.homedir(), 'Applications');
  return list.some(
    (name) =>
      fs.existsSync(path.join('/Applications', `${name}.app`)) ||
      fs.existsSync(path.join(homeApps, `${name}.app`))
  );
}

const ADAPTERS = {
  rex: {
    label: 'Rex',
    processNames: ['rex'],
    isInstalled: (lastTerminal) => Boolean(findRexBinary(lastTerminal) || hasApp(['Rex', 'Rex Beta'])),
    launch: async (workDir, lastTerminal) => {
      const rexBin = findRexBinary(lastTerminal);
      if (!rexBin) return false;
      if (hasApp('Rex')) {
        await spawnDetached('open', ['-a', 'Rex']);
      } else if (hasApp('Rex Beta')) {
        await spawnDetached('open', ['-a', 'Rex Beta']);
      }
      try {
        await runCommand(rexBin, ['run', '--interactive', '--cwd', workDir, '--keep-open', '--', 'pi'], 6000);
        return true;
      } catch (_err) {
        return false;
      }
    },
  },
  ghostty: {
    label: 'Ghostty',
    processNames: ['ghostty'],
    isInstalled: () => hasApp('Ghostty'),
    launch: async (workDir) => {
      const cmd = `cd ${shellQuoteSingle(workDir)} && pi`;
      return await spawnDetached('open', ['-na', 'Ghostty', '--args', '-e', 'sh', '-lc', cmd]);
    },
  },
  wezterm: {
    label: 'WezTerm',
    processNames: ['wezterm', 'wezterm-gui'],
    isInstalled: () => hasApp('WezTerm'),
    launch: async (workDir) => {
      return await spawnDetached('open', ['-a', 'WezTerm', '--args', 'start', '--cwd', workDir, 'pi']);
    },
  },
  warp: {
    label: 'Warp',
    processNames: ['warp'],
    isInstalled: () => hasApp('Warp'),
    launch: async (workDir) => {
      const uri = `warp://action/new_tab?path=${encodeURIComponent(workDir)}`;
      const opened = await spawnDetached('open', [uri]);
      if (!opened) return false;
      // Launch pi via Warp tab; if AppleScript keystroke isn't permitted, Warp still opens in workDir.
      try {
        await new Promise((r) => setTimeout(r, 400));
        await runAppleScript('tell application "Warp" to activate');
        await runAppleScript('tell application "System Events" to keystroke "pi" & return');
      } catch (_err) {}
      return true;
    },
  },
  kitty: {
    label: 'kitty',
    processNames: ['kitty'],
    isInstalled: () => hasApp('kitty'),
    launch: async (workDir) => {
      return await spawnDetached('open', ['-a', 'kitty', '--args', '--directory', workDir, 'sh', '-lc', 'pi']);
    },
  },
  alacritty: {
    label: 'Alacritty',
    processNames: ['alacritty'],
    isInstalled: () => hasApp('Alacritty'),
    launch: async (workDir) => {
      return await spawnDetached('open', [
        '-na',
        'Alacritty',
        '--args',
        '--working-directory',
        workDir,
        '-e',
        'sh',
        '-lc',
        'pi',
      ]);
    },
  },
  iterm2: {
    label: 'iTerm2',
    processNames: ['iterm2', 'iterm'],
    isInstalled: () => hasApp(['iTerm', 'iTerm2']),
    launch: async (workDir) => {
      const itermScript = `
        tell application "iTerm"
          activate
          try
            set newWindow to (create window with default profile)
            tell current session of newWindow
              write text "cd " & quoted form of "${workDir.replace(/"/g, '\\"')}" & " && pi"
            end tell
          on error
            tell current window
              create tab with default profile
              tell current session to write text "cd " & quoted form of "${workDir.replace(/"/g, '\\"')}" & " && pi"
            end tell
          end try
        end tell
      `;
      try {
        await runAppleScript(itermScript);
        return true;
      } catch (_err) {
        return false;
      }
    },
  },
  terminal: {
    label: 'Terminal.app',
    processNames: ['terminal'],
    isInstalled: () => true,
    launch: async (workDir) => {
      const terminalScript = `
        tell application "Terminal"
          activate
          do script "cd " & quoted form of "${workDir.replace(/"/g, '\\"')}" & " && pi"
        end tell
      `;
      try {
        await runAppleScript(terminalScript);
        return true;
      } catch (_err) {
        return false;
      }
    },
  },
};

function normalizeTerminalKey(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return '';
  if (key === 'iterm' || key === 'iterm.app') return 'iterm2';
  if (key === 'apple_terminal' || key === 'terminal.app') return 'terminal';
  if (key === 'warpterminal') return 'warp';
  return ADAPTERS[key] ? key : '';
}

async function launchDarwin(workDir, options = {}) {
  const preferred = normalizeTerminalKey(options.preferredTerminal || process.env.PI_TERMINAL);
  const lastKey = normalizeTerminalKey(options.lastTerminal && options.lastTerminal.terminal);
  const defaultOrder = ['rex', 'ghostty', 'wezterm', 'warp', 'kitty', 'alacritty', 'iterm2', 'terminal'];

  // Build prioritized, deduplicated candidate list.
  const ordered = [];
  const pushUnique = (k) => {
    if (k && ADAPTERS[k] && !ordered.includes(k)) ordered.push(k);
  };

  // 1. Explicit user preference
  pushUnique(preferred);
  // 2. Last terminal that actually ran Pi
  pushUnique(lastKey);

  // 3. Currently running supported terminal apps
  const runningApps = await getRunningAppNames();
  for (const key of defaultOrder) {
    const adapter = ADAPTERS[key];
    if (adapter.processNames.some((p) => runningApps.has(p))) {
      pushUnique(key);
    }
  }

  // 4. Installed apps + Terminal.app fallback
  for (const key of defaultOrder) {
    pushUnique(key);
  }

  for (const key of ordered) {
    const adapter = ADAPTERS[key];
    if (!adapter.isInstalled(options.lastTerminal)) continue;
    const ok = await adapter.launch(workDir, options.lastTerminal);
    if (ok) {
      return { success: true, terminal: adapter.label, key };
    }
  }

  return { success: false, error: 'Failed to launch any supported macOS terminal.' };
}

const FOCUS_APP_MAP = {
  rex: 'Rex',
  ghostty: 'Ghostty',
  iterm2: 'iTerm',
  iterm: 'iTerm',
  warp: 'Warp',
  wezterm: 'WezTerm',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  terminal: 'Terminal',
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  zed: 'Zed',
  tabby: 'Tabby',
  hyper: 'Hyper',
};

async function focusDarwinApp(session) {
  if (!session) return false;
  const termKey = (session.terminal || '').toLowerCase();
  const appName = FOCUS_APP_MAP[termKey] || (typeof session.appName === 'string' ? session.appName.trim() : '');
  if (!appName || !/^[a-zA-Z0-9 ._-]+$/.test(appName)) return false;
  return await spawnDetached('open', ['-a', appName]);
}

module.exports = launchDarwin;
module.exports.focusDarwinApp = focusDarwinApp;
module.exports.normalizeTerminalKey = normalizeTerminalKey;
module.exports.findRexBinary = findRexBinary;
