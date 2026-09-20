// VS Code 外壳样式（Light+ / Dark+），从 V2EX 工作区脚本抽取，两个项目共享
// 需要的外部变量由调用方通过 buildCss(ctx) 注入

export function buildCss(ctx) {
  const {
    ROOT_CLASS,
    LIGHT_CLASS = "vsc-light",
    LOCK_CLASS = "vsc-locked",
    storedPanelH,
    sideWidth,
    // 这三个漏传会让整个样式表构建抛异常、页面变白板，所以给默认实现
    codeSize = () => 13,
    codeLine = () => 18,
    gutterW = () => 56,
    // 宿主接管：只有作为用户脚本嵌进别人的页面时才需要（V2EX 版 = true）。
    // 独立页面（EPUB 版）必须为 false，否则 body 会被强制 overflow:hidden。
    hostTakeover = false,
  } = ctx;

  const hostCss = hostTakeover
    ? `/* IDE 模式（.${LOCK_CLASS}）接管宿主页面 */
html.${ROOT_CLASS}.${LOCK_CLASS}, html.${ROOT_CLASS}.${LOCK_CLASS} body {
  background: var(--vsc-editor) !important;
  color: var(--vsc-fg) !important;
  font-family: var(--vsc-ui) !important;
  overflow: hidden !important;
}
.${ROOT_CLASS}.${LOCK_CLASS} #Top, .${ROOT_CLASS}.${LOCK_CLASS} #Bottom,
.${ROOT_CLASS}.${LOCK_CLASS} #Rightbar, .${ROOT_CLASS}.${LOCK_CLASS} #Leftbar,
.${ROOT_CLASS}.${LOCK_CLASS} .adsbygoogle, .${ROOT_CLASS}.${LOCK_CLASS} .wwads-cn,
.${ROOT_CLASS}.${LOCK_CLASS} #pro-campaign-container {
  display: none !important;
}
.${ROOT_CLASS}.${LOCK_CLASS} #Wrapper {
  position: fixed !important; left: -9999px !important; width: 1px !important; height: 1px !important;
  overflow: hidden !important; opacity: 0 !important; pointer-events: none !important;
}`
    : "";

  const fabCss = hostTakeover
    ? `.vsc-fab {
  position: fixed; right: 16px; bottom: 28px; z-index: 700;
  height: 28px; padding: 0 10px; border: 0; border-radius: 2px;
  background: var(--vsc-status); color: #fff; cursor: pointer; display: none;
}
html.${ROOT_CLASS}:not(.${LOCK_CLASS}) .vsc-app { display: none !important; }
html.${ROOT_CLASS}:not(.${LOCK_CLASS}) .vsc-fab { display: inline-flex; align-items: center; }`
    : "";

  return `
html.${ROOT_CLASS} {
  --vsc-act: #333333;
  --vsc-side: #252526;
  --vsc-editor: #1e1e1e;
  --vsc-title: #3c3c3c;
  --vsc-status: #007acc;
  --vsc-border: #3e3e42;
  --vsc-hover: #2a2d2e;
  --vsc-active: #094771;
  --vsc-fg: #cccccc;
  --vsc-fg2: #bbbbbb;
  --vsc-fg3: #858585;
  --vsc-tab: #2d2d2d;
  --vsc-kw: #569cd6;
  --vsc-fn: #dcdcaa;
  --vsc-str: #ce9178;
  --vsc-cm: #6a9955;
  --vsc-tag: #4ec9b0;
  --vsc-attr: #9cdcfe;
  --vsc-num: #b5cea8;
  --vsc-punc: #d4d4d4;
  --vsc-plain: #d4d4d4;
  --vsc-on: #ffffff;
  --vsc-chrome: #000000;
  --vsc-input: #3c3c3c;
  --vsc-scroll: #424242;
  --vsc-tab-fg: #969696;
  --vsc-tab-sep: #252526;
  --vsc-line-hover: #2a2a2a;
  --vsc-fence: #202020;
  --vsc-panel: #1e1e1e;
  --vsc-panel-line: #2b2b2b;
  --vsc-icon: #858585;
  --vsc-icon-active: #ffffff;
  --vsc-icon-hover: #505050;
  --vsc-btn: #0e639c;
  --vsc-btn-hover: #1177bb;
  --vsc-link: #3794ff;
  --vsc-err: #f48771;
  --vsc-pop: #111111;
  --vsc-menu: #252526;
  --vsc-welcome: #ffffff;
  --vsc-shadow: rgba(0,0,0,.5);
  --vsc-side-w: ${sideWidth()};
  --vsc-agent-w: 0px;   /* Agent 面板宽度，关闭时为 0 */
  /* 编辑器字号三件套：必须联动，否则行号列和代码行会错位 */
  --vsc-code-size: ${codeSize()}px;
  --vsc-code-line: ${codeLine()}px;
  --vsc-gutter-w: ${gutterW()}px;
  --vsc-panel-h: ${storedPanelH() || "clamp(180px, 34vh, 460px)"};
  --vsc-ui: "Segoe UI", "PingFang SC", "Microsoft YaHei", -apple-system, sans-serif;
  --vsc-mono: "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace;
}
html.${ROOT_CLASS}.${LIGHT_CLASS} {
  --vsc-act: #e8e8e8;
  --vsc-side: #f3f3f3;
  --vsc-editor: #ffffff;
  --vsc-title: #dddddd;
  --vsc-status: #007acc;
  --vsc-border: #e5e5e5;
  --vsc-hover: #e8e8e8;
  --vsc-active: #0060c0;
  --vsc-fg: #333333;
  --vsc-fg2: #444444;
  --vsc-fg3: #6e6e6e;
  --vsc-tab: #ececec;
  --vsc-kw: #0000ff;
  --vsc-fn: #795e26;
  --vsc-str: #a31515;
  --vsc-cm: #008000;
  --vsc-tag: #267f99;
  --vsc-attr: #001080;
  --vsc-num: #098658;
  --vsc-punc: #393a34;
  --vsc-plain: #333333;
  --vsc-on: #1e1e1e;
  --vsc-chrome: #d4d4d4;
  --vsc-input: #ffffff;
  --vsc-scroll: #c1c1c1;
  --vsc-tab-fg: #6e6e6e;
  --vsc-tab-sep: #e5e5e5;
  --vsc-line-hover: #f5f5f5;
  --vsc-fence: #f6f8f4;
  --vsc-panel: #f3f3f3;
  --vsc-panel-line: #e5e5e5;
  --vsc-icon: #616161;
  --vsc-icon-active: #1e1e1e;
  --vsc-icon-hover: #d0d0d0;
  --vsc-btn: #007acc;
  --vsc-btn-hover: #0062a3;
  --vsc-link: #006ab1;
  --vsc-err: #e51400;
  --vsc-pop: #ffffff;
  --vsc-menu: #ffffff;
  --vsc-welcome: #1e1e1e;
  --vsc-shadow: rgba(0,0,0,.18);
}
${hostCss}
.vsc-app, .vsc-app * { box-sizing: border-box; }
.vsc-app {
  position: fixed; inset: 0; z-index: 200;
  display: grid;
  grid-template-rows: 30px minmax(0, 1fr) 22px;
  grid-template-columns: 48px var(--vsc-side-w) minmax(0, 1fr) var(--vsc-agent-w);
  background: var(--vsc-editor);
  color: var(--vsc-fg);
  font-family: var(--vsc-ui);
  overflow: hidden;
}
.vsc-titlebar {
  grid-column: 1 / -1;
  background: var(--vsc-title);
  display: flex; align-items: center; gap: 10px;
  padding: 0 10px; font-size: 12px; color: var(--vsc-fg);
  border-bottom: 1px solid var(--vsc-chrome);
  user-select: none;
}
.vsc-dots { display: flex; gap: 6px; }
.vsc-dots i { width: 10px; height: 10px; border-radius: 50%; display: block; }
.vsc-dots i:nth-child(1) { background: #ff5f57; }
.vsc-dots i:nth-child(2) { background: #febc2e; }
.vsc-dots i:nth-child(3) { background: #28c840; }
.vsc-menubar { display: flex; gap: 0; color: var(--vsc-fg); }
.vsc-menu-item {
  border: 0; background: transparent; color: inherit; font: inherit;
  padding: 3px 8px; border-radius: 4px; cursor: pointer; opacity: .85;
  line-height: 1.4; white-space: nowrap;
}
.vsc-menu-item:hover { background: var(--vsc-icon-hover); opacity: 1; }
.vsc-menu-item.open { background: var(--vsc-icon-hover); opacity: 1; }
/* 下拉面板 */
.vsc-menu-pop {
  position: fixed; z-index: 800; min-width: 220px; max-width: 340px;
  background: var(--vsc-menu); border: 1px solid var(--vsc-border);
  border-radius: 6px; box-shadow: 0 8px 28px var(--vsc-shadow);
  padding: 4px; display: none; font-family: var(--vsc-ui); font-size: 13px;
}
.vsc-menu-pop.open { display: block; }
.vsc-menu-row {
  display: flex; align-items: center; gap: 12px;
  padding: 5px 10px; border-radius: 4px; cursor: pointer; color: var(--vsc-fg);
}
.vsc-menu-row:hover { background: var(--vsc-active); color: #fff; }
.vsc-menu-row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vsc-menu-row .hint { margin-left: auto; font-size: 11px; opacity: .6; flex-shrink: 0; }
.vsc-menu-row.disabled { opacity: .4; pointer-events: none; }
.vsc-menu-sep { height: 1px; margin: 4px 6px; background: var(--vsc-border); }
.vsc-menu-title {
  padding: 4px 10px 2px; font-size: 11px; color: var(--vsc-fg3);
  text-transform: uppercase; letter-spacing: .5px;
}
.vsc-title-center { margin: 0 auto; color: var(--vsc-fg2); font-size: 12px; }
.vsc-title-actions { display: flex; align-items: center; gap: 2px; }
.vsc-icon-btn {
  width: 26px; height: 26px; flex: 0 0 26px; padding: 0;
  border: 0; background: transparent; color: var(--vsc-fg2);
  cursor: pointer; border-radius: 5px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .12s ease, color .12s ease;
}
.vsc-icon-btn:hover { background: var(--vsc-icon-hover); color: var(--vsc-on); }
.vsc-icon-btn:active { transform: translateY(.5px); }
/* 激活态用淡色底 + 主题色图标，比整块实心蓝底克制 */
.vsc-icon-btn.on {
  color: var(--vsc-status);
  background: color-mix(in srgb, var(--vsc-status) 18%, transparent);
}
.vsc-icon-btn.on:hover { background: color-mix(in srgb, var(--vsc-status) 28%, transparent); }
/* display:block 是关键：inline 的 svg 会吃 line-height 产生基线下沉，看起来就是没对齐 */
.vsc-icon-btn svg {
  display: block; width: 16px; height: 16px;
  stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
}
.vsc-activity {
  grid-row: 2 / 3; grid-column: 1 / 2;
  background: var(--vsc-act);
  display: flex; flex-direction: column; align-items: center;
  padding: 4px 0; border-right: 1px solid var(--vsc-chrome);
  min-height: 0; overflow: hidden;
}
.vsc-act-btn {
  width: 48px; height: 48px; border: 0; background: transparent; color: var(--vsc-icon);
  cursor: pointer; position: relative;
}
.vsc-act-btn svg { display: block; width: 24px; height: 24px; stroke-linecap: round; stroke-linejoin: round; }
.vsc-act-btn.active { color: var(--vsc-icon-active); }
.vsc-act-btn.active::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; background: var(--vsc-icon-active);
}
.vsc-act-btn:hover { color: var(--vsc-icon-active); }
.vsc-act-badge {
  position: absolute; right: 8px; bottom: 8px; min-width: 16px; height: 16px; padding: 0 4px;
  background: var(--vsc-status); color: #fff; font-size: 9px; line-height: 16px; border-radius: 8px;
}
.vsc-act-spacer { flex: 1; }
.vsc-act-btn.vsc-agent-act.on { color: var(--vsc-icon-active); }
.vsc-act-btn.vsc-agent-act.on::before {
  content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; background: var(--vsc-icon-active);
}
.vsc-sidebar {
  grid-row: 2 / 3; grid-column: 2 / 3;
  background: var(--vsc-side);
  border-right: 1px solid var(--vsc-border);
  display: flex; flex-direction: column;
  min-width: 0; min-height: 0; overflow: hidden;
}
.vsc-side-head {
  height: 35px; padding: 0 12px; display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; letter-spacing: .8px; color: var(--vsc-fg2); text-transform: uppercase;
}
.vsc-side-search {
  margin: 0 8px 8px; height: 24px; background: var(--vsc-input); border: 1px solid var(--vsc-border);
  color: var(--vsc-fg); padding: 0 8px; font-size: 12px; outline: none; width: calc(100% - 16px);
  font-family: var(--vsc-ui);
}
.vsc-side-search:focus { border-color: var(--vsc-status); }
.vsc-tree {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-size: 13px;
  padding-bottom: 12px;
}
.vsc-tree::-webkit-scrollbar { width: 10px; }
.vsc-tree::-webkit-scrollbar-thumb { background: var(--vsc-scroll); }
.vsc-tree-row {
  display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px;
  cursor: pointer; color: var(--vsc-fg); white-space: nowrap; overflow: hidden;
}
.vsc-tree-row:hover { background: var(--vsc-hover); }
.vsc-tree-row.active { background: var(--vsc-active); color: #fff; }
.vsc-tree-row .chev { width: 10px; color: var(--vsc-fg3); font-size: 10px; }
.vsc-file-ico { width: 14px; text-align: center; flex-shrink: 0; font-size: 12px; }
.vsc-file-name { overflow: hidden; text-overflow: ellipsis; }
.vsc-file-meta { margin-left: auto; color: var(--vsc-fg3); font-size: 11px; padding-left: 8px; }
.vsc-work {
  grid-row: 2 / 3; grid-column: 3 / 4;
  display: grid;
  grid-template-rows: 35px 22px minmax(0, 1fr) var(--vsc-panel-h);
  min-width: 0; min-height: 0; overflow: hidden;
  background: var(--vsc-editor);
}
/* 折叠：面板只留 28px 的 tabs 行，仍可点击/双击展开 */
.vsc-app.panel-off .vsc-work { grid-template-rows: 35px 22px minmax(0, 1fr) 28px; }
.vsc-app.panel-off .vsc-panel-body,
.vsc-app.panel-off .vsc-reply-form { display: none; }
.vsc-app.panel-off .vsc-panel-tabs { border-bottom: 0; }
.vsc-tabs {
  display: flex; align-items: stretch; background: var(--vsc-side); overflow-x: auto;
  border-bottom: 1px solid var(--vsc-border);
}
.vsc-tabs::-webkit-scrollbar { height: 0; }
.vsc-tab {
  display: flex; align-items: center; gap: 8px; padding: 0 12px;
  background: var(--vsc-tab); color: var(--vsc-tab-fg); font-size: 13px; border-right: 1px solid var(--vsc-tab-sep);
  cursor: pointer; max-width: 220px; min-width: 80px; white-space: nowrap;
}
.vsc-tab.active { background: var(--vsc-editor); color: var(--vsc-on); }
.vsc-tab .x {
  border: 0; background: transparent; color: inherit; cursor: pointer; opacity: .5; font-size: 14px; padding: 0 2px;
}
.vsc-tab .x:hover { opacity: 1; }
.vsc-crumb {
  display: flex; align-items: center; gap: 6px; padding: 0 12px;
  font-size: 12px; color: var(--vsc-fg2); border-bottom: 1px solid var(--vsc-border); background: var(--vsc-editor);
}
.vsc-crumb span { opacity: .7; }
.vsc-editor {
  min-width: 0; min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  font-family: var(--vsc-mono); font-size: var(--vsc-code-size); line-height: var(--vsc-code-line);
  background: var(--vsc-editor); position: relative;
}
.vsc-editor::-webkit-scrollbar { width: 10px; height: 10px; }
.vsc-editor::-webkit-scrollbar-thumb { background: var(--vsc-scroll); }
/* 宽度测量探针：不可见、不占位、不参与布局，但字体与正文完全一致 */
.vsc-measure {
  position: absolute; visibility: hidden; pointer-events: none;
  white-space: pre; top: 0; left: 0; height: 0; overflow: hidden;
}
.vsc-code { display: grid; grid-template-columns: var(--vsc-gutter-w) 1fr; min-width: max-content; }
.vsc-gutter {
  text-align: right; padding: 8px 12px 8px 0; color: var(--vsc-fg3); user-select: none;
  background: var(--vsc-editor);
}
.vsc-gutter div { height: var(--vsc-code-line); }
/* 不再硬撑 640px：正文已按宽度折行，窄窗口不该被迫横向滚动 */
.vsc-lines { padding: 8px 20px 40px 0; min-width: 0; }
.vsc-line { height: var(--vsc-code-line); white-space: pre; }
.vsc-line:hover { background: var(--vsc-line-hover); }
.vsc-line.vsc-fence {
  background: var(--vsc-fence);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vsc-cm) 50%, transparent);
}
.vsc-kw { color: var(--vsc-kw); }
.vsc-fn { color: var(--vsc-fn); }
.vsc-str { color: var(--vsc-str); }
.vsc-cm { color: var(--vsc-cm); font-style: italic; }
.vsc-tag { color: var(--vsc-tag); }
.vsc-attr { color: var(--vsc-attr); }
.vsc-num { color: var(--vsc-num); }
.vsc-punc { color: var(--vsc-punc); }
.vsc-plain { color: var(--vsc-plain); }
.vsc-img-emoji {
  display: inline-block; cursor: zoom-in; font-style: normal; font-size: 15px;
  padding: 0 2px; border-radius: 3px; line-height: 1;
}
.vsc-img-emoji:hover { background: color-mix(in srgb, var(--vsc-on) 8%, transparent); }
.vsc-img-pop {
  position: fixed; z-index: 9999; width: 500px; max-width: min(500px, 70vw);
  pointer-events: none; opacity: 0; transform: translateY(6px);
  transition: opacity .12s ease, transform .12s ease;
  border: 1px solid var(--vsc-status); border-radius: 4px; overflow: hidden;
  box-shadow: 0 12px 40px var(--vsc-shadow); background: var(--vsc-pop);
}
.vsc-img-pop.show { opacity: 1; transform: none; }
.vsc-img-pop img { display: block; width: 500px; max-width: 100%; height: auto; opacity: .5; }
.vsc-panel {
  position: relative;
  background: var(--vsc-panel); border-top: 1px solid var(--vsc-border);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
/* 面板顶部可拖拽分隔线：上下拖动调整 TERMINAL 高度，双击复位 */
.vsc-panel-resizer {
  position: absolute; top: -2px; left: 0; right: 0; height: 6px;
  cursor: ns-resize; z-index: 400; background: transparent;
  transition: background .12s ease;
}
.vsc-panel-resizer:hover,
.vsc-app.panel-resizing .vsc-panel-resizer { background: var(--vsc-status); }
.vsc-app.panel-resizing { cursor: ns-resize; user-select: none; }
.vsc-app.panel-resizing .vsc-panel-body { overflow-y: hidden; }
.vsc-app.panel-off .vsc-panel-resizer { display: none; }
.vsc-panel-tabs {
  height: 28px; display: flex; align-items: center; gap: 16px; padding: 0 12px;
  font-size: 11px; letter-spacing: .6px; color: var(--vsc-fg3); text-transform: uppercase;
  border-bottom: 1px solid var(--vsc-panel-line);
  user-select: none; cursor: default;
}
/* 折叠/展开按钮，靠右 */
.vsc-panel-toggle {
  margin-left: auto; border: 0; background: transparent; color: var(--vsc-fg3);
  cursor: pointer; font-size: 13px; line-height: 1; padding: 4px 6px; border-radius: 3px;
}
.vsc-panel-toggle:hover { background: var(--vsc-hover); color: var(--vsc-on); }
.vsc-panel-tabs button {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  font-size: 11px; letter-spacing: .6px; text-transform: uppercase; padding: 6px 0;
}
.vsc-panel-tabs button.on { color: var(--vsc-on); border-bottom: 1px solid var(--vsc-on); }
.vsc-panel-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 8px 12px; font-family: var(--vsc-mono); font-size: 12px; color: var(--vsc-fg);
}
/* 行内删除按钮：树行与面板行右侧的 ×，hover 才显形 */
.vsc-row-x {
  margin-left: auto; border: 0; background: transparent; color: var(--vsc-fg3);
  cursor: pointer; font-size: 15px; line-height: 1; padding: 0 4px; border-radius: 3px;
  opacity: 0; flex-shrink: 0; transition: opacity .12s ease;
}
.vsc-tree-row:hover .vsc-row-x,
.vsc-term-line:hover .vsc-row-x { opacity: .6; }
.vsc-row-x:hover { opacity: 1 !important; color: var(--vsc-err); background: var(--vsc-hover); }
/* 带行内按钮的面板行：.vsc-term-line 本身是 pre-wrap 的块元素，
   margin-left:auto 不生效，所以带按钮的行额外加这个 flex 变体 */
.vsc-term-row {
  display: flex; align-items: baseline; gap: 4px; white-space: nowrap;
}
.vsc-term-row > .vsc-term-note {
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
/* 面板里的可点条目 */
.vsc-term-link { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
.vsc-term-link:hover { color: var(--vsc-on); }
.vsc-term-line {
  white-space: pre-wrap; margin: 0 0 4px;
  overflow-wrap: anywhere; word-break: break-word; line-height: 1.5;
}
/* 回复行：首行顶格，折行后悬挂缩进，便于区分楼层 */
.vsc-term-reply { padding-left: 2ch; text-indent: -2ch; }
.vsc-term-reply + .vsc-term-reply { margin-top: 6px; }
.vsc-term-muted { color: var(--vsc-cm); }
.vsc-term-warn { color: var(--vsc-fn); }
.vsc-term-err { color: var(--vsc-err); }
.vsc-reply-form { display: flex; gap: 8px; padding: 6px 12px 8px; border-top: 1px solid var(--vsc-panel-line); }
.vsc-reply-form input {
  flex: 1; height: 26px; background: var(--vsc-input); border: 1px solid var(--vsc-border); color: var(--vsc-fg);
  padding: 0 8px; font-family: var(--vsc-mono); font-size: 12px; outline: none;
}
.vsc-reply-form input:focus { border-color: var(--vsc-status); }
.vsc-reply-form button {
  height: 26px; padding: 0 12px; border: 0; background: var(--vsc-btn); color: #fff; cursor: pointer; font-size: 12px;
}
.vsc-reply-form button:hover { background: var(--vsc-btn-hover); }
/* ============== Agent 面板（Cursor 风格） ============== */
.vsc-agent {
  grid-row: 2 / 3; grid-column: 4 / 5;
  background: var(--vsc-side);
  border-left: 1px solid var(--vsc-border);
  display: flex; flex-direction: column;
  min-width: 0; min-height: 0; overflow: hidden;
  font-family: var(--vsc-ui);
}
.vsc-app:not(.agent-on) .vsc-agent { display: none; }
/* 绝对定位，不占网格格子——占了就会把 .vsc-agent 挤走 */
.vsc-agent-resizer {
  position: absolute; top: 30px; bottom: 22px;
  right: calc(var(--vsc-agent-w) - 2px);
  width: 5px; cursor: col-resize; z-index: 400;
  background: transparent; transition: background .12s ease;
}
.vsc-app:not(.agent-on) .vsc-agent-resizer { display: none; }
.vsc-agent-resizer:hover, .vsc-app.agent-resizing .vsc-agent-resizer { background: var(--vsc-status); }
.vsc-agent-head {
  height: 35px; flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; border-bottom: 1px solid var(--vsc-border);
  font-size: 11px; letter-spacing: .6px; text-transform: uppercase; color: var(--vsc-fg2);
}
.vsc-agent-model {
  margin-left: auto; text-transform: none; letter-spacing: 0;
  font-size: 11px; color: var(--vsc-fg3);
  padding: 2px 6px; border: 1px solid var(--vsc-border); border-radius: 10px;
}
/* 速度切换：外观同 model chip，但可点 */
.vsc-agent-speed {
  text-transform: none; letter-spacing: 0; font-family: var(--vsc-ui);
  font-size: 11px; color: var(--vsc-fg3); cursor: pointer;
  padding: 2px 8px; border: 1px solid var(--vsc-border); border-radius: 10px;
  background: transparent; flex-shrink: 0;
}
.vsc-agent-speed:hover { background: var(--vsc-hover); color: var(--vsc-on); border-color: var(--vsc-fg3); }
.vsc-agent-speed::before { content: "⚡ "; opacity: .7; }
.vsc-agent-x {
  border: 0; background: transparent; color: var(--vsc-fg3); cursor: pointer;
  font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 3px;
}
.vsc-agent-x:hover { background: var(--vsc-hover); color: var(--vsc-on); }
.vsc-agent-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 12px 12px 4px; font-size: 13px; line-height: 1.65; color: var(--vsc-fg);
}
.vsc-agent-body::-webkit-scrollbar { width: 10px; }
.vsc-agent-body::-webkit-scrollbar-thumb { background: var(--vsc-scroll); }
/* 用户那条「指令」 */
.vsc-agent-user {
  background: var(--vsc-editor); border: 1px solid var(--vsc-border); border-radius: 6px;
  padding: 8px 10px; margin-bottom: 14px; color: var(--vsc-fg2); font-size: 12px;
}
.vsc-agent-user::before { content: "› "; color: var(--vsc-status); }
/* 工具调用行 */
.vsc-agent-tool {
  display: flex; align-items: baseline; gap: 6px; margin: 14px 0 6px;
  font-family: var(--vsc-mono); font-size: 11px; color: var(--vsc-fg3);
}
.vsc-agent-tool .dot { color: var(--vsc-cm); }
.vsc-agent-tool .name { color: var(--vsc-fn); }
.vsc-agent-tool .path { color: var(--vsc-attr); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vsc-agent-tool .range { color: var(--vsc-fg3); flex-shrink: 0; }
.vsc-agent-tool.running .dot { animation: vsc-blink 1s steps(2) infinite; }
@keyframes vsc-blink { 50% { opacity: .25; } }
/* Agent 正文 */
.vsc-agent-text {
  white-space: pre-wrap; overflow-wrap: anywhere;
  margin: 0 0 4px; padding-left: 10px;
  border-left: 2px solid color-mix(in srgb, var(--vsc-cm) 45%, transparent);
}
.vsc-agent-text .caret {
  display: inline-block; width: 7px; height: 1em; vertical-align: text-bottom;
  background: var(--vsc-fg); animation: vsc-blink .9s steps(2) infinite;
}
.vsc-agent-text .vsc-img-emoji { font-size: 15px; }
/* Usage（仿 Claude Code 的额度显示） */
.vsc-usage {
  flex-shrink: 0; border-top: 1px solid var(--vsc-border);
  padding: 10px 12px 2px; display: flex; flex-direction: column; gap: 10px;
}
.vsc-usage-row { display: flex; flex-direction: column; gap: 4px; }
.vsc-usage-head {
  display: flex; align-items: baseline; gap: 5px; font-size: 11px; color: var(--vsc-fg2);
}
.vsc-usage-head .win { color: var(--vsc-fg3); }
.vsc-usage-head .reset { margin-left: auto; color: var(--vsc-fg3); font-size: 10px; }
.vsc-usage-bar {
  height: 6px; border-radius: 3px; overflow: hidden;
  background: color-mix(in srgb, var(--vsc-fg3) 28%, transparent);
}
.vsc-usage-bar i {
  display: block; height: 100%; background: var(--vsc-status);
  transition: width .25s ease;
}
.vsc-usage-bar i.high { background: var(--vsc-fn); }
.vsc-usage-bar i.done { background: var(--vsc-cm); }
.vsc-usage-foot {
  display: flex; font-size: 10px; color: var(--vsc-fg3);
}
.vsc-usage-foot .right { margin-left: auto; }
/* 底部操作条 */
.vsc-agent-foot {
  flex-shrink: 0; border-top: 1px solid var(--vsc-border);
  padding: 8px 10px; display: flex; flex-direction: column; gap: 8px;
}
.vsc-agent-hint { font-size: 11px; color: var(--vsc-fg3); display: flex; gap: 8px; align-items: center; }
.vsc-agent-hint .spacer { margin-left: auto; }
.vsc-agent-btns { display: flex; gap: 6px; }
.vsc-agent-btn {
  flex: 1; height: 28px; border: 1px solid var(--vsc-border); border-radius: 4px;
  background: var(--vsc-editor); color: var(--vsc-fg); cursor: pointer; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.vsc-agent-btn:hover:not(:disabled) { background: var(--vsc-hover); border-color: var(--vsc-fg3); }
.vsc-agent-btn:disabled { opacity: .4; cursor: default; }
.vsc-agent-btn.primary { background: var(--vsc-btn); border-color: var(--vsc-btn); color: #fff; }
.vsc-agent-btn.primary:hover:not(:disabled) { background: var(--vsc-btn-hover); }
.vsc-agent-btn kbd {
  font-family: var(--vsc-mono); font-size: 10px; opacity: .7;
  border: 1px solid currentColor; border-radius: 3px; padding: 0 3px; line-height: 1.4;
}
/* 折叠掉的历史段落 */
.vsc-agent-skip {
  font-size: 11px; color: var(--vsc-fg3); text-align: center;
  padding: 6px 0; margin-bottom: 6px;
  border-bottom: 1px dashed var(--vsc-border);
}
.vsc-agent-done {
  text-align: center; color: var(--vsc-fg3); font-size: 12px; padding: 10px 0 2px;
}
.vsc-status {
  grid-column: 1 / -1;
  background: var(--vsc-status); color: #fff; display: flex; align-items: center;
  font-size: 12px; padding: 0 8px; gap: 12px; user-select: none;
}
.vsc-status .right { margin-left: auto; display: flex; gap: 14px; }
.vsc-welcome {
  padding: 48px 56px; max-width: 860px; color: var(--vsc-fg); font-family: var(--vsc-ui);
}
.vsc-welcome h1 { font-weight: 300; font-size: 26px; color: var(--vsc-welcome); margin: 0 0 8px; }
.vsc-welcome .sub { color: var(--vsc-fg3); margin-bottom: 28px; }
.vsc-welcome h2 { font-size: 13px; letter-spacing: .6px; text-transform: uppercase; color: var(--vsc-fg3); }
.vsc-welcome a, .vsc-welcome .link {
  color: var(--vsc-link); cursor: pointer; text-decoration: none; display: block; margin: 6px 0;
}
.vsc-palette {
  position: fixed; left: 50%; top: 12%; transform: translateX(-50%);
  width: min(640px, 80vw); z-index: 800; background: var(--vsc-menu);
  border: 1px solid var(--vsc-status); box-shadow: 0 16px 48px var(--vsc-shadow); display: none;
}
.vsc-palette.open { display: block; }
.vsc-palette input {
  width: 100%; height: 40px; border: 0; background: var(--vsc-input); color: var(--vsc-fg);
  padding: 0 14px; font-size: 14px; outline: none; font-family: var(--vsc-ui);
  border-bottom: 1px solid var(--vsc-border);
}
.vsc-palette-list { max-height: 320px; overflow: auto; }
.vsc-palette-item {
  padding: 6px 14px; font-size: 13px; cursor: pointer; color: var(--vsc-fg);
  display: flex; justify-content: space-between;
}
.vsc-palette-item:hover, .vsc-palette-item.on { background: var(--vsc-active); color: #fff; }
${fabCss}
.vsc-side-resizer {
  position: absolute; top: 30px; bottom: 22px; width: 4px; cursor: col-resize; z-index: 400;
  left: calc(48px + var(--vsc-side-w) - 2px);
}
.vsc-lang { cursor: pointer; padding: 0 6px; border-radius: 3px; }
.vsc-lang:hover, .vsc-theme-chip:hover { background: rgba(255,255,255,.18); }
.vsc-theme-chip { cursor: pointer; padding: 0 6px; border-radius: 3px; }
.vsc-lang-menu {
  position: fixed; right: 10px; bottom: 26px; z-index: 760; min-width: 150px;
  background: var(--vsc-menu); border: 1px solid var(--vsc-status); display: none;
  box-shadow: 0 8px 24px var(--vsc-shadow); font-family: var(--vsc-ui);
}
.vsc-lang-menu.open { display: block; }
.vsc-lang-item {
  padding: 6px 14px; font-size: 12px; color: var(--vsc-fg); cursor: pointer;
  display: flex; justify-content: space-between; gap: 14px;
}
.vsc-lang-item:hover { background: var(--vsc-active); color: #fff; }
.vsc-lang-item.on { color: var(--vsc-on); }
.vsc-lang-item.on::after { content: "✓"; margin-left: auto; }
.vsc-lang-item .ext { color: var(--vsc-fg3); }
.vsc-lang-item:hover .ext { color: #ddd; }
.vsc-list-pager {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-top: 1px solid var(--vsc-border); font-size: 12px; color: var(--vsc-fg2);
}
.vsc-list-pager:empty { display: none; }
.vsc-pg-btn {
  border: 0; background: var(--vsc-input); color: var(--vsc-fg); font-size: 12px; cursor: pointer;
  padding: 2px 10px; border-radius: 3px; font-family: var(--vsc-ui); border: 1px solid var(--vsc-border);
}
.vsc-pg-btn:hover:not(:disabled) { background: var(--vsc-status); color: #fff; border-color: var(--vsc-status); }
.vsc-pg-btn:disabled { opacity: .4; cursor: default; }
.vsc-pg-label { margin: 0 auto; color: var(--vsc-fg3); font-size: 11px; }
.vsc-crumb-pager { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.vsc-crumb-pager .vsc-pg-label { margin: 0; }
`;
}

export function injectStyle(styleId, css) {
  const old = document.getElementById(styleId);
  if (old) old.remove();
  const el = document.createElement("style");
  el.id = styleId;
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
}
