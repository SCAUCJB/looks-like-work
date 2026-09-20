/**
 * UI 层端到端测试：createEpubSource + createShell().mount()
 *
 * 真跑外壳挂载、文件树渲染、章节打开、面板渲染、命令面板、TERMINAL 命令、
 * 全书检索、IndexedDB 进度与书签。
 *
 * DOM 用 linkedom，IndexedDB 用 fake-indexeddb（都是 devDependency，不进产物）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";
import "fake-indexeddb/auto";

/* ------------------------- 浏览器环境桩 ------------------------- */

const { document, window } = parseHTML(
  "<html><head></head><body><div id='library'></div></body></html>"
);

/** linkedom 不做 HTML 隐式 body 补全，包一层还原浏览器语义 */
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
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = (el) => ({
  getPropertyValue: (name) => document.documentElement.style.getPropertyValue(name) || "",
});
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.URL.createObjectURL = (blob) => `blob:fake/${blob?.size ?? 0}`;
// 拖拽/尺寸相关：linkedom 没有布局，给出可预测的假值
// linkedom 没有布局引擎，这里给出可预测的假尺寸：
// 测量探针（100 个字符）返回 700px => 单字符 7px，编辑器 clientWidth 假定 1000px，
// 于是 measureCols() 应得 floor((1000 - 56 - 20 - 2) / 7) = 131 列。
// 等宽字体里字符宽度约为字号的 0.6 倍，字号变字宽就变，auto 列数要跟着变
const CHAR_W_RATIO = 0.6;
let FAKE_CHAR_W = 13 * CHAR_W_RATIO;
const FAKE_EDITOR_W = 1000;
/** 模拟浏览器：字号变了，探针量出来的字宽也变 */
function syncFakeCharW() {
  const px = parseFloat(
    document.documentElement.style.getPropertyValue("--vsc-code-size")
  ) || 13;
  FAKE_CHAR_W = px * CHAR_W_RATIO;
  return px;
}
// 注意：linkedom 自带一个恒返回 0 的 getBoundingClientRect，必须无条件覆盖
window.Element.prototype.getBoundingClientRect = function () {
  if (this.classList?.contains("vsc-measure")) {
    syncFakeCharW();
    const n = (this.textContent || "").length;
    return { top: 0, left: 0, right: n * FAKE_CHAR_W, bottom: 0, width: n * FAKE_CHAR_W, height: 18 };
  }
  return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 180 };
};
// linkedom 没有 clientWidth，补一个假值让 measureCols 走得通
Object.defineProperty(window.Element.prototype, "clientWidth", {
  get() { return this.classList?.contains("vsc-editor") ? FAKE_EDITOR_W : 0; },
  configurable: true,
});

/* 阅读位置需要布局信息，linkedom 一概没有，这里造一套确定的假布局：
   每个 .vsc-line 高 ROW_H，按 DOM 顺序累加 offsetTop；编辑器视口高 VIEW_H。 */
const ROW_H = 18;
const VIEW_H = 400;
Object.defineProperty(window.Element.prototype, "offsetHeight", {
  get() { return this.classList?.contains("vsc-line") ? ROW_H : 0; },
  configurable: true,
});
Object.defineProperty(window.Element.prototype, "offsetTop", {
  get() {
    if (!this.classList?.contains("vsc-line")) return 0;
    const all = [...(this.parentElement?.children || [])];
    return all.indexOf(this) * ROW_H;
  },
  configurable: true,
});
Object.defineProperty(window.Element.prototype, "clientHeight", {
  get() { return this.classList?.contains("vsc-editor") ? VIEW_H : 0; },
  configurable: true,
});
Object.defineProperty(window.Element.prototype, "scrollHeight", {
  get() {
    if (!this.classList?.contains("vsc-editor")) return 0;
    return this.querySelectorAll(".vsc-line").length * ROW_H;
  },
  configurable: true,
});
// scrollTop 要可读可写
Object.defineProperty(window.Element.prototype, "scrollTop", {
  get() { return this.__scrollTop || 0; },
  set(v) { this.__scrollTop = Math.max(0, v); },
  configurable: true,
});
// linkedom 的 scrollTo 是空实现，平滑滚动（Agent 推进走这条路）在测试里就不会改 scrollTop
window.Element.prototype.scrollTo = function (opts) {
  if (opts && typeof opts === "object") this.scrollTop = opts.top ?? this.scrollTop;
};
Object.defineProperty(window.Element.prototype, "scrollLeft", {
  get() { return this.__scrollLeft || 0; },
  set(v) { this.__scrollLeft = v; },
  configurable: true,
});
if (!window.Element.prototype.setPointerCapture) {
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
}

const { unzip } = await import("../src/sources/epub/unzip.js");
const { createEpubSource } = await import("../src/sources/epub/source.js");
const { createShell } = await import("../src/shell/shell.js");
const { buildCss, injectStyle } = await import("../src/shell/style.js");
const { getState } = await import("../src/sources/epub/store.js");

/* ------------------------------ 准备 ------------------------------ */

const buf = await readFile(join(import.meta.dirname, "test.epub"));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const files = await unzip(ab);

