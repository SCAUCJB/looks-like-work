/**
 * Usage 面板：仿 Claude Code 的额度显示。
 *
 * session (5h)  -> 当前章节进度
 * weekly  (7d)  -> 全书进度
 *
 * 数据源无关：只认一个 bar 列表，怎么算由调用方决定。
 *
 * @typedef {Object} UsageBar
 * @property {string} label    "Current session"
 * @property {string} window   "5h"
 * @property {number} pct      0~100
 * @property {string} [right]  右侧真实信息，如 "14/24 段"
 * @property {string} [resets] "resets 21:30"
 */

import { escapeHtml } from "./util.js";

/** 进度条字符宽度（TERMINAL 里用字符画） */
const BAR_CELLS = 20;

/** 重置时间：session 从现在起 5 小时，weekly 从现在起 7 天——纯装饰，为了像 */
export function resetHint(hours) {
  const t = new Date(Date.now() + hours * 3600 * 1000);
  if (hours >= 24) {
    return `resets ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.getDay()]}`;
  }
  return `resets ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}

/**
 * 字符画进度条，给 TERMINAL 用。
 * @param {number} pct
 */
export function barText(pct) {
  const p = clampPct(pct);
  const filled = Math.round((p / 100) * BAR_CELLS);
  return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

/**
 * HTML 进度条，给 Agent 面板用。
 * @param {UsageBar[]} bars
 */
export function usageHtml(bars) {
  return (bars || []).map((b) => {
    const pct = clampPct(b.pct);
    // 接近读完时变绿——Claude Code 那边是越高越危险，这里反过来，高是好事
    const tone = pct >= 99 ? "done" : pct >= 75 ? "high" : "";
    return `<div class="vsc-usage-row">
      <div class="vsc-usage-head">
        <span class="name">${escapeHtml(b.label)}</span>
        <span class="win">(${escapeHtml(b.window)})</span>
        <span class="reset">${escapeHtml(b.resets || "")}</span>
      </div>
      <div class="vsc-usage-bar"><i class="${tone}" style="width:${pct}%"></i></div>
      <div class="vsc-usage-foot">
        <span>${pct}% used</span>
        <span class="right">${escapeHtml(b.right || "")}</span>
      </div>
    </div>`;
  }).join("");
}

/**
 * 终端风格的多行文本，给 TERMINAL / OUTPUT 用。
 * @param {UsageBar[]} bars
 */
export function usageLines(bars) {
  const list = bars || [];
  // 按最长标题对齐，别写死宽度——"Current week (all chapters) (7d)" 会把 resets 挤得没有空格
  const titles = list.map((b) => `${b.label} (${b.window})`);
  const width = Math.max(0, ...titles.map((t) => t.length)) + 2;

  const out = [];
  list.forEach((b, i) => {
    const pct = clampPct(b.pct);
    out.push(titles[i].padEnd(width) + (b.resets || ""));
    out.push(`${barText(pct)}  ${String(pct).padStart(3)}% used` + (b.right ? `     ${b.right}` : ""));
    out.push("");
  });
  if (out.length) out.pop();
  return out;
}
