/** 折行算法单测（纯函数，不需要 DOM） */
import assert from "node:assert/strict";
import { wrapLine, wrapText, strWidth, charWidth } from "../src/shell/wrap.js";

console.log("=== 显示宽度 ===");
assert.equal(charWidth("中"), 2);
assert.equal(charWidth("a"), 1);
assert.equal(strWidth("中文abc"), 4 + 3);
assert.equal(strWidth(""), 0);
console.log("  中=2 a=1 '中文abc'=7  ✓");

console.log("\n=== 中文段落按字断行 ===");
const cn = "这是一段很长的中文段落".repeat(6);   // 11 字 * 6 = 66 字 = 132 列
const cnLines = wrapLine(cn, 40);
cnLines.forEach((l) => console.log(`  [${String(strWidth(l)).padStart(2)}] ${l}`));
cnLines.forEach((l) => assert.ok(strWidth(l) <= 40, `超宽: ${strWidth(l)}`));
assert.equal(cnLines.join(""), cn, "中文折行后内容丢失或改变");
console.log("  ✓ 每行 <=40 列且内容无损");

console.log("\n=== 英文在空格处断，不切断单词 ===");
const en = "The quick brown fox jumps over the lazy dog and then keeps running far away";
const enLines = wrapLine(en, 30);
enLines.forEach((l) => console.log(`  [${String(strWidth(l)).padStart(2)}] ${l}`));
enLines.forEach((l) => assert.ok(strWidth(l) <= 30, `超宽: ${strWidth(l)}`));
assert.equal(enLines.join(" ").replace(/\s+/g, " "), en, "英文折行后内容改变");
// 每行都不应以半个单词结尾（除超长词）
enLines.forEach((l) => assert.ok(!/\w$/.test(l) || en.includes(l), "单词被切断"));
console.log("  ✓ 按词断行，内容无损");

console.log("\n=== 超长单词 / URL 硬切 ===");
const url = "see https://example.com/a/very/long/path/that/never/ends/and/keeps/going/forever end";
const urlLines = wrapLine(url, 28);
urlLines.forEach((l) => console.log(`  [${String(strWidth(l)).padStart(2)}] ${l}`));
urlLines.forEach((l) => assert.ok(strWidth(l) <= 28, `超宽: ${strWidth(l)}`));
console.log("  ✓ 超长 token 被硬切但不超宽");

console.log("\n=== 图片占位符不可切断 ===");
const withImg = "前面的文字".repeat(8) + " ⟦IMG:3⟧ " + "后面的文字".repeat(8);
const imgLines = wrapLine(withImg, 30);
imgLines.forEach((l) => console.log(`  [${String(strWidth(l)).padStart(2)}] ${l}`));
const joined = imgLines.join("");
assert.ok(joined.includes("⟦IMG:3⟧"), "图片占位符被折断了");
assert.equal((joined.match(/⟦IMG:3⟧/g) || []).length, 1, "占位符数量异常");
console.log("  ✓ ⟦IMG:3⟧ 完整保留");

console.log("\n=== 中英混排 ===");
const mix = "他说 hello world 然后又说 goodbye everyone 接着离开了房间并关上了门";
const mixLines = wrapLine(mix, 24);
mixLines.forEach((l) => console.log(`  [${String(strWidth(l)).padStart(2)}] ${l}`));
mixLines.forEach((l) => assert.ok(strWidth(l) <= 24, `超宽: ${strWidth(l)}`));
console.log("  ✓ 混排不超宽");

console.log("\n=== 边界情况 ===");
assert.deepEqual(wrapLine("", 40), [""], "空行应原样保留");
assert.deepEqual(wrapLine("   ", 40), ["   "], "纯空白行应原样保留");
assert.deepEqual(wrapLine("短", 40), ["短"], "短行不该被改");
assert.equal(wrapText("第一行\n\n第三行", 40), "第一行\n\n第三行", "空行结构被破坏");
const long = wrapText("中".repeat(100) + "\n" + "英".repeat(100), 50);
assert.equal(long.split("\n").length, 8, `折行数不对: ${long.split("\n").length}`);
console.log("  ✓ 空行 / 纯空白 / 短行 / 多行结构都正确");

console.log("\n✓ 折行测试通过");
