# looks-like-work

> 看起来像在工作。

把内容当代码读：目录变文件树，正文变注释绿，插图变 emoji（hover 出预览）。

共享一套 VS Code 外壳，数据源可插拔：

| 产物 | 格式 | 体积 |
|---|---|---|
| `dist/epub-vscode.html` | EPUB | 257 KB，零依赖 |
| `dist/reader-vscode.html` | EPUB + PDF | 1.9 MB（内联了 pdf.js） |

只读 epub 就用小的那个。两个产物都是单文件，双击即用。

| 数据源 | 状态 |
|---|---|
| EPUB | ✅ 完整支持 |
| PDF | ✅ 文本型（电子书 / 导出文档）；扫描版无文本层，不支持 |
| V2EX | ✅ 可用，但尚未接入共享层 —— 见 [`userscript/`](userscript/) |

## 快速开始

```bash
node build.mjs            # 构建，产物 dist/epub-vscode.html
node build.mjs --watch    # 改 src/ 自动重建
```

然后直接双击 `dist/epub-vscode.html`（`file://` 协议也能用，不需要起服务器），
把 `.epub` 拖进去即可。书库和阅读进度存在浏览器本地 IndexedDB，文件不会上传。

## 目录结构

```
src/
├── shell/                    ← 数据源无关，两个项目共享
│   ├── const.js              共享常量
│   ├── util.js               escapeHtml / localStorage / 确定性伪随机
│   ├── style.js              全部 CSS（Light+ / Dark+），buildCss(ctx)
│   ├── wrap.js               按显示宽度折行（中日韩 2 列 / 西文 1 列）
│   ├── agent.js              Agent 面板驱动：打字机 + 逐步推进（数据源无关）
│   ├── usage.js              额度条：仿 Claude Code 的 /usage 显示
│   ├── chunks.js             富文本 HTML -> 行块（保留换行、抽代码栅栏、图片占位）
│   ├── render.js             行块 -> 注释 -> 语法着色 -> 一行 DOM
│   └── shell.js              外壳：标题栏 / 活动栏 / 文件树 / tabs / 面板 / 命令面板
├── sources/epub/
│   ├── unzip.js              零依赖 zip 解包（原生 DecompressionStream）
│   ├── opf.js                container.xml -> OPF -> spine / manifest / TOC / buildTocIndex
│   ├── adapter.js            EPUB -> BookAdapter
│   ├── codegen.js            段落间伪装代码生成（确定性 / 变量连贯 / 类型自洽）
│   ├── chapter.js            章节内容 -> 编辑器行（吃 xhtml 或现成段落）
│   ├── store.js              IndexedDB：书库 / 进度 / 书签
│   └── source.js             createBookSource：EPUB 与 PDF 共用的数据源
├── sources/pdf/
│   ├── extract.js            文本片段 -> 行 -> 段落（版面启发式）
│   ├── load.js               pdf.js 调用 + 目录切分
│   └── adapter.js            PDF -> BookAdapter
├── epub-main.js              入口：书库页 + 拖拽 + 挂载工作区
build.mjs                     零依赖打包器 -> 自包含单文件 HTML
userscript/                   V2EX 油猴脚本（独立单文件，共享层的来源）
vendor/                       构建时内联的第三方文件（pdf.js）
```

## 外壳与数据源的契约

外壳不认识「帖子」或「章节」，只认识一个 `Source`：

```javascript
const source = {
  id: "epub",
  workspaceName: () => "书名",          // 标题栏 / 面包屑根
  tree: () => [/* TreeNode[] */],        // 侧边栏文件树（folder 可嵌套）
  openFile: async (id) => ({ id, file, crumb, rows, branch }),
  welcomeHtml: () => "...",              // 没有打开文件时的 README 页
  panelHtml: (panel) => "...",           // problems / output / terminal
  commands: () => [{ label, hint, run }],// ⌘P 命令面板
  activityView: (act) => ({ head, html }) | null,  // 自定义活动栏视图
  commandLine: { placeholder, submit },  // 面板底部输入行
  onAction: (action, data, el) => {},    // 行内动作（删书签、切风格…），见下
  onReady: (api) => {},                  // 拿到外壳 api，做恢复进度等初始化
};

createShell(source).mount();
```

