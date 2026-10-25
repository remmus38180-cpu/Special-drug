// 值型別：金額（十進位字串，不用浮點）、日期（YYYY-MM-DD，可讀民國年）、代碼（文字，保留前導零）。
import { SpecError } from './errors.js';

// ---------- 金額 ----------
const MONEY_RE = /^-?\d+(\.\d+)?$/;

// 正規化金額文字（去千分位、去多餘零：12.50→12.5、12.0→12）；無法解析回傳 null
export function normalizeMoney(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') throw new SpecError('MONEY_FLOAT', '金額不得以數值（浮點）傳入，請以文字傳入');
  let s = String(v).trim().replace(/,/g, '');
  if (!MONEY_RE.test(s)) return null;
  let neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let [i, f = ''] = s.split('.');
  i = i.replace(/^0+(?=\d)/, '');
  f = f.replace(/0+$/, '');
  if (i === '0' && !f) neg = false;
  return (neg ? '-' : '') + i + (f ? '.' + f : '');
}

function toScaled(a, scale) {
  const neg = a.startsWith('-');
  const s = neg ? a.slice(1) : a;
  const [i, f = ''] = s.split('.');
  const n = BigInt(i + f.padEnd(scale, '0'));
  return neg ? -n : n;
}

function scaleOf(a) {
  const k = a.indexOf('.');
  return k < 0 ? 0 : a.length - k - 1;
}

function fromScaled(n, scale) {
  const neg = n < 0n;
  let s = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const out = scale ? s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale) : s;
  return normalizeMoney((neg ? '-' : '') + out);
}

function needMoney(a) {
  const n = normalizeMoney(a);
  if (n === null) throw new SpecError('MONEY_BAD', `金額格式錯誤：${a}`);
  return n;
}

export function compareMoney(a, b) {
  const x = needMoney(a); const y = needMoney(b);
  const sc = Math.max(scaleOf(x), scaleOf(y));
  const d = toScaled(x, sc) - toScaled(y, sc);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

export function addMoney(a, b) {
  const x = needMoney(a); const y = needMoney(b);
  const sc = Math.max(scaleOf(x), scaleOf(y));
  return fromScaled(toScaled(x, sc) + toScaled(y, sc), sc);
}

export function subMoney(a, b) {
  const x = needMoney(a); const y = needMoney(b);
  const sc = Math.max(scaleOf(x), scaleOf(y));
  return fromScaled(toScaled(x, sc) - toScaled(y, sc), sc);
}

// ---------- 日期 ----------
const ISO_RE = /^\s*(\d{4})[./-](\d{1,2})[./-](\d{1,2})\s*$/;
const YMD8_RE = /^\s*(\d{4})(\d{2})(\d{2})\s*$/;
const ROC_RE = /^\s*(\d{2,3})[./-](\d{1,2})[./-](\d{1,2})\s*$/;
const ROC7_RE = /^\s*(\d{3})(\d{2})(\d{2})\s*$/;

function validYmd(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 解析西元或民國日期；無法解析回傳 null（不猜測）
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  for (const [re, roc] of [[ISO_RE, false], [YMD8_RE, false], [ROC_RE, true], [ROC7_RE, true]]) {
    const m = re.exec(s);
    if (m) {
      let y = Number(m[1]);
      if (roc) y += 1911;
      return validYmd(y, Number(m[2]), Number(m[3]));
    }
  }
  return null;
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDate(s) === s;
}

export function rocDisplay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(y) - 1911}/${m}/${d}`;
}

// 起日含、迄日不含；起日空白視為未知→不成立
export function inPeriod(day, from, to) {
  if (!from) return false;
  if (day < from) return false;
  if (to && day >= to) return false;
  return true;
}

export function taipeiToday(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------- 代碼 ----------
// 回傳 {code, error}；只去前後空白；不改O/0、不補前導零；數值型可能遺失前導零列為錯誤
export function normalizeCode(raw) {
  if (raw === null || raw === undefined) return { code: null, error: '代碼空白' };
  if (typeof raw === 'boolean') return { code: null, error: '代碼型別錯誤' };
  if (typeof raw === 'number' || typeof raw === 'bigint') return { code: null, error: `代碼為數值型（${raw}），可能遺失前導零，不自行補碼` };
  const s = String(raw).trim();
  if (!s) return { code: null, error: '代碼空白' };
  if (/^[0-9.]+[Ee][+-]?[0-9]+$/.test(s)) return { code: null, error: `代碼疑似科學記號（${s}）` };
  return { code: s, error: null };
}
