/**
 * Send to Pi - Chrome Background Service Worker
 * Version: 1.1.0
 */

const DEFAULT_PORT = 18090;
const isChinese = (navigator.language || '').toLowerCase().startsWith('zh');

const i18n = {
  menuSelection: isChinese ? "🚀 发送选中内容给 Pi" : "🚀 Send Selection to Pi",
  menuArticle: isChinese ? "🚀 发送精简文章给 Pi" : "🚀 Send Clean Article to Pi",
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
  notifyNoSelectionTitle: isChinese ? "未检测到选中文本" : "No Selection Detected",
  notifyNoSelectionMsg: isChinese
    ? "请先在页面上划选需要发送的文本或代码。"
    : "Please select text or code on the webpage first.",
};

async function getBridgeUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ bridgePort: DEFAULT_PORT }, (items) => {
      const port = items.bridgePort || DEFAULT_PORT;
      resolve(`http://127.0.0.1:${port}/send`);
    });
  });
}

function showNotify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: title,
    message: message,
    priority: 1,
  });
}

// 注册右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "send_selection",
      title: i18n.menuSelection,
      contexts: ["selection"],
    });

    chrome.contextMenus.create({
      id: "send_article",
      title: i18n.menuArticle,
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "send_link",
      title: i18n.menuLink,
      contexts: ["link"],
    });
  });
});

/**
 * 在页面 DOM 上下文中执行的提取器（自包含函数）
 * mode: 'selection' | 'article'
 */
