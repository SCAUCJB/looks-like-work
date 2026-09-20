/**
 * PDF 文本提取：把带坐标的文本片段还原成段落。
 *
 * PDF 里没有「段落」这个概念，只有一堆定位好的字符串。pdf.js 的 getTextContent()
 * 返回的是 { str, transform, width, height } 列表，顺序是绘制顺序，不一定是阅读顺序。
 * 所以要自己重建：
 *
 *   1. 按 y 坐标聚成行（同一行的片段 y 值接近，但不会完全相等）
 *   2. 行内按 x 排序，按间距决定要不要补空格
 *   3. 统计正文行距，据此判断换行是「同段续行」还是「新段落」
 *   4. 剔除页眉页脚（每页同一位置反复出现的短行）
 *   5. 合并英文连字符换行（hyphenation）
 *
 * 目标是单栏的电子书 / 导出文档。双栏论文会串行——需要分栏检测，暂不支持。
 */

/** 同一行的 y 容差（相对字高的比例） */
const LINE_TOL = 0.5;
/** 行距超过正文行距的这个倍数，就认为是新段落 */
const PARA_GAP = 1.6;
/** 页眉页脚判定：出现在超过这个比例的页面上 */
const REPEAT_RATIO = 0.5;

/**
 * @typedef {Object} TextItem
 * @property {string} str
 * @property {number[]} transform  [a, b, c, d, e, f]，e/f 是 x/y
 * @property {number} width
 * @property {number} height
 *
 * @typedef {Object} Line
 * @property {string} text
 * @property {number} x      行首 x
 * @property {number} y
 * @property {number} size   字高
 */

/**
 * 一页的文本片段 -> 行
 * @param {TextItem[]} items
 * @returns {Line[]}
 */
export function itemsToLines(items) {
  /** @type {{y: number, size: number, parts: {x: number, str: string, w: number}[]}[]} */
  const rows = [];

  for (const it of items) {
    const str = it.str;
    if (!str) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.abs(it.transform[3]) || it.height || 10;
    if (!str.trim()) continue;

    // 找一个 y 接近的已有行；PDF 里同一行的片段 y 不会完全相等
    const tol = Math.max(1, size * LINE_TOL);
    let row = null;
    for (let i = rows.length - 1; i >= 0 && rows.length - i < 6; i--) {
      if (Math.abs(rows[i].y - y) <= tol) {
        row = rows[i];
        break;
      }
    }
    if (!row) {
      row = { y, size, parts: [] };
      rows.push(row);
    }
    row.size = Math.max(row.size, size);
    row.parts.push({ x, str, w: it.width || 0 });
  }

  return rows
    // PDF 坐标系原点在左下角，y 大的在上面
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const parts = row.parts.sort((p, q) => p.x - q.x);
      let text = "";
      let prevEnd = null;
      for (const p of parts) {
        if (prevEnd !== null) {
          const gap = p.x - prevEnd;
          // 间距超过大约半个字宽就补一个空格；中文之间不需要
          const needSpace =
            gap > row.size * 0.22 &&
            !/[\s　]$/.test(text) &&
            !/^[\s　]/.test(p.str) &&
            !(isCJK(text.slice(-1)) && isCJK(p.str[0]));
          if (needSpace) text += " ";
        }
        text += p.str;
        prevEnd = p.x + p.w;
      }
      return { text: text.replace(/\s+$/, ""), x: parts[0]?.x ?? 0, y: row.y, size: row.size };
    })
    .filter((l) => l.text.trim());
}

function isCJK(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60);
}

/**
 * 找出页眉页脚：在多数页面的**版面同一位置**反复出现的短行。
 *
 * 不能按「每页前两行 / 后两行」取候选——章节末页、插图页只有寥寥几行，
 * 正文会落进候选区，跨页一比对就被当成页眉删掉，直接丢内容。
 * 所以按 y 坐标判断是否落在页眉页脚带里，并跳过行数太少、信息不足的页面。
 *
 * 页码会变（1、2、3…），归一化成 # 之后再比对。
 *
 * @param {Line[][]} pages
 * @returns {Set<string>} 归一化后的特征串
 */
