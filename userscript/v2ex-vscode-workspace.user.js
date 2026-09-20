// ==UserScript==
// @name         V2EX · VS Code 工作区
// @namespace    http://tampermonkey.net/
// @version      0.6.1
// @description  把 V2EX 换成 VS Code 风格工作区（支持 Light+ / Dark+）。帖子详情生成伪代码文件（默认 Vue SFC，可切换 Java/JS/TS/Python/Go/Rust/C++），正文与回复全部以注释绿显示并保留原始换行；图片用 emoji，hover 出 500px / 50% 透明预览。
// @author       chenjiabin
// @license      MIT
// @homepageURL  https://github.com/SCAUCJB/looks-like-work
// @supportURL   https://github.com/SCAUCJB/looks-like-work/issues
// @downloadURL  https://raw.githubusercontent.com/SCAUCJB/looks-like-work/main/userscript/v2ex-vscode-workspace.user.js
// @updateURL    https://raw.githubusercontent.com/SCAUCJB/looks-like-work/main/userscript/v2ex-vscode-workspace.user.js
// @match        *://*.v2ex.com/*
// @exclude      *://static.v2ex.com/*
// @exclude      *://cdn.v2ex.com/*
// @exclude      *://i.v2ex.co/*
// @icon         https://www.v2ex.com/static/favicon.ico
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  if (document.documentElement.classList.contains("wecom-im-theme")) {
    console.warn("[v2ex-vscode] 检测到企微换肤，已跳过。请只启用一套外观脚本。");
    return;
  }

  const STYLE_ID = "v2ex-vscode-theme";
  const ROOT_CLASS = "vsc-theme";
  const LOCK_CLASS = "vsc-locked";
  const VIEW_KEY = "v2ex-vscode-view";
  const SIDEBAR_KEY = "v2ex-vscode-sidebar";
  const PANEL_KEY = "v2ex-vscode-panel";
  const PANEL_H_KEY = "v2ex-vscode-panel-h";
  const PANEL_OPEN_KEY = "v2ex-vscode-panel-open";
  const PANEL_H_MIN = 80;   // 最小高度：够放 tabs + 输入行
  const PANEL_H_KEEP = 150; // 上方编辑器至少保留的高度
  const LAST_LIST_KEY = "v2ex-vscode-last-list";
  const LANG_KEY = "v2ex-vscode-lang";
  const THEME_KEY = "v2ex-vscode-theme";
  const LIGHT_CLASS = "vsc-light";

  const LANGS = [
    { id: "vue", label: "Vue", ext: "vue" },
    { id: "javascript", label: "JavaScript", ext: "js" },
    { id: "typescript", label: "TypeScript", ext: "ts" },
    { id: "python", label: "Python", ext: "py" },
    { id: "java", label: "Java", ext: "java" },
    { id: "go", label: "Go", ext: "go" },
    { id: "rust", label: "Rust", ext: "rs" },
    { id: "cpp", label: "C++", ext: "cpp" },
  ];

  function currentTheme() {
    return lsGet(THEME_KEY, "dark") === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    const t = theme === "light" || theme === "dark" ? theme : currentTheme();
    lsSet(THEME_KEY, t);
    document.documentElement.classList.toggle(LIGHT_CLASS, t === "light");
    const btn = document.querySelector(".vsc-theme-btn");
    if (btn) {
      const toLight = t === "dark";
      btn.title = toLight ? "切换浅色主题 Light+" : "切换深色主题 Dark+";
      btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
      btn.innerHTML = toLight
        ? ico('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.2 6.2l1.4 1.4M16.4 16.4l1.4 1.4M6.2 17.8l1.4-1.4M16.4 7.6l1.4-1.4"/>')
        : ico('<path d="M17 14.5A7 7 0 0 1 9.5 7 6.2 6.2 0 0 0 9 9a7 7 0 0 0 8 8c.7 0 1.3-.1 1.9-.3A6.4 6.4 0 0 1 17 14.5z"/>');
    }
    const chip = document.querySelector(".vsc-theme-chip");
    if (chip) chip.textContent = t === "light" ? "Light+" : "Dark+";
  }

  function toggleTheme() {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
  }

  function currentLang() {
    const id = lsGet(LANG_KEY, "vue");
    return LANGS.find((l) => l.id === id) || LANGS[0];
  }

  const NATIVE_PATHS = /^\/(signin|signup|forgot|settings|account|new|write|notes|balance|mission|notifications|member\/|append_topic|edit\/|delete\/|preview|2fa|planes|changes|help|about|advertise|faq|api|search|my\/)/i;
  const IMG_EMOJI = ["🖼️", "📷", "🌄", "🗺️", "🧩", "🎞️", "🏞️", "🌈", "📸", "🧿"];

  const FOLDERS = [
    { href: "/", label: "latest" },
    { href: "/?tab=hot", label: "hot" },
    { href: "/?tab=tech", label: "tech" },
    { href: "/?tab=creative", label: "creative" },
    { href: "/?tab=play", label: "play" },
    { href: "/?tab=apple", label: "apple" },
    { href: "/?tab=jobs", label: "jobs" },
    { href: "/?tab=qna", label: "qna" },
    { href: "/recent", label: "recent" },
  ];

  const QUICK_NODES = [
    "/go/programmer", "/go/python", "/go/share", "/go/create",
    "/go/openai", "/go/claude", "/go/macos", "/go/career",
  ];

  const state = {
    user: { name: "", loggedIn: false, avatar: "" },
    listUrl: "/",
    listPage: 1,
    listPages: 1,
    topics: [],
    openFolders: { src: true, nodes: true, latest: true },
    tabs: [],
    activeTab: "welcome",
    topic: null,
    once: "",
    activity: "explorer",
    panel: lsGet(PANEL_KEY, "terminal"),
    panelOpen: lsGet(PANEL_OPEN_KEY, "1") !== "0",
    sending: false,
    paletteOpen: false,
  };

  const htmlCache = new Map();

  /* ============================== 工具 ============================== */

  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // 超长文本截断并补省略号（仅用于单行摘要场景）
  function truncate(text, max) {
    const s = String(text ?? "");
    return s.length > max ? s.slice(0, max) + "…" : s;
  }

  // 读取用户拖拽保存过的面板高度；无记录/非法值返回空串（走 CSS 默认自适应）
  function storedPanelH() {
    const v = Number(lsGet(PANEL_H_KEY, 0));
    return Number.isFinite(v) && v >= PANEL_H_MIN ? `${Math.round(v)}px` : "";
  }

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }

  function lsDel(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  function topicIdFromHref(href) {
    const m = String(href || "").match(/\/t\/(\d+)/);
    return m ? m[1] : "";
  }

  function absUrl(href) {
    try { return new URL(href, location.origin).href; } catch { return href; }
  }

  function isImRoute(pathname, search) {
    const path = pathname || location.pathname;
    if (NATIVE_PATHS.test(path)) return false;
    if (path === "/" || path === "" || path === "/recent" || path === "/xna") return true;
    if (/^\/t\/\d+/.test(path) || /^\/go\/[^/]+/.test(path)) return true;
    if ((path === "/" || path === "") && (search || "").includes("tab=")) return true;
    return false;
  }

  function getView() {
    return lsGet(VIEW_KEY, "ide") === "native" ? "native" : "ide";
  }

  function mulberry32(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return function () {
      a |= 0;
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function pick(rand, arr) {
    return arr[Math.floor(rand() * arr.length) % arr.length];
  }

  function slugFile(title, id, ext) {
    const s = String(title || "topic")
      .replace(/[^\w\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 28);
    return `t${id}-${s || "topic"}.${ext || currentLang().ext}`;
  }

  function parseOnce(doc) {
    const input = doc.querySelector('input[name="once"]');
    if (input?.value) return input.value;
    const html = doc.documentElement?.innerHTML || "";
    const m = html.match(/once\s*=\s*["']?(\d+)/);
    return m ? m[1] : "";
  }

  /* 从页面里解析分页信息：V2EX 的分页控件是 input.page_input（value=当前页, max=总页数），
     退化时用 a.page_normal 里的最大页码 */
  function parsePager(doc) {
    const input = doc.querySelector("input.page_input");
    if (input) {
      return {
        page: parseInt(input.value || "1", 10) || 1,
        pages: parseInt(input.getAttribute("max") || "1", 10) || 1,
      };
    }
    const nums = [...doc.querySelectorAll("a.page_normal")]
      .map((a) => parseInt(a.textContent, 10))
      .filter((n) => Number.isFinite(n));
    if (nums.length) return { page: 1, pages: Math.max(...nums) };
    return { page: 1, pages: 1 };
  }

  function pageFromSearch(search = location.search) {
    const m = (search || "").match(/[?&]p=(\d+)/);
    return m ? Math.max(1, parseInt(m[1], 10) || 1) : 1;
  }

  function withPage(url, n) {
    const [path, qs] = String(url || "/").split("?");
    const params = new URLSearchParams(qs || "");
    if (n > 1) params.set("p", String(n));
    else params.delete("p");
    const s = params.toString();
    return s ? `${path}?${s}` : path;
  }

  /* ============================== 样式 ============================== */

  const CSS = `
html.${ROOT_CLASS} {
  --vsc-act: #333333;
  --vsc-side: #252526;
  --vsc-editor: #1e1e1e;
  --vsc-title: #3c3c3c;
  --vsc-status: #007acc;
  --vsc-border: #3e3e42;
  --vsc-hover: #2a2d2e;
  --vsc-active: #094771;
  --vsc-fg: #cccccc;
  --vsc-fg2: #bbbbbb;
  --vsc-fg3: #858585;
  --vsc-tab: #2d2d2d;
  --vsc-kw: #569cd6;
  --vsc-fn: #dcdcaa;
  --vsc-str: #ce9178;
  --vsc-cm: #6a9955;
  --vsc-tag: #4ec9b0;
  --vsc-attr: #9cdcfe;
  --vsc-num: #b5cea8;
  --vsc-punc: #d4d4d4;
  --vsc-plain: #d4d4d4;
  --vsc-on: #ffffff;
  --vsc-chrome: #000000;
  --vsc-input: #3c3c3c;
  --vsc-scroll: #424242;
  --vsc-tab-fg: #969696;
  --vsc-tab-sep: #252526;
  --vsc-line-hover: #2a2a2a;
  --vsc-fence: #202020;
  --vsc-panel: #1e1e1e;
  --vsc-panel-line: #2b2b2b;
  --vsc-icon: #858585;
  --vsc-icon-active: #ffffff;
  --vsc-icon-hover: #505050;
  --vsc-btn: #0e639c;
  --vsc-btn-hover: #1177bb;
  --vsc-link: #3794ff;
  --vsc-err: #f48771;
  --vsc-pop: #111111;
  --vsc-menu: #252526;
  --vsc-welcome: #ffffff;
  --vsc-shadow: rgba(0,0,0,.5);
  --vsc-side-w: ${Number(lsGet(SIDEBAR_KEY, 260)) || 260}px;
  --vsc-panel-h: ${storedPanelH() || "clamp(180px, 34vh, 460px)"};
  --vsc-ui: "Segoe UI", "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif;
  --vsc-mono: "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace;
}
html.${ROOT_CLASS}.${LIGHT_CLASS} {
  --vsc-act: #e8e8e8;
  --vsc-side: #f3f3f3;
  --vsc-editor: #ffffff;
  --vsc-title: #dddddd;
  --vsc-status: #007acc;
  --vsc-border: #e5e5e5;
  --vsc-hover: #e8e8e8;
  --vsc-active: #0060c0;
  --vsc-fg: #333333;
  --vsc-fg2: #444444;
  --vsc-fg3: #6e6e6e;
  --vsc-tab: #ececec;
  --vsc-kw: #0000ff;
  --vsc-fn: #795e26;
  --vsc-str: #a31515;
  --vsc-cm: #008000;
  --vsc-tag: #267f99;
  --vsc-attr: #001080;
  --vsc-num: #098658;
  --vsc-punc: #393a34;
  --vsc-plain: #333333;
  --vsc-on: #1e1e1e;
  --vsc-chrome: #d4d4d4;
  --vsc-input: #ffffff;
  --vsc-scroll: #c1c1c1;
  --vsc-tab-fg: #6e6e6e;
  --vsc-tab-sep: #e5e5e5;
  --vsc-line-hover: #f5f5f5;
  --vsc-fence: #f6f8f4;
  --vsc-panel: #f3f3f3;
  --vsc-panel-line: #e5e5e5;
  --vsc-icon: #616161;
  --vsc-icon-active: #1e1e1e;
  --vsc-icon-hover: #d0d0d0;
  --vsc-btn: #007acc;
  --vsc-btn-hover: #0062a3;
  --vsc-link: #006ab1;
  --vsc-err: #e51400;
  --vsc-pop: #ffffff;
  --vsc-menu: #ffffff;
  --vsc-welcome: #1e1e1e;
  --vsc-shadow: rgba(0,0,0,.18);
}
/* 只有 IDE 模式（.vsc-locked）才覆盖原页面样式；原生模式下原页面完全不受影响 */
html.${ROOT_CLASS}.${LOCK_CLASS}, html.${ROOT_CLASS}.${LOCK_CLASS} body {
  background: var(--vsc-editor) !important;
  color: var(--vsc-fg) !important;
  font-family: var(--vsc-ui) !important;
  overflow: hidden !important;
}
.${ROOT_CLASS}.${LOCK_CLASS} #Top, .${ROOT_CLASS}.${LOCK_CLASS} #Bottom,
.${ROOT_CLASS}.${LOCK_CLASS} #Rightbar, .${ROOT_CLASS}.${LOCK_CLASS} #Leftbar,
.${ROOT_CLASS}.${LOCK_CLASS} .adsbygoogle, .${ROOT_CLASS}.${LOCK_CLASS} .wwads-cn,
.${ROOT_CLASS}.${LOCK_CLASS} #pro-campaign-container {
  display: none !important;
}
.${ROOT_CLASS}.${LOCK_CLASS} #Wrapper {
  position: fixed !important; left: -9999px !important; width: 1px !important; height: 1px !important;
  overflow: hidden !important; opacity: 0 !important; pointer-events: none !important;
}
.vsc-app, .vsc-app * { box-sizing: border-box; }
.vsc-app {
  position: fixed; inset: 0; z-index: 200;
  display: grid;
  grid-template-rows: 30px minmax(0, 1fr) 22px;
  grid-template-columns: 48px var(--vsc-side-w) minmax(0, 1fr);
  background: var(--vsc-editor);
  color: var(--vsc-fg);
  font-family: var(--vsc-ui);
  overflow: hidden;
}
.vsc-titlebar {
  grid-column: 1 / -1;
  background: var(--vsc-title);
  display: flex; align-items: center; gap: 10px;
  padding: 0 10px; font-size: 12px; color: var(--vsc-fg);
  border-bottom: 1px solid var(--vsc-chrome);
  user-select: none;
}
.vsc-dots { display: flex; gap: 6px; }
.vsc-dots i { width: 10px; height: 10px; border-radius: 50%; display: block; }
.vsc-dots i:nth-child(1) { background: #ff5f57; }
.vsc-dots i:nth-child(2) { background: #febc2e; }
.vsc-dots i:nth-child(3) { background: #28c840; }
.vsc-menubar { display: flex; gap: 12px; color: var(--vsc-fg); }
.vsc-menubar span { opacity: .85; cursor: default; }
.vsc-title-center { margin: 0 auto; color: var(--vsc-fg2); font-size: 12px; }
.vsc-title-actions { display: flex; gap: 4px; }
.vsc-icon-btn {
  width: 22px; height: 22px; border: 0; background: transparent; color: var(--vsc-fg);
  cursor: pointer; border-radius: 3px; display: grid; place-items: center;
}
.vsc-icon-btn:hover { background: var(--vsc-icon-hover); }
.vsc-icon-btn svg { width: 14px; height: 14px; }
.vsc-activity {
  grid-row: 2 / 3;
  background: var(--vsc-act);
  display: flex; flex-direction: column; align-items: center;
  padding: 4px 0; border-right: 1px solid var(--vsc-chrome);
  min-height: 0; overflow: hidden;
}
.vsc-act-btn {
  width: 48px; height: 48px; border: 0; background: transparent; color: var(--vsc-icon);
  cursor: pointer; position: relative;
}
.vsc-act-btn svg { width: 24px; height: 24px; }
.vsc-act-btn.active { color: var(--vsc-icon-active); }
.vsc-act-btn.active::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; background: var(--vsc-icon-active);
}
.vsc-act-btn:hover { color: var(--vsc-icon-active); }
.vsc-act-badge {
  position: absolute; right: 8px; bottom: 8px; min-width: 16px; height: 16px; padding: 0 4px;
  background: var(--vsc-status); color: #fff; font-size: 9px; line-height: 16px; border-radius: 8px;
}
.vsc-act-spacer { flex: 1; }
.vsc-sidebar {
  grid-row: 2 / 3;
  background: var(--vsc-side);
  border-right: 1px solid var(--vsc-border);
  display: flex; flex-direction: column;
  min-width: 0; min-height: 0; overflow: hidden;
}
.vsc-side-head {
  height: 35px; padding: 0 12px; display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; letter-spacing: .8px; color: var(--vsc-fg2); text-transform: uppercase;
}
.vsc-side-search {
  margin: 0 8px 8px; height: 24px; background: var(--vsc-input); border: 1px solid var(--vsc-border);
  color: var(--vsc-fg); padding: 0 8px; font-size: 12px; outline: none; width: calc(100% - 16px);
  font-family: var(--vsc-ui);
}
.vsc-side-search:focus { border-color: var(--vsc-status); }
.vsc-tree {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 13px;
  padding-bottom: 12px;
}
.vsc-tree::-webkit-scrollbar { width: 10px; }
.vsc-tree::-webkit-scrollbar-thumb { background: var(--vsc-scroll); }
.vsc-tree-row {
  display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
  cursor: pointer; color: var(--vsc-fg); white-space: nowrap; overflow: hidden;
}
.vsc-tree-row:hover { background: var(--vsc-hover); }
.vsc-tree-row.active { background: var(--vsc-active); color: #fff; }
.vsc-tree-row .chev { width: 10px; color: var(--vsc-fg3); font-size: 10px; }
.vsc-file-ico { width: 14px; text-align: center; flex-shrink: 0; font-size: 12px; }
.vsc-file-name { overflow: hidden; text-overflow: ellipsis; }
.vsc-file-meta { margin-left: auto; color: var(--vsc-fg3); font-size: 11px; padding-left: 8px; }
.vsc-work {
  grid-row: 2 / 3;
  display: grid;
  grid-template-rows: 35px 22px minmax(0, 1fr) var(--vsc-panel-h);
  min-width: 0; min-height: 0; overflow: hidden;
  background: var(--vsc-editor);
}
/* 折叠：面板只留 28px 的 tabs 行，仍可点击/双击展开 */
.vsc-app.panel-off .vsc-work { grid-template-rows: 35px 22px minmax(0, 1fr) 28px; }
.vsc-app.panel-off .vsc-panel-body,
.vsc-app.panel-off .vsc-reply-form { display: none; }
.vsc-app.panel-off .vsc-panel-tabs { border-bottom: 0; }
.vsc-tabs {
  display: flex; align-items: stretch; background: var(--vsc-side); overflow-x: auto;
  border-bottom: 1px solid var(--vsc-border);
}
.vsc-tabs::-webkit-scrollbar { height: 0; }
.vsc-tab {
  display: flex; align-items: center; gap: 8px; padding: 0 12px;
  background: var(--vsc-tab); color: var(--vsc-tab-fg); font-size: 13px; border-right: 1px solid var(--vsc-tab-sep);
  cursor: pointer; max-width: 220px; min-width: 80px; white-space: nowrap;
}
.vsc-tab.active { background: var(--vsc-editor); color: var(--vsc-on); }
.vsc-tab .x {
  border: 0; background: transparent; color: inherit; cursor: pointer; opacity: .5; font-size: 14px; padding: 0 2px;
}
.vsc-tab .x:hover { opacity: 1; }
.vsc-crumb {
  display: flex; align-items: center; gap: 6px; padding: 0 12px;
  font-size: 12px; color: var(--vsc-fg2); border-bottom: 1px solid var(--vsc-border); background: var(--vsc-editor);
}
.vsc-crumb span { opacity: .7; }
.vsc-editor {
  min-width: 0; min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  font-family: var(--vsc-mono); font-size: 13px; line-height: 18px;
  background: var(--vsc-editor); position: relative;
}
.vsc-editor::-webkit-scrollbar { width: 10px; height: 10px; }
.vsc-editor::-webkit-scrollbar-thumb { background: var(--vsc-scroll); }
.vsc-code { display: grid; grid-template-columns: 56px 1fr; min-width: max-content; }
.vsc-gutter {
  text-align: right; padding: 8px 12px 8px 0; color: var(--vsc-fg3); user-select: none;
  background: var(--vsc-editor);
}
.vsc-gutter div { height: 18px; }
.vsc-lines { padding: 8px 20px 40px 0; min-width: 640px; }
.vsc-line { height: 18px; white-space: pre; }
.vsc-line:hover { background: var(--vsc-line-hover); }
.vsc-line.vsc-fence {
  background: var(--vsc-fence);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vsc-cm) 50%, transparent);
}
.vsc-kw { color: var(--vsc-kw); }
.vsc-fn { color: var(--vsc-fn); }
.vsc-str { color: var(--vsc-str); }
.vsc-cm { color: var(--vsc-cm); font-style: italic; }
.vsc-tag { color: var(--vsc-tag); }
.vsc-attr { color: var(--vsc-attr); }
.vsc-num { color: var(--vsc-num); }
.vsc-punc { color: var(--vsc-punc); }
.vsc-plain { color: var(--vsc-plain); }
.vsc-img-emoji {
  display: inline-block; cursor: zoom-in; font-style: normal; font-size: 15px;
  padding: 0 2px; border-radius: 3px; line-height: 1;
}
.vsc-img-emoji:hover { background: color-mix(in srgb, var(--vsc-on) 8%, transparent); }
.vsc-img-pop {
  position: fixed; z-index: 9999; width: 500px; max-width: min(500px, 70vw);
  pointer-events: none; opacity: 0; transform: translateY(6px);
  transition: opacity .12s ease, transform .12s ease;
  border: 1px solid var(--vsc-status); border-radius: 4px; overflow: hidden;
  box-shadow: 0 12px 40px var(--vsc-shadow); background: var(--vsc-pop);
}
.vsc-img-pop.show { opacity: 1; transform: none; }
.vsc-img-pop img { display: block; width: 500px; max-width: 100%; height: auto; opacity: .5; }
.vsc-panel {
  position: relative;
  background: var(--vsc-panel); border-top: 1px solid var(--vsc-border);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
/* 面板顶部可拖拽分隔线：上下拖动调整 TERMINAL 高度，双击复位 */
.vsc-panel-resizer {
  position: absolute; top: -2px; left: 0; right: 0; height: 6px;
  cursor: ns-resize; z-index: 400; background: transparent;
  transition: background .12s ease;
}
.vsc-panel-resizer:hover,
.vsc-app.panel-resizing .vsc-panel-resizer { background: var(--vsc-status); }
.vsc-app.panel-resizing { cursor: ns-resize; user-select: none; }
.vsc-app.panel-resizing .vsc-panel-body { overflow-y: hidden; }
.vsc-app.panel-off .vsc-panel-resizer { display: none; }
.vsc-panel-tabs {
  height: 28px; display: flex; align-items: center; gap: 16px; padding: 0 12px;
  font-size: 11px; letter-spacing: .6px; color: var(--vsc-fg3); text-transform: uppercase;
  border-bottom: 1px solid var(--vsc-panel-line);
  user-select: none; cursor: default;
}
/* 折叠/展开按钮，靠右 */
.vsc-panel-toggle {
  margin-left: auto; border: 0; background: transparent; color: var(--vsc-fg3);
  cursor: pointer; font-size: 13px; line-height: 1; padding: 4px 6px; border-radius: 3px;
}
.vsc-panel-toggle:hover { background: var(--vsc-hover); color: var(--vsc-on); }
.vsc-panel-tabs button {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  font-size: 11px; letter-spacing: .6px; text-transform: uppercase; padding: 6px 0;
}
.vsc-panel-tabs button.on { color: var(--vsc-on); border-bottom: 1px solid var(--vsc-on); }
.vsc-panel-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 8px 12px; font-family: var(--vsc-mono); font-size: 12px; color: var(--vsc-fg);
}
.vsc-term-line {
  white-space: pre-wrap; margin: 0 0 4px;
  overflow-wrap: anywhere; word-break: break-word; line-height: 1.5;
}
/* 回复行：首行顶格，折行后悬挂缩进，便于区分楼层 */
.vsc-term-reply { padding-left: 2ch; text-indent: -2ch; }
.vsc-term-reply + .vsc-term-reply { margin-top: 6px; }
.vsc-term-muted { color: var(--vsc-cm); }
.vsc-term-warn { color: var(--vsc-fn); }
.vsc-term-err { color: var(--vsc-err); }
.vsc-reply-form { display: flex; gap: 8px; padding: 6px 12px 8px; border-top: 1px solid var(--vsc-panel-line); }
.vsc-reply-form input {
  flex: 1; height: 26px; background: var(--vsc-input); border: 1px solid var(--vsc-border); color: var(--vsc-fg);
  padding: 0 8px; font-family: var(--vsc-mono); font-size: 12px; outline: none;
}
.vsc-reply-form input:focus { border-color: var(--vsc-status); }
.vsc-reply-form button {
  height: 26px; padding: 0 12px; border: 0; background: var(--vsc-btn); color: #fff; cursor: pointer; font-size: 12px;
}
.vsc-reply-form button:hover { background: var(--vsc-btn-hover); }
.vsc-status {
  grid-column: 1 / -1;
  background: var(--vsc-status); color: #fff; display: flex; align-items: center;
  font-size: 12px; padding: 0 8px; gap: 12px; user-select: none;
}
.vsc-status .right { margin-left: auto; display: flex; gap: 14px; }
.vsc-welcome {
  padding: 48px 56px; max-width: 860px; color: var(--vsc-fg); font-family: var(--vsc-ui);
}
.vsc-welcome h1 { font-weight: 300; font-size: 26px; color: var(--vsc-welcome); margin: 0 0 8px; }
.vsc-welcome .sub { color: var(--vsc-fg3); margin-bottom: 28px; }
.vsc-welcome h2 { font-size: 13px; letter-spacing: .6px; text-transform: uppercase; color: var(--vsc-fg3); }
.vsc-welcome a, .vsc-welcome .link {
  color: var(--vsc-link); cursor: pointer; text-decoration: none; display: block; margin: 6px 0;
}
.vsc-palette {
  position: fixed; left: 50%; top: 12%; transform: translateX(-50%);
  width: min(640px, 80vw); z-index: 800; background: var(--vsc-menu);
  border: 1px solid var(--vsc-status); box-shadow: 0 16px 48px var(--vsc-shadow); display: none;
}
.vsc-palette.open { display: block; }
.vsc-palette input {
  width: 100%; height: 40px; border: 0; background: var(--vsc-input); color: var(--vsc-fg);
  padding: 0 14px; font-size: 14px; outline: none; font-family: var(--vsc-ui);
  border-bottom: 1px solid var(--vsc-border);
}
.vsc-palette-list { max-height: 320px; overflow: auto; }
.vsc-palette-item {
  padding: 6px 14px; font-size: 13px; cursor: pointer; color: var(--vsc-fg);
  display: flex; justify-content: space-between;
}
.vsc-palette-item:hover, .vsc-palette-item.on { background: var(--vsc-active); color: #fff; }
.vsc-fab {
  position: fixed; right: 16px; bottom: 28px; z-index: 700;
  height: 28px; padding: 0 10px; border: 0; border-radius: 2px;
  background: var(--vsc-status); color: #fff; cursor: pointer; display: none;
}
html.${ROOT_CLASS}:not(.${LOCK_CLASS}) .vsc-app { display: none !important; }
html.${ROOT_CLASS}:not(.${LOCK_CLASS}) .vsc-fab { display: inline-flex; align-items: center; }
.vsc-side-resizer {
  position: absolute; top: 30px; bottom: 22px; width: 4px; cursor: col-resize; z-index: 400;
  left: calc(48px + var(--vsc-side-w) - 2px);
}
.vsc-lang { cursor: pointer; padding: 0 6px; border-radius: 3px; }
.vsc-lang:hover, .vsc-theme-chip:hover { background: rgba(255,255,255,.18); }
.vsc-theme-chip { cursor: pointer; padding: 0 6px; border-radius: 3px; }
.vsc-lang-menu {
  position: fixed; right: 10px; bottom: 26px; z-index: 760; min-width: 150px;
  background: var(--vsc-menu); border: 1px solid var(--vsc-status); display: none;
  box-shadow: 0 8px 24px var(--vsc-shadow); font-family: var(--vsc-ui);
}
.vsc-lang-menu.open { display: block; }
.vsc-lang-item {
  padding: 6px 14px; font-size: 12px; color: var(--vsc-fg); cursor: pointer;
  display: flex; justify-content: space-between; gap: 14px;
}
.vsc-lang-item:hover { background: var(--vsc-active); color: #fff; }
.vsc-lang-item.on { color: var(--vsc-on); }
.vsc-lang-item.on::after { content: "✓"; margin-left: auto; }
.vsc-lang-item .ext { color: var(--vsc-fg3); }
.vsc-lang-item:hover .ext { color: #ddd; }
.vsc-list-pager {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-top: 1px solid var(--vsc-border); font-size: 12px; color: var(--vsc-fg2);
}
.vsc-list-pager:empty { display: none; }
.vsc-pg-btn {
  border: 0; background: var(--vsc-input); color: var(--vsc-fg); font-size: 12px; cursor: pointer;
  padding: 2px 10px; border-radius: 3px; font-family: var(--vsc-ui); border: 1px solid var(--vsc-border);
}
.vsc-pg-btn:hover:not(:disabled) { background: var(--vsc-status); color: #fff; border-color: var(--vsc-status); }
.vsc-pg-btn:disabled { opacity: .4; cursor: default; }
.vsc-pg-label { margin: 0 auto; color: var(--vsc-fg3); font-size: 11px; }
.vsc-crumb-pager { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.vsc-crumb-pager .vsc-pg-label { margin: 0; }
`;

  function injectStyle() {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = CSS;
  }

  /* ============================== 解析 ============================== */

  async function fetchDoc(url, { bust = false, cacheMs = 12000 } = {}) {
    const abs = absUrl(url);
    const now = Date.now();
    if (!bust) {
      const hit = htmlCache.get(abs);
      if (hit && now - hit.at < cacheMs) return hit.doc;
    }
    const resp = await fetch(abs, { credentials: "same-origin", headers: { Accept: "text/html" } });
    const doc = new DOMParser().parseFromString(await resp.text(), "text/html");
    htmlCache.set(abs, { doc, at: now });
    return doc;
  }

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    doc.querySelectorAll("script,style,iframe,object,form,input,button").forEach((n) => n.remove());
    doc.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        const val = attr.value || "";
        if (name.startsWith("on") || name === "srcdoc" || /^(javascript|data):/i.test(val.trim())) {
          el.removeAttribute(attr.name);
        }
      });
    });
    return doc.body.firstChild ? doc.body.firstChild.innerHTML : "";
  }

  function parseTopics(doc) {
    const root = doc.querySelector("#Main") || doc;
    const cells = [...root.querySelectorAll(".cell.item, #TopicsNode .cell")];
    const source = cells.length ? cells : [...root.querySelectorAll(".cell")];
    const seen = new Set();
    const topics = [];
    for (const cell of source) {
      const link = cell.querySelector("a.topic-link, .item_title a[href*='/t/']");
      if (!link) continue;
      const id = topicIdFromHref(link.getAttribute("href") || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const node = cell.querySelector("a.node");
      const members = [...cell.querySelectorAll('a[href^="/member/"]')];
      const count = cell.querySelector("a.count_livid, a.count_orange");
      topics.push({
        id,
        title: link.textContent.trim(),
        author: members[0] ? members[0].textContent.trim() : "",
        node: node ? node.textContent.trim() : "general",
        nodeHref: node ? node.getAttribute("href") : "",
        replies: parseInt(count?.textContent || "0", 10) || 0,
        file: slugFile(link.textContent.trim(), id),
      });
    }
    return topics;
  }

  function parseTopicDetail(doc, id) {
    const main = doc.querySelector("#Main") || doc;
    const header = main.querySelector(".header");
    const content = main.querySelector(".topic_content");
    const replies = [...main.querySelectorAll('.cell[id^="r_"]')].map((cell) => {
      const user = cell.querySelector('a[href^="/member/"]');
      const body = cell.querySelector(".reply_content");
      const ago = cell.querySelector(".ago");
      const no = cell.querySelector(".no");
      return {
        id: cell.id.replace(/^r_/, ""),
        user: user ? user.textContent.trim() : "",
        floor: no ? no.textContent.trim() : "",
        time: ago?.getAttribute("title") || ago?.textContent.trim() || "",
        html: sanitizeHtml(body ? body.innerHTML : ""),
      };
    });
    return {
      id: String(id),
      title: header?.querySelector("h1")?.textContent.trim() || "",
      node: header?.querySelector('a[href^="/go/"]')?.textContent.trim() || "",
      nodeHref: header?.querySelector('a[href^="/go/"]')?.getAttribute("href") || "",
      author: header?.querySelector('a[href^="/member/"]')?.textContent.trim() || "",
      html: sanitizeHtml(content ? content.innerHTML : ""),
      replies,
      once: parseOnce(doc),
      canReply: !!doc.querySelector("#reply_content, textarea[name='content']"),
    };
  }

  function detectUser(doc = document) {
    const user = { name: "", loggedIn: false, avatar: "" };
    const member = doc.querySelector('#Rightbar .bigger a[href^="/member/"], #Rightbar a[href^="/member/"] img');
    const img = doc.querySelector("#Rightbar img.avatar");
    const link = doc.querySelector('#Rightbar .bigger a[href^="/member/"], #Rightbar span.bigger a');
    if (link) {
      user.name = link.textContent.trim();
      user.loggedIn = true;
    }
    if (img?.src) user.avatar = img.src;
    if (!user.loggedIn) {
      user.loggedIn = !!doc.querySelector('a[href="/settings"], a[href="/notifications"], a[href="/balance"]');
      if (img?.alt && user.loggedIn) user.name = img.alt;
    }
    state.user = user;
    return user;
  }

  // 把回复 HTML 还原成纯文本：保留原始换行、解码 HTML 实体、图片转 emoji 占位
  function htmlToPlainText(html) {
    const box = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    box.querySelectorAll("img").forEach((img, i) => {
      img.replaceWith(box.createTextNode(` ${IMG_EMOJI[i % IMG_EMOJI.length]} `));
    });
    box.querySelectorAll("br").forEach((br) => br.replaceWith(box.createTextNode("\n")));
    box.querySelectorAll("p,div,li,blockquote,pre,tr,section,article,h1,h2,h3,h4,h5,h6").forEach((el) => {
      el.appendChild(box.createTextNode("\n"));
    });
    return String(box.body.textContent || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // 压成单行（Problems 面板等单行场景用，换行以 ⏎ 标记）
  function htmlToOneLine(html) {
    return htmlToPlainText(html).replace(/\s*\n\s*/g, " ⏎ ");
  }

  function htmlToChunks(html) {
    const box = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
    const images = [...box.querySelectorAll("img")].map((img, i) => ({
      src: img.getAttribute("src") || "",
      alt: img.getAttribute("alt") || img.getAttribute("title") || `image-${i + 1}`,
    })).filter((x) => x.src);
    box.querySelectorAll("img").forEach((img, i) => {
      img.replaceWith(box.createTextNode(` ⟦IMG:${i}⟧ `));
    });

    // 保留原始换行：<br> 转成 \n，块级元素末尾补 \n（textContent 不会为它们产生换行）
    box.querySelectorAll("br").forEach((br) => br.replaceWith(box.createTextNode("\n")));
    box.querySelectorAll("p,div,li,blockquote,h1,h2,h3,h4,h5,h6,tr,section,article").forEach((el) => {
      el.appendChild(box.createTextNode("\n"));
    });

    const fences = [];
    const takeCodeEl = (el) => {
      const codeEl = el.matches("pre") ? (el.querySelector("code") || el) : el;
      const lang = (
        (codeEl.getAttribute("class") || "").match(/(?:language|lang)-([\w+-]+)/i) ||
        (el.getAttribute("class") || "").match(/(?:language|lang)-([\w+-]+)/i) ||
        []
      )[1] || "";
      const body = String(codeEl.textContent || "").replace(/\r/g, "").replace(/\n$/, "");
      if (!body.trim()) return;
      const token = `⟦CODE:${fences.length}⟧`;
      fences.push({ lang, lines: body.split("\n") });
      el.replaceWith(box.createTextNode(` ${token} `));
    };
    box.querySelectorAll("pre").forEach(takeCodeEl);
    box.querySelectorAll("code").forEach((el) => {
      if (el.closest("pre")) return;
      const t = el.textContent || "";
      if (t.includes("\n") || t.length > 72) takeCodeEl(el);
    });

    const text = (box.body.textContent || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");

    function pushSentences(raw, parts) {
      const block = String(raw || "");
      if (!block.trim()) return;
      // 保留原始换行结构，不拆句、不硬切长行
      const lines = block.replace(/\r/g, "").split("\n");
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.forEach((line) => {
        parts.push({ kind: "text", value: line.replace(/[ \t]+$/g, "") });
      });
    }

    function absorbMarkdownFences(raw, parts) {
      const fenceRe = /```([\w+-]*)[ \t]*\n?([\s\S]*?)```/g;
      let last = 0;
      let m;
      while ((m = fenceRe.exec(raw))) {
        pushSentences(raw.slice(last, m.index), parts);
        const body = String(m[2] || "").replace(/\n$/, "");
        if (body.trim()) parts.push({ kind: "fence", lang: m[1] || "", lines: body.split("\n") });
        last = m.index + m[0].length;
      }
      pushSentences(raw.slice(last), parts);
    }

    const parts = [];
    const tokenRe = /⟦CODE:(\d+)⟧/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(text))) {
      absorbMarkdownFences(text.slice(last, m.index), parts);
      const fence = fences[Number(m[1])];
      if (fence) parts.push({ kind: "fence", lang: fence.lang, lines: fence.lines.slice() });
      last = m.index + m[0].length;
    }
    absorbMarkdownFences(text.slice(last), parts);
    return { parts, images };
  }

  /* ============================== Vue 生成 ============================== */

  function vueSkeleton(topic, rand) {
    const id = topic.id;
    const node = topic.node || "general";
    const author = topic.author || "anonymous";
    const titleLit = JSON.stringify(topic.title || "Untitled");
    const indent = pick(rand, [2, 2, 2, 4]);
    const sp = " ".repeat(indent);
    const apiName = pick(rand, ["api", "client", "http", "v2ex"]);
    const storeName = pick(rand, ["useTopicStore", "useThread", "usePost"]);
    const className = pick(rand, ["topic-page", "thread-view", "post-shell"]);

    const script = [
      "<script setup>",
      `import { ref, computed, watch, onMounted } from 'vue'`,
      pick(rand, [
        `import { useRoute } from 'vue-router'`,
        `import { storeToRefs } from 'pinia'`,
        `import { ${apiName} } from '@/lib/${apiName}'`,
      ]),
      pick(rand, [
        `import ${storeName} from '@/stores/topic'`,
        `import { formatTime } from '@/utils/time'`,
        "",
      ]),
      "",
      `const topicId = ref(${id})`,
      `const nodeSlug = ref(${JSON.stringify(node)})`,
      `const author = ref(${JSON.stringify(author)})`,
      `const title = ref(${titleLit})`,
      "const loading = ref(false)",
      "const draft = ref('')",
      "const replies = ref([])",
      pick(rand, ["const collapsed = ref(false)", "const error = ref(null)", ""]),
      "",
      "const replyCount = computed(() => replies.value.length)",
      pick(rand, [
        "const canSubmit = computed(() => draft.value.trim().length > 1)",
        "const headline = computed(() => title.value.slice(0, 80))",
        "",
      ]),
      "",
      "async function fetchTopic() {",
      `${sp}loading.value = true`,
      `${sp}try {`,
      `${sp}${sp}const data = await ${apiName}.get('/t/' + topicId.value)`,
      `${sp}${sp}replies.value = data.replies ?? []`,
      `${sp}} catch (e) {`,
      `${sp}${sp}console.warn('topic load failed', e)`,
      `${sp}} finally {`,
      `${sp}${sp}loading.value = false`,
      `${sp}}`,
      "}",
      "",
      pick(rand, [
        "watch(topicId, fetchTopic)",
        "watch(draft, (v) => { if (v.length > 400) draft.value = v.slice(0, 400) })",
        "",
      ]),
      "",
      "function submit() {",
      `${sp}if (!draft.value.trim()) return`,
      `${sp}replies.value.push({ user: author.value, content: draft.value })`,
      `${sp}draft.value = ''`,
      "}",
      "",
      "onMounted(fetchTopic)",
      "</" + "script>",
    ];

    const tmpl = [
      "<template>",
      `  <section class="${className}" :data-id="topicId">`,
      '    <header class="head">',
      "      <p class=\"crumb\">nodes / {{ nodeSlug }}</p>",
      "      <h1>{{ title }}</h1>",
      '      <p class="meta">{{ author }} · {{ replyCount }} replies</p>',
      "    </header>",
      pick(rand, [
        '    <div v-if="loading" class="skeleton" />',
        '    <p v-if="loading" class="muted">loading…</p>',
        "",
      ]),
      '    <ul class="replies">',
      '      <li v-for="item in replies" :key="item.id">',
      "        <strong>{{ item.user }}</strong>",
      "        <span>{{ item.content }}</span>",
      "      </li>",
      "    </ul>",
      '    <form class="composer" @submit.prevent="submit">',
      '      <textarea v-model="draft" rows="3" />',
      '      <button type="submit">Reply</button>',
      "    </form>",
      "  </section>",
      "</template>",
    ];

    const style = [
      "<style scoped>",
      `.${className} {`,
      "  max-width: 760px;",
      "  margin: 0 auto;",
      "  padding: 24px 16px 64px;",
      "}",
      ".head h1 { font-size: 22px; line-height: 1.35; }",
      ".meta { color: #858585; font-size: 12px; }",
      ".replies { display: flex; flex-direction: column; gap: 12px; }",
      pick(rand, [
        "textarea { width: 100%; font-family: inherit; }",
        ".composer { display: grid; gap: 8px; margin-top: 24px; }",
      ]),
      "</style>",
    ];

    return {
      regions: [
        { name: "script", cstyle: "slash", lines: script.filter((x) => x !== undefined) },
        { name: "template", cstyle: "html", lines: tmpl },
        { name: "style", cstyle: "slash", lines: style },
      ],
    };
  }

  function jsSkeleton(topic, rand) {
    const lines = [
      `import { fetchTopic, postReply } from './api/v2ex.js'`,
      pick(rand, [`import { createStore } from './store.js'`, `import { formatTime } from './utils/time.js'`, ""]),
      "",
      `const topicId = ${topic.id}`,
      `const nodeSlug = ${JSON.stringify(topic.node || "general")}`,
      `const author = ${JSON.stringify(topic.author || "anonymous")}`,
      `const title = ${JSON.stringify(topic.title || "Untitled")}`,
      "",
      "const store = {",
      "  loading: false,",
      "  draft: '',",
      "  replies: [],",
      "}",
      "",
      pick(rand, [
        "const replyCount = () => store.replies.length",
        "const canSubmit = () => store.draft.trim().length > 1",
      ]),
      "",
      "async function loadTopic() {",
      "  store.loading = true",
      "  try {",
      "    const data = await fetchTopic(topicId)",
      "    store.replies = data.replies ?? []",
      "  } catch (err) {",
      "    console.warn('topic load failed', err)",
      "  } finally {",
      "    store.loading = false",
      "  }",
      "}",
      "",
      "async function submit() {",
      "  const text = store.draft.trim()",
      "  if (!text) return",
      "  await postReply(topicId, text)",
      "  store.replies.push({ user: author, content: text })",
      "  store.draft = ''",
      "}",
      "",
      pick(rand, ["loadTopic()", "loadTopic().catch(console.warn)"]),
    ];
    return { regions: [{ name: "main", cstyle: "slash", lines: lines.filter((x) => x !== undefined) }] };
  }

  function tsSkeleton(topic, rand) {
    const lines = [
      "interface Reply {",
      "  id: number",
      "  user: string",
      "  content: string",
      "}",
      "",
      "interface Topic {",
      "  id: number",
      "  title: string",
      "  node: string",
      "  author: string",
      "  replies: Reply[]",
      "}",
      "",
      `const TOPIC_ID: number = ${topic.id}`,
      `const NODE: string = ${JSON.stringify(topic.node || "general")}`,
      `const AUTHOR: string = ${JSON.stringify(topic.author || "anonymous")}`,
      `const TITLE: string = ${JSON.stringify(topic.title || "Untitled")}`,
      "",
      "class TopicService {",
      "  private readonly base = 'https://www.v2ex.com'",
      "",
      "  async get(id: number): Promise<Topic> {",
      "    const resp = await fetch(`${this.base}/t/${id}`)",
      "    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)",
      "    return (await resp.json()) as Topic",
      "  }",
      "",
      pick(rand, [
        "  async reply(id: number, content: string): Promise<void> {",
        "  async reply(id: number, content: string): Promise<boolean> {",
      ]),
      "    await fetch(`${this.base}/t/${id}`, {",
      "      method: 'POST',",
      "      body: new URLSearchParams({ content }),",
      "    })",
      pick(rand, ["  }", "    return true\n  }"]),
      "}",
      "",
      "const service = new TopicService()",
      "",
      "async function main(): Promise<void> {",
      "  const topic = await service.get(TOPIC_ID)",
      "  console.log(topic.title, topic.replies.length, 'replies')",
      "}",
      "",
      "main().catch(console.error)",
    ];
    return { regions: [{ name: "main", cstyle: "slash", lines }] };
  }

  function pySkeleton(topic, rand) {
    const lines = [
      pick(rand, ["import requests", "import httpx", "from urllib import request"]),
      "from dataclasses import dataclass, field",
      "",
      `TOPIC_ID = ${topic.id}`,
      `NODE = ${JSON.stringify(topic.node || "general")}`,
      `AUTHOR = ${JSON.stringify(topic.author || "anonymous")}`,
      `TITLE = ${JSON.stringify(topic.title || "Untitled")}`,
      "",
      "",
      "@dataclass",
      "class Reply:",
      "    user: str",
      "    content: str",
      "",
      "",
      "@dataclass",
      "class Topic:",
      "    id: int",
      "    title: str",
      "    replies: list = field(default_factory=list)",
      "",
      "    def submit(self, draft: str) -> None:",
      "        text = draft.strip()",
      "        if not text:",
      "            return",
      "        self.replies.append(Reply(user=AUTHOR, content=text))",
      "",
      "",
      "def fetch_topic(topic_id: int) -> Topic:",
      `    url = f"https://www.v2ex.com/t/{topic_id}"`,
      "    resp = requests.get(url, timeout=10)",
      "    resp.raise_for_status()",
      "    return Topic(id=topic_id, title=TITLE)",
      "",
      "",
      pick(rand, [
        'if __name__ == "__main__":',
        "def main() -> None:",
      ]),
      "    topic = fetch_topic(TOPIC_ID)",
      '    print(f"{topic.title} · {len(topic.replies)} replies")',
    ];
    return { regions: [{ name: "main", cstyle: "hash", lines }] };
  }

  function javaSkeleton(topic, rand) {
    const className = pick(rand, ["TopicPage", "ThreadView", "PostShell"]);
    const lines = [
      "package com.v2ex.workspace;",
      "",
      "import java.net.URI;",
      "import java.net.http.HttpClient;",
      "import java.net.http.HttpRequest;",
      "import java.net.http.HttpResponse;",
      "import java.util.ArrayList;",
      "import java.util.List;",
      "",
      `public class ${className} {`,
      "",
      `    private static final long TOPIC_ID = ${topic.id}L;`,
      `    private static final String NODE = ${JSON.stringify(topic.node || "general")};`,
      `    private static final String AUTHOR = ${JSON.stringify(topic.author || "anonymous")};`,
      `    private static final String TITLE = ${JSON.stringify(topic.title || "Untitled")};`,
      "",
      "    record Reply(String user, String content) {}",
      "",
      "    private final List<Reply> replies = new ArrayList<>();",
      "    private final HttpClient client = HttpClient.newHttpClient();",
      "",
      "    public void load() throws Exception {",
      '        var req = HttpRequest.newBuilder(URI.create("https://www.v2ex.com/t/" + TOPIC_ID)).build();',
      "        var resp = client.send(req, HttpResponse.BodyHandlers.ofString());",
      '        if (resp.statusCode() != 200) throw new IllegalStateException("HTTP " + resp.statusCode());',
      "    }",
      "",
      "    public void submit(String draft) {",
      "        if (draft == null || draft.isBlank()) return;",
      "        replies.add(new Reply(AUTHOR, draft));",
      "    }",
      "",
      "    public static void main(String[] args) throws Exception {",
      `        var page = new ${className}();`,
      "        page.load();",
      '        System.out.println(TITLE + " · " + page.replies.size() + " replies");',
      "    }",
      "}",
    ];
    return { regions: [{ name: "main", cstyle: "slash", lines }] };
  }

  function goSkeleton(topic, rand) {
    const lines = [
      "package main",
      "",
      "import (",
      '\t"fmt"',
      '\t"net/http"',
      ")",
      "",
      `const topicID = ${topic.id}`,
      "",
      "const (",
      `\tnodeSlug = ${JSON.stringify(topic.node || "general")}`,
      `\tauthor   = ${JSON.stringify(topic.author || "anonymous")}`,
      `\ttitle    = ${JSON.stringify(topic.title || "Untitled")}`,
      ")",
      "",
      "type Reply struct {",
      "\tUser    string",
      "\tContent string",
      "}",
      "",
      "type Topic struct {",
      "\tID      int",
      "\tTitle   string",
      "\tReplies []Reply",
      "}",
      "",
      "func (t *Topic) Submit(draft string) {",
      "\tif draft == \"\" {",
      "\t\treturn",
      "\t}",
      "\tt.Replies = append(t.Replies, Reply{User: author, Content: draft})",
      "}",
      "",
      "func fetchTopic(id int) (*Topic, error) {",
      '\tresp, err := http.Get(fmt.Sprintf("https://www.v2ex.com/t/%d", id))',
      "\tif err != nil {",
      "\t\treturn nil, err",
      "\t}",
      "\tdefer resp.Body.Close()",
      "\treturn &Topic{ID: id, Title: title}, nil",
      "}",
      "",
      "func main() {",
      "\ttopic, err := fetchTopic(topicID)",
      "\tif err != nil {",
      '\t\tfmt.Println("load failed:", err)',
      "\t\treturn",
      "\t}",
      pick(rand, [
        '\tfmt.Println(topic.Title, len(topic.Replies), "replies")',
        '\tfmt.Printf("%s · %d replies\\n", topic.Title, len(topic.Replies))',
      ]),
      "}",
    ];
    return { regions: [{ name: "main", cstyle: "slash", lines }] };
  }

  function rustSkeleton(topic, rand) {
    const lines = [
      "use std::fmt;",
      "",
      `const TOPIC_ID: u64 = ${topic.id};`,
      `const NODE: &str = ${JSON.stringify(topic.node || "general")};`,
      `const AUTHOR: &str = ${JSON.stringify(topic.author || "anonymous")};`,
      `const TITLE: &str = ${JSON.stringify(topic.title || "Untitled")};`,
      "",
      "#[derive(Debug, Clone)]",
      "struct Reply {",
      "    user: String,",
      "    content: String,",
      "}",
      "",
      "#[derive(Debug, Default)]",
      "struct Topic {",
      "    id: u64,",
      "    title: String,",
      "    replies: Vec<Reply>,",
      "}",
      "",
      "impl Topic {",
      "    fn new(id: u64) -> Self {",
      "        Self { id, title: TITLE.to_string(), replies: Vec::new() }",
      "    }",
      "",
      "    fn submit(&mut self, draft: &str) {",
      "        let text = draft.trim();",
      "        if text.is_empty() {",
      "            return;",
      "        }",
      "        self.replies.push(Reply { user: AUTHOR.to_string(), content: text.to_string() });",
      "    }",
      "}",
      "",
      "impl fmt::Display for Topic {",
      "    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
      '        write!(f, "{} · {} replies", self.title, self.replies.len())',
      "    }",
      "}",
      "",
      "fn main() {",
      "    let mut topic = Topic::new(TOPIC_ID);",
      pick(rand, [
        '    topic.submit("hello v2ex");',
        '    topic.submit("nice post");',
      ]),
      '    println!("{}", topic);',
      "}",
    ];
    return { regions: [{ name: "main", cstyle: "slash", lines }] };
  }

  function cppSkeleton(topic, rand) {
    const lines = [
      "#include <iostream>",
      "#include <string>",
      "#include <vector>",
      "",
      "namespace v2ex {",
      "",
      `constexpr long kTopicId = ${topic.id};`,
      `const std::string kNode = ${JSON.stringify(topic.node || "general")};`,
      `const std::string kAuthor = ${JSON.stringify(topic.author || "anonymous")};`,
      `const std::string kTitle = ${JSON.stringify(topic.title || "Untitled")};`,
      "",
      "struct Reply {",
      "    std::string user;",
      "    std::string content;",
      "};",
      "",
      "class TopicPage {",
      "public:",
      "    explicit TopicPage(long id) : id_(id) {}",
      "",
      "    void load() {",
      "        loaded_ = true;",
      "    }",
      "",
      "    void submit(const std::string& draft) {",
      "        if (draft.empty()) return;",
      "        replies_.push_back({kAuthor, draft});",
      "    }",
      "",
      "    std::size_t replyCount() const { return replies_.size(); }",
      "",
      "private:",
      "    long id_;",
      "    bool loaded_ = false;",
      "    std::vector<Reply> replies_;",
      "};",
      "",
      "}  // namespace v2ex",
      "",
      "int main() {",
      "    v2ex::TopicPage page(v2ex::kTopicId);",
      "    page.load();",
      pick(rand, [
        '    page.submit("hello v2ex");',
        '    page.submit("nice post");',
      ]),
      '    std::cout << v2ex::kTitle << " · " << page.replyCount() << " replies" << std::endl;',
      "    return 0;",
      "}",
    ];
    return { regions: [{ name: "main", cstyle: "slash", lines }] };
  }

  const SKELETONS = {
    vue: vueSkeleton,
    javascript: jsSkeleton,
    typescript: tsSkeleton,
    python: pySkeleton,
    java: javaSkeleton,
    go: goSkeleton,
    rust: rustSkeleton,
    cpp: cppSkeleton,
  };

  /* 注释风格：slash 用 // 行注释与块注释（JS/TS/Java/Go/Rust/C++/Vue script），
     hash 用 #（Python），html 用 <!-- -->（Vue template） */
  const COMMENT_STYLE = {
    slash: { open: "/*", mid: " * ", close: " */", line: "// ", single: (t) => `/* ${t} */` },
    hash: { open: null, mid: "# ", close: null, line: "# ", single: (t) => `# ${t}` },
    html: { open: "<!--", mid: "  ", close: "-->", line: null, single: (t) => `<!-- ${t} -->` },
  };

  function fenceWrap(item, cstyle) {
    const lang = item.lang || "code";
    const who = item.prefix ? `${item.prefix} ` : "";
    const src = (item.lines && item.lines.length ? item.lines : [""]).map((l) => l.replace(/\t/g, "  "));
    const code = src.map((l) => ({ type: "code", text: l || " ", fence: true }));
    if (cstyle === "html") {
      return { rows: [{ type: "comment", text: `<!-- ${who}${lang}` }, ...code, { type: "comment", text: "-->" }] };
    }
    if (cstyle === "hash") {
      return { rows: [{ type: "comment", text: `# --- ${who}${lang} ---` }, ...code, { type: "comment", text: "# --- end ---" }] };
    }
    return { rows: [{ type: "comment", text: `/* ${who}${lang}` }, ...code, { type: "comment", text: "*/" }] };
  }

  function replyBlockWrap(reply, cstyle, images) {
    const cs = COMMENT_STYLE[cstyle] || COMMENT_STYLE.slash;
    const header = `@${reply.user}#${reply.floor}`;
    const open = cstyle === "html" ? `<!-- ${header}` : cstyle === "hash" ? `# ${header}` : `/* ${header}`;
    const close = cstyle === "html" ? "-->" : cstyle === "hash" ? "# ──────────" : " */";
    const rows = [{ type: "comment", text: open }];

    reply.parts.forEach((part) => {
      if (part.kind === "fence") {
        const lang = part.lang || "code";
        const src = (part.lines || [""]).map((l) => l.replace(/\t/g, "  "));
        rows.push({ type: "comment", text: `${cs.mid}\`\`\`${lang}` });
        src.forEach((l) => rows.push({ type: "code", text: l || " ", fence: true }));
        rows.push({ type: "comment", text: `${cs.mid}\`\`\``.trimEnd() });
        return;
      }
      const lines = String(part.value || "").split("\n");
      lines.forEach((line) => {
        rows.push({ type: "comment", text: line ? `${cs.mid}${line}` : cs.mid.trimEnd() });
      });
    });

    const imgMarks = extractCommentImages(
      reply.parts.filter((p) => p.kind === "text").map((p) => p.value || ""),
      images
    );
    rows.push({ type: "comment", text: close, images: imgMarks });
    return { rows };
  }

  function extractCommentImages(chunks, images) {
    const joined = (Array.isArray(chunks) ? chunks : [chunks]).join(" ");
    return [...joined.matchAll(/⟦IMG:(\d+)⟧/g)].map((m) => {
      const img = images[Number(m[1])];
      if (!img) return null;
      const emoji = IMG_EMOJI[Math.abs(hashStr(img.src)) % IMG_EMOJI.length];
      return { emoji, src: img.src, alt: img.alt };
    }).filter(Boolean);
  }

  function splitCommentLines(chunks) {
    const raw = Array.isArray(chunks) ? chunks : [chunks];
    const lines = [];
    raw.forEach((chunk) => {
      String(chunk || "")
        .split(/\n|(?=@\S+#\d+\s)/)
        .map((s) => s.replace(/⟦IMG:\d+⟧/g, " ").replace(/[ \t]+/g, " ").trimEnd())
        .forEach((line) => {
          // 保留原始行结构，不再按固定宽度硬切
          lines.push(line.trim() ? line.trim() : "");
        });
    });
    // 去掉首尾空行，中间空行保留
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines;
  }

  function commentWrap(chunks, cstyle, rand, images) {
    const cs = COMMENT_STYLE[cstyle] || COMMENT_STYLE.slash;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    if (list.length === 1 && list[0] && list[0].kind === "fence") {
      return fenceWrap(list[0], cstyle);
    }
    if (list.length === 1 && list[0] && list[0].kind === "reply") {
      return replyBlockWrap(list[0], cstyle, images);
    }
    const texts = list.map((c) => (typeof c === "string" ? c : c?.value || "")).filter(Boolean);
    const imgMarks = extractCommentImages(texts, images);
    const linesText = splitCommentLines(texts);
    const multi = linesText.length > 1;

    if (!linesText.length && !imgMarks.length) return { lines: [], images: [] };
    if (!linesText.length) return { lines: [], images: imgMarks };

    if (multi) {
      // html 没有行注释，只能块注释；slash/hash 随机选行注释或块注释
      if (cs.open && (cs.line ? rand() >= 0.45 : true)) {
        return {
          lines: [cs.open, ...linesText.map((l) => (cs.mid + l).trimEnd()), cs.close],
          images: imgMarks,
        };
      }
      return { lines: linesText.map((l) => (cs.line + l).trimEnd()), images: imgMarks };
    }

    const clean = linesText[0];
    const roll = rand();
    if (cs.line && roll < 0.22 && clean.length < 48) {
      return { lines: [], images: imgMarks, inline: ` ${cs.line}${clean}` };
    }
    if (roll < 0.5 || !cs.line) return { lines: [cs.single(clean)], images: imgMarks };
    return { lines: [`${cs.line}${clean}`], images: imgMarks };
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function buildVueDocument(topic) {
    const rand = mulberry32(Number(topic.id) * 997 + (topic.title || "").length);
    const lang = currentLang();
    const skeleton = (SKELETONS[lang.id] || SKELETONS.vue)(topic, rand);
    const regions = skeleton.regions;
    const op = htmlToChunks(topic.html);
    const replyBlocks = [];
    topic.replies.slice(0, 100).forEach((r) => {
      const c = htmlToChunks(r.html);
      const offset = op.images.length;
      const parts = c.parts.map((p) => {
        if (p.kind === "fence") return p;
        const shifted = String(p.value || "").replace(/⟦IMG:(\d+)⟧/g, (_, n) => `⟦IMG:${offset + Number(n)}⟧`);
        return { kind: "text", value: shifted };
      });
      op.images.push(...c.images);
      replyBlocks.push({ kind: "reply", user: r.user, floor: r.floor, parts, images: c.images.map((_, i) => offset + i) });
    });

    const pool = [
      topic.title ? { kind: "text", value: `主题：${topic.title}` } : null,
      { kind: "text", value: `${topic.author} @ ${topic.node || "v2ex"}` },
      ...op.parts,
      ...replyBlocks,
    ].filter(Boolean);

    const out = [];
    let pi = 0;

    function takeChunks() {
      if (pi >= pool.length) return [];
      if (pool[pi].kind === "fence" || pool[pi].kind === "reply") return [pool[pi++]];
      const n = 1 + Math.floor(rand() * (rand() < 0.3 ? 3 : 1));
      const slice = [];
      for (let k = 0; k < n && pi < pool.length; k++) {
        if (pool[pi].kind === "fence" || pool[pi].kind === "reply") break;
        slice.push(pool[pi++]);
      }
      return slice;
    }

    function emitWrap(wrap) {
      if (wrap.rows) {
        wrap.rows.forEach((row) => out.push(row));
        return true;
      }
      if (wrap.inline) {
        out.push({ type: "comment", text: wrap.inline.trim(), images: wrap.images });
        return true;
      }
      wrap.lines.forEach((t, idx) => {
        const last = idx === wrap.lines.length - 1;
        out.push({ type: "comment", text: t, images: last ? wrap.images : [] });
      });
      if (!wrap.lines.length && wrap.images?.length) {
        out.push({ type: "comment", text: "// media", images: wrap.images });
      }
      return true;
    }

    regions.forEach((region, ri) => {
      if (ri) out.push({ type: "code", text: "" });
      let i = 0;
      while (i < region.lines.length) {
        const burst = 1 + Math.floor(rand() * (rand() < 0.35 ? 2 : 6));
        for (let k = 0; k < burst && i < region.lines.length; k++, i++) {
          const line = region.lines[i];
          if (pi < pool.length && rand() < 0.12 && line && !line.startsWith("<") && region.cstyle !== "html") {
            const wrap = commentWrap(takeChunks(), region.cstyle, rand, op.images);
            if (wrap.inline) {
              out.push({ type: "code", text: line + wrap.inline, images: wrap.images });
              continue;
            }
            emitWrap(wrap);
          }
          out.push({ type: "code", text: line });
        }
        if (pi < pool.length && rand() < 0.72) {
          const gap = Math.floor(rand() * 3);
          for (let g = 0; g < gap; g++) out.push({ type: "code", text: "" });
          emitWrap(commentWrap(takeChunks(), region.cstyle, rand, op.images));
        } else if (rand() < 0.18) {
          out.push({ type: "code", text: "" });
        }
      }
    });

    while (pi < pool.length) {
      if (rand() < 0.4) out.push({ type: "code", text: "" });
      emitWrap(commentWrap(takeChunks(), regions[0] ? regions[0].cstyle : "slash", rand, op.images));
    }

    return out;
  }

  const HIGHLIGHT_KEYWORDS = "import|from|const|let|var|function|async|await|return|if|else|elif|for|while|loop|try|catch|except|finally|export|default|class|interface|struct|enum|impl|fn|func|def|public|private|protected|static|final|void|null|None|true|false|True|False|package|pub|mut|ref|switch|case|break|continue|defer|extends|implements|throws|throw|raise|yield|namespace|using|template|typename|virtual|override|constexpr|sizeof|computed|watch|onMounted|record|include|new|this|self|super|go|type|match|where|in|of|as|is|not|and|or|with|use|mod|pass|auto|var";

  function highlightCode(text) {
    if (!text) return "";
    let s = escapeHtml(text);
    // 先保护字符串字面量（escapeHtml 后引号是 &quot; / &#39;），
    // 避免字符串里的 //、#、关键字、数字被误高亮
    const strs = [];
    s = s.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`[^`]*`)/g, (m) => {
      strs.push(m);
      return `\u0001S${strs.length - 1}S\u0001`;
    });
    const restore = (x) => x.replace(/\u0001S(\d+)S\u0001/g, (_, i) => `<span class="vsc-str">${strs[Number(i)]}</span>`);
    s = s.replace(/(\/\/.*)$/g, '<span class="vsc-cm">$1</span>');
    s = s.replace(/^(\s*)(#(?![\w[!]).*)$/g, '$1<span class="vsc-cm">$2</span>');
    s = s.replace(/(\s)(#(?![\w[!]).*)$/g, '$1<span class="vsc-cm">$2</span>');
    s = s.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="vsc-cm">$1</span>');
    s = s.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="vsc-cm">$1</span>');
    if (s.includes('class="vsc-cm"')) return restore(s);
    s = s.replace(new RegExp(`\\b(${HIGHLIGHT_KEYWORDS})\\b`, "g"), '<span class="vsc-kw">$1</span>');
    s = s.replace(/\b(\d+)\b/g, '<span class="vsc-num">$1</span>');
    s = s.replace(/\b([A-Za-z_][\w]*)\s*(?=\()/g, '<span class="vsc-fn">$1</span>');
    s = s.replace(/(&lt;\/?)([\w-]+)/g, '<span class="vsc-punc">$1</span><span class="vsc-tag">$2</span>');
    return restore(s);
  }

  function renderLine(row) {
    const imgs = row.images || [];
    const emojiHtml = imgs.map((img) =>
      `<span class="vsc-img-emoji" data-src="${escapeHtml(img.src)}" title="${escapeHtml(img.alt || "")}">${img.emoji}</span>`
    ).join(" ");
    const body = (row.type === "comment" || row.fence)
      ? `<span class="vsc-cm">${escapeHtml(row.text)}</span>`
      : highlightCode(row.text);
    if (!emojiHtml) return body || " ";
    if (!row.text || row.text === "// media") {
      return `<span class="vsc-cm">// assets </span>${emojiHtml}`;
    }
    return `${body} ${emojiHtml}`;
  }

  /* ============================== 壳 ============================== */

  function ico(p) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${p}</svg>`;
  }

  function ensureShell() {
    if (document.querySelector(".vsc-app")) return;
    const app = document.createElement("div");
    app.className = "vsc-app";
    app.innerHTML = `
      <div class="vsc-titlebar">
        <div class="vsc-dots"><i></i><i></i><i></i></div>
        <div class="vsc-menubar">
          <span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Run</span><span>Terminal</span><span>Help</span>
        </div>
        <div class="vsc-title-center">v2ex-workspace — Visual Studio Code</div>
        <div class="vsc-title-actions">
          <button type="button" class="vsc-icon-btn vsc-theme-btn" title="切换浅色主题 Light+"></button>
          <button type="button" class="vsc-icon-btn vsc-palette-btn" title="Command Palette">⌘P</button>
          <button type="button" class="vsc-icon-btn vsc-native-btn" title="原生页面">⇄</button>
        </div>
      </div>
      <nav class="vsc-activity">
        <button type="button" class="vsc-act-btn active" data-act="explorer" title="Explorer">${ico('<path d="M4 6h6l2 2h8v10H4z"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="search" title="Search">${ico('<circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="scm" title="Source Control">${ico('<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M6 8v4a6 6 0 0 0 6 6M18 8v2"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="debug" title="Run">${ico('<polygon points="8,5 19,12 8,19"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="ext" title="Extensions">${ico('<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>')}</button>
        <div class="vsc-act-spacer"></div>
        <button type="button" class="vsc-act-btn vsc-account" title="Account">${ico('<circle cx="12" cy="8" r="3"/><path d="M5 19a7 7 0 0 1 14 0"/>')}</button>
      </nav>
      <aside class="vsc-sidebar">
        <div class="vsc-side-head"><span>Explorer</span><span>···</span></div>
        <input class="vsc-side-search" placeholder="Search files" maxlength="64">
        <div class="vsc-tree"></div>
        <div class="vsc-list-pager"></div>
      </aside>
      <div class="vsc-side-resizer"></div>
      <section class="vsc-work">
        <div class="vsc-tabs"></div>
        <div class="vsc-crumb">src <span>›</span> nodes</div>
        <div class="vsc-editor"></div>
        <div class="vsc-panel">
          <div class="vsc-panel-resizer" title="拖动调整面板高度（双击复位）"></div>
          <div class="vsc-panel-tabs">
            <button type="button" data-panel="problems">Problems</button>
            <button type="button" data-panel="output">Output</button>
            <button type="button" data-panel="terminal" class="on">Terminal</button>
            <button type="button" class="vsc-panel-toggle" title="折叠面板（Ctrl/⌘ + \`）">⌄</button>
          </div>
          <div class="vsc-panel-body"></div>
          <form class="vsc-reply-form">
            <input name="cmd" placeholder="$ reply — 输入后回车发送到当前主题" autocomplete="off">
            <button type="submit">Run</button>
          </form>
        </div>
      </section>
      <footer class="vsc-status">
        <span class="vsc-branch">⎇ main</span>
        <span class="vsc-sync">0↓ 0↑</span>
        <div class="right">
          <span class="vsc-ln">Ln 1, Col 1</span>
          <span>UTF-8</span>
          <span>LF</span>
          <span class="vsc-theme-chip" title="切换 Light+ / Dark+">Dark+</span>
          <span class="vsc-lang" title="切换代码语言">${currentLang().label}</span>
          <span>Prettier</span>
        </div>
      </footer>
      <div class="vsc-img-pop"><img alt=""></div>
      <div class="vsc-lang-menu"></div>
      <div class="vsc-palette">
        <input placeholder="> Search files by name" >
        <div class="vsc-palette-list"></div>
      </div>
    `;
    document.body.appendChild(app);
    const fab = document.createElement("button");
    fab.className = "vsc-fab";
    fab.type = "button";
    fab.textContent = "Open in VS Code";
    document.body.appendChild(fab);
    bindShell();
  }

  function bindShell() {
    const app = document.querySelector(".vsc-app");
    if (!app || app.dataset.bound === "1") return;
    app.dataset.bound = "1";

    app.querySelectorAll(".vsc-act-btn[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        app.querySelectorAll(".vsc-act-btn[data-act]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.activity = btn.dataset.act;
        renderSidebar();
      });
    });

    app.querySelector(".vsc-account").addEventListener("click", () => {
      location.href = state.user.loggedIn && state.user.name
        ? `/member/${state.user.name}`
        : "/signin";
    });

    app.querySelector(".vsc-native-btn").addEventListener("click", () => setView("native"));
    app.querySelector(".vsc-theme-btn").addEventListener("click", toggleTheme);
    app.querySelector(".vsc-theme-chip").addEventListener("click", toggleTheme);
    document.querySelector(".vsc-fab").addEventListener("click", () => {
      if (!isImRoute(location.pathname, location.search)) {
        lsSet(VIEW_KEY, "ide");
        location.href = "/";
        return;
      }
      setView("ide");
    });

    app.querySelector(".vsc-side-search").addEventListener("input", (e) => {
      renderSidebar(e.target.value.trim());
    });

    app.querySelector(".vsc-list-pager").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-lpage]");
      if (btn && !btn.disabled) gotoListPage(Number(btn.dataset.lpage));
    });

    app.querySelector(".vsc-crumb").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-rpage]");
      if (btn && !btn.disabled) setReplyPage(Number(btn.dataset.rpage));
    });

    app.querySelector(".vsc-tree").addEventListener("click", (e) => {
      const row = e.target.closest(".vsc-tree-row");
      if (!row) return;
      if (row.dataset.folder) {
        state.openFolders[row.dataset.folder] = !state.openFolders[row.dataset.folder];
        renderSidebar(app.querySelector(".vsc-side-search").value.trim());
        return;
      }
      if (row.dataset.href && !row.dataset.id) {
        loadList(row.dataset.href, { push: true });
        return;
      }
      if (row.dataset.id) openTopic(row.dataset.id, { push: true });
    });

    app.querySelector(".vsc-tabs").addEventListener("click", (e) => {
      const x = e.target.closest(".x");
      const tab = e.target.closest(".vsc-tab");
      if (x && tab) {
        e.stopPropagation();
        closeTab(tab.dataset.tab);
        return;
      }
      if (tab) activateTab(tab.dataset.tab);
    });

    app.querySelectorAll(".vsc-panel-tabs button[data-panel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.panel = btn.dataset.panel;
        lsSet(PANEL_KEY, state.panel);
        // 面板处于折叠状态时，点 tab 视为「切到该 tab 并展开」
        if (!state.panelOpen) {
          setPanelOpen(true);
          return;
        }
        renderPanel();
      });
    });

    const panelTabs = app.querySelector(".vsc-panel-tabs");
    app.querySelector(".vsc-panel-toggle").addEventListener("click", togglePanel);
    // 双击 tabs 行空白处（不含按钮）折叠/展开
    panelTabs.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      togglePanel();
    });

    app.querySelector(".vsc-reply-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = e.currentTarget.querySelector("input");
      const val = input.value.trim();
      if (!val) return;
      if (val.startsWith(">")) {
        input.value = "";
        openPalette(val.slice(1));
        return;
      }
      submitReply(val);
      input.value = "";
    });

    const palBtn = app.querySelector(".vsc-palette-btn");
    const pal = app.querySelector(".vsc-palette");
    palBtn.addEventListener("click", () => openPalette(""));
    pal.querySelector("input").addEventListener("input", (e) => fillPalette(e.target.value));
    pal.querySelector(".vsc-palette-list").addEventListener("click", (e) => {
      const item = e.target.closest(".vsc-palette-item");
      if (!item) return;
      pal.classList.remove("open");
      if (item.dataset.id) openTopic(item.dataset.id, { push: true });
    });

    const langBtn = app.querySelector(".vsc-lang");
    const langMenu = app.querySelector(".vsc-lang-menu");
    langBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!langMenu.classList.contains("open")) {
        const cur = currentLang().id;
        langMenu.innerHTML = LANGS.map((l) =>
          `<div class="vsc-lang-item${l.id === cur ? " on" : ""}" data-lang="${l.id}"><span>${l.label}</span><span class="ext">.${l.ext}</span></div>`
        ).join("");
      }
      langMenu.classList.toggle("open");
    });
    langMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".vsc-lang-item");
      if (!item) return;
      langMenu.classList.remove("open");
      setLang(item.dataset.lang);
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".vsc-lang-menu") && !e.target.closest(".vsc-lang")) {
        langMenu.classList.remove("open");
      }
    });

    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openPalette("");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        togglePanel();
      }
      if (e.key === "Escape") {
        pal.classList.remove("open");
        langMenu.classList.remove("open");
        hideImgPop();
      }
    });

    const editor = app.querySelector(".vsc-editor");
    const pop = app.querySelector(".vsc-img-pop");
    editor.addEventListener("mouseover", (e) => {
      const em = e.target.closest(".vsc-img-emoji");
      if (!em) return;
      const src = em.getAttribute("data-src");
      if (!src) return;
      const img = pop.querySelector("img");
      img.src = src;
      pop.classList.add("show");
      const r = em.getBoundingClientRect();
      let left = r.right + 12;
      let top = r.top - 20;
      if (left + 500 > window.innerWidth) left = r.left - 512;
      if (top + 320 > window.innerHeight) top = window.innerHeight - 340;
      if (top < 8) top = 8;
      pop.style.left = `${Math.max(8, left)}px`;
      pop.style.top = `${top}px`;
    });
    editor.addEventListener("mouseout", (e) => {
      if (!e.relatedTarget || !e.target.closest(".vsc-img-emoji")) {
        if (!e.relatedTarget?.closest?.(".vsc-img-emoji")) hideImgPop();
      }
    });

    const handle = app.querySelector(".vsc-side-resizer");
    handle.addEventListener("pointerdown", (e) => {
      const start = e.clientX;
      const startW = Number(getComputedStyle(document.documentElement).getPropertyValue("--vsc-side-w").replace("px", "")) || 260;
      const move = (ev) => {
        const w = Math.min(420, Math.max(180, startW + (ev.clientX - start)));
        document.documentElement.style.setProperty("--vsc-side-w", `${w}px`);
        lsSet(SIDEBAR_KEY, String(Math.round(w)));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    // TERMINAL 面板高度：顶部分隔线上下拖动，双击复位为默认自适应高度
    const panelHandle = app.querySelector(".vsc-panel-resizer");
    const panelEl = app.querySelector(".vsc-panel");
    const workEl = app.querySelector(".vsc-work");

    panelHandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      // 用实际渲染高度作为基准，避免 CSS 默认值是 clamp() 时无法解析
      const startH = panelEl.getBoundingClientRect().height;
      const maxH = Math.max(PANEL_H_MIN, workEl.clientHeight - PANEL_H_KEEP);
      app.classList.add("panel-resizing");
      try { panelHandle.setPointerCapture(e.pointerId); } catch {}

      const move = (ev) => {
        // 往上拖 => clientY 变小 => 面板变高
        const h = Math.min(maxH, Math.max(PANEL_H_MIN, startH + (startY - ev.clientY)));
        document.documentElement.style.setProperty("--vsc-panel-h", `${Math.round(h)}px`);
      };
      const up = () => {
        app.classList.remove("panel-resizing");
        const h = Math.round(panelEl.getBoundingClientRect().height);
        if (h >= PANEL_H_MIN) lsSet(PANEL_H_KEY, String(h));
        try { panelHandle.releasePointerCapture(e.pointerId); } catch {}
        panelHandle.removeEventListener("pointermove", move);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      // pointer capture 生效时事件走 handle，否则回退到 window
      panelHandle.addEventListener("pointermove", move);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    panelHandle.addEventListener("dblclick", () => {
      document.documentElement.style.removeProperty("--vsc-panel-h");
      lsDel(PANEL_H_KEY);
    });
  }

  // 折叠/展开底部面板：折叠后仅保留 tabs 行，状态持久化
  function setPanelOpen(open) {
    state.panelOpen = !!open;
    lsSet(PANEL_OPEN_KEY, state.panelOpen ? "1" : "0");
    const app = document.querySelector(".vsc-app");
    if (app) app.classList.toggle("panel-off", !state.panelOpen);
    const btn = document.querySelector(".vsc-panel-toggle");
    if (btn) {
      btn.textContent = state.panelOpen ? "⌄" : "⌃";
      btn.title = state.panelOpen ? "折叠面板（Ctrl/⌘ + `）" : "展开面板（Ctrl/⌘ + `）";
      btn.setAttribute("aria-expanded", state.panelOpen ? "true" : "false");
    }
    if (state.panelOpen) renderPanel();
  }

  function togglePanel() {
    setPanelOpen(!state.panelOpen);
  }

  function hideImgPop() {
    document.querySelector(".vsc-img-pop")?.classList.remove("show");
  }

  function setView(mode) {
    lsSet(VIEW_KEY, mode);
    const ide = mode === "ide" && isImRoute(location.pathname, location.search);
    document.documentElement.classList.toggle(LOCK_CLASS, ide);
  }

  function setLang(id) {
    if (!LANGS.some((l) => l.id === id)) return;
    lsSet(LANG_KEY, id);
    // 语言变了，所有伪文件名扩展名要跟着变
    state.topics.forEach((t) => { t.file = slugFile(t.title, t.id); });
    state.tabs.forEach((t) => { t.file = slugFile(t.title, t.id); });
    const btn = document.querySelector(".vsc-lang");
    if (btn) btn.textContent = currentLang().label;
    if (state.topic) {
      document.title = `${slugFile(state.topic.title, state.topic.id)} — v2ex-workspace`;
    }
    renderTabs();
    renderSidebar(document.querySelector(".vsc-side-search")?.value.trim() || "");
    renderEditor();
    renderPanel();
  }

  function openPalette(q) {
    const pal = document.querySelector(".vsc-palette");
    pal.classList.add("open");
    const input = pal.querySelector("input");
    input.value = q || "";
    input.focus();
    fillPalette(input.value);
  }

  function fillPalette(q) {
    const list = document.querySelector(".vsc-palette-list");
    const s = (q || "").toLowerCase();
    const rows = state.topics.filter((t) =>
      !s || t.file.toLowerCase().includes(s) || t.title.toLowerCase().includes(s) || t.author.toLowerCase().includes(s)
    ).slice(0, 20);
    list.innerHTML = rows.map((t) =>
      `<div class="vsc-palette-item" data-id="${t.id}"><span>${escapeHtml(t.file)}</span><span>${escapeHtml(t.node)}</span></div>`
    ).join("") || `<div class="vsc-palette-item">No matching files</div>`;
  }

  /* ============================== 渲染 ============================== */

  function renderSidebar(filter = "") {
    const tree = document.querySelector(".vsc-tree");
    const head = document.querySelector(".vsc-side-head span");
    if (!tree) return;
    const q = filter.toLowerCase();

    if (state.activity === "search") {
      head.textContent = "Search";
      const hits = state.topics.filter((t) => t.title.toLowerCase().includes(q) || t.author.toLowerCase().includes(q));
      tree.innerHTML = (q ? hits : state.topics).slice(0, 40).map((t) =>
        `<div class="vsc-tree-row" data-id="${t.id}" style="padding-left:12px"><span class="vsc-file-ico">🟩</span><span class="vsc-file-name">${escapeHtml(t.title)}</span></div>`
      ).join("") || `<div class="vsc-tree-row">No results</div>`;
      return;
    }
    if (state.activity === "scm") {
      head.textContent = "Source Control";
      tree.innerHTML = `
        <div class="vsc-tree-row"><span class="vsc-file-ico">⎇</span> main · ${state.topics.length} changes</div>
        ${state.topics.slice(0, 12).map((t) =>
          `<div class="vsc-tree-row" data-id="${t.id}" style="padding-left:16px"><span class="vsc-file-ico">M</span><span class="vsc-file-name">${escapeHtml(t.file)}</span></div>`
        ).join("")}`;
      return;
    }
    if (state.activity === "debug") {
      head.textContent = "Run and Debug";
      tree.innerHTML = `<div class="vsc-tree-row">Run: Open Topic</div><div class="vsc-tree-row">Watch: replies.length</div>`;
      return;
    }
    if (state.activity === "ext") {
      head.textContent = "Extensions";
      tree.innerHTML = `
        <div class="vsc-tree-row">V2EX Syntax</div>
        <div class="vsc-tree-row">Vue Language Features</div>
        <div class="vsc-tree-row">Error Lens</div>
        <div class="vsc-tree-row">Pretty Comments</div>`;
      return;
    }

    head.textContent = "Explorer";
    const byNode = new Map();
    state.topics.forEach((t) => {
      if (q && !t.file.toLowerCase().includes(q) && !t.title.toLowerCase().includes(q)) return;
      const key = t.node || "general";
      if (!byNode.has(key)) byNode.set(key, []);
      byNode.get(key).push(t);
    });

    const folder = (id, label, depth, extra = "") => {
      const open = state.openFolders[id] !== false;
      return `<div class="vsc-tree-row" data-folder="${id}" style="padding-left:${8 + depth * 12}px">
        <span class="chev">${open ? "▾" : "▸"}</span>
        <span class="vsc-file-ico">${open ? "📂" : "📁"}</span>
        <span class="vsc-file-name">${escapeHtml(label)}</span>${extra}
      </div>`;
    };

    let html = folder("src", "SRC", 0) + (state.openFolders.src === false ? "" : (
      folder("nodes", "nodes", 1) +
      (state.openFolders.nodes === false ? "" : [...byNode.entries()].map(([node, files]) => {
        const fid = `n-${node}`;
        const open = state.openFolders[fid] !== false;
        return folder(fid, node, 2, `<span class="vsc-file-meta">${files.length}</span>`) +
          (open ? files.map((t) =>
            `<div class="vsc-tree-row${t.id === state.topic?.id ? " active" : ""}" data-id="${t.id}" style="padding-left:${8 + 3 * 12}px">
              <span class="vsc-file-ico" style="color:#42b883">V</span>
              <span class="vsc-file-name">${escapeHtml(t.file)}</span>
              <span class="vsc-file-meta">${t.replies}</span>
            </div>`
          ).join("") : "");
      }).join(""))
    ));

    html += `<div class="vsc-tree-row" data-id="welcome" style="padding-left:8px"><span class="vsc-file-ico">📄</span><span class="vsc-file-name">README.md</span></div>`;
    html += folder("tabs", "tabs", 0);
    if (state.openFolders.tabs !== false) {
      html += FOLDERS.map((f) =>
        `<div class="vsc-tree-row" data-href="${f.href}" style="padding-left:20px"><span class="vsc-file-ico">📁</span><span class="vsc-file-name">${f.label}.tab</span></div>`
      ).join("");
    }
    tree.innerHTML = html;
  }

  function renderTabs() {
    const el = document.querySelector(".vsc-tabs");
    if (!el) return;
    if (!state.tabs.length) {
      el.innerHTML = `<div class="vsc-tab active" data-tab="welcome"><span class="vsc-file-ico">📄</span> README.md</div>`;
      return;
    }
    el.innerHTML = state.tabs.map((t) =>
      `<div class="vsc-tab${t.id === state.activeTab ? " active" : ""}" data-tab="${t.id}">
        <span style="color:#42b883">V</span>
        <span class="vsc-file-name">${escapeHtml(t.file)}</span>
        <button type="button" class="x" title="Close">×</button>
      </div>`
    ).join("");
  }

  function welcomeHtml() {
    return `<div class="vsc-welcome">
      <h1>v2ex-workspace</h1>
      <div class="sub">Visual Studio Code · Vue 3 · ${state.topics.length} files in explorer</div>
      <h2>Start</h2>
      <div class="link" data-go="palette">Go to File…  ⌘P</div>
      <div class="link" data-go="/?tab=hot">Open folder tabs/hot.tab</div>
      <h2>Recent</h2>
      ${state.topics.slice(0, 8).map((t) =>
        `<div class="link" data-id="${t.id}">src/nodes/${escapeHtml(t.node)}/${escapeHtml(t.file)}</div>`
      ).join("")}
    </div>`;
  }

  function renderEditor() {
    const ed = document.querySelector(".vsc-editor");
    const crumb = document.querySelector(".vsc-crumb");
    if (!ed) return;
    if (state.activeTab === "welcome" || !state.topic) {
      crumb.innerHTML = `v2ex-workspace <span>›</span> README.md`;
      ed.innerHTML = welcomeHtml();
      ed.querySelectorAll(".link[data-id]").forEach((n) => n.addEventListener("click", () => openTopic(n.dataset.id, { push: true })));
      ed.querySelector("[data-go='palette']")?.addEventListener("click", () => openPalette(""));
      ed.querySelector("[data-go='/?tab=hot']")?.addEventListener("click", () => loadList("/?tab=hot", { push: true }));
      document.querySelector(".vsc-ln").textContent = "Ln 1, Col 1";
      document.querySelector(".vsc-branch").textContent = "⎇ main";
    } else {
      const topic = state.topic;
      const rp = topic.page || 1;
      const rt = Math.max(1, topic.pages || 1);
      const replyPager = rt > 1
        ? `<span class="vsc-crumb-pager">` +
          `<button type="button" class="vsc-pg-btn" data-rpage="${rp - 1}" ${rp <= 1 ? "disabled" : ""}>‹</button>` +
          `<span class="vsc-pg-label">回复 ${rp} / ${rt}</span>` +
          `<button type="button" class="vsc-pg-btn" data-rpage="${rp + 1}" ${rp >= rt ? "disabled" : ""}>›</button>` +
          `</span>`
        : "";
      crumb.innerHTML = `src <span>›</span> nodes <span>›</span> ${escapeHtml(topic.node || "general")} <span>›</span> ${escapeHtml(slugFile(topic.title, topic.id))}${replyPager}`;
      const rows = buildVueDocument(topic);
      const gutter = rows.map((_, i) => `<div>${i + 1}</div>`).join("");
      const lines = rows.map((row) => `<div class="vsc-line${row.fence ? " vsc-fence" : ""}">${renderLine(row)}</div>`).join("");
      ed.innerHTML = `<div class="vsc-code"><div class="vsc-gutter">${gutter}</div><div class="vsc-lines">${lines}</div></div>`;
      document.querySelector(".vsc-ln").textContent = `Ln ${rows.length}, Col 1`;
      document.querySelector(".vsc-branch").textContent = `⎇ topic/${topic.id}`;
      document.querySelector(".vsc-title-center").textContent =
        `${slugFile(topic.title, topic.id)} — v2ex-workspace — Visual Studio Code`;
    }
    ed.scrollTop = 0;
    ed.scrollLeft = 0;
  }

  function renderPanel() {
    const body = document.querySelector(".vsc-panel-body");
    const tabs = document.querySelectorAll(".vsc-panel-tabs button[data-panel]");
    tabs.forEach((b) => b.classList.toggle("on", b.dataset.panel === state.panel));
    if (!body) return;
    const t = state.topic;
    if (state.panel === "problems") {
      const n = t ? t.replies.length : 0;
      body.innerHTML = n
        ? `<div class="vsc-term-line vsc-term-warn">[vue] ${n} replies treated as info comments</div>` +
          t.replies.slice(0, 12).map((r) =>
            `<div class="vsc-term-line">src/nodes/${escapeHtml(t.node)}/${slugFile(t.title, t.id)}  <span class="vsc-term-muted">// ${escapeHtml(r.user)}: ${escapeHtml(truncate(htmlToOneLine(r.html), 80))}</span></div>`
          ).join("")
        : `<div class="vsc-term-line vsc-term-muted">No problems have been detected in the workspace.</div>`;
      return;
    }
    if (state.panel === "output") {
      body.innerHTML = `
        <div class="vsc-term-line">[v2ex-syntax] generating ${currentLang().label} source…</div>
        <div class="vsc-term-line">[v2ex-syntax] scattered ${t ? t.replies.length + 1 : 0} comment blocks</div>
        <div class="vsc-term-line vsc-term-muted">images mapped to emoji hover previews (500px @ 50%)</div>`;
      return;
    }
    if (!t) {
      body.innerHTML = `<div class="vsc-term-line">v2ex@workspace $ <span class="vsc-term-muted">open a .${currentLang().ext} file to stream replies</span></div>`;
      return;
    }
    const total = t.replies.length;
    body.innerHTML = [
      `<div class="vsc-term-line vsc-term-muted"># git log --oneline t/${t.id}  (${total} ${total === 1 ? "reply" : "replies"})</div>`,
      `<div class="vsc-term-line">${escapeHtml(t.author)}  ${escapeHtml(t.title)}</div>`,
      // 全量渲染所有楼层，正文保留原始换行、不做字符截断
      ...t.replies.map((r) => {
        const text = htmlToPlainText(r.html);
        const meta =
          `<span class="vsc-term-warn">${escapeHtml(r.user)}</span>` +
          ` <span class="vsc-term-muted">#${escapeHtml(r.floor)}</span>` +
          (r.time ? ` <span class="vsc-term-muted">${escapeHtml(r.time)}</span>` : "");
        const bodyText = text
          ? escapeHtml(text)
          : '<span class="vsc-term-muted">(空回复)</span>';
        return `<div class="vsc-term-line vsc-term-reply">${meta}  ${bodyText}</div>`;
      }),
      `<div class="vsc-term-line">v2ex@t/${t.id} $</div>`,
    ].join("");
    body.scrollTop = 0;
  }

  function activateTab(id) {
    state.activeTab = id;
    if (id === "welcome") {
      state.topic = null;
      renderTabs();
      renderEditor();
      renderPanel();
      return;
    }
    const tab = state.tabs.find((x) => x.id === id);
    if (tab) openTopic(tab.id, { push: false, reuse: true });
  }

  function closeTab(id) {
    state.tabs = state.tabs.filter((t) => t.id !== id);
    if (state.activeTab === id) {
      const next = state.tabs[state.tabs.length - 1];
      state.activeTab = next ? next.id : "welcome";
      if (next) openTopic(next.id, { push: false, reuse: true });
      else {
        state.topic = null;
        renderTabs();
        renderEditor();
        renderPanel();
      }
    } else {
      renderTabs();
    }
  }

  /* ============================== 数据 ============================== */

  async function loadList(url, { push = false, bust = false } = {}) {
    try {
      const same = url === location.pathname + location.search || (url === "/" && location.pathname === "/" && !location.search);
      const doc = same && !bust ? document : await fetchDoc(url, { bust });
      detectUser(doc === document ? document : doc);
      state.topics = parseTopics(doc === document ? document : doc);
      state.listUrl = url;
      const pager = parsePager(doc === document ? document : doc);
      const urlPage = pageFromSearch(url.includes("?") ? `?${url.split("?")[1]}` : "");
      state.listPage = urlPage > 1 ? urlPage : pager.page;
      state.listPages = Math.max(pager.pages, state.listPage);
      lsSet(LAST_LIST_KEY, url);
      if (push) history.pushState({ vsc: 1, kind: "list", url }, "", url);
      renderSidebar();
      renderListPager();
      if (!state.topic) renderEditor();
    } catch (err) {
      document.querySelector(".vsc-tree").innerHTML = `<div class="vsc-tree-row">load failed: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderListPager() {
    const el = document.querySelector(".vsc-list-pager");
    if (!el) return;
    const path = state.listUrl.split("?")[0];
    // 首页 tab 流没有分页；节点页和 /recent 有
    const pageable = /^\/go\//.test(path) || path === "/recent";
    const p = state.listPage;
    const total = state.listPages;
    if (!pageable || (total <= 1 && p <= 1)) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `
      <button type="button" class="vsc-pg-btn" data-lpage="${p - 1}" ${p <= 1 ? "disabled" : ""}>‹ Prev</button>
      <span class="vsc-pg-label">${p} / ${total}</span>
      <button type="button" class="vsc-pg-btn" data-lpage="${p + 1}" ${p >= total ? "disabled" : ""}>Next ›</button>`;
  }

  function gotoListPage(n) {
    const total = Math.max(1, state.listPages || 1);
    const target = Math.min(Math.max(1, n), total);
    if (target === state.listPage) return;
    loadList(withPage(state.listUrl, target), { push: true });
  }

  async function openTopic(id, { push = false, bust = false, reuse = false, page } = {}) {
    if (id === "welcome") {
      activateTab("welcome");
      return;
    }
    try {
      const p = Math.max(1, page || pageFromSearch());
      const topicUrl = p > 1 ? `/t/${id}?p=${p}` : `/t/${id}`;
      const current = topicIdFromHref(location.pathname) === String(id) && pageFromSearch() === p;
      const doc = current && !bust ? document : await fetchDoc(topicUrl, { bust, cacheMs: 6000 });
      const topic = parseTopicDetail(doc, id);
      const pager = parsePager(doc);
      topic.page = p;
      topic.pages = Math.max(pager.pages, p);
      state.topic = topic;
      state.once = topic.once || parseOnce(document);
      state.activeTab = String(id);
      const file = slugFile(topic.title, topic.id);
      if (!state.tabs.some((t) => t.id === String(id))) {
        state.tabs.push({ id: String(id), file, title: topic.title });
      }
      if (push) history.pushState({ vsc: 1, kind: "topic", id, page: p }, "", topicUrl);
      document.title = `${file} — v2ex-workspace`;
      renderTabs();
      renderEditor();
      renderPanel();
      renderSidebar();
    } catch (err) {
      document.querySelector(".vsc-editor").innerHTML =
        `<div class="vsc-welcome"><h1>Failed to open file</h1><p>${escapeHtml(err.message || err)}</p></div>`;
    }
  }

  function setReplyPage(n) {
    const t = state.topic;
    if (!t) return;
    const target = Math.min(Math.max(1, n), Math.max(1, t.pages || 1));
    if (target === (t.page || 1)) return;
    openTopic(t.id, { push: true, page: target });
  }

  async function submitReply(text) {
    if (!state.topic) return;
    if (!state.user.loggedIn) {
      location.href = "/signin";
      return;
    }
    const body = document.querySelector(".vsc-panel-body");
    try {
      let once = state.once || parseOnce(document);
      if (!once) {
        const doc = await fetchDoc(`/t/${state.topic.id}`, { bust: true });
        once = parseOnce(doc);
        state.once = once;
      }
      const payload = new URLSearchParams();
      payload.set("content", text);
      if (once) payload.set("once", once);
      const resp = await fetch(`/t/${state.topic.id}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: payload.toString(),
      });
      if (!resp.ok && resp.status !== 302) throw new Error(`HTTP ${resp.status}`);
      htmlCache.clear();
      // 新回复在最后一页，发完直接跳过去
      await openTopic(state.topic.id, { bust: true, page: Math.max(1, state.topic.pages || 1) });
    } catch (err) {
      if (body) body.insertAdjacentHTML("beforeend", `<div class="vsc-term-line vsc-term-err">send failed: ${escapeHtml(err.message)}</div>`);
    }
  }

  /* ============================== 启动 ============================== */

  function applyRoot() {
    document.documentElement.classList.add(ROOT_CLASS);
    if (getView() === "ide" && isImRoute(location.pathname, location.search)) {
      document.documentElement.classList.add(LOCK_CLASS);
    }
    applyTheme(currentTheme());
  }

  async function start() {
    if (document.querySelector(".vsc-app")) return;
    applyRoot();
    injectStyle();
    ensureShell();
    applyTheme(currentTheme());
    setPanelOpen(state.panelOpen);
    detectUser();
    setView(getView());

    const path = location.pathname;
    const id = topicIdFromHref(path);
    const last = lsGet(LAST_LIST_KEY, "/") || "/";

    if (id && isImRoute(path, location.search)) {
      loadList(/^\//.test(last) ? last : "/", { push: false });
      openTopic(id, { push: false });
    } else if (isImRoute(path, location.search)) {
      await loadList(path + location.search || "/", { push: false });
      state.activeTab = "welcome";
      renderTabs();
      renderEditor();
      renderPanel();
    } else {
      setView("native");
    }

    window.addEventListener("popstate", () => {
      const tid = topicIdFromHref(location.pathname);
      if (tid) openTopic(tid);
      else if (isImRoute(location.pathname, location.search)) {
        loadList(location.pathname + location.search || "/");
        state.topic = null;
        state.activeTab = "welcome";
        renderTabs();
        renderEditor();
        renderPanel();
      } else setView("native");
    });
  }

  applyRoot();
  injectStyle();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