`rows` 是渲染单元：`{ type: "comment" | "code" | "plain", text, fence?, images? }`。

**行内动作**：树、面板、编辑器里任何带 `data-action` 的元素被点击时，外壳会
`preventDefault` + `stopPropagation` 后转发给 `source.onAction(action, dataset, el)`。
数据源不用自己到处挂监听，也不会因为点了行内的 `×` 而误触发外层的「打开文件」。

## 概念映射

| VS Code | EPUB |
|---|---|
| 工作区 | 书名 |
| 文件夹树 | TOC 目录（嵌套） |
| 文件 | 章节（`01-chapter.md`） |
| 打开的 tab | 多个章节（最多 8 个） |
| SEARCH 侧栏 | 全书全文检索 |
| SOURCE CONTROL | 书签 |
| RUN AND DEBUG | 阅读统计（字数 / 预估时长） |
| EXTENSIONS | 字号 / 渲染风格 / 伪装代码密度 / 连续注释行上限 / 每行宽度 |
| Agent 面板（⌘I） | 逐段输出章节内容，确认后继续 |
| PROBLEMS | 书签列表 |
| OUTPUT | epub 结构诊断（OPF 路径、spine、manifest） |
| TERMINAL | 章节清单 + 笔记 |
| 状态栏 `⎇` | 作者 |
| 状态栏右侧 | 全书进度百分比 + 章内段落位置 |
| 窗口缩放 / 拖侧栏 | 自动重算每行列数并重渲染 |

## TERMINAL 命令

| 命令 | 作用 |
|---|---|
| `mark [备注]` | 收藏当前章节 |
| `unmark [序号]` | 删除书签（序号见 PROBLEMS 面板；不给序号删最近一条） |
| `usage` | 在 TERMINAL 打印阅读额度报告 |
| `agent [on\|off]` | 开关 Agent 面板 |
| `agent slow\|normal\|fast\|instant` | Agent 输出速度 |
| `font <px>` / `size <px>` | 字号，11~24px，默认 13 |
| `wrap auto` | 每行宽度自动撑满编辑器（默认） |
| `wrap <列数>` | 固定每行宽度，40~200 |
| `code off\|low\|mid\|high` | 段落间伪装代码密度，默认 mid |
| `run <行数>` / `run auto` | 连续注释行上限，默认跟随密度（mid = 6 行） |
| `note <内容>` | 记一条笔记 |
| `view md\|js\|ts\|py\|rs\|html` | 切换渲染风格 |
| `> <关键词>` | 打开命令面板 |
| 其它文本 | 按章节名模糊跳转 |

书签也可以直接点 SCM 侧栏或 PROBLEMS 面板里每行右侧的 `×` 删除；
每行宽度也可以在 EXTENSIONS 侧栏或命令面板里点选。

## 快捷键

| 键 | 作用 |
|---|---|
| `⌘/Ctrl + P` | 命令面板（跳章节 / 切风格） |
| `⌘/Ctrl + \`` | 折叠 / 展开底部面板 |
| `⌘/Ctrl + O` | 打开 EPUB 文件（随时可用） |
| `⌘/Ctrl + I` | 开关 Agent 面板（Toggle Agents） |
| `⏎` | Agent 面板开着时：继续下一段 / 跳过本段打字 |
| `⌘/Ctrl + =` / `-` | 字号加大 / 缩小一档 |
| `⌘/Ctrl + 0` | 字号复位到 13px |
| `Esc` | 关闭面板、隐藏图片预览 |

鼠标：拖侧边栏右缘调宽度，拖面板顶缘调高度（双击复位），双击面板 tabs 空白处折叠，
点状态栏的字号（如 `13px`）复位。EXTENSIONS 侧栏可以点选字号、渲染风格、伪装代码密度、每行宽度。

