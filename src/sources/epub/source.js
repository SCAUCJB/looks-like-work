/**
 * EPUB 数据源适配器：把一本书喂给通用 VS Code 外壳。
 *
 * 映射关系：
 *   书        -> 工作区
 *   TOC 目录  -> 文件夹树
 *   章节      -> 文件
 *   spine     -> 文件顺序
 *   SEARCH    -> 全书全文检索
 *   PROBLEMS  -> 书签列表
 *   TERMINAL  -> 章节清单 + 笔记
 *   Ln/Col    -> 阅读进度
 */

import { escapeHtml, lsGet, lsSet, truncate } from "../../shell/util.js";
import { htmlToPlainText } from "../../shell/chunks.js";
import { createEpubAdapter } from "./adapter.js";
import { renderChapter, STYLES, chapterFileName, countWords, excerpt, DEFAULT_WRAP, WRAP_MIN, WRAP_MAX } from "./chapter.js";
import { bookId, getState, saveState, addBookmark, removeBookmark } from "./store.js";
import { DENSITIES, DEFAULT_DENSITY, densityOf, MAX_RUN_MIN, MAX_RUN_MAX } from "./codegen.js";
import { FONT_SIZES, DEFAULT_FONT, codeSize } from "../../shell/shell.js";
import { SPEEDS as AGENT_SPEEDS } from "../../shell/agent.js";
import { resetHint, usageLines } from "../../shell/usage.js";

const STYLE_KEY = "epub-vsc-style";
const WRAP_KEY = "epub-vsc-wrap";
const DENSITY_KEY = "epub-vsc-density";
const MAXRUN_KEY = "epub-vsc-maxrun";
const decoder = new TextDecoder("utf-8");

export function currentStyle() {
  const id = lsGet(STYLE_KEY, "markdown");
  return STYLES.find((s) => s.id === id) || STYLES[0];
}

/** 段落间伪装代码的密度 */
export function currentDensity() {
  return densityOf(lsGet(DENSITY_KEY, DEFAULT_DENSITY));
}

/**
 * 连续注释行上限。"auto" 表示跟随密度档位（默认），否则是个具体行数。
 * 一大段纯注释中间一行代码都没有，一眼就假。
 */
export function currentMaxRun() {
  const raw = lsGet(MAXRUN_KEY, "auto");
  if (raw === "auto") return "auto";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "auto";
  return Math.min(MAX_RUN_MAX, Math.max(MAX_RUN_MIN, Math.round(n)));
}

/**
 * 折行宽度设置。"auto" 表示跟随编辑器实际宽度（默认），
 * 否则是一个固定列数。
 */
export function currentWrapSetting() {
  const raw = lsGet(WRAP_KEY, "auto");
  if (raw === "auto") return "auto";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "auto";
  return Math.min(WRAP_MAX, Math.max(WRAP_MIN, Math.round(n)));
}

/** 兼容旧调用：返回一个具体列数 */
export function currentWrap() {
  const set = currentWrapSetting();
  return set === "auto" ? DEFAULT_WRAP : set;
}

/**
 * 通用的「书」数据源。EPUB 和 PDF 共用这一套——
 * 差异全部收在 adapter 里（怎么拿元信息、章节列表、章节内容），
 * 外壳、折行、伪装代码、Agent 面板、额度条、阅读进度都不用动。
 *
 * @param {Object} args
 * @param {BookAdapter} args.adapter             书的内容来源
 * @param {number} args.size                     原始文件大小（用于 bookId）
 * @param {() => void} [args.onOpenLibrary]      「打开书库」回调（回到欢迎页）
 * @param {() => void} [args.onPickFile]         弹出文件选择器，添加新的 epub
 * @param {{id: string, title: string, author: string}[]} [args.recentBooks] 书库里最近的几本
 * @param {(id: string) => void} [args.onOpenBook] 打开书库里的某一本
 * @returns {import("../../shell/shell.js").Source}
 */
