/** 伪装代码生成器测试：确定性、连贯性、语法合理性 */
import assert from "node:assert/strict";
import { createCodeGen, DENSITIES, densityOf, DEFAULT_DENSITY } from "../src/sources/epub/codegen.js";
import { mulberry32, hashStr } from "../src/shell/util.js";

const STYLE_LIST = [
  { id: "markdown", cstyle: "hash" },
  { id: "javascript", cstyle: "slash" },
  { id: "typescript", cstyle: "slash" },
  { id: "python", cstyle: "hash" },
  { id: "rust", cstyle: "slash" },
  { id: "html", cstyle: "html" },
];

const mk = (style, seed = 42) => createCodeGen({
  style,
  rand: mulberry32(seed),
  bookIdent: "the_book",
  chapterIdent: "chapter_one",
});

console.log("=== 1. 密度档位 ===");
DENSITIES.forEach((d) => console.log(`  ${d.id.padEnd(5)} ${d.label.padEnd(5)} chance=${d.chance}`));
assert.equal(densityOf("off").chance, 0, "off 档必须是 0");
assert.equal(densityOf("不存在").id, DEFAULT_DENSITY, "非法档位应回落默认");
assert.ok(densityOf("high").chance > densityOf("low").chance, "high 应比 low 密");

console.log("\n=== 2. 各语言片段样例 ===");
for (const style of STYLE_LIST) {
  console.log(`\n  --- ${style.id} ---`);
  const gen = mk(style);
  for (let i = 0; i < 4; i++) {
    gen.snippet().rows.forEach((r) => console.log(`  │${r.text}`));
    console.log("  │");
  }
}

console.log("\n=== 3. 确定性：同种子必须逐字符一致 ===");
for (const style of STYLE_LIST) {
  const a = [];
  const b = [];
  const g1 = mk(style, 12345);
  const g2 = mk(style, 12345);
  for (let i = 0; i < 12; i++) {
    a.push(...g1.snippet().rows.map((r) => r.text));
    b.push(...g2.snippet().rows.map((r) => r.text));
  }
  assert.deepEqual(a, b, `${style.id} 同种子产出不一致（重开书内容会乱跳）`);
}
console.log("  ✓ 6 种风格各 12 次产出完全可复现");

console.log("\n=== 4. 不同种子要产出不同内容 ===");
const s1 = mk(STYLE_LIST[1], 1).snippet().rows.map((r) => r.text).join("\n");
const s2 = mk(STYLE_LIST[1], 99999).snippet().rows.map((r) => r.text).join("\n");
console.log("  seed=1     :", s1.split("\n")[0]);
console.log("  seed=99999 :", s2.split("\n")[0]);
assert.notEqual(s1, s2, "不同种子产出相同，说明没真的用上随机");

