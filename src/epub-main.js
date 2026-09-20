/**
 * EPUB · VS Code 工作区 入口
 *
 * 流程：拖入/选择 epub -> unzip -> parseBook -> createEpubSource -> createShell().mount()
 * 书库存 IndexedDB，下次打开直接从书库继续读。
 */

import { buildCss, injectStyle } from "./shell/style.js";
import { createShell, storedPanelH, sideWidth, codeSize, codeLine, gutterW } from "./shell/shell.js";
import { escapeHtml } from "./shell/util.js";
import { STYLE_ID, ROOT_CLASS } from "./shell/const.js";
import { unzip } from "./sources/epub/unzip.js";
import { createBookSource, createEpubSource } from "./sources/epub/source.js";
import { createEpubAdapter } from "./sources/epub/adapter.js";
import { loadPdf, pdfAvailable } from "./sources/pdf/load.js";
import { createPdfAdapter } from "./sources/pdf/adapter.js";
import { putBook, listBooks, getBookBlob, deleteBook, bookId } from "./sources/epub/store.js";

/**
 * 环境自检。缺任何一项都会让「打开」悄无声息地失败，
 * 与其让用户对着空白页面发呆，不如直接说清楚缺什么。
 */
function checkEnv() {
  const problems = [];
  try {
    // deflate-raw 比 DecompressionStream 本身晚一步落地：Chrome 105+ / Safari 17+
    new DecompressionStream("deflate-raw");
  } catch {
    problems.push(
      "浏览器不支持 DecompressionStream('deflate-raw')，无法解压 epub。" +
      "需要 Chrome 105+ / Edge 105+ / Safari 17+ / Firefox 113+。"
    );
  }
  if (typeof indexedDB === "undefined") {
    problems.push("浏览器禁用了 IndexedDB，书库和阅读进度无法保存（仍可临时阅读）。");
  }
  return problems;
}

/** 环境诊断，出问题时把它贴给我就能定位 */
function diagnostics() {
  const yes = (v) => (v ? "✓" : "✗");
  let dcs = false;
  try { new DecompressionStream("deflate-raw"); dcs = true; } catch { /* 不支持 */ }
  return [
    `UA          ${navigator.userAgent}`,
    `协议        ${location.protocol}`,
    `解压 API    ${yes(dcs)} DecompressionStream('deflate-raw')`,
    `PDF 支持    ${yes(pdfAvailable())}`,
    `IndexedDB   ${yes(typeof indexedDB !== "undefined")}`,
    `File API    ${yes(typeof File !== "undefined" && typeof Blob !== "undefined")}`,
    `文件读取    ${yes(typeof Blob !== "undefined" && !!Blob.prototype.arrayBuffer)}`,
    `localStorage ${yes((() => { try { localStorage.setItem("_t", "1"); localStorage.removeItem("_t"); return true; } catch { return false; } })())}`,
  ].join("\n");
}

/** 把错误显示到页面上——只写 console 的话，用户看到的就是「没反应」 */
function fatal(msg, detail) {
  const host = document.getElementById("library");
  if (!host) return;
  host.hidden = false;
  const box = document.createElement("div");
  box.className = "lib-fatal";
  box.innerHTML = `<strong>出错了</strong><p>${escapeHtml(String(msg || ""))}</p>` +
    (detail ? `<pre>${escapeHtml(String(detail))}</pre>` : "");
  host.prepend(box);
}

/** 环境自检结果，渲染书库页时要显示出来 */
let envProblems = [];

/**
 * 当前挂载的工作区外壳。
 * 换书 / 回书库前必须 destroy()——只删 DOM 的话，旧外壳在 document 和 window 上的
 * 监听器会留下来和新外壳叠加（按一次 ⌘I 触发两次）。
 * @type {{destroy: () => void} | null}
 */
let currentShell = null;