## 段落间的伪装代码

正文全是注释绿的话，一眼就能看出不是在写代码。所以段落之间会按密度插入伪代码
（`src/sources/epub/codegen.js`），六种渲染风格各有一套模板。

四条硬约束，缺一条伪装就露馅：

1. **确定性** — 种子取自章节路径（`hashStr(href + "#code")`），同一章每次打开插入的代码
   逐字符一致。每次重开书代码都在变，比没有代码更假。
2. **变量连贯** — 维护已声明标识符池，后面的片段引用前面声明过的变量，不重复声明同名变量。
3. **类型自洽** — 变量带粗粒度类型（array / obj / num），`.push()`、`for..of`、`.filter()`、
   `.length` 只会用在数组上。否则会写出 `const x = Object.create(null)` 紧跟 `x.push(...)` 这种破绽。
4. **声明先于引用** — 模板里必须先取 ref 再 declare，否则会生成
   `const anchor = anchor.filter(...)` 这种自引用（TDZ 错误）。

另外：纯中文书名会被 `slugIdent` 兜底成 `ch_xxx`，这种名字放进代码里很怪且从未声明，
所以会换成 `reader` 这样的普通标识符。数组变量用复数名（`tokens` / `anchors` / `fragments`）。

密度四档，每档两个参数：`chance` 是每段正文之后插入的概率，`burst` 是插入后再追加
一段的概率（连着插能形成成块的代码，零散单行比成块的假）：

| 档位 | chance | burst | maxRun |
|---|---|---|---|
| `off` | 0% | — | 不限 |
| `low` | 30% | 20% | 10 行 |
| `mid`（默认） | 55% | 40% | **6 行** |
| `high` | 80% | 60% | 4 行 |

- `chance` 每段正文之后插代码的概率
- `burst` 插入后再追加一段的概率（成块的代码比零散单行更像）
- `maxRun` **连续注释行的上限**。光按段落插不够——一个长段落折行后有二三十行，
  中间一行代码都没有，整屏纯注释一眼就假。超过上限就在段落中间切开插代码。

`run 6` 命令可以单独指定上限，`run auto` 恢复成跟随密度档位。

模板以多行块为主（函数声明、reduce、if/else、带 continue 的循环、链式调用、try/catch），
单行语句只占少数——成块的代码才像在写代码。

### 切分长段落的两个坑

**不能直接往注释块中间塞代码**。块注释（`/* … */`、`<!-- … -->`）里插进去的代码
仍然在注释内部，显示出来还是绿的。所以要把长段落切成若干**独立的完整注释块**，
块之间再插——每块自己是闭合的注释。

**连续注释行必须跨段落累计，而且要在输出前预判**。只在段内切分、或只在输出后检查，
都挡不住这两种情况：相邻几个短段落之间没插代码时会连成一片；上一段末尾剩几行、
下一段又一次性加一整块注释，两者相加照样超限。

在 EXTENSIONS 侧栏、命令面板或 `code <档位>` 命令切换。

函数参数用 `localName()` 生成：占住名字避免撞车，但**不**进声明池。
参数在函数外不可见，进池会让后面的片段引用一个不存在的变量。

## 目录的层级与排序

**顺序取自 spine，层级取自 TOC 的父子关系。** 这两件事必须分开处理。

早先的实现是「按 spine 排序 + 用 TOC 的 depth 数字 + 栈还原层级」，四种常见的
EPUB 结构都会出错（`test/fixtures/case-*.epub` 逐一钉住）：

| 结构 | 症状 |
|---|---|
| TOC 顺序 ≠ spine 顺序 | 子章挂到了中间那个兄弟章底下 |
| 跳级目录（0 → 2） | 层级被压平 |
| 单文件多章（`#anchor` 区分） | **后续章节从目录里彻底消失** |
| TOC 未覆盖的插页 | 插页自成顶层，把后面本属于上一章的子章抢走 |

