/**
 * 零依赖打包器：把 ESM 模块树打成一个自包含的单文件 HTML。
 *
 * 为什么要打包：file:// 协议下浏览器会因 CORS 拒绝加载 <script type="module">，
 * 所以必须把所有模块内联成一个普通 <script>。
 *
 * 做法：给每个模块包一层工厂函数，注册进一个 mini CommonJS registry，
 * 而不是简单地把 import/export 删掉再拼接（那样无法处理同名变量和执行顺序）。
 *
 * 支持的语法（本项目实际用到的全集）：
 *   import { a, b as c } from "./x.js"
 *   import * as ns from "./x.js"
 *   export function / export async function / export const / export let
 *   export { a, b }
 *
 * 不支持：默认导出、动态 import、循环依赖。
 *
 * 用法：node build.mjs [--watch]
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { watch } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * @type {{entry: string, out: string, title: string, favicon: string,
 *         vendor?: {file: string, global: string}[], define?: Record<string, string>}[]}
 */
const TARGETS = [
  {
    entry: "src/epub-main.js",
    out: "dist/epub-vscode.html",
    title: "EPUB · VS Code 工作区",
    favicon: "📘",
  },
  {
    // 带 PDF 支持的版本：多内联 1.6MB 的 pdf.js，只读 epub 的话用上面那个就行
    entry: "src/epub-main.js",
    out: "dist/reader-vscode.html",
    title: "EPUB / PDF · VS Code 工作区",
    favicon: "📚",
    vendor: [
      { file: "vendor/pdf.min.mjs", global: "pdfjsLib" },
      { file: "vendor/pdf.worker.min.mjs", global: "__pdfWorkerSrc", asText: true },
    ],
    define: { __PDF_ENABLED__: "true" },
  },
];

/* ---------------------------- 模块解析 ---------------------------- */

const IMPORT_RE = /^import\s+(?:(\{[^}]*\})|(\*\s+as\s+\w+)|(\w+))\s+from\s+["']([^"']+)["'];?\s*$/gm;
const BARE_IMPORT_RE = /^import\s+["']([^"']+)["'];?\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?\s*$/gm;

/**
 * @param {string} absPath
 * @param {Map<string, {code: string, deps: string[], exports: string[]}>} graph
 */
async function collect(absPath, graph) {
  const key = relative(ROOT, absPath).split("\\").join("/");
  if (graph.has(key)) return key;
  graph.set(key, null); // 占位，防止循环依赖时无限递归

  const raw = await readFile(absPath, "utf8");
  const dir = dirname(absPath);
  const deps = [];
  const exportNames = new Set();
  let code = raw;

  // 1. import -> const { ... } = __require("key")
  code = code.replace(IMPORT_RE, (_m, named, star, def, spec) => {
    if (!spec.startsWith(".")) {
      throw new Error(`${key}: 不支持裸模块导入 "${spec}"`);
    }
    const depAbs = resolve(dir, spec);
    const depKey = relative(ROOT, depAbs).split("\\").join("/");
    deps.push({ key: depKey, abs: depAbs });
    if (named) {
      // { a, b as c } -> { a, b: c }
      const body = named.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
        .map((s) => {
          const m = s.match(/^(\w+)\s+as\s+(\w+)$/);
          return m ? `${m[1]}: ${m[2]}` : s;
        }).join(", ");
      return `const { ${body} } = __require("${depKey}");`;
    }
    if (star) {
      const ns = star.replace(/^\*\s+as\s+/, "");
      return `const ${ns} = __require("${depKey}");`;
    }
    throw new Error(`${key}: 不支持默认导入 "${def}" from "${spec}"`);
  });

  code = code.replace(BARE_IMPORT_RE, (_m, spec) => {
    const depAbs = resolve(dir, spec);
    const depKey = relative(ROOT, depAbs).split("\\").join("/");
    deps.push({ key: depKey, abs: depAbs });
    return `__require("${depKey}");`;
  });

  // 2. export function foo / export const foo -> 去掉 export 并记名
  code = code.replace(EXPORT_DECL_RE, (_m, kind, name) => {
    exportNames.add(name);
    return `${kind} ${name}`;
  });

  // 3. export { a, b as c }
  code = code.replace(EXPORT_LIST_RE, (_m, body) => {
    body.split(",").map((s) => s.trim()).filter(Boolean).forEach((s) => {
      const m = s.match(/^(\w+)\s+as\s+(\w+)$/);
      exportNames.add(m ? m[2] : s);
    });
    return "";
  });

  if (/^export\s+default/m.test(code)) {
    throw new Error(`${key}: 不支持 export default`);
  }

  // 递归依赖
  for (const d of deps) await collect(d.abs, graph);

  graph.set(key, {
    code,
    deps: deps.map((d) => d.key),
    exports: [...exportNames],
  });
  return key;
}

