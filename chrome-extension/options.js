const DEFAULT_PORT = 18090;

function restoreOptions() {
  chrome.storage.sync.get({ bridgePort: DEFAULT_PORT }, (items) => {
    document.getElementById('bridgePort').value = items.bridgePort;
  });
}

function saveOptions() {
  const port = parseInt(document.getElementById('bridgePort').value, 10) || DEFAULT_PORT;
  chrome.storage.sync.set({ bridgePort: port }, () => {
    const status = document.getElementById('status');
    status.textContent = '✅ 设置已保存！';
    setTimeout(() => {
      status.textContent = '';
    }, 2000);
  });
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