export function createBookSource({ adapter, size, onOpenLibrary, onPickFile, recentBooks = [], onOpenBook }) {
  const book = adapter.meta;
  const id = bookId(book.title, size);

  // 章节列表由 adapter 给出；href 在 EPUB 里是 zip 路径，在 PDF 里是合成 id
  const chapters = adapter.chapters.map((c, i) => ({
    id: c.href,
    href: c.href,
    index: i,
    title: c.title,
    depth: c.depth || 0,
    // 层级靠 parent（TOC 的父子关系），不是 depth 数字——别漏带
    parent: c.parent || null,
    anchors: c.anchors || [],
    file: chapterFileName(c.title, i, currentStyle().ext),
    /** @type {number | null} */ words: null,
    /** @type {number} */ paras: 0,
    /** @type {string} */ plain: "",
  }));

  const byHref = new Map(chapters.map((c) => [c.href, c]));

  const blobUrlFor = (p) => adapter.blobUrlFor?.(p) || "";

  /**
   * 本次渲染要用的列数。
   * auto 模式下向外壳要实测值；外壳还没布局好（首帧）时退回默认值，
   * 随后的 onResize 会带着真实值再渲染一次。
   */
  function resolveWrap() {
    const set = currentWrapSetting();
    if (set !== "auto") return set;
    const measured = shell?.measureCols?.() || 0;
    if (!measured) return DEFAULT_WRAP;
    return Math.min(WRAP_MAX, Math.max(WRAP_MIN, measured));
  }

  let progress = { chapterHref: "", para: 0, bookmarks: [] };
  let currentChapter = null;
  /** 改设置导致重渲染时，暂存当前段落，渲染完滚回去 */
  let pendingPara = null;
  /** 当前章节渲染出的行，Agent 面板据此生成脚本 */
  let currentRows = [];
  /** 当前章内已读比例，状态栏百分比用 */
  let chapterRatio = 0;
  /** usage 命令的输出，非空时 TERMINAL 显示它 */
  let usageReport = [];
  /** 存储是否可用；不可用时只提示一次，不反复刷屏 */
  let storeWarned = false;

  /**
   * 存储操作一律走这里。IndexedDB 在隐私模式 / 存储被禁时会失败，
   * 任何一个没接住的 rejection 都会打断页面脚本——读书不该因为存不了进度而中断。
   * @template T
   * @param {Promise<T>} p
   * @param {T} fallback
   * @returns {Promise<T>}
   */
  function safeStore(p, fallback) {
    return Promise.resolve(p).catch((err) => {
      if (!storeWarned) {
        storeWarned = true;
        console.warn("[epub] 存储不可用，进度与书签不会被保存", err);
        notes.push("存储不可用，本次阅读不会保存进度与书签");
        shell?.renderPanel?.();
      }
      return fallback;
    });
  }

  /**
   * 额度条数据。提成独立函数是因为 commandLine.submit 里的 this
   * 指向 commandLine 对象而不是 source，拿不到 source.usageStats。
   */
  function buildUsage() {
    const total = totalWords();
    const before = currentChapter ? readWordsBefore(currentChapter.href) : 0;
    const chapterWords = currentChapter?.words || 0;
    const bookDone = before + chapterWords * chapterRatio;

    const paras = currentChapter?.paras || 0;
    const paraNow = paras ? Math.min(paras, (Number(progress.para) || 0) + 1) : 0;

    return [
      {
        label: "Current session",
        window: "5h",
        resets: resetHint(5),
        pct: paras ? Math.round((paraNow / paras) * 100) : 0,
        right: currentChapter ? `${paraNow}/${paras} 段` : "未打开章节",
      },
      {
        label: "Current week (all chapters)",
        window: "7d",
        resets: resetHint(24 * 7),
        pct: total ? Math.round((bookDone / total) * 100) : 0,
        right: `${fmtWords(Math.round(bookDone))}/${fmtWords(total)} 字`,
      },
    ];
  }

  /** 打印 usage 报告到 TERMINAL */
  function showUsage() {
    usageReport = usageLines(buildUsage());
    if (shell?.state) shell.state.panel = "terminal";
    shell?.renderPanel();
  }
  /** @type {{chapter: string, title: string, line: string}[]} */
  let searchHits = [];
  let searchQuery = "";
  /** @type {string[]} */
  const notes = [];
  /** @type {import("../../shell/shell.js").ShellApi | null} */
  let shell = null;

  /* ------------------------- 全书检索 ------------------------- */

  /** 为检索准备纯文本（惰性，第一次搜索时才解全书） */
  function ensurePlain() {
    for (const ch of chapters) {
      if (ch.words !== null) continue;
      ch.plain = adapter.plainOf(ch.href);
      ch.words = countWords(ch.plain);
    }
  }

  function search(q) {
    searchQuery = q;
    searchHits = [];
    if (!q || q.length < 2) return;
    ensurePlain();
    const needle = q.toLowerCase();
    for (const ch of chapters) {
      for (const line of ch.plain.split("\n")) {
        if (!line.toLowerCase().includes(needle)) continue;
        searchHits.push({ chapter: ch.href, title: ch.title, line: line.trim() });
        if (searchHits.length >= 200) return;
      }
    }
  }

  /* ------------------------- 进度 ------------------------- */

  function totalWords() {
    ensurePlain();
    return chapters.reduce((sum, c) => sum + (c.words || 0), 0);
  }

  function readWordsBefore(href) {
    ensurePlain();
    let sum = 0;
    for (const ch of chapters) {
      if (ch.href === href) break;
      sum += ch.words || 0;
    }
    return sum;
  }

  function updateStatus() {
    if (!shell || !currentChapter) return;
    const total = totalWords();
    const before = readWordsBefore(currentChapter.href);
    // 章内按滚动比例折算，而不是整章算已读——否则打开一章进度就直接跳满
    const done = before + (currentChapter.words || 0) * chapterRatio;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const paraInfo = currentChapter.paras
      ? `  ·  ${Math.min(currentChapter.paras, (Number(progress.para) || 0) + 1)}/${currentChapter.paras} 段`
      : "";
    shell.setProgress(`${pct}%${paraInfo}`);
  }

  /* ------------------------- Source 接口 ------------------------- */

  return {
    id: "epub",

    workspaceName() {
      return book.title;
    },

    tree() {
      const style = currentStyle();

      // 按 TOC 的父子关系建树，不用 depth 数字。
      // 章节顺序来自 spine，depth 按 spine 顺序重排后就还原不出真实父子关系了：
      // A 有子章 C、spine 里 B 夹在中间时，depth 序列是 [0,0,1]，
      // 栈式重建只能把 C 挂到最近的 B 上，挂错了。
      const wrap = new Map();
      chapters.forEach((ch) => {
        wrap.set(ch.href, { ch, node: fileNode(ch, style), children: [] });
      });

      const roots = [];

      /**
       * 分组节点（第一部分 / Part I）没有自己的文件，所以也没有 spine 位置。
       * 按需创建，位置由第一个挂进来的子决定——因为下面是按 spine 顺序遍历的，
       * 这样分组自然就落在它第一章所在的位置上。
       */
      const groupEntries = new Map();
      const ensureGroup = (gid) => {
        const hit = groupEntries.get(gid);
        if (hit) return hit;
        const g = adapter.groups?.get(gid);
        if (!g) return null;
        const entry = { group: g, ch: null, node: null, children: [] };
        groupEntries.set(gid, entry);
        attach(entry, g.parent);   // 分组自己也可能挂在别的分组下
        return entry;
      };

      /** 把一个条目挂到父级下；父级不存在或就是自己就退回顶层 */
      const attach = (self, parentId) => {
        const parent = parentId
          ? (wrap.get(parentId) || ensureGroup(parentId))
          : null;
        if (parent && parent !== self) parent.children.push(self);
        else roots.push(self);
      };

      chapters.forEach((ch) => attach(wrap.get(ch.href), ch.parent));

      /** 同一文件里的其它 TOC 条目（单文件多章，靠 #anchor 区分） */
      const anchorNodes = (ch) => (ch.anchors || []).map((a) => ({
        kind: "file",
        id: `${ch.href}#${a.anchor}`,
        label: a.label,
        icon: "§",
        iconColor: "#7a8aa0",
      }));

      /**
       * 条目 -> 树节点。
       * 分组条目没有自己的文件，直接就是文件夹；
       * 有文件又有子节点的章节从 file 变成 folder，自身内容作为第一个子项。
       */
      const build = (entry) => {
        if (!entry.ch) {
          // 纯分组：只有标题
          const kids = entry.children.map(build);
          return {
            kind: "folder",
            id: `dir-${entry.group.id}`,
            label: entry.group.label,
            meta: String(kids.length),
            children: kids,
          };
        }
        const kids = [...entry.children.map(build), ...anchorNodes(entry.ch)];
        if (!kids.length) return entry.node;
        const self = { ...entry.node };
        return {
          kind: "folder",
          id: `dir-${entry.ch.href}`,
          label: entry.ch.title,
          meta: String(kids.length),
          children: [self, ...kids],
        };
      };

      return [
        {
          kind: "folder",
          id: "book",
          label: book.title,
          meta: `${chapters.length}`,
          children: roots.map(build),
        },
        { kind: "file", id: "welcome", label: "README.md", icon: "📄" },
      ];
    },

    async openFile(fileId) {
      // 目录里的锚点条目 id 是 "文件#锚点"，落到文件上打开
      const ch = byHref.get(fileId) || byHref.get(String(fileId).split("#")[0]);
      if (!ch) return null;
      const style = currentStyle();
      const content = adapter.contentOf(ch.href);
      if (!content) throw new Error(`章节内容缺失: ${ch.href}`);

      const { rows, words, paras, plain } = renderChapter({
        ...content,
        href: ch.href,
        title: ch.title,
        bookTitle: book.title,
        author: book.author,
        style,
        blobUrlFor,
        wrapCols: resolveWrap(),
        density: currentDensity().id,
        maxRun: currentMaxRun() === "auto" ? undefined : currentMaxRun(),
      });
      ch.words = words;
      ch.paras = paras;
      ch.plain = plain;
      currentRows = rows;
      const prevChapter = currentChapter;
      currentChapter = ch;

      // 恢复位置：
      // - pendingPara 是改设置时暂存的当前段落（换字号不该跳回开头）
      // - 否则，回到这一章上次读到的地方（只在"接着上次读"时，换章要从头开始）
      let restorePara = 0;
      if (pendingPara != null) {
        restorePara = pendingPara;
        pendingPara = null;
      } else if (progress.chapterHref === ch.href && !prevChapter) {
        restorePara = Number(progress.para) || 0;
      }

      progress = await safeStore(
        saveState(id, { chapterHref: ch.href, para: restorePara }),
        { ...progress, chapterHref: ch.href, para: restorePara }
      );
      queueMicrotask(updateStatus);

      const crumb = [book.title];
      if (ch.depth > 0) crumb.push("…");
      crumb.push(ch.file);

      return {
        id: ch.id,
        file: ch.file,
        crumb,
        rows,
        paras,
        restorePara,
        branch: `⎇ ${book.author || "book"}`,
        icon: style.id === "markdown" ? "Ⓜ" : "📘",
        iconColor: "#519aba",
      };
    },

    welcomeHtml() {
      const style = currentStyle();
      const cover = adapter.coverUrl?.() || "";
      return `<div class="vsc-welcome">
        <h1>${escapeHtml(book.title)}</h1>
        <div class="sub">
          ${escapeHtml(book.author || "unknown author")}
          ${book.publisher ? ` · ${escapeHtml(book.publisher)}` : ""}
          · ${chapters.length} chapters · ${escapeHtml(style.label)} 视图
        </div>
        ${cover ? `<img src="${cover}" alt="cover" style="max-width:180px;margin:20px 0;border:1px solid var(--vsc-border)">` : ""}
        <h2>Start</h2>
        <div class="link" data-go="palette">Go to Chapter…  ⌘P</div>
        ${progress.chapterHref && byHref.has(progress.chapterHref)
          ? `<div class="link" data-id="${escapeHtml(progress.chapterHref)}">继续阅读 · ${escapeHtml(byHref.get(progress.chapterHref).title)}${
              Number(progress.para) ? `（第 ${Number(progress.para) + 1} 段）` : ""
            }</div>`
          : ""}
        <div class="link" data-action="library">打开书库 / 换一本书</div>
        <h2>Chapters</h2>
        ${chapters.slice(0, 10).map((c) =>
          `<div class="link" data-id="${escapeHtml(c.id)}">${escapeHtml(c.file)}  <span style="opacity:.55">${escapeHtml(truncate(c.title, 40))}</span></div>`
        ).join("")}
      </div>`;
    },

    activityView(activity) {
      if (activity === "search") {
        return {
          head: "Search",
          html: searchHits.length
            ? `<div class="vsc-tree-row" style="opacity:.6">${searchHits.length} results for “${escapeHtml(searchQuery)}”</div>` +
              searchHits.slice(0, 60).map((h) =>
                `<div class="vsc-tree-row" data-id="${escapeHtml(h.chapter)}" style="padding-left:12px;height:auto;min-height:22px">
                  <span class="vsc-file-ico">🔍</span>
                  <span class="vsc-file-name" title="${escapeHtml(h.line)}">${escapeHtml(truncate(h.line, 48))}</span>
                </div>`
              ).join("")
            : `<div class="vsc-tree-row" style="opacity:.6">${
                searchQuery ? "No results" : "在上方输入 2 个字以上搜索全书"
              }</div>`,
        };
      }
      if (activity === "scm") {
        const marks = progress.bookmarks || [];
        return {
          head: "Bookmarks",
          html: marks.length
            ? marks.slice().reverse().map((b) =>
                `<div class="vsc-tree-row" data-id="${escapeHtml(b.chapter)}" style="padding-left:8px">
                  <span class="vsc-file-ico">🔖</span>
                  <span class="vsc-file-name" title="${escapeHtml(b.note || "")}">${escapeHtml(truncate(b.title || b.chapter, 28))}</span>
                  <button type="button" class="vsc-row-x" data-action="unmark" data-at="${b.at}" title="删除这个书签">×</button>
                </div>`
              ).join("")
            : `<div class="vsc-tree-row" style="opacity:.6">还没有书签。在 TERMINAL 输入 mark 收藏当前章节</div>`,
        };
      }
      if (activity === "debug") {
        const total = totalWords();
        return {
          head: "Reading Stats",
          html: `
            <div class="vsc-tree-row"><span class="vsc-file-ico">📖</span> ${chapters.length} chapters</div>
            <div class="vsc-tree-row"><span class="vsc-file-ico">🔢</span> ${fmtWords(total)} 字</div>
            <div class="vsc-tree-row"><span class="vsc-file-ico">⏱</span> 约 ${Math.max(1, Math.round(total / 400))} 分钟</div>
            <div class="vsc-tree-row"><span class="vsc-file-ico">🌐</span> ${escapeHtml(book.language || "-")}</div>`,
        };
      }
      if (activity === "ext") {
        const wrapSet = currentWrapSetting();
        const wrap = resolveWrap();
        return {
          head: "Views",
          html:
            `<div class="vsc-tree-row" style="opacity:.55;pointer-events:none">字号</div>` +
            FONT_SIZES.map((px) =>
              `<div class="vsc-tree-row" data-action="font" data-font="${px}" style="padding-left:8px">
                <span class="vsc-file-ico">${px === codeSize() ? "✓" : " "}</span>
                <span class="vsc-file-name">${px}px</span>
                <span class="vsc-file-meta">${px === DEFAULT_FONT ? "默认" : ""}</span>
              </div>`
            ).join("") +
            `<div class="vsc-tree-row" style="opacity:.55;pointer-events:none;margin-top:6px">渲染风格</div>` +
            STYLES.map((s) =>
              `<div class="vsc-tree-row" data-action="style" data-style="${s.id}" style="padding-left:8px">
                <span class="vsc-file-ico">${s.id === currentStyle().id ? "✓" : " "}</span>
                <span class="vsc-file-name">${escapeHtml(s.label)}</span>
                <span class="vsc-file-meta">.${s.ext}</span>
              </div>`
            ).join("") +
            `<div class="vsc-tree-row" style="opacity:.55;pointer-events:none;margin-top:6px">Agent 输出速度</div>` +
            AGENT_SPEEDS.map((sp) =>
              `<div class="vsc-tree-row" data-action="speed" data-speed="${sp.id}" style="padding-left:8px">
                <span class="vsc-file-ico">${sp.id === shell?.agentSpeed?.().id ? "✓" : " "}</span>
                <span class="vsc-file-name">${escapeHtml(sp.label)}</span>
                <span class="vsc-file-meta">${sp.cps ? `${sp.cps} 字/秒` : "不打字"}</span>
              </div>`
            ).join("") +
            `<div class="vsc-tree-row" style="opacity:.55;pointer-events:none;margin-top:6px">伪装代码密度</div>` +
            DENSITIES.map((d) =>
              `<div class="vsc-tree-row" data-action="density" data-density="${d.id}" style="padding-left:8px">
                <span class="vsc-file-ico">${d.id === currentDensity().id ? "✓" : " "}</span>
                <span class="vsc-file-name">${escapeHtml(d.label)}</span>
                <span class="vsc-file-meta">${d.chance ? `${Math.round(d.chance * 100)}%` : "—"}</span>
              </div>`
            ).join("") +
            `<div class="vsc-tree-row" style="opacity:.55;pointer-events:none;margin-top:6px">连续注释行上限</div>` +
            [["auto", "跟随密度"], [4, "4 行"], [6, "6 行"], [8, "8 行"], [12, "12 行"]].map(([v, label]) =>
              `<div class="vsc-tree-row" data-action="maxrun" data-maxrun="${v}" style="padding-left:8px">
                <span class="vsc-file-ico">${v === currentMaxRun() ? "✓" : " "}</span>
                <span class="vsc-file-name">${escapeHtml(label)}</span>
                <span class="vsc-file-meta">${v === "auto" ? `${currentDensity().maxRun} 行` : ""}</span>
              </div>`
            ).join("") +
            `<div class="vsc-tree-row" style="opacity:.55;pointer-events:none;margin-top:6px">每行宽度（列）</div>` +
            `<div class="vsc-tree-row" data-action="wrap" data-wrap="auto" style="padding-left:8px">
              <span class="vsc-file-ico">${wrapSet === "auto" ? "✓" : " "}</span>
              <span class="vsc-file-name">自动（撑满编辑器）</span>
              <span class="vsc-file-meta">${wrapSet === "auto" ? `${wrap} 列` : "—"}</span>
            </div>` +
            [72, 88, 104, 120, 140].map((n) =>
              `<div class="vsc-tree-row" data-action="wrap" data-wrap="${n}" style="padding-left:8px">
                <span class="vsc-file-ico">${n === wrapSet ? "✓" : " "}</span>
                <span class="vsc-file-name">${n} 列</span>
                <span class="vsc-file-meta">≈${Math.floor(n / 2)} 汉字</span>
              </div>`
            ).join(""),
        };
      }
      return null;
    },

    panelHtml(panel) {
      if (panel === "problems") {
        const marks = progress.bookmarks || [];
        return marks.length
          ? `<div class="vsc-term-line vsc-term-warn">${marks.length} bookmarks  <span class="vsc-term-muted">// 点 × 删除，或输入 unmark &lt;序号&gt;</span></div>` +
            marks.slice().reverse().map((b, i) =>
              `<div class="vsc-term-line vsc-term-row">` +
              `<span class="vsc-term-muted">${marks.length - i}.</span>` +
              `<span data-action="open" data-id="${escapeHtml(b.chapter)}" class="vsc-term-link">${escapeHtml(b.file || "")}</span>` +
              `<span class="vsc-term-muted vsc-term-note">// ${escapeHtml(truncate(b.note || b.title || "", 80))}</span>` +
              `<button type="button" class="vsc-row-x" data-action="unmark" data-at="${b.at}" title="删除这个书签">×</button>` +
              `</div>`
            ).join("")
          : `<div class="vsc-term-line vsc-term-muted">No bookmarks yet. 在下方输入 mark 收藏当前章节。</div>`;
      }
      if (panel === "output") {
        return `
          <div class="vsc-term-line">[${escapeHtml(adapter.kind)}] ${escapeHtml(book.title)}</div>
          ${(adapter.info?.() || []).map((l) => `<div class="vsc-term-line">[${escapeHtml(adapter.kind)}] ${escapeHtml(l)}</div>`).join("")}
          <div class="vsc-term-line">[${escapeHtml(adapter.kind)}] chapters: ${chapters.length}</div>
          <div class="vsc-term-line vsc-term-muted">view: ${escapeHtml(currentStyle().label)} · font: ${codeSize()}px · wrap: ${resolveWrap()} cols${currentWrapSetting() === "auto" ? " (auto)" : ""} · decoy: ${escapeHtml(currentDensity().label)} (max ${currentMaxRun() === "auto" ? currentDensity().maxRun : currentMaxRun()} 行)</div>
          <div class="vsc-term-line vsc-term-muted">images mapped to emoji hover previews (500px @ 50%)</div>`;
      }
      // terminal
      if (usageReport.length) {
        const body = [
          `<div class="vsc-term-line vsc-term-muted">$ usage</div>`,
          ...usageReport.map((l) =>
            `<div class="vsc-term-line${/█|░/.test(l) ? " vsc-term-warn" : ""}">${escapeHtml(l) || "&nbsp;"}</div>`
          ),
          `<div class="vsc-term-line vsc-term-muted">// session = 当前章节，weekly = 全书；输入任意命令返回章节列表</div>`,
        ].join("");
        return body;
      }
      const head = currentChapter
        ? `<div class="vsc-term-line vsc-term-muted"># cat ${escapeHtml(currentChapter.file)}</div>` +
          `<div class="vsc-term-line">${escapeHtml(currentChapter.title)}  <span class="vsc-term-muted">${fmtWords(currentChapter.words || 0)} 字</span></div>`
        : `<div class="vsc-term-line vsc-term-muted"># 打开左侧任意章节开始阅读</div>`;
      const list = chapters.map((c) =>
        `<div class="vsc-term-line${c.href === currentChapter?.href ? " vsc-term-warn" : ""}">` +
        `${escapeHtml(c.file)}  <span class="vsc-term-muted">${escapeHtml(truncate(c.title, 60))}</span></div>`
      ).join("");
      const noteLines = notes.map((n) => `<div class="vsc-term-line vsc-term-warn">note: ${escapeHtml(n)}</div>`).join("");
      return `${head}${list}${noteLines}<div class="vsc-term-line">epub@${escapeHtml(book.title.slice(0, 16))} $</div>`;
    },

    commandLine: {
      placeholder: "$ 章节名跳转 / usage / agent / mark / font / wrap / code <密度> / run <行数> / note / view",
      submit(text) {
        const [cmd, ...rest] = text.split(/\s+/);
        const arg = rest.join(" ");
        if (cmd !== "usage") usageReport = [];

        if (cmd === "mark" && currentChapter) {
          const mark = {
            chapter: currentChapter.href,
            title: currentChapter.title,
            file: currentChapter.file,
            note: arg,
            at: Date.now(),
          };
          safeStore(addBookmark(id, mark), {
            ...progress,
            bookmarks: [...(progress.bookmarks || []), mark],
          }).then((st) => {
            progress = st;
            shell?.renderPanel();
            shell?.renderSidebar();
          });
          return;
        }
        if (cmd === "unmark") {
          const marks = progress.bookmarks || [];
          if (!marks.length) return;
          // 序号与 PROBLEMS 面板一致：1 是最早收藏的那条
          const n = Number(arg);
          const hit = Number.isFinite(n) && n >= 1 && n <= marks.length
            ? marks[n - 1]
            : marks[marks.length - 1];   // 不给序号就删最近一条
          if (hit) dropBookmark(hit.at);
          return;
        }
        if (cmd === "wrap") {
          setWrap(arg.trim() === "auto" ? "auto" : Number(arg));
          return;
        }
        if (cmd === "code") {
          setDensity(arg.trim());
          return;
        }
        if (cmd === "run") {
          setMaxRun(arg.trim() === "auto" ? "auto" : Number(arg));
          return;
        }
        if (cmd === "usage") {
          showUsage();
          return;
        }
        if (cmd === "agent") {
          const sub2 = arg.trim();
          if (sub2 === "on") shell?.setAgentOpen?.(true);
          else if (sub2 === "off") shell?.setAgentOpen?.(false);
          else if (sub2) shell?.setAgentSpeed?.(sub2);
          else shell?.toggleAgent?.();
          return;
        }
        if (cmd === "font" || cmd === "size") {
          shell?.setFontSize?.(Number(arg));
          shell?.renderSidebar();
          return;
        }
        if (cmd === "note") {
          notes.push(arg || "(empty)");
          shell?.renderPanel();
          return;
        }
        if (cmd === "view") {
          const hit = STYLES.find((s) => s.id === arg || s.ext === arg || s.label.toLowerCase() === arg.toLowerCase());
          if (hit) setStyle(hit.id);
          return;
        }
        // 其它输入当作章节名搜索并跳转
        const hit = chapters.find((c) =>
          c.title.toLowerCase().includes(text.toLowerCase()) || c.file.includes(text)
        );
        if (hit) shell?.openFile(hit.id);
      },
    },

    commands() {
      const style = currentStyle();
      return [
        ...chapters.map((c) => ({
          label: c.file,
          hint: truncate(c.title, 40),
          run: () => shell?.openFile(c.id),
        })),
        ...STYLES.filter((s) => s.id !== style.id).map((s) => ({
          label: `View: 切换到 ${s.label} 视图`,
          hint: `.${s.ext}`,
          run: () => setStyle(s.id),
        })),
        { label: "Usage: 查看阅读额度（session / weekly）", hint: "usage", run: showUsage },
        { label: "Agent: 开关 Agent 面板（逐段输出）", hint: "⌘I", run: () => shell?.toggleAgent?.() },
        ...AGENT_SPEEDS.map((sp) => ({
          label: `Agent: 输出速度 — ${sp.label}`,
          hint: `agent ${sp.id}`,
          run: () => {
            shell?.setAgentSpeed?.(sp.id);
            shell?.agent?.renderFoot?.();
          },
        })),
        { label: "Library: 打开书库 / 换一本书", hint: "epub", run: () => onOpenLibrary?.() },
        ...[["auto", "跟随密度"], [4, "4 行"], [6, "6 行"], [8, "8 行"], [12, "12 行"]]
          .filter(([v]) => v !== currentMaxRun())
          .map(([v, label]) => ({
            label: `Code: 连续注释行上限 — ${label}`,
            hint: `run ${v}`,
            run: () => setMaxRun(v),
          })),
        ...DENSITIES.filter((d) => d.id !== currentDensity().id).map((d) => ({
          label: `Code: 段落间伪装代码 — ${d.label}`,
          hint: `code ${d.id}`,
          run: () => setDensity(d.id),
        })),
        ...FONT_SIZES.filter((px) => px !== codeSize()).map((px) => ({
          label: `Font: 字号 ${px}px${px === DEFAULT_FONT ? "（默认）" : ""}`,
          hint: `font ${px}`,
          run: () => {
            shell?.setFontSize?.(px);
            shell?.renderSidebar();
          },
        })),
        ...(currentWrapSetting() === "auto"
          ? []
          : [{ label: "Wrap: 自动撑满编辑器", hint: "wrap auto", run: () => setWrap("auto") }]),
        ...[72, 88, 104, 120, 140].filter((n) => n !== currentWrapSetting()).map((n) => ({
          label: `Wrap: 固定每行 ${n} 列（约 ${Math.floor(n / 2)} 个汉字）`,
          hint: `wrap ${n}`,
          run: () => setWrap(n),
        })),
        ...(progress.bookmarks || []).length
          ? [{
              label: `Bookmark: 删除最近一个书签`,
              hint: "unmark",
              run: () => {
                const marks = progress.bookmarks || [];
                if (marks.length) dropBookmark(marks[marks.length - 1].at);
              },
            }]
          : [],
        {
          label: "Bookmark: 收藏当前章节",
          hint: "mark",
          run: () => currentChapter && safeStore(
            addBookmark(id, {
              chapter: currentChapter.href,
              title: currentChapter.title,
              file: currentChapter.file,
            }),
            progress
          ).then((st) => { progress = st; shell?.renderPanel(); }),
        },
      ];
    },

    /** 菜单栏内容 */
    menus() {
      const i = currentChapter ? chapters.findIndex((c) => c.href === currentChapter.href) : -1;
      const hasPrev = i > 0;
      const hasNext = i >= 0 && i < chapters.length - 1;

      return [
        {
          label: "File",
          items: [
            { label: "打开 EPUB…", hint: "⌘O", run: () => onPickFile?.() },
            ...(recentBooks.length
              ? [
                  { type: "sep" },
                  { type: "title", label: "最近打开" },
                  ...recentBooks.slice(0, 6).map((b) => ({
                    label: b.title,
                    hint: b.author || "",
                    run: () => onOpenBook?.(b.id),
                  })),
                ]
              : []),
            { type: "sep" },
            { label: "回到书库", run: () => onOpenLibrary?.() },
            { label: "关闭当前章节", hint: "⌘W", run: () => shell?.openFile("welcome") },
          ],
        },
        {
          label: "Edit",
          items: [
            { label: "全书搜索", hint: "⌘⇧F", run: () => {
              if (shell?.state) shell.state.activity = "search";
              shell?.renderSidebar();
              document.querySelector(".vsc-side-search")?.focus();
            } },
            { label: "收藏当前章节", hint: "mark", run: () => {
              if (!currentChapter) return;
              safeStore(
                addBookmark(id, {
                  chapter: currentChapter.href,
                  title: currentChapter.title,
                  file: currentChapter.file,
                }),
                progress
              ).then((st) => { progress = st; shell?.renderPanel(); shell?.renderSidebar(); });
            }, disabled: !currentChapter },
          ],
        },
        {
          label: "View",
          items: [
            { label: "命令面板…", hint: "⌘P", run: () => shell?.openPalette("") },
            { type: "sep" },
            { label: "切换浅色 / 深色主题", run: () => shell?.toggleTheme?.() },
            { label: "放大字号", hint: "⌘+", run: () => shell?.stepFontSize?.(1) },
            { label: "缩小字号", hint: "⌘-", run: () => shell?.stepFontSize?.(-1) },
            { label: "字号复位", hint: "⌘0", run: () => shell?.setFontSize?.(13) },
            { type: "sep" },
            { label: "切换底部面板", hint: "⌘`", run: () => shell?.togglePanel?.() },
            { label: "切换 Agent 面板", hint: "⌘I", run: () => shell?.toggleAgent?.() },
          ],
        },
        {
          label: "Go",
          items: [
            { label: "上一章", hint: "⌘↑", run: () => gotoChapter(-1), disabled: !hasPrev },
            { label: "下一章", hint: "⌘↓", run: () => gotoChapter(1), disabled: !hasNext },
            { type: "sep" },
            { label: "跳转到章节…", hint: "⌘P", run: () => shell?.openPalette("") },
            {
              label: "继续上次阅读",
              run: () => progress.chapterHref && shell?.openFile(progress.chapterHref),
              disabled: !progress.chapterHref,
            },
          ],
        },
        {
          label: "Run",
          items: [
            { label: "Agent：输出下一段", hint: "⏎", run: () => {
              shell?.setAgentOpen?.(true);
              shell?.agent?.advance?.();
            } },
            { label: "Agent：连续 / 暂停", run: () => {
              shell?.setAgentOpen?.(true);
              shell?.agent?.toggleAuto?.();
            } },
            { label: "Agent：停止", run: () => shell?.agent?.stop?.() },
          ],
        },
        {
          label: "Terminal",
          items: [
            { label: "查看阅读额度", hint: "usage", run: showUsage },
            { label: "显示 TERMINAL 面板", hint: "⌘`", run: () => {
              if (shell?.state) shell.state.panel = "terminal";
              shell?.setPanelOpen?.(true) ?? shell?.renderPanel();
              shell?.renderPanel();
            } },
          ],
        },
        {
          label: "Help",
          items: [
            { label: `关于《${book.title}》`, run: () => {
              if (shell?.state) shell.state.panel = "output";
              shell?.renderPanel();
            } },
            { label: "书库 / 换一本书", run: () => onOpenLibrary?.() },
          ],
        },
      ];
    },

    /**
     * 额度条，仿 Claude Code 的 /usage：
     *   session (5h) = 当前章节进度
     *   weekly (7d)  = 全书进度
     * resets 时间是装饰，右侧给的是真实的段数 / 字数。
     */
    usageStats() {
      return buildUsage();
    },

    /**
     * Agent 面板的播放脚本：一段正文 = 一步。
     * 直接复用编辑器已经渲染好的行（同样的折行、同样的图片 emoji），
     * 按 para 归并回段落，这样两个面板看到的内容完全一致。
     */
    agentScript() {
      if (!currentChapter || !currentRows.length) return null;

      /** @type {Map<number, {lines: string[], images: any[]}>} */
      const byPara = new Map();
      for (const row of currentRows) {
        if (row.para == null) continue;
        if (!byPara.has(row.para)) byPara.set(row.para, { lines: [], images: [] });
        const bucket = byPara.get(row.para);
        // 去掉注释前缀，Agent 面板里是"说话"，不该带 # 或 //
        bucket.lines.push(stripCommentMark(row.text));
        if (row.images?.length) bucket.images.push(...row.images);
      }

      const file = currentChapter.file;
      const dir = `src/chapters/${file}`;
      let line = 1;
      const steps = [...byPara.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([para, bucket]) => {
          const text = bucket.lines.join("\n").trim();
          const from = line;
          line += bucket.lines.length + 1;
          return {
            tool: para === 0 ? "Read" : "Edit",
            path: dir,
            range: `L${from}-${line - 2}`,
            text,
            images: bucket.images,
            para,
          };
        })
        .filter((s) => s.text || s.images.length);

      return {
        // header 由 Agent 面板负责转义，这里给纯文本，别重复转义
        header: `继续实现 ${file}：逐段补完《${currentChapter.title}》，每段等我确认`,
        steps,
      };
    },

    /**
     * 当前文档变了（含切回已缓存的 tab）。
     * 缓存命中时 openFile 不会被调用，这里补上「当前章节 / 当前行」的同步，
     * 否则 Agent 脚本和额度统计会停在上一章。
     */
    onActivate(doc) {
      if (!doc) {
        currentChapter = null;
        currentRows = [];
        return;
      }
      const ch = byHref.get(doc.id);
      if (ch) currentChapter = ch;
      currentRows = doc.rows || [];
    },

    /** 行内动作：由 shell 的 data-action 委托转发过来 */
    onAction(action, data) {
      if (action === "unmark") {
        dropBookmark(Number(data.at));
        return;
      }
      if (action === "style") {
        setStyle(data.style || "");
        return;
      }
      if (action === "wrap") {
        setWrap(data.wrap === "auto" ? "auto" : Number(data.wrap));
        return;
      }
      if (action === "density") {
        setDensity(data.density || "");
        return;
      }
      if (action === "maxrun") {
        setMaxRun(data.maxrun === "auto" ? "auto" : Number(data.maxrun));
        return;
      }
      if (action === "font") {
        shell?.setFontSize?.(Number(data.font));
        shell?.renderSidebar();
        return;
      }
      if (action === "speed") {
        shell?.setAgentSpeed?.(data.speed || "");
        shell?.renderSidebar();
        return;
      }
      if (action === "library") {
        onOpenLibrary?.();
        return;
      }
      if (action === "open" && data.id) {
        shell?.openFile(data.id);
      }
    },

    /** 阅读位置变了（已防抖）：落库并刷新状态栏 */
    onScroll(para, ratio) {
      chapterRatio = ratio;
      updateStatus();
      if (!currentChapter) return;
      // 只在段落真的变了时写库，避免同一段内反复滚动频繁写入
      if (Number(progress.para) === para) return;
      safeStore(
        saveState(id, { chapterHref: currentChapter.href, para }),
        { ...progress, para }
      ).then((st) => { progress = st; });
    },

    /** 编辑器可用列数变了：auto 模式才需要重渲染 */
    onResize() {
      if (currentWrapSetting() !== "auto") return;
      reopenCurrent();
    },

    onReady(api) {
      shell = api;
      // 侧边栏搜索框在 search 视图下驱动全书检索
      const input = document.querySelector(".vsc-side-search");
      input?.addEventListener("input", (e) => {
        if (api.state.activity !== "search") return;
        search(/** @type {HTMLInputElement} */ (e.target).value.trim());
        api.renderSidebar();
      });
      // 恢复上次阅读位置
      safeStore(getState(id), { id, chapterHref: "", para: 0, bookmarks: [] }).then((st) => {
        progress = st;
        if (st.chapterHref && byHref.has(st.chapterHref)) api.openFile(st.chapterHref);
        else api.refresh();
      });
    },

    /** 暴露给外部（书库页）用 */
    _book: book,
  };

  /** 相对当前章节跳转（-1 上一章 / +1 下一章） */
  function gotoChapter(delta) {
    if (!currentChapter) {
      if (chapters[0]) shell?.openFile(chapters[0].id);
      return;
    }
    const i = chapters.findIndex((c) => c.href === currentChapter.href);
    const next = chapters[i + delta];
    if (next) shell?.openFile(next.id);
  }

  /** 删书签：刷新侧栏与面板 */
  function dropBookmark(at) {
    if (!Number.isFinite(at)) return;
    safeStore(removeBookmark(id, at), {
      ...progress,
      bookmarks: (progress.bookmarks || []).filter((b) => b.at !== at),
    }).then((st) => {
      progress = st;
      shell?.renderPanel();
      shell?.renderSidebar();
    });
  }

  /** 改连续注释行上限 */
  function setMaxRun(v) {
    if (v === "auto") {
      lsSet(MAXRUN_KEY, "auto");
      reopenCurrent();
      return;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    lsSet(MAXRUN_KEY, String(Math.min(MAX_RUN_MAX, Math.max(MAX_RUN_MIN, Math.round(n)))));
    reopenCurrent();
  }

  /** 改伪装代码密度 */
  function setDensity(id) {
    if (!DENSITIES.some((d) => d.id === id)) return;
    lsSet(DENSITY_KEY, id);
    reopenCurrent();
  }

  /** 改折行宽度：传 "auto" 或具体列数。重渲染当前章节（清 tab 缓存，否则拿到的还是旧行） */
  function setWrap(cols) {
    if (cols === "auto") {
      lsSet(WRAP_KEY, "auto");
      reopenCurrent();
      return;
    }
    const n = Number(cols);
    if (!Number.isFinite(n)) return;
    lsSet(WRAP_KEY, String(Math.min(WRAP_MAX, Math.max(WRAP_MIN, Math.round(n)))));
    reopenCurrent();
  }

  /** 章节 -> 文件树的 file 节点 */
  function fileNode(ch, style) {
    return {
      kind: "file",
      id: ch.id,
      label: ch.file,
      // 文件名是 slug，中文书根本看不出是哪一章，hover 给出真实标题
      hint: ch.title,
      meta: ch.words ? fmtWords(ch.words) : "",
      icon: style.id === "markdown" ? "Ⓜ" : "📘",
      iconColor: "#519aba",
    };
  }

  function setStyle(styleId) {
    if (!STYLES.some((s) => s.id === styleId)) return;
    lsSet(STYLE_KEY, styleId);
    const ext = currentStyle().ext;
    chapters.forEach((c) => { c.file = chapterFileName(c.title, c.index, ext); });
    reopenCurrent();
  }

  /**
   * 丢掉 tab 缓存并重新打开当前章节，让新的风格 / 宽度 / 字号 / 密度生效。
   * 先把当前段落存进 pendingPara——改个字号就跳回章首太难用了。
   */
  function reopenCurrent() {
    const keep = currentChapter?.href;
    if (keep) pendingPara = shell?.currentPara?.() ?? null;
    if (shell?.state) shell.state.tabs.length = 0;
    if (keep) shell?.openFile(keep);
    else shell?.refresh();
  }
}

/** 去掉行首的注释标记，Agent 面板里显示的是"说的话"，不该带 # 或 // */
function stripCommentMark(text) {
  return String(text || "")
    .replace(/^\s*(?:\/\/\s?|#\s?|\*\s?|<!--\s?)/, "")
    .replace(/\s*-->\s*$/, "")
    .replace(/^\/\*+\s?/, "")
    .replace(/\s*\*\/\s*$/, "");
}

function fmtWords(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

function guessMime(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp", css: "text/css",
    xhtml: "application/xhtml+xml", html: "text/html",
    ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
  }[ext] || "application/octet-stream";
}

export { removeBookmark };

/**
 * EPUB 入口：保持原有调用方式不变。
 * @param {{files: Map<string, Uint8Array>, size: number, [k: string]: any}} args
 */
export function createEpubSource({ files, ...rest }) {
  return createBookSource({ adapter: createEpubAdapter(files), ...rest });
}
