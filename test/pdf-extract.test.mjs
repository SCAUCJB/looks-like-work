/** PDF 文本重建测试：纯函数，用构造的坐标数据验证段落还原 */
import assert from "node:assert/strict";
import {
  itemsToLines, linesToParagraphs, findRunningHeads, normalizeHead, joinLine,
} from "../src/sources/pdf/extract.js";

/** 造一个文本片段（y 越大越靠上，PDF 坐标原点在左下角） */
const item = (str, x, y, size = 12, w = null) => ({
  str, transform: [size, 0, 0, size, x, y], width: w ?? str.length * size * 0.5, height: size,
});

console.log("=== 1. 片段聚成行 ===");
{
  // 同一行被拆成三段（PDF 里很常见），y 略有抖动
  const lines = itemsToLines([
    item("这是一行", 72, 700),
    item("被拆开的", 120, 700.3),
    item("文字", 168, 699.8),
    item("第二行", 72, 686),
  ]);
  lines.forEach((l) => console.log(`  y=${l.y.toFixed(1)} x=${l.x}  "${l.text}"`));
  assert.equal(lines.length, 2, "行聚合错误");
  assert.equal(lines[0].text, "这是一行被拆开的文字", "同行片段没拼起来，或中文之间多了空格");
  assert.equal(lines[1].text, "第二行", "第二行不对");
  // y 大的在前（阅读顺序）
  assert.ok(lines[0].y > lines[1].y, "行顺序反了");
  console.log("  ✓ y 抖动容忍、按阅读顺序、中文无空格");
}

console.log("\n=== 2. 英文词间要补空格 ===");
{
  const lines = itemsToLines([
    item("Hello", 72, 700, 12, 30),
    item("world", 110, 700, 12, 30),   // 有间距
  ]);
  console.log(`  "${lines[0].text}"`);
  assert.equal(lines[0].text, "Hello world", "英文之间没补空格");
}

console.log("\n=== 3. 段落重建：行距决定分段 ===");
{
  const size = 12;
  const mk = (t, y, x = 72) => ({ text: t, x, y, size });
  // 行距 14 是正文；第三行之前空了 30，应该分段
  const pages = [[
    mk("第一段的第一行", 700),
    mk("第一段的第二行", 686),
    mk("第二段开始了", 656),
    mk("第二段第二行", 642),
  ]];
  const paras = linesToParagraphs(pages, new Set());
  paras.forEach((p, i) => console.log(`  [${i}] p${p.page} "${p.text}"`));
  assert.equal(paras.length, 2, `应分成 2 段，实际 ${paras.length}`);
  assert.equal(paras[0].text, "第一段的第一行第一段的第二行");
  assert.equal(paras[1].text, "第二段开始了第二段第二行");
  console.log("  ✓ 按行距分段");
}

console.log("\n=== 4. 缩进也意味着新段落 ===");
{
  const size = 12;
  const mk = (t, y, x = 72) => ({ text: t, x, y, size });
  const pages = [[
    mk("正文第一行", 700),
    mk("正文第二行", 686),
    mk("缩进的新段", 672, 96),   // 行距一样，但缩进了
  ]];
  const paras = linesToParagraphs(pages, new Set());
  console.log("  段数:", paras.length, paras.map((p) => `"${p.text}"`).join(" "));
  assert.equal(paras.length, 2, "缩进没有触发新段落");
}

console.log("\n=== 5. 页眉页脚要剔除 ===");
{
  const size = 10;
  const mk = (t, y, x = 72) => ({ text: t, x, y, size });
  // 6 页，每页顶部书名、底部页码（页码每页不同），中间是正文。
  // 每页给足行数，贴近真实 PDF——行数太少的页面算法会跳过不统计
  const pages = Array.from({ length: 6 }, (_, i) => [
    mk("某某某著 · 第三章", 780),
    mk(`这是第 ${i + 1} 页的正文内容`, 700),
    ...Array.from({ length: 5 }, (_, k) => mk(`正文第 ${i + 1}-${k} 行`, 686 - k * 14)),
    mk(`- ${i + 10} -`, 60),
  ]);
  const heads = findRunningHeads(pages);
  console.log("  识别出的页眉页脚:", [...heads].map((h) => `"${h}"`).join(", "));
  assert.ok(heads.size >= 2, `没识别出页眉页脚，只找到 ${heads.size} 个`);
  assert.ok(heads.has(normalizeHead("某某某著 · 第三章")), "书名页眉没识别出来");
  assert.ok(heads.has(normalizeHead("- 10 -")), "页码没识别出来（数字应归一化）");

  const paras = linesToParagraphs(pages, heads);
  const joined = paras.map((p) => p.text).join("\n");
  console.log("  正文:", joined.replace(/\n/g, " / ").slice(0, 60));
  assert.ok(!joined.includes("某某某著"), "页眉混进正文了");
  assert.ok(!/- \d+ -/.test(joined), "页码混进正文了");
  assert.ok(joined.includes("这是第 1 页的正文内容"), "正文被误删了");
  console.log("  ✓ 页眉页脚剔除、页码归一化、正文保留");
}