根因是同一个：depth 只是个数字，一旦按 spine 顺序重排，真实的父子关系就没了。
`A` 有子章 `C`、而 spine 里 `B` 夹在中间时，depth 序列是 `[0, 0, 1]`——
栈式重建只能把 `C` 挂到最近的 `0`（也就是 `B`）上，无从知道原本该挂给谁。

所以 `buildTocIndex()` 记的是 **parent（父章节的 href）**，配套三条规则：

- **自引用要挡掉**：子条目指向同一个文件时 parent 会等于自己
- **同一文件的多个 TOC 条目**：第一个作为文件标题，其余进 `anchors` 在目录里展示，
  不然整段消失
- **TOC 未覆盖的文件**继承前一个章节的父级，当成顶层会打断层级
- 父级不在 spine 里时逐级上溯，找不到才退回顶层——别把整棵子树丢掉

另外文件名是 slug（中文书会变成 `03-ch_1xjx.md`，看不出是哪一章），
所以树节点带 `hint`：hover 显示真实标题，侧栏搜索也能按标题命中。

## PDF 支持

用 `dist/reader-vscode.html`。PDF 和 EPUB 共用同一套数据源（`createBookSource`），
差异全部收在 `BookAdapter` 里——所以文件树、折行、伪装代码、Agent 面板、额度条、
阅读进度、菜单栏全部自动复用，PDF 侧只写了「怎么拿内容」这一层。

```javascript
const adapter = {
  kind: "pdf",
  meta: { title, author },
  chapters: [{ href, title, depth }],
  contentOf: (href) => ({ paras: [...] }),   // EPUB 给 { bytes }，PDF 给 { paras }
  plainOf: (href) => "...",                  // 全书检索用
  blobUrlFor: () => "",                      // PDF 不提取图片
};
```

### 难点在段落重建

PDF 里没有「段落」，只有一堆带坐标的文本片段。`extract.js` 的还原步骤：

1. 按 y 坐标聚成行（同行片段的 y 会有抖动，要给容差）
2. 行内按 x 排序，按间距补空格；中文之间不补
3. 统计正文行距，据此判断换行是同段续行还是新段落
4. 剔除页眉页脚
5. 合并英文连字符换行

两个踩过的坑：

- **正文行距不能用中位数**。段间距、标题间距会混进来把它抬高，一抬高就什么都分不开了。
  改用 30% 分位——正文行距是出现最密集的那一档。
- **页眉页脚不能按「每页前两行 / 后两行」取候选**。章节末页、插图页只有寥寥几行，
  正文会落进候选区，跨页一比对就被当成页眉删掉，**直接丢内容**。
  改成按 y 坐标判断是否落在版面的页眉页脚带里，并跳过行数太少的页面。

另外字号变化也会触发分段（标题和正文的分界）。

### 限制

- **扫描版 PDF 不支持**：没有文本层，只有页面图像。打开时会检测（平均每页不足 20 字符即判定），
  并明确提示需要 OCR
- **双栏论文会串行**：需要分栏检测，目前没做
- 不提取 PDF 里的图片（渲染成 canvas 成本高，对「当代码读」也没意义）

### pdf.js 怎么内联的

pdf.js 只发 ESM，而产物是单文件里的普通 `<script>`：`file://` 下内联 module script
虽然能跑，但两个内联 module 之间没法 import。所以 `build.mjs` 的 `esmToGlobal()` 把它
末尾唯一那条 `export{...}` 改写成全局赋值，退回普通脚本。前提是没有顶层 `import`，
构建时会校验。worker 以源码字符串内联，运行时转成 blob URL。

## 菜单栏

标题栏的 File / Edit / View / Go / Run / Terminal / Help 是能用的真菜单，
不是装饰——点击展开，展开后划过其它菜单名直接切换，`Esc` 或点别处关闭。

