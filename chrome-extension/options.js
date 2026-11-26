const DEFAULT_BRIDGE_PORT = 18090;
const DEFAULT_INTERNAL_PORT_START = 18091;
const DEFAULT_DELIVERY_MODE = "smart";
const DEFAULT_INLINE_LIMIT = 1500;

function restoreOptions() {
  chrome.storage.sync.get(
    {
      bridgePort: DEFAULT_BRIDGE_PORT,
      internalPortStart: DEFAULT_INTERNAL_PORT_START,
      deliveryMode: DEFAULT_DELIVERY_MODE,
      inlineLimit: DEFAULT_INLINE_LIMIT,
    },
    (items) => {
      document.getElementById("bridgePort").value = items.bridgePort;
      document.getElementById("internalPortStart").value = items.internalPortStart;
      document.getElementById("deliveryMode").value = items.deliveryMode;
      document.getElementById("inlineLimit").value = items.inlineLimit;
    }
  );
}

function saveOptions() {
  const bridgePort = parseInt(document.getElementById("bridgePort").value, 10) || DEFAULT_BRIDGE_PORT;
  const internalPortStart =
    parseInt(document.getElementById("internalPortStart").value, 10) || DEFAULT_INTERNAL_PORT_START;
  const deliveryMode = document.getElementById("deliveryMode").value || DEFAULT_DELIVERY_MODE;
  const rawLimit = parseInt(document.getElementById("inlineLimit").value, 10);
  const inlineLimit = Number.isFinite(rawLimit) && rawLimit >= 200 ? rawLimit : DEFAULT_INLINE_LIMIT;

  chrome.storage.sync.set({ bridgePort, internalPortStart, deliveryMode, inlineLimit }, () => {
    const status = document.getElementById("status");
    status.textContent = "✅ Settings saved!";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.getElementById("save").addEventListener("click", saveOptions);
