// 條件 AST（第8節）：白名單驗證、三值判定、說明文字、範圍預覽、原文規則草稿解析（移轉用）。
// 禁止把使用者文字當程式執行；欄位、運算子、型別皆採白名單。
import { SpecError } from './errors.js';
import { normalizeMoney, compareMoney } from './values.js';
import { stableStringify, sha256Text } from './util.js';
import { normUnit } from './masterImport.js';

export const TRUE = '符合';
export const FALSE = '不符合';
export const UNKNOWN = '待確認';

// 欄位白名單：key → {label, type, col}
export const FIELDS = {
  group_code: { label: '分組代碼', type: 'text', col: 'group_code', name: 'group_name' },
  atc_code: { label: 'ATC碼', type: 'text', col: 'atc_code', name: 'atc_name' },
  dose_code: { label: '核價劑型', type: 'text', col: 'dose_code', name: 'dose_name' },
  multi_mark: { label: '單複方', type: 'text', col: 'multi_mark' },
  drug_code: { label: '藥品代碼', type: 'text', col: 'drug_code', name: 'drug_name' },
  firm_code: { label: '藥商代碼', type: 'text', col: 'firm_code', name: 'firm' },
  firm: { label: '藥商名稱', type: 'text', col: 'firm' },
  ingredient: { label: '成分', type: 'text', col: 'ingredient' },
  spec: { label: '規格', type: 'quantity', col: ['spec_qty', 'spec_unit'] },
};
export const TEXT_OPS = { eq: '等於', ne: '不等於', in: '屬於', not_in: '不屬於', starts_with: '前綴為', not_starts_with: '前綴非' };
export const QTY_OPS = { eq: '=', ne: '≠', gt: '>', ge: '≥', lt: '<', le: '≤' };
export const LOGIC_OPS = { and: '全部符合', or: '任一符合', not: '排除' };

function err(path, msg) {
  return new SpecError('RULE', `${path}：${msg}`);
}

function only(node, allowed, path) {
  const extra = Object.keys(node).filter((k) => !allowed.includes(k));
  if (extra.length) throw err(path, '不允許的屬性 ' + extra.join(', '));
}

export function validateRule(node, path = '根') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw err(path, '條件格式錯誤');
  const op = node.op;
  if (op === 'and' || op === 'or') {
    if (!Array.isArray(node.children) || !node.children.length) throw err(path, `${LOGIC_OPS[op]}群組不可為空（空規則不得當作全選）`);
    node.children.forEach((c, i) => validateRule(c, `${path}/${i + 1}`));
    only(node, ['op', 'children'], path);
    return;
  }
  if (op === 'not') {
    if (!node.child) throw err(path, '排除條件缺少內容');
    validateRule(node.child, `${path}/排除`);
    only(node, ['op', 'child'], path);
    return;
  }
  if (op === 'manual') {
    if (!String(node.text || '').trim()) throw err(path, '人工條件須保留原文');
    only(node, ['op', 'text', 'id'], path);
    return;
  }
  const f = FIELDS[node.field];
  if (!f) throw err(path, `不支援的欄位 ${JSON.stringify(node.field)}`);
  if (f.type === 'text') {
    if (!TEXT_OPS[op]) throw err(path, `欄位 ${node.field} 不支援運算子 ${JSON.stringify(op)}`);
    if (op === 'in' || op === 'not_in') {
      if (!Array.isArray(node.values) || !node.values.length || !node.values.every((v) => typeof v === 'string' && v.trim())) throw err(path, '清單條件須至少一個文字值');
      only(node, ['op', 'field', 'values'], path);
    } else {
      if (typeof node.value !== 'string' || !node.value.trim()) throw err(path, '條件值須為非空文字');
      only(node, ['op', 'field', 'value'], path);
    }
  } else {
    if (!QTY_OPS[op]) throw err(path, `規格不支援運算子 ${JSON.stringify(op)}`);
    if (typeof node.value !== 'string' || normalizeMoney(node.value) === null) throw err(path, '規格數值無法解析');
    if (!String(node.unit || '').trim()) throw err(path, '規格須指定單位');
    only(node, ['op', 'field', 'value', 'unit'], path);
  }
}

