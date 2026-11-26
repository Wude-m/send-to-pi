/**
 * Send to Pi - Chrome Background Service Worker
 * Version: 1.3.0
 *
 * Dual-path delivery:
 * 1. Primary: Local Bridge Daemon (127.0.0.1:18090) — supports cold-start terminal launch & focus.
 * 2. Zero-Daemon Direct Fallback: Probes active Pi sessions on 127.0.0.1:18091~18095 directly
 *    and routes to the most recently active session (or user-pinned session), terminal-agnostic.
 * 3. Clipboard Fallback: Copies formatted Markdown to clipboard when neither Bridge nor Pi is active.
 */

const DEFAULT_BRIDGE_PORT = 18090;
const DEFAULT_INTERNAL_PORT_START = 18091;
const INTERNAL_PORT_COUNT = 5;
const isChinese = (navigator.language || "").toLowerCase().startsWith("zh");

const i18n = {
  menuSelection: isChinese ? "🚀 发送选中内容给 Pi" : "🚀 Send Selection to Pi",
  menuArticle: isChinese ? "🚀 发送精简文章给 Pi" : "🚀 Send Clean Article to Pi",
  menuLink: isChinese ? "🚀 发送此链接给 Pi" : "🚀 Send Link to Pi",
  notifyLaunchedTitle: isChinese ? "已唤起终端并预填内容" : "Terminal Launched & Prefilled",
  notifyLaunchedMsg: (term) =>
    isChinese
      ? `已启动 ${term || "终端"}，内容已在 Pi 输入框就绪！`
      : `Started ${term || "terminal"}, prompt is ready in Pi!`,
  notifyPrefilledTitle: isChinese ? "已填入 Pi 终端输入框" : "Prefilled into Pi Terminal",
  notifyDirectTitle: isChinese ? "已直连填入 Pi 输入框" : "Prefilled Directly into Pi",
  notifyPrefilledMsg: (target) =>
    isChinese
      ? `内容已送达${target ? `（${target}）` : ""}，可自由补充要求或按 Enter 发送！`
      : `Delivered${target ? ` (${target})` : ""}. Append instructions or press Enter!`,
  notifyClipboardTitle: isChinese ? "已复制到剪贴板（兜底）" : "Copied to Clipboard (Fallback)",
  notifyClipboardMsg: isChinese
    ? "未检测到运行中的 Pi 或 Bridge，已将 Markdown 复制到剪贴板，请切回终端粘贴（或运行 npx send-to-pi start 启用自动唤醒）。"
    : "No active Pi or Bridge detected. Markdown copied to clipboard—paste into your terminal (or run 'npx send-to-pi start' for cold-start launch).",
  notifyBridgeClipboardMsg: isChinese
    ? "未能自动拉起终端，已将格式化内容写入系统剪贴板，请直接粘贴到你的终端中。"
    : "Could not launch a terminal automatically. Content copied to your clipboard—paste into Pi.",
  notifyFailedTitle: isChinese ? "发送失败" : "Failed to Send",
  notifyFailedMsg: (code) =>
    isChinese ? `Bridge 响应状态码: ${code}` : `Bridge daemon responded with status: ${code}`,
  notifyNoConnTitle: isChinese ? "未检测到运行中的 Pi" : "No Active Pi Session Found",
  notifyNoConnMsg: isChinese
    ? "请先在任意终端打开 pi，或启动守护进程 (npx send-to-pi start) 以支持自动唤醒。"
    : "Open Pi in any terminal for zero-daemon direct send, or run 'npx send-to-pi start' for cold-start launch.",
  notifyNoSelectionTitle: isChinese ? "未检测到选中文本" : "No Selection Detected",
  notifyNoSelectionMsg: isChinese
    ? "请先在页面上划选需要发送的文本或代码。"
    : "Please select text or code on the webpage first.",
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        bridgePort: DEFAULT_BRIDGE_PORT,
        internalPortStart: DEFAULT_INTERNAL_PORT_START,
        preferredPort: 0,
      },
      (items) => {
        resolve({
          bridgePort: Number(items.bridgePort) || DEFAULT_BRIDGE_PORT,
          internalPortStart: Number(items.internalPortStart) || DEFAULT_INTERNAL_PORT_START,
          preferredPort: Number(items.preferredPort) || 0,
        });
      }
    );
  });
}

function showNotify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 1,
  });
}