console.log("=== 1. CSS 注入 ===");
const shellMod = await import("../src/shell/shell.js");
injectStyle("vsc-test", buildCss({
  ROOT_CLASS: "vsc-theme",
  storedPanelH: () => "",
  sideWidth: () => "260px",
  codeSize: shellMod.codeSize,
  codeLine: shellMod.codeLine,
  gutterW: shellMod.gutterW,
  hostTakeover: false,
}));
const styleEl = document.getElementById("vsc-test");
assert.ok(styleEl, "<style> 未注入");
const css = styleEl.textContent;
console.log(`  CSS ${css.length} 字节`);
assert.ok(css.includes("--vsc-panel-h: clamp(180px, 34vh, 460px)"), "面板高度默认值缺失");
assert.ok(css.includes("--vsc-side-w: 260px"), "侧边栏宽度未注入");
assert.ok(!css.includes("#Wrapper"), "hostTakeover=false 时仍注入了 V2EX 宿主接管 CSS");
assert.ok(!css.includes("${"), "CSS 里有未求值的模板占位符");
assert.ok(css.includes("--vsc-code-size:"), "字号变量没进 CSS");
assert.ok(css.includes("--vsc-gutter-w:"), "行号列宽变量没进 CSS");
// 漏传取值函数时要能回落默认值，而不是抛异常把整个样式表搞没
const minimalCss = buildCss({ ROOT_CLASS: "vsc-theme", storedPanelH: () => "", sideWidth: () => "260px" });
assert.ok(minimalCss.includes("--vsc-code-size: 13px"), "漏传 codeSize 时没有回落默认值");
console.log("  ✓ 漏传字号函数时回落默认值，不会崩");
console.log("  ✓ hostTakeover=false 时不含 V2EX 宿主规则");

console.log("\n=== 2. createEpubSource ===");
let libraryOpened = 0;
const source = createEpubSource({
  files,
  size: buf.length,
  onOpenLibrary: () => { libraryOpened += 1; },
});
console.log("  workspaceName:", source.workspaceName());
assert.equal(source.workspaceName(), "测试之书 · Test Book");

const tree = source.tree();
const dumpTree = (nodes, d = 0) => nodes.forEach((n) => {
  console.log(`  ${"  ".repeat(d)}${n.kind === "folder" ? "📁" : "📄"} ${n.label}${n.meta ? `  (${n.meta})` : ""}`);
  if (n.children) dumpTree(n.children, d + 1);
});
dumpTree(tree);

assert.equal(tree[0].kind, "folder", "根节点应是书名文件夹");
assert.equal(tree[0].label, "测试之书 · Test Book");
// TOC 第二章有子节，必须渲染成可折叠文件夹
const ch2Folder = tree[0].children.find((n) => n.kind === "folder" && n.label === "第二章 展开");
assert.ok(ch2Folder, "TOC 嵌套没有变成文件夹");
assert.ok(ch2Folder.children.length >= 2, "文件夹里应同时有自身章节和子章节");
console.log("  ✓ TOC 嵌套 -> 文件夹树");

console.log("\n=== 3. mount 外壳 ===");
const shell = createShell(source).mount();
const app = document.querySelector(".vsc-app");
assert.ok(app, ".vsc-app 未挂载");
for (const sel of [
  ".vsc-titlebar", ".vsc-activity", ".vsc-sidebar", ".vsc-side-resizer",
  ".vsc-tabs", ".vsc-crumb", ".vsc-editor",
  ".vsc-panel", ".vsc-panel-resizer", ".vsc-panel-tabs", ".vsc-panel-toggle",
  ".vsc-panel-body", ".vsc-reply-form", ".vsc-status", ".vsc-palette",
]) {
  assert.ok(app.querySelector(sel), `缺少节点: ${sel}`);
}
console.log("  ✓ 15 个关键节点齐全");
console.log("  标题栏:", document.querySelector(".vsc-title-center").textContent);
console.log("  树行数:", document.querySelectorAll(".vsc-tree-row").length);
assert.ok(document.querySelectorAll(".vsc-tree-row").length >= 4, "文件树行数过少");

console.log("\n=== 4. 打开章节 ===");
await shell.openFile("OEBPS/text/ch1.xhtml");
const ed = document.querySelector(".vsc-editor");
const lineCount = ed.querySelectorAll(".vsc-line").length;
const gutterCount = ed.querySelectorAll(".vsc-gutter div").length;
console.log("  行数:", lineCount, "| 行号数:", gutterCount);
assert.ok(lineCount > 8, "编辑器行数过少");
assert.equal(lineCount, gutterCount, "行号与代码行数不一致");
console.log("  面包屑:", document.querySelector(".vsc-crumb").textContent.trim());
console.log("  Ln:", document.querySelector(".vsc-ln").textContent);
console.log("  分支:", document.querySelector(".vsc-branch").textContent);
assert.ok(document.querySelector(".vsc-branch").textContent.includes("某位作者"), "状态栏分支未显示作者");

// 注释着色 + 图片 emoji
const html = ed.innerHTML;
assert.ok(html.includes("vsc-cm"), "正文没有走注释着色");
assert.ok(html.includes("vsc-img-emoji"), "插图没有渲染成 emoji");
assert.ok(html.includes("data-src=\"blob:fake/"), "插图没有拿到 blob URL");
assert.ok(html.includes("vsc-fence"), "代码块没有栅栏样式");
console.log("  ✓ 注释着色 / 图片 emoji / 代码栅栏都在");

// tab
const tabs = document.querySelectorAll(".vsc-tab");
console.log("  tab 数:", tabs.length, "| 标题:", tabs[0]?.textContent.trim());
assert.equal(tabs.length, 1, "应该只有一个 tab");