export function fieldsUsed(node, out = new Set()) {
  if (node.op === 'and' || node.op === 'or') node.children.forEach((c) => fieldsUsed(c, out));
  else if (node.op === 'not') fieldsUsed(node.child, out);
  else if (node.op !== 'manual') out.add(node.field);
  return out;
}

export function hasManual(node) {
  if (node.op === 'and' || node.op === 'or') return node.children.some(hasManual);
  if (node.op === 'not') return hasManual(node.child);
  return node.op === 'manual';
}

export function canonical(node) {
  return stableStringify(node);
}

export function ruleHash(node) {
  return sha256Text(canonical(node));
}

// 三值判定。knownUnits：Set（已正規化）；conversions：{'L|ML': '1000'}（僅經確認者；預設無）
export class Evaluator {
  constructor({ knownUnits, conversions } = {}) {
    this.known = new Set([...(knownUnits || [])].map(normUnit));
    this.conv = new Map();
    for (const [k, factor] of Object.entries(conversions || {})) {
      const [a, b] = k.split('|').map(normUnit);
      this.conv.set(`${a}|${b}`, { mul: factor });
      this.conv.set(`${b}|${a}`, { div: factor });
    }
  }

  evaluate(node, drug) {
    const op = node.op;
    if (op === 'and') {
      const rs = node.children.map((c) => this.evaluate(c, drug));
      const f = rs.find((r) => r[0] === FALSE);
      if (f) return f;
      const u = rs.filter((r) => r[0] === UNKNOWN);
      if (u.length) return [UNKNOWN, u.map((r) => r[1]).join('；')];
      return [TRUE, rs.map((r) => r[1]).join(' 且 ')];
    }
    if (op === 'or') {
      const rs = node.children.map((c) => this.evaluate(c, drug));
      const t = rs.find((r) => r[0] === TRUE);
      if (t) return t;
      const u = rs.filter((r) => r[0] === UNKNOWN);
      if (u.length) return [UNKNOWN, u.map((r) => r[1]).join('；')];
      return [FALSE, '皆不符合'];
    }
    if (op === 'not') {
      const [r, p] = this.evaluate(node.child, drug);
      if (r === UNKNOWN) return [UNKNOWN, `排除條件待確認（${p}）`];
      return r === TRUE ? [FALSE, `被排除：${p}`] : [TRUE, `非（${p}）`];
    }
    if (op === 'manual') return [UNKNOWN, `人工條件待確認：${node.text}`];
    const f = FIELDS[node.field];
    if (f.type === 'quantity') return this.qty(node, drug);
    let val = drug[f.col];
    val = val === null || val === undefined ? '' : String(val).trim();
    // 分組代碼空白直接視為不符合【使用者 2026-11-07 決定】；其他欄位缺值仍待確認
    if (!val && node.field === 'group_code') return [FALSE, '分組代碼空白（視為不符合）'];
    if (!val) return [UNKNOWN, `${f.label}缺值`];
    let ok;
    if (op === 'eq') ok = val === node.value.trim();
    else if (op === 'ne') ok = val !== node.value.trim();
    else if (op === 'in') ok = node.values.some((v) => v.trim() === val);
    else if (op === 'not_in') ok = !node.values.some((v) => v.trim() === val);
    else if (op === 'starts_with') ok = val.startsWith(node.value.trim());
    else ok = !val.startsWith(node.value.trim());
    return [ok ? TRUE : FALSE, `${f.label}=${val} ${TEXT_OPS[op]} ${node.value !== undefined ? node.value : node.values.join(',')}`];
  }

