/** Usage 额度条测试：纯函数部分 */
import assert from "node:assert/strict";
import { barText, usageLines, usageHtml, resetHint } from "../src/shell/usage.js";

console.log("=== 1. 字符进度条 ===");
for (const p of [0, 25, 50, 75, 100]) {
  const bar = barText(p);
  console.log(`  ${String(p).padStart(3)}%  ${bar}`);
  assert.equal(bar.length, 20, `进度条长度应恒为 20，实际 ${bar.length}`);
}
assert.equal(barText(0), "░".repeat(20), "0% 应全空");
assert.equal(barText(100), "█".repeat(20), "100% 应全满");
// 越界与非法值
assert.equal(barText(-50), "░".repeat(20), "负数应夹到 0");
assert.equal(barText(999), "█".repeat(20), "超 100 应夹到 100");
assert.equal(barText(NaN).length, 20, "NaN 不该产出畸形进度条");
assert.equal(barText(undefined).length, 20, "undefined 不该产出畸形进度条");
console.log("  ✓ 长度恒定、越界夹取、非法值兜底");

console.log("\n=== 2. 终端报告 ===");
const bars = [
  { label: "Current session", window: "5h", resets: "resets 21:30", pct: 58, right: "14/24 段" },
  { label: "Current week (all chapters)", window: "7d", resets: "resets Tue", pct: 19, right: "2.1万/11.0万 字" },
];
const lines = usageLines(bars);
lines.forEach((l) => console.log(`  │${l}`));
assert.ok(lines.some((l) => l.includes("Current session (5h)")), "缺少 session 标题");
assert.ok(lines.some((l) => l.includes("58% used")), "缺少百分比");
assert.ok(lines.some((l) => l.includes("14/24 段")), "缺少右侧真实信息");
assert.ok(lines.some((l) => l.includes("resets 21:30")), "缺少重置提示");
assert.equal(usageLines([]).length, 0, "空输入应返回空");
// 长标题不能把 resets 挤得没空格
const titleLines = lines.filter((l) => l.includes("resets"));
titleLines.forEach((l) => assert.ok(/\)\s{2,}resets/.test(l), `标题与 resets 之间没留空: "${l}"`));
// 两行标题的 resets 要对齐在同一列
const cols = titleLines.map((l) => l.indexOf("resets"));
assert.equal(new Set(cols).size, 1, `resets 没对齐，列位置: ${cols.join(", ")}`);
console.log("  ✓ 报告完整");

console.log("\n=== 3. HTML 进度条 ===");
const html = usageHtml(bars);
assert.ok(html.includes("width:58%"), "条宽没按百分比");
assert.ok(html.includes("width:19%"), "第二条宽度不对");
assert.ok(html.includes("58% used"), "缺少百分比文案");
// 色阶：高百分比要换色
assert.ok(!usageHtml([{ label: "a", window: "5h", pct: 30 }]).includes('class="high"'), "30% 不该是 high");
assert.ok(usageHtml([{ label: "a", window: "5h", pct: 80 }]).includes('class="high"'), "80% 应为 high");
assert.ok(usageHtml([{ label: "a", window: "5h", pct: 100 }]).includes('class="done"'), "100% 应为 done");
// 越界不能溢出容器
assert.ok(usageHtml([{ label: "a", window: "5h", pct: 300 }]).includes("width:100%"), "超 100% 没夹住");
// XSS
const evil = usageHtml([{ label: "<img src=x onerror=alert(1)>", window: "5h", pct: 10, right: "<b>x</b>" }]);
assert.ok(!evil.includes("<img"), "label 没转义");
assert.ok(!evil.includes("<b>"), "right 没转义");
console.log("  ✓ 宽度、色阶、越界夹取、HTML 转义");

console.log("\n=== 4. 重置时间 ===");
const h5 = resetHint(5);
const d7 = resetHint(24 * 7);
console.log(`  5 小时后: ${h5}`);
console.log(`  7 天后:   ${d7}`);
assert.ok(/^resets \d{2}:\d{2}$/.test(h5), `5 小时应是 HH:MM 格式，实际 ${h5}`);
assert.ok(/^resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(d7), `7 天应是星期，实际 ${d7}`);
console.log("  ✓ 格式正确");

console.log("\n✓ Usage 测试通过");
