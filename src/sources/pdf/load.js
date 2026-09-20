/**
 * 用 pdf.js 把 PDF 读成「章节 + 段落」的结构，喂给和 EPUB 同一套 Source 适配器。
 *
 * pdf.js 是构建时内联进产物的（见 build.mjs 的 vendor 处理），
 * 通过 globalThis.pdfjsLib 取用；worker 源码以字符串形式内联，运行时转成 blob URL。
 * 只读 epub 的那个产物不含 pdf.js，所以这里的入口都要先检查可用性。
 */

import { itemsToLines, findRunningHeads, linesToParagraphs } from "./extract.js";

/** 这个产物里有没有打包 pdf.js */
export function pdfAvailable() {
  return typeof globalThis.pdfjsLib?.getDocument === "function";
}

let workerReady = false;

/** 把内联的 worker 源码转成 blob URL 交给 pdf.js */
function setupWorker() {
  if (workerReady) return;
  const lib = globalThis.pdfjsLib;
  const src = globalThis.__pdfWorkerSrc;
  if (!lib?.GlobalWorkerOptions) return;
  if (typeof src === "string" && src.length > 1000) {
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    lib.GlobalWorkerOptions.workerSrc = url;
  } else {
    // 没有 worker 就退回主线程解析：大文件会卡一下，但不至于打不开
    console.warn("[pdf] 没有内联 worker，改用主线程解析");
    lib.GlobalWorkerOptions.workerSrc = "";
  }
  workerReady = true;
}

/**
 * @typedef {Object} PdfChapter
 * @property {string} id
 * @property {string} title
 * @property {number} page      起始页（1 起）
 * @property {number} depth     目录层级
 * @property {{text: string, page: number}[]} paras
 *
 * @typedef {Object} PdfBook
 * @property {string} title
 * @property {string} author
 * @property {number} pages
 * @property {PdfChapter[]} chapters
 * @property {boolean} hasText   有没有文本层（扫描版就是 false）
 */

/**
 * @param {ArrayBuffer} buffer
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<PdfBook>}
 */
export async function loadPdf(buffer, onProgress) {
  if (!pdfAvailable()) {
    throw new Error("这个版本没有内置 PDF 支持，请使用 reader-vscode.html");
  }
  setupWorker();

  const lib = globalThis.pdfjsLib;
  const doc = await lib.getDocument({
    data: new Uint8Array(buffer),
    // 字体和 CMap 都没随包，禁用掉避免去网上取
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const meta = await doc.getMetadata().catch(() => null);
  const info = meta?.info || {};

  // 逐页提取文本
  /** @type {import("./extract.js").Line[][]} */
  const pageLines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    if (p % 10 === 0 || p === 1) onProgress?.(`正在提取文本 ${p}/${doc.numPages} 页…`);
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pageLines.push(itemsToLines(content.items || []));
    page.cleanup();
  }

  const totalChars = pageLines.flat().reduce((n, l) => n + l.text.length, 0);
  const hasText = totalChars > doc.numPages * 20;   // 平均每页 20 字都没有，基本可以判定是扫描版

  onProgress?.("正在还原段落…");
  const heads = findRunningHeads(pageLines);
  const paras = linesToParagraphs(pageLines, heads);

  // 目录：优先用 PDF 自带的 outline，没有就按页切
  onProgress?.("正在整理目录…");
  const outline = await doc.getOutline().catch(() => null);
  const marks = await outlineToPages(doc, outline);
  const chapters = marks.length
    ? splitByOutline(paras, marks)
    : splitByPages(paras, doc.numPages);

  return {
    title: (info.Title || "").trim() || "untitled",
    author: (info.Author || "").trim(),
    pages: doc.numPages,
    chapters,
    hasText,
  };
}

/** outline 条目 -> 页码 */
async function outlineToPages(doc, outline, depth = 0, out = []) {
  if (!Array.isArray(outline)) return out;
  for (const node of outline) {
    let page = 0;
    try {
      const dest = typeof node.dest === "string"
        ? await doc.getDestination(node.dest)
        : node.dest;
      if (Array.isArray(dest) && dest[0]) {
        page = (await doc.getPageIndex(dest[0])) + 1;
      }
    } catch {
      // 目标解析不了就跳过这一条，不影响其它条目
    }
    const title = String(node.title || "").replace(/\s+/g, " ").trim();
    if (page > 0 && title) out.push({ title, page, depth });
    if (node.items?.length) await outlineToPages(doc, node.items, depth + 1, out);
  }
  return out;
}

/** 按目录切分段落 */
function splitByOutline(paras, marks) {
  const sorted = [...marks].sort((a, b) => a.page - b.page);
  /** @type {PdfChapter[]} */
  const chapters = [];

  // 目录第一条之前的内容（封面、版权页等）单独成章
  if (sorted[0] && sorted[0].page > 1) {
    const head = paras.filter((p) => p.page < sorted[0].page);
    if (head.length) {
      chapters.push({ id: "front", title: "front-matter", page: 1, depth: 0, paras: head });
    }
  }

  sorted.forEach((m, i) => {
    const next = sorted[i + 1];
    const from = m.page;
    const to = next ? next.page : Infinity;
    // 同一页里有多个目录项时，页内不再细分，内容归给第一个
    const paged = paras.filter((p) => p.page >= from && p.page < to);
    chapters.push({
      id: `ch${i}`,
      title: m.title,
      page: m.page,
      depth: m.depth,
      paras: next && next.page === m.page ? [] : paged,
    });
  });

  return chapters.filter((c) => c.paras.length || c.title);
}

/** 没有目录时按页分组 */
function splitByPages(paras, numPages, per = 10) {
  /** @type {PdfChapter[]} */
  const chapters = [];
  for (let start = 1; start <= numPages; start += per) {
    const end = Math.min(numPages, start + per - 1);
    const group = paras.filter((p) => p.page >= start && p.page <= end);
    if (!group.length) continue;
    chapters.push({
      id: `p${start}`,
      title: `第 ${start}–${end} 页`,
      page: start,
      depth: 0,
      paras: group,
    });
  }
  return chapters;
}
