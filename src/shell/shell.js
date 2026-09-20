/**
 * VS Code 外壳（数据源无关）
 *
 * 外壳只认识一个 source 适配器，不关心数据从哪来：
 * V2EX 版喂帖子，EPUB 版喂章节，接口一致。
 *
 * @typedef {Object} TreeNode
 * @property {"folder" | "file"} kind
 * @property {string} id            folder 用于折叠记忆，file 用于 openFile(id)
 * @property {string} label
 * @property {string} [meta]        右侧灰色小字（章节字数 / 回复数）
 * @property {string} [hint]        hover 提示（文件名是 slug 时用来显示真实标题）
 * @property {string} [icon]        默认 file=📄 folder=📁
 * @property {string} [iconColor]
 * @property {TreeNode[]} [children]
 *
 * @typedef {Object} Row
 * @property {"comment" | "code" | "plain"} type
 * @property {string} text
 * @property {boolean} [fence]      代码栅栏行（带左侧色条背景）
 * @property {number} [para]        正文段落序号（阅读位置锚点，非正文行没有）
 * @property {{emoji: string, src: string, alt: string}[]} [images]
 *
 * @typedef {Object} OpenedDoc
 * @property {string} id
 * @property {string} file          tab 上显示的文件名
 * @property {string[]} crumb       面包屑分段
 * @property {Row[]} rows
 * @property {string} [branch]      状态栏 ⎇ 文案
 * @property {string} [icon]
 * @property {string} [iconColor]
 * @property {number} [restorePara] 渲染后滚到这一段（恢复阅读位置）
 * @property {number} [paras]       正文总段落数
 *
 * @typedef {Object} Source
 * @property {string} id
 * @property {() => string} workspaceName
 * @property {() => TreeNode[]} tree
 * @property {(id: string) => Promise<OpenedDoc> | OpenedDoc} openFile
 * @property {() => string} welcomeHtml
 * @property {(panel: "problems" | "output" | "terminal") => string} panelHtml
 * @property {() => {label: string, hint?: string, run: () => void}[]} commands
 * @property {(activity: string) => {head: string, html: string} | null} [activityView]
 * @property {{placeholder: string, submit: (text: string) => void} | null} [commandLine]
 * @property {(action: string, data: Record<string, string>, el: HTMLElement) => void} [onAction]
 * @property {(cols: number) => void} [onResize]   编辑器可用列数变化（窗口缩放 / 侧栏拖动）
 * @property {(para: number, ratio: number) => void} [onScroll] 阅读位置变化（已防抖）
 * @property {() => {header: string, steps: import("./agent.js").AgentStep[]}} [agentScript] Agent 面板要播的内容
 * @property {() => import("./usage.js").UsageBar[]} [usageStats] 额度条数据（章节进度 / 全书进度）
 * @property {(doc: OpenedDoc | null) => void} [onActivate] 当前文档变了（含切回已缓存的 tab）
 * @property {() => MenuDef[]} [menus]  菜单栏内容
 *
 * @typedef {Object} MenuDef
 * @property {string} label            菜单名，如 "File"
 * @property {MenuItem[]} items
 *
 * @typedef {Object} MenuItem
 * @property {"sep" | "title"} [type] 分隔线 / 分组标题
 * @property {string} [label]
 * @property {string} [hint]           右侧快捷键提示
 * @property {boolean} [disabled]
 * @property {() => void} [run]
 * @property {(ctx: ShellApi) => void} [onReady]
 */

import { escapeHtml, lsGet, lsSet, lsDel } from "./util.js";
import { renderLine } from "./render.js";
import { LIGHT_CLASS } from "./const.js";
import { createAgentRunner, SPEEDS, DEFAULT_SPEED, speedOf } from "./agent.js";
import { usageHtml } from "./usage.js";

const SIDEBAR_KEY = "vsc-side-w";
const PANEL_KEY = "vsc-panel";
const PANEL_H_KEY = "vsc-panel-h";
const PANEL_OPEN_KEY = "vsc-panel-open";
const THEME_KEY = "vsc-theme";
const FONT_KEY = "vsc-code-size";
const AGENT_KEY = "vsc-agent-open";
const AGENT_W_KEY = "vsc-agent-w";
const AGENT_SPEED_KEY = "vsc-agent-speed";
const AGENT_W_MIN = 260;
const AGENT_W_MAX = 720;

const PANEL_H_MIN = 80;
const PANEL_H_KEEP = 150;

/** 编辑器字号档位（px） */
export const FONT_SIZES = [11, 12, 13, 14, 16, 18, 20, 24];
export const DEFAULT_FONT = 13;

/** 当前字号；非法值回落默认 */
export function codeSize() {
  const n = Number(lsGet(FONT_KEY, DEFAULT_FONT));
  if (!Number.isFinite(n)) return DEFAULT_FONT;
  return Math.min(FONT_SIZES[FONT_SIZES.length - 1], Math.max(FONT_SIZES[0], Math.round(n)));
}

/**
 * 行高。必须是整数像素：小数行高会逐行累积误差，
 * 几百行之后行号列就和代码行错开了。
 */
export function codeLine() {
  return Math.round(codeSize() * 1.38);
}

/** 行号列宽度：要放得下 4 位行号，按字号等比缩放 */
export function gutterW() {
  return Math.max(36, Math.round(codeSize() * 4.3));
}

export function currentTheme() {
  return lsGet(THEME_KEY, "dark") === "light" ? "light" : "dark";
}

export function storedPanelH() {
  const v = Number(lsGet(PANEL_H_KEY, 0));
  return Number.isFinite(v) && v >= PANEL_H_MIN ? `${Math.round(v)}px` : "";
}

export function sideWidth() {
  return `${Number(lsGet(SIDEBAR_KEY, 260)) || 260}px`;
}

