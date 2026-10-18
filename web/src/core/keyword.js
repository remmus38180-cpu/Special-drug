// 強制收回關鍵詞（第4.6節第10點）：只存加鹽雜湊，不存明文。
import { SpecError } from './errors.js';
import { P } from './paths.js';
import { hex, fromHex, utf8, randomHex, isoUtc } from './util.js';

export const DEFAULT_ITERATIONS = 200000;
export const MIN_KEYWORD_LENGTH = 4;

export async function deriveKeyword(keyword, saltHex, iterations) {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', utf8(keyword), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256);
  return hex(bits);
}

function checkNewKeyword(k) {
  if (typeof k !== 'string' || k.trim().length < MIN_KEYWORD_LENGTH) {
    throw new SpecError('BAD_KEYWORD', `關鍵詞至少 ${MIN_KEYWORD_LENGTH} 個字`);
  }
}

export async function buildKeywordRecord(keyword, { now, by, iterations = DEFAULT_ITERATIONS }) {
  checkNewKeyword(keyword);
  const salt = randomHex(16);
  return {
    format: 'specdrug-keyword',
    algorithm: 'PBKDF2-SHA256',
    iterations,
    salt,
    hash: await deriveKeyword(keyword, salt, iterations),
    set_at: isoUtc(now),
    set_by: by,
  };
}

export async function readKeywordRecord(fs) {
  const r = await fs.read(P.KEYWORD);
  if (!r) return null;
  let rec;
  try { rec = JSON.parse(r.text); } catch (e) { throw new SpecError('KEYWORD_BAD', '關鍵詞檔格式錯誤'); }
  if (!rec || rec.format !== 'specdrug-keyword' || !rec.salt || !rec.hash) throw new SpecError('KEYWORD_BAD', '關鍵詞檔格式錯誤');
  return rec;
}

export async function verifyKeyword(fs, keyword) {
  const rec = await readKeywordRecord(fs);
  if (!rec) throw new SpecError('KEYWORD_MISSING', '尚未設定關鍵詞（control/keyword.json 不存在）');
  const h = await deriveKeyword(String(keyword || ''), rec.salt, rec.iterations);
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0 && h.length === rec.hash.length;
}

export async function writeKeyword(fs, keyword, opts) {
  const rec = await buildKeywordRecord(keyword, opts);
  await fs.write(P.KEYWORD, JSON.stringify(rec, null, 2));
  return rec;
}

// 修改須輸入原關鍵詞
export async function changeKeyword(fs, oldKeyword, newKeyword, opts) {
  if (!(await verifyKeyword(fs, oldKeyword))) throw new SpecError('KEYWORD_WRONG', '原關鍵詞不正確');
  return writeKeyword(fs, newKeyword, opts);
}

// 分頁內連續輸錯鎖定（預設5次／30秒）
export class KeywordGuard {
  constructor({ clock, maxFail = 5, lockMs = 30000 }) {
    this.clock = clock;
    this.maxFail = maxFail;
    this.lockMs = lockMs;
    this.fails = 0;
    this.lockedUntil = 0;
  }

  status() {
    const now = this.clock.now();
    if (now < this.lockedUntil) return { locked: true, remainMs: this.lockedUntil - now };
    return { locked: false, remaining: this.maxFail - this.fails };
  }

  record(ok) {
    if (ok) { this.fails = 0; return this.status(); }
    this.fails += 1;
    if (this.fails >= this.maxFail) {
      this.lockedUntil = this.clock.now() + this.lockMs;
      this.fails = 0;
    }
    return this.status();
  }
}