  qty(node, drug) {
    const q = drug.spec_qty === null || drug.spec_qty === undefined ? null : normalizeMoney(String(drug.spec_qty));
    const unit = normUnit(drug.spec_unit);
    const want = normalizeMoney(node.value);
    const wantUnit = normUnit(node.unit);
    if (q === null || !unit) return [UNKNOWN, '規格缺值'];
    let qty = q;
    if (unit !== wantUnit) {
      const c = this.conv.get(`${unit}|${wantUnit}`);
      if (!c) {
        if (this.known.has(unit) && this.known.has(wantUnit)) {
          if (node.op === 'eq') return [FALSE, `規格單位${unit}≠${wantUnit}`];
          if (node.op === 'ne') return [TRUE, `規格單位${unit}≠${wantUnit}`];
          return [UNKNOWN, `規格單位${unit}與${wantUnit}無確認換算，無法比較大小`];
        }
        return [UNKNOWN, `規格單位${unit}未知或無確認換算`];
      }
      // 經確認之換算：以整數運算避免浮點（乘法）；除法換算比較時以交叉相乘
      if (c.mul) qty = mulDec(q, c.mul);
      else return this.cmp(node.op, q, mulDec(want, c.div), unit, `${want}${wantUnit}`);
    }
    return this.cmp(node.op, qty, want, wantUnit, `${want}${wantUnit}`);
  }

  cmp(op, a, b, unit, wantText) {
    const c = compareMoney(a, b);
    const ok = { eq: c === 0, ne: c !== 0, gt: c > 0, ge: c >= 0, lt: c < 0, le: c <= 0 }[op];
    return [ok ? TRUE : FALSE, `規格${a}${unit} ${QTY_OPS[op]} ${wantText}`];
  }
}

function mulDec(a, b) {
  const split = (x) => { const [i, f = ''] = x.replace('-', '').split('.'); return { n: BigInt(i + f), s: f.length, neg: x.startsWith('-') }; };
  const x = split(normalizeMoney(a)); const y = split(normalizeMoney(String(b)));
  let n = x.n * y.n;
  const sc = x.s + y.s;
  const neg = x.neg !== y.neg;
  let s = n.toString().padStart(sc + 1, '0');
  s = sc ? s.slice(0, s.length - sc) + '.' + s.slice(s.length - sc) : s;
  return normalizeMoney((neg ? '-' : '') + s);
}

export function describe(node, depth = 0) {
  const pad = '　'.repeat(depth);
  const op = node.op;
  if (op === 'and' || op === 'or') return `${pad}${LOGIC_OPS[op]}：\n` + node.children.map((c) => describe(c, depth + 1)).join('\n');
  if (op === 'not') return `${pad}排除：\n` + describe(node.child, depth + 1);
  if (op === 'manual') return `${pad}【人工條件】${node.text}`;
  const f = FIELDS[node.field];
  if (f.type === 'quantity') return `${pad}${f.label} ${QTY_OPS[op]} ${node.value} ${node.unit}`;
  return `${pad}${f.label} ${TEXT_OPS[op]} ${node.value !== undefined ? node.value : node.values.join('、')}`;
}

// 待確認原因分類（供批次人工確認）
export function pendingReason(path) {
  if (path.includes('人工條件')) return '人工條件';
  if (path.includes('規格缺值')) return '規格缺值';
  if (path.includes('未知或無確認換算') || path.includes('無法比較大小')) return '規格單位未知或無換算';
  const m = /([^\s；=]+)缺值/.exec(path);
  return m ? `${m[1]}缺值` : '其他';
}

// 範圍預覽：rows＝loadMasterRows() 結果；imp＝主檔版本紀錄（取停用欄位與已知單位）
// 範圍全域排除【使用者 2026-11-07 決定】：藥品代碼前綴（預設 TPN）、不上網註＝Y
export function exclusionOf(settings) {
  const prefixes = String((settings && settings.scope_exclude_code_prefixes) ?? 'TPN').split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean);
  return { code_prefixes: prefixes, web_hidden_y: settings ? settings.scope_exclude_web_hidden !== false : true };
}