function inPageExtractor(mode) {
  function domToMarkdown(rootNode) {
    if (!rootNode) return "";

    function walk(node, depth) {
      if (!node) return "";

      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      const tag = node.tagName.toLowerCase();

      // 忽略不可视或干扰性标签
      if (["script", "style", "noscript", "svg", "canvas", "template"].includes(tag)) {
        return "";
      }

      // 1. 代码块 <pre>
      if (tag === "pre") {
        const codeElem = node.querySelector("code") || node;
        const langClass = (codeElem.getAttribute("class") || "") + " " + (node.getAttribute("class") || "");
        const match = langClass.match(/(?:lang(?:uage)?-|hljs-?)([a-zA-Z0-9_-]+)/i);
        const lang = match ? match[1] : "";
        const codeText = (codeElem.textContent || "").replace(/\r\n/g, "\n").trimEnd();
        return `\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
      }

      // 2. 行内代码 <code> (不在 pre 内)
      if (tag === "code") {
        if (node.closest("pre")) {
          return node.textContent;
        }
        const text = node.textContent || "";
        return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
      }

      // 3. 标题
      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        const prefix = "#".repeat(level);
        const text = getChildrenText(node, depth).trim();
        return `\n\n${prefix} ${text}\n\n`;
      }

      // 4. 引用
      if (tag === "blockquote") {
        const content = getChildrenText(node, depth).trim();
        const quoted = content
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        return `\n\n${quoted}\n\n`;
      }

      // 5. 链接
      if (tag === "a") {
        const text = getChildrenText(node, depth).trim();
        const href = node.getAttribute("href");
        if (!text) return "";
        if (href && !href.startsWith("javascript:")) {
          return `[${text}](${href})`;
        }
        return text;
      }

      // 6. 强调
      if (tag === "strong" || tag === "b") {
        const text = getChildrenText(node, depth).trim();
        return text ? `**${text}**` : "";
      }
      if (tag === "em" || tag === "i") {
        const text = getChildrenText(node, depth).trim();
        return text ? `*${text}*` : "";
      }
      if (tag === "s" || tag === "del" || tag === "strike") {
        const text = getChildrenText(node, depth).trim();
        return text ? `~~${text}~~` : "";
      }

      // 7. 分割线
      if (tag === "hr") {
        return "\n\n---\n\n";
      }

      // 8. 换行
      if (tag === "br") {
        return "\n";
      }

      // 9. 图片
      if (tag === "img") {
        const alt = node.getAttribute("alt") || "";
        const src = node.getAttribute("src") || "";
        return src ? `![${alt}](${src})` : "";
      }

      // 10. 表格
      if (tag === "table") {
        return renderTable(node);
      }

      // 11. 列表
      if (tag === "ul" || tag === "ol") {
        const isOrdered = tag === "ol";
        let idx = 1;
        const items = [];
        for (const child of node.children) {
          if (child.tagName && child.tagName.toLowerCase() === "li") {
            const itemText = walkLi(child, depth + 1).trim();
            const indent = "  ".repeat(depth);
            const bullet = isOrdered ? `${idx++}. ` : "* ";
            items.push(`${indent}${bullet}${itemText}`);
          }
        }
        return `\n\n${items.join("\n")}\n\n`;
      }

      // 12. 常用块级元素
      if (["p", "div", "section", "article"].includes(tag)) {
        const text = getChildrenText(node, depth).trim();
        return text ? `\n\n${text}\n\n` : "";
      }

      return getChildrenText(node, depth);
    }

    function getChildrenText(node, depth) {
      let result = "";
      for (const child of node.childNodes) {
        result += walk(child, depth);
      }
      return result;
    }

    function walkLi(liNode, depth) {
      let result = "";
      for (const child of liNode.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && ["ul", "ol"].includes(child.tagName.toLowerCase())) {
          result += "\n" + walk(child, depth);
        } else {
          result += walk(child, depth);
        }
      }
      return result;
    }

    function renderTable(table) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (!rows.length) return "";

      const matrix = [];
      let maxCols = 0;

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("th, td")).map((cell) =>
          (cell.textContent || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
        );
        if (cells.length > maxCols) maxCols = cells.length;
        matrix.push(cells);
      }

      if (!matrix.length || maxCols === 0) return "";

      const lines = [];
      const header = matrix[0];
      while (header.length < maxCols) header.push("");
      lines.push(`| ${header.join(" | ")} |`);

      const sep = Array(maxCols).fill("---");
      lines.push(`| ${sep.join(" | ")} |`);

      for (let i = 1; i < matrix.length; i++) {
        const row = matrix[i];
        while (row.length < maxCols) row.push("");
        lines.push(`| ${row.join(" | ")} |`);
      }

      return `\n\n${lines.join("\n")}\n\n`;
    }

    const rawMd = walk(rootNode, 0);
    return rawMd.replace(/\n{3,}/g, "\n\n").trim();
  }

  if (mode === "selection") {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const container = document.createElement("div");
    for (let i = 0; i < selection.rangeCount; i++) {
      container.appendChild(selection.getRangeAt(i).cloneContents());
    }
    const md = domToMarkdown(container);
    return md || selection.toString();
  }

  if (mode === "article") {
    // Readability 简版：整页正文提取
    const clone = document.body.cloneNode(true);

    const removeSelectors = [
      "script", "style", "noscript", "nav", "header", "footer", "aside",
      "iframe", "svg", "form", "[role='navigation']", "[role='banner']",
      "[role='contentinfo']", ".nav", ".menu", ".sidebar", ".ad",
      ".advertisement", ".social-share", ".comments", ".comment-section"
    ];
    removeSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    let mainContainer =
      clone.querySelector("article") ||
      clone.querySelector("main") ||
      clone.querySelector("[role='main']") ||
      clone.querySelector(".post-content") ||
      clone.querySelector(".article-content") ||
      clone.querySelector(".entry-content") ||
      clone.querySelector("#content");

    if (!mainContainer) {
      const candidates = Array.from(clone.querySelectorAll("div, section"));
      let bestElem = clone;
      let maxScore = 0;

      for (const el of candidates) {
        const pCount = el.querySelectorAll("p").length;
        const textLen = (el.textContent || "").trim().length;
        const score = pCount * 100 + textLen;
        if (score > maxScore) {
          maxScore = score;
          bestElem = el;
        }
      }
      mainContainer = bestElem;
    }

    const md = domToMarkdown(mainContainer);
    return md;
  }

  return null;
}

async function extractFromTab(tabId, mode) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: inPageExtractor,
      args: [mode],
    });
    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
    return null;
  } catch (err) {
    console.warn("[SendToPi] executeScript extraction failed:", err);
    return null;
  }
}

async function sendPayload(payload) {
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
}

// 处理右键点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab ? tab.id : null;

  if (info.menuItemId === "send_selection") {
    let markdown = null;
    if (tabId) {
      markdown = await extractFromTab(tabId, "selection");
    }
    // 平滑降级：若 HTML 提取失败则回退到 selectionText
    const textToSend = markdown || info.selectionText || "";

    const payload = {
      type: "selection",
      text: textToSend,
      title: tab ? tab.title : "",
      url: tab ? tab.url : "",
      lang: isChinese ? "zh" : "en",
    };
    await sendPayload(payload);
    return;
  }

  if (info.menuItemId === "send_article") {
    let articleText = null;
    if (tabId) {
      articleText = await extractFromTab(tabId, "article");
    }

    const payload = {
      type: articleText ? "article" : "page",
      text: articleText || "",
      title: tab ? tab.title : "",
      url: tab ? tab.url : "",
      lang: isChinese ? "zh" : "en",
    };
    await sendPayload(payload);
    return;
  }

  if (info.menuItemId === "send_link") {
    const payload = {
      type: "link",
      text: "",
      title: tab ? tab.title : "",
      url: info.linkUrl || (tab ? tab.url : ""),
      lang: isChinese ? "zh" : "en",
    };
    await sendPayload(payload);
  }
});

// 处理快捷键事件
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "send-selection") {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id) return;

    const extracted = await extractFromTab(tab.id, "selection");
    if (!extracted || !extracted.trim()) {
      showNotify(i18n.notifyNoSelectionTitle, i18n.notifyNoSelectionMsg);
      return;
    }

    const payload = {
      type: "selection",
      text: extracted.trim(),
      title: tab.title || "",
      url: tab.url || "",
      lang: isChinese ? "zh" : "en",
    };

    await sendPayload(payload);
  }
});
