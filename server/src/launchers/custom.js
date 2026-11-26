/**
 * Layer 1 Escape Hatch: Custom user-defined terminal launch command template.
 *
 * Example (~/.pi/send-to-pi/config.json or PI_LAUNCH_CMD):
 *   rex run --interactive --cwd "{workdir}" --keep-open -- pi
 *   kitty --directory "{workdir}" pi
 */

const { spawn } = require('child_process');

function shellEscape(value) {
  if (process.platform === 'win32') {
    return String(value).replace(/"/g, '""');
  }
  return String(value).replace(/(["\\$`])/g, '\\$1');
}

function launchCustomCommand(template, workDir) {
  return new Promise((resolve) => {
    const trimmed = (template || '').trim();
    if (!trimmed) {
      resolve({ success: false, error: 'Empty custom launch command' });
      return;
    }

    const command = trimmed.replace(/\{workdir\}/gi, shellEscape(workDir));

    try {
      const child = spawn(command, {
        cwd: workDir,
        env: { ...process.env, PI_WORKDIR: workDir },
        shell: true,
        detached: true,
        stdio: 'ignore',
      });

      let failed = false;
      child.on('error', (err) => {
        failed = true;
        resolve({ success: false, error: err.message });
      });

      child.unref();
      setTimeout(() => {
        if (!failed) {
          resolve({ success: true, terminal: 'Custom Command', command });
        }
      }, 250);
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

module.exports = { launchCustomCommand };