console.log("\n=== 5. 进度写入 IndexedDB ===");
await new Promise((r) => setTimeout(r, 50));
const st = await getState(`测试之书-·-Test-Book@${buf.length}`);
console.log("  chapterHref:", st.chapterHref);
assert.equal(st.chapterHref, "OEBPS/text/ch1.xhtml", "阅读进度未落库");
console.log("  进度显示:", document.querySelector(".vsc-progress").textContent);
assert.ok(/\d+%/.test(document.querySelector(".vsc-progress").textContent), "状态栏没有进度百分比");

console.log("\n=== 6. 三个面板 ===");
for (const p of ["problems", "output", "terminal"]) {
  shell.state.panel = p;
  shell.renderPanel();
  const body = document.querySelector(".vsc-panel-body").textContent.trim();
  console.log(`  [${p.toUpperCase()}] ${body.split("\n")[0].slice(0, 70)}`);
  assert.ok(body.length > 0, `${p} 面板为空`);
}
assert.ok(
  document.querySelector(".vsc-panel-body").textContent.includes("01-ch_"),
  "TERMINAL 没有列出章节"
);

console.log("\n=== 7. 面板折叠 ===");
shell.togglePanel();
assert.ok(app.classList.contains("panel-off"), "折叠后缺少 panel-off class");
assert.equal(document.querySelector(".vsc-panel-toggle").textContent, "⌃");
shell.togglePanel();
assert.ok(!app.classList.contains("panel-off"), "展开后 panel-off 未移除");
assert.equal(document.querySelector(".vsc-panel-toggle").textContent, "⌄");
console.log("  ✓ 折叠 / 展开 + 按钮图标翻转");

console.log("\n=== 8. 命令面板 ===");
shell.openPalette("");
const palRows = document.querySelectorAll(".vsc-palette-row");
console.log("  条目数:", palRows.length);
assert.ok(palRows.length >= 3, "命令面板条目过少");
console.log("  前三条:", [...palRows].slice(0, 3).map((r) => r.textContent.trim().split("\n")[0]).join(" | "));
const cmds = source.commands();
const libCmd = cmds.find((c) => c.label.includes("打开书库"));
assert.ok(libCmd, "缺少「打开书库」命令");
libCmd.run();
assert.equal(libraryOpened, 1, "打开书库回调未触发");
console.log("  ✓ 命令可执行（onOpenLibrary 被调用）");

console.log("\n=== 9. TERMINAL 命令 ===");
source.commandLine.submit("mark 这里很关键");
await new Promise((r) => setTimeout(r, 50));
const st2 = await getState(`测试之书-·-Test-Book@${buf.length}`);
console.log("  书签数:", st2.bookmarks.length, "| 备注:", st2.bookmarks[0]?.note);
assert.equal(st2.bookmarks.length, 1, "mark 命令没有写入书签");
assert.equal(st2.bookmarks[0].note, "这里很关键");

source.commandLine.submit("note 随手记一条");
shell.state.panel = "terminal";
shell.renderPanel();
assert.ok(document.querySelector(".vsc-panel-body").textContent.includes("随手记一条"), "note 未显示");

source.commandLine.submit("view python");
assert.equal(globalThis.localStorage.getItem("epub-vsc-style"), "python", "view 命令未切换风格");
console.log("  ✓ mark / note / view 都生效");

// 切风格后文件名扩展名要跟着变
shell.renderSidebar();
assert.ok(
  document.querySelector(".vsc-tree").innerHTML.includes(".py"),
  "切到 python 后文件树扩展名未更新"
);
source.commandLine.submit("view md");

console.log("\n=== 10. 全书检索 ===");
shell.state.activity = "search";
const searchView = () => {
  shell.renderSidebar();
  return document.querySelector(".vsc-tree").textContent;
};
// 通过 source 内部的 search（由侧栏输入驱动），这里直接触发 input 事件
const input = document.querySelector(".vsc-side-search");
input.value = "第二章";
input.dispatchEvent(new window.Event("input"));
const hits = searchView();
console.log("  搜「第二章」:", hits.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3).join(" / "));
assert.ok(hits.includes("results"), "检索没有返回结果计数");

input.value = "不存在的词xyz";
input.dispatchEvent(new window.Event("input"));
assert.ok(searchView().includes("No results"), "无结果时未提示");
console.log("  ✓ 命中与无结果两种情况都正确");

console.log("\n=== 11. 其它活动栏视图 ===");
for (const act of ["scm", "debug", "ext"]) {
  shell.state.activity = act;
  shell.renderSidebar();
  const head = document.querySelector(".vsc-side-head span").textContent;
  const rows = document.querySelectorAll(".vsc-tree-row").length;
  console.log(`  ${act.padEnd(6)} -> ${head.padEnd(15)} ${rows} 行`);
  assert.ok(rows > 0, `${act} 视图为空`);
}

console.log("\n✓ UI 层全链路测试通过");

console.log("\n=== 12. 长行折行 ===");
const { currentWrap } = await import("../src/sources/epub/source.js");
const { strWidth } = await import("../src/shell/wrap.js");

