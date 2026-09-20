/**
 * EPUB 目录层级与排序测试。
 *
 * 核心约定：**顺序取自 spine，层级取自 TOC 的父子关系（parent href）**。
 * 不能用 depth 数字 + 栈来还原层级——depth 一旦按 spine 顺序重排，
 * 真实的父子关系就丢了。下面四个 fixture 就是专门用来钉住这件事的。
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
const { buildTocIndex } = await import("../src/sources/epub/opf.js");

async function load(name) {
  const buf = await readFile(join(import.meta.dirname, "fixtures", `${name}.epub`));
  const files = await unzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const adapter = createEpubAdapter(files);
  const source = createBookSource({ adapter, size: 1, onOpenLibrary: () => {} });
  return { adapter, source, tree: source.tree()[0].children || [] };
}

/** 树 -> 扁平的 "路径" 列表，便于断言 */
function paths(nodes, prefix = "") {
  const out = [];
  for (const n of nodes) {
    const here = prefix ? `${prefix} / ${n.label}` : n.label;
    if (n.hint) out.push(prefix ? `${prefix} / ${n.hint}` : n.hint);
    out.push(here);
    if (n.children) out.push(...paths(n.children, here));
  }
  return out;
}

function show(nodes, d = 0) {
  nodes.forEach((n) => {
    console.log(`    ${"│  ".repeat(d)}${n.kind === "folder" ? "📁" : "📄"} ${n.label}`);
    if (n.children) show(n.children, d + 1);
  });
}

console.log("=== A. TOC 顺序与 spine 顺序不一致 ===");
{
  // TOC: A(含子章 C) / B；spine: A, B, C —— C 在 spine 里排在 B 后面
  const { adapter, tree } = await load("case-a");
  show(tree);
  const c = adapter.chapters.find((x) => x.href.endsWith("c.xhtml"));
  assert.ok(c.parent?.endsWith("a.xhtml"), `C 的父级应是 A，实际 ${c.parent}`);

  const folderA = tree.find((n) => n.kind === "folder" && n.label === "A 第一章");
  assert.ok(folderA, "A 没有成为文件夹");
  // 树上显示的是文件名（IDE 风格），真实标题在 hint 里
  const inA = folderA.children;
  assert.ok(
    inA.some((n) => n.hint === "A.1 小节（spine 里排在 b 后面）"),
    `A.1 不在 A 底下，A 下只有: ${inA.map((n) => n.hint || n.label).join(", ")}`
  );
  assert.ok(inA.every((n) => n.kind !== "file" || n.hint), "文件节点缺少 hint（中文书看不出是哪章）");
  // B 必须是顶层，不能把 A.1 抢走
  const bTop = tree.find((n) => n.hint === "B 第二章" || n.label === "B 第二章");
  assert.ok(bTop, "B 不在顶层");
  assert.ok(
    !(bTop.children || []).some((n) => (n.hint || "").includes("A.1")),
    "A.1 被挂到了 B 底下 —— depth 栈式重建的典型症状"
  );
  console.log("  ✓ 子章挂在正确的父章下，没被中间的兄弟章抢走");
}

console.log("\n=== B. 跳级目录（0 -> 2，缺中间级） ===");
{
  const { adapter, tree } = await load("case-b");
  show(tree);
  const b = adapter.chapters.find((x) => x.href.endsWith("b.xhtml"));
  assert.ok(b.parent?.endsWith("a.xhtml"), `跳级章的父级应是 A 部，实际 ${b.parent}`);
  const folderA = tree.find((n) => n.kind === "folder" && n.label === "A 部");
  assert.ok(folderA, "A 部没有成为文件夹");
  assert.ok(folderA.children.some((n) => (n.hint || "").includes("A.1.1")), "跳级的子章不在 A 部下");
  // C 部不能被 A 部吞掉
  assert.ok(tree.some((n) => n.label === "C 部" || n.hint === "C 部"), "C 部不在顶层");
  console.log("  ✓ 跳级不影响归属");
}

console.log("\n=== C. 单文件多章（多个 TOC 条目指向同一文件的不同锚点） ===");
{
  const { adapter, tree } = await load("case-c");
  show(tree);
  const all = adapter.chapters.find((x) => x.href.endsWith("all.xhtml"));
  console.log("  anchors:", all.anchors.map((a) => a.label).join(", "));
  assert.equal(all.anchors.length, 2, "锚点条目没被保留下来");

  const flat = paths(tree).join(" | ");
  // 这两条在修复前会从目录里彻底消失
  assert.ok(flat.includes("第二章"), "「第二章」从目录里消失了");
  assert.ok(flat.includes("2.1 小节"), "「2.1 小节」从目录里消失了");
  assert.ok(flat.includes("附录"), "附录丢了");
  console.log("  ✓ 同一文件的多个章节条目都在目录里");
}

