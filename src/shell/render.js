// 把行块包装成「注释」并着色，最终渲染为编辑器里的一行 DOM

import { escapeHtml, pick, hashStr } from "./util.js";
import { IMG_EMOJI } from "./const.js";

// 各语言的注释风格：正文会被包成这些注释
const COMMENT_STYLE = {
  slash: { open: "/*", mid: " * ", close: " */", line: "// ", single: (t) => `/* ${t} */` },
  hash: { open: null, mid: "# ", close: null, line: "# ", single: (t) => `# ${t}` },
  html: { open: "<!--", mid: "  ", close: "-->", line: null, single: (t) => `<!-- ${t} -->` },
};

const HIGHLIGHT_KEYWORDS = "import|from|const|let|var|function|async|await|return|if|else|elif|for|while|loop|try|catch|except|finally|export|default|class|interface|struct|enum|impl|fn|func|def|public|private|protected|static|final|void|null|None|true|false|True|False|package|pub|mut|ref|switch|case|break|continue|defer|extends|implements|throws|throw|raise|yield|namespace|using|template|typename|virtual|override|constexpr|sizeof|computed|watch|onMounted|record|include|new|this|self|super|go|type|match|where|in|of|as|is|not|and|or|with|use|mod|pass|auto|var";


export function fenceWrap(item, cstyle) {
  const lang = item.lang || "code";
  const who = item.prefix ? `${item.prefix} ` : "";
  const src = (item.lines && item.lines.length ? item.lines : [""]).map((l) => l.replace(/\t/g, "  "));
  const code = src.map((l) => ({ type: "code", text: l || " ", fence: true }));
  if (cstyle === "html") {
    return { rows: [{ type: "comment", text: `<!-- ${who}${lang}` }, ...code, { type: "comment", text: "-->" }] };
  }
  if (cstyle === "hash") {
    return { rows: [{ type: "comment", text: `# --- ${who}${lang} ---` }, ...code, { type: "comment", text: "# --- end ---" }] };
  }
  return { rows: [{ type: "comment", text: `/* ${who}${lang}` }, ...code, { type: "comment", text: "*/" }] };
}

export function extractCommentImages(chunks, images) {
  const joined = (Array.isArray(chunks) ? chunks : [chunks]).join(" ");
  return [...joined.matchAll(/⟦IMG:(\d+)⟧/g)].map((m) => {
    const img = images[Number(m[1])];
    if (!img) return null;
    const emoji = IMG_EMOJI[Math.abs(hashStr(img.src)) % IMG_EMOJI.length];
    return { emoji, src: img.src, alt: img.alt };
  }).filter(Boolean);
}

