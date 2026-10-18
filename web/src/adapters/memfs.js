// 記憶體資料夾（測試用）：模擬共用槽上的資料夾。store 為共用之伺服器端內容；
// client() 為某台電腦的存取視角，可模擬斷線、唯讀權限、注入寫入失敗。
import { SpecError } from '../core/errors.js';
import { assertPath, assertDir } from '../core/paths.js';
import { utf8 } from '../core/util.js';

export class MemStore {
  constructor({ serverNow } = {}) {
    this.files = new Map(); // path -> {bytes:Uint8Array, mtime}
    this.serverNow = serverNow || (() => Date.now());
  }

  client(opts = {}) {
    return new MemClient(this, opts);
  }

  // 測試輔助：直接改寫（模擬外部編輯器）
  rawSet(path, text) {
    this.files.set(path, { bytes: utf8(text), mtime: this.serverNow() });
  }

  rawGet(path) {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.bytes) : null;
  }

  names(prefix) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

function netError() {
  const e = new Error('網路連線中斷');
  e.name = 'NetworkError';
  return e;
}

function denied() {
  const e = new Error('沒有寫入權限');
  e.name = 'NotAllowedError';
  return e;
}

class MemClient {
  // opts: {offline:()=>bool, readonly:bool, failWrite:(path,op)=>Error|null}
  constructor(store, opts) {
    this.store = store;
    this.opts = opts;
    this.name = opts.name || 'mem';
  }

  _net() {
    if (this.opts.offline && this.opts.offline()) throw netError();
  }

  _canWrite(path, op) {
    this._net();
    if (this.opts.readonly) throw denied();
    const f = this.opts.failWrite && this.opts.failWrite(path, op);
    if (f) throw f;
  }

  async read(path) {
    assertPath(path);
    this._net();
    const f = this.store.files.get(path);
    if (!f) return null;
    return { text: new TextDecoder().decode(f.bytes), lastModified: f.mtime, size: f.bytes.length };
  }

  async readBytes(path) {
    assertPath(path);
    this._net();
    const f = this.store.files.get(path);
    if (!f) return null;
    return { bytes: f.bytes.slice(), lastModified: f.mtime, size: f.bytes.length };
  }

  async write(path, data) {
    assertPath(path);
    this._canWrite(path, 'write');
    const bytes = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
    this.store.files.set(path, { bytes, mtime: this.store.serverNow() });
  }

  async create(path, data) {
    assertPath(path);
    this._net();
    if (this.store.files.has(path)) throw new SpecError('EXISTS', `檔案已存在，不覆寫：${path}`);
    this._canWrite(path, 'create');
    const bytes = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
    this.store.files.set(path, { bytes, mtime: this.store.serverNow() });
  }

  async remove(path) {
    assertPath(path);
    this._canWrite(path, 'remove');
    this.store.files.delete(path);
  }

  async list(dir) {
    assertDir(dir);
    this._net();
    const prefix = dir ? dir + '/' : '';
    const seen = new Map();
    for (const k of this.store.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const i = rest.indexOf('/');
      if (i < 0) seen.set(rest, 'file');
      else if (!seen.has(rest.slice(0, i))) seen.set(rest.slice(0, i), 'directory');
    }
    return [...seen.entries()].map(([name, kind]) => ({ name, kind }));
  }
}

export class MemDraftStore {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? JSON.parse(this.map.get(k)) : null; }
  async put(k, v) { this.map.set(k, JSON.stringify(v)); }
  async delete(k) { this.map.delete(k); }
}

// 模擬 navigator.locks（同一瀏覽器之分頁共用一個 MemLocks）
export class MemLocks {
  constructor() { this.held = new Set(); }
  async tryHold(name) {
    if (this.held.has(name)) return null;
    this.held.add(name);
    return () => this.held.delete(name);
  }
}

export class MemLocalSessions {
  constructor() { this.ids = new Set(); }
  has(id) { return this.ids.has(id); }
  add(id) { this.ids.add(id); }
}
