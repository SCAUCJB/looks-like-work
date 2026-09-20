/**
 * epub 结构解析：container.xml -> OPF（metadata / manifest / spine）-> TOC
 * 兼容 EPUB2（toc.ncx）与 EPUB3（nav.xhtml）。
 */

import { resolvePath } from "./unzip.js";

/**
 * @typedef {Object} SpineItem
 * @property {string} id
 * @property {string} href       zip 内完整路径
 * @property {string} mediaType
 * @property {number} index      spine 顺序（从 0 起）
 *
 * @typedef {Object} TocNode
 * @property {string} label
 * @property {string} href       zip 内完整路径（不含 #anchor）
 * @property {string} anchor
 * @property {TocNode[]} children
 *
 * @typedef {Object} Book
 * @property {string} title
 * @property {string} author
 * @property {string} language
 * @property {string} publisher
 * @property {string} opfPath
 * @property {string} base
 * @property {SpineItem[]} spine
 * @property {Map<string, SpineItem>} manifest    id -> item
 * @property {Map<string, SpineItem>} byHref      href -> item
 * @property {TocNode[]} toc
 * @property {string} coverHref
 */

const parser = new DOMParser();
const decoder = new TextDecoder("utf-8");

/** @param {Map<string, Uint8Array>} files */
function readText(files, path) {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`epub 内缺少文件: ${path}`);
  return decoder.decode(bytes);
}

function parseXml(text) {
  const doc = parser.parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    // 有些书的 xhtml 不严格合法，退回 HTML 解析器
    return parser.parseFromString(text, "text/html");
  }
  return doc;
}

/**
 * @param {Map<string, Uint8Array>} files
 * @returns {Book}
 */
export function parseBook(files) {
  // 1. container.xml 指向 OPF
  const container = parseXml(readText(files, "META-INF/container.xml"));
  const rootfile = container.querySelector("rootfile");
  const opfPath = rootfile?.getAttribute("full-path");
  if (!opfPath) throw new Error("epub 缺少 rootfile（container.xml 异常）");
  const base = opfPath.includes("/") ? opfPath.replace(/\/[^/]+$/, "/") : "";

  // 2. OPF：metadata / manifest / spine
  const opf = parseXml(readText(files, opfPath));

  /** @type {Map<string, SpineItem>} */
  const manifest = new Map();
  /** @type {Map<string, SpineItem>} */
  const byHref = new Map();
  opf.querySelectorAll("manifest > item").forEach((it) => {
    const id = it.getAttribute("id") || "";
    const rawHref = it.getAttribute("href") || "";
    if (!id || !rawHref) return;
    const item = {
      id,
      href: resolvePath(base, rawHref),
      mediaType: it.getAttribute("media-type") || "",
      properties: it.getAttribute("properties") || "",
      index: -1,
    };
    manifest.set(id, item);
    byHref.set(item.href, item);
  });

  /** @type {SpineItem[]} */
  const spine = [];
  opf.querySelectorAll("spine > itemref").forEach((ref) => {
    const item = manifest.get(ref.getAttribute("idref") || "");
    // linear="no" 一般是封面/版权页，仍收进来但不参与进度计算
    if (!item) return;
    item.index = spine.length;
    item.linear = ref.getAttribute("linear") !== "no";
    spine.push(item);
  });
  if (!spine.length) throw new Error("epub 的 spine 为空，无法确定阅读顺序");

  const meta = (tag) => {
    const el = [...opf.querySelectorAll("metadata > *")].find(
      (n) => n.localName === tag || n.nodeName === `dc:${tag}`
    );
    return el?.textContent?.trim() || "";
  };

  // 3. TOC：EPUB3 nav 优先，回落 EPUB2 ncx
  const navItem = [...manifest.values()].find((i) => (i.properties || "").includes("nav"));
  const ncxId = opf.querySelector("spine")?.getAttribute("toc");
  const ncxItem = (ncxId && manifest.get(ncxId)) ||
    [...manifest.values()].find((i) => i.mediaType === "application/x-dtbncx+xml");

  let toc = [];
  try {
    if (navItem && files.has(navItem.href)) {
      toc = parseNav(readText(files, navItem.href), navItem.href);
    } else if (ncxItem && files.has(ncxItem.href)) {
      toc = parseNcx(readText(files, ncxItem.href), ncxItem.href);
    }
  } catch (err) {
    console.warn("[epub] TOC 解析失败，回落到 spine 顺序", err);
  }
  if (!toc.length) {
    toc = spine.filter((s) => s.mediaType.includes("html")).map((s, i) => ({
      label: `Chapter ${i + 1}`,
      href: s.href,
      anchor: "",
      children: [],
    }));
  }

  // 4. 封面
  const coverMeta = opf.querySelector('metadata > meta[name="cover"]')?.getAttribute("content");
  const coverItem =
    (coverMeta && manifest.get(coverMeta)) ||
    [...manifest.values()].find((i) => (i.properties || "").includes("cover-image")) ||
    [...manifest.values()].find((i) => /cover/i.test(i.href) && i.mediaType.startsWith("image/"));

  return {
    title: meta("title") || "untitled",
    author: meta("creator"),
    language: meta("language"),
    publisher: meta("publisher"),
    opfPath,
    base,
    spine,
    manifest,
    byHref,
    toc,
    coverHref: coverItem?.href || "",
  };
}

