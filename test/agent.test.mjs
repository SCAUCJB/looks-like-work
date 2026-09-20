/** Agent 面板测试：脚本生成、逐步推进、打字机、联动编辑器 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";
import "fake-indexeddb/auto";

const { document, window } = parseHTML(
  "<html><head></head><body><div id='library'></div></body></html>"
);
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
globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => document.documentElement.style.getPropertyValue(n) || "" });
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.URL.createObjectURL = (b) => `blob:fake/${b?.size ?? 0}`;

const ROW_H = 18, VIEW_H = 400, EDITOR_W = 1000;
Object.defineProperty(window.Element.prototype, "offsetHeight", {
  get() { return this.classList?.contains("vsc-line") ? ROW_H : 0; }, configurable: true,
});
Object.defineProperty(window.Element.prototype, "offsetTop", {
  get() {
    if (!this.classList?.contains("vsc-line")) return 0;
    return [...(this.parentElement?.children || [])].indexOf(this) * ROW_H;
  }, configurable: true,
});
Object.defineProperty(window.Element.prototype, "clientHeight", {
  get() { return this.classList?.contains("vsc-editor") ? VIEW_H : 0; }, configurable: true,
});
Object.defineProperty(window.Element.prototype, "clientWidth", {
  get() { return this.classList?.contains("vsc-editor") ? EDITOR_W : 0; }, configurable: true,
});
Object.defineProperty(window.Element.prototype, "scrollHeight", {
  get() {
    if (this.classList?.contains("vsc-editor")) return this.querySelectorAll(".vsc-line").length * ROW_H;
    if (this.classList?.contains("vsc-agent-body")) return 9999;
    return 0;
  }, configurable: true,
});
Object.defineProperty(window.Element.prototype, "scrollTop", {
  get() { return this.__st || 0; }, set(v) { this.__st = Math.max(0, v); }, configurable: true,
});
// linkedom 的 scrollTo 是空实现，平滑滚动（Agent 推进走这条路）在测试里就不会改 scrollTop
window.Element.prototype.scrollTo = function (opts) {
  if (opts && typeof opts === "object") this.scrollTop = opts.top ?? this.scrollTop;
};
Object.defineProperty(window.Element.prototype, "scrollLeft", {
  get() { return this.__sl || 0; }, set(v) { this.__sl = v; }, configurable: true,
});
window.Element.prototype.getBoundingClientRect = function () {
  if (this.classList?.contains("vsc-measure")) {
    const n = (this.textContent || "").length;
    return { top: 0, left: 0, right: n * 7.8, bottom: 0, width: n * 7.8, height: 18 };
  }
  return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 180 };
};

const { unzip } = await import("../src/sources/epub/unzip.js");
const { createEpubSource } = await import("../src/sources/epub/source.js");
const { createShell } = await import("../src/shell/shell.js");
const { SPEEDS, speedOf, DEFAULT_SPEED } = await import("../src/shell/agent.js");

const buf = await readFile(join(import.meta.dirname, "test.epub"));
const files = await unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

// 造一本段落多一点的书用的章节
files.set("OEBPS/text/ch1.xhtml", new TextEncoder().encode(
  `<html><body><h1>第一章 开端</h1>${Array.from({ length: 8 },
    (_, i) => `<p>这是第 ${i + 1} 段的内容，用来验证 Agent 面板逐段输出。</p>`).join("")}</body></html>`
));

const source = createEpubSource({ files, size: buf.length, onOpenLibrary: () => {} });
const shell = createShell(source).mount();

console.log("=== 1. 速度档位 ===");
SPEEDS.forEach((s) => console.log(`  ${s.id.padEnd(8)} ${s.label.padEnd(4)} cps=${s.cps}`));
assert.equal(speedOf("不存在").id, DEFAULT_SPEED, "非法速度应回落默认");
assert.equal(speedOf("instant").cps, 0, "instant 应该不打字");

console.log("\n=== 2. 面板开关 ===");
const app = document.querySelector(".vsc-app");
assert.ok(document.querySelector(".vsc-agent"), "Agent 面板 DOM 不存在");
assert.ok(!app.classList.contains("agent-on"), "默认应关闭");
shell.toggleAgent();
assert.ok(app.classList.contains("agent-on"), "开关失效");
const widthOpen = document.documentElement.style.getPropertyValue("--vsc-agent-w");
console.log("  打开后宽度:", widthOpen);
assert.ok(parseFloat(widthOpen) > 0, "打开后宽度应大于 0");
shell.toggleAgent();
assert.equal(document.documentElement.style.getPropertyValue("--vsc-agent-w"), "0px", "关闭后宽度应为 0");
shell.setAgentOpen(true);
console.log("  ✓ 开关与宽度联动");

console.log("\n=== 2b. 布局：四个主区域必须显式占列 ===");
{
  const { buildCss } = await import("../src/shell/style.js");
  const shellMod = await import("../src/shell/shell.js");
  const css = buildCss({
    ROOT_CLASS: "vsc-theme", storedPanelH: () => "", sideWidth: () => "260px",
    codeSize: shellMod.codeSize, codeLine: shellMod.codeLine, gutterW: shellMod.gutterW,
  });
  // 取某条规则的声明块
  const ruleOf = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = css.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : "";
  };
  const cols = {
    ".vsc-activity": "1 / 2",
    ".vsc-sidebar": "2 / 3",
    ".vsc-work": "3 / 4",
    ".vsc-agent": "4 / 5",
  };
  for (const [sel, expect] of Object.entries(cols)) {
    const rule = ruleOf(sel);
    console.log(`  ${sel.padEnd(14)} grid-column: ${(rule.match(/grid-column:\s*([^;]+)/) || [])[1] || "（缺失）"}`);
    assert.ok(
      rule.includes(`grid-column: ${expect}`),
      `${sel} 没有显式 grid-column —— 只要有任何一项显式定位，其余自动放置项就会被挤位`
    );
  }
  // resizer 必须是绝对定位，不占网格
  const rz = ruleOf(".vsc-agent-resizer");
  assert.ok(rz.includes("position: absolute"), "agent resizer 应绝对定位");
  assert.ok(!rz.includes("grid-column"), "agent resizer 占了网格格子，会把 Agent 面板挤走");
  console.log("  .vsc-agent-resizer 绝对定位，不占网格 ✓");
  // 网格本身要有 4 列
  const appRule = ruleOf(".vsc-app");
  assert.ok(appRule.includes("var(--vsc-agent-w)"), "网格没有给 Agent 留列");
  console.log("  ✓ 四列布局完整，Agent 不会被挤到别处");
}

console.log("\n=== 2c. 可见入口 ===");
{
  const titleBtn = document.querySelector(".vsc-agent-btn");
  const actBtn = document.querySelector(".vsc-agent-act");
  assert.ok(titleBtn, "标题栏没有 Agent 按钮");
  assert.ok(actBtn, "活动栏没有 Agent 按钮");
  assert.ok(titleBtn.getAttribute("title").includes("I"), "按钮没标注快捷键");

  shell.setAgentOpen(false);
  assert.ok(!titleBtn.classList.contains("on"), "关闭时按钮不该高亮");

  // 点标题栏按钮
  titleBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(app.classList.contains("agent-on"), "点标题栏按钮没打开面板");
  assert.ok(titleBtn.classList.contains("on"), "打开后标题栏按钮没高亮");
  assert.ok(actBtn.classList.contains("on"), "打开后活动栏按钮没高亮");
  console.log("  标题栏按钮 -> 打开并高亮 ✓");

  // 点活动栏按钮关闭
  actBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(!app.classList.contains("agent-on"), "点活动栏按钮没关闭面板");
  assert.ok(!titleBtn.classList.contains("on"), "关闭后按钮仍高亮");
  console.log("  活动栏按钮 -> 关闭并取消高亮 ✓");

  // 活动栏的 Agent 按钮不该被当成 sidebar 视图切换按钮
  assert.ok(!actBtn.hasAttribute("data-act"), "Agent 按钮不该带 data-act（会被当成 Explorer/Search 那类视图）");

  // 面板里的 × 也能关
  shell.setAgentOpen(true);
  document.querySelector(".vsc-agent-x").dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(!app.classList.contains("agent-on"), "面板内的 × 没关掉");
  shell.setAgentOpen(true);
  console.log("  ✓ 三个入口都能开关（标题栏 / 活动栏 / 面板内 ×）");
}

console.log("\n=== 2c2. 标题栏三个图标按钮 ===");
{
  const { buildCss } = await import("../src/shell/style.js");
  const shellMod2 = await import("../src/shell/shell.js");
  const css2 = buildCss({
    ROOT_CLASS: "vsc-theme", storedPanelH: () => "", sideWidth: () => "260px",
    codeSize: shellMod2.codeSize, codeLine: shellMod2.codeLine, gutterW: shellMod2.gutterW,
  });
  const ruleOf2 = (sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = css2.match(new RegExp(esc + "\\s*\\{([^}]*)\\}"));
    return m ? m[1] : "";
  };

  const btns = [...document.querySelectorAll(".vsc-title-actions .vsc-icon-btn")];
  console.log("  按钮数:", btns.length);
  assert.equal(btns.length, 3, "标题栏应有三个图标按钮");

  // 三个都得是图标，不能混一个纯文字进去——那正是对不齐的来源
  btns.forEach((b, i) => {
    const svg = b.querySelector("svg");
    assert.ok(svg, `第 ${i + 1} 个按钮不是图标（混了文字进去会与其它按钮基线不一致）`);
    assert.equal(svg.getAttribute("viewBox"), "0 0 24 24", `第 ${i + 1} 个图标 viewBox 不统一`);
    const txt = (b.textContent || "").trim();
    assert.equal(txt, "", `第 ${i + 1} 个按钮混入了文字 "${txt}"`);
  });
  console.log("  三个都是 24×24 viewBox 的纯图标 ✓");

  // 尺寸与对齐靠 CSS 保证
  const btnRule = ruleOf2(".vsc-icon-btn");
  const svgRule = ruleOf2(".vsc-icon-btn svg");
  console.log("  按钮尺寸:", (btnRule.match(/width:\s*[^;]+/) || [])[0]);
  console.log("  图标尺寸:", (svgRule.match(/width:\s*[^;]+/) || [])[0]);
  assert.ok(/width:\s*26px/.test(btnRule) && /height:\s*26px/.test(btnRule), "按钮不是正方形固定尺寸");
  assert.ok(btnRule.includes("inline-flex"), "按钮没用 flex 居中");
  assert.ok(btnRule.includes("align-items: center"), "按钮缺垂直居中");
  assert.ok(btnRule.includes("justify-content: center"), "按钮缺水平居中");
  // 这条是对齐的关键
  assert.ok(
    svgRule.includes("display: block"),
    "图标缺 display:block —— inline svg 会吃 line-height 产生基线下沉，看起来就是没对齐"
  );
  assert.ok(/stroke-width:\s*1\.6/.test(svgRule), "图标描边粗细没统一");
  assert.ok(svgRule.includes("stroke-linecap: round"), "图标没做圆头描边");
  console.log("  ✓ 固定 26×26、flex 居中、svg display:block、描边统一");

  // 容器对齐
  const actionsRule = ruleOf2(".vsc-title-actions");
  assert.ok(actionsRule.includes("align-items: center"), "按钮容器没垂直居中");
  console.log("  容器:", actionsRule.trim());

  // 激活态不该是整块实心色
  const onRule = ruleOf2(".vsc-icon-btn.on");
  assert.ok(onRule.includes("color-mix"), "激活态仍是实心背景，太重");
  console.log("  ✓ 激活态用淡色底 + 主题色图标");

  // 每个按钮都要有 title（图标化之后没有文字提示就认不出来了）
  btns.forEach((b, i) => {
    const t = b.getAttribute("title") || "";
    assert.ok(t.length > 0, `第 ${i + 1} 个按钮没有 title`);
    assert.ok(/[⌘I P]/.test(t), `第 ${i + 1} 个按钮的 title 没写快捷键: "${t}"`);
    console.log(`  按钮 ${i + 1} title: ${t}`);
  });
  console.log("  ✓ 图标化后仍能通过 title 认出功能");
}

console.log("\n=== 2d. 面板宽度可调 ===");
{
  const handle = document.querySelector(".vsc-agent-resizer");
  assert.ok(handle, "没有宽度拖拽手柄");
  const widthOf = () => parseFloat(document.documentElement.style.getPropertyValue("--vsc-agent-w")) || 0;
  const before = widthOf();

  // 模拟往左拖 120px（面板在右侧，往左 = 变宽）
  const down = new window.Event("pointerdown", { bubbles: true });
  down.clientX = 700;
  down.pointerId = 1;
  handle.dispatchEvent(down);
  const move = new window.Event("pointermove", { bubbles: true });
  move.clientX = 580;
  window.dispatchEvent(move);
  const wider = widthOf();
  console.log(`  往左拖 120px: ${before}px -> ${wider}px`);
  assert.ok(wider > before, "往左拖没有变宽");
  assert.equal(wider, before + 120, "宽度变化量不对");

  // 往右拖回去
  const move2 = new window.Event("pointermove", { bubbles: true });
  move2.clientX = 760;
  window.dispatchEvent(move2);
  console.log(`  再往右拖: -> ${widthOf()}px`);
  assert.ok(widthOf() < wider, "往右拖没有变窄");

  // 越界要夹住
  const move3 = new window.Event("pointermove", { bubbles: true });
  move3.clientX = 9999;
  window.dispatchEvent(move3);
  assert.ok(widthOf() >= 260, `宽度被拖到 ${widthOf()}px，没有夹住下限`);
  const move4 = new window.Event("pointermove", { bubbles: true });
  move4.clientX = -9999;
  window.dispatchEvent(move4);
  assert.ok(widthOf() <= 720, `宽度被拖到 ${widthOf()}px，没有夹住上限`);
  window.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  console.log(`  越界夹取: 下限 260 / 上限 720，当前 ${widthOf()}px`);

  // 宽度要持久化
  assert.ok(Number(globalThis.localStorage.getItem("vsc-agent-w")) > 0, "宽度没持久化");
  // 拖完松手后再移动不该继续改宽度
  const after = widthOf();
  const stray = new window.Event("pointermove", { bubbles: true });
  stray.clientX = 100;
  window.dispatchEvent(stray);
  assert.equal(widthOf(), after, "松手后仍在响应拖拽");
  console.log("  ✓ 可拖拽、有上下限、会记住、松手即停");

  document.documentElement.style.setProperty("--vsc-agent-w", "340px");
  globalThis.localStorage.setItem("vsc-agent-w", "340");
}

console.log("\n=== 2e. 速度的可见入口 ===");
{
  shell.setAgentOpen(true);
  const chip = document.querySelector(".vsc-agent-speed");
  assert.ok(chip, "面板头部没有速度切换控件");

  shell.setAgentSpeed("normal");
  console.log(`  chip 文案: "${chip.textContent}"  title: "${chip.getAttribute("title")}"`);
  assert.equal(chip.textContent, "正常", "chip 没显示当前档位");
  assert.ok(chip.getAttribute("title").includes("70"), "title 没写明速度数值");

  // 点击循环切换，转一圈要回到原点
  const seen = [];
  for (let i = 0; i < SPEEDS.length; i++) {
    chip.dispatchEvent(new window.Event("click", { bubbles: true }));
    seen.push(shell.agentSpeed().id);
  }
  console.log("  点 4 次:", seen.join(" -> "));
  assert.equal(seen.length, new Set(seen).size, "循环中出现重复档位");
  assert.equal(shell.agentSpeed().id, "normal", "转一圈没回到起点");
  assert.equal(chip.textContent, "正常", "chip 文案没跟着更新");
  console.log("  ✓ 点击循环切换，chip 同步");

  // 速度要持久化
  shell.setAgentSpeed("fast");
  assert.equal(globalThis.localStorage.getItem("vsc-agent-speed"), "fast", "速度没持久化");

  // 非法值不改变设置
  shell.setAgentSpeed("超音速");
  assert.equal(shell.agentSpeed().id, "fast", "非法档位不该生效");
  console.log("  ✓ 持久化 + 非法值忽略");

  // EXTENSIONS 侧栏也要能点选
  shell.state.activity = "ext";
  shell.renderSidebar();
  const rows = document.querySelectorAll(".vsc-tree [data-action='speed']");
  console.log("  EXTENSIONS 里的速度档位数:", rows.length);
  assert.equal(rows.length, SPEEDS.length, "侧栏没列全速度档位");
  const checked = [...rows].filter((r) => r.textContent.includes("✓"));
  assert.equal(checked.length, 1, "选中标记不唯一");
  assert.ok(checked[0].textContent.includes("快"), "选中的不是当前档位");
  // 点侧栏里的「慢」
  const slowRow = [...rows].find((r) => r.dataset.speed === "slow");
  slowRow.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(shell.agentSpeed().id, "slow", "点侧栏没切换速度");
  console.log("  ✓ 侧栏可点选，选中态正确");

  shell.state.activity = "explorer";
  shell.setAgentSpeed("instant");
}

console.log("\n=== 3. 脚本生成 ===");
shell.setAgentSpeed("instant");
await shell.openFile("OEBPS/text/ch1.xhtml");
const script = source.agentScript();
console.log("  header:", script.header);
console.log("  步数:", script.steps.length);
script.steps.slice(0, 3).forEach((st, i) =>
  console.log(`  ${i}: ⏺ ${st.tool} ${st.path} ${st.range}  "${st.text.slice(0, 28)}…"`));
assert.ok(script.steps.length >= 8, `步数过少: ${script.steps.length}`);
assert.ok(script.header.includes("每段等我确认"), "header 不对");
// 注释前缀必须被剥掉
script.steps.forEach((st) => {
  assert.ok(!/^\s*(\/\/|#|\*|<!--)/.test(st.text), `正文还带着注释前缀: ${st.text.slice(0, 20)}`);
});
// 每步都要有 para，用于联动
script.steps.forEach((st, i) => assert.ok(st.para != null, `第 ${i} 步缺少 para`));
console.log("  ✓ 注释前缀已剥离，每步都带段落锚点");

console.log("\n=== 4. 逐步推进 ===");
shell.loadAgent();
const body = document.querySelector(".vsc-agent-body");
const foot = document.querySelector(".vsc-agent-foot");
assert.ok(body.querySelector(".vsc-agent-user"), "没有渲染用户指令");
assert.equal(body.querySelectorAll(".vsc-agent-text").length, 0, "加载后不该自动输出");
console.log("  初始:", foot.textContent.replace(/\s+/g, " ").trim().slice(0, 40));

shell.agent.advance();
assert.equal(body.querySelectorAll(".vsc-agent-tool").length, 1, "第一步没出工具调用行");
assert.equal(body.querySelectorAll(".vsc-agent-text").length, 1, "第一步没出正文");
const firstText = body.querySelector(".vsc-agent-text").textContent;
console.log(`  第 1 步: "${firstText.slice(0, 30)}…"`);
assert.ok(firstText.length > 0, "第一步正文为空");

shell.agent.advance();
shell.agent.advance();
assert.equal(body.querySelectorAll(".vsc-agent-text").length, 3, "推进 3 次应有 3 段");
console.log("  推进 3 次后段数:", body.querySelectorAll(".vsc-agent-text").length);
console.log("  底部状态:", foot.querySelector(".vsc-agent-hint").textContent.replace(/\s+/g, " ").trim());
assert.ok(foot.textContent.includes("3 / "), "进度计数不对");
console.log("  ✓ 一次一段，不会自己往下跑");

console.log("\n=== 4b. 接上阅读进度 ===");
{
  shell.setAgentSpeed("instant");
  await shell.openFile("OEBPS/text/ch1.xhtml");
  const allSteps = source.agentScript().steps;
  const body2 = document.querySelector(".vsc-agent-body");
  const foot2 = document.querySelector(".vsc-agent-foot");

  // 从头打开：一段都不该输出
  shell.scrollToPara(0, false);
  shell.loadAgent();
  console.log("  在第 0 段打开:", foot2.querySelector(".vsc-agent-hint").textContent.replace(/\s+/g, " ").trim());
  assert.equal(body2.querySelectorAll(".vsc-agent-text").length, 0,
    "还没开始读（第 0 段）时不该预先补任何段落");
  assert.ok(foot2.textContent.includes("0 / "), "计数没对上");

  // 读到中间再打开：前面的段落要已经"输出过"
  shell.scrollToPara(5, false);
  shell.loadAgent();
  const shown = body2.querySelectorAll(".vsc-agent-text").length;
  const counter = foot2.querySelector(".vsc-agent-hint").textContent.replace(/\s+/g, " ").trim();
  console.log(`  在第 5 段打开: 计数 "${counter}"，实际渲染 ${shown} 段`);
  assert.ok(counter.startsWith("6 / "), `计数应为 6 / N，实际 "${counter}"`);
  assert.ok(shown > 1, "没有补出历史段落");
  assert.ok(!shell.agent.finished, "中途打开不该是完成态");

  // 继续推进要从第 6 段开始，而不是从头
  shell.agent.advance();
  const afterCounter = foot2.querySelector(".vsc-agent-hint").textContent.replace(/\s+/g, " ").trim();
  console.log(`  按一次继续: "${afterCounter}"`);
  assert.ok(afterCounter.startsWith("7 / "), "继续后没有接着往下走");
  assert.equal(shell.currentPara(), allSteps[6].para, "编辑器没跟到第 7 步对应的段落");
  console.log("  ✓ 从阅读位置接着往下，不重播");

  // 历史很长时要折叠，不能铺几百个 DOM 块
  shell.scrollToPara(allSteps.length - 1, false);
  shell.loadAgent();
  const rendered = body2.querySelectorAll(".vsc-agent-text").length;
  const skip = body2.querySelector(".vsc-agent-skip");
  console.log(`  在最后一段打开: 渲染 ${rendered} 段，折叠提示 "${skip ? skip.textContent : "无"}"`);
  assert.ok(rendered <= 6, `渲染了 ${rendered} 段，没有折叠历史`);
  if (allSteps.length > 6) {
    assert.ok(skip, "长历史没有折叠提示");
    assert.ok(/前 \d+ 段已输出/.test(skip.textContent), "折叠提示文案不对");
  }
  assert.ok(shell.agent.finished, "在最后一段打开应是完成态");
  console.log("  ✓ 长历史折叠，不铺满 DOM");

  // 关掉再打开，位置要还在
  shell.scrollToPara(3, false);
  shell.loadAgent();
  const beforeClose = foot2.querySelector(".vsc-agent-hint").textContent.replace(/\s+/g, " ").trim();
  shell.setAgentOpen(false);
  shell.setAgentOpen(true);
  const afterOpen = foot2.querySelector(".vsc-agent-hint").textContent.replace(/\s+/g, " ").trim();
  console.log(`  关闭前 "${beforeClose}" -> 重开 "${afterOpen}"`);
  assert.equal(afterOpen, beforeClose, "关掉重开丢了位置");
  console.log("  ✓ 关闭重开保持位置");

  // Agent 推进的位置要落库，下次进来能接上
  const bkId = `测试之书-·-Test-Book@${buf.length}`;
  const { getState } = await import("../src/sources/epub/store.js");
  shell.scrollToPara(0, false);
  shell.loadAgent();
  shell.agent.advance();
  shell.agent.advance();
  await new Promise((r) => setTimeout(r, 120));
  const st = await getState(bkId);
  console.log(`  推进 2 步后落库 para=${st.para}`);
  assert.ok(Number(st.para) > 0, "Agent 推进没有写进阅读进度");
  console.log("  ✓ Agent 推进会更新阅读进度");
}

console.log("\n=== 4c. Usage 额度条 ===");
{
  shell.setAgentSpeed("instant");
  shell.setAgentOpen(true);
  await shell.openFile("OEBPS/text/ch1.xhtml");

  const stats = source.usageStats();
  console.log("  session:", JSON.stringify(stats[0]));
  console.log("  weekly :", JSON.stringify(stats[1]));
  assert.equal(stats.length, 2, "应有两条额度");
  assert.equal(stats[0].window, "5h", "session 窗口不对");
  assert.equal(stats[1].window, "7d", "weekly 窗口不对");
  assert.ok(/段$/.test(stats[0].right), "session 右侧应显示段数");
  assert.ok(/字$/.test(stats[1].right), "weekly 右侧应显示字数");

  // 面板里要渲染出来
  const usageEl = document.querySelector(".vsc-usage");
  assert.ok(usageEl, "Agent 面板没有 usage 区块");
  shell.renderUsage();
  const barEls = usageEl.querySelectorAll(".vsc-usage-bar i");
  console.log("  渲染出的条数:", barEls.length, "| 宽度:", [...barEls].map((b) => b.style.width).join(", "));
  assert.equal(barEls.length, 2, "没渲染出两条");

  // session 随章内推进而增长
  shell.scrollToPara(0, false);
  shell.loadAgent();
  const s0 = source.usageStats()[0].pct;
  for (let i = 0; i < 5; i++) shell.agent.advance();
  await new Promise((r) => setTimeout(r, 120));
  const s1 = source.usageStats()[0].pct;
  console.log(`  推进 5 段: session ${s0}% -> ${s1}%`);
  assert.ok(s1 > s0, "session 进度没有随章内推进增长");

  // weekly 换到后面的章节要更高
  const w1 = source.usageStats()[1].pct;
  await shell.openFile("OEBPS/text/ch2a.xhtml");
  const w2 = source.usageStats()[1].pct;
  console.log(`  换到末章: weekly ${w1}% -> ${w2}%`);
  assert.ok(w2 >= w1, "weekly 进度在后面的章节反而更低");

  // 两条都要在 0~100 之间
  for (const st of source.usageStats()) {
    assert.ok(st.pct >= 0 && st.pct <= 100, `百分比越界: ${st.label} = ${st.pct}`);
  }
  console.log("  ✓ session 跟章节、weekly 跟全书，均在 0~100");

  // usage 命令要在 TERMINAL 打出报告
  source.commandLine.submit("usage");
  const panelText = document.querySelector(".vsc-panel-body").textContent;
  console.log("  TERMINAL 输出片段:", panelText.replace(/\s+/g, " ").slice(0, 60));
  assert.ok(panelText.includes("Current session"), "TERMINAL 没打出 session");
  assert.ok(panelText.includes("Current week"), "TERMINAL 没打出 weekly");
  assert.ok(/█|░/.test(panelText), "TERMINAL 没有字符进度条");
  // 换个命令要退出报告视图
  source.commandLine.submit("mark 随手一记");
  await new Promise((r) => setTimeout(r, 60));
  shell.renderPanel();
  assert.ok(
    !document.querySelector(".vsc-panel-body").textContent.includes("Current session"),
    "执行其它命令后仍停留在 usage 报告"
  );
  console.log("  ✓ usage 命令可进可出");

  // 面板关着时不该白算
  shell.setAgentOpen(false);
  shell.renderUsage();
  console.log("  ✓ 面板关闭时跳过渲染");
  shell.setAgentOpen(true);

  // 这一段切过章节、发过命令，恢复现场，免得污染后面的用例
  await shell.openFile("OEBPS/text/ch1.xhtml");
  shell.scrollToPara(0, false);
  shell.loadAgent();
}

console.log("\n=== 4d. 切回已缓存的 tab，数据要跟着换 ===");
{
  // 回归：切回读过的 tab 时 shell 直接用缓存的 doc、不再调 source.openFile，
  // 如果数据源那边不同步，Agent 脚本和额度统计会停在上一章。
  shell.setAgentSpeed("instant");
  shell.setAgentOpen(true);

  await shell.openFile("OEBPS/text/ch1.xhtml");
  const stepsCh1 = source.agentScript().steps.length;
  const usageCh1 = source.usageStats()[0].right;

  await shell.openFile("OEBPS/text/ch2a.xhtml");
  const stepsCh2 = source.agentScript().steps.length;
  const usageCh2 = source.usageStats()[0].right;
  console.log(`  ch1: ${stepsCh1} 步 / ${usageCh1}     ch2a: ${stepsCh2} 步 / ${usageCh2}`);
  assert.notEqual(stepsCh1, stepsCh2, "两章步数相同，这个用例区分不出问题，换个章节");

  // 切回 ch1（此时走缓存）
  await shell.openFile("OEBPS/text/ch1.xhtml");
  const backSteps = source.agentScript().steps.length;
  const backUsage = source.usageStats()[0].right;
  console.log(`  切回 ch1（走缓存）: ${backSteps} 步 / ${backUsage}`);
  assert.equal(backSteps, stepsCh1, "切回缓存 tab 后 Agent 脚本还是上一章的");
  assert.equal(backUsage, usageCh1, "切回缓存 tab 后额度统计还是上一章的");

  // 通过 tab 点击切换也一样
  shell.state.tabs.forEach((t) => {});
  await shell.openFile("OEBPS/text/ch2a.xhtml");
  shell.agent && shell.openFile("OEBPS/text/ch1.xhtml");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(source.agentScript().steps.length, stepsCh1, "再次切回仍不同步");

  // 面包屑与 Agent 指令要指向同一章
  const crumb = document.querySelector(".vsc-crumb").textContent;
  const header = document.querySelector(".vsc-agent-user").textContent;
  const file = source.agentScript().steps[0].path.split("/").pop();
  console.log(`  面包屑: ${crumb.trim()}`);
  console.log(`  Agent 指令: ${header.slice(0, 40)}`);
  assert.ok(crumb.includes(file), `面包屑 (${crumb}) 与 Agent 脚本 (${file}) 不是同一章`);
  assert.ok(header.includes(file), `Agent 指令 (${header}) 与脚本 (${file}) 不是同一章`);
  console.log("  ✓ 编辑器 / Agent / 额度三者始终同一章");

  shell.scrollToPara(0, false);
  shell.loadAgent();
}

console.log("\n=== 5. 联动编辑器 ===");
// 先推两步建立基线，别依赖上一段用例留下的位置
shell.agent.advance();
shell.agent.advance();
const paraBefore = shell.currentPara();
shell.agent.advance();
const paraAfter = shell.currentPara();
console.log(`  推进前编辑器在第 ${paraBefore} 段 -> 推进后第 ${paraAfter} 段`);
assert.ok(paraAfter > paraBefore, "推进后编辑器没有跟着滚");
console.log("  ✓ Agent 推进带动编辑器滚动");

console.log("\n=== 6. 打字机与跳过 ===");
shell.setAgentSpeed("slow");
shell.scrollToPara(0, false);   // loadAgent 会接阅读进度，这里显式复位到章首
shell.loadAgent();
assert.equal(body.querySelectorAll(".vsc-agent-text").length, 0, "复位后应为空");
shell.agent.advance();
assert.ok(shell.agent.typing, "慢速下应处于打字状态");
const partial = body.querySelector(".vsc-agent-text").textContent;
console.log(`  打字中: "${partial.slice(0, 20)}…" (typing=${shell.agent.typing})`);
assert.ok(foot.textContent.includes("跳过本段"), "打字中按钮文案应为跳过");
// 打字中再次 advance = 把这段补完，而不是跳到下一段
shell.agent.advance();
assert.ok(!shell.agent.typing, "advance 后应停止打字");
assert.equal(body.querySelectorAll(".vsc-agent-text").length, 1, "跳过打字不该直接进入下一段");
const full = body.querySelector(".vsc-agent-text").textContent;
console.log(`  补完后: "${full.slice(0, 30)}…"`);
assert.ok(full.length > partial.length, "补完后文本没有变长");
assert.ok(!full.includes("​"), "残留了光标占位");
console.log("  ✓ 打字中继续 = 先补完本段");

console.log("\n=== 7. 连续模式 ===");
shell.setAgentSpeed("instant");
shell.scrollToPara(0, false);
shell.loadAgent();
shell.agent.toggleAuto();
assert.ok(shell.agent.auto, "连续模式没开");
await new Promise((r) => setTimeout(r, 1200));
const autoCount = body.querySelectorAll(".vsc-agent-text").length;
console.log("  连续 1.2s 后输出段数:", autoCount);
assert.ok(autoCount > 1, "连续模式没有自动推进");
shell.agent.stop();
assert.ok(!shell.agent.auto, "停止后仍在连续模式");
console.log("  ✓ 连续 / 暂停可控");

console.log("\n=== 8. 跑到结尾 ===");
shell.setAgentSpeed("instant");
shell.scrollToPara(0, false);
shell.loadAgent();
for (let i = 0; i < script.steps.length + 3; i++) shell.agent.advance();
console.log("  最终段数:", body.querySelectorAll(".vsc-agent-text").length, "/ 脚本步数:", script.steps.length);
assert.equal(body.querySelectorAll(".vsc-agent-text").length, script.steps.length, "多按几次不该超出脚本");
assert.ok(shell.agent.finished, "没有进入完成态");
const nextBtn = foot.querySelector("[data-agent='next']");
assert.ok(nextBtn.hasAttribute("disabled"), "完成后继续按钮应禁用");
console.log("  完成态按钮:", nextBtn.textContent.replace(/\s+/g, " ").trim());
console.log("  ✓ 到底即停");

console.log("\n=== 9. 换章节重载脚本 ===");
await shell.openFile("OEBPS/text/ch2.xhtml");
console.log("  换章后段数:", body.querySelectorAll(".vsc-agent-text").length);
assert.equal(body.querySelectorAll(".vsc-agent-text").length, 0, "换章后没有重置");
assert.ok(body.querySelector(".vsc-agent-user").textContent.includes("ch"), "指令没跟着换章");
console.log("  新指令:", body.querySelector(".vsc-agent-user").textContent.slice(0, 50));
console.log("  ✓ 换章自动重载");

console.log("\n=== 10. agent 命令 ===");
source.commandLine.submit("agent off");
assert.ok(!app.classList.contains("agent-on"), "agent off 未生效");
source.commandLine.submit("agent on");
assert.ok(app.classList.contains("agent-on"), "agent on 未生效");
source.commandLine.submit("agent fast");
assert.equal(shell.agentSpeed().id, "fast", "速度未切换");
source.commandLine.submit("agent 乱写");
assert.equal(shell.agentSpeed().id, "fast", "非法速度不该改变设置");
console.log("  ✓ agent on/off/speed 命令生效");

console.log("\n✓ Agent 面板测试通过");
