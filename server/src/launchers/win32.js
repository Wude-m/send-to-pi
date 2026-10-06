/**
 * Windows Terminal Launcher for send-to-pi
 *
 * Supports:
 * - Windows Terminal (wt.exe)
 * - PowerShell (powershell.exe fallback)
 * - Command Prompt (cmd.exe fallback)
 */

const { spawn } = require('child_process');

function launchWin32(workDir) {
  return new Promise((resolve) => {
    // 1. 尝试 Windows Terminal (wt.exe)
    try {
      const wtArgs = ['-d', workDir, 'powershell', '-NoExit', '-Command', 'pi'];
      const child = spawn('wt.exe', wtArgs, {
        detached: true,
        stdio: 'ignore',
      });

      child.on('error', (_err) => {
        // wt.exe 不存在或失败，回退到 powershell.exe
        fallbackPowerShell(workDir, resolve);
      });

      child.unref();
      // 在 Windows 上若成功触发 spawn 且无即时报错即视为已拉起
      setTimeout(() => resolve({ success: true, terminal: 'Windows Terminal' }), 300);
    } catch (_e) {
      fallbackPowerShell(workDir, resolve);
    }
  });
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
