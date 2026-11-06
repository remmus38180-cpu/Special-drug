// DEFLATE 解壓（RFC 1951），自行實作，不依賴外部函式庫。
// 以產生器分段輸出（每段約1MB），保留32KB回溯視窗；呼叫端可在段與段之間讓出執行緒、顯示進度。
import { SpecError } from './errors.js';

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const FAST = 10;
const WINDOW = 32768;

function bad(msg) {
  return new SpecError('INFLATE', '壓縮資料損毀：' + msg);
}

// 霍夫曼表：counts／symbols 供慢速逐位元解碼；fast 為10位元查表（值＝symbol | len<<16，0＝走慢速）
function buildHuffman(lengths, n) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw bad('霍夫曼碼超量');
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Uint16Array(n);
  for (let s = 0; s < n; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  const fast = new Int32Array(1 << FAST);
  // 依正準碼建查表（位元反轉）
  let code = 0;
  const next = new Uint16Array(16);
  for (let len = 1; len < 16; len++) { code = (code + counts[len - 1]) << 1; next[len] = code; }
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (!len || len > FAST) continue;
    let c = next[len]++;
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | (c & 1); c >>>= 1; }
    for (let k = r; k < (1 << FAST); k += (1 << len)) fast[k] = s | (len << 16) | 0x40000000;
  }
  return { counts, symbols, fast };
}

const FIXED = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  return { lit: buildHuffman(l, 288), dist: buildHuffman(d, 30) };
})();

export function* inflateRawChunks(src, chunkSize = 1 << 20) {
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;
  const cap = WINDOW + chunkSize;
  let out = new Uint8Array(cap);
  let op = 0;
  let emitFrom = 0;
  let overrun = 0;

  const need = (n) => {
    while (bitcnt < n) {
      if (pos < src.length) bitbuf |= src[pos++] << bitcnt;
      else if (++overrun > 4) throw bad('資料提前結束');
      bitcnt += 8;
    }
  };
  const bits = (n) => {
    need(n);
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  };
  const decode = (h) => {
    need(15);
    const e = h.fast[bitbuf & ((1 << FAST) - 1)];
    if (e) {
      const len = (e >>> 16) & 0xff;
      bitbuf >>>= len;
      bitcnt -= len;
      return e & 0xffff;
    }
    // 慢速：逐位元正準解碼
    let code = 0; let first = 0; let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bitbuf & 1;
      bitbuf >>>= 1;
      bitcnt--;
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw bad('無效霍夫曼碼');
  };
  // 輸出緩衝滿：送出新資料，保留最後32KB作回溯視窗
  function* flushIfFull(force) {
    if (!force && op < cap) return;
    if (op > emitFrom) yield out.slice(emitFrom, op);
    if (op > WINDOW) {
      out.copyWithin(0, op - WINDOW, op);
      op = WINDOW;
    }
    emitFrom = op;
  }

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // 對齊位元組：捨棄未滿一位元組之位元，並退回已預讀之整位元組
      bitcnt -= bitcnt & 7;
      pos -= (bitcnt >> 3) - Math.max(0, overrun);
      bitbuf = 0; bitcnt = 0; overrun = 0;
      if (pos + 4 > src.length) throw bad('stored區塊不完整');
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw bad('stored區塊長度錯誤');
      if (pos + len > src.length) throw bad('stored區塊超出資料');
      let k = 0;
      while (k < len) {
        const n = Math.min(len - k, cap - op);
        out.set(src.subarray(pos + k, pos + k + n), op);
        op += n; k += n;
        yield* flushIfFull(false);
      }
      pos += len;
      continue;
    }
    let lit; let dist;
    if (type === 1) {
      lit = FIXED.lit; dist = FIXED.dist;
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clh = buildHuffman(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decode(clh);
        if (sym < 16) { lens[i++] = sym; continue; }
        let rep = 0; let val = 0;
        if (sym === 16) { if (!i) throw bad('重複碼無前值'); val = lens[i - 1]; rep = 3 + bits(2); }
        else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (i + rep > hlit + hdist) throw bad('碼長超量');
        while (rep--) lens[i++] = val;
      }
      if (!lens[256]) throw bad('缺區塊結束碼');
      lit = buildHuffman(lens.subarray(0, hlit), hlit);
      dist = buildHuffman(lens.subarray(hlit), hdist);
    } else {
      throw bad('區塊類型錯誤');
    }
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        out[op++] = sym;
        if (op === cap) yield* flushIfFull(false);
        continue;
      }
      if (sym === 256) break;
      sym -= 257;
      if (sym >= 29) throw bad('長度碼錯誤');
      const len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
      const ds = decode(dist);
      if (ds >= 30) throw bad('距離碼錯誤');
      const d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
      if (d > op) throw bad('回溯距離超出');
      if (op + len > cap) yield* flushIfFull(true);
      let from = op - d;
      for (let k = 0; k < len; k++) out[op++] = out[from++];
      if (op === cap) yield* flushIfFull(false);
    }
  }
  yield* flushIfFull(true);
}

export function inflateRaw(src) {
  const parts = [];
  let total = 0;
  for (const c of inflateRawChunks(src)) { parts.push(c); total += c.length; }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of parts) { out.set(c, o); o += c.length; }
  return out;
}
