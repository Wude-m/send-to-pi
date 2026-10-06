/**
 * Linux Terminal Launcher for send-to-pi
 *
 * Supports:
 * - x-terminal-emulator
 * - gnome-terminal
 * - konsole
 * - kitty / alacritty
 * - xterm
 */

const { spawn } = require('child_process');

function trySpawn(cmd, args, resolve) {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.unref();
    setTimeout(() => resolve(true), 200);
  } catch {
    resolve(false);
  }
}

async function launchLinux(workDir) {
  const customTerminal = (process.env.PI_TERMINAL || '').toLowerCase();

  const candidates = [
    ...(customTerminal ? [{ cmd: customTerminal, args: ['-e', `sh -c "cd '${workDir}' && pi; exec sh"`] }] : []),
    { cmd: 'x-terminal-emulator', args: ['-e', `sh -c "cd '${workDir}' && pi; exec sh"`] },
    { cmd: 'gnome-terminal', args: ['--working-directory', workDir, '--', 'sh', '-c', 'pi; exec sh'] },
    { cmd: 'konsole', args: ['--workdir', workDir, '-e', 'sh', '-c', 'pi; exec sh'] },
    { cmd: 'kitty', args: ['--directory', workDir, 'sh', '-c', 'pi; exec sh'] },
    { cmd: 'alacritty', args: ['--working-directory', workDir, '-e', 'sh', '-c', 'pi; exec sh'] },
    { cmd: 'xterm', args: ['-e', `cd '${workDir}' && pi; exec sh`] },
  ];

  for (const item of candidates) {
    const ok = await new Promise((resolve) => trySpawn(item.cmd, item.args, resolve));
    if (ok) {
      return { success: true, terminal: item.cmd };
    }
  }

  return { success: false, error: 'No supported terminal emulator found on Linux system.' };
}

module.exports = launchLinux;