export function excludedReason(d, ex) {
  if (!ex) return null;
  const p = ex.code_prefixes.find((x) => String(d.drug_code).startsWith(x));
  if (p) return `代碼前綴${p}`;
  if (ex.web_hidden_y && String(d.web_hidden ?? '').trim().toUpperCase() === 'Y') return '不上網註＝Y';
  return null;
}

export async function previewRule(rule, rows, imp, { threshold = 500, conversions, exclusions } = {}) {
  validateRule(rule);
  if (!imp || imp.status !== '已啟用') throw new SpecError('MASTER_NOT_ACTIVE', '規則預覽須使用已啟用之主檔版本');
  const disabled = (imp.check && imp.check.disabled_rule_fields) || [];
  const missing = [...fieldsUsed(rule)].filter((f) => disabled.includes(f));
  if (missing.length) throw new SpecError('FIELD_DISABLED', '此主檔版本未映射欄位：' + missing.map((f) => FIELDS[f].label).join('、') + '；相關規則停用，請改用含該欄位的主檔或修改條件');
  const ev = new Evaluator({ knownUnits: (imp.check && imp.check.known_units) || [], conversions });
  const members = [];
  const groupTotal = new Map();
  const excluded = {};
  const ex = exclusions || null;
  const webMapped = !ex || !ex.web_hidden_y || [...rows.byCode.values()].some((d) => d.web_hidden !== undefined && d.web_hidden !== null);
  for (const d of rows.byCode.values()) {
    const xr = excludedReason(d, ex);
    const g = d.group_code;
    if (g && !xr) groupTotal.set(g, (groupTotal.get(g) || 0) + 1);
    const [res, path] = ev.evaluate(rule, d);
    // 全域排除：只計入原本會列入（符合或待確認）之品項
    if (xr) { if (res !== FALSE) excluded[xr] = (excluded[xr] || 0) + 1; continue; }
    if (res !== FALSE) {
      members.push({ drug_code: d.drug_code, result: res, path, group_code: g || null, drug_name: d.drug_name || null, firm: d.firm || null,
        spec: `${d.spec_qty ?? ''}${d.spec_unit ?? ''}`, source_row: d.source_row ?? null, annotation: d.annotation ?? null });
    }
  }
  members.sort((a, b) => (a.drug_code < b.drug_code ? -1 : 1));
  const groups = new Map();
  for (const m of members) {
    if (!m.group_code) continue;
    const x = groups.get(m.group_code) || { group_code: m.group_code, matched: 0, pending: 0, total: groupTotal.get(m.group_code) || 0 };
    if (m.result === TRUE) x.matched++; else x.pending++;
    groups.set(m.group_code, x);
  }
  for (const g of groups.values()) g.partial = g.matched + g.pending < g.total;
  const match = members.filter((m) => m.result === TRUE).length;
  const pending = members.length - match;
  const reasons = {};
  // 一個品項可能有多個待確認原因（如分組缺值且規格缺值），各別計數
  for (const m of members) {
    if (m.result !== UNKNOWN) continue;
    for (const k of new Set(m.path.split('；').map(pendingReason))) reasons[k] = (reasons[k] || 0) + 1;
  }
  const warnings = [];
  if (Object.keys(excluded).length) warnings.push('全域排除（不列入範圍）：' + Object.entries(excluded).map(([k, v]) => `${k} ${v}筆`).join('；'));
  if (!webMapped) warnings.push('此主檔版本未映射「不上網註」，未套用不上網註＝Y之排除');
  if (!members.length) warnings.push('零筆符合，請檢查條件');
  if (members.length > threshold) warnings.push(`符合筆數 ${members.length} 超過警示門檻 ${threshold}，請確認範圍`);
  const partial = [...groups.values()].filter((g) => g.partial).map((g) => g.group_code);
  if (partial.length) warnings.push('部分涵蓋分組：' + partial.join('、') + '；分組調價方式須另確認，不得直接將整組排除DET（Q02）');
  if (hasManual(rule)) warnings.push('含人工條件（如跨品項關係），相關品項列為待確認，須逐項人工確認');
  if (Object.keys(reasons).length) warnings.push('待確認原因：' + Object.entries(reasons).map(([k, v]) => `${k} ${v}筆`).join('；'));
  return { members, match, pending, groups: [...groups.values()].sort((a, b) => (a.group_code < b.group_code ? -1 : 1)), warnings, reasons,
    excluded, exclusions: ex ? { ...ex, web_hidden_applied: webMapped } : null,
    rule_hash: await ruleHash(rule), rule_canonical: canonical(rule), import_id: imp.id, base_date: imp.base_date };
}

