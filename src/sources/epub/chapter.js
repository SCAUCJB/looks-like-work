/**
 * 章节 xhtml -> 编辑器行（Row[]）
 *
 * 复用 shell 层的 htmlToChunks + commentWrap：正文变注释绿、保留原始换行、
 * <pre> 变代码栅栏、图片变 emoji（hover 出预览）。
 */

import { htmlToChunks, sanitizeHtml } from "../../shell/chunks.js";
import { commentWrap } from "../../shell/render.js";
import { mulberry32, hashStr, escapeHtml } from "../../shell/util.js";
import { IMG_EMOJI } from "../../shell/const.js";
import { wrapText } from "../../shell/wrap.js";
import { createCodeGen, densityOf, DEFAULT_DENSITY, DEFAULT_MAX_RUN, MAX_RUN_MIN, MAX_RUN_MAX } from "./codegen.js";
import { resolvePath } from "./unzip.js";

/** 渲染风格：决定注释符号与「伪代码」骨架 */
export const STYLES = [
  { id: "markdown", label: "Markdown", ext: "md", cstyle: "hash" },
  { id: "javascript", label: "JavaScript", ext: "js", cstyle: "slash" },
  { id: "typescript", label: "TypeScript", ext: "ts", cstyle: "slash" },
  { id: "python", label: "Python", ext: "py", cstyle: "hash" },
  { id: "rust", label: "Rust", ext: "rs", cstyle: "slash" },
  { id: "html", label: "HTML", ext: "html", cstyle: "html" },
];

const decoder = new TextDecoder("utf-8");

/** 默认折行宽度（显示列数）。中文约 44 字/行，西文约 88 字符/行。 */
export const DEFAULT_WRAP = 88;
export const WRAP_MIN = 40;
export const WRAP_MAX = 200;

/**
 * 把章节内的 <img src> 改写成 blob URL，让 hover 预览能直接显示书里的插图
 * @param {string} html
 * @param {string} chapterHref  章节在 zip 内的路径（用于解析相对 src）
 * @param {(zipPath: string) => string} blobUrlFor
 */
function rewriteImages(html, chapterHref, blobUrlFor) {
  const chapterBase = chapterHref.includes("/") ? chapterHref.replace(/\/[^/]+$/, "/") : "";
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("img, image").forEach((img) => {
    const raw = img.getAttribute("src") || img.getAttribute("xlink:href") || "";
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return;
    const url = blobUrlFor(resolvePath(chapterBase, raw));
    if (url) img.setAttribute("src", url);
    else img.remove();
  });
  // svg 包 image 的封面写法，转成普通 img 以便统一处理
  doc.querySelectorAll("svg").forEach((svg) => {
    const inner = svg.querySelector("image");
    if (!inner) return;
    const el = doc.createElement("img");
    el.setAttribute("src", inner.getAttribute("src") || "");
    el.setAttribute("alt", "cover");
    svg.replaceWith(el);
  });
  return doc.body.firstElementChild?.innerHTML || "";
}

/**
 * @param {Object} args
 * @param {Uint8Array} [args.bytes]     章节 xhtml 原始字节（EPUB）
 * @param {string[]} [args.paras]       已经还原好的段落（PDF），与 bytes 二选一
 * @param {string} args.href            zip 内路径
 * @param {string} args.title           章节标题（来自 TOC）
 * @param {string} args.bookTitle
 * @param {string} args.author
 * @param {{id: string, cstyle: string, ext: string, label: string}} args.style
 * @param {(zipPath: string) => string} args.blobUrlFor
 * @param {number} [args.wrapCols]     每行最大显示列数（默认 DEFAULT_WRAP）
 * @param {string} [args.density]      段落间伪装代码密度：off / low / mid / high
 * @param {number} [args.maxRun]       连续注释行上限，超过就在段落中间插代码
 * @returns {{rows: import("../../shell/shell.js").Row[], words: number, paras: number, plain: string}}
 */