// 造一个超长段落的章节，验证渲染出来没有超宽行
const longPara = "这是一段刻意写得很长的中文正文用来验证折行是否生效".repeat(12);
const fakeChapter = new TextEncoder().encode(
  `<html><body><h1>长章</h1><p>${longPara}</p></body></html>`
);
const { renderChapter: rc, DEFAULT_WRAP } = await import("../src/sources/epub/chapter.js");
console.log("  默认宽度:", DEFAULT_WRAP, "列 | 当前设置:", currentWrap(), "列");

for (const cols of [64, 88, 120]) {
  const out = rc({
    bytes: fakeChapter,
    href: "x.xhtml",
    title: "长章",
    bookTitle: "书",
    author: "人",
    style: { id: "markdown", label: "Markdown", ext: "md", cstyle: "hash" },
    blobUrlFor: () => "",
    wrapCols: cols,
  });
  const widest = Math.max(...out.rows.map((r) => strWidth(r.text)));
  console.log(`  wrap=${String(cols).padStart(3)} -> ${String(out.rows.length).padStart(3)} 行，最宽 ${widest} 列`);
  assert.ok(widest <= cols, `wrap=${cols} 时出现 ${widest} 列的超宽行`);
  assert.ok(out.rows.length > 10, "折行后行数反而没增加");
}
// 窄宽度必须产出比宽宽度更多的行
const narrow = rc({ bytes: fakeChapter, href: "x.xhtml", title: "长章", bookTitle: "书", author: "人",
  style: { id: "markdown", ext: "md", cstyle: "hash" }, blobUrlFor: () => "", wrapCols: 48 });
const wide = rc({ bytes: fakeChapter, href: "x.xhtml", title: "长章", bookTitle: "书", author: "人",
  style: { id: "markdown", ext: "md", cstyle: "hash" }, blobUrlFor: () => "", wrapCols: 140 });
assert.ok(narrow.rows.length > wide.rows.length, "宽度变窄行数没有变多");
console.log(`  ✓ 48 列 ${narrow.rows.length} 行 > 140 列 ${wide.rows.length} 行`);

// 通过 wrap 命令改宽度，应清掉 tab 缓存并重渲染
source.commandLine.submit("wrap 64");
await new Promise((r) => setTimeout(r, 30));
assert.equal(currentWrap(), 64, "wrap 命令未生效");
const edRows = [...document.querySelectorAll(".vsc-line")].map((n) => n.textContent);
const widestOnScreen = Math.max(...edRows.map((t) => strWidth(t)));
console.log("  编辑器实际最宽行:", widestOnScreen, "列");
assert.ok(widestOnScreen <= 64, `编辑器里仍有 ${widestOnScreen} 列的超宽行`);
// 越界值要被夹住
source.commandLine.submit("wrap 5");
assert.equal(currentWrap(), 40, "过小的宽度未被夹到 WRAP_MIN");
source.commandLine.submit("wrap 9999");
assert.equal(currentWrap(), 200, "过大的宽度未被夹到 WRAP_MAX");
source.commandLine.submit("wrap 88");
console.log("  ✓ wrap 命令生效且越界值被夹住");

console.log("\n=== 12b. 自动宽度（撑满编辑器）===");
const { currentWrapSetting } = await import("../src/sources/epub/source.js");

const measured = shell.measureCols();
const gutterNow = parseFloat(document.documentElement.style.getPropertyValue("--vsc-gutter-w")) || 56;
const expected = Math.floor((FAKE_EDITOR_W - gutterNow - 20 - 2) / FAKE_CHAR_W);
console.log(`  measureCols() = ${measured}（预期 ${expected}）`);
assert.equal(measured, expected, "列数测量算错了（gutter/padding 没扣对）");

source.commandLine.submit("wrap auto");
await new Promise((r) => setTimeout(r, 40));
assert.equal(currentWrapSetting(), "auto", "wrap auto 未生效");

await shell.openFile("OEBPS/text/ch1.xhtml");
const autoRows = [...document.querySelectorAll(".vsc-line")].map((n) => n.textContent);
const widestAuto = Math.max(...autoRows.map((t) => strWidth(t)));
console.log(`  auto 模式下最宽行 ${widestAuto} 列，上限 ${measured} 列`);
assert.ok(widestAuto <= measured, `auto 模式下出现 ${widestAuto} 列的超宽行，会触发横向滚动`);
// auto 量出来的 131 列，应该比原来的固定 88 列宽得多
assert.ok(measured > 88, "auto 没有比默认 88 列更宽，白做了");
console.log("  ✓ 自动宽度生效且不超出编辑器");

// 切回固定值再切回来，设置要能正确区分
source.commandLine.submit("wrap 72");
assert.equal(currentWrapSetting(), 72, "固定宽度未生效");
source.commandLine.submit("wrap auto");
assert.equal(currentWrapSetting(), "auto", "切回 auto 失败");
console.log("  ✓ auto / 固定值可来回切换");

// EXTENSIONS 侧栏应有 auto 选项
shell.state.activity = "ext";
shell.renderSidebar();
const autoRow = document.querySelector(".vsc-tree [data-action='wrap'][data-wrap='auto']");
assert.ok(autoRow, "EXTENSIONS 里没有 auto 选项");
console.log("  侧栏 auto 行:", autoRow.textContent.replace(/\s+/g, " ").trim());
shell.state.activity = "explorer";

console.log("\n=== 12c. 字号 ===");
const { FONT_SIZES, DEFAULT_FONT, codeSize } = await import("../src/shell/shell.js");

