/**
 * 极简 zip 解包（epub 就是 zip），零第三方依赖。
 * 用原生 DecompressionStream("deflate-raw") 解 deflate，只支持 epub 实际会用到的
 * 两种存储方式：stored(0) 与 deflate(8)。
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Map<string, Uint8Array>>} 路径 -> 解压后的字节
 */
export async function unzip(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const size = buffer.byteLength;

  // 从尾部回扫 EOCD（注释区最大 64KB）
  let eocd = -1;
  const floor = Math.max(0, size - 65557);
  for (let i = size - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法的 zip / epub 文件（未找到 EOCD）");

  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  // zip64：条目数或偏移为 0xffffffff 时要读 zip64 EOCD
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && dv.getUint32(locator, true) === EOCD64_LOCATOR_SIG) {
      const z64 = Number(dv.getBigUint64(locator + 8, true));
      if (dv.getUint32(z64, true) === EOCD64_SIG) {
        count = Number(dv.getBigUint64(z64 + 32, true));
        cdOffset = Number(dv.getBigUint64(z64 + 48, true));
      }
    }
  }

  const decoder = new TextDecoder("utf-8");
  const files = new Map();
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // central file header 签名
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // 目录项

    // local header 固定 30 字节 + 文件名 + extra，之后才是数据
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(dataOff, dataOff + compSize);

    if (method === 0) {
      files.set(name, raw);
    } else if (method === 8) {
      files.set(name, await inflateRaw(raw));
    } else {
      console.warn(`[epub] 跳过不支持的压缩方式 ${method}: ${name}`);
    }
  }
  return files;
}

/** @param {Uint8Array} raw */
async function inflateRaw(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zip 内相对路径归一化：处理 ../ 与 ./ */
export function resolvePath(base, href) {
  const clean = String(href || "").split("#")[0].split("?")[0];
  if (!clean) return "";
  if (clean.startsWith("/")) return clean.slice(1);
  const parts = (base + clean).split("/");
  const out = [];
  for (const seg of parts) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}