// ---------- 原文規則草稿解析（Excel移轉用）：無法完整解析時以人工條件保存原文，不猜測 ----------
const ALIASES = [
  [/^分組代碼前(\d+)碼$/, 'group_code', 'prefix'],
  [/^ATC前(\d+)碼$/i, 'atc_code', 'prefix'],
  [/^(分類)?分組代碼$/, 'group_code', null],
  [/^規格量?$/, 'spec', 'qty'],
  [/^ATC7?碼$/i, 'atc_code', null],
  [/^(核價劑型PDOSE|核價劑型|PDOSE)$/i, 'dose_code', null],
  [/^複方藥品$/, 'multi_mark', null],
  [/^(CODE_aggr|CODE|藥品代碼)$/i, 'drug_code', null],
];
const ATC7 = /^[A-Z]\d\d[A-Z][A-Z]\d\d$/;

function prep(t) {
  let s = t;
  for (const [a, b] of [['＝', '='], ['，', ','], ['、', ','], ['＆', '&'], ['（', '('], ['）', ')'], ['﹛', '('], ['﹜', ')'], ['｛', '('], ['｝', ')'], ['　', ' '], ['≠', '<>']]) s = s.split(a).join(b);
  return s.trim();
}

function tokenize(t) {
  const re = /\s*(\(|\)|&|\bor\b|\bOR\b|\bIN\b|\bin\b|<>|!=|=|,|[^\s()&=,<>!]+)/y;
  const toks = [];
  let pos = 0;
  while (pos < t.length) {
    re.lastIndex = pos;
    const m = re.exec(t);
    if (!m || re.lastIndex === pos) {
      if (!t.slice(pos).trim()) break;
      throw new SpecError('RULE_PARSE', `無法辨識「${t.slice(pos, pos + 10)}」`);
    }
    const tok = m[1];
    toks.push(['or', 'in'].includes(tok.toLowerCase()) ? tok.toLowerCase() : tok);
    pos = re.lastIndex;
  }
  return toks;
}

function isField(tk) {
  return ALIASES.some(([re]) => re.test(tk));
}

function parseOr(toks, i) {
  let [left, j] = parseAnd(toks, i);
  const kids = [left];
  while (j < toks.length && toks[j] === 'or') { const [n, k] = parseAnd(toks, j + 1); kids.push(n); j = k; }
  return [kids.length === 1 ? kids[0] : { op: 'or', children: kids }, j];
}

function parseAnd(toks, i) {
  let [left, j] = parseAtom(toks, i);
  const kids = [left];
  while (j < toks.length && toks[j] === '&') { const [n, k] = parseAtom(toks, j + 1); kids.push(n); j = k; }
  return [kids.length === 1 ? kids[0] : { op: 'and', children: kids }, j];
}