| 菜单 | 内容 |
|---|---|
| **File** | **打开 EPUB…（⌘O）** / 最近打开的书 / 回到书库 / 关闭当前章节 |
| Edit | 全书搜索 / 收藏当前章节 |
| View | 命令面板 / 切换主题 / 字号增减与复位 / 切换底部面板 / 切换 Agent 面板 |
| Go | 上一章 / 下一章（首末章自动置灰）/ 跳转到章节 / 继续上次阅读 |
| Run | Agent 输出下一段 / 连续与暂停 / 停止 |
| Terminal | 查看阅读额度 / 显示 TERMINAL 面板 |
| Help | 关于本书 / 换一本书 |

添加新书不必回书库：`File → 打开 EPUB…` 或 `⌘O` 随时能选文件。
工作区里用的是一个常驻的隐藏 `input`——书库页那个会随页面清空而消失。
每次选完要把 `input.value` 清空，否则连选同一个文件不会再触发 `change`。

菜单内容由数据源通过 `source.menus()` 提供，shell 只负责渲染和交互。

**换书要先 `destroy()`**：`createShell().mount()` 返回的实例持有 document / window 上的
监听器（keydown、click、resize）。换书时只删 `.vsc-app` 的话，这些监听器会留下来和新外壳
叠加，按一次 `⌘I` 触发两次（开了又关，看起来毫无反应）。
`destroy()` 会停掉定时器、解绑全部全局监听、移除 DOM，并置一个 `destroyed` 标志——
数据源那边的异步回调（恢复进度、写库）可能在 destroy 之后才到，所有渲染入口都要先检查它。

## Agent 面板（Toggle Agents）

三个入口：标题栏右上角的 ✦ 按钮、活动栏底部的对话按钮、`⌘/Ctrl + I`。
打开后把正文伪装成 AI Agent 的逐段输出。面板左缘可拖拽调宽（260~720px）。

每一步：先出一行工具调用 `⏺ Read src/chapters/03-xxx.md L12-28`，再打字机逐字吐出
该段正文，吐完**停住等确认**——按 `⏎` 或点「继续」才进入下一段。

```
› 继续实现 03-chapter.md：逐段补完《第三章》，每段等我确认

⏺ Read  src/chapters/03-chapter.md  L1-1
│ 第三章 远行

⏺ Edit  src/chapters/03-chapter.md  L3-9
│ 他把行李放下，站在窗边看了很久……
                                    ▊
                              3 / 24 段   generating…
                          [ 跳过本段 ⏎ ]  [ 连续 ]
```

几个设计点：

- **和阅读进度双向打通**：
  推进到第 N 段时，编辑器同步滚到第 N 段并落库；
  反过来，打开面板时会按当前阅读位置**接着往下播**，而不是从头重放。
  所以在编辑器里读到一半再开面板、或者关掉面板再打开，位置都不会丢。
  还在章首（第 0 段）时从零播起，一段都不预先补。
  历史超过 6 段会折成一行 `⋯ 前 N 段已输出`——读到第 200 段时铺 200 个 DOM 块会卡。
- **内容完全一致**：直接复用编辑器已渲染好的行按 `para` 归并回段落，
  所以折行、图片 emoji 都和编辑器里一模一样，只是剥掉了注释前缀（面板里是"说话"，不该带 `#`）。
- **打字中按继续 = 先补完本段**，不会跳段。第二次按才进入下一段。
- **连续模式**：点「连续」自动往下播，再点变回暂停。
- **速度四档**：慢 28 / 正常 70 / 快 160 字符每秒 / 瞬间（不打字）。
  四个入口：面板头部的 `⚡ 正常` 按钮（点击循环切换）、EXTENSIONS 侧栏、命令面板、
  `agent fast` 命令。改速度只影响下一段，正在打字的这段不受影响。
- 面板宽度可拖（260~720px），打开会让编辑器变窄，auto 折行列数自动重算。

**布局上有个坑**：`.vsc-app` 是四列网格，四个主区域（活动栏 / 侧栏 / 编辑区 / Agent）
必须**全部显式写 `grid-column`**。CSS Grid 会先放置显式定位的项、再自动填其余项，
所以只要有任何一项显式定位（比如宽度拖拽手柄），其余自动放置的项就会被挤位——
表现是 Agent 面板左边凭空多出一块空白、拖拽手柄也对不上位置。
拖拽手柄本身用 `position: absolute`，不占网格格子。

