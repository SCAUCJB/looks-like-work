/**
 * Agent 面板：把内容伪装成 AI Agent 的逐步输出（Cursor 风格）。
 *
 * 数据源无关——它只认一个 step 列表，每步是「一次工具调用 + 一段正文」。
 * EPUB 版喂章节段落，将来 V2EX 版可以喂楼层回复。
 *
 * 交互模型刻意做成「一步一停」：吐完一段就等确认，
 * 这样它既是伪装，也是一种真的阅读节奏控制。
 *
 * @typedef {Object} AgentStep
 * @property {string} tool          工具名，如 "Read" / "Edit"
 * @property {string} path          目标路径
 * @property {string} [range]       行范围，如 "L12-28"
 * @property {string} text          这一步要吐出的正文
 * @property {{emoji: string, src: string, alt: string}[]} [images]
 * @property {number} [para]        对应的正文段落序号（用于联动编辑器）
 */

import { escapeHtml } from "./util.js";

/** 打字速度档位（毫秒/帧，每帧吐若干字符） */
export const SPEEDS = [
  { id: "slow", label: "慢", cps: 28 },
  { id: "normal", label: "正常", cps: 70 },
  { id: "fast", label: "快", cps: 160 },
  { id: "instant", label: "瞬间", cps: 0 },
];

export const DEFAULT_SPEED = "normal";

export function speedOf(id) {
  return SPEEDS.find((s) => s.id === id) || SPEEDS.find((s) => s.id === DEFAULT_SPEED);
}

/**
 * @param {Object} deps
 * @param {() => HTMLElement | null} deps.bodyEl     消息区容器
 * @param {() => HTMLElement | null} deps.footEl     底部操作条
 * @param {() => string} deps.speedId
 * @param {(step: AgentStep, index: number) => void} [deps.onStep]   每步开始时回调（用于联动编辑器）
 * @param {() => void} [deps.onDone]
 */
