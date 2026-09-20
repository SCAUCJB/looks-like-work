/**
 * EPUB 解析 + 章节渲染的端到端测试。
 *
 * Node 没有 DOMParser / indexedDB，这里用 linkedom 补 DOM，
 * 用内存假实现补 IndexedDB，然后真跑 opf.js / chapter.js / source.js。
 *
 * linkedom 是 devDependency（--no-save 装的），仅测试用，不进构建产物。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";

/* ------------------------- DOM / 浏览器 API 桩 ------------------------- */

const { document, window } = parseHTML("<html><body></body></html>");

/**
 * linkedom 的 DOMParser 不做 HTML 的隐式 html/head/body 补全：
 * parseFromString("<div>x</div>", "text/html") 会把 <div> 当 documentElement，
 * doc.body 因此是空的。真浏览器会补成 <html><body><div>x</div></body></html>。
 * 这里包一层还原浏览器语义，否则测的就不是生产环境的行为。
 */
class BrowserLikeDOMParser {
  parseFromString(str, type) {
    const p = new DOMParser();
    if (type === "text/html" && !/^\s*<(!doctype|html)\b/i.test(str)) {
      return p.parseFromString(`<html><body>${str}</body></html>`, "text/html");
    }
    return p.parseFromString(str, type);
  }
}
globalThis.DOMParser = BrowserLikeDOMParser;
globalThis.document = document;
globalThis.window = window;
globalThis.Node = window.Node;
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.URL.createObjectURL = (blob) => `blob:fake/${blob.size}`;

const { unzip } = await import("../src/sources/epub/unzip.js");
const { parseBook, flattenToc } = await import("../src/sources/epub/opf.js");
const { renderChapter, STYLES, chapterFileName, countWords } = await import("../src/sources/epub/chapter.js");

/* ------------------------------ 跑起来 ------------------------------ */

const buf = await readFile(join(import.meta.dirname, "test.epub"));
const files = await unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

console.log("=== 1. parseBook ===");
const book = parseBook(files);
console.log("  title     :", book.title);
console.log("  author    :", book.author);
console.log("  language  :", book.language);
console.log("  publisher :", book.publisher);
console.log("  opfPath   :", book.opfPath);
console.log("  base      :", JSON.stringify(book.base));
console.log("  spine     :", book.spine.map((s) => s.href).join(", "));
console.log("  manifest  :", book.manifest.size, "项");

assert.equal(book.title, "测试之书 · Test Book", "书名解析错误");
assert.equal(book.author, "某位作者", "作者解析错误");
assert.equal(book.language, "zh-CN");
assert.equal(book.publisher, "Scratchpad Press");
assert.equal(book.opfPath, "OEBPS/content.opf");
assert.equal(book.base, "OEBPS/");
assert.equal(book.spine.length, 3, "spine 数量错误");
assert.deepEqual(
  book.spine.map((s) => s.href),
  ["OEBPS/text/ch1.xhtml", "OEBPS/text/ch2.xhtml", "OEBPS/text/ch2a.xhtml"],
  "spine 顺序或路径解析错误"
);

console.log("\n=== 2. TOC（EPUB3 nav，含嵌套） ===");
const dump = (nodes, d = 0) => nodes.forEach((n) => {
  console.log(`  ${"  ".repeat(d)}- ${n.label}  ->  ${n.href}`);
  if (n.children?.length) dump(n.children, d + 1);
});
dump(book.toc);

assert.equal(book.toc.length, 2, "顶层 TOC 条目数错误");
assert.equal(book.toc[0].label, "第一章 开端");
assert.equal(book.toc[0].href, "OEBPS/text/ch1.xhtml", "nav 里的相对路径未正确解析");
assert.equal(book.toc[1].children.length, 1, "TOC 嵌套未解析");
assert.equal(book.toc[1].children[0].label, "2.1 一个小节");

const flat = flattenToc(book.toc);
assert.equal(flat.get("OEBPS/text/ch2a.xhtml").depth, 1, "嵌套层级 depth 错误");
console.log("  flattenToc:", flat.size, "项，depth 正确");

console.log("\n=== 3. renderChapter（markdown 视图） ===");
const style = STYLES[0];
const ch1 = book.spine[0];
const blobCalls = [];
const { rows, words, plain } = renderChapter({
  bytes: files.get(ch1.href),
  href: ch1.href,
  title: "第一章 开端",
  bookTitle: book.title,
  author: book.author,
  style,
  blobUrlFor: (p) => {
    blobCalls.push(p);
    return files.has(p) ? `blob:fake/${p}` : "";
  },
});

