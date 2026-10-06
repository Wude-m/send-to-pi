/**
 * macOS Terminal Launcher for send-to-pi
 *
 * Supports:
 * - Terminal.app (macOS Built-in default)
 * - iTerm2 (Most popular developer terminal)
 * - Ghostty / WezTerm / Alacritty / Kitty (Modern GPU terminals)
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function launchDarwin(workDir) {
  const customTerminal = (process.env.PI_TERMINAL || '').toLowerCase();

  // 1. 指定或探测常见现代独立终端 (Ghostty, Alacritty, WezTerm, Kitty)
  if (customTerminal === 'ghostty' || (!customTerminal && fs.existsSync('/Applications/Ghostty.app'))) {
    try {
      const child = spawn('open', ['-a', 'Ghostty', '--args', '-e', `sh -c "cd '${workDir}' && pi"`], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { success: true, terminal: 'Ghostty' };
    } catch (_err) {}
  }

  if (customTerminal === 'wezterm' || (!customTerminal && fs.existsSync('/Applications/WezTerm.app'))) {
    try {
      const child = spawn('open', ['-a', 'WezTerm', '--args', 'start', '--cwd', workDir, 'pi'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { success: true, terminal: 'WezTerm' };
    } catch (_err) {}
  }

  // 2. 探测 iTerm2
  const hasITerm = fs.existsSync('/Applications/iTerm.app') || customTerminal === 'iterm2' || customTerminal === 'iterm';
  if (hasITerm && customTerminal !== 'terminal') {
    try {
      const itermScript = `
        tell application "iTerm"
          activate
          try
            set newWindow to (create window with default profile)
            tell current session of newWindow
              write text "cd " & quoted form of "${workDir}" & " && pi"
            end tell
          on error
            -- Fallback for older iTerm versions
            tell current window
              create tab with default profile
              tell current session to write text "cd " & quoted form of "${workDir}" & " && pi"
            end tell
          end try
        end tell
      `;
      await runAppleScript(itermScript);
      return { success: true, terminal: 'iTerm2' };
    } catch (err) {
      console.warn('[darwin-launcher] iTerm launch failed, falling back to Terminal.app:', err.message);
    }
  }

  // 3. 兜底 macOS 官方原生 Terminal.app
  const terminalScript = `
    tell application "Terminal"
      activate
      do script "cd " & quoted form of "${workDir}" & " && pi"
    end tell
  `;
  await runAppleScript(terminalScript);
  return { success: true, terminal: 'Terminal.app' };
}

module.exports = launchDarwin;
