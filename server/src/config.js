const path = require('path');
const os = require('os');
const fs = require('fs');

const piHomeDir = path.join(os.homedir(), '.pi');
if (!fs.existsSync(piHomeDir)) {
  try {
    fs.mkdirSync(piHomeDir, { recursive: true });
  } catch (_err) {
    // Fallback to OS temp dir if ~/.pi cannot be created.
  }
}

const SEND_TO_PI_DIR = path.join(piHomeDir, 'send-to-pi');
try {
  fs.mkdirSync(SEND_TO_PI_DIR, { recursive: true });
} catch (_err) {
  // Ignore creation errors.
}

const USER_CONFIG_FILE = path.join(SEND_TO_PI_DIR, 'config.json');
const SESSION_REGISTRY_FILE = path.join(SEND_TO_PI_DIR, 'sessions.json');
const LAST_TERMINAL_FILE = path.join(SEND_TO_PI_DIR, 'last-terminal.json');
const ACTIVE_SESSION_FILE = path.join(piHomeDir, 'send-to-pi.json');

const PENDING_FILE = fs.existsSync(piHomeDir)
  ? path.join(piHomeDir, 'pending-browser-input.txt')
  : path.join(os.tmpdir(), 'pi-pending-browser-input.txt');

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readUserConfigFile() {
  const parsed = readJsonSafe(USER_CONFIG_FILE);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function readLastTerminal() {
  const parsed = readJsonSafe(LAST_TERMINAL_FILE);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function loadUserConfig() {
  const fileCfg = readUserConfigFile();
  const bridgePort =
    parseInt(process.env.PI_BRIDGE_PORT, 10) ||
    parseInt(fileCfg.bridgePort, 10) ||
    18090;
  const internalPort =
    parseInt(process.env.PI_INTERNAL_PORT, 10) ||
    parseInt(fileCfg.internalPort, 10) ||
    18091;
  const terminal = (
    process.env.PI_TERMINAL ||
    fileCfg.terminal ||
    ''
  ).trim().toLowerCase();
  const launchCommand = (
    process.env.PI_LAUNCH_CMD ||
    fileCfg.launchCommand ||
    ''
  ).trim();
  const workDir = (process.env.PI_WORKDIR || fileCfg.workDir || '').trim();
  const focusEnv = (process.env.PI_FOCUS_ON_SEND || '').trim().toLowerCase();
  const focusOnSend =
    focusEnv !== ''
      ? focusEnv === '1' || focusEnv === 'true' || focusEnv === 'yes'
      : Boolean(fileCfg.focusOnSend);

  return {
    bridgePort,
    internalPort,
    internalPortStart: internalPort,
    internalPortEnd: internalPort + 4,
    terminal,
    launchCommand,
    workDir,
    focusOnSend,
  };
}

const initialCfg = loadUserConfig();
const BRIDGE_PORT = initialCfg.bridgePort;
const PI_INTERNAL_PORT = initialCfg.internalPort;
const PI_INTERNAL_PORT_START = initialCfg.internalPortStart;
const PI_INTERNAL_PORT_END = initialCfg.internalPortEnd;

// Workdir priority: PI_WORKDIR -> config.json -> last active Pi workdir -> cwd -> homedir
function getWorkDir() {
  const cfg = loadUserConfig();
  if (cfg.workDir && fs.existsSync(cfg.workDir)) {
    return cfg.workDir;
  }
  const last = readLastTerminal();
  if (last && last.workdir && fs.existsSync(last.workdir)) {
    return last.workdir;
  }
  const cwd = process.cwd();
  if (cwd && fs.existsSync(cwd) && cwd !== '/' && !cwd.endsWith('\\Windows\\system32')) {
    return cwd;
  }
  return os.homedir();
}

function getPreferredTerminal() {
  const cfg = loadUserConfig();
  return cfg.terminal || '';
}

function getCustomLaunchCommand() {
  const cfg = loadUserConfig();
  return cfg.launchCommand || '';
}

function shouldFocusOnSend() {
  const cfg = loadUserConfig();
  return cfg.focusOnSend;
}

module.exports = {
  BRIDGE_PORT,
  PI_INTERNAL_PORT,
  PI_INTERNAL_PORT_START,
  PI_INTERNAL_PORT_END,
  SEND_TO_PI_DIR,
  USER_CONFIG_FILE,
  ACTIVE_SESSION_FILE,
  SESSION_REGISTRY_FILE,
  LAST_TERMINAL_FILE,
  PENDING_FILE,
  loadUserConfig,
  readLastTerminal,
  getWorkDir,
  getPreferredTerminal,
  getCustomLaunchCommand,
  shouldFocusOnSend,
};
