/**
 * Cross-Platform Terminal Launcher Dispatcher
 */

const os = require('os');
const launchDarwin = require('./darwin');
const launchWin32 = require('./win32');
const launchLinux = require('./linux');

async function launchTerminal(workDir) {
  const platform = process.platform;

  switch (platform) {
    case 'darwin':
      return await launchDarwin(workDir);
    case 'win32':
      return await launchWin32(workDir);
    case 'linux':
      return await launchLinux(workDir);
    default:
      return {
        success: false,
        error: `Unsupported platform: ${platform}`,
      };
  }
}

module.exports = { launchTerminal };
