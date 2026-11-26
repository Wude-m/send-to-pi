/**
 * Windows Adaptive Terminal Launcher for send-to-pi
 *
 * Resolution order:
 * 1. Explicit preference (PI_TERMINAL / config.json) or last-terminal.json
 * 2. Windows Terminal (wt.exe)
 * 3. PowerShell (pwsh.exe / powershell.exe)
 * 4. Command Prompt (cmd.exe)
 * Also supports WezTerm, Alacritty, and Tern when configured or detected.
 */

const { spawn } = require('child_process');
const fs = require('fs');

function spawnAndCheck(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
      });
      let failed = false;
      child.on('error', () => {
        failed = true;
        resolve(false);
      });
      child.unref();
      setTimeout(() => {
        if (!failed) resolve(true);
      }, 280);
    } catch (_err) {
      resolve(false);
    }
  });
}

function escapePsSingle(str) {
  return String(str).replace(/'/g, "''");
}

const ADAPTERS = {
  wt: {
    label: 'Windows Terminal',
    launch: (workDir) =>
      spawnAndCheck('wt.exe', ['-d', workDir, 'powershell', '-NoExit', '-Command', 'pi']),
  },
  wezterm: {
    label: 'WezTerm',
    launch: (workDir) =>
      spawnAndCheck('wezterm-gui.exe', ['start', '--cwd', workDir, 'pi']),
  },
  alacritty: {
    label: 'Alacritty',
    launch: (workDir) =>
      spawnAndCheck('alacritty.exe', [
        '--working-directory',
        workDir,
        '-e',
        'powershell',
        '-NoExit',
        '-Command',
        'pi',
      ]),
  },
  tern: {
    label: 'Tern',
    launch: (workDir) => {
      const ternPath = process.env.TERN_PATH || 'D:\\Tern\\tern.exe';
      if (!fs.existsSync(ternPath)) return Promise.resolve(false);
      return spawnAndCheck(ternPath, [
        '-e',
        'powershell',
        '-NoExit',
        '-Command',
        `Set-Location '${escapePsSingle(workDir)}'; pi`,
      ]);
    },
  },
  pwsh: {
    label: 'PowerShell 7',
    launch: (workDir) =>
      spawnAndCheck('pwsh.exe', [
        '-NoExit',
        '-Command',
        `Set-Location '${escapePsSingle(workDir)}'; pi`,
      ]),
  },
  powershell: {
    label: 'PowerShell',
    launch: (workDir) =>
      spawnAndCheck('powershell.exe', [
        '-NoExit',
        '-Command',
        `Set-Location '${escapePsSingle(workDir)}'; pi`,
      ]),
  },
  cmd: {
    label: 'cmd.exe',
    launch: (workDir) =>
      spawnAndCheck('cmd.exe', ['/k', `cd /d "${workDir}" && pi`]),
  },
};

function normalizeKey(name) {
  const k = (name || '').trim().toLowerCase();
  if (!k) return '';
  if (k === 'windows-terminal' || k === 'windowsterminal') return 'wt';
  return ADAPTERS[k] ? k : '';
}

async function launchWin32(workDir, options = {}) {
  const preferred = normalizeKey(options.preferredTerminal || process.env.PI_TERMINAL);
  const lastKey = normalizeKey(options.lastTerminal && options.lastTerminal.terminal);
  const defaultOrder = ['wt', 'pwsh', 'powershell', 'cmd'];

  const ordered = [];
  const pushUnique = (k) => {
    if (k && ADAPTERS[k] && !ordered.includes(k)) ordered.push(k);
  };

  pushUnique(preferred);
  pushUnique(lastKey);
  for (const k of defaultOrder) pushUnique(k);

  for (const key of ordered) {
    const ok = await ADAPTERS[key].launch(workDir);
    if (ok) {
      return { success: true, terminal: ADAPTERS[key].label, key };
    }
  }

  return { success: false, error: 'Failed to launch any supported Windows terminal.' };
}

module.exports = launchWin32;
