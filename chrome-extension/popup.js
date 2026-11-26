const DEFAULT_BRIDGE_PORT = 18090;
const DEFAULT_INTERNAL_PORT_START = 18091;
const INTERNAL_PORT_COUNT = 5;
const isChinese = (navigator.language || "").toLowerCase().startsWith("zh");

const t = {
  modeLabel: isChinese ? "内容填充模式" : "Delivery Mode",
  modeSmart: isChinese ? "智能分流" : "Smart",
  modeInline: isChinese ? "全文直填" : "Inline",
  modeLink: isChinese ? "仅发链接" : "Link Only",
  modeHints: {
    smart: (limit) =>
      isChinese
        ? `≤${limit} 字直填输入框；更长自动存本地 .md 仅填 @路径`
        : `≤${limit} chars inline; longer saved to local .md with @path`,
    inline: () =>
      isChinese ? "无论多长均直接填入终端输入框" : "Always prefill full Markdown text into prompt",
    link: () =>
      isChinese ? "整页发送只填标题与 URL（划词仍发送选中文本）" : "Article mode sends title + URL only (selection still sends text)",
  },
  targetLabel: isChinese ? "目标 Pi 会话" : "Target Pi Session",
  bridgeOnline: isChinese ? "Bridge 在线" : "Bridge Online",
  bridgeDirect: isChinese ? "直连模式 (无 Bridge)" : "Direct Mode (No Bridge)",
  autoName: isChinese ? "自动路由（最近活跃）" : "Auto (Most Recent)",
  autoSub: isChinese ? "优先发送到刚刚交互的 Pi 窗口" : "Routes to the most recently active Pi session",
  empty: isChinese
    ? "未发现运行中的 Pi 会话。打开任意终端运行 pi 即可直连，或启动 Bridge 支持冷启动。"
    : "No active Pi session found. Open Pi in any terminal for direct send, or start Bridge for cold-start.",
  selected: isChinese ? "已选" : "Selected",
  refresh: isChinese ? "刷新列表" : "Refresh",
  settings: isChinese ? "更多设置" : "Settings",
};

async function fetchJson(url, timeoutMs = 450) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        bridgePort: DEFAULT_BRIDGE_PORT,
        internalPortStart: DEFAULT_INTERNAL_PORT_START,
        preferredPort: 0,
        deliveryMode: "smart",
        inlineLimit: 1500,
      },
      (items) => {
        resolve({
          bridgePort: Number(items.bridgePort) || DEFAULT_BRIDGE_PORT,
          internalPortStart: Number(items.internalPortStart) || DEFAULT_INTERNAL_PORT_START,
          preferredPort: Number(items.preferredPort) || 0,
          deliveryMode: ["smart", "inline", "link"].includes(items.deliveryMode) ? items.deliveryMode : "smart",
          inlineLimit: Number(items.inlineLimit) || 1500,
        });
      }
    );
  });
}

function saveSetting(patch) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(patch, resolve);
  });
}

function basename(p) {
  if (!p) return "Pi Session";
  const clean = String(p).replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || p;
}

async function render() {
  document.getElementById("modeLabel").textContent = t.modeLabel;
  document.getElementById("modeSmart").textContent = t.modeSmart;
  document.getElementById("modeInline").textContent = t.modeInline;
  document.getElementById("modeLink").textContent = t.modeLink;
  document.getElementById("sectionLabel").textContent = t.targetLabel;
  document.getElementById("refreshBtn").textContent = t.refresh;
  document.getElementById("optionsBtn").textContent = t.settings;

  const { bridgePort, internalPortStart, preferredPort, deliveryMode, inlineLimit } = await getSettings();

  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === deliveryMode);
  });
  document.getElementById("modeHint").textContent = t.modeHints[deliveryMode](inlineLimit);

  const bridgeBadge = document.getElementById("bridgeBadge");
  const listEl = document.getElementById("sessionList");

  const ports = Array.from({ length: INTERNAL_PORT_COUNT }, (_, i) => internalPortStart + i);
  const [bridgeHealth, ...piResults] = await Promise.all([
    fetchJson(`http://127.0.0.1:${bridgePort}/health`, 500),
    ...ports.map(async (p) => {
      const info = await fetchJson(`http://127.0.0.1:${p}/health`, 450);
      return info && info.status === "alive" ? { ...info, port: p } : null;
    }),
  ]);

  if (bridgeHealth && bridgeHealth.status === "ok") {
    bridgeBadge.textContent = t.bridgeOnline;
    bridgeBadge.className = "badge ok";
  } else {
    bridgeBadge.textContent = t.bridgeDirect;
    bridgeBadge.className = "badge warn";
  }

  const sessions = piResults
    .filter(Boolean)
    .sort((a, b) => Number(b.activeAt || b.updatedAt || 0) - Number(a.activeAt || a.updatedAt || 0));

  listEl.innerHTML = "";

  const autoItem = document.createElement("div");
  autoItem.className = "item" + (preferredPort === 0 ? " active" : "");
  autoItem.innerHTML = `
    <div class="item-main">
      <div class="item-name">${t.autoName}</div>
      <div class="item-sub">${t.autoSub}</div>
    </div>
    ${preferredPort === 0 ? `<span class="pill">${t.selected}</span>` : ""}
  `;
  autoItem.addEventListener("click", async () => {
    await saveSetting({ preferredPort: 0 });
    render();
  });
  listEl.appendChild(autoItem);

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = t.empty;
    listEl.appendChild(empty);
    return;
  }

  for (const s of sessions) {
    const item = document.createElement("div");
    const isSelected = preferredPort === s.port;
    item.className = "item" + (isSelected ? " active" : "");
    const termLabel = s.appName || s.terminal || "terminal";
    item.innerHTML = `
      <div class="item-main">
        <div class="item-name">${basename(s.workdir)} · ${termLabel}</div>
        <div class="item-sub">:${s.port} · ${s.workdir || ""}</div>
      </div>
      ${isSelected ? `<span class="pill">${t.selected}</span>` : ""}
    `;
    item.addEventListener("click", async () => {
      await saveSetting({ preferredPort: s.port });
      render();
    });
    listEl.appendChild(item);
  }
}

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await saveSetting({ deliveryMode: btn.dataset.mode });
    render();
  });
});

document.getElementById("refreshBtn").addEventListener("click", render);
document.getElementById("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.addEventListener("DOMContentLoaded", render);
