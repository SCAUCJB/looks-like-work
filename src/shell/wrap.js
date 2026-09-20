/**
 * 按显示宽度折行。
 *
 * 为什么不用 CSS 软换行：编辑器的行号 gutter 和代码行是两列独立的 div，
 * 每行固定 18px 高。一旦 CSS 折行，一个逻辑行占了两行高度，行号就全错位了。
 * 所以折行必须发生在渲染之前——折出来的每一行都是真正独立的一行，各占一个行号。
 *
 * 宽度按「等宽字体的显示列数」算，不是字符数：中日韩文字占 2 列，西文占 1 列，
 * 否则中文段落会比英文段落短一半。
 */

/** 单字符显示宽度（等宽字体下的列数） */
export function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c === undefined) return 0;
  // 组合附加符号（声调等）不占宽度
  if (c >= 0x0300 && c <= 0x036f) return 0;
  // East Asian Wide / Fullwidth：CJK、假名、韩文、全角标点、部分 emoji
  if (
    (c >= 0x1100 && c <= 0x115f) ||   // 韩文字母
    (c >= 0x2e80 && c <= 0xa4cf) ||   // CJK 部首 ~ 彝文（含中日韩统一汉字、假名）
    (c >= 0xac00 && c <= 0xd7a3) ||   // 韩文音节
    (c >= 0xf900 && c <= 0xfaff) ||   // CJK 兼容汉字
    (c >= 0xfe30 && c <= 0xfe6f) ||   // CJK 兼容形式
    (c >= 0xff00 && c <= 0xff60) ||   // 全角 ASCII
    (c >= 0xffe0 && c <= 0xffe6) ||   // 全角符号
    (c >= 0x1f300 && c <= 0x1faff) || // emoji
    (c >= 0x20000 && c <= 0x3fffd)    // CJK 扩展 B~
  ) return 2;
  return 1;
}

/** 字符串显示宽度 */
export function strWidth(s) {
  let w = 0;
  for (const ch of String(s ?? "")) w += charWidth(ch);
  return w;
}

/**
 * 把一行切成「不可分割的 token」：
 *   - ⟦IMG:0⟧ / ⟦CODE:0⟧ 这类占位符必须整体保留，绝不能被折断
 *   - 每个宽字符（中文等）自成一个 token，可以在任意字之间断行
 *   - 连续的西文/数字/标点算一个词，尽量不在词中间断
 *   - 空白附着在前一个 token 尾部，这样行尾不会留下孤立空格
 */
function tokenize(line) {
  const tokens = [];
  const re = /⟦(?:IMG|CODE):\d+⟧|[ \t]+|[^ \t]/gu;
  let m;
  while ((m = re.exec(line))) {
    const piece = m[0];
    if (/^[ \t]+$/.test(piece)) {
      // 空白并到前一个 token
      if (tokens.length) tokens[tokens.length - 1] += piece;
      else tokens.push(piece);
      continue;
    }
    if (piece.startsWith("⟦")) {
      tokens.push(piece);
      continue;
    }
    const wide = charWidth(piece) === 2;
    const prev = tokens[tokens.length - 1];
    // 窄字符且上一个 token 也是「窄字符词」且没被空白截断 -> 并成一个词
    if (
      !wide &&
      prev !== undefined &&
      !/[ \t]$/.test(prev) &&
      !prev.startsWith("⟦") &&
      strWidth(prev[prev.length - 1]) === 1
    ) {
      tokens[tokens.length - 1] = prev + piece;
    } else {
      tokens.push(piece);
    }
  }
  return tokens;
}

/**
 * 按显示宽度折一行，返回多行。
 * @param {string} line
 * @param {number} maxCols  每行最大显示列数
 * @returns {string[]}
 */
export function wrapLine(line, maxCols) {
  const limit = Math.max(20, Number(maxCols) || 88);
  const src = String(line ?? "");
  if (!src.trim()) return [src];
  if (strWidth(src) <= limit) return [src];

  const out = [];
  let cur = "";
  let curW = 0;

  for (const token of tokenize(src)) {
    const tw = strWidth(token);

    // 当前行放不下这个 token -> 先断行
    if (curW > 0 && curW + tw > limit) {
      out.push(cur.replace(/[ \t]+$/, ""));
      cur = "";
      curW = 0;
    }

    // 单个 token 本身就超宽（超长英文单词 / URL）-> 硬切
    if (tw > limit) {
      let chunk = "";
      let chunkW = 0;
      for (const ch of token) {
        const cw = charWidth(ch);
        if (chunkW + cw > limit) {
          out.push(chunk);
          chunk = "";
          chunkW = 0;
        }
        chunk += ch;
        chunkW += cw;
      }
      cur = chunk;
      curW = chunkW;
      continue;
    }

    cur += token;
    curW += tw;
  }

  if (cur.trim() || out.length === 0) out.push(cur.replace(/[ \t]+$/, ""));
  return out;
}

/**
 * 折整段文本（保留原有换行结构），返回用 \n 连接的结果。
 * @param {string} text
 * @param {number} maxCols
 */
export function wrapText(text, maxCols) {
  return String(text ?? "")
    .split("\n")
    .flatMap((line) => wrapLine(line, maxCols))
    .join("\n");
}