/** 拆掉当前工作区 */
function teardownWorkspace() {
  try {
    currentShell?.destroy();
  } catch (err) {
    console.warn("[epub] 拆除旧工作区时出错", err);
  }
  currentShell = null;
  document.querySelector(".vsc-app")?.remove();
}

function applyStyles() {
  document.documentElement.classList.add(ROOT_CLASS);
  // hostTakeover: false —— 这是独立页面，不需要（也不能）接管宿主页面的 body
  injectStyle(STYLE_ID, buildCss({
    ROOT_CLASS, storedPanelH, sideWidth, codeSize, codeLine, gutterW, hostTakeover: false,
  }));
}

/**
 * 弹出文件选择器。书库页里的 input 会随页面清空而消失，
 * 所以工作区里用一个常驻的隐藏 input。
 */
function pickEpubFile(say) {
  let input = document.getElementById("vsc-file-picker");
  if (!input) {
    input = document.createElement("input");
    input.type = "file";
    input.id = "vsc-file-picker";
    input.accept = acceptAttr();
    // 视觉隐藏而不是 hidden：display:none 的 file input 在 Safari 下可能不派发 change
    input.className = "lib-file";
    document.body.appendChild(input);

    let last = 0;
    const onPick = () => {
      const f = input.files?.[0];
      if (!f) return;
      const now = Date.now();
      if (now - last < 300) return;   // change 和 input 都会来，去重
      last = now;
      input.value = "";               // 清空，否则连选同一个文件不会再触发
      handleFile(f, say || ((m, e) => console[e ? "error" : "log"]("[epub]", m)));
    };
    input.addEventListener("change", onPick);
    input.addEventListener("input", onPick);
  }
  input.click();
}

/* ------------------------------ 书库页 ------------------------------ */

