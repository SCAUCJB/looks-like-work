# V2EX · VS Code 工作区（油猴脚本）

把 V2EX 整站换成 VS Code 外观：帖子渲染成伪代码文件，正文和回复以注释形式显示，
图片折叠成 emoji（hover 出半透明预览）。

## 安装

1. 装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 都有）
2. 打开 [`v2ex-vscode-workspace.user.js`](v2ex-vscode-workspace.user.js) 的
   [raw 链接](https://raw.githubusercontent.com/SCAUCJB/looks-like-work/main/userscript/v2ex-vscode-workspace.user.js)
3. Tampermonkey 会拦截并弹出安装页，点「安装」

脚本头里写了 `@updateURL`，之后 Tampermonkey 会自动检查更新。

## 用法

| 操作 | 效果 |
|---|---|
| 活动栏图标 | 切换资源管理器 / 搜索 |
| 右下角语言标识 | 切换伪代码语言（Vue SFC / Java / JS / TS / Python / Go / Rust / C++） |
| 右下角主题图标 | Light+ / Dark+ |
| 拖拽 TERMINAL 上边缘 | 调整面板高度 |
| 双击 TERMINAL 标题栏 | 折叠 / 展开面板 |

评论全部渲染在 TERMINAL 里，按显示宽度折行（中日韩按 2 列算），不会横向溢出。

## 和 `src/` 是什么关系

这个脚本目前是**独立的单文件**，没有用 `src/shell/` 那套共享层。

共享层是从它里面抽出来的 —— EPUB / PDF 阅读器用的就是抽出来的那一份。
把这个脚本也切过去是计划内的事，但还没做：它要在油猴环境里跑，
需要处理宿主页面的样式冲突（`style.js` 里的 `hostTakeover` 开关就是为此留的），
比内联一份 HTML 麻烦。

在切过去之前，两边的 shell 逻辑会各自演进，修 bug 时注意两处都要看。

## 已知限制

- 只适配 v2ex.com，换域名要改 `@match`
- 和其他 V2EX 换肤脚本冲突（检测到企微换肤会自动跳过）
- 登录、发帖等操作仍走原站逻辑，只改了外观