function ico(p) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${p}</svg>`;
}

/** @param {Source} source */
export function createShell(source) {
  const state = {
    activity: "explorer",
    panel: lsGet(PANEL_KEY, "terminal"),
    panelOpen: lsGet(PANEL_OPEN_KEY, "1") !== "0",
    openFolders: /** @type {Record<string, boolean>} */ ({}),
    /** @type {OpenedDoc[]} */ tabs: [],
    activeTab: "welcome",
    /** @type {OpenedDoc | null} */ doc: null,
    filter: "",
    agentOpen: lsGet(AGENT_KEY, "0") === "1",
    agentSpeed: lsGet(AGENT_SPEED_KEY, DEFAULT_SPEED),
  };

  let app = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
  /**
   * 已经拆掉了。数据源那边的异步回调（恢复进度、写库等）可能在 destroy 之后才到，
   * 那时再去渲染就会对着 null 操作——所有渲染入口都要先看这个标志。
   */
  let destroyed = false;
  const $ = (sel) => /** @type {HTMLElement} */ (app ? app.querySelector(sel) : null);
  /** 外壳还活着吗 */
  const alive = () => !destroyed && !!app;

  /**
   * document / window 上的监听器登记表。
   * 换书时要把旧外壳彻底拆掉——只删 DOM 的话这些监听器会留下来，
   * 和新外壳的监听器叠加，按一次 ⌘I 就会触发两次。
   * @type {(() => void)[]}
   */
  const disposers = [];
  function on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    disposers.push(() => target.removeEventListener(type, handler, opts));
  }

  /* ------------------------------ 主题 ------------------------------ */

  function applyTheme(theme) {
    const t = theme === "light" || theme === "dark" ? theme : currentTheme();
    lsSet(THEME_KEY, t);
    document.documentElement.classList.toggle(LIGHT_CLASS, t === "light");
    const btn = app?.querySelector(".vsc-theme-btn");
    if (btn) {
      const toLight = t === "dark";
      btn.setAttribute("title", toLight ? "切换浅色主题 Light+" : "切换深色主题 Dark+");
      btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
      btn.innerHTML = toLight
        ? ico('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>')
        : ico('<path d="M20.5 14.3A8.2 8.2 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z"/>');
    }
    const chip = app?.querySelector(".vsc-theme-chip");
    if (chip) chip.textContent = t === "light" ? "Light+" : "Dark+";
  }

  function toggleTheme() {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
  }

  /* ------------------------------ 字号 ------------------------------ */

  /**
   * 设置编辑器字号。三个 CSS 变量必须一起改，否则行号列和代码行会错位。
   * 改完要重量列数：字宽变了，auto 折行宽度也得跟着变。
   */
  function setFontSize(px) {
    const n = Number(px);
    if (!Number.isFinite(n)) return;
    const next = Math.min(FONT_SIZES[FONT_SIZES.length - 1], Math.max(FONT_SIZES[0], Math.round(n)));
    lsSet(FONT_KEY, String(next));
    const root = document.documentElement;
    root.style.setProperty("--vsc-code-size", `${next}px`);
    root.style.setProperty("--vsc-code-line", `${Math.round(next * 1.38)}px`);
    root.style.setProperty("--vsc-gutter-w", `${Math.max(36, Math.round(next * 4.3))}px`);
    const chip = app?.querySelector(".vsc-font-chip");
    if (chip) chip.textContent = `${next}px`;
    notifyResize();
  }

  /** 按档位表前后挪一档 */
  function stepFontSize(dir) {
    const cur = codeSize();
    let idx = FONT_SIZES.indexOf(cur);
    if (idx < 0) {
      // 存的是档位表外的值，找最接近的
      idx = FONT_SIZES.reduce((best, v, i) =>
        Math.abs(v - cur) < Math.abs(FONT_SIZES[best] - cur) ? i : best, 0);
    }
    const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, idx + dir))];
    if (next !== cur) setFontSize(next);
  }

  /* ------------------------------ 骨架 ------------------------------ */

  function mount(host = document.body) {
    // 之前这里是「已有外壳就直接 return」，结果换书时新外壳根本没挂上，
    // 页面还停在上一本书。现在兜底把残留的外壳拆掉。
    const stale = document.querySelector(".vsc-app");
    if (stale) {
      console.warn("[shell] 挂载前发现残留外壳，已移除；调用方应先 destroy()");
      stale.remove();
    }
    app = document.createElement("div");
    app.className = "vsc-app";
    app.innerHTML = `
      <div class="vsc-titlebar">
        <div class="vsc-dots"><i></i><i></i><i></i></div>
        <div class="vsc-menubar"></div>
        <div class="vsc-title-center"></div>
        <div class="vsc-title-actions">
          <button type="button" class="vsc-icon-btn vsc-theme-btn"></button>
          <button type="button" class="vsc-icon-btn vsc-palette-btn" title="命令面板（⌘/Ctrl + P）">${ico('<path d="M15 6V4.5a2.5 2.5 0 1 1 2.5 2.5H15zm0 0v12m0-12H9m6 12v1.5a2.5 2.5 0 1 0 2.5-2.5H15zm0 0H9m0 0v1.5A2.5 2.5 0 1 1 6.5 15H9zm0 0V6m0 0V4.5A2.5 2.5 0 1 0 6.5 7H9z"/>')}</button>
          <button type="button" class="vsc-icon-btn vsc-agent-btn" title="Agent 面板（⌘/Ctrl + I）">${ico('<path d="M11 3.5 12.6 8l4.4 1.6-4.4 1.6L11 15.6 9.4 11.2 5 9.6 9.4 8z"/><path d="m18 14.5.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75z"/>')}</button>
        </div>
      </div>
      <nav class="vsc-activity">
        <button type="button" class="vsc-act-btn active" data-act="explorer" title="Explorer">${ico('<path d="M4 6h6l2 2h8v10H4z"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="search" title="Search">${ico('<circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="scm" title="Source Control">${ico('<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M6 8v4a6 6 0 0 0 6 6M18 8v2"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="debug" title="Run">${ico('<polygon points="8,5 19,12 8,19"/>')}</button>
        <button type="button" class="vsc-act-btn" data-act="ext" title="Extensions">${ico('<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>')}</button>
        <div class="vsc-act-spacer"></div>
        <button type="button" class="vsc-act-btn vsc-agent-act" title="Agent（⌘/Ctrl + I）">${ico('<path d="M4 5h16v11H7l-3 3z"/><circle cx="9.5" cy="10.5" r="1"/><circle cx="14.5" cy="10.5" r="1"/>')}</button>
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
        <div class="vsc-crumb"></div>
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
            <input name="cmd" autocomplete="off">
            <button type="submit">Run</button>
          </form>
        </div>
      </section>
      <div class="vsc-agent-resizer"></div>
      <aside class="vsc-agent">
        <div class="vsc-agent-head">
          <span>Agent</span>
          <span class="vsc-agent-model">claude-opus-5</span>
          <button type="button" class="vsc-agent-speed" title="输出速度（点击切换）"></button>
          <button type="button" class="vsc-agent-x" title="关闭（⌘/Ctrl + I）">×</button>
        </div>
        <div class="vsc-agent-body"></div>
        <div class="vsc-usage"></div>
        <div class="vsc-agent-foot"></div>
      </aside>
      <footer class="vsc-status">
        <span class="vsc-branch">⎇ main</span>
        <span class="vsc-sync">0↓ 0↑</span>
        <div class="right">
          <span class="vsc-ln">Ln 1, Col 1</span>
          <span>UTF-8</span>
          <span>LF</span>
          <span class="vsc-font-chip" title="字号（⌘/Ctrl + 加减号调整，点击复位）"></span>
          <span class="vsc-theme-chip" title="切换 Light+ / Dark+">Dark+</span>
          <span class="vsc-progress"></span>
        </div>
      </footer>
      <div class="vsc-img-pop"><img alt=""></div>
      <div class="vsc-menu-pop"></div>
      <div class="vsc-palette">
        <input placeholder="> Search files by name">
        <div class="vsc-palette-list"></div>
      </div>
    `;
    host.appendChild(app);

    bind();
    applyTheme(currentTheme());
    renderMenubar();
    setFontSize(codeSize());
    setPanelOpen(state.panelOpen);
    setAgentSpeed(state.agentSpeed);
    setAgentOpen(state.agentOpen);
    refresh();

    // 先把列数量出来，再交给数据源。否则 onReady 里恢复进度打开的第一章
    // 会用默认宽度渲染一遍，随后又被 onResize 重渲染一遍。
    lastCols = measureCols();

    source.onReady?.(api);

    // 自定义字体加载完成后宽度会变（fallback 字体字宽不同），重量一次
    document.fonts?.ready?.then(() => notifyResize()).catch(() => {});
    return api;
  }

  /* ------------------------------ 事件 ------------------------------ */

  /**
   * 行内动作的统一委托：任何带 data-action 的元素被点击时交给 source 处理，
   * 并阻止冒泡，免得同一次点击又触发了外层的「打开文件」。
   * 树、面板、编辑器三处都走这个入口，数据源不必自己到处挂监听。
   * @returns {boolean} 是否已消费掉这次点击
   */
  function handleAction(e) {
    const el = /** @type {HTMLElement} */ (e.target).closest("[data-action]");
    if (!el) return false;
    e.preventDefault();
    e.stopPropagation();
    source.onAction?.(el.dataset.action || "", { ...el.dataset }, el);
    return true;
  }

  function bind() {
    app.querySelectorAll(".vsc-act-btn[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        app.querySelectorAll(".vsc-act-btn[data-act]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.activity = /** @type {HTMLElement} */ (btn).dataset.act || "explorer";
        renderSidebar();
      });
    });

    $(".vsc-theme-btn").addEventListener("click", toggleTheme);
    $(".vsc-font-chip").addEventListener("click", () => setFontSize(DEFAULT_FONT));
    $(".vsc-theme-chip").addEventListener("click", toggleTheme);
    $(".vsc-palette-btn").addEventListener("click", () => openPalette(""));

    $(".vsc-side-search").addEventListener("input", (e) => {
      state.filter = /** @type {HTMLInputElement} */ (e.target).value.trim();
      renderSidebar();
    });

    $(".vsc-tree").addEventListener("click", (e) => {
      if (handleAction(e)) return;
      const row = /** @type {HTMLElement} */ (e.target).closest(".vsc-tree-row");
      if (!row) return;
      const el = /** @type {HTMLElement} */ (row);
      if (el.dataset.folder) {
        const key = el.dataset.folder;
        state.openFolders[key] = state.openFolders[key] === false;
        renderSidebar();
        return;
      }
      if (el.dataset.id) openFile(el.dataset.id);
    });

    $(".vsc-tabs").addEventListener("click", (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const tab = target.closest(".vsc-tab");
      if (!tab) return;
      const id = /** @type {HTMLElement} */ (tab).dataset.tab || "";
      if (target.closest(".x")) {
        e.stopPropagation();
        closeTab(id);
        return;
      }
      activateTab(id);
    });

    app.querySelectorAll(".vsc-panel-tabs button[data-panel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.panel = /** @type {HTMLElement} */ (btn).dataset.panel || "terminal";
        lsSet(PANEL_KEY, state.panel);
        if (!state.panelOpen) {
          setPanelOpen(true);
          return;
        }
        renderPanel();
      });
    });

    const panelTabs = $(".vsc-panel-tabs");
    $(".vsc-panel-toggle").addEventListener("click", togglePanel);
    panelTabs.addEventListener("dblclick", (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest("button")) return;
      togglePanel();
    });

    // 命令行（面板底部输入）
    const form = /** @type {HTMLFormElement} */ ($(".vsc-reply-form"));
    const cmdInput = /** @type {HTMLInputElement} */ (form.querySelector("input"));
    if (source.commandLine) {
      cmdInput.placeholder = source.commandLine.placeholder;
    } else {
      form.style.display = "none";
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = cmdInput.value.trim();
      if (!val) return;
      cmdInput.value = "";
      if (val.startsWith(">")) {
        openPalette(val.slice(1).trim());
        return;
      }
      source.commandLine?.submit(val);
    });

    // 命令面板
    const pal = $(".vsc-palette");
    /** @type {HTMLInputElement} */ (pal.querySelector("input"))
      .addEventListener("input", (e) => fillPalette(/** @type {HTMLInputElement} */ (e.target).value));
    pal.querySelector(".vsc-palette-list").addEventListener("click", (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest("[data-idx]");
      if (!row) return;
      const idx = Number(/** @type {HTMLElement} */ (row).dataset.idx);
      pal.classList.remove("open");
      paletteItems[idx]?.run();
    });

    on(document, "keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openPalette("");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        togglePanel();
      }
      // Agent 面板：⌘/Ctrl + I 开关（Cursor 的 Toggle Agents）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
        e.preventDefault();
        toggleAgent();
        return;
      }
      // 面板开着且焦点不在输入框里时，回车 = 继续下一段
      if (
        e.key === "Enter" && state.agentOpen && !e.metaKey && !e.ctrlKey && !e.altKey &&
        !/^(INPUT|TEXTAREA)$/.test(/** @type {HTMLElement} */ (e.target)?.tagName || "")
      ) {
        e.preventDefault();
        agent.advance();
        return;
      }
      // 字号：⌘/Ctrl + 加号 / 减号 / 0，与 VS Code 一致
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          stepFontSize(1);
        } else if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          stepFontSize(-1);
        } else if (e.key === "0") {
          e.preventDefault();
          setFontSize(DEFAULT_FONT);
        }
      }
      if (e.key === "Escape") {
        pal.classList.remove("open");
        closeMenu();
        hideImgPop();
      }
    });

    // 面板与编辑器里的行内动作（删书签、切风格、打开书库等）
    $(".vsc-panel-body").addEventListener("click", handleAction);
    $(".vsc-editor").addEventListener("click", handleAction);

    bindMenubar();
    bindImgPop();
    bindResizers();

    on(window, "resize", notifyResize);
    bindScroll();
    bindAgent();
  }

  function bindAgent() {
    $(".vsc-agent-x").addEventListener("click", () => setAgentOpen(false));
    $(".vsc-agent-btn").addEventListener("click", toggleAgent);
    $(".vsc-agent-act").addEventListener("click", toggleAgent);
    $(".vsc-agent-speed").addEventListener("click", cycleAgentSpeed);

    $(".vsc-agent-foot").addEventListener("click", (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest("[data-agent]");
      if (!btn) return;
      const act = /** @type {HTMLElement} */ (btn).dataset.agent;
      if (act === "next") agent.advance();
      else if (act === "auto") agent.toggleAuto();
    });

    // Agent 面板里的图片同样要能 hover 预览
    const pop = $(".vsc-img-pop");
    const img = /** @type {HTMLImageElement} */ (pop.querySelector("img"));
    $(".vsc-agent-body").addEventListener("mouseover", (e) => {
      const em = /** @type {HTMLElement} */ (e.target).closest(".vsc-img-emoji");
      const src = em?.getAttribute("data-src");
      if (!src) return;
      img.src = src;
      pop.classList.add("show");
      const r = em.getBoundingClientRect();
      let left = r.left - 512;
      if (left < 8) left = 8;
      pop.style.left = `${left}px`;
      pop.style.top = `${Math.max(8, Math.min(r.top - 20, window.innerHeight - 340))}px`;
    });
    $(".vsc-agent-body").addEventListener("mouseout", (e) => {
      if (!/** @type {HTMLElement} */ (e.relatedTarget)?.closest?.(".vsc-img-emoji")) hideImgPop();
    });

    // 面板宽度拖拽
    const handle = $(".vsc-agent-resizer");
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = Number(lsGet(AGENT_W_KEY, 340)) || 340;
      app.classList.add("agent-resizing");
      const move = (ev) => {
        // 面板在右侧，往左拖变宽
        const w = Math.min(AGENT_W_MAX, Math.max(AGENT_W_MIN, startW + (startX - ev.clientX)));
        document.documentElement.style.setProperty("--vsc-agent-w", `${w}px`);
        lsSet(AGENT_W_KEY, String(Math.round(w)));
      };
      const up = () => {
        app.classList.remove("agent-resizing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        notifyResize();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function bindImgPop() {
    const editor = $(".vsc-editor");
    const pop = $(".vsc-img-pop");
    const img = /** @type {HTMLImageElement} */ (pop.querySelector("img"));

    editor.addEventListener("mouseover", (e) => {
      const em = /** @type {HTMLElement} */ (e.target).closest(".vsc-img-emoji");
      if (!em) return;
      const src = em.getAttribute("data-src");
      if (!src) return;
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
      if (!/** @type {HTMLElement} */ (e.relatedTarget)?.closest?.(".vsc-img-emoji")) hideImgPop();
    });
  }

  function hideImgPop() {
    app?.querySelector(".vsc-img-pop")?.classList.remove("show");
  }

  /* ---------------------- 编辑器可用宽度测量 ---------------------- */

  /**
   * 量出编辑器当前能放下多少列等宽字符。
   * 用一个隐藏探针实测字符宽度，而不是按字号估算——字体回退、缩放、
   * 用户改过字号都会让估算失准。
   * @returns {number} 列数；量不出来（还没布局）返回 0
   */
  function measureCols() {
    if (!alive()) return 0;
    const ed = app?.querySelector(".vsc-editor");
    if (!ed || !ed.clientWidth) return 0;

    let probe = ed.querySelector(".vsc-measure");
    if (!probe) {
      probe = document.createElement("span");
      probe.className = "vsc-measure";
      ed.appendChild(probe);
    }
    // 量 100 个字符再平均，抵消亚像素误差
    probe.textContent = "0".repeat(100);
    const charW = probe.getBoundingClientRect().width / 100;
    if (!charW) return 0;

    // 行号列宽度随字号变，从 CSS 变量读，别写死
    const gutterVar = getComputedStyle(document.documentElement).getPropertyValue("--vsc-gutter-w");
    const GUTTER = parseFloat(gutterVar) || gutterW();
    const PAD_RIGHT = 20;
    const SAFETY = 2;   // 留一点余量，避免正好压线触发横向滚动
    const avail = ed.clientWidth - GUTTER - PAD_RIGHT - SAFETY;
    return Math.max(20, Math.floor(avail / charW));
  }

  /** 可用列数变化时通知数据源（窗口缩放、侧栏拖动都会触发） */
  let lastCols = 0;
  let resizeTimer = null;
  function notifyResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const cols = measureCols();
      if (!cols || cols === lastCols) return;
      lastCols = cols;
      source.onResize?.(cols);
    }, 160);
  }

  function bindResizers() {
    // 侧边栏宽度
    const sideHandle = $(".vsc-side-resizer");
    sideHandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const start = e.clientX;
      const startW = Number(lsGet(SIDEBAR_KEY, 260)) || 260;
      const move = (ev) => {
        const w = Math.min(460, Math.max(180, startW + (ev.clientX - start)));
        document.documentElement.style.setProperty("--vsc-side-w", `${w}px`);
        lsSet(SIDEBAR_KEY, String(Math.round(w)));
        notifyResize();   // 侧栏变宽 = 编辑器变窄，列数要跟着变
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    // 面板高度
    const panelHandle = $(".vsc-panel-resizer");
    const panelEl = $(".vsc-panel");
    const workEl = $(".vsc-work");
    panelHandle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = panelEl.getBoundingClientRect().height;
      const maxH = Math.max(PANEL_H_MIN, workEl.clientHeight - PANEL_H_KEEP);
      app.classList.add("panel-resizing");
      try { panelHandle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const move = (ev) => {
        const h = Math.min(maxH, Math.max(PANEL_H_MIN, startH + (startY - ev.clientY)));
        document.documentElement.style.setProperty("--vsc-panel-h", `${Math.round(h)}px`);
      };
      const up = () => {
        app.classList.remove("panel-resizing");
        const h = Math.round(panelEl.getBoundingClientRect().height);
        if (h >= PANEL_H_MIN) lsSet(PANEL_H_KEY, String(h));
        panelHandle.removeEventListener("pointermove", move);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      panelHandle.addEventListener("pointermove", move);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    panelHandle.addEventListener("dblclick", () => {
      document.documentElement.style.removeProperty("--vsc-panel-h");
      lsDel(PANEL_H_KEY);
    });
  }

  /* --------------------------- 面板折叠 --------------------------- */

  function setPanelOpen(open) {
    state.panelOpen = !!open;
    lsSet(PANEL_OPEN_KEY, state.panelOpen ? "1" : "0");
    app.classList.toggle("panel-off", !state.panelOpen);
    const btn = $(".vsc-panel-toggle");
    btn.textContent = state.panelOpen ? "⌄" : "⌃";
    btn.title = state.panelOpen ? "折叠面板（Ctrl/⌘ + `）" : "展开面板（Ctrl/⌘ + `）";
    btn.setAttribute("aria-expanded", state.panelOpen ? "true" : "false");
    if (state.panelOpen) renderPanel();
  }

  function togglePanel() {
    setPanelOpen(!state.panelOpen);
  }

  /* --------------------------- 命令面板 --------------------------- */

  let paletteItems = /** @type {{label: string, hint?: string, run: () => void}[]} */ ([]);

  function openPalette(q) {
    const pal = $(".vsc-palette");
    pal.classList.add("open");
    const input = /** @type {HTMLInputElement} */ (pal.querySelector("input"));
    input.value = q || "";
    input.focus();
    fillPalette(input.value);
  }

  function fillPalette(q) {
    const list = $(".vsc-palette-list");
    const query = String(q || "").trim().toLowerCase();
    paletteItems = source.commands().filter((c) =>
      !query || c.label.toLowerCase().includes(query) || (c.hint || "").toLowerCase().includes(query)
    ).slice(0, 40);
    list.innerHTML = paletteItems.length
      ? paletteItems.map((c, i) =>
          `<div class="vsc-palette-row" data-idx="${i}">
            <span>${escapeHtml(c.label)}</span>
            <span class="hint">${escapeHtml(c.hint || "")}</span>
          </div>`
        ).join("")
      : `<div class="vsc-palette-row"><span>No matching results</span></div>`;
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function renderSidebar() {
    if (!alive()) return;
    const tree = $(".vsc-tree");
    const head = /** @type {HTMLElement} */ ($(".vsc-side-head span"));
    const custom = source.activityView?.(state.activity);
    if (custom) {
      head.textContent = custom.head;
      tree.innerHTML = custom.html;
      return;
    }

    head.textContent = "Explorer";
    const q = state.filter.toLowerCase();
    const activeId = state.doc?.id;

    /** @param {TreeNode[]} nodes @param {number} depth */
    const walk = (nodes, depth) => nodes.map((n) => {
      if (n.kind === "folder") {
        const open = state.openFolders[n.id] !== false;
        const kids = n.children || [];
        // 过滤时只要子孙有命中就保留该文件夹
        const rendered = open ? walk(kids, depth + 1) : "";
        if (q && !rendered.trim() && !n.label.toLowerCase().includes(q)) return "";
        const fhint = n.hint ? ` title="${escapeHtml(n.hint)}"` : "";
        return `<div class="vsc-tree-row" data-folder="${escapeHtml(n.id)}"${fhint} style="padding-left:${8 + depth * 12}px">
            <span class="chev">${open ? "▾" : "▸"}</span>
            <span class="vsc-file-ico">${open ? "📂" : "📁"}</span>
            <span class="vsc-file-name">${escapeHtml(n.label)}</span>
            ${n.meta ? `<span class="vsc-file-meta">${escapeHtml(n.meta)}</span>` : ""}
          </div>${rendered}`;
      }
      // 搜索时标题也要能命中——文件名是 slug，中文书按标题搜才找得到
      if (q && !n.label.toLowerCase().includes(q) && !String(n.hint || "").toLowerCase().includes(q)) return "";
      const style = n.iconColor ? ` style="color:${escapeHtml(n.iconColor)}"` : "";
      const hint = n.hint ? ` title="${escapeHtml(n.hint)}"` : "";
      return `<div class="vsc-tree-row${n.id === activeId ? " active" : ""}" data-id="${escapeHtml(n.id)}"${hint} style="padding-left:${8 + depth * 12}px">
          <span class="vsc-file-ico"${style}>${n.icon || "📄"}</span>
          <span class="vsc-file-name">${escapeHtml(n.label)}</span>
          ${n.meta ? `<span class="vsc-file-meta">${escapeHtml(n.meta)}</span>` : ""}
        </div>`;
    }).join("");

    tree.innerHTML = walk(source.tree(), 0) || `<div class="vsc-tree-row">No results</div>`;
  }

  function renderTabs() {
    if (!alive()) return;
    const el = $(".vsc-tabs");
    if (!state.tabs.length) {
      el.innerHTML = `<div class="vsc-tab active" data-tab="welcome"><span class="vsc-file-ico">📄</span> README.md</div>`;
      return;
    }
    el.innerHTML = state.tabs.map((t) => {
      const style = t.iconColor ? ` style="color:${escapeHtml(t.iconColor)}"` : "";
      return `<div class="vsc-tab${t.id === state.activeTab ? " active" : ""}" data-tab="${escapeHtml(t.id)}">
          <span class="vsc-file-ico"${style}>${t.icon || "📄"}</span>
          <span class="vsc-file-name">${escapeHtml(t.file)}</span>
          <button type="button" class="x" title="Close">×</button>
        </div>`;
    }).join("");
  }

  function renderEditor() {
    if (!alive()) return;
    const ed = $(".vsc-editor");
    const crumb = $(".vsc-crumb");
    const ws = source.workspaceName();

    if (!state.doc) {
      crumb.innerHTML = `${escapeHtml(ws)} <span>›</span> README.md`;
      ed.innerHTML = source.welcomeHtml();
      ed.querySelectorAll("[data-id]").forEach((n) =>
        n.addEventListener("click", () => openFile(/** @type {HTMLElement} */ (n).dataset.id || ""))
      );
      ed.querySelector("[data-go='palette']")?.addEventListener("click", () => openPalette(""));
      $(".vsc-ln").textContent = "Ln 1, Col 1";
      $(".vsc-branch").textContent = "⎇ main";
      $(".vsc-title-center").textContent = `${ws} — Visual Studio Code`;
      return;
    }

    const doc = state.doc;
    crumb.innerHTML = doc.crumb.map((c) => escapeHtml(c)).join(" <span>›</span> ");
    const gutter = doc.rows.map((_, i) => `<div>${i + 1}</div>`).join("");
    const lines = doc.rows
      .map((row) => {
        const para = row.para != null ? ` data-para="${row.para}"` : "";
        return `<div class="vsc-line${row.fence ? " vsc-fence" : ""}"${para}>${renderLine(row)}</div>`;
      })
      .join("");
    ed.innerHTML = `<div class="vsc-code"><div class="vsc-gutter">${gutter}</div><div class="vsc-lines">${lines}</div></div>`;
    $(".vsc-ln").textContent = `Ln ${doc.rows.length}, Col 1`;
    $(".vsc-branch").textContent = doc.branch || "⎇ main";
    $(".vsc-title-center").textContent = `${doc.file} — ${ws} — Visual Studio Code`;
    ed.scrollLeft = 0;
    // 有记录的阅读位置就滚过去，否则回到顶部
    if (doc.restorePara != null && doc.restorePara > 0) {
      scrollToPara(doc.restorePara, false);
    } else {
      ed.scrollTop = 0;
    }
    lastPara = doc.restorePara || 0;
  }

  /* ------------------------ 菜单栏 ------------------------ */

  /** 当前展开的菜单序号，-1 表示没展开 */
  let openMenu = -1;
  /** @type {MenuItem[]} */
  let menuItems = [];

  function menuDefs() {
    return source.menus?.() || [];
  }

  function renderMenubar() {
    if (!alive()) return;
    const bar = $(".vsc-menubar");
    const defs = menuDefs();
    bar.innerHTML = defs.map((m, i) =>
      `<button type="button" class="vsc-menu-item" data-menu="${i}">${escapeHtml(m.label)}</button>`
    ).join("");
  }

  function closeMenu() {
    openMenu = -1;
    if (!app) return;
    app.querySelector(".vsc-menu-pop")?.classList.remove("open");
    app.querySelectorAll(".vsc-menu-item").forEach((b) => b.classList.remove("open"));
  }

  /** @param {number} i */
  function showMenu(i) {
    const defs = menuDefs();
    const def = defs[i];
    const btn = app.querySelector(`.vsc-menu-item[data-menu="${i}"]`);
    if (!def || !btn) return;

    openMenu = i;
    app.querySelectorAll(".vsc-menu-item").forEach((b) => b.classList.remove("open"));
    btn.classList.add("open");

    menuItems = def.items || [];
    const pop = $(".vsc-menu-pop");
    pop.innerHTML = menuItems.map((it, idx) => {
      if (it.type === "sep") return `<div class="vsc-menu-sep"></div>`;
      if (it.type === "title") return `<div class="vsc-menu-title">${escapeHtml(it.label || "")}</div>`;
      return `<div class="vsc-menu-row${it.disabled ? " disabled" : ""}" data-idx="${idx}">
        <span class="label">${escapeHtml(it.label || "")}</span>
        ${it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : ""}
      </div>`;
    }).join("");
    pop.classList.add("open");

    // 贴着按钮左下角展开，超出右边界就往左收
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 2}px`;
    pop.style.left = "0px";
    const w = pop.getBoundingClientRect().width || 220;
    pop.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 8))}px`;
  }

  function bindMenubar() {
    const bar = $(".vsc-menubar");
    const pop = $(".vsc-menu-pop");

    bar.addEventListener("click", (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest(".vsc-menu-item");
      if (!btn) return;
      e.stopPropagation();
      const i = Number(btn.dataset.menu);
      if (openMenu === i) closeMenu();
      else showMenu(i);
    });

    // 已经展开时，划过别的菜单名直接切换（和真 IDE 一致）
    bar.addEventListener("mouseover", (e) => {
      if (openMenu < 0) return;
      const btn = /** @type {HTMLElement} */ (e.target).closest(".vsc-menu-item");
      if (!btn) return;
      const i = Number(btn.dataset.menu);
      if (i !== openMenu) showMenu(i);
    });

    pop.addEventListener("click", (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest(".vsc-menu-row");
      if (!row) return;
      e.stopPropagation();
      const it = menuItems[Number(row.dataset.idx)];
      closeMenu();
      it?.run?.();
    });

    // 点别处关掉
    on(document, "click", () => {
      if (openMenu >= 0) closeMenu();
    });
  }

  /* ------------------------ Agent 面板 ------------------------ */

  const agent = createAgentRunner({
    bodyEl: () => app?.querySelector(".vsc-agent-body") || null,
    footEl: () => app?.querySelector(".vsc-agent-foot") || null,
    speedId: () => state.agentSpeed,
    // 每推进一段，编辑器跟着滚到那一段——Agent 面板就是另一种阅读方式
    onStep: (step) => {
      if (step.para != null) {
        scrollToPara(step.para, true);
        source.onScroll?.(step.para, scrollRatio());
      }
      renderUsage();
    },
  });

  /**
   * 把当前文档喂给 Agent 面板，并接上阅读进度。
   * 不接的话每次打开面板都从第一段重播，读到一半根本没法用。
   */
  function loadAgent() {
    const script = source.agentScript?.();
    if (!script) {
      agent.load([], "");
      return;
    }
    // 编辑器当前在第几段，Agent 就"已经输出"到哪一步。
    // para <= 0 表示还在章首、没开始读，这时从零播起，一段都不预先补。
    const para = currentPara();
    const startIndex = para > 0
      ? script.steps.reduce((best, st, i) => (st.para != null && st.para <= para ? i : best), -1)
      : -1;
    agent.load(script.steps, script.header, startIndex);
  }

  function setAgentOpen(open) {
    state.agentOpen = !!open;
    lsSet(AGENT_KEY, state.agentOpen ? "1" : "0");
    app.classList.toggle("agent-on", state.agentOpen);
    app.querySelector(".vsc-agent-btn")?.classList.toggle("on", state.agentOpen);
    app.querySelector(".vsc-agent-act")?.classList.toggle("on", state.agentOpen);
    document.documentElement.style.setProperty(
      "--vsc-agent-w",
      state.agentOpen ? `${Number(lsGet(AGENT_W_KEY, 340)) || 340}px` : "0px"
    );
    if (state.agentOpen) {
      loadAgent();
      renderUsage();
    } else {
      agent.stop();
    }
    notifyResize();   // 编辑器变窄了，auto 折行列数要重算
  }

  function toggleAgent() {
    setAgentOpen(!state.agentOpen);
  }

  /** 刷新额度条。面板关着时不用算，省得每次滚动都白跑一遍 */
  function renderUsage() {
    if (!alive() || !state.agentOpen) return;
    const el = app?.querySelector(".vsc-usage");
    if (!el) return;
    const bars = source.usageStats?.() || [];
    el.innerHTML = bars.length ? usageHtml(bars) : "";
  }

  /** 设置输出速度：存储 + 刷新面板上的显示（正在打字的这一段不受影响，下一段生效） */
  function setAgentSpeed(id) {
    if (!SPEEDS.some((x) => x.id === id)) return;
    state.agentSpeed = id;
    lsSet(AGENT_SPEED_KEY, id);
    const chip = app?.querySelector(".vsc-agent-speed");
    if (chip) {
      const sp = speedOf(id);
      chip.textContent = sp.label;
      chip.title = `输出速度：${sp.label}${sp.cps ? `（${sp.cps} 字/秒）` : ""} — 点击切换`;
    }
    agent.renderFoot();
  }

  /** 点一下切到下一档，循环 */
  function cycleAgentSpeed() {
    const i = SPEEDS.findIndex((x) => x.id === state.agentSpeed);
    setAgentSpeed(SPEEDS[(i + 1) % SPEEDS.length].id);
  }

  /* ------------------------ 阅读位置 ------------------------ */

  let lastPara = 0;
  let scrollTimer = null;

  /**
   * 滚到某一段。
   * @param {number} para
   * @param {boolean} smooth
   */
  function scrollToPara(para, smooth = true) {
    if (!alive()) return false;
    const ed = app?.querySelector(".vsc-editor");
    if (!ed) return false;
    // 目标段可能因为设置变化而不存在了，往前找最近的一段
    let el = null;
    for (let p = para; p >= 0 && !el; p--) {
      el = ed.querySelector(`.vsc-line[data-para="${p}"]`);
    }
    if (!el) {
      ed.scrollTop = 0;
      return false;
    }
    // 目标段落放在视口靠上的位置，上方留一点上下文
    const top = el.offsetTop - ed.clientHeight * 0.15;
    if (smooth && typeof ed.scrollTo === "function") {
      ed.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    } else {
      ed.scrollTop = Math.max(0, top);
    }
    lastPara = para;
    return true;
  }

  /** 当前视口顶部对应的段落序号 */
  function currentPara() {
    const ed = app?.querySelector(".vsc-editor");
    if (!ed) return 0;
    const rows = ed.querySelectorAll(".vsc-line[data-para]");
    if (!rows.length) return 0;
    // 找第一个底边越过标记线的正文行。
    // 这里必须用 > 而不是 >=：标记线正好压在两行交界时，
    // 上一行的底边等于标记线，用 >= 会取到上一行，位置就差了一行。
    const mark = ed.scrollTop + ed.clientHeight * 0.15;
    let hit = 0;
    for (const row of rows) {
      if (row.offsetTop + row.offsetHeight > mark) {
        hit = Number(row.dataset.para) || 0;
        break;
      }
      hit = Number(row.dataset.para) || 0;
    }
    return hit;
  }

  /** 章内已读比例（0~1），用于状态栏百分比 */
  function scrollRatio() {
    const ed = app?.querySelector(".vsc-editor");
    if (!ed) return 0;
    const max = ed.scrollHeight - ed.clientHeight;
    if (max <= 0) return 1;
    return Math.min(1, Math.max(0, ed.scrollTop / max));
  }

  function bindScroll() {
    const ed = $(".vsc-editor");
    ed.addEventListener("scroll", () => {
      clearTimeout(scrollTimer);
      // 防抖：滚动停下来再记，不然每帧都在写 IndexedDB
      scrollTimer = setTimeout(() => {
        const para = currentPara();
        const ratio = scrollRatio();
        if (para === lastPara) {
          // 段落没变但比例可能变了（长段落内滚动），仍然上报
          source.onScroll?.(para, ratio);
          renderUsage();
          return;
        }
        lastPara = para;
        source.onScroll?.(para, ratio);
        renderUsage();
      }, 350);
    }, { passive: true });
  }

  function renderPanel() {
    if (!alive()) return;
    const body = $(".vsc-panel-body");
    app.querySelectorAll(".vsc-panel-tabs button[data-panel]").forEach((b) =>
      b.classList.toggle("on", /** @type {HTMLElement} */ (b).dataset.panel === state.panel)
    );
    body.innerHTML = source.panelHtml(/** @type {any} */ (state.panel));
    body.scrollTop = 0;
  }

  function refresh() {
    if (!alive()) return;
    renderSidebar();
    renderTabs();
    renderEditor();
    renderPanel();
  }

  /* ---------------------------- tab 操作 ---------------------------- */

  /**
   * 离开当前文档前把阅读位置记到它的 doc 对象上，切回来时能回到原处。
   * openFile / activateTab / closeTab 三条路径都要走，漏一条就会丢位置。
   */
  function rememberPos() {
    if (state.doc) state.doc.restorePara = currentPara();
  }

  /**
   * 切换当前文档。必须走这里，不能直接给 state.doc 赋值——
   * 切回已缓存的 tab 时不会再调 source.openFile()，
   * 数据源那边的「当前章节」就会停在上一章，Agent 脚本和额度统计全是错的。
   */
  function setDoc(doc, id) {
    state.doc = doc;
    state.activeTab = id;
    source.onActivate?.(doc);
  }

  async function openFile(id) {
    if (!alive()) return;
    rememberPos();
    if (!id || id === "welcome") {
      setDoc(null, "welcome");
      refresh();
      return;
    }
    const cached = state.tabs.find((t) => t.id === id);
    const doc = cached || (await source.openFile(id));
    // await 期间可能已经换书了
    if (!doc || !alive()) return;
    if (!cached) state.tabs = [...state.tabs.filter((t) => t.id !== id), doc].slice(-8);
    setDoc(doc, id);
    refresh();
    if (state.agentOpen) {
      loadAgent();
      renderUsage();
    }
  }

  function activateTab(id) {
    rememberPos();
    if (id === "welcome") {
      setDoc(null, "welcome");
      refresh();
      return;
    }
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return;
    setDoc(tab, id);
    refresh();
    if (state.agentOpen) {
      loadAgent();
      renderUsage();
    }
  }

  function closeTab(id) {
    rememberPos();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    state.tabs.splice(idx, 1);
    if (state.activeTab === id) {
      const nextDoc = state.tabs[idx] || state.tabs[idx - 1];
      setDoc(nextDoc || null, nextDoc ? nextDoc.id : "welcome");
    }
    refresh();
    if (state.agentOpen) {
      loadAgent();
      renderUsage();
    }
  }

  /* ---------------------------- 对外 API ---------------------------- */

  /** 彻底拆掉这个外壳：停掉定时器、解绑全局监听、移除 DOM */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    agent.stop();
    clearTimeout(scrollTimer);
    clearTimeout(resizeTimer);
    closeMenu();
    disposers.splice(0).forEach((off) => {
      try { off(); } catch { /* ignore */ }
    });
    app?.remove();
    app = /** @type {any} */ (null);
  }

  const api = {
    state,
    mount,
    destroy,
    openFile,
    refresh,
    renderSidebar,
    renderPanel,
    renderEditor,
    openPalette,
    applyTheme,
    togglePanel,
    measureCols,
    renderMenubar,
    closeMenu,
    setPanelOpen,
    toggleTheme,
    toggleAgent,
    setAgentOpen,
    loadAgent,
    renderUsage,
    agent,
    setAgentSpeed,
    cycleAgentSpeed,
    agentSpeed: () => speedOf(state.agentSpeed),
    scrollToPara,
    currentPara,
    scrollRatio,
    setFontSize,
    stepFontSize,
    codeSize,
    /** 状态栏右侧自定义文案（阅读进度等） */
    setProgress(text) {
      const el = app?.querySelector(".vsc-progress");
      if (el) el.textContent = text || "";
    },
    setLn(text) {
      const el = app?.querySelector(".vsc-ln");
      if (el) el.textContent = text;
    },
    get editorEl() {
      return app?.querySelector(".vsc-editor");
    },
  };

  /** @typedef {typeof api} ShellApi */
  return api;
}