console.log("\n=== D. TOC 未覆盖的插页 ===");
{
  const { adapter, tree } = await load("case-d");
  show(tree);
  const ad = adapter.chapters.find((x) => x.href.endsWith("ad.xhtml"));
  const a2 = adapter.chapters.find((x) => x.href.endsWith("a2.xhtml"));
  assert.ok(ad.parent?.endsWith("a.xhtml"), "插页应继承前一章的父级，而不是自成顶层");
  assert.ok(a2.parent?.endsWith("a.xhtml"), `A.2 的父级应是 A，实际 ${a2.parent}`);

  const folderA = tree.find((n) => n.kind === "folder" && n.label === "A 第一章");
  assert.ok(folderA, "A 没有成为文件夹");
  assert.ok(folderA.children.some((n) => (n.hint || "") === "A.2"), "A.2 被插页抢走了");
  assert.equal(tree.length, 1, `顶层应只有 A 一项，实际 ${tree.length} 项`);
  console.log("  ✓ 插页不打断层级");
}

console.log("\n=== E. buildTocIndex 的基本约定 ===");
{
  const toc = [
    { label: "一", href: "a.html", anchor: "", children: [
      { label: "一.1", href: "b.html", anchor: "", children: [] },
      { label: "一.2", href: "a.html", anchor: "s2", children: [] },   // 指回自己
    ] },
    { label: "分组（无链接）", href: "", anchor: "", children: [
      { label: "二", href: "c.html", anchor: "", children: [] },
    ] },
  ];
  const { index: idx, groups } = buildTocIndex(toc);
  console.log("  索引:", [...idx].map(([h, v]) => `${h}(parent=${v.parent}, anchors=${v.anchors.length})`).join(" | "));
  console.log("  分组:", [...groups].map(([g, v]) => `${g}=${v.label}`).join(" | ") || "—");
  assert.equal(idx.get("a.html").parent, null, "顶层条目不该有父级");
  assert.equal(idx.get("b.html").parent, "a.html", "子章父级不对");
  assert.equal(idx.get("a.html").anchors.length, 1, "指回自己的条目应记为锚点");
  // 有名字的无链接分组：保留成 group，子项挂在它下面（以前整个标题会丢掉）
  const gid = idx.get("c.html").parent;
  assert.ok(gid && groups.has(gid), "无链接分组应该保留成 group");
  assert.equal(groups.get(gid).label, "分组（无链接）", "分组标题丢了");
  // order 递增，可用于判断 TOC 顺序
  assert.ok(idx.get("a.html").order < idx.get("b.html").order, "order 没有按 TOC 顺序递增");
  console.log("  ✓ 自引用 / 有名分组 / order 都正确");
}

console.log("\n=== F. 无名占位节点不该造出空层级 ===");
{
  const { index, groups } = buildTocIndex([
    { label: "(untitled)", href: "", anchor: "", children: [
      { label: "正文", href: "x.html", anchor: "", children: [] },
    ] },
  ]);
  assert.equal(groups.size, 0, "没名字又没文件的节点不该建分组");
  assert.equal(index.get("x.html").parent, null, "无名节点应该透传父级");
  console.log("  ✓ 无名占位节点被跳过");
}

console.log("\n=== G. 壳条目让位给第一章 ===");
{
  // 「第一部分」的 href 直接指向它第一章的文件——这是最常见的写法，
  // 先到先得的话第一章就被壳吞掉了。
  const { index, groups } = buildTocIndex([
    { label: "第一部分", href: "ch1.html", anchor: "", children: [
      { label: "第1章", href: "ch1.html", anchor: "", children: [] },
      { label: "第2章", href: "ch2.html", anchor: "", children: [] },
    ] },
  ]);
  assert.equal(index.get("ch1.html").label, "第1章", "ch1.html 应该归第一章，不是壳");
  const g = index.get("ch1.html").parent;
  assert.ok(g && groups.get(g)?.label === "第一部分", "壳应该降级成分组并保留标题");
  assert.equal(index.get("ch2.html").parent, g, "同部分的其它章要挂在同一个分组下");
  console.log("  ✓ 壳降级成分组，第一章拿回自己的文件");
}

console.log("\n=== H. 单文件多章不受壳规则误伤 ===");
{
  // 同一个 xhtml 被一串**平级**条目用 #anchor 切开，
  // 这里没有父子争抢，不该触发让位。
  const { index, groups } = buildTocIndex([
    { label: "第一章", href: "ch.html", anchor: "", children: [] },
    { label: "第二章", href: "ch.html", anchor: "c2", children: [] },
  ]);
  assert.equal(index.get("ch.html").label, "第一章", "平级同文件条目不该触发让位");
  assert.equal(index.get("ch.html").anchors.length, 1, "后续条目应记为锚点");
  assert.equal(groups.size, 0, "不该产生多余分组");
  console.log("  ✓ 锚点分章行为不变");
}

console.log("\n✓ 目录层级与排序测试通过");
