/**
 * 「部 → 章」结构测试。
 *
 * 症状是「每一部分的第一章目录错位」。根因在 TOC 索引的**先到先得**：
 * 「第一部分」这类壳条目的 href 往往直接指向它第一章的文件，
 * 壳先占住 href，第一章再来就没位置了——于是每部分的第一章
 * 要么凭空消失、要么被降级成锚点排到末尾。
 *
 * 下面四种写法覆盖了壳的常见形态，用来钉住「壳让位给第一章」这条规则。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DOMParser, parseHTML } from "linkedom";

const { document, window } = parseHTML("<html><body></body></html>");
class BL {
  parseFromString(s, t) {
    const p = new DOMParser();
    return (t === "text/html" && !/^\s*<(!doctype|html)\b/i.test(s))
      ? p.parseFromString(`<html><body>${s}</body></html>`, "text/html")
      : p.parseFromString(s, t);
  }
}
globalThis.DOMParser = BL;
globalThis.document = document;
globalThis.window = window;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.URL.createObjectURL = () => "blob:x";

const { unzip } = await import("../src/sources/epub/unzip.js");
const { createEpubAdapter } = await import("../src/sources/epub/adapter.js");
const { createBookSource } = await import("../src/sources/epub/source.js");

async function load(name) {
  const buf = await readFile(join(import.meta.dirname, "fixtures", `${name}.epub`));
  const files = await unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const adapter = createEpubAdapter(files);
  const source = createBookSource({ adapter, size: 1, onOpenLibrary: () => {} });
  return { adapter, tree: source.tree()[0].children || [] };
}

function show(nodes, d = 0) {
  nodes.forEach((n) => {
    const tag = n.kind === "folder" ? "📁" : "📄";
    console.log(`    ${"│  ".repeat(d)}${tag} ${n.label}${n.hint && n.hint !== n.label ? `   « ${n.hint}` : ""}`);
    if (n.children) show(n.children, d + 1);
  });
}

/** 文件夹 -> 它下面所有叶子的真实标题（hint 优先，文件名是 slug 看不出内容） */
const titlesUnder = (folder) =>
  (folder.children || []).flatMap((n) =>
    n.kind === "folder" ? titlesUnder(n) : [n.hint || n.label]);

/** 四种壳的写法，期望结果完全一致 */
const CASES = [
  ["part-e1", "每部有独立扉页文件（基线）", true],
  ["part-e2", "壳的 href 指向第一章的文件", false],
  ["part-e3", "壳指向第一章文件，子条目带锚点", false],
  ["part-e4", "壳是没有链接的分组标题", false],
];

for (const [name, desc, hasFrontPage] of CASES) {
  console.log(`\n=== ${name}：${desc} ===`);
  const { tree } = await load(name);
  show(tree);

  const parts = tree.filter((n) => n.kind === "folder");
  assert.equal(parts.length, 2, `${name}: 应该有两个部分`);
  assert.equal(parts[0].label, "第一部分", `${name}: 第一部分标题丢了`);
  assert.equal(parts[1].label, "第二部分", `${name}: 第二部分标题丢了`);

  const first = titlesUnder(parts[0]);
  const second = titlesUnder(parts[1]);

  // 核心断言：每部分的第一章必须在，而且排在最前
  const firstChapters = first.filter((t) => /^第\d章$/.test(t));
  const secondChapters = second.filter((t) => /^第\d章$/.test(t));
  assert.deepEqual(firstChapters, ["第1章", "第2章"], `${name}: 第一部分的章节不对`);
  assert.deepEqual(secondChapters, ["第3章", "第4章"], `${name}: 第二部分的章节不对`);

  // 有独立扉页的那本，扉页作为第一个子项保留（它是真实存在的文件，得能点开）
  if (hasFrontPage) {
    assert.ok(first.includes("第一部分"), `${name}: 扉页内容应该仍可访问`);
  } else {
    assert.ok(!first.includes("第一部分"), `${name}: 壳不该再生成一个文件节点`);
  }

  console.log(`  ✓ 两部分各 ${firstChapters.length} / ${secondChapters.length} 章，第一章没丢也没错位`);
}

console.log("\n✓ 部→章结构测试通过");