function formatTargetLabel(info) {
  if (!info) return "";
  const parts = [];
  if (info.workdir) {
    const clean = String(info.workdir).replace(/[\\/]+$/, "");
    const base = clean.split(/[\\/]/).pop();
    if (base) parts.push(base);
  }
  if (info.appName || info.terminal) {
    parts.push(info.appName || info.terminal);
  }
  return parts.join(" · ");
}

function formatContent(payload) {
  const { type, text, title, url, lang } = payload;
  const isZh = lang === "zh";

  if (type === "selection") {
    const label = isZh ? "【来源】" : "[Source]";
    return `${label}: ${title || (isZh ? "网页摘录" : "Web Snippet")} (${url || ""})\n\n${text}\n\n`;
  }
  if (type === "article") {
    const titleLabel = isZh ? "【网页文章】" : "[Web Article]";
    const linkLabel = isZh ? "【网页链接】" : "[Link]";
    return `${titleLabel}: ${title || (isZh ? "正文" : "Article")}\n${linkLabel}: ${url || ""}\n\n${text}\n\n`;
  }
  if (type === "link") {
    const label = isZh ? "【网页链接】" : "[Link]";
    return `${label}: ${url}\n\n`;
  }
  const titleLabel = isZh ? "【网页标题】" : "[Title]";
  const linkLabel = isZh ? "【网页链接】" : "[Link]";
  return `${titleLabel}: ${title || (isZh ? "网页" : "Page")}\n${linkLabel}: ${url || ""}\n\n`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probePiPort(port) {
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${port}/health`,
      { method: "GET" },
      450
    );
    if (!res.ok) return null;
    const info = await res.json();
    if (info && info.status === "alive") {
      return { ...info, port };
    }
    return null;
  } catch (_err) {
    return null;
  }
}

async function discoverDirectPiSessions(startPort) {
  const ports = Array.from({ length: INTERNAL_PORT_COUNT }, (_, idx) => startPort + idx);
  const results = await Promise.all(ports.map((p) => probePiPort(p)));
  return results
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(b.activeAt || b.updatedAt || 0) - Number(a.activeAt || a.updatedAt || 0)
    );
}

async function sendDirectlyToPi(port, content) {
  const res = await fetchWithTimeout(
    `http://127.0.0.1:${port}/receive`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
    1500
  );
  if (!res.ok) {
    throw new Error(`Pi port ${port} responded with HTTP ${res.status}`);
  }
  return await res.json();
}

