/**
 * Cross-platform clipboard fallback (zero external dependencies)
 */

const { spawn } = require('child_process');

function pipeToCommand(cmd, args, text) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      let settled = false;
      const done = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
      child.stdin.on('error', () => done(false));
      child.stdin.end(text, 'utf8');
    } catch (_err) {
      resolve(false);
    }
  });
}

async function copyToClipboard(text) {
  if (!text) return false;

  if (process.platform === 'darwin') {
    return await pipeToCommand('pbcopy', [], text);
  }

  if (process.platform === 'win32') {
    // PowerShell Set-Clipboard preserves UTF-8 cleanly; fall back to clip.exe.
    const psOk = await pipeToCommand(
      'powershell.exe',
      ['-NoProfile', '-Command', '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      text
    );
    if (psOk) return true;
    return await pipeToCommand('clip', [], text);
  }

  // Linux / BSD
  if (await pipeToCommand('wl-copy', [], text)) return true;
  if (await pipeToCommand('xclip', ['-selection', 'clipboard'], text)) return true;
  if (await pipeToCommand('xsel', ['--clipboard', '--input'], text)) return true;
  return false;
}

module.exports = { copyToClipboard };