const root = document.documentElement;
const readVars = () => ({
  size: parseFloat(root.style.getPropertyValue("--vsc-code-size")),
  line: parseFloat(root.style.getPropertyValue("--vsc-code-line")),
  gutter: parseFloat(root.style.getPropertyValue("--vsc-gutter-w")),
});

console.log("  档位:", FONT_SIZES.join(", "), "| 默认", DEFAULT_FONT);
for (const px of FONT_SIZES) {
  shell.setFontSize(px);
  const v = readVars();
  console.log(`  ${String(px).padStart(2)}px -> line ${v.line}px, gutter ${v.gutter}px`);
  assert.equal(v.size, px, "字号变量没设上");
  assert.equal(codeSize(), px, "codeSize() 没跟上");
  // 行高必须是整数：小数行高会逐行累积误差，几百行后行号就和代码错开
  assert.ok(Number.isInteger(v.line), `行高不是整数: ${v.line}`);
  assert.ok(v.line > px, "行高必须大于字号");
  assert.ok(v.gutter >= 36, "行号列太窄");
  // 大字号要放得下 4 位行号
  assert.ok(v.gutter >= px * 2.4, `字号 ${px}px 时行号列 ${v.gutter}px 可能放不下 4 位行号`);
}
console.log("  ✓ 三个变量联动，行高均为整数");

// 越界夹取
shell.setFontSize(2);
assert.equal(codeSize(), FONT_SIZES[0], "过小字号未夹到最小档");
shell.setFontSize(999);
assert.equal(codeSize(), FONT_SIZES[FONT_SIZES.length - 1], "过大字号未夹到最大档");
shell.setFontSize("不是数字");
assert.equal(codeSize(), FONT_SIZES[FONT_SIZES.length - 1], "非法值不该改变字号");
console.log("  ✓ 越界与非法值处理正确");

// 逐档增减
shell.setFontSize(13);
shell.stepFontSize(1);
assert.equal(codeSize(), 14, "加一档不对");
shell.stepFontSize(-1);
assert.equal(codeSize(), 13, "减一档不对");
shell.stepFontSize(-99);
assert.equal(codeSize(), FONT_SIZES[0], "连减应停在最小档");
shell.stepFontSize(99);
assert.equal(codeSize(), FONT_SIZES[FONT_SIZES.length - 1], "连加应停在最大档");
console.log("  ✓ 逐档增减且不越界");

// 行号与代码行必须一一对应（字号改动最容易坏的地方）
for (const px of [11, 13, 20, 24]) {
  shell.setFontSize(px);
  await shell.openFile("OEBPS/text/ch1.xhtml");
  const ed2 = document.querySelector(".vsc-editor");
  const nLines = ed2.querySelectorAll(".vsc-line").length;
  const nGutter = ed2.querySelectorAll(".vsc-gutter div").length;
  assert.equal(nLines, nGutter, `${px}px 下行号 ${nGutter} 与代码行 ${nLines} 不一致`);
  // 行号必须是连续的 1..n
  const nums = [...ed2.querySelectorAll(".vsc-gutter div")].map((d) => Number(d.textContent));
  assert.deepEqual(nums, nums.map((_, i) => i + 1), `${px}px 下行号不连续`);
  console.log(`  ${String(px).padStart(2)}px: ${nLines} 行，行号 1..${nLines} 连续对齐`);
}
console.log("  ✓ 各字号下行号都不错位");

// 字号变化要带动 auto 折行列数变化（字宽变了）
shell.setFontSize(13);
await new Promise((r) => setTimeout(r, 40));
const cols13 = shell.measureCols();
shell.setFontSize(24);
await new Promise((r) => setTimeout(r, 40));
const cols24 = shell.measureCols();
console.log(`  13px -> ${cols13} 列，24px -> ${cols24} 列`);
assert.ok(cols24 < cols13, "字号变大后每行列数应变少");
shell.setFontSize(DEFAULT_FONT);

// EXTENSIONS 侧栏应列出所有档位
shell.state.activity = "ext";
shell.renderSidebar();
const fontRows = document.querySelectorAll(".vsc-tree [data-action='font']");
console.log("  EXTENSIONS 里的字号档位数:", fontRows.length);
assert.equal(fontRows.length, FONT_SIZES.length, "字号档位没全列出来");

// font 命令
source.commandLine.submit("font 18");
assert.equal(codeSize(), 18, "font 命令未生效");
source.commandLine.submit("size 14");
assert.equal(codeSize(), 14, "size 别名未生效");
source.commandLine.submit("font 乱写");
assert.equal(codeSize(), 14, "非法 font 参数不该改变字号");
source.commandLine.submit("font 13");
console.log("  ✓ font / size 命令生效");

// 状态栏 chip
assert.equal(document.querySelector(".vsc-font-chip").textContent, "13px", "状态栏字号显示不对");
console.log("  状态栏显示:", document.querySelector(".vsc-font-chip").textContent);
shell.state.activity = "explorer";

console.log("\n=== 12d. 阅读位置记忆 ===");

// 用多段落章节，位置才有意义
const posBytes = new TextEncoder().encode(
  `<html><body><h1>位置章</h1>${Array.from({ length: 30 },
    (_, i) => `<p>第 ${i + 1} 段的内容，用来验证阅读位置记忆。</p>`).join("")}</body></html>`
);
const posFiles = new Map(files);
posFiles.set("OEBPS/text/pos.xhtml", posBytes);

