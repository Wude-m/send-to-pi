const DEFAULT_BRIDGE_PORT = 18090;
const DEFAULT_INTERNAL_PORT_START = 18091;

function restoreOptions() {
  chrome.storage.sync.get(
    {
      bridgePort: DEFAULT_BRIDGE_PORT,
      internalPortStart: DEFAULT_INTERNAL_PORT_START,
    },
    (items) => {
      document.getElementById("bridgePort").value = items.bridgePort;
      document.getElementById("internalPortStart").value = items.internalPortStart;
    }
  );
}

function saveOptions() {
  const bridgePort = parseInt(document.getElementById("bridgePort").value, 10) || DEFAULT_BRIDGE_PORT;
  const internalPortStart =
    parseInt(document.getElementById("internalPortStart").value, 10) || DEFAULT_INTERNAL_PORT_START;

  chrome.storage.sync.set({ bridgePort, internalPortStart }, () => {
    const status = document.getElementById("status");
    status.textContent = "✅ Settings saved!";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.getElementById("save").addEventListener("click", saveOptions);