console.log("\n=== 5. 变量连贯性：引用的变量必须先声明过 ===");
for (const style of STYLE_LIST) {
  if (style.id === "html") continue;      // html 片段不涉及变量引用
  const gen = mk(style, 777);
  const all = [];
  for (let i = 0; i < 40; i++) all.push(...gen.snippet().rows.map((r) => r.text));
  const declared = new Set(gen.declared);
  // 收集所有「疑似变量引用」的位置：出现在 .prop / .push / for..of / len() 里的标识符
  const refs = [];
  for (const line of all) {
    for (const m of line.matchAll(/\b([a-z][a-zA-Z0-9_]*)\s*(?:\.(?:id|href|depth|words|offset|title|kind|level|at|push|append|iter|len)\b|\.length\b)/g)) {
      refs.push(m[1]);
    }
  }
  // 函数参数在函数体内引用自己是合法的，先把参数名收集出来
  const params = new Set();
  for (const line of all) {
    for (const m of line.matchAll(/(?:function \w+|def \w+)\(([a-z]\w*)/g)) params.add(m[1]);
  }
  const unknown = refs.filter((r) =>
    // 这些是模板里的局部变量/内置对象，不需要出现在声明池里
    !declared.has(r) && !params.has(r) &&
    !["the_book", "chapter_one", "console", "logger", "reader",
      "x", "item", "acc", "sum", "total", "Object"].includes(r)
  );
  console.log(`  ${style.id.padEnd(11)} 声明 ${gen.declared.length} 个，引用检查 ${refs.length} 处，函数参数 ${params.size} 个，可疑 ${unknown.length}`);
  assert.equal(unknown.length, 0, `${style.id} 引用了未声明的变量: ${[...new Set(unknown)].join(", ")}`);
  // 函数参数在函数外不可见，绝不能进声明池，否则后面的片段会引用一个不存在的变量
  const leaked = [...params].filter((p) => declared.has(p));
  assert.equal(leaked.length, 0, `${style.id} 函数参数泄漏进了声明池: ${leaked.join(", ")}`);
}
console.log("  ✓ 没有凭空出现的变量");

console.log("\n=== 6. 不重复声明同名变量 ===");
for (const style of STYLE_LIST) {
  const gen = mk(style, 555);
  for (let i = 0; i < 60; i++) gen.snippet();
  const dup = gen.declared.filter((n, i) => gen.declared.indexOf(n) !== i);
  console.log(`  ${style.id.padEnd(11)} 声明 ${gen.declared.length} 个，重名 ${dup.length}`);
  assert.equal(dup.length, 0, `${style.id} 重复声明: ${dup.join(", ")}`);
}
console.log("  ✓ 无重名声明");

console.log("\n=== 6b. 类型自洽：push/for-of/filter 只能用在数组上 ===");
for (const style of STYLE_LIST) {
  if (style.id === "html" || style.id === "markdown") continue;
  const gen = createCodeGen({
    style, rand: mulberry32(8899), bookIdent: "the_book", chapterIdent: "chapter_one",
  });
  const all = [];
  for (let i = 0; i < 80; i++) all.push(...gen.snippet().rows.map((r) => r.text));
  const typed = gen.declaredTyped;
  const kindOf = new Map(typed.map((d) => [d.name, d.kind]));

  // 收集「被当成数组用」的标识符
  const asArray = [];
  for (const line of all) {
    for (const re of [
      /\b([a-z]\w*)\.push\(/g,
      /\b([a-z]\w*)\.append\(/g,
      /for (?:const )?item (?:of|in) &?([a-z]\w*)/g,
      /\blen\(([a-z]\w*)\)/g,
      /\b([a-z]\w*)\.len\(\)/g,
      /\b([a-z]\w*)\.length\b/g,
      /for x in ([a-z]\w*) if x/g,
    ]) {
      for (const m of line.matchAll(re)) asArray.push(m[1]);
    }
  }
  const wrong = [...new Set(asArray)].filter((n) => kindOf.has(n) && kindOf.get(n) !== "array");
  const arrCount = typed.filter((d) => d.kind === "array").length;
  console.log(`  ${style.id.padEnd(11)} 声明 ${typed.length} 个（数组 ${arrCount}），数组用法 ${asArray.length} 处，类型不符 ${wrong.length}`);
  assert.equal(wrong.length, 0, `${style.id} 把非数组当数组用: ${wrong.join(", ")}`);
}
console.log("  ✓ 没有 Object.create(null) 后面接 .push 这类破绽");

console.log("\n=== 6c. 纯中文书名不该把 ch_xxx 塞进代码 ===");
{
  const gen = createCodeGen({
    style: STYLE_LIST[1], rand: mulberry32(11), bookIdent: "ch_fhi", chapterIdent: "ch_abc",
  });
  const all = [];
  for (let i = 0; i < 60; i++) all.push(...gen.snippet().rows.map((r) => r.text));
  const bad = all.filter((l) => /\bch_[a-z0-9]+\b/.test(l));
  bad.slice(0, 3).forEach((l) => console.log("  ✗", l));
  assert.equal(bad.length, 0, "代码里出现了 hash 兜底标识符 ch_xxx");
  console.log("  ✓ 已换成普通标识符");
}

console.log("\n=== 7. 输出形状合规 ===");
for (const style of STYLE_LIST) {
  const gen = mk(style, 31);
  for (let i = 0; i < 30; i++) {
    const { rows } = gen.snippet();
    assert.ok(Array.isArray(rows) && rows.length > 0, `${style.id} 产出空片段`);
    rows.forEach((r) => {
      assert.ok(typeof r.text === "string", `${style.id} row.text 不是字符串`);
      assert.ok(r.type === "code", `${style.id} 片段应为 code 类型（才会走语法着色），实际 ${r.type}`);
      assert.ok(!r.text.includes("undefined"), `${style.id} 片段里漏出 undefined: ${r.text}`);
      assert.ok(!r.text.includes("NaN"), `${style.id} 片段里漏出 NaN: ${r.text}`);
      assert.ok(!/\{[a-z]+\}/.test(r.text), `${style.id} 模板占位符未替换: ${r.text}`);
    });
  }
}
console.log("  ✓ 无 undefined / NaN / 未替换占位符");

console.log("\n=== 8. markdown 的围栏必须成对 ===");
{
  const gen = mk(STYLE_LIST[0], 2024);
  let opens = 0;
  for (let i = 0; i < 60; i++) {
    const rows = gen.snippet().rows;
    const fences = rows.filter((r) => /^```/.test(r.text));
    assert.ok(fences.length === 0 || fences.length === 2, `围栏数不是 0 或 2: ${fences.length}`);
    if (fences.length === 2) {
      assert.ok(fences[0].text.length > 3, "开围栏应带语言标记");
      assert.equal(fences[1].text, "```", "闭围栏应是裸 ```");
      opens += 1;
    }
  }
  console.log(`  60 次里 ${opens} 次产出围栏代码块，全部成对`);
}

console.log("\n=== 9. 连续注释行不能超上限 ===");
{
  const { DOMParser: DP, parseHTML } = await import("linkedom");
  const { document: doc2, window: win2 } = parseHTML("<html><body></body></html>");
  class BL {
    parseFromString(str, type) {
      const p = new DP();
      return (type === "text/html" && !/^\s*<(!doctype|html)\b/i.test(str))
        ? p.parseFromString(`<html><body>${str}</body></html>`, "text/html")
        : p.parseFromString(str, type);
    }
  }
  globalThis.DOMParser = BL;
  globalThis.document = doc2;
  globalThis.window = win2;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  const { renderChapter } = await import("../src/sources/epub/chapter.js");
  const { DENSITIES: D } = await import("../src/sources/epub/codegen.js");

  // 一个超长段落：折行后会有几十行注释
  const longOne = "这是一个特别长的段落，".repeat(40);
  const bytes = new TextEncoder().encode(
    `<html><body><h1>长段</h1><p>${longOne}</p><p>${longOne}</p></body></html>`
  );

  /** 数一数最长的一串连续 comment 行 */
  const longestRun = (rows) => {
    let max = 0, cur = 0;
    for (const r of rows) {
      if (r.type === "comment" && r.para != null) {
        cur += 1;
        max = Math.max(max, cur);
      } else if (r.type === "code") {
        cur = 0;                // 只有真代码才算打断
      }
      // plain 空行不重置：空行本身不构成"有代码"
    }
    return max;
  };

  const style = { id: "markdown", label: "Markdown", ext: "md", cstyle: "hash" };
  const base = { bytes, href: "long.xhtml", title: "长段", bookTitle: "书", author: "人",
                 style, blobUrlFor: () => "", wrapCols: 60 };

  console.log("  --- 显式指定上限 ---");
  for (const limit of [4, 6, 10]) {
    const out = renderChapter({ ...base, density: "mid", maxRun: limit });
    const run = longestRun(out.rows);
    console.log(`    maxRun=${String(limit).padStart(2)} -> 最长连续注释 ${run} 行，总行数 ${out.rows.length}`);
    assert.ok(run <= limit, `maxRun=${limit} 时出现了 ${run} 行连续注释`);
  }

  console.log("  --- 跟随密度档位 ---");
  for (const d of D.filter((x) => x.id !== "off")) {
    const out = renderChapter({ ...base, density: d.id });
    const run = longestRun(out.rows);
    console.log(`    ${d.id.padEnd(4)}(maxRun=${d.maxRun}) -> 最长连续注释 ${run} 行`);
    assert.ok(run <= d.maxRun, `${d.id} 档位应限制在 ${d.maxRun} 行，实际 ${run}`);
  }

  console.log("  --- off 档不切分 ---");
  {
    const out = renderChapter({ ...base, density: "off" });
    const run = longestRun(out.rows);
    const codeRows = out.rows.filter((r) => r.type === "code" && !/^# /.test(r.text));
    console.log(`    off -> 最长连续注释 ${run} 行，伪装代码 ${codeRows.length} 行`);
    assert.equal(codeRows.length, 0, "off 档不该有伪装代码");
    assert.ok(run > 10, "off 档不该切分段落");
  }

  console.log("  --- 切分不能破坏段落锚点 ---");
  {
    const out = renderChapter({ ...base, density: "high", maxRun: 4 });
    const paras = [...new Set(out.rows.filter((r) => r.para != null).map((r) => r.para))];
    console.log(`    段落锚点: ${paras.join(",")}（原文 2 段 + 标题）`);
    assert.equal(paras.length, out.paras, `锚点数 ${paras.length} != 段落数 ${out.paras}`);
    assert.deepEqual(paras, paras.map((_, i) => i), "锚点不连续，阅读进度会乱");
  }

  console.log("  --- 切开处必须真的有代码 ---");
  {
    const out = renderChapter({ ...base, density: "mid", maxRun: 5 });
    // 同一段落被切开时，两段注释之间必须夹着 code 行
    let breaks = 0;
    for (let i = 1; i < out.rows.length; i++) {
      const a = out.rows[i - 1], b = out.rows[i];
      if (a.para != null && b.para != null && a.para === b.para && a !== b) continue;
    }
    // 直接数：同 para 的 comment 行之间出现过 code，就说明切开处插了代码
    const byPara = new Map();
    out.rows.forEach((r, i) => {
      if (r.para == null) return;
      if (!byPara.has(r.para)) byPara.set(r.para, []);
      byPara.get(r.para).push(i);
    });
    for (const [para, idxs] of byPara) {
      if (idxs.length < 2) continue;
      for (let k = 1; k < idxs.length; k++) {
        if (idxs[k] - idxs[k - 1] > 1) {
          const between = out.rows.slice(idxs[k - 1] + 1, idxs[k]);
          assert.ok(
            between.some((r) => r.type === "code"),
            `段落 ${para} 被切开了但中间没插代码`
          );
          breaks += 1;
        }
      }
    }
    console.log(`    段内切开 ${breaks} 处，每处都插了代码`);
    assert.ok(breaks > 0, "长段落没有被切开");
  }

  console.log("  ✓ 上限生效、锚点完整、切开处有代码");
}

console.log("\n✓ 伪装代码生成器测试通过");