/** 生成 IIFE bundle */
function emit(graph, entryKey) {
  const modules = [...graph.entries()].map(([key, mod]) => {
    if (!mod) throw new Error(`模块未解析完成: ${key}`);
    const exportsAssign = mod.exports.length
      ? `\n  return { ${mod.exports.map((n) => `${n}`).join(", ")} };`
      : "\n  return {};";
    return `  ${JSON.stringify(key)}: function (__require) {\n${indent(mod.code)}${exportsAssign}\n  }`;
  });

  return `(function () {
  "use strict";
  var __defs = {
${modules.join(",\n")}
  };
  var __cache = {};
  function __require(key) {
    if (__cache[key]) return __cache[key];
    var def = __defs[key];
    if (!def) throw new Error("模块未找到: " + key);
    var exp = def(__require);
    __cache[key] = exp;
    return exp;
  }
  __require(${JSON.stringify(entryKey)});
})();`;
}

function indent(code) {
  return code.split("\n").map((l) => (l ? `    ${l}` : "")).join("\n");
}

/* ---------------------------- vendor ---------------------------- */

/**
 * 把一个「只在末尾有一条 export{...}」的 ESM bundle 改写成普通脚本。
 *
 * pdf.js 只发 ESM，而我们的产物是单文件里的普通 <script>：
 * file:// 下内联 module script 虽然能跑，但两个内联 module 之间没法 import，
 * 所以干脆把导出改成全局赋值，退回普通脚本。
 * 前提是这个 bundle 没有顶层 import（pdf.js 满足），构建时会校验。
 */
function esmToGlobal(src, globalName, file) {
  const m = src.match(/export\{([^}]*)\};?\s*$/);
  if (!m) throw new Error(`${file}: 末尾没有找到 export{...}，无法转成全局脚本`);

  const pairs = m[1].split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const as = p.match(/^(\S+)\s+as\s+(\S+)$/);
    return as ? `${as[2]}: ${as[1]}` : `${p}: ${p}`;
  });

  const out = src.slice(0, m.index) + `globalThis.${globalName} = { ${pairs.join(", ")} };\n`;
  // 还有别的顶层 import/export 就说明它不是自包含 bundle，转换不安全
  if (/(^|\n)\s*(import|export)[\s{*]/.test(out)) {
    throw new Error(`${file}: 还残留顶层 import/export，不能当普通脚本内联`);
  }
  return out;
}

/** 生成 vendor 脚本片段 */
async function buildVendor(list) {
  if (!list?.length) return "";
  const parts = [];
  for (const v of list) {
    const raw = await readFile(resolve(ROOT, v.file), "utf8");
    if (v.asText) {
      // worker 要作为源码字符串交给 Blob，运行时再转 blob URL
      const code = esmToGlobal(raw, "__pdfWorkerExports", v.file);
      parts.push(`globalThis.${v.global} = ${JSON.stringify(code)};`);
    } else {
      parts.push(esmToGlobal(raw, v.global, v.file));
    }
    const kb = (Buffer.byteLength(raw) / 1024).toFixed(0);
    console.log(`    + ${v.file}  ${kb} KB`);
  }
  return parts.join("\n");
}

/* ---------------------------- HTML 外壳 ---------------------------- */

/**
 * 产物头部的许可声明。
 *
 * 带 PDF 支持的产物把 pdf.js 源码整个内联了进来，分发它就等同于分发 pdf.js，
 * Apache-2.0 要求随附许可声明——所以这段注释必须留在产物里，别当成可压缩的空白。
 *
 * @param {boolean} withPdf 这个产物有没有内联 pdf.js
 */
function licenseBanner(withPdf) {
  const lines = [
    "  本文件由 https://github.com/SCAUCJB/looks-like-work 构建生成。",
    "  Copyright (c) 2026 chenjiabin — MIT License",
  ];
  if (withPdf) {
    lines.push(
      "",
      "  内含 pdf.js (pdfjs-dist) 4.10.38",
      "    Copyright 2012 Mozilla Foundation",
      "    Licensed under the Apache License, Version 2.0",
      "    http://www.apache.org/licenses/LICENSE-2.0",
      "    https://github.com/mozilla/pdf.js"
    );
  }
  return `<!--\n${lines.join("\n")}\n-->`;
}