export function splitCommentLines(chunks) {
  const raw = Array.isArray(chunks) ? chunks : [chunks];
  const lines = [];
  raw.forEach((chunk) => {
    String(chunk || "")
      .split(/\n|(?=@\S+#\d+\s)/)
      .map((s) => s.replace(/⟦IMG:\d+⟧/g, " ").replace(/[ \t]+/g, " ").trimEnd())
      .forEach((line) => {
        // 保留原始行结构，不再按固定宽度硬切
        lines.push(line.trim() ? line.trim() : "");
      });
  });
  // 去掉首尾空行，中间空行保留
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

export function commentWrap(chunks, cstyle, rand, images) {
  const cs = COMMENT_STYLE[cstyle] || COMMENT_STYLE.slash;
  const list = Array.isArray(chunks) ? chunks : [chunks];
  if (list.length === 1 && list[0] && list[0].kind === "fence") {
    return fenceWrap(list[0], cstyle);
  }
  if (list.length === 1 && list[0] && list[0].kind === "reply") {
    return replyBlockWrap(list[0], cstyle, images);
  }
  const texts = list.map((c) => (typeof c === "string" ? c : c?.value || "")).filter(Boolean);
  const imgMarks = extractCommentImages(texts, images);
  const linesText = splitCommentLines(texts);
  const multi = linesText.length > 1;

  if (!linesText.length && !imgMarks.length) return { lines: [], images: [] };
  if (!linesText.length) return { lines: [], images: imgMarks };

  if (multi) {
    // html 没有行注释，只能块注释；slash/hash 随机选行注释或块注释
    if (cs.open && (cs.line ? rand() >= 0.45 : true)) {
      return {
        lines: [cs.open, ...linesText.map((l) => (cs.mid + l).trimEnd()), cs.close],
        images: imgMarks,
      };
    }
    return { lines: linesText.map((l) => (cs.line + l).trimEnd()), images: imgMarks };
  }

  const clean = linesText[0];
  const roll = rand();
  if (cs.line && roll < 0.22 && clean.length < 48) {
    return { lines: [], images: imgMarks, inline: ` ${cs.line}${clean}` };
  }
  if (roll < 0.5 || !cs.line) return { lines: [cs.single(clean)], images: imgMarks };
  return { lines: [`${cs.line}${clean}`], images: imgMarks };
}

export function highlightCode(text) {
  if (!text) return "";
  let s = escapeHtml(text);
  // 先保护字符串字面量（escapeHtml 后引号是 &quot; / &#39;），
  // 避免字符串里的 //、#、关键字、数字被误高亮
  const strs = [];
  s = s.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`[^`]*`)/g, (m) => {
    strs.push(m);
    return `\u0001S${strs.length - 1}S\u0001`;
  });
  const restore = (x) => x.replace(/\u0001S(\d+)S\u0001/g, (_, i) => `<span class="vsc-str">${strs[Number(i)]}</span>`);
  s = s.replace(/(\/\/.*)$/g, '<span class="vsc-cm">$1</span>');
  s = s.replace(/^(\s*)(#(?![\w[!]).*)$/g, '$1<span class="vsc-cm">$2</span>');
  s = s.replace(/(\s)(#(?![\w[!]).*)$/g, '$1<span class="vsc-cm">$2</span>');
  s = s.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="vsc-cm">$1</span>');
  s = s.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="vsc-cm">$1</span>');
  if (s.includes('class="vsc-cm"')) return restore(s);
  s = s.replace(new RegExp(`\\b(${HIGHLIGHT_KEYWORDS})\\b`, "g"), '<span class="vsc-kw">$1</span>');
  s = s.replace(/\b(\d+)\b/g, '<span class="vsc-num">$1</span>');
  s = s.replace(/\b([A-Za-z_][\w]*)\s*(?=\()/g, '<span class="vsc-fn">$1</span>');
  s = s.replace(/(&lt;\/?)([\w-]+)/g, '<span class="vsc-punc">$1</span><span class="vsc-tag">$2</span>');
  return restore(s);
}

export function renderLine(row) {
  const imgs = row.images || [];
  const emojiHtml = imgs.map((img) =>
    `<span class="vsc-img-emoji" data-src="${escapeHtml(img.src)}" title="${escapeHtml(img.alt || "")}">${img.emoji}</span>`
  ).join(" ");
  const body = (row.type === "comment" || row.fence)
    ? `<span class="vsc-cm">${escapeHtml(row.text)}</span>`
    : highlightCode(row.text);
  if (!emojiHtml) return body || " ";
  if (!row.text || row.text === "// media") {
    return `<span class="vsc-cm">// assets </span>${emojiHtml}`;
  }
  return `${body} ${emojiHtml}`;
}

// V2EX 专属：把一条回复渲染成带 @用户#楼层 头的注释块
export function replyBlockWrap(reply, cstyle, images) {
  const cs = COMMENT_STYLE[cstyle] || COMMENT_STYLE.slash;
  const header = `@${reply.user}#${reply.floor}`;
  const open = cstyle === "html" ? `<!-- ${header}` : cstyle === "hash" ? `# ${header}` : `/* ${header}`;
  const close = cstyle === "html" ? "-->" : cstyle === "hash" ? "# ──────────" : " */";
  const rows = [{ type: "comment", text: open }];

  reply.parts.forEach((part) => {
    if (part.kind === "fence") {
      const lang = part.lang || "code";
      const src = (part.lines || [""]).map((l) => l.replace(/\t/g, "  "));
      rows.push({ type: "comment", text: `${cs.mid}\`\`\`${lang}` });
      src.forEach((l) => rows.push({ type: "code", text: l || " ", fence: true }));
      rows.push({ type: "comment", text: `${cs.mid}\`\`\``.trimEnd() });
      return;
    }
    const lines = String(part.value || "").split("\n");
    lines.forEach((line) => {
      rows.push({ type: "comment", text: line ? `${cs.mid}${line}` : cs.mid.trimEnd() });
    });
  });

  const imgMarks = extractCommentImages(
    reply.parts.filter((p) => p.kind === "text").map((p) => p.value || ""),
    images
  );
  rows.push({ type: "comment", text: close, images: imgMarks });
  return { rows };
}