export function findRunningHeads(pages) {
  const total = pages.length;
  if (total < 4) return new Set();

  // 用全局 y 分布估计版心范围（多数页是满的，个别短页不影响分位数）
  const allY = pages.flat().map((l) => l.y);
  if (allY.length < 20) return new Set();
  const top = percentile(allY, 0.98);
  const bottom = percentile(allY, 0.02);
  const span = top - bottom;
  if (span <= 0) return new Set();
  const headZone = top - span * 0.08;     // 顶部 8%
  const footZone = bottom + span * 0.08;  // 底部 8%

  const count = new Map();
  let sampled = 0;
  for (const lines of pages) {
    // 行数太少的页面（章末、插图页）信息不足，拿来统计容易误伤正文
    if (lines.length < 5) continue;
    sampled += 1;
    const seen = new Set();
    for (const l of lines) {
      if (l.y < headZone && l.y > footZone) continue;   // 不在页眉页脚带里
      if (l.text.length > 40) continue;                  // 太长的不像页眉
      const key = normalizeHead(l.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  if (sampled < 4) return new Set();

  const out = new Set();
  for (const [key, n] of count) {
    if (n / sampled >= REPEAT_RATIO) out.add(key);
  }
  return out;
}

/** 页码归一化：把数字换成占位，这样「第 1 页」「第 2 页」算同一个 */
export function normalizeHead(text) {
  return String(text || "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 行 -> 段落。
 * @param {Line[][]} pages  每页的行
 * @param {Set<string>} heads 要剔除的页眉页脚
 * @returns {{text: string, page: number}[]}
 */
export function linesToParagraphs(pages, heads) {
  // 正文行距的基准。
  // 不能用中位数：段间距、标题间距都会混进来把它抬高，
  // 一抬高阈值就没有任何换行能被判成新段落了。
  // 正文行距是出现最密集的那一档，取 30% 分位更贴近它。
  const gaps = [];
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const g = lines[i - 1].y - lines[i].y;
      if (g > 0 && g < 200) gaps.push(g);
    }
  }
  const baseGap = percentile(gaps, 0.3) || 14;

  // 正文左边界：取所有行 x 的众数区间，用来识别缩进（缩进往往意味着新段落）
  const xs = pages.flat().map((l) => l.x);
  const baseX = percentile(xs, 0.2);

  /** @type {{text: string, page: number}[]} */
  const paras = [];
  let buf = "";
  let bufPage = 1;

  const flush = () => {
    const t = buf.replace(/\s+$/, "");
    if (t.trim()) paras.push({ text: t, page: bufPage });
    buf = "";
  };

  pages.forEach((lines, pi) => {
    const pageNo = pi + 1;
    let prev = null;

    for (const line of lines) {
      if (heads.has(normalizeHead(line.text))) continue;    // 页眉页脚
      if (/^[\s#·．.\-—]*$/.test(line.text)) continue;      // 纯装饰行

      let newPara = false;
      if (!prev) {
        // 每页第一行：跨页时通常是上一段的续行，除非有明显缩进
        newPara = buf === "" || line.x > baseX + line.size * 1.2;
      } else {
        const gap = prev.y - line.y;
        const indented = line.x > prev.x + line.size * 1.2;
        // 字号变了基本就是标题和正文的分界
        const sizeChanged = Math.abs(line.size - prev.size) > Math.max(prev.size, line.size) * 0.15;
        const prevEndsSentence = /[.。！？!?；;：:”"』」]$/.test(prev.text);
        const prevIsShort = prev.text.length < 30;
        newPara =
          gap > baseGap * PARA_GAP ||
          indented ||
          sizeChanged ||
          (prevEndsSentence && prevIsShort);
      }

      if (newPara) {
        flush();
        bufPage = pageNo;
      }
      buf = joinLine(buf, line.text);
      prev = line;
    }
  });
  flush();

  return paras;
}

/** 拼接续行：处理英文连字符换行，中文之间不加空格 */
export function joinLine(buf, next) {
  if (!buf) return next;
  const last = buf.slice(-1);
  const first = next[0] || "";

  // 英文单词被连字符断开：把连字符去掉直接接上
  if (/[A-Za-z]-$/.test(buf) && /^[a-z]/.test(next)) {
    return buf.slice(0, -1) + next;
  }
  // 中文之间不加空格
  if (isCJK(last) && isCJK(first)) return buf + next;
  if (/\s$/.test(buf) || /^\s/.test(next)) return buf + next;
  return `${buf} ${next}`;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length * p)];
}