/** EPUB3：nav.xhtml 里 <nav epub:type="toc"> 下的嵌套 <ol> */
function parseNav(text, navPath) {
  const doc = parseXml(text);
  const navBase = navPath.includes("/") ? navPath.replace(/\/[^/]+$/, "/") : "";
  const nav =
    [...doc.querySelectorAll("nav")].find((n) =>
      (n.getAttribute("epub:type") || n.getAttribute("type") || "").includes("toc")
    ) || doc.querySelector("nav");
  if (!nav) return [];

  /** @param {Element} ol */
  const walk = (ol) => [...ol.children]
    .filter((li) => li.localName === "li")
    .map((li) => {
      const a = li.querySelector(":scope > a, :scope > span");
      const raw = a?.getAttribute("href") || "";
      const childOl = li.querySelector(":scope > ol");
      return {
        label: (a?.textContent || "").replace(/\s+/g, " ").trim() || "(untitled)",
        href: raw ? resolvePath(navBase, raw) : "",
        anchor: raw.includes("#") ? raw.split("#")[1] : "",
        children: childOl ? walk(childOl) : [],
      };
    });

  const rootOl = nav.querySelector("ol");
  return rootOl ? walk(rootOl) : [];
}

/** EPUB2：toc.ncx 的 navPoint 天然嵌套 */
function parseNcx(text, ncxPath) {
  const doc = parseXml(text);
  const ncxBase = ncxPath.includes("/") ? ncxPath.replace(/\/[^/]+$/, "/") : "";

  /** @param {Element} parent */
  const walk = (parent) => [...parent.children]
    .filter((n) => n.localName === "navPoint")
    .map((np) => {
      const raw = np.querySelector(":scope > content")?.getAttribute("src") || "";
      return {
        label: (np.querySelector(":scope > navLabel > text")?.textContent || "")
          .replace(/\s+/g, " ").trim() || "(untitled)",
        href: raw ? resolvePath(ncxBase, raw) : "",
        anchor: raw.includes("#") ? raw.split("#")[1] : "",
        children: walk(np),
      };
    });

  const navMap = doc.querySelector("navMap");
  return navMap ? walk(navMap) : [];
}

/**
 * 把 TOC 摊平成 href -> 条目信息。
 *
 * 关键是记 **parent（父章节的 href）**，而不是只记 depth 数字。
 * 章节顺序取自 spine，depth 一旦按 spine 顺序重排就还原不出真实父子关系了：
 * TOC 里 A 有个子章 C，但 spine 里 B 夹在 A 和 C 中间，
 * depth 序列就成了 [0, 0, 1]，栈式重建只能把 C 挂到最近的 B 上——挂错了。
 *
 * 同一个文件被多个 TOC 条目指向（单文件多章，靠 #anchor 区分）时，
 * 第一个条目作为这个文件的标题，其余记进 anchors，否则目录里会整段消失。
 *
 * @param {TocNode[]} toc
 * @returns {Map<string, {label: string, depth: number, parent: string|null, order: number,
 *                        anchors: {label: string, anchor: string, depth: number}[]}>}
 */
export function buildTocIndex(toc) {
  const index = new Map();
  let order = 0;

  const walk = (nodes, parentHref, depth) => {
    for (const node of nodes) {
      const href = node.href;
      if (href) {
        if (!index.has(href)) {
          index.set(href, {
            label: node.label,
            depth,
            // 自引用要挡掉：子条目指向同一个文件时 parent 会等于自己
            parent: parentHref && parentHref !== href ? parentHref : null,
            order: order++,
            anchors: [],
          });
        } else if (node.anchor) {
          // 同一文件的后续条目：作为节内锚点保留，别让它从目录里消失
          index.get(href).anchors.push({ label: node.label, anchor: node.anchor, depth });
        }
      }
      if (node.children?.length) {
        // 子节点的父级是当前条目；当前条目没有 href 时（纯分组标题）沿用上一层
        walk(node.children, href || parentHref, depth + 1);
      }
    }
  };

  walk(toc, null, 0);
  return index;
}

/** 兼容旧调用：只要 href -> {label, depth} */
export function flattenToc(toc) {
  const out = new Map();
  for (const [href, v] of buildTocIndex(toc)) out.set(href, { label: v.label, depth: v.depth });
  return out;
}