rows.forEach((r, i) => {
  const img = r.images?.length ? `   [img x${r.images.length}]` : "";
  console.log(`  ${String(i + 1).padStart(2)} │ ${r.type.padEnd(7)} │ ${r.text}${img}`);
});
console.log(`  -> words=${words}`);

assert.ok(rows.length > 8, "渲染行数过少，正文可能丢了");
assert.ok(rows.some((r) => r.text.includes("测试之书")), "文件头缺书名");
assert.ok(rows.some((r) => r.text.includes("某位作者")), "文件头缺作者");

// HTML 实体必须已解码（&amp; -> &），不能是 &amp; 残留
const allText = rows.map((r) => r.text).join("\n");
assert.ok(allText.includes("包含 & 实体"), "HTML 实体未解码");
assert.ok(!allText.includes("&amp;"), "HTML 实体被二次转义");

// <br/> 必须变成独立的一行，而不是被压成空格
assert.ok(allText.includes("一个换行"), "br 后的文本丢失");

// <pre><code> 必须变成代码栅栏行
const fenceRows = rows.filter((r) => r.fence);
console.log(`  代码栅栏行: ${fenceRows.length} 行`);
assert.ok(fenceRows.some((r) => r.text.includes("const answer = 42;")), "代码块内容丢失");

// 插图：../images/fig1.png 要解析到 zip 内真实路径并拿到 blob
console.log("  blobUrlFor 被调用:", blobCalls);
assert.ok(blobCalls.includes("OEBPS/images/fig1.png"), "章节内相对图片路径未正确解析");
const imgRows = rows.filter((r) => r.images?.length);
assert.ok(imgRows.length > 0, "图片没有变成 emoji 行");
console.log("  图片 emoji:", imgRows[0].images.map((i) => `${i.emoji} ${i.src}`).join(", "));

// 字数统计（中英混合）
assert.ok(words > 20, `字数统计异常: ${words}`);
assert.equal(countWords("中文三字 two words"), 4 + 2, "中英混合字数统计错误");

console.log("\n=== 3b. 正文一段都不能丢 ===");
// commentWrap 对短文本有概率走 inline 分支（lines 为空），
// 若不处理会把整段正文丢掉。用大量短段落把这条路径压出来。
{
  const shortParas = Array.from({ length: 60 }, (_, i) => `短段落${i + 1}号`);
  const html = `<html><body>${shortParas.map((t) => `<p>${t}</p>`).join("")}</body></html>`;
  const bytes = new TextEncoder().encode(html);

  for (const st of STYLES) {
    const out = renderChapter({
      bytes, href: `short-${st.id}.xhtml`, title: "短段", bookTitle: "书", author: "人",
      style: st, blobUrlFor: () => "", wrapCols: 88, density: "off",
    });
    const all = out.rows.map((r) => r.text).join("\n");
    const missing = shortParas.filter((t) => !all.includes(t));
    console.log(`  ${st.label.padEnd(11)} ${out.rows.length} 行，丢失 ${missing.length} 段`);
    assert.equal(missing.length, 0, `${st.label} 丢了 ${missing.length} 段正文: ${missing.slice(0, 3).join(", ")}`);
    // 段落锚点也要覆盖全部段落
    const paras = new Set(out.rows.filter((r) => r.para != null).map((r) => r.para));
    assert.equal(paras.size, shortParas.length, `${st.label} 段落锚点数 ${paras.size} != 段落数 ${shortParas.length}`);
  }
  console.log("  ✓ 六种风格下 60 个短段落全部保留，锚点齐全");
}

console.log("\n=== 4. 六种渲染风格都能跑通 ===");
for (const s of STYLES) {
  const out = renderChapter({
    bytes: files.get(ch1.href),
    href: ch1.href,
    title: "第一章 开端",
    bookTitle: book.title,
    author: book.author,
    style: s,
    blobUrlFor: () => "blob:fake/x",
  });
  const fname = chapterFileName("第一章 开端", 0, s.ext);
  console.log(`  ${s.label.padEnd(11)} ${String(out.rows.length).padStart(3)} 行  ${fname}`);
  assert.ok(out.rows.length > 5, `${s.label} 渲染结果过短`);
  assert.ok(fname.endsWith(`.${s.ext}`), `${s.label} 文件名扩展名错误`);
}

console.log("\n=== 5. 纯中文标题的文件名（不能是空 slug） ===");
for (const t of ["第一章 开端", "序", "Chapter One", "2.1 一个小节"]) {
  const f = chapterFileName(t, 0, "md");
  console.log(`  ${t.padEnd(14)} -> ${f}`);
  assert.ok(/^\d\d-[a-z0-9_]+\.md$/.test(f), `文件名不合法: ${f}`);
}

console.log("\n✓ 解析 + 渲染全链路测试通过");