async function tryCopyToClipboardInTab(tabId, text) {
  if (!tabId) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (str) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(str);
            return true;
          }
        } catch (_e) {}
        try {
          const ta = document.createElement("textarea");
          ta.value = str;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          return Boolean(ok);
        } catch (_e) {
          return false;
        }
      },
      args: [text],
    });
    return Boolean(results && results[0] && results[0].result);
  } catch (_err) {
    return false;
  }
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

      if (["script", "style", "noscript", "svg", "canvas", "template"].includes(tag)) {
        return "";
      }

      if (tag === "pre") {
        const codeElem = node.querySelector("code") || node;
        const langClass = (codeElem.getAttribute("class") || "") + " " + (node.getAttribute("class") || "");
        const match = langClass.match(/(?:lang(?:uage)?-|hljs-?)([a-zA-Z0-9_-]+)/i);
        const lang = match ? match[1] : "";
        const codeText = (codeElem.textContent || "").replace(/\r\n/g, "\n").trimEnd();
        return `\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
      }

      if (tag === "code") {
        if (node.closest("pre")) {
          return node.textContent;
        }
        const text = node.textContent || "";
        return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
      }

      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        const prefix = "#".repeat(level);
        const text = getChildrenText(node, depth).trim();
        return `\n\n${prefix} ${text}\n\n`;
      }

      if (tag === "blockquote") {
        const content = getChildrenText(node, depth).trim();
        const quoted = content
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        return `\n\n${quoted}\n\n`;
      }

      if (tag === "a") {
        const text = getChildrenText(node, depth).trim();
        const href = node.getAttribute("href");
        if (!text) return "";
        if (href && !href.startsWith("javascript:")) {
          return `[${text}](${href})`;
        }
        return text;
      }

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

      if (tag === "hr") return "\n\n---\n\n";
      if (tag === "br") return "\n";

      if (tag === "img") {
        const alt = node.getAttribute("alt") || "";
        const src = node.getAttribute("src") || "";
        return src ? `![${alt}](${src})` : "";
      }

      if (tag === "table") {
        return renderTable(node);
      }

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
    const isXTwitter = /(^|\.)((twitter|x)\.com)$/i.test(window.location.hostname);
    if (isXTwitter) {
      const xSelectors = [
        'main [data-testid="twitter-article"]',
        'main [data-testid="article"]',
        'main article[data-testid="tweet"]',
        '[data-testid="twitter-article"]',
        '[data-testid="article"]',
        'article[data-testid="tweet"]',
        "main article",
        "article",
      ];
      let mainTweet = null;
      for (const selector of xSelectors) {
        mainTweet = document.querySelector(selector);
        if (mainTweet) break;
      }

      if (!mainTweet) {
        const tweetText = document.querySelector('[data-testid="tweetText"]');
        mainTweet = tweetText ? tweetText.closest("article") : null;
      }

      if (!mainTweet) return null;

      const cleanTweet = mainTweet.cloneNode(true);
      [
        '[data-testid="User-Name"]',
        '[data-testid="User-Names"]',
        '[data-testid="UserDescription"]',
        '[data-testid="tweetPhoto"]',
        '[data-testid="videoPlayer"]',
        '[role="group"]',
        "time",
        "img",
      ].forEach((selector) => {
        cleanTweet.querySelectorAll(selector).forEach((el) => el.remove());
      });

      const xMarkdown = domToMarkdown(cleanTweet);
      return xMarkdown || null;
    }

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

    return domToMarkdown(mainContainer);
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

async function sendPayload(payload, tabId = null) {
  const { bridgePort, internalPortStart, preferredPort } = await getSettings();
  const formattedContent = formatContent(payload);

  // 0. If user pinned a specific Pi session port in the popup, try it first.
  if (preferredPort > 0) {
    try {
      const res = await sendDirectlyToPi(preferredPort, formattedContent);
      showNotify(i18n.notifyDirectTitle, i18n.notifyPrefilledMsg(formatTargetLabel(res)));
      return;
    } catch (_err) {
      // Pinned session closed — fall through to normal routing.
    }
  }

  // 1. Primary path: local Bridge Daemon (handles hot delivery, cold-start launch, and focus).
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${bridgePort}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      2500
    );

    if (res.ok) {
      const data = await res.json();
      if (data.mode === "launched") {
        showNotify(i18n.notifyLaunchedTitle, i18n.notifyLaunchedMsg(data.terminal));
      } else if (data.mode === "clipboard") {
        showNotify(i18n.notifyClipboardTitle, i18n.notifyBridgeClipboardMsg);
      } else {
        showNotify(i18n.notifyPrefilledTitle, i18n.notifyPrefilledMsg(formatTargetLabel(data)));
      }
      return;
    } else {
      showNotify(i18n.notifyFailedTitle, i18n.notifyFailedMsg(res.status));
      return;
    }
  } catch (_bridgeErr) {
    // Bridge daemon is not running; fall through to zero-daemon direct Pi discovery.
  }

  // 2. Zero-Daemon Direct Fallback: probe active Pi instances directly (terminal-agnostic).
  const directSessions = await discoverDirectPiSessions(internalPortStart);
  for (const session of directSessions) {
    try {
      const res = await sendDirectlyToPi(session.port, formattedContent);
      showNotify(
        i18n.notifyDirectTitle,
        i18n.notifyPrefilledMsg(formatTargetLabel({ ...session, ...res }))
      );
      return;
    } catch (_err) {
      // Try next healthy session if one disappeared mid-request.
    }
  }

  // 3. Final fallback: copy formatted Markdown to clipboard so content is never lost.
  const copied = await tryCopyToClipboardInTab(tabId, formattedContent);
  if (copied) {
    showNotify(i18n.notifyClipboardTitle, i18n.notifyClipboardMsg);
  } else {
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
    const textToSend = markdown || info.selectionText || "";

    const payload = {
      type: "selection",
      text: textToSend,
      title: tab ? tab.title : "",
      url: tab ? tab.url : "",
      lang: isChinese ? "zh" : "en",
    };
    await sendPayload(payload, tabId);
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
    await sendPayload(payload, tabId);
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
    await sendPayload(payload, tabId);
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

    await sendPayload(payload, tab.id);
  }
});
