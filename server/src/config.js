const path = require('path');
const os = require('os');
const fs = require('fs');

const BRIDGE_PORT = parseInt(process.env.PI_BRIDGE_PORT, 10) || 18090;
const PI_INTERNAL_PORT = parseInt(process.env.PI_INTERNAL_PORT, 10) || 18091;
const PI_INTERNAL_PORT_START = PI_INTERNAL_PORT;
const PI_INTERNAL_PORT_END = PI_INTERNAL_PORT + 4; // 18091 ~ 18095

// 确保 ~/.pi 目录存在
const piHomeDir = path.join(os.homedir(), '.pi');
if (!fs.existsSync(piHomeDir)) {
  try {
    fs.mkdirSync(piHomeDir, { recursive: true });
  } catch (_err) {
    // 忽略创建失败（如权限受限），由操作系统临时目录兜底
  }
}

const ACTIVE_SESSION_FILE = path.join(piHomeDir, 'send-to-pi.json');

const PENDING_FILE = fs.existsSync(piHomeDir)
  ? path.join(piHomeDir, 'pending-browser-input.txt')
  : path.join(os.tmpdir(), 'pi-pending-browser-input.txt');

// 默认工作目录：环境变量优先，其次当前工作目录，兜底家目录
function getWorkDir() {
  if (process.env.PI_WORKDIR && fs.existsSync(process.env.PI_WORKDIR)) {
    return process.env.PI_WORKDIR;
  }
  const cwd = process.cwd();
  if (cwd && fs.existsSync(cwd) && cwd !== '/' && !cwd.endsWith('\\Windows\\system32')) {
    return cwd;
  }
  return os.homedir();
}

module.exports = {
  BRIDGE_PORT,
  PI_INTERNAL_PORT,
  PI_INTERNAL_PORT_START,
  PI_INTERNAL_PORT_END,
  ACTIVE_SESSION_FILE,
  PENDING_FILE,
  getWorkDir,
};