`agent.js` 是数据源无关的：它只认一个 step 列表（`{tool, path, range, text, images, para}`），
将来 V2EX 版可以喂楼层回复。

## Usage（阅读额度）

仿 Claude Code 的 `/usage`，把阅读进度显示成额度条：

| 额度 | 对应 | 右侧真实信息 |
|---|---|---|
| Current session (5h) | **当前章节**进度 | `14/24 段` |
| Current week (7d) | **全书**进度 | `2.1万/11.0万 字` |

```
Current session (5h)              resets 21:30
████████████░░░░░░░░   58% used     14/24 段

Current week (all chapters) (7d)  resets Tue
████░░░░░░░░░░░░░░░░   19% used     2.1万/11.0万 字
```

两处显示：

- **Agent 面板底部**常驻（CSS 进度条），随滚动和 Agent 推进实时更新
- **`usage` 命令**在 TERMINAL 打字符画报告，面板关着时也能看；输入任意其它命令即退出

`resets 21:30` / `resets Tue` 是装饰（按当前时间 +5h / +7d 算），右侧给的才是真实数据。
进度条颜色：75% 以上转黄，100% 转绿——和 Claude Code 相反，这里读得多是好事。

终端报告按最长标题动态对齐，不能写死宽度——
`Current week (all chapters) (7d)` 会把 `resets` 挤得连空格都没有。

## 阅读位置记忆

自动记，不用手动操作：滚动停下 350ms 后落库，重开书从上次的段落继续。

**用段落序号当锚点，不是滚动像素、也不是行号**。因为字号、折行宽度、伪装代码密度
都会改变像素位置和行数，只有正文段落数是内容固有的：

| 锚点 | 改字号 | 改折行宽度 | 改代码密度 |
|---|---|---|---|
| 滚动像素 | ❌ | ❌ | ❌ |
| 行号 | ✅ | ❌ | ❌ |
| **正文段落序号** | ✅ | ✅ | ✅ |

带来的直接好处：**改任何显示设置都停在原处**，而不是跳回章首。
`reopenCurrent()` 会先把当前段落存进 `pendingPara`，重渲染后滚回去。

实现要点：
- 渲染时只给正文行打 `data-para`，骨架行和伪装代码行不打
- `currentPara()` 取视口标记线（顶部 15% 处）下方的第一个正文行。
  判定必须用 `>` 而不是 `>=`：标记线正好压在两行交界时，用 `>=` 会取到上一行，位置差一行
- `scrollToPara()` 在目标段落不存在时（内容变了）往前找最近的一段，而不是回顶
- 离开文档前记位置这件事，`openFile` / `activateTab` / `closeTab` 三条路径都要走，
  漏一条切 tab 回来就会丢位置
- 状态栏百分比 = 前面章节字数 + 本章字数 × 滚动比例。
  按整章算会导致打开一章进度就跳满

想手动标记特定位置用书签（`mark`），和自动进度是两套，互不干扰。

## 字号

档位 11 / 12 / 13 / 14 / 16 / 18 / 20 / 24 px，默认 13。`⌘/Ctrl` 加减号逐档调整，
`⌘/Ctrl + 0` 复位，或用 `font 18` 命令、EXTENSIONS 侧栏、点状态栏字号。

字号改动牵着三个 CSS 变量，必须一起改，否则**行号列会和代码行错位**：

| 变量 | 取值 | 用在 |
|---|---|---|
| `--vsc-code-size` | 字号 | `.vsc-editor` 的 font-size |
| `--vsc-code-line` | `round(字号 × 1.38)` | `.vsc-line` 和 `.vsc-gutter div` 的 height |
| `--vsc-gutter-w` | `max(36, round(字号 × 4.3))` | `.vsc-code` 行号列宽度 |

行高**必须取整**：小数行高会逐行累积误差，几百行之后行号就和代码错开了。
行号列宽度也要随字号缩放，否则大字号下放不下 4 位行号。

