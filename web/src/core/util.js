// 共用小工具：時間格式、雜湊、穩定序列化。不碰DOM。

export function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

export function isoUtc(ms) {
  return new Date(ms).toISOString();
}

// 20261018T024501Z（版本檔名用，UTC）
export function compactUtc(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}

// Asia/Taipei 固定 UTC+8（台灣無日光節約時間）
function taipei(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(), mo: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()), mi: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()),
  };
}

export function taipeiDisplay(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  const t = taipei(ms);
  return `${t.y}-${t.mo}-${t.d} ${t.h}:${t.mi}:${t.s}`;
}

export function taipeiHM(ms) {
  const t = taipei(ms);
  return `${t.h}:${t.mi}`;
}

// 20261018-124805（匯出檔名用，第11.5節）
export function taipeiCompact(ms) {
  const t = taipei(ms);
  return `${t.y}${t.mo}${t.d}-${t.h}${t.mi}${t.s}`;
}

export function parseIso(s) {
  const v = Date.parse(s);
  return Number.isNaN(v) ? null : v;
}

export function hex(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

export function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function utf8(text) {
  return new TextEncoder().encode(text);
}

export async function sha256Bytes(bytes) {
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Text(text) {
  return sha256Bytes(utf8(text));
}

export function newId() {
  return globalThis.crypto.randomUUID();
}

export function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  globalThis.crypto.getRandomValues(b);
  return hex(b);
}

// 鍵排序之JSON，供雜湊鏈計算
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export function revLabel(rev) {
  return 'r' + pad(rev, 6);
}