// 正文行必须带 data-para，且序号连续
await shell.openFile("OEBPS/text/ch1.xhtml");
const edP = document.querySelector(".vsc-editor");
const paraRows = edP.querySelectorAll(".vsc-line[data-para]");
const paraNums = [...new Set([...paraRows].map((r) => Number(r.dataset.para)))].sort((a, b) => a - b);
console.log(`  正文行 ${paraRows.length} 行，覆盖段落 ${paraNums.join(",")}`);
assert.ok(paraRows.length > 0, "正文行没有 data-para");
assert.deepEqual(paraNums, paraNums.map((_, i) => i), "段落序号不连续");
// 代码行 / 骨架行不该有 para
const codeWithPara = [...edP.querySelectorAll(".vsc-line[data-para]")]
  .filter((r) => !r.querySelector(".vsc-cm"));
assert.equal(codeWithPara.length, 0, "非正文行也带了 data-para");
console.log("  ✓ 只有正文行带段落锚点");

// scrollToPara 定位
const ok = shell.scrollToPara(2, false);
assert.ok(ok, "scrollToPara 定位失败");
console.log(`  scrollToPara(2) -> scrollTop=${edP.scrollTop}`);
assert.ok(edP.scrollTop >= 0, "滚动位置异常");
assert.equal(shell.currentPara(), 2, `定位后 currentPara 应为 2，实际 ${shell.currentPara()}`);

// 目标段落不存在时要往前找最近的，而不是崩或回顶
const far = shell.scrollToPara(9999, false);
console.log(`  scrollToPara(9999) 回退到第 ${shell.currentPara()} 段`);
assert.ok(far, "越界段落没有回退到最近的一段");
console.log("  ✓ 定位与越界回退正确");

// 滚动 -> 防抖 -> 落库
const bkId2 = `测试之书-·-Test-Book@${buf.length}`;
shell.scrollToPara(1, false);
edP.dispatchEvent(new window.Event("scroll"));
await new Promise((r) => setTimeout(r, 450));
let stP = await getState(bkId2);
console.log(`  滚动后落库: chapterHref=${stP.chapterHref.split("/").pop()}, para=${stP.para}`);
assert.equal(stP.chapterHref, "OEBPS/text/ch1.xhtml", "章节没记对");
assert.ok(typeof stP.para === "number", "段落位置没落库");
console.log("  ✓ 滚动位置已落库（350ms 防抖）");

// 改字号不该跳回章首 —— 这是段落锚点最主要的价值
shell.scrollToPara(3, false);
const beforeFont = shell.currentPara();
shell.setFontSize(20);
await new Promise((r) => setTimeout(r, 250));
const afterFont = shell.currentPara();
console.log(`  改字号前第 ${beforeFont} 段 -> 改后第 ${afterFont} 段`);
assert.equal(afterFont, beforeFont, "改字号后跳回了别的位置");
shell.setFontSize(13);
await new Promise((r) => setTimeout(r, 250));

// 改折行宽度同样要停在原处（行数会变，但段落不变）
shell.scrollToPara(3, false);
const beforeWrap = shell.currentPara();
source.commandLine.submit("wrap 60");
await new Promise((r) => setTimeout(r, 250));
console.log(`  改折行宽度前第 ${beforeWrap} 段 -> 改后第 ${shell.currentPara()} 段`);
assert.equal(shell.currentPara(), beforeWrap, "改折行宽度后位置丢了");

// 改伪装代码密度也一样（行数变化更大）
shell.scrollToPara(2, false);
const beforeCode = shell.currentPara();
source.commandLine.submit("code high");
await new Promise((r) => setTimeout(r, 250));
console.log(`  改代码密度前第 ${beforeCode} 段 -> 改后第 ${shell.currentPara()} 段`);
assert.equal(shell.currentPara(), beforeCode, "改代码密度后位置丢了");
source.commandLine.submit("code mid");
source.commandLine.submit("wrap auto");
await new Promise((r) => setTimeout(r, 200));
console.log("  ✓ 改字号 / 折行宽度 / 代码密度都停在原段落");

// 切走 tab 再切回来，位置要还在
await shell.openFile("OEBPS/text/ch2.xhtml");
shell.scrollToPara(0, false);
await shell.openFile("OEBPS/text/ch1.xhtml");
shell.scrollToPara(3, false);
const keepPara = shell.currentPara();
shell.openFile("OEBPS/text/ch2.xhtml");
await new Promise((r) => setTimeout(r, 60));
shell.openFile("OEBPS/text/ch1.xhtml");
await new Promise((r) => setTimeout(r, 60));
console.log(`  切走再切回: 离开时第 ${keepPara} 段 -> 回来第 ${shell.currentPara()} 段`);
assert.equal(shell.currentPara(), keepPara, "切 tab 回来位置丢了");
console.log("  ✓ 切 tab 往返保位置");

// 状态栏百分比要随滚动变化，而不是打开就跳满
shell.scrollToPara(0, false);
edP.dispatchEvent(new window.Event("scroll"));
await new Promise((r) => setTimeout(r, 450));
const pctTop = document.querySelector(".vsc-progress").textContent;
edP.scrollTop = 99999;
edP.dispatchEvent(new window.Event("scroll"));
await new Promise((r) => setTimeout(r, 450));
const pctBottom = document.querySelector(".vsc-progress").textContent;
console.log(`  章首: ${pctTop}   章尾: ${pctBottom}`);
const numOf = (t) => Number((t.match(/(\d+)%/) || [])[1] || 0);
assert.ok(numOf(pctBottom) >= numOf(pctTop), "滚到章尾进度反而变小了");
assert.ok(/\d+\/\d+ 段/.test(pctBottom), "状态栏没显示段落进度");
console.log("  ✓ 进度随滚动推进且显示段落数");