字号变了字宽也变，所以 `setFontSize` 会触发重新测量列数；auto 折行模式下会重渲染当前章节。

## 长行折行

epub 的段落动辄几百字，若一行一个行号就得反复横向滚动。所以正文在渲染前
会按**显示宽度**折行（`src/shell/wrap.js`），折出的每一行都是独立的一行、各占一个行号。

为什么不用 CSS 软换行：行号 gutter 和代码行是两列独立的 div、每行固定 18px 高，
一旦 CSS 折行，一个逻辑行占两行高度，行号就全错位了。

默认是 **auto**：按编辑器实际可用宽度算列数，尽量放满而不触发横向滚动。
`shell.measureCols()` 用一个隐藏探针实测 100 个字符的宽度取平均（不按字号估算——
字体回退、页面缩放、用户改过字号都会让估算失准），再减去行号列 56px、右侧 padding 20px
和 2px 余量。窗口缩放、侧栏拖动、自定义字体加载完成都会重量并重渲染（160ms 防抖）。

也可以 `wrap 104` 固定列数。

折行规则：
- 宽度按等宽字体的**列数**算，中日韩文字 2 列、西文 1 列（否则中文段落会比英文段落短一半）
- 优先在空白处断，不切断英文单词；超长单词 / URL 才硬切
- `⟦IMG:n⟧` 图片占位符整体保留，绝不切断（切断了就匹配不上，会漏出乱码文本）
- 注释前缀（`# ` / `// ` / ` * `）预留 4 列余量，所以实际行宽 ≤ 设定值

## 打包器说明

`build.mjs` 是自己写的极简打包器（约 200 行，零依赖）。存在的原因：
`file://` 协议下浏览器会因 CORS 拒绝 `<script type="module">`，所以必须内联成一个普通
`<script>`。做法是给每个模块包一层工厂函数注册进 mini CommonJS registry，
而不是粗暴地删掉 `import`/`export` 再拼接。

支持：`import { a, b as c }`、`import * as ns`、`export function/const/let/class`、`export { a, b }`。
不支持：`export default`、动态 `import()`、循环依赖、裸模块名（node_modules）。
碰到这些会在构建时明确报错，不会静默产出坏包。

将来若装了 esbuild，可以直接换成
`esbuild src/epub-main.js --bundle --format=iife` 再内联，本打包器可整体删除。

## 测试

```bash
npm install     # 只装测试用的 devDependencies（linkedom / fake-indexeddb）
npm test        # 跑三套测试
npm run build   # 构建产物
```

| 文件 | 覆盖 |
|---|---|
| `test/unzip.test.mjs` | zip 解包：stored / deflate、中文、二进制、`../` 相对路径 |
| `test/wrap.test.mjs` | 折行：显示宽度、中文按字断、英文按词断、超长 URL 硬切、图片占位符不切断、中英混排、空行边界 |
| `test/toc.test.mjs` | 目录层级：TOC/spine 顺序不一致、跳级、单文件多章、未覆盖插页，外加 `buildTocIndex` 的自引用 / 无链接分组 / order |
| `test/pdf-extract.test.mjs` | PDF 文本重建：片段聚行、中英空格、行距分段、缩进分段、页眉页脚剔除（含短页不误删正文）、连字符合并、跨页续行 |
| `test/pdf.test.mjs` | PDF 数据源：缺 pdf.js 时的提示、outline 目录、无 outline 按页分组、扫描版识别、接入通用数据源后各功能复用 |
| `test/menu.test.mjs` | 菜单栏：可点性、展开/hover 切换/Esc/点外部关闭、File 打开 epub 与最近书籍、七个菜单都非空、菜单项实际执行、首末章禁用态 |
| `test/usage.test.mjs` | 额度条：进度条长度恒定、越界夹取、NaN 兜底、报告对齐、HTML 宽度与色阶、XSS 转义、重置时间格式 |
| `test/agent.test.mjs` | Agent 面板：速度档位、开关与宽度、脚本生成（注释前缀剥离、段落锚点）、逐步推进、联动编辑器、打字机与跳过、连续模式、到底即停、换章重载、接续阅读进度、长历史折叠、切回缓存 tab 数据同步、额度条随进度变化、命令 |
| `test/codegen.test.mjs` | 伪装代码：密度档位、6 种风格样例、同种子可复现、不同种子有差异、变量先声明后引用、无重名、类型自洽、无 `ch_xxx`、无未替换占位符、markdown 围栏成对、连续注释行不超上限（含跨段落累计、切开处必有代码、锚点不被破坏） |
| `test/parse.test.mjs` | 正文一段不丢（六种风格 × 60 短段落）、OPF 元数据、spine 顺序、EPUB3 nav 嵌套 TOC、章节渲染、6 种风格、中英混合字数、纯中文标题 slug |
| `test/shell.test.mjs` | 阅读位置（锚点连续、定位、越界回退、落库、改设置保位置、切 tab 往返、进度推进）、CSS 注入与样式隔离、文件树、外壳挂载、打开章节、行号对齐、注释着色、图片 emoji、IndexedDB 进度与书签、三个面板、折叠、命令面板、TERMINAL 命令、全书检索、活动栏视图、折行宽度生效与越界夹取、自动宽度测量与不超宽、字号三变量联动与行号不错位（11/13/20/24px 逐一验证）、书签删除（面板 × / 侧栏 × / `unmark` / 清空）、伪装代码密度递增与确定性、书库页 |

