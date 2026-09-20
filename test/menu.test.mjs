/** 菜单栏测试：展开/切换/关闭、File 打开 epub、菜单项可用性 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";
import "fake-indexeddb/auto";

const { document, window } = parseHTML("<html><head></head><body></body></html>");
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
for (const [prop, val] of [["offsetHeight", 18], ["offsetTop", 0], ["clientHeight", 400], ["clientWidth", 1000], ["scrollHeight", 900]]) {
  Object.defineProperty(window.Element.prototype, prop, { get() { return val; }, configurable: true });
}
Object.defineProperty(window.Element.prototype, "scrollTop", {
  get() { return this.__st || 0; }, set(v) { this.__st = v; }, configurable: true,
});
Object.defineProperty(window.Element.prototype, "scrollLeft", { get() { return 0; }, set() {}, configurable: true });
window.Element.prototype.scrollTo = function (o) { if (o) this.scrollTop = o.top ?? 0; };
window.Element.prototype.getBoundingClientRect = function () {
  return { top: 0, left: 40, right: 100, bottom: 30, width: 60, height: 26 };
};
window.Element.prototype.focus = function () {};

const { unzip } = await import("../src/sources/epub/unzip.js");
const { createEpubSource } = await import("../src/sources/epub/source.js");
const { createShell } = await import("../src/shell/shell.js");

const buf = await readFile(join(import.meta.dirname, "test.epub"));
const files = await unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let picked = 0;
let openedLibrary = 0;
let openedBook = "";
const source = createEpubSource({
  files,
  size: buf.length,
  recentBooks: [
    { id: "b1", title: "三体", author: "刘慈欣" },
    { id: "b2", title: "美丽新世界", author: "赫胥黎" },
  ],
  onPickFile: () => { picked += 1; },
  onOpenLibrary: () => { openedLibrary += 1; },
  onOpenBook: (id) => { openedBook = id; },
});
const shell = createShell(source).mount();

const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
const bar = () => document.querySelector(".vsc-menubar");
const pop = () => document.querySelector(".vsc-menu-pop");
const rows = () => [...pop().querySelectorAll(".vsc-menu-row")];
const rowByLabel = (t) => rows().find((r) => r.querySelector(".label").textContent.includes(t));

console.log("=== 1. 菜单栏渲染 ===");
const items = [...bar().querySelectorAll(".vsc-menu-item")];
console.log("  菜单:", items.map((b) => b.textContent).join(" / "));
assert.ok(items.length >= 5, "菜单项太少");
assert.equal(items[0].textContent, "File", "第一个应是 File");
// 不能再是不可点的装饰
items.forEach((b) => assert.equal(b.tagName, "BUTTON", "菜单项应该是按钮"));
console.log("  ✓ 菜单栏可点");

console.log("\n=== 2. 展开 / 切换 / 关闭 ===");
assert.ok(!pop().classList.contains("open"), "初始不该展开");
click(items[0]);
assert.ok(pop().classList.contains("open"), "点 File 没展开");
assert.ok(items[0].classList.contains("open"), "File 没高亮");
console.log("  File 菜单项数:", rows().length);

// 展开状态下划过别的菜单名要直接切换
items[2].dispatchEvent(new window.Event("mouseover", { bubbles: true }));
assert.ok(items[2].classList.contains("open"), "hover 没切换菜单");
assert.ok(!items[0].classList.contains("open"), "旧菜单没取消高亮");
console.log("  ✓ hover 切换");

// 再点一次收起
click(items[2]);
assert.ok(!pop().classList.contains("open"), "再点没收起");
// Esc 关闭
click(items[0]);
document.dispatchEvent(new window.Event("keydown", { bubbles: true }));
const esc = new window.Event("keydown", { bubbles: true });
esc.key = "Escape";
document.dispatchEvent(esc);
assert.ok(!pop().classList.contains("open"), "Esc 没关掉菜单");
// 点别处关闭
click(items[0]);
click(document.body);
assert.ok(!pop().classList.contains("open"), "点别处没关掉菜单");
console.log("  ✓ 再点收起 / Esc / 点外部");

console.log("\n=== 3. File 菜单：添加 epub ===");
click(items[0]);
const labels = rows().map((r) => r.querySelector(".label").textContent);
console.log("  项目:", labels.join(" | "));
const openItem = rowByLabel("打开 EPUB");
assert.ok(openItem, "File 里没有「打开 EPUB…」");
assert.equal(openItem.querySelector(".hint").textContent, "⌘O", "没标注快捷键");
click(openItem);
assert.equal(picked, 1, "点「打开 EPUB…」没触发文件选择器");
assert.ok(!pop().classList.contains("open"), "选完菜单没关闭");
console.log("  ✓ 触发文件选择器并收起菜单");

console.log("\n=== 4. File 菜单：最近打开 ===");
click(items[0]);
const recent = rowByLabel("三体");
assert.ok(recent, "最近打开里没有书名");
assert.equal(recent.querySelector(".hint").textContent, "刘慈欣", "没显示作者");
assert.ok(pop().querySelector(".vsc-menu-title"), "缺少「最近打开」分组标题");
assert.ok(pop().querySelector(".vsc-menu-sep"), "缺少分隔线");
click(recent);
assert.equal(openedBook, "b1", "点最近书籍没打开对应的书");
console.log("  ✓ 最近打开可点");

// 回到书库
click(items[0]);
click(rowByLabel("回到书库"));
assert.equal(openedLibrary, 1, "「回到书库」没生效");
console.log("  ✓ 回到书库");

console.log("\n=== 5. 其它菜单都有内容 ===");
for (let i = 0; i < items.length; i++) {
  click(items[i]);
  const n = rows().length;
  console.log(`  ${items[i].textContent.padEnd(9)} ${n} 项`);
  assert.ok(n > 0, `${items[i].textContent} 菜单是空的，点了没反应很怪`);
}
click(document.body);

console.log("\n=== 6. 菜单项能真的执行 ===");
// View -> 切换 Agent 面板
const viewIdx = items.findIndex((b) => b.textContent === "View");
click(items[viewIdx]);
const before = document.querySelector(".vsc-app").classList.contains("agent-on");
click(rowByLabel("切换 Agent 面板"));
assert.notEqual(document.querySelector(".vsc-app").classList.contains("agent-on"), before, "菜单没切换 Agent 面板");
console.log("  ✓ View → 切换 Agent 面板");

// View -> 放大字号
const { codeSize } = await import("../src/shell/shell.js");
shell.setFontSize(13);
click(items[viewIdx]);
click(rowByLabel("放大字号"));
assert.equal(codeSize(), 14, "菜单没放大字号");
click(items[viewIdx]);
click(rowByLabel("字号复位"));
assert.equal(codeSize(), 13, "菜单没复位字号");
console.log("  ✓ View → 字号");

// Go -> 上一章在首章应禁用
await shell.openFile("OEBPS/text/ch1.xhtml");
shell.renderMenubar();
const goIdx = [...bar().querySelectorAll(".vsc-menu-item")].findIndex((b) => b.textContent === "Go");
click([...bar().querySelectorAll(".vsc-menu-item")][goIdx]);
const prev = rowByLabel("上一章");
const next = rowByLabel("下一章");
console.log(`  首章: 上一章 disabled=${prev.classList.contains("disabled")}, 下一章 disabled=${next.classList.contains("disabled")}`);
assert.ok(prev.classList.contains("disabled"), "首章的「上一章」应禁用");
assert.ok(!next.classList.contains("disabled"), "首章的「下一章」不该禁用");
click(next);
await new Promise((r) => setTimeout(r, 50));
console.log("  跳转后:", document.querySelector(".vsc-crumb").textContent.trim());
assert.ok(document.querySelector(".vsc-crumb").textContent.includes("02-"), "「下一章」没跳转");
console.log("  ✓ Go → 章节跳转与禁用态");

console.log("\n✓ 菜单栏测试通过");
