/**
 * Send to Pi - Chrome Background Service Worker
 */

const DEFAULT_PORT = 18090;

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
    title: "🚀 发送选中内容给 Pi",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: "send_page",
    title: "🚀 发送当前网页给 Pi",
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: "send_link",
    title: "🚀 发送此链接给 Pi",
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
        showNotify("已唤起终端并预填内容", `已启动 ${data.terminal || '终端'}，内容已在 Pi 输入框就绪！`);
      } else {
        showNotify("已填入 Pi 终端输入框", "内容已送达，光标位于末尾，可自由补充要求或按 Enter 发送！");
      }
    } else {
      showNotify("发送失败", `Bridge 响应状态码: ${res.status}`);
    }
  } catch (_err) {
    showNotify(
      "无法连接到 Bridge 守护进程",
      "请确保本地后台 send-to-pi 守护进程已启动（默认端口 18090）。可在扩展选项中更改端口。"
    );
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
