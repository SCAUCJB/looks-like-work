import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzip, resolvePath } from "../src/sources/epub/unzip.js";


const buf = await readFile(join(import.meta.dirname, "test.epub"));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const files = await unzip(ab);
console.log(`解包出 ${files.size} 个文件:`);
const dec = new TextDecoder();
for (const [name, bytes] of files) {
  console.log(`  ${name.padEnd(28)} ${String(bytes.length).padStart(5)} 字节`);
}

// 校验解压内容正确性
const mt = dec.decode(files.get("mimetype"));
console.log("\nmimetype (stored/未压缩):", JSON.stringify(mt));
console.assert(mt === "application/epub+zip", "mimetype 不对");

const opf = dec.decode(files.get("OEBPS/content.opf"));
console.log("OPF 含书名:", opf.includes("测试之书 · Test Book"));
console.assert(opf.includes("测试之书"), "deflate 解压后中文丢失");

const png = files.get("OEBPS/images/fig1.png");
console.log("PNG 魔数正确:", png[0] === 0x89 && dec.decode(png.subarray(1, 4)) === "PNG");

// resolvePath：章节里的 ../images/fig1.png 要能解析到 zip 内真实路径
const resolved = resolvePath("OEBPS/text/", "../images/fig1.png");
console.log("\nresolvePath('OEBPS/text/', '../images/fig1.png') =", resolved);
console.assert(resolved === "OEBPS/images/fig1.png", "相对路径解析错误");
console.assert(files.has(resolved), "解析出的路径在 zip 里找不到");

console.log("\n✓ unzip + resolvePath 全部通过");