export function createAgentRunner({ bodyEl, footEl, speedId, onStep, onDone }) {
  /** @type {AgentStep[]} */
  let steps = [];
  let index = -1;          // 当前已开始的步序号
  let typing = false;      // 是否正在打字
  let auto = false;        // 连续模式
  let timer = null;
  let header = "";         // 用户那条「指令」

  function clearTimer() {
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 恢复历史时最多实际渲染几段，更早的折成一行——否则读到第 200 段时要铺 200 个 DOM 块 */
  const KEEP_HISTORY = 6;

  /**
   * 载入一批步骤。
   * @param {AgentStep[]} nextSteps
   * @param {string} headerText
   * @param {number} [startIndex] 已经"输出过"到第几步（用于接上阅读进度）。
   *                              -1 或省略表示从头开始。
   */
  function load(nextSteps, headerText, startIndex = -1) {
    clearTimer();
    steps = Array.isArray(nextSteps) ? nextSteps : [];
    index = -1;
    typing = false;
    auto = false;
    header = headerText || "";
    const body = bodyEl();
    if (body) {
      body.innerHTML = header
        ? `<div class="vsc-agent-user">${escapeHtml(header)}</div>`
        : "";
    }

    // 接上阅读进度：把此前的段落直接补出来（不打字），让面板看起来"已经输出到这里"
    const start = Math.min(steps.length - 1, Math.floor(Number(startIndex)));
    if (start >= 0) {
      const from = Math.max(0, start - KEEP_HISTORY + 1);
      if (from > 0 && body) {
        const skip = document.createElement("div");
        skip.className = "vsc-agent-skip";
        skip.textContent = `⋯ 前 ${from} 段已输出`;
        body.appendChild(skip);
      }
      for (let i = from; i <= start; i++) {
        index = i;
        appendStep(steps[i], true);
      }
      index = start;
    }
    renderFoot();
  }

  /** 跳到第 n 步（跳过的步骤直接补全文本，不打字） */
  function seek(n) {
    const target = Math.max(0, Math.min(steps.length - 1, n));
    if (target <= index) return;
    while (index < target - 1) {
      index += 1;
      appendStep(steps[index], true);
    }
    next();
  }

  /** 当前这一步对应的段落序号（供外部保存进度） */
  function currentStep() {
    return steps[index] || null;
  }

  /** 推进一步 */
  function next() {
    if (typing || index >= steps.length - 1) return;
    index += 1;
    const step = steps[index];
    onStep?.(step, index);
    appendStep(step, false);
  }

  /**
   * 渲染一步。
   * @param {AgentStep} step
   * @param {boolean} instant 直接出全文，不打字
   */
  function appendStep(step, instant) {
    const body = bodyEl();
    if (!body) return;

    const tool = document.createElement("div");
    tool.className = "vsc-agent-tool running";
    tool.innerHTML =
      `<span class="dot">⏺</span>` +
      `<span class="name">${escapeHtml(step.tool || "Read")}</span>` +
      `<span class="path">${escapeHtml(step.path || "")}</span>` +
      (step.range ? `<span class="range">${escapeHtml(step.range)}</span>` : "");
    body.appendChild(tool);

    const text = document.createElement("div");
    text.className = "vsc-agent-text";
    body.appendChild(text);

    const imgHtml = (step.images || []).map((img) =>
      `<span class="vsc-img-emoji" data-src="${escapeHtml(img.src)}" title="${escapeHtml(img.alt || "")}">${img.emoji}</span>`
    ).join(" ");

    const full = String(step.text || "");
    const cps = speedOf(speedId()).cps;

    const finish = () => {
      tool.classList.remove("running");
      text.innerHTML = escapeHtml(full) + (imgHtml ? ` ${imgHtml}` : "");
      typing = false;
      scrollToEnd();
      renderFoot();
      if (auto && index < steps.length - 1) {
        timer = setTimeout(() => next(), 450);
      } else if (index >= steps.length - 1) {
        onDone?.();
      }
    };

    if (instant || !cps || !full) {
      finish();
      return;
    }

    // 打字机：按帧吐字符，长文也不会卡（每帧字符数随速度走）
    typing = true;
    renderFoot();
    let i = 0;
    const FRAME = 24;                                   // ms
    const perFrame = Math.max(1, Math.round(cps * FRAME / 1000));
    timer = setInterval(() => {
      i = Math.min(full.length, i + perFrame);
      text.innerHTML = `${escapeHtml(full.slice(0, i))}<span class="caret"></span>`;
      scrollToEnd();
      if (i >= full.length) {
        clearTimer();
        finish();
      }
    }, FRAME);
  }

  function scrollToEnd() {
    const body = bodyEl();
    if (body) body.scrollTop = body.scrollHeight;
  }

  /** 正在打字时点「继续」= 先把这段补完 */
  function skipTyping() {
    if (!typing) return false;
    clearTimer();
    const body = bodyEl();
    const last = body?.querySelector(".vsc-agent-text:last-of-type");
    const step = steps[index];
    if (last && step) {
      const imgHtml = (step.images || []).map((img) =>
        `<span class="vsc-img-emoji" data-src="${escapeHtml(img.src)}" title="${escapeHtml(img.alt || "")}">${img.emoji}</span>`
      ).join(" ");
      last.innerHTML = escapeHtml(String(step.text || "")) + (imgHtml ? ` ${imgHtml}` : "");
    }
    body?.querySelector(".vsc-agent-tool.running")?.classList.remove("running");
    typing = false;
    renderFoot();
    scrollToEnd();
    return true;
  }

  /** 主操作：打字中 -> 补完；否则 -> 下一步 */
  function advance() {
    if (skipTyping()) return;
    next();
  }

  function toggleAuto() {
    auto = !auto;
    if (auto && !typing && index < steps.length - 1) next();
    else renderFoot();
  }

  function stop() {
    auto = false;
    clearTimer();
    typing = false;
    renderFoot();
  }

  function renderFoot() {
    const foot = footEl();
    if (!foot) return;
    const total = steps.length;
    const done = index + 1;
    const finished = total > 0 && index >= total - 1 && !typing;

    if (!total) {
      foot.innerHTML = `<div class="vsc-agent-hint">打开一个章节后开始</div>`;
      return;
    }
    foot.innerHTML = `
      <div class="vsc-agent-hint">
        <span>${done} / ${total} 段</span>
        <span class="spacer"></span>
        <span>${typing ? "generating…" : finished ? "done" : auto ? "auto" : "paused"}</span>
      </div>
      <div class="vsc-agent-btns">
        <button type="button" class="vsc-agent-btn primary" data-agent="next" ${finished ? "disabled" : ""}>
          ${typing ? "跳过本段" : finished ? "已完成" : "继续"} <kbd>⏎</kbd>
        </button>
        <button type="button" class="vsc-agent-btn" data-agent="auto" ${finished ? "disabled" : ""}>
          ${auto ? "暂停" : "连续"}
        </button>
      </div>`;
  }

  return {
    load,
    next,
    seek,
    currentStep,
    advance,
    toggleAuto,
    stop,
    renderFoot,
    get index() { return index; },
    get total() { return steps.length; },
    get typing() { return typing; },
    get auto() { return auto; },
    get finished() { return steps.length > 0 && index >= steps.length - 1 && !typing; },
  };
}