console.log("\n=== 13. 书签删除 ===");
// 先攒 3 个书签
await shell.openFile("OEBPS/text/ch1.xhtml");
source.commandLine.submit("mark 第一个");
await new Promise((r) => setTimeout(r, 30));
source.commandLine.submit("mark 第二个");
await new Promise((r) => setTimeout(r, 30));
source.commandLine.submit("mark 第三个");
await new Promise((r) => setTimeout(r, 30));
const bkId = `测试之书-·-Test-Book@${buf.length}`;
let stB = await getState(bkId);
console.log("  当前书签:", stB.bookmarks.map((b) => b.note).join(", "));
assert.ok(stB.bookmarks.length >= 3, "书签没攒够");
const before = stB.bookmarks.length;

// 13a. 点 PROBLEMS 面板里的 × 删除
shell.state.panel = "problems";
shell.renderPanel();
const xBtns = document.querySelectorAll(".vsc-panel-body .vsc-row-x[data-action='unmark']");
console.log("  PROBLEMS 面板里的 × 按钮数:", xBtns.length);
assert.equal(xBtns.length, before, "× 按钮数与书签数不一致");
xBtns[0].dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
stB = await getState(bkId);
console.log("  点 × 后:", stB.bookmarks.map((b) => b.note).join(", "));
assert.equal(stB.bookmarks.length, before - 1, "点 × 没有删掉书签");
console.log("  ✓ 面板里点 × 生效");

// 13b. SCM 侧栏里的 × 删除，且不会误触发「打开章节」
shell.state.activity = "scm";
shell.renderSidebar();
const treeX = document.querySelectorAll(".vsc-tree .vsc-row-x[data-action='unmark']");
console.log("  SCM 侧栏里的 × 按钮数:", treeX.length);
assert.equal(treeX.length, stB.bookmarks.length, "侧栏 × 按钮数不对");
const tabsBefore = shell.state.tabs.length;
treeX[0].dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
stB = await getState(bkId);
assert.equal(stB.bookmarks.length, before - 2, "侧栏点 × 没有删掉书签");
assert.equal(shell.state.tabs.length, tabsBefore, "点 × 误触发了打开章节（事件没被拦住）");
console.log("  ✓ 侧栏点 × 生效且未误开章节");

// 13c. unmark 命令：按序号删
source.commandLine.submit("mark 甲");
await new Promise((r) => setTimeout(r, 30));
source.commandLine.submit("mark 乙");
await new Promise((r) => setTimeout(r, 30));
stB = await getState(bkId);
const notes3 = stB.bookmarks.map((b) => b.note);
console.log("  删之前:", notes3.join(", "));
source.commandLine.submit("unmark 1");
await new Promise((r) => setTimeout(r, 50));
stB = await getState(bkId);
console.log("  unmark 1 之后:", stB.bookmarks.map((b) => b.note).join(", "));
assert.equal(stB.bookmarks.length, notes3.length - 1, "unmark 没删掉");
assert.ok(!stB.bookmarks.some((b) => b.note === notes3[0]), "unmark 1 删错了条目");

// 13d. unmark 不给序号 = 删最近一条
const lastNote = stB.bookmarks[stB.bookmarks.length - 1].note;
source.commandLine.submit("unmark");
await new Promise((r) => setTimeout(r, 50));
stB = await getState(bkId);
assert.ok(!stB.bookmarks.some((b) => b.note === lastNote), "unmark 无参数没删掉最近一条");
console.log("  ✓ unmark <序号> / unmark 都正确");

// 13e. 删到空时面板给出提示
while (stB.bookmarks.length) {
  source.commandLine.submit("unmark");
  await new Promise((r) => setTimeout(r, 40));
  stB = await getState(bkId);
}
shell.state.panel = "problems";
shell.renderPanel();
assert.ok(
  document.querySelector(".vsc-panel-body").textContent.includes("No bookmarks"),
  "书签清空后没有回到空状态提示"
);
console.log("  ✓ 清空后回到空状态提示");

console.log("\n=== 14. 段落间伪装代码 ===");
const { currentDensity } = await import("../src/sources/epub/source.js");
const { DENSITIES: DENS } = await import("../src/sources/epub/codegen.js");

// 造一个多段落章节
const paras = Array.from({ length: 24 }, (_, i) => `<p>这是第 ${i + 1} 段正文内容，用来测试伪装代码插入。</p>`).join("");
const manyParas = new TextEncoder().encode(`<html><body><h1>多段章</h1>${paras}</body></html>`);
const mdStyle = { id: "markdown", label: "Markdown", ext: "md", cstyle: "hash" };

