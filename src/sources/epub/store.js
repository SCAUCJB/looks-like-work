/**
 * IndexedDB 书库：epub 原始文件（几 MB ~ 几十 MB，localStorage 存不下）、
 * 阅读进度、书签。零依赖的 promise 包装。
 */

const DB_NAME = "epub-vscode";
const DB_VERSION = 1;
const STORE_BOOKS = "books";     // { id, title, author, size, addedAt, blob }
const STORE_STATE = "state";     // { id, chapterHref, para, updatedAt, bookmarks[] }

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/**
 * 打开数据库。
 *
 * 三件事必须做对，否则存储不可用时会连累整个页面：
 * 1. indexedDB.open() 在隐私模式 / 存储被禁时会**同步抛出**，得转成 rejection；
 * 2. 失败的 promise 不能永久缓存，否则后续每次调用都拿到同一个死掉的 promise；
 * 3. 立刻挂一个 catch，免得它在调用方 await 之前就被判定为 unhandled rejection
 *    （那会直接打断页面脚本）。
 */
function openDb() {
  if (dbPromise) return dbPromise;

  const p = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
    req.onblocked = () => reject(new Error("IndexedDB 被其它标签页占用"));
  });

  // 失败就清掉缓存，下次还能重试；这个 catch 同时让 p 不会变成 unhandled rejection
  p.catch(() => { dbPromise = null; });
  dbPromise = p;
  return p;
}

/**
 * @param {"readonly" | "readwrite"} mode
 * @param {(store: IDBObjectStore) => IDBRequest | void} fn
 *
 * 取值必须走 request.onsuccess 拿 request.result。
 * 不能在 transaction.oncomplete 里用 `req.result !== undefined ? req.result : req`
 * 兜底——记录不存在时 result 本来就是 undefined，那样会把 IDBRequest 对象
 * 本身当成数据返回，调用方 `row || 默认值` 判断失效，再存回去就 DataCloneError。
 */
async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let value;
    let req;
    try {
      req = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    if (req && typeof req === "object" && "onsuccess" in req) {
      req.onsuccess = () => { value = req.result; };
      req.onerror = () => reject(req.error);
    }
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("事务被中止"));
  });
}

/** 书的唯一 id：书名 + 大小，避免同一本书重复入库 */
export function bookId(title, size) {
  const safe = String(title || "untitled").replace(/\s+/g, "-").slice(0, 60);
  return `${safe}@${size}`;
}

/**
 * @param {{id: string, title: string, author: string, size: number, blob: Blob}} book
 */
export async function putBook(book) {
  return tx(STORE_BOOKS, "readwrite", (s) => s.put({ ...book, addedAt: Date.now() }));
}

export async function listBooks() {
  const rows = await tx(STORE_BOOKS, "readonly", (s) => s.getAll());
  return (rows || [])
    .map(({ blob, ...meta }) => meta)  // 列表不带 blob，避免一次性读出几十 MB
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export async function getBookBlob(id) {
  const row = await tx(STORE_BOOKS, "readonly", (s) => s.get(id));
  return row?.blob || null;
}

export async function deleteBook(id) {
  await tx(STORE_BOOKS, "readwrite", (s) => s.delete(id));
  await tx(STORE_STATE, "readwrite", (s) => s.delete(id));
}

/**
 * 阅读状态。para 是正文段落序号——它不随字号 / 折行宽度 / 伪装代码密度变化，
 * 比滚动像素或行号都稳，所以拿它当阅读位置的锚点。
 * @returns {Promise<{id: string, chapterHref: string, para: number, bookmarks: any[]}>}
 */
export async function getState(id) {
  const row = await tx(STORE_STATE, "readonly", (s) => s.get(id));
  return row || { id, chapterHref: "", para: 0, bookmarks: [] };
}

export async function saveState(id, patch) {
  const cur = await getState(id);
  const next = { ...cur, ...patch, id, updatedAt: Date.now() };
  await tx(STORE_STATE, "readwrite", (s) => s.put(next));
  return next;
}

export async function addBookmark(id, mark) {
  const cur = await getState(id);
  const bookmarks = [...(cur.bookmarks || []), { ...mark, at: Date.now() }].slice(-200);
  return saveState(id, { bookmarks });
}

export async function removeBookmark(id, at) {
  const cur = await getState(id);
  return saveState(id, { bookmarks: (cur.bookmarks || []).filter((b) => b.at !== at) });
}
