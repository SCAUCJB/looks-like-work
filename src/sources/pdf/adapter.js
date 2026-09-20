/**
 * PDF 的 BookAdapter。
 *
 * PDF 没有图片提取（渲染成 canvas 成本高、对「当代码读」也没意义），
 * 所以 blobUrlFor 恒空；内容以已经还原好的段落数组给出。
 */

/**
 * @param {import("./load.js").PdfBook} book
 * @returns {import("../epub/adapter.js").BookAdapter}
 */
export function createPdfAdapter(book) {
  const byId = new Map(book.chapters.map((c) => [c.id, c]));

  return {
    kind: "pdf",
    meta: { title: book.title, author: book.author },
    chapters: book.chapters.map((c) => ({ href: c.id, title: c.title, depth: c.depth || 0 })),
    contentOf: (href) => {
      const ch = byId.get(href);
      return ch ? { paras: ch.paras.map((p) => p.text) } : null;
    },
    plainOf: (href) => (byId.get(href)?.paras || []).map((p) => p.text).join("\n"),
    blobUrlFor: () => "",
    coverUrl: () => "",
    info: () => [
      `pages: ${book.pages}`,
      `chapters: ${book.chapters.length}`,
      book.hasText ? "text layer: ok" : "text layer: 缺失（扫描版）",
    ],
  };
}