`test/test.epub` 是一个结构完整的最小 EPUB3（嵌套 TOC、中文、HTML 实体、
代码块、`../` 相对路径插图），由 `zipfile` 构造。
`test/test.pdf` 是手写的最小 PDF（3 页、带 outline 目录、含跨页段落和连字符换行），
留作在真浏览器里手动验证用——Node 里不跑真的 pdf.js（它的 web 构建带了大量
浏览器专用代码，在 linkedom 下起不来），PDF 测试用 mock 顶掉 pdf.js 接口，
只测我们自己那层。

Node 没有 `DOMParser` 和 `indexedDB`，测试用 linkedom + fake-indexeddb 补齐。
**注意** linkedom 的 `DOMParser` 不做 HTML 隐式 `<html><body>` 补全，
测试里包了一层 `BrowserLikeDOMParser` 还原浏览器语义 —— 不包的话测的就不是生产行为。
这两个依赖只在测试里用，不进构建产物（产物零依赖）。

## 已知限制

- `unzip.js` 只支持 stored(0) 与 deflate(8)，不支持加密（DRM）epub
- 章节内锚点（`#anchor`）目前只用于 TOC 定位，点击不会滚到具体位置
- 阅读位置精确到正文段落，但一个超长段落内部的位置不再细分
- 单文件多章的书，目录里的锚点条目点击后打开整个文件，不会滚到对应锚点
- 全书检索是惰性全量解析，很厚的书第一次搜索会卡一下（之后有缓存）

## 许可

本项目以 **MIT** 发布，见 [`LICENSE`](LICENSE)。

第三方组件见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。需要留意的只有一条：

**`dist/reader-vscode.html` 把 pdf.js 整个内联了进去**，所以分发这个文件
就等同于分发 pdf.js，其 Apache-2.0 条款随之生效。产物头部由 `licenseBanner()`
写入了许可声明注释 —— 如果以后给产物加压缩/混淆步骤，**别把这段注释去掉**。

`dist/epub-vscode.html` 不含 pdf.js，只受 MIT 约束。

### 测试固件的来源

`test/` 下的 epub 与 pdf 全部是为测试手工构造的，不含任何真实出版物：

| 文件 | 构造方式 |
|---|---|
| `test.epub` | `zipfile` 生成的最小 EPUB3，元数据是「测试之书 · Test Book」 |
| `test.pdf` | 手写的 `%PDF-1.4`，3 页 Helvetica，不嵌字体 |
| `fixtures/case-a~d.epub` | 为复现四种目录乱序结构构造，见「目录的层级与排序」 |
