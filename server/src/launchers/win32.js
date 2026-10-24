/**
 * Windows Terminal Launcher for send-to-pi
 *
 * Supports:
 * - Tern Terminal (D:\Tern\tern.exe)
 * - Windows Terminal (wt.exe fallback)
 * - PowerShell (powershell.exe fallback)
 * - Command Prompt (cmd.exe fallback)
 */

const { spawn } = require('child_process');
const fs = require('fs');

function launchWin32(workDir) {
  return new Promise((resolve) => {
    // 1. 优先尝试 Tern Terminal (主力终端)
    const ternPath = 'D:\\Tern\\tern.exe';
    if (fs.existsSync(ternPath)) {
      try {
        const ternArgs = ['-e', 'powershell', '-NoExit', '-Command', `Set-Location '${workDir}'; pi`];
        const child = spawn(ternPath, ternArgs, {
          detached: true,
          stdio: 'ignore',
        });
        child.on('error', () => fallbackWT(workDir, resolve));
        child.unref();
        setTimeout(() => resolve({ success: true, terminal: 'Tern' }), 300);
        return;
      } catch (_e) {
        // continue
      }
    }
    fallbackWT(workDir, resolve);
  });
}

function fallbackWT(workDir, resolve) {
  // 2. 回退尝试 Windows Terminal (wt.exe)
  try {
    const wtArgs = ['-d', workDir, 'powershell', '-NoExit', '-Command', 'pi'];
    const child = spawn('wt.exe', wtArgs, {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', (_err) => {
      fallbackPowerShell(workDir, resolve);
    });

    child.unref();
    setTimeout(() => resolve({ success: true, terminal: 'Windows Terminal' }), 300);
  } catch (_e) {
    fallbackPowerShell(workDir, resolve);
  }
}

function fallbackPowerShell(workDir, resolve) {
  try {
    const psArgs = ['-NoExit', '-Command', `Set-Location '${workDir}'; pi`];
    const child = spawn('powershell.exe', psArgs, {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', (_err) => {
      fallbackCmd(workDir, resolve);
    });

    child.unref();
    setTimeout(() => resolve({ success: true, terminal: 'PowerShell' }), 300);
  } catch (_e) {
    fallbackCmd(workDir, resolve);
  }
}

function fallbackCmd(workDir, resolve) {
  try {
    const child = spawn('cmd.exe', ['/k', `cd /d "${workDir}" && pi`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    resolve({ success: true, terminal: 'cmd.exe' });
  } catch (err) {
    resolve({ success: false, error: err.message });
  }
}

module.exports = launchWin32;