async function renderLibrary() {
  // IndexedDB 在隐私模式 / 某些浏览器的 file:// 下会直接抛错。
  // 不兜住的话整个渲染中断，页面一片空白——这正是「打开没反应」的样子。
  let books = [];
  let storeError = "";
  try {
    books = await listBooks();
  } catch (err) {
    storeError = err instanceof Error ? err.message : String(err);
    console.warn("[epub] 书库不可用，仅支持临时阅读", err);
  }

  const host = document.getElementById("library");
  if (!host) return;
  host.hidden = false;
  teardownWorkspace();

  host.innerHTML = `
    <div class="lib-wrap">
      <h1>${pdfAvailable() ? "EPUB / PDF" : "EPUB"} · VS Code 工作区</h1>
      <p class="lib-sub">把书当代码读：目录变文件树，正文变注释，插图 hover 出预览。</p>
      <div class="lib-drop" id="drop" role="button" tabindex="0">
        <strong>拖入 ${acceptedExts().join(" / ")} 文件</strong>
        <span>或点击选择（文件只存在你自己的浏览器里，不会上传）</span>
      </div>
      <!--
        input 刻意放在 label/按钮外面，并且用视觉隐藏而不是 hidden：
        - 嵌在 label 里会让 click 被转发一次、input 自己再收一次，某些浏览器下选择直接被取消
        - Safari 对 display:none 的 file input 可能根本不派发 change
      -->
      <input type="file" accept="${acceptAttr()}" id="file" class="lib-file">
      <div class="lib-status" id="status"></div>
      ${envProblems.length
        ? `<div class="lib-warn">${envProblems.map((p) => `<div>⚠︎ ${escapeHtml(p)}</div>`).join("")}</div>`
        : ""}
      ${storeError
        ? `<div class="lib-warn"><div>⚠︎ 书库不可用（${escapeHtml(storeError)}），本次可以正常阅读，但不会保存进度。</div></div>`
        : ""}
      <div class="lib-diag-wrap">
        <button type="button" class="lib-diag-btn" id="diag">打不开？点here查看环境诊断</button>
        <pre class="lib-diag" id="diagbox" hidden></pre>
      </div>
      ${books.length ? `<h2>书库 · ${books.length}</h2><div class="lib-list">${books.map((b) => `
        <div class="lib-item" data-id="${escapeHtml(b.id)}">
          <div class="lib-item-main">
            <div class="lib-title">${escapeHtml(b.title)}</div>
            <div class="lib-meta">${escapeHtml(b.author || "unknown")} · ${fmtSize(b.size)}</div>
          </div>
          <button type="button" class="lib-open" data-open="${escapeHtml(b.id)}">打开</button>
          <button type="button" class="lib-del" data-del="${escapeHtml(b.id)}" title="从书库移除">×</button>
        </div>`).join("")}</div>` : ""}
    </div>`;

  const status = /** @type {HTMLElement} */ (host.querySelector("#status"));
  const fileInput = /** @type {HTMLInputElement} */ (host.querySelector("#file"));
  const drop = /** @type {HTMLElement} */ (host.querySelector("#drop"));

  const say = (msg, err = false) => {
    status.textContent = msg;
    status.classList.toggle("err", err);
  };

  // change 和 input 都监听：个别浏览器只派发其中一个；用时间戳去重避免处理两次
  let lastPick = 0;
  const onPick = () => {
    const f = fileInput.files?.[0];
    if (!f) {
      say("没有拿到文件，请再试一次。", true);
      return;
    }
    const now = Date.now();
    if (now - lastPick < 300) return;
    lastPick = now;
    // 先给反馈：万一后面卡住，至少能看出「文件已经收到了」
    say(`已选择 ${f.name}（${fmtSize(f.size)}），正在读取…`);
    handleFile(f, say);
  };
  fileInput.addEventListener("change", onPick);
  fileInput.addEventListener("input", onPick);

  // 点击拖拽区 / 回车空格都能打开选择器
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList.remove("over"))
  );
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = /** @type {DragEvent} */ (e).dataTransfer?.files?.[0];
    if (f) handleFile(f, say);
  });

  host.addEventListener("click", async (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const openId = target.closest("[data-open]")?.getAttribute("data-open");
    const delId = target.closest("[data-del]")?.getAttribute("data-del");
    if (delId) {
      await deleteBook(delId);
      renderLibrary();
      return;
    }
    if (openId) {
      const blob = await getBookBlob(openId);
      if (!blob) {
        say("书库里找不到这本书的内容，请重新拖入。", true);
        return;
      }
      openWorkspace(await blob.arrayBuffer(), blob.size, say);
    }
  });

  const diagBtn = host.querySelector("#diag");
  const diagBox = host.querySelector("#diagbox");
  diagBtn?.addEventListener("click", () => {
    diagBox.hidden = !diagBox.hidden;
    if (!diagBox.hidden) diagBox.textContent = diagnostics();
  });

  // 整个窗口都能接收拖拽
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && !document.querySelector(".vsc-app")) handleFile(f, say);
  });
}

/** 按文件头判断是不是 PDF（%PDF-）——拖进来的文件可能没后缀 */
function isPdfBuffer(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(5, buffer.byteLength));
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
}

/** 这个产物支持哪些格式（epub-vscode.html 不带 pdf.js） */
function acceptedExts() {
  return pdfAvailable() ? [".epub", ".pdf"] : [".epub"];
}

function acceptAttr() {
  return pdfAvailable()
    ? ".epub,.pdf,application/epub+zip,application/pdf"
    : ".epub,application/epub+zip";
}

