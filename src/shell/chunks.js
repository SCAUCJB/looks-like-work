// 富文本 HTML -> 行块（chunks）：保留原始换行、抽出代码栅栏、图片转占位符
// 输出结构：{ parts: [{kind:'text'|'fence', ...}], images: [{src, alt}] }

import { IMG_EMOJI } from "./const.js";

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("script,style,iframe,object,form,input,button").forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const val = attr.value || "";
      if (name.startsWith("on") || name === "srcdoc" || /^(javascript|data):/i.test(val.trim())) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.firstChild ? doc.body.firstChild.innerHTML : "";
}

export function htmlToPlainText(html) {
  const box = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  box.querySelectorAll("img").forEach((img, i) => {
    img.replaceWith(box.createTextNode(` ${IMG_EMOJI[i % IMG_EMOJI.length]} `));
  });
  box.querySelectorAll("br").forEach((br) => br.replaceWith(box.createTextNode("\n")));
  box.querySelectorAll("p,div,li,blockquote,pre,tr,section,article,h1,h2,h3,h4,h5,h6").forEach((el) => {
    el.appendChild(box.createTextNode("\n"));
  });
  return String(box.body.textContent || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToOneLine(html) {
  return htmlToPlainText(html).replace(/\s*\n\s*/g, " ⏎ ");
}

export function htmlToChunks(html) {
  const box = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const images = [...box.querySelectorAll("img")].map((img, i) => ({
    src: img.getAttribute("src") || "",
    alt: img.getAttribute("alt") || img.getAttribute("title") || `image-${i + 1}`,
  })).filter((x) => x.src);
  box.querySelectorAll("img").forEach((img, i) => {
    img.replaceWith(box.createTextNode(` ⟦IMG:${i}⟧ `));
  });

  // 保留原始换行：<br> 转成 \n，块级元素末尾补 \n（textContent 不会为它们产生换行）
  box.querySelectorAll("br").forEach((br) => br.replaceWith(box.createTextNode("\n")));
  box.querySelectorAll("p,div,li,blockquote,h1,h2,h3,h4,h5,h6,tr,section,article").forEach((el) => {
    el.appendChild(box.createTextNode("\n"));
  });

  const fences = [];
  const takeCodeEl = (el) => {
    const codeEl = el.matches("pre") ? (el.querySelector("code") || el) : el;
    const lang = (
      (codeEl.getAttribute("class") || "").match(/(?:language|lang)-([\w+-]+)/i) ||
      (el.getAttribute("class") || "").match(/(?:language|lang)-([\w+-]+)/i) ||
      []
    )[1] || "";
    const body = String(codeEl.textContent || "").replace(/\r/g, "").replace(/\n$/, "");
    if (!body.trim()) return;
    const token = `⟦CODE:${fences.length}⟧`;
    fences.push({ lang, lines: body.split("\n") });
    el.replaceWith(box.createTextNode(` ${token} `));
  };
  box.querySelectorAll("pre").forEach(takeCodeEl);
  box.querySelectorAll("code").forEach((el) => {
    if (el.closest("pre")) return;
    const t = el.textContent || "";
    if (t.includes("\n") || t.length > 72) takeCodeEl(el);
  });

  const text = (box.body.textContent || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  function pushSentences(raw, parts) {
    const block = String(raw || "");
    if (!block.trim()) return;
    // 保留原始换行结构，不拆句、不硬切长行
    const lines = block.replace(/\r/g, "").split("\n");
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.forEach((line) => {
      parts.push({ kind: "text", value: line.replace(/[ \t]+$/g, "") });
    });
  }

  function absorbMarkdownFences(raw, parts) {
    const fenceRe = /```([\w+-]*)[ \t]*\n?([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fenceRe.exec(raw))) {
      pushSentences(raw.slice(last, m.index), parts);
      const body = String(m[2] || "").replace(/\n$/, "");
      if (body.trim()) parts.push({ kind: "fence", lang: m[1] || "", lines: body.split("\n") });
      last = m.index + m[0].length;
    }
    pushSentences(raw.slice(last), parts);
  }

  const parts = [];
  const tokenRe = /⟦CODE:(\d+)⟧/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(text))) {
    absorbMarkdownFences(text.slice(last, m.index), parts);
    const fence = fences[Number(m[1])];
    if (fence) parts.push({ kind: "fence", lang: fence.lang, lines: fence.lines.slice() });
    last = m.index + m[0].length;
  }
  absorbMarkdownFences(text.slice(last), parts);
  return { parts, images };
}
