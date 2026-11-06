// ZIP 讀寫（xlsx、備份用）。讀：支援 stored／deflate，驗 CRC32；寫：stored（不壓縮），一律 UTF-8 檔名。
import { SpecError } from './errors.js';
import { inflateRawChunks } from './inflate.js';
import { utf8 } from './util.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32(bytes) {
  return crc32Update(0, bytes);
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function bad(msg) {
  return new SpecError('ZIP', 'ZIP檔格式錯誤：' + msg);
}

// 回傳 [{name, method, crc, compSize, size, offset}]
export function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('找不到目錄結尾（檔案可能不是xlsx／zip或已損毀）');
  let count = u16(bytes, eocd + 10);
  let cdOff = u32(bytes, eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(bytes, loc) !== 0x07064b50) throw bad('ZIP64目錄定位錯誤');
    const z64 = Number(u32(bytes, loc + 8)) + Number(u32(bytes, loc + 12)) * 2 ** 32;
    if (u32(bytes, z64) !== 0x06064b50) throw bad('ZIP64目錄結尾錯誤');
    count = Number(u32(bytes, z64 + 32)) + Number(u32(bytes, z64 + 36)) * 2 ** 32;
    cdOff = Number(u32(bytes, z64 + 48)) + Number(u32(bytes, z64 + 52)) * 2 ** 32;
  }
  const out = [];
  const dec = new TextDecoder('utf-8');
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) throw bad('中央目錄項目錯誤');
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    let compSize = u32(bytes, p + 20);
    let size = u32(bytes, p + 24);
    const nl = u16(bytes, p + 28); const el = u16(bytes, p + 30); const cl = u16(bytes, p + 32);
    let offset = u32(bytes, p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
    // ZIP64 延伸欄位
    let e = p + 46 + nl;
    const eEnd = e + el;
    while (e + 4 <= eEnd) {
      const id = u16(bytes, e); const len = u16(bytes, e + 2);
      if (id === 1) {
        let q = e + 4;
        const rd = () => { const v = Number(u32(bytes, q)) + Number(u32(bytes, q + 4)) * 2 ** 32; q += 8; return v; };
        if (size === 0xffffffff) size = rd();
        if (compSize === 0xffffffff) compSize = rd();
        if (offset === 0xffffffff) offset = rd();
      }
      e += 4 + len;
    }
    out.push({ name, method, crc, compSize, size, offset });
    p += 46 + nl + el + cl;
  }
  return out;
}

function dataStart(bytes, ent) {
  if (u32(bytes, ent.offset) !== 0x04034b50) throw bad(`本地檔頭錯誤：${ent.name}`);
  return ent.offset + 30 + u16(bytes, ent.offset + 26) + u16(bytes, ent.offset + 28);
}

// 逐段解出一個項目；全部讀完後驗 CRC32 與大小
export function* zipEntryChunks(bytes, ent) {
  const start = dataStart(bytes, ent);
  const comp = bytes.subarray(start, start + ent.compSize);
  let crc = 0; let size = 0;
  if (ent.method === 0) {
    const step = 1 << 20;
    for (let i = 0; i < comp.length; i += step) {
      const c = comp.subarray(i, i + step);
      crc = crc32Update(crc, c); size += c.length;
      yield c;
    }
  } else if (ent.method === 8) {
    for (const c of inflateRawChunks(comp)) {
      crc = crc32Update(crc, c); size += c.length;
      yield c;
    }
  } else {
    throw bad(`不支援的壓縮方式 ${ent.method}：${ent.name}`);
  }
  if (size !== ent.size || crc !== ent.crc) throw bad(`內容校驗不符：${ent.name}`);
}

export function zipEntryBytes(bytes, ent) {
  const parts = [];
  let total = 0;
  for (const c of zipEntryChunks(bytes, ent)) { parts.push(c); total += c.length; }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}

export function readZip(bytes) {
  const entries = zipEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    has: (n) => byName.has(n),
    entry: (n) => byName.get(n) || null,
    bytes: (n) => { const e = byName.get(n); return e ? zipEntryBytes(bytes, e) : null; },
    text: (n) => { const e = byName.get(n); return e ? new TextDecoder('utf-8').decode(zipEntryBytes(bytes, e)) : null; },
    chunks: (n) => { const e = byName.get(n); if (!e) throw bad(`缺少 ${n}`); return zipEntryChunks(bytes, e); },
  };
}

// 寫 ZIP（stored）。files：[{name, data: Uint8Array|string}]；comment：字串（ZIP註解，限65535位元組）
export function writeZip(files, { comment = '', dosTime = 0, dosDate = 0x21 } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const push = (arr) => { parts.push(arr); offset += arr.length; };
  for (const f of files) {
    const name = utf8(f.name);
    const data = typeof f.data === 'string' ? utf8(f.data) : f.data;
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new SpecError('ZIP', 'ZIP 超過 4GB，請分批');
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true); dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    lh.set(name, 30);
    const at = offset;
    push(lh);
    push(data);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, at, true);
    ch.set(name, 46);
    central.push(ch);
  }
  const cdStart = offset;
  for (const c of central) push(c);
  const cm = utf8(comment);
  if (cm.length > 65535) throw new SpecError('ZIP', 'ZIP註解過長');
  const end = new Uint8Array(22 + cm.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, offset - cdStart, true); ev.setUint32(16, cdStart, true); ev.setUint16(20, cm.length, true);
  end.set(cm, 22);
  push(end);
  const out = new Uint8Array(offset);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function zipComment(bytes) {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) return new TextDecoder('utf-8').decode(bytes.subarray(i + 22, i + 22 + u16(bytes, i + 20)));
  }
  return null;
}
