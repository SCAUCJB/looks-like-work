/**
 * EPUB 的 BookAdapter：把 epub 包装成 createBookSource 认识的形状。
 *
 * @typedef {Object} BookAdapter
 * @property {string} kind                       "epub" / "pdf"，只用于展示
 * @property {{title: string, author: string}} meta
 * @property {{href: string, title: string, depth: number, parent: string|null,
 *             anchors: {label: string, anchor: string}[]}[]} chapters
 * @property {(href: string) => {bytes?: Uint8Array, paras?: string[]} | null} contentOf
 * @property {(href: string) => string} plainOf  检索用纯文本
 * @property {(path: string) => string} [blobUrlFor]
 * @property {() => string} [coverUrl]
 * @property {() => string[]} [info]             OUTPUT 面板里的诊断行
 */

import { parseBook, buildTocIndex } from "./opf.js";
import { htmlToPlainText } from "../../shell/chunks.js";

const decoder = new TextDecoder("utf-8");

/**
 * @param {Map<string, Uint8Array>} files
 * @returns {BookAdapter}
 */
export function createEpubAdapter(files) {
  const book = parseBook(files);
  const tocIndex = buildTocIndex(book.toc);

  // 只有 xhtml/html 才是可读章节，图片和 CSS 不进文件树。
  // 顺序取自 spine（那才是真正的阅读顺序），层级取自 TOC 的父子关系。
  const readable = book.spine.filter(
    (s) => /x?html/i.test(s.mediaType) || /\.x?html?$/i.test(s.href)
  );
  const inSpine = new Set(readable.map((s) => s.href));

  /** 往上找第一个确实在 spine 里的祖先——TOC 可能指向不参与阅读顺序的文件 */
  function resolveParent(href) {
    const seen = new Set([href]);
    let p = tocIndex.get(href)?.parent || null;
    while (p && !seen.has(p)) {
      if (inSpine.has(p)) return p;
      seen.add(p);
      p = tocIndex.get(p)?.parent || null;
    }
    return null;
  }

  let lastParent = null;
  const chapters = readable.map((s, i) => {
    const hit = tocIndex.get(s.href);
    let parent;
    if (hit) {
      parent = resolveParent(s.href);
      lastParent = parent;
    } else {
      // TOC 没覆盖的文件（插页、版权页等）：继承前一个章节的父级。
      // 当成顶层的话，它会把后面本属于上一章的子章全抢过去。
      parent = lastParent;
    }
    return {
      href: s.href,
      title: hit?.label || `Chapter ${i + 1}`,
      depth: hit?.depth ?? 0,
      parent,
      anchors: hit?.anchors || [],
    };
  });

  /** blob URL 缓存：同一张图只创建一次 */
  const blobUrls = new Map();

  function blobUrlFor(zipPath) {
    if (!zipPath) return "";
    if (blobUrls.has(zipPath)) return blobUrls.get(zipPath);
    const bytes = files.get(zipPath);
    if (!bytes) {
      blobUrls.set(zipPath, "");
      return "";
    }
    const item = book.byHref.get(zipPath);
    const url = URL.createObjectURL(
      new Blob([bytes], { type: item?.mediaType || guessMime(zipPath) })
    );
    blobUrls.set(zipPath, url);
    return url;
  }

  /** 取章节 body（检索和渲染都要用） */
  function bodyOf(href) {
    const bytes = files.get(href);
    if (!bytes) return "";
    const raw = decoder.decode(bytes);
    const m = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return m ? m[1] : raw;
  }

  return {
    kind: "epub",
    meta: { title: book.title, author: book.author, publisher: book.publisher, language: book.language },
    chapters,
    contentOf: (href) => (files.has(href) ? { bytes: files.get(href) } : null),
    plainOf: (href) => htmlToPlainText(bodyOf(href)),
    blobUrlFor,
    coverUrl: () => (book.coverHref ? blobUrlFor(book.coverHref) : ""),
    info: () => [
      `opf: ${book.opfPath}`,
      `spine: ${book.spine.length} items`,
      `manifest: ${book.manifest.size} resources`,
      `toc: ${book.toc.length} top-level entries`,
    ],
  };
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
