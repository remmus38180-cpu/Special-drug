// 階段4：自製 inflate／zip 與 Node zlib 對照
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflateRaw, inflateRawChunks } from '../src/core/inflate.js';
import { readZip, writeZip, crc32, zipComment } from '../src/core/zip.js';

function rand(n, seed, alphabet = 256) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = (x >>> 16) % alphabet; }
  return out;
}

test('inflate：各種資料與壓縮等級與 zlib 一致', () => {
  const samples = [
    new Uint8Array(0), new Uint8Array([65]), rand(1000, 1), rand(200000, 2, 4), rand(300000, 3, 40),
    new TextEncoder().encode('特殊藥品'.repeat(50000)), new Uint8Array(3 << 20).fill(7),
    // 可壓縮與不可壓縮交錯：產生動態區塊後接 stored 區塊
    (() => { const parts = []; for (let i = 0; i < 6; i++) { parts.push(new Uint8Array(70000).fill(65 + i)); parts.push(rand(90000, 100 + i)); } return new Uint8Array(Buffer.concat(parts.map((x) => Buffer.from(x)))); })(),
  ];
  for (const s of samples) {
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED, zlib.constants.Z_HUFFMAN_ONLY]) {
        const c = zlib.deflateRawSync(s, { level, strategy });
        const d = inflateRaw(new Uint8Array(c));
        assert.equal(Buffer.compare(Buffer.from(d), Buffer.from(s)), 0, `len ${s.length} level ${level} strategy ${strategy}`);
      }
    }
  }
});

test('inflate：分段輸出（小段）結果相同；損毀資料報錯', () => {
  const s = rand(500000, 9, 30);
  const c = new Uint8Array(zlib.deflateRawSync(s, { level: 9 }));
  const parts = [...inflateRawChunks(c, 4096)];
  assert.ok(parts.length > 50);
  assert.equal(Buffer.compare(Buffer.concat(parts.map((p) => Buffer.from(p))), Buffer.from(s)), 0);
  const broken = c.slice(0, c.length >> 1);
  assert.throws(() => inflateRaw(broken), (e) => e.code === 'INFLATE');
  assert.throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff])), (e) => e.code === 'INFLATE');
});

test('zip：寫入（stored）再讀回、CRC、UTF-8檔名、註解', () => {
  const files = [{ name: 'a.txt', data: 'hello' }, { name: '資料/版本.json', data: new Uint8Array([1, 2, 3]) }, { name: 'empty', data: '' }];
  const z = writeZip(files, { comment: '特藥備份 r000001' });
  const r = readZip(z);
  assert.deepEqual(r.entries.map((e) => e.name), ['a.txt', '資料/版本.json', 'empty']);
  assert.equal(r.text('a.txt'), 'hello');
  assert.deepEqual([...r.bytes('資料/版本.json')], [1, 2, 3]);
  assert.equal(r.text('empty'), '');
  assert.equal(zipComment(z), '特藥備份 r000001');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  // 竄改內容：CRC不符
  const bad = z.slice();
  bad[30 + 5] ^= 1;
  assert.throws(() => readZip(bad).text('a.txt'), (e) => e.code === 'ZIP');
});

test('zip：讀取 deflate 壓縮之 zip（以 zlib 產生）', () => {
  // 手工組一個 deflate 項目
  const data = new TextEncoder().encode('<x>'.repeat(10000));
  const comp = zlib.deflateRawSync(data);
  const name = new TextEncoder().encode('xl/sheet1.xml');
  const crc = crc32(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 42);
  const body = Buffer.concat([lh, name, comp]);
  const cd = Buffer.concat([ch, name]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  const z = new Uint8Array(Buffer.concat([body, cd, end]));
  assert.equal(readZip(z).text('xl/sheet1.xml'), '<x>'.repeat(10000));
  assert.throws(() => readZip(new Uint8Array(100)), (e) => e.code === 'ZIP');
});
