/**
 * 降级测试：IndexedDB 不可用 / 解压能力缺失时，页面必须给出可见提示，
 * 而不是一片空白（那就是用户看到的"打开没反应"）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";

const { document, window } = parseHTML(
  "<html><head></head><body><div id='library'></div></body></html>"
);
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

// ---- 关键：IndexedDB 完全不可用（隐私模式 / file:// 限制 / 存储被禁）----
// 注意不能 delete globalThis.indexedDB 后又补上，这里就是要模拟「open 就抛」
globalThis.indexedDB = {
  open() { throw new DOMException("The user denied permission to access the database.", "SecurityError"); },
};

const bytes = await readFile(join(import.meta.dirname, "test.epub"));
const fakeFile = () => ({
  name: "book.epub",
  size: bytes.length,
  type: "application/epub+zip",
  async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
});

console.log("=== 1. IndexedDB 不可用时，书库页仍要渲染 ===");
await import("../src/epub-main.js");
await new Promise((r) => setTimeout(r, 120));

const lib = document.getElementById("library");
const title = lib.querySelector("h1")?.textContent;
console.log("  页面标题:", title || "(空白！)");
assert.ok(title, "IndexedDB 抛错就让页面变空白了 —— 这正是「打开没反应」");
assert.ok(lib.querySelector("#drop"), "拖拽区没渲染出来");
assert.ok(lib.querySelector("#file"), "文件输入框没渲染出来");

const warn = lib.querySelector(".lib-warn");
console.log("  警告提示:", warn ? warn.textContent.trim().slice(0, 60) : "(无)");
assert.ok(warn, "书库不可用却没有任何提示");
assert.ok(/书库不可用|IndexedDB/.test(warn.textContent), "提示没说清楚问题");
console.log("  ✓ 降级渲染 + 明确告知");

console.log("\n=== 2. 此时仍然能正常打开 epub（只是不保存进度）===");
const input = lib.querySelector("#file");
Object.defineProperty(input, "files", { value: [fakeFile()], configurable: true });
input.dispatchEvent(new window.Event("change", { bubbles: true }));
await new Promise((r) => setTimeout(r, 400));

const app = document.querySelector(".vsc-app");
const status = lib.querySelector("#status");
console.log("  状态:", status ? `"${status.textContent}"` : "(书库页已关闭)");
console.log("  工作区挂载:", !!app);
assert.ok(app, "书库存不了就连书都打不开了 —— 存储失败不该阻断阅读");
assert.ok(document.querySelectorAll(".vsc-tree-row").length > 0, "文件树是空的");
console.log("  章节数:", document.querySelectorAll(".vsc-tree-row").length);
console.log("  ✓ 存储不可用不影响阅读");

console.log("\n=== 3. 坏文件要给出可读的错误，而不是静默 ===");
const { unzip } = await import("../src/sources/epub/unzip.js");
let msg = "";
try {
  await unzip(new TextEncoder().encode("this is definitely not a zip file").buffer);
} catch (err) {
  msg = err.message;
}
console.log("  错误信息:", msg);
assert.ok(msg.includes("epub") || msg.includes("zip"), `错误信息对用户没意义: "${msg}"`);
console.log("  ✓ 错误可读");

console.log("\n✓ 降级测试通过");