/** @param {File} file */
async function handleFile(file, say) {
  const isEpub = /\.epub$/i.test(file.name) || file.type === "application/epub+zip";
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (!isEpub && !isPdf) {
    say(`“${file.name}” 不是 ${acceptedExts().join(" / ")} 文件。`, true);
    return;
  }
  if (isPdf && !pdfAvailable()) {
    say("这个版本不支持 PDF，请改用 reader-vscode.html（带 PDF 支持的完整版）。", true);
    return;
  }
  say(`正在解析 ${file.name}（${fmtSize(file.size)}）…`);
  try {
    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength < 100) {
      say(`“${file.name}” 是空文件或读取失败（${buffer?.byteLength ?? 0} 字节）。`, true);
      return;
    }
    say(`已读取 ${fmtSize(buffer.byteLength)}，正在解析…`);
    await openWorkspace(buffer, file.size, say, { blob: file, isPdf });
  } catch (err) {
    console.error("[epub] 打开失败", err);
    say(`打开失败：${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/* ------------------------------ 工作区 ------------------------------ */

async function openWorkspace(buffer, size, say, { blob, isPdf } = {}) {
  try {
    // PDF 和 EPUB 只有「怎么拿内容」不同，后面共用同一套数据源
    let adapter;
    if (isPdf ?? isPdfBuffer(buffer)) {
      const book = await loadPdf(buffer, (m) => say?.(m));
      if (!book.hasText) {
        say?.(
          "这个 PDF 没有文本层（多半是扫描版），提取不出文字。需要 OCR 才能读，本工具暂不支持。",
          true
        );
        return;
      }
      say?.(`解析出 ${book.pages} 页、${book.chapters.length} 章`);
      adapter = createPdfAdapter(book);
    } else {
      const files = await unzip(buffer);
      say?.(`解包出 ${files.size} 个文件，正在解析目录…`);
      adapter = createEpubAdapter(files);
    }

    // File 菜单里的「最近打开」
    const recentBooks = await listBooks().catch(() => []);
    const source = createBookSource({
      adapter,
      size,
      recentBooks,
      onOpenLibrary: () => renderLibrary(),
      onPickFile: () => pickEpubFile(say),
      onOpenBook: async (bookIdToOpen) => {
        const b = await getBookBlob(bookIdToOpen);
        if (!b) {
          say?.("书库里找不到这本书的内容，请重新拖入。", true);
          return;
        }
        openWorkspace(await b.arrayBuffer(), b.size, say);
      },
    });

    // 首次打开时入库（含原始 blob，方便下次直接读）
    if (blob) {
      const bk = source._book;
      await putBook({
        id: bookId(bk.title, size),
        title: bk.title,
        author: bk.author,
        size,
        blob,
      }).catch((err) => console.warn("[epub] 入库失败（不影响阅读）", err));
    }

    // 换书：先把上一本的外壳彻底拆掉，否则 mount 会发现已有外壳而不挂载新的，
    // 页面就一直停在上一本书
    teardownWorkspace();

    const lib = document.getElementById("library");
    if (lib) {
      lib.hidden = true;
      lib.innerHTML = "";
    }
    document.title = `${source.workspaceName()} — EPUB Workspace`;
    currentShell = createShell(source).mount();
  } catch (err) {
    console.error("[epub] 打开失败", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (say) say(`打开失败：${msg}`, true);
    // 书库页可能已经被清空了，这时 say 写到哪都看不见，再兜一层
    if (!document.querySelector(".vsc-app")) {
      await renderLibrary().catch(() => {});
      fatal(`打开失败：${msg}`, err instanceof Error ? err.stack : "");
    }
  }
}

function fmtSize(n) {
  const mb = (Number(n) || 0) / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round((Number(n) || 0) / 1024)} KB`;
}

/* ------------------------------ 启动 ------------------------------ */

// ⌘/Ctrl + O：随时添加一本新书
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    pickEpubFile();
  }
});

// 任何没被接住的错误都显示到页面上，而不是只留在 console 里
window.addEventListener("error", (e) => {
  fatal(e.message || "脚本错误", e.error?.stack || "");
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  fatal(r?.message || String(r) || "未处理的异步错误", r?.stack || "");
});

envProblems = checkEnv();
if (envProblems.length) console.warn("[epub] 环境自检", envProblems);

applyStyles();
renderLibrary().catch((err) => fatal("书库页渲染失败", err?.stack || String(err)));