console.log("\n=== 5b. 短页的正文不能被当成页眉 ===");
{
  const size = 10;
  const mk = (t, y, x = 72) => ({ text: t, x, y, size });
  // 章节末页只有两三行正文，且每页结构相似——按「前两行后两行」取候选就会误删
  const pages = Array.from({ length: 8 }, (_, i) => [
    mk("书名页眉", 780),
    ...Array.from({ length: 6 }, (_, k) => mk(`第 ${i} 页正文 ${k}`, 700 - k * 14)),
    mk(`${i + 1}`, 60),
  ]);
  // 插入一个只有两行的短页（章节结尾）
  pages.push([mk("书名页眉", 780), mk("全书完", 700)]);

  const heads = findRunningHeads(pages);
  const paras = linesToParagraphs(pages, heads);
  const joined = paras.map((p) => p.text).join("\n");
  console.log("  识别出:", [...heads].map((h) => `"${h}"`).join(", ") || "(无)");
  console.log("  末页内容保留:", joined.includes("全书完"));
  assert.ok(heads.has(normalizeHead("书名页眉")), "页眉没识别出来");
  assert.ok(joined.includes("全书完"), "短页的正文被当成页眉删掉了 —— 这会丢内容");
  assert.ok(joined.includes("第 0 页正文 0"), "正文被误删");
  console.log("  ✓ 短页正文安全");
}

console.log("\n=== 6. 英文连字符换行要合并 ===");
{
  assert.equal(joinLine("inter-", "national"), "international", "连字符没合并");
  assert.equal(joinLine("hello", "world"), "hello world", "英文之间要空格");
  assert.equal(joinLine("中文", "接续"), "中文接续", "中文之间不该有空格");
  assert.equal(joinLine("", "开头"), "开头", "空缓冲处理错误");
  // 大写开头不是连字符换行（可能是专有名词）
  assert.equal(joinLine("Co-", "Operation"), "Co- Operation", "大写不该被当成连字符换行");
  console.log("  ✓ 连字符 / 中英空格规则");
}

console.log("\n=== 7. 跨页续行 ===");
{
  const size = 12;
  const mk = (t, y, x = 72) => ({ text: t, x, y, size });
  const pages = [
    [mk("这一段在第一页没有", 700), mk("写完继续到", 686)],
    [mk("第二页接着写完了", 700)],        // 没缩进 -> 续行
  ];
  const paras = linesToParagraphs(pages, new Set());
  console.log("  段数:", paras.length, `"${paras[0].text}"`);
  assert.equal(paras.length, 1, "跨页被错误地断成了两段");
  assert.ok(paras[0].text.includes("第二页接着写完了"), "跨页内容丢了");
  console.log("  ✓ 跨页续行不断段");
}

console.log("\n=== 8. 边界情况 ===");
{
  assert.deepEqual(itemsToLines([]), [], "空输入");
  assert.deepEqual(linesToParagraphs([], new Set()), [], "空页");
  assert.deepEqual(linesToParagraphs([[]], new Set()), [], "空页内容");
  assert.equal(findRunningHeads([[], []]).size, 0, "页数太少不该判定页眉");
  // 全空白片段不该产出行
  assert.equal(itemsToLines([item("   ", 72, 700)]).length, 0, "空白片段产出了行");
  console.log("  ✓ 空输入不崩");
}

console.log("\n✓ PDF 文本重建测试通过");
