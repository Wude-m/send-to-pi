/**
 * Linux Adaptive Terminal Launcher for send-to-pi
 */

const { spawn } = require('child_process');

function trySpawn(cmd, args) {
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
      }, 220);
    } catch (_err) {
      resolve(false);
    }
  });
}

function shellQuoteSingle(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function buildCandidates(workDir) {
  const quoted = shellQuoteSingle(workDir);
  return {
    ghostty: { cmd: 'ghostty', args: ['-e', 'sh', '-lc', `cd ${quoted} && pi; exec ${process.env.SHELL || 'sh'}`] },
    wezterm: { cmd: 'wezterm', args: ['start', '--cwd', workDir, 'pi'] },
    kitty: { cmd: 'kitty', args: ['--directory', workDir, 'sh', '-lc', 'pi; exec sh'] },
    alacritty: { cmd: 'alacritty', args: ['--working-directory', workDir, '-e', 'sh', '-lc', 'pi; exec sh'] },
    'gnome-terminal': { cmd: 'gnome-terminal', args: ['--working-directory', workDir, '--', 'sh', '-lc', 'pi; exec sh'] },
    konsole: { cmd: 'konsole', args: ['--workdir', workDir, '-e', 'sh', '-lc', 'pi; exec sh'] },
    'x-terminal-emulator': { cmd: 'x-terminal-emulator', args: ['-e', `sh -lc "cd ${quoted} && pi; exec sh"`] },
    xterm: { cmd: 'xterm', args: ['-e', `cd ${quoted} && pi; exec sh`] },
  };
}

async function launchLinux(workDir, options = {}) {
  const candidates = buildCandidates(workDir);
  const preferred = (options.preferredTerminal || process.env.PI_TERMINAL || '').trim().toLowerCase();
  const lastKey = (options.lastTerminal && options.lastTerminal.terminal || '').trim().toLowerCase();

  const order = [];
  const pushUnique = (k) => {
    if (k && !order.includes(k)) order.push(k);
  };

  pushUnique(preferred);
  pushUnique(lastKey);
  for (const k of Object.keys(candidates)) pushUnique(k);

  for (const key of order) {
    const item = candidates[key] || {
      cmd: key,
      args: ['-e', `sh -lc "cd ${shellQuoteSingle(workDir)} && pi; exec sh"`],
    };
    const ok = await trySpawn(item.cmd, item.args);
    if (ok) {
      return { success: true, terminal: item.cmd, key };
    }
  }

  return { success: false, error: 'No supported terminal emulator found on Linux system.' };
}

module.exports = launchLinux;
