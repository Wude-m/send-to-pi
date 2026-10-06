/**
 * Send to Pi - Chrome Background Service Worker
 */

const DEFAULT_PORT = 18090;
const isChinese = (navigator.language || '').toLowerCase().startsWith('zh');

const i18n = {
  menuSelection: isChinese ? "🚀 发送选中内容给 Pi" : "🚀 Send Selection to Pi",
  menuPage: isChinese ? "🚀 发送当前网页给 Pi" : "🚀 Send Current Page to Pi",
  menuLink: isChinese ? "🚀 发送此链接给 Pi" : "🚀 Send Link to Pi",
  notifyLaunchedTitle: isChinese ? "已唤起终端并预填内容" : "Terminal Launched & Prefilled",
  notifyLaunchedMsg: (term) =>
    isChinese ? `已启动 ${term || '终端'}，内容已在 Pi 输入框就绪！` : `Started ${term || 'terminal'}, prompt is ready in Pi!`,
  notifyPrefilledTitle: isChinese ? "已填入 Pi 终端输入框" : "Prefilled into Pi Terminal",
  notifyPrefilledMsg: isChinese
    ? "内容已送达，光标位于末尾，可自由补充要求或按 Enter 发送！"
    : "Content delivered to terminal prompt. Append your instructions or press Enter!",
  notifyFailedTitle: isChinese ? "发送失败" : "Failed to Send",
  notifyFailedMsg: (code) =>
    isChinese ? `Bridge 响应状态码: ${code}` : `Bridge daemon responded with status: ${code}`,
  notifyNoConnTitle: isChinese ? "无法连接到 Bridge 守护进程" : "Cannot Connect to Bridge Daemon",
  notifyNoConnMsg: isChinese
    ? "请确保本地后台 send-to-pi 守护进程已启动（默认端口 18090）。"
    : "Please ensure the local send-to-pi daemon is running (default port: 18090).",
};

async function getBridgeUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ bridgePort: DEFAULT_PORT }, (items) => {
      const port = items.bridgePort || DEFAULT_PORT;
      resolve(`http://127.0.0.1:${port}/send`);
    });
  });
}

// 注册右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send_selection",
    title: i18n.menuSelection,
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: "send_page",
    title: i18n.menuPage,
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: "send_link",
    title: i18n.menuLink,
    contexts: ["link"],
  });
});

// 处理右键点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const payload = {
    type: "page",
    text: "",
    title: tab ? tab.title : "",
    url: tab ? tab.url : "",
    lang: isChinese ? "zh" : "en",
  };

  if (info.menuItemId === "send_selection") {
    payload.type = "selection";
    payload.text = info.selectionText || "";
  } else if (info.menuItemId === "send_link") {
    payload.type = "link";
    payload.url = info.linkUrl || "";
  } else if (info.menuItemId === "send_page") {
    payload.type = "page";
  }

  const endpoint = await getBridgeUrl();

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.mode === "launched") {
        showNotify(i18n.notifyLaunchedTitle, i18n.notifyLaunchedMsg(data.terminal));
      } else {
        showNotify(i18n.notifyPrefilledTitle, i18n.notifyPrefilledMsg);
      }
    } else {
      showNotify(i18n.notifyFailedTitle, i18n.notifyFailedMsg(res.status));
    }
  } catch (_err) {
    showNotify(i18n.notifyNoConnTitle, i18n.notifyNoConnMsg);
  }
});

function showNotify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: title,
    message: message,
    priority: 1,
  });
}
