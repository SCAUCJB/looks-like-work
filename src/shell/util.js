// 通用工具：HTML 转义、localStorage 包装、确定性伪随机

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function lsDel(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function mulberry32(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function () {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
