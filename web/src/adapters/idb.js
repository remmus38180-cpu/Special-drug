// IndexedDB 鍵值存放：只作資料夾授權記憶與當機復原草稿，不作正式資料。
const DB_NAME = 'specdrug_v04';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其他分頁阻擋'));
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error || new Error('交易中止')); };
  }));
}

export const idbStore = {
  get: (k) => tx('readonly', (s) => s.get(k)).then((v) => (v === undefined ? null : v)),
  put: (k, v) => tx('readwrite', (s) => s.put(v, k)),
  delete: (k) => tx('readwrite', (s) => s.delete(k)),
};

export function browserLocks(nav) {
  if (!nav.locks || typeof nav.locks.request !== 'function') return null;
  return {
    tryHold(name) {
      return new Promise((resolve, reject) => {
        nav.locks.request(name, { ifAvailable: true }, (lock) => {
          if (!lock) { resolve(null); return null; }
          return new Promise((release) => { resolve(() => release()); });
        }).catch(reject);
      });
    },
  };
}

// 本瀏覽器曾持牌之工作階段id（localStorage，保留最近20筆）；只用於判定同瀏覽器已關閉分頁
const LOCAL_SESSIONS_KEY = 'specdrug.localSessions';
export const localSessions = {
  _list() {
    try { return JSON.parse(window.localStorage.getItem(LOCAL_SESSIONS_KEY) || '[]'); } catch (e) { return []; }
  },
  has(id) { return this._list().includes(id); },
  add(id) {
    const l = this._list().filter((x) => x !== id);
    l.push(id);
    try { window.localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(l.slice(-20))); } catch (e) { /* 忽略 */ }
  },
};
