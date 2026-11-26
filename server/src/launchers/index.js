/**
 * Cross-Platform Adaptive Terminal Launcher Dispatcher
 *
 * 4-Layer Strategy:
 * 1. Custom launch command template (PI_LAUNCH_CMD / config.json launchCommand)
 * 2. Last terminal that ran Pi (~/.pi/send-to-pi/last-terminal.json) or user preference
 * 3. Running / installed terminal auto-detection with OS default fallback
 * 4. Clipboard fallback (handled in server/src/index.js if launch fails)
 */

const launchDarwin = require('./darwin');
const launchWin32 = require('./win32');
const launchLinux = require('./linux');
const { launchCustomCommand } = require('./custom');
const {
  getPreferredTerminal,
  getCustomLaunchCommand,
  readLastTerminal,
} = require('../config');

async function launchTerminal(workDir, overrides = {}) {
  const customCmd =
    overrides.customLaunchCommand !== undefined
      ? overrides.customLaunchCommand
      : getCustomLaunchCommand();

  // Layer 1: Universal custom command escape hatch
  if (customCmd) {
    const customResult = await launchCustomCommand(customCmd, workDir);
    if (customResult.success) {
      return customResult;
    }
    console.warn(`[launcher] Custom launch command failed (${customResult.error}), falling back to platform adapters.`);
  }

  const options = {
    preferredTerminal:
      overrides.preferredTerminal !== undefined
        ? overrides.preferredTerminal
        : getPreferredTerminal(),
    lastTerminal:
      overrides.lastTerminal !== undefined
        ? overrides.lastTerminal
        : readLastTerminal(),
  };

  const platform = overrides.platform || process.platform;

  switch (platform) {
    case 'darwin':
      return await launchDarwin(workDir, options);
    case 'win32':
      return await launchWin32(workDir, options);
    case 'linux':
      return await launchLinux(workDir, options);
    default:
      return {
        success: false,
        error: `Unsupported platform: ${platform}`,
      };
  }
}

async function focusTerminal(session) {
  if (process.platform === 'darwin' && typeof launchDarwin.focusDarwinApp === 'function') {
    return await launchDarwin.focusDarwinApp(session);
  }
  return false;
}

module.exports = { launchTerminal, focusTerminal };
