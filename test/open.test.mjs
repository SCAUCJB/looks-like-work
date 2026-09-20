/** 端到端：从书库页选择 epub -> 挂载工作区。复现"打开没反应"类问题 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";
import "fake-indexeddb/auto";

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
Object.defineProperty(window.Element.prototype, "scrollTop", {
  get() { return this.__st || 0; }, set(v) { this.__st = v; }, configurable: true,
});
Object.defineProperty(window.Element.prototype, "scrollLeft", { get() { return 0; }, set() {}, configurable: true });
window.Element.prototype.scrollTo = function (o) { if (o) this.scrollTop = o.top ?? 0; };
window.Element.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 30, width: 60, height: 26 });
window.Element.prototype.focus = function () {};
// 记录 input.click() 有没有被调用
let pickerClicks = 0;
window.HTMLElement.prototype.click = function () {
  if (this.tagName === "INPUT" && this.type === "file") pickerClicks += 1;
  this.dispatchEvent(new window.Event("click", { bubbles: true }));
};

// 捕获未处理的错误，"没反应"往往就是这里吞掉的
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); origError(...a); };

const bytes = await readFile(join(import.meta.dirname, "test.epub"));

/** 模拟浏览器的 File 对象 */
function fakeFile(name = "book.epub", body = bytes) {
  return {
    name,
    size: body.length,
    type: "application/epub+zip",
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

/** 换个书名重新打包一本，用来验证「换书」确实换掉了 */
async function makeSecondBook() {
  const { unzip } = await import("../src/sources/epub/unzip.js");
  const files = await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const dec = new TextDecoder();
  const opf = dec.decode(files.get("OEBPS/content.opf"))
    .replace("测试之书 · Test Book", "第二本书 · Second Book");
  files.set("OEBPS/content.opf", new TextEncoder().encode(opf));
  return files;
}

console.log("=== 1. 加载入口，渲染书库页 ===");
await import("../src/epub-main.js");
await new Promise((r) => setTimeout(r, 80));
const lib = document.getElementById("library");
console.log("  标题:", lib.querySelector("h1")?.textContent);
assert.ok(lib.querySelector("#file"), "书库页没有文件输入框");
assert.equal(errors.length, 0, `加载阶段就报错了: ${errors.join(" | ")}`);

console.log("\n=== 2. 选择 epub 文件 ===");
const input = lib.querySelector("#file");
Object.defineProperty(input, "files", { value: [fakeFile()], configurable: true });
input.dispatchEvent(new window.Event("change", { bubbles: true }));
await new Promise((r) => setTimeout(r, 300));

const status = lib.querySelector("#status");
console.log("  状态提示:", status ? `"${status.textContent}"` : "(书库页已关闭)");
console.log("  报错:", errors.length ? errors.join(" | ") : "无");
assert.equal(errors.length, 0, `打开过程中报错: ${errors.join(" | ")}`);

const app = document.querySelector(".vsc-app");
console.log("  工作区挂载:", !!app);
assert.ok(app, "选了文件之后工作区没挂载 —— 这就是「打开没反应」");
assert.ok(lib.hidden, "工作区起来了但书库页没隐藏");
console.log("  标题栏:", document.querySelector(".vsc-title-center")?.textContent);
console.log("  菜单栏:", [...document.querySelectorAll(".vsc-menu-item")].map((b) => b.textContent).join("/"));
assert.ok(document.querySelectorAll(".vsc-menu-item").length > 0, "菜单栏是空的");
assert.ok(document.querySelectorAll(".vsc-tree-row").length > 0, "文件树是空的");
console.log("  ✓ 打开成功");

console.log("\n=== 2b. file input 的两个兼容性陷阱 ===");
{
  // 这几条是结构约定，直接检查源码比重跑一遍渲染更稳，也不会动到当前页面状态
  const html = await readFile(join(import.meta.dirname, "..", "src", "epub-main.js"), "utf8");

  // input 不能嵌在 label 里：label 会把 click 转发给 input，input 自己再收一次，
  // 某些浏览器下这会让文件选择直接被取消
  assert.ok(
    !/<label[^>]*class="lib-drop"[\s\S]{0,200}?<input type="file"/.test(html),
    "file input 又被嵌回 label 里了"
  );
  // 不能用 hidden / display:none：Safari 下可能不派发 change
  assert.ok(
    !/id="file"[^>]*\shidden/.test(html),
    "file input 用了 hidden —— Safari 下可能收不到 change 事件"
  );
  assert.ok(html.includes('class="lib-file"'), "file input 没用视觉隐藏的 class");
  assert.ok(/input\.className = "lib-file"/.test(html), "常驻选择器仍在用 hidden");

  // change 和 input 都要监听（个别浏览器只派发其中一个）
  assert.ok(html.includes('addEventListener("change", onPick)'), "没监听 change");
  assert.ok(html.includes('addEventListener("input", onPick)'), "没监听 input");
  // 去重，别处理两次
  assert.ok(/now - lastPick < 300|now - last < 300/.test(html), "没有对重复事件去重");
  // 选完要清空 value，否则连选同一个文件不会再触发
  assert.ok(html.includes('input.value = ""'), "没清空 input.value");
  console.log("  ✓ input 独立于 label、视觉隐藏、双事件监听、去重、value 复位");
}

console.log("\n=== 2c. 每一步都要有可见反馈 ===");
{
  const html = await readFile(join(import.meta.dirname, "..", "src", "epub-main.js"), "utf8");
  for (const [step, pat] of [
    ["已选择文件", /已选择 \$\{f\.name\}/],
    ["已读取字节", /已读取 \$\{fmtSize\(buffer\.byteLength\)\}/],
    ["解包完成", /解包出 \$\{files\.size\} 个文件/],
  ]) {
    assert.ok(pat.test(html), `缺少「${step}」这一步的提示，卡住时看不出卡在哪`);
    console.log(`  ✓ ${step}`);
  }
  // 拿不到文件也要说话
  assert.ok(html.includes("没有拿到文件"), "files 为空时没有任何提示");
  console.log("  ✓ 空选择也有提示");
}

console.log("\n=== 2d. 诊断入口 ===");
{
  const html = await readFile(join(import.meta.dirname, "..", "src", "epub-main.js"), "utf8");
  assert.ok(html.includes("function diagnostics()"), "没有诊断函数");
  for (const key of ["UA", "解压 API", "IndexedDB", "File API"]) {
    assert.ok(html.includes(key), `诊断里缺少 ${key}`);
  }
  assert.ok(html.includes('id="diag"'), "书库页没有诊断按钮");
  console.log("  ✓ 诊断函数与入口齐全");
}

console.log("\n=== 3. File → 打开 EPUB… 能弹出选择器 ===");
const fileMenu = [...document.querySelectorAll(".vsc-menu-item")][0];
fileMenu.dispatchEvent(new window.Event("click", { bubbles: true }));
const openRow = [...document.querySelectorAll(".vsc-menu-row")]
  .find((r) => r.textContent.includes("打开 EPUB"));
assert.ok(openRow, "File 菜单里没有「打开 EPUB…」");
const before = pickerClicks;
openRow.dispatchEvent(new window.Event("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
console.log(`  input.click() 触发次数: ${before} -> ${pickerClicks}`);
assert.ok(pickerClicks > before, "点菜单没有弹出文件选择器");
assert.equal(errors.length, 0, `弹选择器时报错: ${errors.join(" | ")}`);

console.log("\n=== 3b. 换书必须真的换掉 ===");
{
  // 回归：mount() 以前发现已有 .vsc-app 就直接 return，
  // 于是在工作区里打开新书时页面一直停在上一本。
  const titleBefore = document.querySelector(".vsc-title-center").textContent;
  const treeBefore = document.querySelector(".vsc-tree").textContent;
  console.log("  当前:", titleBefore);

  const second = await makeSecondBook();
  const { createEpubSource } = await import("../src/sources/epub/source.js");
  const { createShell } = await import("../src/shell/shell.js");

  // 直接走和 openWorkspace 一样的路径：不 destroy 就挂载，看看会不会覆盖
  const src2 = createEpubSource({ files: second, size: 999, onOpenLibrary: () => {} });
  const shell2 = createShell(src2).mount();
  await new Promise((r) => setTimeout(r, 60));

  const titleAfter = document.querySelector(".vsc-title-center").textContent;
  console.log("  换书后:", titleAfter);
  assert.notEqual(titleAfter, titleBefore, "换书后标题没变 —— 新外壳没挂上");
  assert.ok(titleAfter.includes("第二本书"), `标题不是新书: ${titleAfter}`);
  assert.equal(document.querySelectorAll(".vsc-app").length, 1, "同时存在多个工作区外壳");
  console.log("  ✓ 新书替换了旧书，且只有一个外壳");

  shell2.destroy();
  assert.equal(document.querySelectorAll(".vsc-app").length, 0, "destroy 后外壳没被移除");
  console.log("  ✓ destroy 移除 DOM");
}

console.log("\n=== 3c. 换书后全局监听不能叠加 ===");
{
  const second = await makeSecondBook();
  const { createEpubSource } = await import("../src/sources/epub/source.js");
  const { createShell } = await import("../src/shell/shell.js");

  const mk = () => createShell(createEpubSource({ files: second, size: 999, onOpenLibrary: () => {} })).mount();

  const a = mk();
  a.setAgentOpen(false);
  // 不 destroy 直接挂下一个，模拟以前那种「只删 DOM」的换书方式
  a.destroy();
  const b = mk();
  b.setAgentOpen(false);
  await new Promise((r) => setTimeout(r, 40));

  // ⌘I 应该只切换一次；监听器叠加的话会开了又关，看起来毫无反应
  const app2 = document.querySelector(".vsc-app");
  const before = app2.classList.contains("agent-on");
  const ev = new window.Event("keydown", { bubbles: true });
  ev.key = "i";
  ev.metaKey = true;
  ev.preventDefault = () => {};
  document.dispatchEvent(ev);
  const after = app2.classList.contains("agent-on");
  console.log(`  按一次 ⌘I: agent-on ${before} -> ${after}`);
  assert.notEqual(after, before, "⌘I 没有生效，或被叠加的监听器触发了两次（开了又关）");
  console.log("  ✓ 旧外壳的监听器已解绑");

  b.destroy();
}

console.log("\n=== 4. 用选择器换一本书 ===");
const picker = document.getElementById("vsc-file-picker");
assert.ok(picker, "常驻文件选择器没创建");
Object.defineProperty(picker, "files", { value: [fakeFile("another.epub")], configurable: true });
picker.dispatchEvent(new window.Event("change", { bubbles: true }));
await new Promise((r) => setTimeout(r, 300));
console.log("  报错:", errors.length ? errors.join(" | ") : "无");
assert.equal(errors.length, 0, `换书时报错: ${errors.join(" | ")}`);
assert.ok(document.querySelector(".vsc-app"), "换书后工作区没了");
console.log("  ✓ 换书成功");

console.log("\n✓ 打开流程测试通过");
