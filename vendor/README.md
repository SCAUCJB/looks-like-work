# vendor

构建时内联进 `dist/reader-vscode.html` 的第三方文件，**只有带 PDF 支持的那个产物会用到**。

| 文件 | 来源 | 版本 |
|---|---|---|
| `pdf.min.mjs` | `pdfjs-dist/build/pdf.min.mjs` | 4.10.38 |
| `pdf.worker.min.mjs` | `pdfjs-dist/build/pdf.worker.min.mjs` | 4.10.38 |

直接提交进仓库而不是从 `node_modules` 取，是为了让构建可重复、不依赖装没装依赖。

升级方式：

```bash
npm install --no-save pdfjs-dist@4
cp node_modules/pdfjs-dist/build/pdf.min.mjs vendor/
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs vendor/
npm run build && npm test
```

`build.mjs` 会把这两个 ESM 文件末尾的 `export{...}` 改写成全局赋值再内联
（见 `esmToGlobal`）。前提是它们没有顶层 `import`——构建时会校验，不满足会直接报错。
