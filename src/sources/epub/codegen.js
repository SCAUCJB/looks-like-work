/**
 * 段落之间的伪装代码生成器。
 *
 * 目标是「扫一眼像真在写代码」，所以有四条硬约束：
 *
 * 1. 确定性：种子来自章节路径，同一章每次打开插入的代码完全一样。
 *    否则每次重开书代码都在变，比没有代码更假。
 * 2. 连贯性：维护已声明标识符池，后面的片段引用前面声明过的变量，
 *    且不重复声明同名变量。凭空出现的变量一眼就假。
 * 3. 类型自洽：变量带粗粒度类型（array / obj / num），
 *    `.push()`、`for..of`、`.filter()` 只会用在数组上。
 *    否则会写出 `const x = Object.create(null)` 后面紧跟 `x.push(...)` 这种破绽。
 * 4. 声明先于引用：模板里必须先取 ref 再 declare，
 *    否则会生成 `const anchor = anchor.filter(...)` 这种自引用（TDZ 错误）。
 */

/**
 * 插入密度。
 * chance = 每段正文之后插入代码的概率
 * burst  = 插入时再追加一段的概率（连着插能形成成块的代码，比零散单行更像）
 * maxRun = 连续注释行的上限，超过就在段落中间切开插代码
 */
export const DENSITIES = [
  { id: "off", label: "关闭", chance: 0, burst: 0, maxRun: Infinity },
  { id: "low", label: "稀疏", chance: 0.3, burst: 0.2, maxRun: 10 },
  { id: "mid", label: "适中", chance: 0.55, burst: 0.4, maxRun: 6 },
  { id: "high", label: "密集", chance: 0.8, burst: 0.6, maxRun: 4 },
];

/** 连续注释行的默认上限：一整屏纯注释一眼就假 */
export const DEFAULT_MAX_RUN = 6;
export const MAX_RUN_MIN = 2;
export const MAX_RUN_MAX = 40;

export const DEFAULT_DENSITY = "mid";

export function densityOf(id) {
  return DENSITIES.find((d) => d.id === id) || DENSITIES.find((d) => d.id === DEFAULT_DENSITY);
}

/* --------------------------- 词库 --------------------------- */

const NOUNS = [
  "reader", "cursor", "page", "buffer", "offset", "tokens", "lines", "cache",
  "index", "chunk", "spine", "anchor", "marker", "session", "outline", "excerpt",
  "paragraph", "glyph", "column", "viewport", "snapshot", "fragment",
];

const VERBS = [
  "load", "parse", "resolve", "collect", "flush", "hydrate", "render", "measure",
  "normalize", "prefetch", "commit", "restore", "advance", "rewind",
];

const PROPS = ["id", "href", "depth", "words", "offset", "title", "kind", "level", "at"];

const STRINGS = [
  "chapter", "toc", "spine", "manifest", "bookmark", "progress", "viewport",
  "nav", "metadata", "fragment",
];

const TODOS = [
  "handle nested toc depth > 3",
  "cache measured line heights",
  "restore scroll offset on resize",
  "dedupe anchors across chapters",
  "lazy-load images below the fold",
  "debounce progress writes",
  "keep selection across re-render",
];

const ARRAY_NOUNS = ["tokens", "lines", "chunks", "anchors", "spine", "columns", "fragments", "pages"];

/* --------------------------- 生成器 --------------------------- */

/**
 * @param {Object} args
 * @param {{id: string}} args.style        渲染风格
 * @param {() => number} args.rand         确定性伪随机（章节级种子）
 * @param {string} args.bookIdent          书名派生的标识符
 * @param {string} args.chapterIdent       章节名派生的标识符
 */