const counts = {};
for (const d of DENS) {
  const out = rc({
    bytes: manyParas, href: "many.xhtml", title: "多段章", bookTitle: "书", author: "人",
    style: mdStyle, blobUrlFor: () => "", wrapCols: 88, density: d.id,
  });
  const codeRows = out.rows.filter((r) => r.type === "code" && !/^# /.test(r.text));
  counts[d.id] = codeRows.length;
  console.log(`  ${d.id.padEnd(5)}(${String(Math.round(d.chance * 100)).padStart(2)}%) -> ${String(out.rows.length).padStart(3)} 行，其中伪装代码 ${codeRows.length} 行`);
}
assert.equal(counts.off, 0, "off 档仍插入了代码");
assert.ok(counts.low > 0, "low 档没插入任何代码");
assert.ok(counts.high > counts.low, `high(${counts.high}) 应比 low(${counts.low}) 多`);
console.log("  ✓ 密度递增且 off 档完全关闭");

// 确定性：同一章连渲染两次必须完全一致
const twice = [0, 1].map(() => rc({
  bytes: manyParas, href: "many.xhtml", title: "多段章", bookTitle: "书", author: "人",
  style: mdStyle, blobUrlFor: () => "", wrapCols: 88, density: "high",
}).rows.map((r) => r.text));
assert.deepEqual(twice[0], twice[1], "同一章两次渲染不一致，重开书内容会乱跳");
console.log("  ✓ 同一章重复渲染逐行一致");

// 不同章节要不一样（种子来自 href）
const otherHref = rc({
  bytes: manyParas, href: "other.xhtml", title: "多段章", bookTitle: "书", author: "人",
  style: mdStyle, blobUrlFor: () => "", wrapCols: 88, density: "high",
}).rows.map((r) => r.text);
assert.notDeepEqual(twice[0], otherHref, "不同章节插入了相同的代码");
console.log("  ✓ 不同章节的伪装代码不同");

// 代码行不该被折行逻辑破坏（折行只作用于正文注释）
const highOut = rc({
  bytes: manyParas, href: "many.xhtml", title: "多段章", bookTitle: "书", author: "人",
  style: { id: "javascript", label: "JavaScript", ext: "js", cstyle: "slash" },
  blobUrlFor: () => "", wrapCols: 88, density: "high",
});
const jsCode = highOut.rows.filter((r) => r.type === "code");
console.log("  JS 视图代码行样例:");
jsCode.slice(3, 9).forEach((r) => console.log(`    │${r.text}`));
// 链式调用不保证一定出现（随机），但只要出现了，续行就必须多缩进一级
const chainRows = jsCode.filter((r) => /^\s*\./.test(r.text));
if (chainRows.length) {
  chainRows.forEach((r) => assert.ok(/^ {4}\./.test(r.text), `链式续行缩进不对: "${r.text}"`));
  console.log(`  链式续行 ${chainRows.length} 行，缩进均为 4 空格`);
} else {
  console.log("  本次随机未产出链式调用，跳过缩进检查");
}
assert.ok(!jsCode.some((r) => /const (\w+) = \1\b/.test(r.text)), "出现了 const x = x 自引用");
console.log("  ✓ 缩进正确、无自引用");

// 通过 code 命令切换密度
source.commandLine.submit("code high");
await new Promise((r) => setTimeout(r, 40));
assert.equal(currentDensity().id, "high", "code 命令未生效");
source.commandLine.submit("code off");
await new Promise((r) => setTimeout(r, 40));
assert.equal(currentDensity().id, "off", "code off 未生效");
source.commandLine.submit("code 不存在的档位");
assert.equal(currentDensity().id, "off", "非法档位不该改变设置");
source.commandLine.submit("code low");
console.log("  ✓ code 命令生效，非法值被忽略");

// EXTENSIONS 侧栏应列出 4 个密度档
shell.state.activity = "ext";
shell.renderSidebar();
const densRows = document.querySelectorAll(".vsc-tree [data-action='density']");
console.log("  EXTENSIONS 里的密度档位数:", densRows.length);
assert.equal(densRows.length, DENS.length, "密度档位没全列出来");

console.log("\n=== 14. 书库页（epub-main.js）===");
// 清掉已挂载的工作区，让 epub-main 从书库页启动
document.querySelector(".vsc-app")?.remove();
globalThis.Event = window.Event;
globalThis.DragEvent = window.Event;
await import("../src/epub-main.js");
await new Promise((r) => setTimeout(r, 80));

const lib = document.getElementById("library");
console.log("  标题:", lib.querySelector("h1")?.textContent);
assert.ok(lib.querySelector("#drop"), "缺少拖拽区");
assert.ok(lib.querySelector("#file"), "缺少文件选择 input");
assert.ok(lib.querySelector("#status"), "缺少状态提示区");
assert.equal(
  lib.querySelector("#file").getAttribute("accept"),
  ".epub,application/epub+zip",
  "文件选择器 accept 不对"
);
// 前面的测试往书库写过这本书吗？没有（只写了 state），所以书库列表应为空
console.log("  书库条目:", lib.querySelectorAll(".lib-item").length);

// CSS 应已由 epub-main 注入，且不含宿主接管规则
const mainStyle = document.getElementById("vsc-workspace-theme");
assert.ok(mainStyle, "epub-main 未注入样式");
assert.ok(!mainStyle.textContent.includes("#Wrapper"), "独立页面注入了 V2EX 宿主规则");
assert.ok(
  !document.documentElement.classList.contains("vsc-locked"),
  "独立页面不应加 vsc-locked（会强制 body overflow:hidden）"
);
console.log("  ✓ 书库页渲染正常，样式隔离正确");

console.log("\n✓✓ 全部测试通过");