export function renderChapter({
  bytes, paras: rawParas, href, title, bookTitle, author, style, blobUrlFor,
  wrapCols = DEFAULT_WRAP,
  density = DEFAULT_DENSITY,
  maxRun,
}) {
  // 两种输入：EPUB 给 xhtml 字节，PDF 给已经还原好的段落
  let chunks;
  let images;
  if (Array.isArray(rawParas)) {
    chunks = rawParas
      .map((t) => String(t ?? ""))
      .filter((t) => t.trim())
      .map((value) => ({ kind: "text", value }));
    images = [];
  } else {
    const rawHtml = decoder.decode(bytes);
    // 只取 body，丢掉书自带的 CSS / 字体 / 脚本
    const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = sanitizeHtml(bodyMatch ? bodyMatch[1] : rawHtml);
    const html = rewriteImages(bodyHtml, href, blobUrlFor);
    const out = htmlToChunks(html);
    chunks = out.parts;
    images = out.images;
  }
  const rand = mulberry32(Math.abs(hashStr(href)) || 1);
  const cstyle = style.cstyle;

  /** @type {import("../../shell/shell.js").Row[]} */
  const rows = [];
  const push = (type, text, extra = {}) => rows.push({ type, text, ...extra });

  // 段落之间的伪装代码。种子同样来自 href，所以同一章每次打开完全一致。
  const dens = densityOf(density);
  // 连续注释行上限：没显式指定就跟随密度档位
  const runLimit = Number.isFinite(maxRun)
    ? Math.min(MAX_RUN_MAX, Math.max(MAX_RUN_MIN, Math.round(maxRun)))
    : (Number.isFinite(dens.maxRun) ? dens.maxRun : DEFAULT_MAX_RUN);
  const gen = createCodeGen({
    style,
    rand: mulberry32(Math.abs(hashStr(`${href}#code`)) || 7),
    bookIdent: slugIdent(bookTitle),
    chapterIdent: slugIdent(title),
  });

  // ---- 文件头：书名 / 作者 / 章节名，做成 import 风格的伪代码 ----
  const head = {
    slash: [
      `/**`,
      ` * ${bookTitle}`,
      author ? ` * @author ${author}` : ` *`,
      ` * @chapter ${title}`,
      ` */`,
    ],
    hash: [
      `# ${bookTitle}`,
      author ? `# author: ${author}` : "#",
      `# chapter: ${title}`,
    ],
    html: [`<!--`, `  ${bookTitle}`, author ? `  author: ${author}` : "", `  chapter: ${title}`, `-->`],
  }[cstyle] || [];
  head.filter(Boolean).forEach((l) => push("comment", l));
  push("plain", "");

  if (style.id === "markdown") {
    push("code", `# ${title}`);
    push("plain", "");
  } else if (style.id === "python") {
    push("code", `from ${slugIdent(bookTitle)} import reader`);
    push("plain", "");
    push("code", `def ${slugIdent(title) || "chapter"}():`);
  } else if (style.id === "rust") {
    push("code", `use ${slugIdent(bookTitle)}::reader;`);
    push("plain", "");
    push("code", `pub fn ${slugIdent(title) || "chapter"}() {`);
  } else if (style.id === "html") {
    push("code", `<article class="${slugIdent(title) || "chapter"}">`);
  } else {
    push("code", `import { reader } from "./${slugIdent(bookTitle)}"`);
    push("plain", "");
    push("code", `export function ${slugIdent(title) || "chapter"}() {`);
  }

  // ---- 正文：每个 chunk 包成注释 ----
  let wordCount = 0;
  let paraCount = 0;
  const plainParts = [];

  /**
   * 已经连续输出了多少行注释。
   * 必须跨段落累计——段落之间不一定会插代码，两段注释连起来照样是一大片绿的。
   */
  let runLen = 0;

  const pushComment = (text, extra = {}) => {
    push("comment", text, extra);
    runLen += 1;
  };

  /** 插一段伪装代码并清空连续计数 */
  const insertCode = () => {
    push("plain", "");
    gen.snippet().rows.forEach((r) => rows.push(r));
    push("plain", "");
    runLen = 0;
  };

  for (const chunk of chunks) {
    if (chunk.kind === "fence") {
      const wrapped = commentWrap([chunk], cstyle, rand, images);
      (wrapped.rows || []).forEach((r) => rows.push(r));
      continue;
    }
    const text = chunk.value || "";
    if (!text.trim() && !/⟦IMG:\d+⟧/.test(text)) {
      push("plain", "");
      continue;
    }
    wordCount += countWords(text);
    plainParts.push(text);

    // 按显示宽度折行后再包注释：折出的每一行都会独立占一个行号，
    // 避免一段几百字的正文变成一条需要横向滚动的超长行。
    // 减 4 是给注释前缀（"# " / "// " / " * "）留的余量。
    const wrappedText = wrapText(text, Math.max(20, wrapCols - 4));
    // para = 正文段落序号，用于记忆阅读位置。
    // 段落数由内容决定，不随字号 / 折行宽度 / 伪装代码密度变化，
    // 所以拿它当锚点比行号或滚动像素都稳。
    const para = paraCount;

    // 长段落切成若干组，每组单独包成一个完整的注释块，组之间插代码。
    // 不能直接往注释块中间塞代码——块注释（/* */、<!-- -->）里插代码就跑到注释内部去了，
    // 看着还是绿的。切成独立的块才能安全地在中间插。
    const srcLines = wrappedText.split("\n");
    // 组大小要给注释包裹留余量：块注释（/* … */、<!-- … -->）会额外占掉首尾两行，
    // 按上限整切的话输出就会超出上限。
    const groupSize = Math.max(1, runLimit - 2);
    const groups = [];
    if (dens.chance > 0 && Number.isFinite(runLimit) && srcLines.length > groupSize) {
      for (let i = 0; i < srcLines.length; i += groupSize) {
        groups.push(srcLines.slice(i, i + groupSize).join("\n"));
      }
    } else {
      groups.push(wrappedText);
    }

    groups.forEach((groupText, gi) => {
      const isLast = gi === groups.length - 1;
      const wrapped = commentWrap([{ ...chunk, value: groupText }], cstyle, rand, images);
      // 图片只挂在整段的最后一行
      const imgs = isLast ? wrapped.images || [] : [];

      // 输出前先预判：这一组加进去会不会让连续注释超限。
      // 只在输出后才检查是不够的——上一段末尾剩几行，这一组又一次性加一整块，
      // 两者相加照样超。
      const incoming = wrapped.lines?.length || 1;
      if (dens.chance > 0 && runLen > 0 && Number.isFinite(runLimit) && runLen + incoming > runLimit) {
        insertCode();
      }

      if (wrapped.lines?.length) {
        wrapped.lines.forEach((line, i) => {
          pushComment(line, {
            para,
            ...(i === wrapped.lines.length - 1 && imgs.length ? { images: imgs } : {}),
          });
        });
      } else if (wrapped.inline) {
        // commentWrap 对短文本有一定概率返回 inline 形式（V2EX 版把它拼在代码行尾）。
        // 这里没有可拼的代码行，必须自己成行——否则这一段正文会被整段丢掉。
        pushComment(wrapped.inline.trim(), { para, ...(imgs.length ? { images: imgs } : {}) });
      } else if (imgs.length) {
        pushComment("// media", { para, images: imgs });
      }

      // 段内切开的地方一定要插代码，否则切了等于没切
      if (!isLast && runLen > 0) insertCode();
    });

    // 段落之后按密度插一段伪装代码。只在「这一段确实输出了内容」之后插，
    // 避免出现两段代码贴在一起、中间没有正文的情况。
    paraCount += 1;
    if (dens.chance > 0 && paraCount > 1) {
      // 连续注释已经攒够上限就必须插，不再看概率——否则相邻几个短段落连起来
      // 照样是一大片绿的
      const forced = Number.isFinite(runLimit) && runLen >= runLimit;
      if (forced || rand() < dens.chance) {
        insertCode();
        // burst：接着再插一两段，凑成成块的代码。零散的单行比成块的更假。
        let burst = 0;
        while (burst < 2 && rand() < dens.burst) {
          gen.snippet().rows.forEach((r) => rows.push(r));
          push("plain", "");
          burst += 1;
        }
      }
    }
  }

  // ---- 文件尾 ----
  push("plain", "");
  if (style.id === "python" || style.id === "rust") {
    push("code", style.id === "python" ? "    return reader.next()" : "    reader.next();");
    if (style.id === "rust") push("code", "}");
  } else if (style.id === "html") {
    push("code", "</article>");
  } else if (style.id !== "markdown") {
    push("code", "  return reader.next()");
    push("code", "}");
  }

  return { rows, words: wordCount, paras: paraCount, plain: plainParts.join("\n") };
}

/** 中英文混合的字数统计：中文按字，西文按词 */
export function countWords(text) {
  const s = String(text || "");
  const cjk = (s.match(/[一-鿿぀-ヿ]/g) || []).length;
  const words = (s.replace(/[一-鿿぀-ヿ]/g, " ").match(/[A-Za-z0-9''-]+/g) || []).length;
  return cjk + words;
}

/** 章节名 -> 合法标识符（伪代码函数名用） */
export function slugIdent(text) {
  const ascii = String(text || "")
    .replace(/[一-鿿぀-ヿ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (ascii) return ascii.slice(0, 40);
  // 纯中文标题：用稳定 hash 兜底，保证同一章节名每次生成一致
  return `ch_${(Math.abs(hashStr(String(text || ""))) % 100000).toString(36)}`;
}

/** 章节名 -> 伪文件名 */
export function chapterFileName(title, index, ext) {
  const n = String(index + 1).padStart(2, "0");
  return `${n}-${slugIdent(title) || "chapter"}.${ext}`;
}

/** 章节纯文本 -> 摘要（TERMINAL / 搜索结果用） */
export function excerpt(plain, max = 120) {
  const s = String(plain || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export { escapeHtml, IMG_EMOJI };
