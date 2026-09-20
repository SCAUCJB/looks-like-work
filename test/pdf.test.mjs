/**
 * PDF 数据源测试。
 *
 * 不在 Node 里跑真的 pdf.js：它的 web 构建带了大量浏览器专用代码
 * （annotation editor、touch manager 等），在 linkedom 下起不来。
 * 第三方库放到真浏览器里验证，这里用 mock 把 pdf.js 的接口顶掉，
 * 测我们自己的那层：文本提取、目录切分、扫描版判定、接入通用数据源。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";
import "fake-indexeddb/auto";

const { document, window } = parseHTML("<html><head></head><body><div id='library'></div></body></html>");
class P2 {
  parseFromString(str, type) {
    const p = new DOMParser();
    return (type === "text/html" && !/^\s*<(!doctype|html)\b/i.test(str))
      ? p.parseFromString(`<html><body>${str}</body></html>`, "text/html")
      : p.parseFromString(str, type);
  }
}
globalThis.DOMParser = P2;
globalThis.document = document;
globalThis.window = window;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.URL.createObjectURL = (b) => `blob:fake/${b?.size ?? 0}`;
for (const [p, v] of [["offsetHeight", 18], ["offsetTop", 0], ["clientHeight", 400], ["clientWidth", 1000], ["scrollHeight", 900]]) {
  Object.defineProperty(window.Element.prototype, p, { get() { return v; }, configurable: true });
}
Object.defineProperty(window.Element.prototype, "scrollTop", { get() { return 0; }, set() {}, configurable: true });
Object.defineProperty(window.Element.prototype, "scrollLeft", { get() { return 0; }, set() {}, configurable: true });
window.Element.prototype.scrollTo = function () {};
window.Element.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 30, width: 60, height: 26 });
window.Element.prototype.focus = function () {};

/* ------------------------- mock pdf.js ------------------------- */

const item = (str, x, y, size = 12) => ({
  str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size,
});

/** 每页的文本片段 */
const PAGES = [
  [ // p1
    item("Chapter One", 72, 760, 16),
    item("This is the first paragraph. It runs", 72, 720),
    item("across two lines to test joining.", 72, 706),
    item("A second paragraph after a bigger gap.", 72, 672),
    item("- 1 -", 300, 40, 9),
  ],
  [ // p2
    item("It continues onto the second page.", 72, 720),
    item("Another paragraph with a hyphen-", 72, 686),
    item("ated word across lines.", 72, 672),
    item("- 2 -", 300, 40, 9),
  ],
  [ // p3
    item("Chapter Two", 72, 760, 16),
    item("The second chapter begins here.", 72, 720),
    item("And this is its second line.", 72, 706),
    item("- 3 -", 300, 40, 9),
  ],
];

function installMock({ pages = PAGES, outline = null } = {}) {
  globalThis.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getMetadata: async () => ({ info: { Title: "Mock 书", Author: "某人" } }),
        getPage: async (n) => ({
          getTextContent: async () => ({ items: pages[n - 1] }),
          cleanup() {},
        }),
        getOutline: async () => outline,
        getDestination: async (name) => ({ ch1: [{ num: 10 }], ch2: [{ num: 12 }] }[name] || null),
        getPageIndex: async (ref) => ({ 10: 0, 12: 2 }[ref.num] ?? 0),
      }),
    }),
  };
  globalThis.__pdfWorkerSrc = "";
}

const OUTLINE = [
  { title: "Chapter One", dest: "ch1" },
  { title: "Chapter Two", dest: "ch2" },
];

/* ------------------------------ 测试 ------------------------------ */

const { loadPdf, pdfAvailable } = await import("../src/sources/pdf/load.js");
const { createPdfAdapter } = await import("../src/sources/pdf/adapter.js");
const { createBookSource } = await import("../src/sources/epub/source.js");
const { createShell } = await import("../src/shell/shell.js");

console.log("=== 1. 没打包 pdf.js 时要明确报错 ===");
{
  delete globalThis.pdfjsLib;
  assert.equal(pdfAvailable(), false, "没有 pdfjsLib 时应返回 false");
  let msg = "";
  await loadPdf(new ArrayBuffer(8)).catch((e) => { msg = e.message; });
  console.log("  错误:", msg);
  assert.ok(msg.includes("reader-vscode.html"), "错误信息没指引用户换哪个版本");
}

console.log("\n=== 2. 解析 + 目录来自 outline ===");
installMock({ outline: OUTLINE });
assert.ok(pdfAvailable(), "mock 装上后应可用");
const steps = [];
const book = await loadPdf(new ArrayBuffer(8), (m) => steps.push(m));
console.log("  进度:", steps.join(" -> "));
console.log(`  《${book.title}》 ${book.author} | ${book.pages} 页 | 文本层 ${book.hasText}`);
book.chapters.forEach((c) => console.log(`  [p${c.page}] ${c.title} — ${c.paras.length} 段`));
assert.equal(book.title, "Mock 书");
assert.equal(book.pages, 3);
assert.ok(book.hasText, "应识别出有文本层");
assert.ok(book.chapters.some((c) => c.title === "Chapter One"), "outline 没解析出来");
assert.ok(book.chapters.some((c) => c.title === "Chapter Two"), "第二章没解析出来");
assert.ok(steps.length >= 2, "没有进度提示");

