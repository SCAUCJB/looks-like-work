# 第三方组件

本项目自身以 MIT 许可发布（见 `LICENSE`）。分发的产物中包含以下第三方组件，
它们各自的许可条款依然适用。

## pdf.js (pdfjs-dist) 4.10.38

- 许可：Apache License 2.0
- 版权：Copyright 2012 Mozilla Foundation
- 主页：https://github.com/mozilla/pdf.js
- 许可全文：[`vendor/LICENSE-pdf.js.txt`](vendor/LICENSE-pdf.js.txt)

源文件为 `vendor/pdf.min.mjs` 与 `vendor/pdf.worker.min.mjs`，由 `build.mjs`
**内联进 `dist/reader-vscode.html`**。因此分发该产物即等同于分发 pdf.js，
其 Apache-2.0 条款随之生效——产物头部保留了许可声明注释。

`dist/epub-vscode.html` 不含 pdf.js。

上游未提供 `NOTICE` 文件，故本项目也无需随附。