function parseAtom(toks, i) {
  const fail = (m) => new SpecError('RULE_PARSE', m);
  if (i >= toks.length) throw fail('條件不完整');
  if (toks[i] === '(') {
    const [n, j] = parseOr(toks, i + 1);
    if (j >= toks.length || toks[j] !== ')') throw fail('括號不對稱');
    return [n, j + 1];
  }
  const name = toks[i];
  let field = null; let kind = null; let digits = null;
  for (const [re, f, k] of ALIASES) {
    const m = re.exec(name);
    if (m) { field = f; kind = k; digits = k === 'prefix' ? Number(m[1]) : null; break; }
  }
  if (!field) throw fail(`未知欄位「${name}」`);
  i++;
  if (i >= toks.length) throw fail('缺少運算子');
  const op = toks[i];
  if (!['=', '<>', '!=', 'in', ','].includes(op)) throw fail(`未知運算子「${op}」`);
  i++;
  const vals = [];
  let paren = false;
  if (i < toks.length && toks[i] === '(') { paren = true; i++; }
  while (i < toks.length) {
    const tk = toks[i];
    if (tk === ',') { i++; continue; }
    if (tk === '&' || tk === 'or' || (tk === ')' && !paren)) break;
    if (tk === ')') { i++; paren = false; break; }
    if (['(', '=', '<>', '!=', 'in'].includes(tk)) break;
    if (isField(tk) && i + 1 < toks.length && ['=', '<>', '!=', 'in'].includes(toks[i + 1])) break;
    vals.push(tk);
    i++;
  }
  if (paren) throw fail('括號不對稱');
  if (!vals.length) throw fail(`欄位「${name}」缺少條件值`);
  const neg = op === '<>' || op === '!=';
  if (kind === 'qty') {
    if (vals.length !== 1) throw fail('規格條件僅支援單一值');
    const m = /^([0-9.]+)\s*([A-Za-z]+)$/.exec(vals[0]);
    if (!m) throw fail(`規格值「${vals[0]}」無法分成數值與單位`);
    return [{ field: 'spec', op: neg ? 'ne' : 'eq', value: m[1], unit: m[2].toUpperCase() }, i];
  }
  if (kind === 'prefix') {
    const bad = vals.filter((v) => v.length !== digits);
    if (bad.length) throw fail(`前${digits}碼條件值長度不符：${bad.join(',')}`);
    const kids = vals.map((v) => ({ field, op: neg ? 'not_starts_with' : 'starts_with', value: v }));
    if (kids.length === 1) return [kids[0], i];
    return [neg ? { op: 'and', children: kids } : { op: 'or', children: kids }, i];
  }
  if (vals.length === 1) return [{ field, op: neg ? 'ne' : 'eq', value: vals[0] }, i];
  return [{ field, op: neg ? 'not_in' : 'in', values: vals }, i];
}

function* atcValues(node) {
  if (node.op === 'and' || node.op === 'or') for (const c of node.children) yield* atcValues(c);
  else if (node.op === 'not') yield* atcValues(node.child);
  else if (node.field === 'atc_code' && ['eq', 'ne', 'in', 'not_in'].includes(node.op)) yield* (node.value !== undefined ? [node.value] : node.values);
}

export function parseRuleText(text) {
  const issues = [];
  if (text === null || text === undefined || !String(text).trim()) return { ast: null, issues: ['篩選原則空白'] };
  const raw = String(text).trim();
  const t = prep(raw);
  if (/=\s*0\s*$/.test(t) || /\)\s*=\s*0/.test(t)) issues.push('條件末尾含「=0」，語意不清，不自動解讀（待業務確認）');
  if (t.includes('同廠牌') || (t.includes('且') && t.includes('同'))) {
    issues.push('含跨品項條件（如同廠牌），須人工確認');
    return { ast: { op: 'manual', text: raw }, issues };
  }
  let node;
  try {
    const toks = tokenize(t);
    const [n, pos] = parseOr(toks, 0);
    if (pos !== toks.length) throw new SpecError('RULE_PARSE', '尚有無法解析的文字');
    validateRule(n);
    node = n;
  } catch (e) {
    issues.push(`原文無法完整解析（${e.message}），保留為人工條件`);
    return { ast: { op: 'manual', text: raw }, issues };
  }
  for (const v of atcValues(node)) {
    if (!ATC7.test(v) && v.length === 7) {
      if (ATC7.test(v.replace(/O/g, '0'))) issues.push(`ATC碼 ${v} 疑似字母O／數字0誤植，標示待確認，未修正`);
      else issues.push(`ATC碼 ${v} 格式異常，待確認`);
    }
  }
  return { ast: node, issues };
}
