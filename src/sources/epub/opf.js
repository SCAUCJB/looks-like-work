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
 * 把 TOC 摊平成「条目索引 + 分组索引」。
 *
 * 两个关键设计：
 *
 * 1. **记 parent（父条目的 id），不是 depth 数字。**
 *    章节顺序取自 spine，depth 一旦按 spine 顺序重排就还原不出真实父子关系了：
 *    TOC 里 A 有个子章 C，但 spine 里 B 夹在 A 和 C 中间，
 *    depth 序列就成了 [0, 0, 1]，栈式重建只能把 C 挂到最近的 B 上——挂错了。
 *
 * 2. **分组节点（group）与文件条目分开。**
 *    「第一部分」这类条目常常不拥有自己的文件，只是个壳。两种写法：
 *      - `<span>第一部分</span>` 完全没有 href
 *      - `<a href="ch1.xhtml">第一部分</a>` 直接指向它第一章的文件
 *    后者尤其坑：壳先到先得占住了 href，第一章再来就没位置了，
 *    于是**每一部分的第一章**要么凭空消失、要么被降级成锚点排到末尾。
 *    所以这里的规则是：**壳让位给子条目**，自己降为 group 只保留标题。
 *
 * @param {TocNode[]} toc
 * @returns {{
 *   index: Map<string, {label: string, depth: number, parent: string|null, order: number,
 *                       anchors: {label: string, anchor: string, depth: number}[]}>,
 *   groups: Map<string, {label: string, depth: number, parent: string|null, order: number}>
 * }}
 */
export function buildTocIndex(toc) {
  /** href -> 条目 */
  const index = new Map();
  /** 合成 id -> 分组条目（没有自己的文件） */
  const groups = new Map();
  let order = 0;

  /** 解析不出标题的条目不配拥有层级——建出来就是一层空文件夹 */
  const isMeaningful = (label) => !!label && label !== "(untitled)";

  /**
   * 这个节点是不是个「壳」——只起分组作用，href 只是指向它管辖的第一章。
   *
   * 判据是**第一个直接子节点跟它同文件**。壳的 href 表达的是
   * 「这一部分从这里开始」，所以必然落在第一个子上。
   *
   * 只看第一个子，是为了不误伤「章 + 章内小节」：
   *
   *     一 (a.html)
   *       一.1 (b.html)        ← 第一个子是别的文件
   *       一.2 (a.html#s2)     ← 指回自己，这是章内锚点，不是来抢文件的
   *
   * 这里的「一」是有正文的真实章节，不能降级。
   */
  const isShell = (node) => {
    if (!node.href) return false;
    const first = (node.children || [])[0];
    return !!first && first.href === node.href;
  };

  const walk = (nodes, parentId, depth) => {
    for (const node of nodes) {
      let selfId = null;

      if (node.href && !isShell(node) && !index.has(node.href)) {
        // 普通章节：占住这个文件
        selfId = node.href;
        index.set(node.href, {
          label: node.label,
          depth,
          // 自引用要挡掉：子条目指向同一个文件时 parent 会等于自己
          parent: parentId && parentId !== node.href ? parentId : null,
          order: order++,
          anchors: [],
        });
      } else if (node.href && index.has(node.href) && node.anchor) {
        // 同一文件的后续条目：作为节内锚点保留，别让它从目录里消失。
        // 它自己不成节点，所以子条目继续挂在这个文件上。
        index.get(node.href).anchors.push({ label: node.label, anchor: node.anchor, depth });
        selfId = node.href;
      } else if (isMeaningful(node.label)) {
        // 壳（第一部分 / Part I）或没有链接的分组标题：只保留标题，不占文件
        selfId = `::g${order++}`;
        groups.set(selfId, {
          label: node.label,
          depth,
          parent: parentId && parentId !== selfId ? parentId : null,
          order: order - 1,
        });
      } else {
        // 没名字又没文件的节点（跳级目录里用来占位的空 li）：
        // 透传父级，别凭空造出一层无名文件夹
        selfId = parentId;
      }

      if (node.children?.length) walk(node.children, selfId, depth + 1);
    }
  };

  walk(toc, null, 0);
  return { index, groups };
}

/** 兼容旧调用：只要 href -> {label, depth} */
export function flattenToc(toc) {
  const out = new Map();
  for (const [href, v] of buildTocIndex(toc).index) {
    out.set(href, { label: v.label, depth: v.depth });
  }
  return out;
}