export function createCodeGen({ style, rand, bookIdent, chapterIdent }) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];
  const num = (max = 40) => 1 + Math.floor(rand() * max);

  // 纯中文书名会被 slugIdent 兜底成 ch_xxx，那种名字放进代码里很怪，
  // 而且它从未被声明过。统一换成一个像模块名的普通标识符。
  const rootIdent = /^ch_/.test(bookIdent) || !bookIdent ? "reader" : bookIdent;

  /** @type {{name: string, kind: "array" | "obj" | "num"}[]} */
  const declared = [];
  const used = new Set([rootIdent, bookIdent, chapterIdent]);

  /** 取一个没用过的新标识符；数组变量用复数名，读起来更自然 */
  function freshName(kind) {
    for (let i = 0; i < 24; i++) {
      const base = kind === "array"
        ? (rand() < 0.5 ? pick(ARRAY_NOUNS) : `${pick(VERBS)}${cap(pick(ARRAY_NOUNS))}`)
        : (rand() < 0.45 ? pick(NOUNS) : `${pick(VERBS)}${cap(pick(NOUNS))}`);
      if (!used.has(base)) {
        used.add(base);
        return base;
      }
    }
    const fallback = `${pick(NOUNS)}${num(99)}`;
    used.add(fallback);
    return fallback;
  }

  /**
   * 取一个局部名字（函数参数等），占住名字避免撞车，但**不**进声明池。
   * 函数参数在函数外不可见，进池会导致后面的片段引用一个未定义变量。
   */
  function localName(kind) {
    return freshName(kind);
  }

  /** 声明一个新变量，返回名字 */
  function declare(kind) {
    const name = freshName(kind);
    declared.push({ name, kind });
    return name;
  }

  /**
   * 引用一个已声明的、指定类型的变量。
   * 池里没有就先声明一个——但调用方必须在 declare 目标变量之前调用本函数，
   * 否则可能引用到自己。
   */
  function ref(kind) {
    const pool = declared.filter((d) => d.kind === kind);
    if (!pool.length) return declare(kind);
    return pool[Math.floor(rand() * pool.length) % pool.length].name;
  }

  const refArr = () => ref("array");
  const refObj = () => ref("obj");
  const anyRef = () => (declared.length
    ? declared[Math.floor(rand() * declared.length) % declared.length].name
    : declare("obj"));

  /* ---------------- 各语言的片段模板 ---------------- */

  /** JS / TS 共用。ind = 语句缩进，cont = 续行/块体缩进 */
  function jsSnippet(ts, ind, cont) {
    const roll = rand();

    if (roll < 0.06) {
      const v = declare("num");
      return [`${ind}const ${v}${ts ? ": number" : ""} = ${num(200)}`];
    }
    if (roll < 0.13) {
      const v = declare("array");
      return [`${ind}const ${v}${ts ? ": string[]" : ""} = []`];
    }
    if (roll < 0.2) {
      const src = refObj();
      const v = declare("num");
      return [`${ind}const ${v}${ts ? ": number" : ""} = ${src}.${pick(PROPS)} ?? ${num(12)}`];
    }
    if (roll < 0.28) {
      // 函数声明：最像"在写代码"的一种。
      // 参数是局部的，用 localName 而不是 declare，否则后面会引用到一个函数外不存在的名字。
      const src = refArr();
      const arg = localName("obj");
      const p = pick(PROPS);
      return [
        `${ind}function ${pick(VERBS)}${cap(pick(NOUNS))}(${arg}${ts ? ": Node" : ""})${ts ? ": number" : ""} {`,
        `${cont}const total = ${src}.reduce((sum, x) => sum + x.${p}, 0)`,
        `${cont}return total > 0 ? total : ${arg}.${p}`,
        `${ind}}`,
      ];
    }
    if (roll < 0.36) {
      const src = refArr();
      const v = declare("obj");
      return [
        `${ind}const ${v} = ${src}.reduce((acc, item) => {`,
        `${cont}acc[item.${pick(PROPS)}] = item.${pick(PROPS)}`,
        `${cont}return acc`,
        `${ind}}, Object.create(null))`,
      ];
    }
    if (roll < 0.46) {
      const src = refArr();
      const v = declare("array");
      return [
        `${ind}const ${v}${ts ? ": string[]" : ""} = ${src}`,
        `${cont}.filter((x) => x.${pick(PROPS)} != null)`,
        `${cont}.map((x) => x.${pick(PROPS)})`,
      ];
    }
    if (roll < 0.53) {
      const v = refObj();
      return [
        `${ind}if (${v}.${pick(PROPS)} > ${num(30)}) {`,
        `${cont}${pick(VERBS)}(${v})`,
        `${ind}} else if (!${v}.${pick(PROPS)}) {`,
        `${cont}return`,
        `${ind}}`,
      ];
    }
    if (roll < 0.63) {
      const arr = refArr();
      return [
        `${ind}for (const item of ${arr}) {`,
        `${cont}if (!item.${pick(PROPS)}) continue`,
        `${cont}${pick(VERBS)}(item.${pick(PROPS)})`,
        `${ind}}`,
      ];
    }
    if (roll < 0.68) {
      const v = declare("obj");
      return [`${ind}const ${v} = await ${pick(VERBS)}${cap(pick(NOUNS))}("${pick(STRINGS)}")`];
    }
    if (roll < 0.76) {
      return [`${ind}${refArr()}.push({ ${pick(PROPS)}: "${pick(STRINGS)}" })`];
    }
    if (roll < 0.82) {
      const v = declare("obj");
      return ts
        ? [`${ind}const ${v}: Record<string, number> = Object.create(null)`]
        : [`${ind}const ${v} = Object.create(null)`];
    }
    if (roll < 0.88) {
      return [
        `${ind}try {`,
        `${cont}${pick(VERBS)}(${anyRef()})`,
        `${ind}} catch {`,
        `${cont}/* ignore */`,
        `${ind}}`,
      ];
    }
    if (roll < 0.93) {
      const src = refArr();
      const v = declare("num");
      return [`${ind}const ${v}${ts ? ": number" : ""} = ${src}.length`];
    }
    if (roll < 0.97) {
      return [`${ind}// TODO: ${pick(TODOS)}`];
    }
    return [`${ind}console.debug("${pick(STRINGS)}", ${anyRef()})`];
  }

  function pySnippet(ind, cont) {
    const roll = rand();

    if (roll < 0.12) {
      const v = declare("num");
      return [`${ind}${v} = ${num(200)}`];
    }
    if (roll < 0.22) {
      const v = declare("array");
      return [`${ind}${v} = []`];
    }
    if (roll < 0.34) {
      const src = refObj();
      const v = declare("num");
      return [`${ind}${v} = ${src}.get("${pick(PROPS)}", ${num(12)})`];
    }
    if (roll < 0.46) {
      const src = refArr();
      const v = declare("array");
      return [`${ind}${v} = [x["${pick(PROPS)}"] for x in ${src} if x]`];
    }
    if (roll < 0.5) {
      const src = refArr();
      const arg = localName("obj");
      return [
        `${ind}def ${pick(VERBS)}_${pick(NOUNS)}(${arg}):`,
        `${cont}total = sum(x["${pick(PROPS)}"] for x in ${src})`,
        `${cont}return total or ${arg}.get("${pick(PROPS)}", 0)`,
      ];
    }
    if (roll < 0.6) {
      const arr = refArr();
      return [
        `${ind}for item in ${arr}:`,
        `${cont}if not item.get("${pick(PROPS)}"):`,
        `${cont}    continue`,
        `${cont}${pick(VERBS)}(item)`,
      ];
    }
    if (roll < 0.68) {
      const v = refArr();
      return [
        `${ind}if len(${v}) > ${num(30)}:`,
        `${cont}${pick(VERBS)}(${v})`,
      ];
    }
    if (roll < 0.78) {
      const v = declare("obj");
      return [`${ind}${v} = await ${pick(VERBS)}_${pick(NOUNS)}("${pick(STRINGS)}")`];
    }
    if (roll < 0.86) {
      return [`${ind}${refArr()}.append({"${pick(PROPS)}": "${pick(STRINGS)}"})`];
    }
    if (roll < 0.92) {
      return [
        `${ind}try:`,
        `${cont}${pick(VERBS)}(${anyRef()})`,
        `${ind}except (KeyError, ValueError):`,
        `${cont}pass`,
      ];
    }
    if (roll < 0.96) {
      return [`${ind}# TODO: ${pick(TODOS)}`];
    }
    return [`${ind}logger.debug("${pick(STRINGS)}=%s", ${anyRef()})`];
  }

  function rsSnippet(ind, cont) {
    const roll = rand();

    if (roll < 0.12) {
      const v = declare("num");
      return [`${ind}let ${v}: usize = ${num(200)};`];
    }
    if (roll < 0.22) {
      const v = declare("array");
      return [`${ind}let mut ${v}: Vec<${cap(pick(NOUNS))}> = Vec::new();`];
    }
    if (roll < 0.34) {
      const src = refObj();
      const v = declare("num");
      return [`${ind}let ${v} = ${src}.${pick(PROPS)}.unwrap_or(${num(12)});`];
    }
    if (roll < 0.46) {
      const src = refArr();
      const v = declare("array");
      return [
        `${ind}let ${v}: Vec<_> = ${src}`,
        `${cont}.iter()`,
        `${cont}.filter(|x| x.${pick(PROPS)} > 0)`,
        `${cont}.collect();`,
      ];
    }
    if (roll < 0.52) {
      const src = refArr();
      const v = declare("num");
      return [
        `${ind}let ${v} = ${src}`,
        `${cont}.iter()`,
        `${cont}.map(|x| x.${pick(PROPS)})`,
        `${cont}.sum::<usize>();`,
      ];
    }
    if (roll < 0.62) {
      const arr = refArr();
      return [
        `${ind}for item in &${arr} {`,
        `${cont}if item.${pick(PROPS)} == 0 {`,
        `${cont}    continue;`,
        `${cont}}`,
        `${cont}${pick(VERBS)}(item);`,
        `${ind}}`,
      ];
    }
    if (roll < 0.7) {
      const v = refArr();
      return [
        `${ind}if ${v}.len() > ${num(30)} {`,
        `${cont}${pick(VERBS)}(&${v});`,
        `${ind}}`,
      ];
    }
    if (roll < 0.8) {
      const v = declare("obj");
      return [`${ind}let ${v} = ${pick(VERBS)}_${pick(NOUNS)}("${pick(STRINGS)}")?;`];
    }
    if (roll < 0.87) {
      return [`${ind}${refArr()}.push(${cap(pick(NOUNS))}::new("${pick(STRINGS)}"));`];
    }
    if (roll < 0.93) {
      return [
        `${ind}match ${refObj()}.${pick(PROPS)} {`,
        `${cont}0 => return,`,
        `${cont}_ => {}`,
        `${ind}}`,
      ];
    }
    if (roll < 0.97) {
      return [`${ind}// TODO: ${pick(TODOS)}`];
    }
    return [`${ind}debug!("${pick(STRINGS)} = {:?}", ${anyRef()});`];
  }

  function htmlSnippet(ind, cont) {
    const roll = rand();
    const cls = `${pick(NOUNS)}-${pick(STRINGS)}`;
    if (roll < 0.3) {
      return [`${ind}<span class="${cls}" data-${pick(PROPS)}="${num(99)}"></span>`];
    }
    if (roll < 0.55) {
      return [
        `${ind}<section class="${cls}">`,
        `${cont}<p data-${pick(PROPS)}="${num(99)}"></p>`,
        `${ind}</section>`,
      ];
    }
    if (roll < 0.72) {
      return [`${ind}<hr class="${cls}" />`];
    }
    if (roll < 0.88) {
      return [
        `${ind}<figure class="${cls}">`,
        `${cont}<figcaption>${pick(STRINGS)}</figcaption>`,
        `${ind}</figure>`,
      ];
    }
    return [`${ind}<!-- TODO: ${pick(TODOS)} -->`];
  }

  /** markdown 视图：插围栏代码块最自然 */
  function mdSnippet() {
    const roll = rand();
    if (roll < 0.35) {
      const v = declare("obj");
      return {
        fence: true,
        lang: "js",
        lines: [
          `const ${v} = ${pick(VERBS)}${cap(pick(NOUNS))}("${pick(STRINGS)}")`,
          `console.log(${v}.${pick(PROPS)})`,
        ],
      };
    }
    if (roll < 0.6) {
      const v = declare("obj");
      return {
        fence: true,
        lang: "bash",
        lines: [`$ ${pick(VERBS)} --${pick(STRINGS)}=${num(99)} > ${v}.log`],
      };
    }
    if (roll < 0.78) {
      return {
        fence: true,
        lang: "json",
        lines: [`{ "${pick(PROPS)}": ${num(99)}, "${pick(PROPS)}": "${pick(STRINGS)}" }`],
      };
    }
    if (roll < 0.9) {
      return { plain: [`> ${pick(STRINGS)}: ${pick(TODOS)}`] };
    }
    return { plain: [`- [ ] ${pick(TODOS)}`] };
  }

  /**
   * 产出一个片段。
   * @returns {{rows: {type: string, text: string, fence?: boolean}[]}}
   */
  function snippet() {
    if (style.id === "markdown") {
      const out = mdSnippet();
      if (out.fence) {
        return {
          rows: [
            { type: "code", text: "```" + out.lang, fence: true },
            ...out.lines.map((l) => ({ type: "code", text: l, fence: true })),
            { type: "code", text: "```", fence: true },
          ],
        };
      }
      return { rows: out.plain.map((l) => ({ type: "code", text: l })) };
    }

    // 缩进全部在这里定好，调用方原样使用：
    // python / rust 的函数体是 4 空格，js/ts/html 是 2 空格，续行再多一级。
    const wide = style.id === "python" || style.id === "rust";
    const ind = wide ? "    " : "  ";
    const cont = ind + (wide ? "    " : "  ");

    const lines =
      style.id === "python" ? pySnippet(ind, cont)
      : style.id === "rust" ? rsSnippet(ind, cont)
      : style.id === "html" ? htmlSnippet(ind, cont)
      : jsSnippet(style.id === "typescript", ind, cont);

    return { rows: lines.map((l) => ({ type: "code", text: l })) };
  }

  return {
    snippet,
    /** 已声明的变量名（测试与调试用） */
    get declared() {
      return declared.map((d) => d.name);
    },
    /** 带类型的声明表 */
    get declaredTyped() {
      return declared.slice();
    },
  };
}

function cap(s) {
  return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
}