function htmlShell({ title, favicon, script, vendorScript = "", define = {} }) {
  const defines = Object.entries(define)
    .map(([k, v]) => `globalThis.${k} = ${v};`)
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
${licenseBanner(Boolean(vendorScript))}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>${favicon}</text></svg>">
<style>
  /* 书库页样式（工作区样式由 JS 注入） */
  :root {
    color-scheme: dark;
    --lib-bg: #1e1e1e; --lib-fg: #d4d4d4; --lib-fg2: #9da5b4; --lib-fg3: #6a737d;
    --lib-line: #2b2b2b; --lib-card: #252526; --lib-accent: #007acc; --lib-err: #f14c4c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--lib-bg); color: var(--lib-fg);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  #library { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
  .lib-wrap { width: 100%; max-width: 640px; }
  .lib-wrap h1 { margin: 0 0 6px; font-size: 26px; font-weight: 500; }
  .lib-sub { margin: 0 0 28px; color: var(--lib-fg2); }
  .lib-wrap h2 { margin: 32px 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: var(--lib-fg3); font-weight: 600; }
  .lib-drop {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 44px 20px; border: 1px dashed #3c3c3c; border-radius: 6px;
    background: var(--lib-card); cursor: pointer; text-align: center;
    transition: border-color .15s ease, background .15s ease;
  }
  .lib-drop:hover, .lib-drop.over { border-color: var(--lib-accent); background: #252d35; }
  .lib-drop strong { font-size: 15px; font-weight: 500; }
  .lib-drop span { color: var(--lib-fg3); font-size: 13px; }
  /* 视觉隐藏而非 display:none —— 后者在 Safari 下可能导致 file input 不派发 change */
  .lib-file {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .lib-drop:focus-visible { outline: 2px solid var(--lib-accent); outline-offset: 2px; }
  .lib-status { min-height: 22px; margin-top: 12px; font-size: 13px; color: var(--lib-fg2); }
  .lib-status.err { color: var(--lib-err); }
  .lib-warn {
    margin-top: 12px; padding: 10px 12px; border-radius: 6px; font-size: 12px; line-height: 1.7;
    background: #2d2a1e; border: 1px solid #5c4d1f; color: #e0cf9a;
  }
  .lib-fatal {
    margin-bottom: 20px; padding: 14px 16px; border-radius: 6px;
    background: #2d1f1f; border: 1px solid #6b2b2b; color: #f0b4b4;
  }
  .lib-fatal strong { display: block; margin-bottom: 6px; font-size: 14px; }
  .lib-fatal p { margin: 0 0 8px; color: #ffd9d9; }
  .lib-fatal pre {
    margin: 0; padding: 8px; border-radius: 4px; background: rgba(0,0,0,.35);
    font-size: 11px; line-height: 1.5; overflow: auto; max-height: 160px; color: #d7a7a7;
  }
  .lib-diag-wrap { margin-top: 18px; }
  .lib-diag-btn {
    border: 0; background: transparent; color: var(--lib-fg3); cursor: pointer;
    font-size: 12px; padding: 4px 0; text-decoration: underline; text-underline-offset: 3px;
  }
  .lib-diag-btn:hover { color: var(--lib-fg2); }
  .lib-diag {
    margin: 8px 0 0; padding: 10px 12px; border-radius: 6px;
    background: var(--lib-card); border: 1px solid var(--lib-line);
    font: 11px/1.7 ui-monospace, Menlo, Consolas, monospace;
    color: var(--lib-fg2); white-space: pre-wrap; word-break: break-all;
  }
  .lib-list { display: flex; flex-direction: column; gap: 6px; }
  .lib-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    background: var(--lib-card); border: 1px solid var(--lib-line); border-radius: 4px;
  }
  .lib-item-main { flex: 1; min-width: 0; }
  .lib-title { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lib-meta { font-size: 12px; color: var(--lib-fg3); }
  .lib-open {
    border: 0; background: var(--lib-accent); color: #fff; padding: 5px 12px;
    border-radius: 3px; cursor: pointer; font-size: 12px;
  }
  .lib-open:hover { background: #1b8ad4; }
  .lib-del {
    border: 0; background: transparent; color: var(--lib-fg3); cursor: pointer;
    font-size: 18px; line-height: 1; padding: 0 4px;
  }
  .lib-del:hover { color: var(--lib-err); }
</style>
</head>
<body>
<div id="library"></div>
${defines ? `<script>\n${defines}\n</script>` : ""}
${vendorScript ? `<script>\n${vendorScript}\n</script>` : ""}
<script>
${script}
</script>
</body>
</html>
`;
}

/* ---------------------------- 构建 ---------------------------- */

async function build() {
  for (const target of TARGETS) {
    const graph = new Map();
    const entryKey = await collect(resolve(ROOT, target.entry), graph);
    const script = emit(graph, entryKey);
    const vendorScript = await buildVendor(target.vendor);
    const html = htmlShell({ ...target, script, vendorScript, define: target.define });
    const outPath = resolve(ROOT, target.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html, "utf8");
    const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
    console.log(`✓ ${target.out}  ${graph.size} 个模块  ${kb} KB`);
  }
}

await build();

if (process.argv.includes("--watch")) {
  console.log("watching src/ …");
  let timer = null;
  watch(resolve(ROOT, "src"), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((e) => console.error("构建失败:", e.message)), 120);
  });
}