console.log("\n=== 3. 段落重建 ===");
const all = book.chapters.flatMap((c) => c.paras.map((p) => p.text));
all.forEach((t, i) => console.log(`  [${i}] ${t}`));
const joined = all.join("\n");
assert.ok(joined.includes("It runs across two lines"), "同段跨行没拼起来");
assert.ok(joined.includes("It continues onto the second page"), "跨页内容丢了");
assert.ok(joined.includes("hyphenated word"), "连字符换行没合并");
assert.ok(all.length >= 4, `分段过少(${all.length})`);
// 标题字号和正文不同，必须独立成段，不能粘在正文前面
assert.ok(
  all.some((t) => t.trim() === "Chapter One"),
  `标题没有独立成段（字号变化应触发分段）: ${JSON.stringify(all[0])}`
);
// 行距明显变大的地方必须断开
assert.ok(
  all.some((t) => t.startsWith("A second paragraph")),
  "行距变大处没有分段 —— 正文行距基准可能被段间距抬高了"
);
// 同段的两行不能被误拆
assert.ok(
  all.some((t) => t.includes("It runs across two lines to test joining")),
  "同段跨行被误拆了"
);
console.log("  ✓ 跨行 / 跨页 / 连字符 / 标题独立 / 行距分段");

console.log("\n=== 4. 没有 outline 时按页分组 ===");
{
  installMock({ outline: null });
  const b2 = await loadPdf(new ArrayBuffer(8));
  console.log("  章节:", b2.chapters.map((c) => c.title).join(", "));
  assert.ok(b2.chapters.length > 0, "没有 outline 就切不出章节了");
  assert.ok(/第 \d+–\d+ 页/.test(b2.chapters[0].title), "回退方案应按页命名");
}

console.log("\n=== 5. 扫描版识别 ===");
{
  // 每页只有零星几个字符（扫描版常见：只有页码之类）
  const scanned = [[item("1", 300, 40, 9)], [item("2", 300, 40, 9)], [item("3", 300, 40, 9)]];
  installMock({ pages: scanned, outline: null });
  const b3 = await loadPdf(new ArrayBuffer(8));
  console.log(`  文本层: ${b3.hasText}（平均每页字符数极少）`);
  assert.equal(b3.hasText, false, "扫描版应被识别出来");
}

console.log("\n=== 6. 接进通用数据源，功能自动复用 ===");
installMock({ outline: OUTLINE });
const book2 = await loadPdf(new ArrayBuffer(8));
const source = createBookSource({
  adapter: createPdfAdapter(book2),
  size: 12345,
  onOpenLibrary: () => {},
});
const shell = createShell(source).mount();

assert.equal(source.workspaceName(), "Mock 书");
assert.ok(document.querySelectorAll(".vsc-tree-row").length > 0, "文件树是空的");

await shell.openFile(book2.chapters[0].id);
const ed = document.querySelector(".vsc-editor");
const lines = ed.querySelectorAll(".vsc-line");
console.log("  行数:", lines.length, "| 行号:", ed.querySelectorAll(".vsc-gutter div").length);
assert.equal(lines.length, ed.querySelectorAll(".vsc-gutter div").length, "行号不匹配");
assert.ok(ed.innerHTML.includes("vsc-cm"), "正文没走注释着色");
assert.ok(ed.querySelectorAll(".vsc-line[data-para]").length > 0, "缺段落锚点");
console.log("  面包屑:", document.querySelector(".vsc-crumb").textContent.trim());

const usage = source.usageStats();
console.log("  额度:", usage.map((u) => `${u.window} ${u.pct}% ${u.right}`).join(" | "));
assert.equal(usage.length, 2);

shell.setAgentSpeed("instant");
shell.setAgentOpen(true);
const script = source.agentScript();
console.log("  Agent 步数:", script.steps.length);
assert.ok(script.steps.length > 0 && script.steps.every((s) => s.para != null), "Agent 脚本不对");

console.log("  菜单:", source.menus().map((m) => m.label).join("/"));
assert.ok(source.menus().length >= 5, "菜单不全");

shell.state.activity = "search";
const input = document.querySelector(".vsc-side-search");
input.value = "chapter";
input.dispatchEvent(new window.Event("input"));
shell.renderSidebar();
assert.ok(/results/.test(document.querySelector(".vsc-tree").textContent), "全书检索没结果");
console.log("  ✓ 树 / 渲染 / 额度 / Agent / 菜单 / 检索全部复用");

console.log("\n=== 7. PDF 没有图片，blobUrlFor 恒空 ===");
{
  const ad = createPdfAdapter(book2);
  assert.equal(ad.blobUrlFor("whatever"), "", "PDF 不该产出图片 URL");
  assert.equal(ad.coverUrl(), "", "PDF 没有封面");
  assert.ok(ad.info().some((l) => l.startsWith("pages:")), "诊断信息缺页数");
  console.log("  info:", ad.info().join(" | "));
}

console.log("\n✓ PDF 数据源测试通过");
