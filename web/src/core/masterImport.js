// 主檔匯入（第7節）：欄位映射、試匯入檢核、啟用（列資料先寫入 masters/ 並驗雜湊）、版本差異。
// 不依固定欄序；使用者選工作表、標題列及映射。新快照保留舊版；主檔消失品項不自動刪除認定。
import { SpecError } from './errors.js';
import { cellText, readHeaders, EXCEL_MAX_ROW } from './table.js';
import { normalizeCode, normalizeMoney, parseDate } from './values.js';
import { insert, setDedicated, list } from './model.js';
import { masterPath } from './paths.js';
import { newId, sha256Text, sha256Bytes } from './util.js';
import { storeBlob, addAttachmentRecord } from './attachments.js';

export const MASTER_FIELDS = [
  ['drug_code', '藥品代碼（必要）'], ['drug_name', '品名'], ['firm', '藥商名稱'], ['firm_code', '藥商代碼'],
  ['group_code', '分組代碼'], ['group_name', '分組名稱'], ['atc_code', 'ATC碼'], ['atc_name', 'ATC名稱'],
  ['dose_code', '核價劑型代碼'], ['dose_name', '核價劑型名稱'], ['ingredient', '成分'], ['strength', '含量'],
  ['multi_mark', '單複方註記'], ['spec_qty', '規格數值'], ['spec_unit', '規格單位'], ['price', '支付價'],
  ['annotation_raw', '必要藥品註記'], ['license_no', '許可證號'],
];
export const FIELD_LABEL = Object.fromEntries(MASTER_FIELDS);
const TARGETS = new Set(MASTER_FIELDS.map((x) => x[0]));
const CODE_FIELDS = new Set(['group_code', 'atc_code', 'dose_code', 'firm_code']);
// 列資料檔欄位順序
export const ROW_FIELDS = ['drug_code', 'drug_code_raw', ...MASTER_FIELDS.slice(1).map((x) => x[0]), 'annotation', 'source_row'];
export const COMPARE_FIELDS = ['drug_name', 'firm', 'firm_code', 'group_code', 'group_name', 'atc_code', 'dose_code', 'dose_name',
  'ingredient', 'strength', 'multi_mark', 'spec_qty', 'spec_unit', 'price', 'annotation', 'license_no'];
// 規則欄位所需之主檔欄位；缺少時停用該類規則（第7節第2點）
export const RULE_FIELD_NEEDS = {
  group_code: ['group_code'], atc_code: ['atc_code'], dose_code: ['dose_code'], multi_mark: ['multi_mark'],
  spec: ['spec_qty', 'spec_unit'], firm: ['firm'], firm_code: ['firm_code'], ingredient: ['ingredient'], drug_code: ['drug_code'],
};
// 已知規格單位；不在清單內視為未知單位→規則判定待確認
export const KNOWN_UNITS = ['ML', 'L', 'GM', 'MG', 'MCG', 'KG', 'IU', 'KIU', 'MIU', 'U', 'KU', 'MU', 'DOSE', 'MCL'];

// 【設計建議】預設映射；匯入時仍由使用者確認
export const PRESETS = [
  {
    key: 'monthly', label: '月產製藥品主檔（如「藥品主檔全」、dwm_drug_115xx）',
    mapping: {
      drug_code: 'CODE', drug_name: '藥品名稱', firm: '藥商名稱', firm_code: '藥商代碼', group_code: '分組代碼', group_name: '分組名稱',
      atc_code: 'ATC7碼', atc_name: 'ATC名稱', dose_code: 'PDOSE', dose_name: '核價劑型', ingredient: '成分名稱', strength: '成分含量',
      multi_mark: '複方藥品', spec_qty: '規格量', spec_unit: '規格單位', annotation_raw: '必要藥品', license_no: '許可證號',
    },
    note: '支付價欄依資料基準日選 PRICE11510／price11511 等（系統依基準日預選）。必要藥品空白視為0（一般藥品）。',
  },
  {
    key: 'daily', label: 'DWM_DRUG SQL Server 每日檔（依 table layout 欄名）',
    mapping: {
      drug_code: 'DRUG_CODE', drug_name: 'DRUG_ENAME', firm_code: 'DRUGGIST_ID', group_code: 'DRUG_GROUP_CODE', atc_code: 'DRUG_ATC7_CODE',
      dose_code: 'DRUG_APV_DOSE_CODE', ingredient: 'DRUG_ING_CODE', strength: 'DRUG_ING_QTY', multi_mark: 'DRUG_MULTI_MARK',
      spec_qty: 'DRUG_STD_QTY_CODE', spec_unit: 'DRUG_STD_CODE', annotation_raw: 'DRUG_NECESSARY', license_no: 'LICID_7',
    },
    lookups: {
      spec_qty: { type: '5', field: 'std_qty' }, spec_unit: { type: '2', field: 'ename' },
      group_name: { type: '8', field: 'cname', from: 'group_code' }, atc_name: { type: '7', field: 'cname', from: 'atc_code' },
      dose_name: { type: '1', field: 'cname', from: 'dose_code' },
    },
    note: '支付價另選 DWM_DRPAY 長表並指定資料基準日；規格量／單位代碼經 DWM_DRUG_RCODE 轉換。',
  },
];

// 依資料基準日預選支付價欄：priceYYYMM（民國年月）
export function suggestPriceColumn(headers, baseDate) {
  const cands = headers.filter((h) => /^price\d{5}$/i.test(h));
  if (!cands.length) return null;
  if (baseDate) {
    const [y, m] = baseDate.split('-');
    const want = `${Number(y) - 1911}${m}`;
    const hit = cands.find((h) => h.slice(5) === want);
    if (hit) return hit;
  }
  return null;
}

export function presetMapping(presetKey, headers, baseDate) {
  const p = PRESETS.find((x) => x.key === presetKey);
  if (!p) return {};
  const m = {};
  for (const [t, src] of Object.entries(p.mapping)) if (headers.includes(src)) m[t] = src;
  if (presetKey === 'monthly') { const pc = suggestPriceColumn(headers, baseDate); if (pc) m.price = pc; }
  return m;
}

export function normUnit(u) {
  if (u === null || u === undefined) return null;
  const s = String(u).trim().toUpperCase().replace(/\s*\(.*\)\s*$/, '');
  return s || null;
}

// 必要藥品註記正規化：空白＝0（一般藥品）【已確認：使用者 2026-11-06】
export function normAnnotation(raw) {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  return s === '' ? '0' : s;
}

const tickEvery = 2000;
async function maybeTick(n, tick) {
  if (tick && n % tickEvery === 0) await tick(n);
}

// DWM_DRUG_RCODE：Map('type|code' → {cname, ename, std_qty})
export async function loadRcode(table, { sheet, headerRow = 1, tick } = {}) {
  const h = readHeaders(table, sheet, headerRow);
  const col = (n) => h.indexOf(n);
  const need = ['DRUG_REL_CODE_TYPE', 'DRUG_REL_CODE', 'DRUG_REL_CODE_CNAME', 'DRUG_REL_CODE_ENAME', 'DRUG_STD_QTY'];
  if (col(need[0]) < 0 || col(need[1]) < 0) throw new SpecError('RCODE', '代碼檔缺 DRUG_REL_CODE_TYPE／DRUG_REL_CODE 欄，請確認是 DWM_DRUG_RCODE 匯出檔');
  const out = new Map();
  let n = 0;
  for (const r of table.rows(sheet)) {
    if (r.rowNo <= headerRow) continue;
    const t = cellText(r.cells.get(col(need[0])));
    const c = cellText(r.cells.get(col(need[1])));
    if (!t || !c) continue;
    const q = cellText(r.cells.get(col(need[4])));
    out.set(`${t}|${c}`, { cname: cellText(r.cells.get(col(need[2]))), ename: cellText(r.cells.get(col(need[3]))), std_qty: q === null ? null : normalizeMoney(q) });
    await maybeTick(++n, tick);
  }
  if (!out.size) throw new SpecError('RCODE', '代碼檔沒有可用資料');
  return out;
}

// 多期價格長表：依基準日取 起日≤基準日≤迄日（迄日含）之價格；同代碼多筆不同價→矛盾
export async function loadPriceLong(table, { sheet, headerRow = 1, cols, baseDate, tick }) {
  if (!baseDate) throw new SpecError('NEED_BASE_DATE', '價格長表須先指定資料基準日，不任取第一筆');
  const h = readHeaders(table, sheet, headerRow);
  const idx = {};
  for (const k of ['code', 'from', 'to', 'price']) {
    idx[k] = h.indexOf(cols[k]);
    if (idx[k] < 0) throw new SpecError('MAP_MISSING', `價格檔找不到欄位：${cols[k]}`);
  }
  const prices = new Map();
  const conflicts = new Map();
  let last = 0; let n = 0;
  for (const r of table.rows(sheet)) {
    if (r.rowNo <= headerRow) continue;
    last = r.rowNo;
    const { code, error } = normalizeCode(cellText(r.cells.get(idx.code)));
    if (error) continue;
    const dv = (c) => { const cell = r.cells.get(c); if (!cell) return null; return cell.iso || parseDate(cellText(cell)); };
    const s = dv(idx.from); const e = dv(idx.to);
    if (!s || s > baseDate || (e && e < baseDate)) continue;
    const p = normalizeMoney(cellText(r.cells.get(idx.price)));
    if (prices.has(code) && prices.get(code) !== p) {
      if (!conflicts.has(code)) conflicts.set(code, new Set([prices.get(code)]));
      conflicts.get(code).add(p);
    }
    prices.set(code, p);
    await maybeTick(++n, tick);
  }
  return { prices, conflicts, truncated: last >= EXCEL_MAX_ROW };
}

function sameRec(a, b) {
  const diffs = {};
  for (const k of [...COMPARE_FIELDS, 'drug_code_raw']) if ((a[k] ?? null) !== (b[k] ?? null)) diffs[k] = [a[k] ?? null, b[k] ?? null];
  return diffs;
}

// 試匯入：不寫任何檔案，回傳 {records(Map), check}
export async function stageMaster({ table, sheet, headerRow = 1, mapping, baseDate, lookups, rcode, price, tick }) {
  if (!mapping || !mapping.drug_code) throw new SpecError('MAP_REQUIRED', '必須映射「藥品代碼」欄位');
  const bad = Object.keys(mapping).filter((k) => !TARGETS.has(k));
  if (bad.length) throw new SpecError('MAP_UNKNOWN', '未知的映射目標：' + bad.join('、'));
  const base = baseDate ? parseDate(baseDate) : null;
  if (baseDate && !base) throw new SpecError('BAD_DATE', '資料基準日格式錯誤');
  const lk = lookups || {};
  if (Object.keys(lk).length && !rcode) throw new SpecError('NEED_RCODE', '此映射需代碼轉換，請另選 DWM_DRUG_RCODE 檔');
  const headers = readHeaders(table, sheet, headerRow);
  const src = {};
  const missingSrc = [];
  for (const [t, name] of Object.entries(mapping)) {
    if (!name) continue;
    const i = headers.indexOf(name);
    if (i < 0) missingSrc.push(`${FIELD_LABEL[t]}←${name}`); else src[t] = i;
  }
  if (missingSrc.length) throw new SpecError('MAP_MISSING', '來源檔找不到映射欄位：' + missingSrc.join('、'));
  const wanted = new Set(Object.values(src));
  const records = new Map();
  const rowsOf = new Map();
  const codeErrors = []; const warnings = []; const identical = []; const conflicts = [];
  const unknownLookup = {}; const unknownUnits = new Map(); const badPrices = [];
  let total = 0; let last = 0;
  for (const r of table.rows(sheet, { wanted: (c) => wanted.has(c) })) {
    if (r.rowNo <= headerRow) continue;
    last = r.rowNo;
    if (![...wanted].some((c) => cellText(r.cells.get(c)) !== null)) continue;
    total++;
    const codeCell = r.cells.get(src.drug_code);
    const rawCode = cellText(codeCell);
    let { code, error } = normalizeCode(rawCode);
    if (!error && codeCell && codeCell.t === 'n') { code = null; error = `代碼為數值型儲存格（${rawCode}），可能遺失前導零，不自行補碼`; }
    if (error) { codeErrors.push({ row: r.rowNo, error }); await maybeTick(total, tick); continue; }
    const rec = { drug_code: code, drug_code_raw: codeCell ? String(codeCell.v) : null };
    for (const [t, ci] of Object.entries(src)) {
      if (t === 'drug_code') continue;
      const cell = r.cells.get(ci);
      const v = cellText(cell);
      if (CODE_FIELDS.has(t) && cell && cell.t === 'n' && !lk[t]) warnings.push(`第${r.rowNo}列 ${FIELD_LABEL[t]} 為數值型（${v}），可能遺失前導零`);
      if (t === 'price') {
        const p = v === null ? null : normalizeMoney(v);
        if (v !== null && p === null) badPrices.push(r.rowNo);
        rec.price = p;
      } else if (t === 'spec_qty' && !lk.spec_qty) {
        rec.spec_qty = v === null ? null : (normalizeMoney(v) ?? v);
      } else {
        rec[t] = v;
      }
    }
    for (const [t, conf] of Object.entries(lk)) {
      const fromT = conf.from || t;
      const key = rec[fromT];
      if (key === null || key === undefined) { if (!conf.from) rec[t] = null; continue; }
      const hit = rcode.get(`${conf.type}|${key}`);
      if (!hit) {
        (unknownLookup[t] = unknownLookup[t] || new Set()).add(key);
        if (!conf.from) rec[t] = null;
      } else {
        rec[t] = hit[conf.field] ?? null;
      }
    }
    if (price) rec.price = price.prices.has(code) ? price.prices.get(code) : null;
    if (rec.spec_unit !== undefined) {
      const u = normUnit(rec.spec_unit);
      rec.spec_unit = u;
      if (u && !KNOWN_UNITS.includes(u)) unknownUnits.set(u, (unknownUnits.get(u) || 0) + 1);
    }
    rec.annotation = mapping.annotation_raw ? normAnnotation(rec.annotation_raw) : null;
    rec.source_row = r.rowNo;
    if (!rowsOf.has(code)) rowsOf.set(code, []);
    rowsOf.get(code).push(r.rowNo);
    if (records.has(code)) {
      const diffs = sameRec(records.get(code), rec);
      if (Object.keys(diffs).length) conflicts.push({ code, rows: [...rowsOf.get(code)], diffs });
      else identical.push({ code, rows: [...rowsOf.get(code)] });
    } else {
      records.set(code, rec);
    }
    await maybeTick(total, tick);
  }
  if (price) {
    for (const [code, vals] of price.conflicts) {
      if (records.has(code)) conflicts.push({ code, rows: rowsOf.get(code), diffs: { price: [...vals] }, note: '價格長表於基準日有多筆不同價格' });
    }
  }
  if (last >= EXCEL_MAX_ROW || (price && price.truncated)) warnings.unshift('來源資料達Excel列數上限（1,048,576列），可能已被截斷，請改用完整CSV匯出');
  if (badPrices.length) warnings.push(`支付價無法解析 ${badPrices.length} 列（例：第${badPrices.slice(0, 5).join('、')}列），該列價格留空`);
  const mapped = new Set([...Object.keys(src), ...Object.keys(lk), ...(price ? ['price'] : [])]);
  const disabledRules = Object.entries(RULE_FIELD_NEEDS).filter(([, need]) => need.some((f) => !mapped.has(f))).map(([k]) => k);
  const conflictCodes = new Set(conflicts.map((c) => c.code));
  const check = {
    total_rows: total, codes: records.size, last_row: last,
    code_error_count: codeErrors.length, code_errors: codeErrors.slice(0, 500),
    identical_duplicate_count: identical.length, identical_duplicates: identical.slice(0, 500),
    conflict_count: conflicts.length, conflicts: conflicts.slice(0, 500),
    warning_count: warnings.length, warnings: warnings.slice(0, 200),
    unknown_units: Object.fromEntries([...unknownUnits.entries()].sort((a, b) => b[1] - a[1])),
    unknown_lookup: Object.fromEntries(Object.entries(unknownLookup).map(([k, v]) => [k, [...v].slice(0, 50)])),
    unknown_lookup_count: Object.fromEntries(Object.entries(unknownLookup).map(([k, v]) => [k, v.size])),
    unmapped_fields: MASTER_FIELDS.map((x) => x[0]).filter((t) => !mapped.has(t)),
    disabled_rule_fields: disabledRules,
    missing_values: Object.fromEntries([...mapped].filter((f) => f !== 'drug_code').map((f) => [f, [...records.values()].filter((x) => x[f] === null || x[f] === undefined).length])),
    base_date: base,
  };
  return { records, check, headers, mapping: { ...mapping }, lookups: lk, conflictCodes, sheet: sheet || null, headerRow };
}

// 啟用前檢查（不寫檔）
export function activationProblems(staged, { confirmMerge } = {}) {
  const c = staged.check;
  const p = [];
  if (!c.base_date) p.push('主檔啟用須有資料基準日');
  if (c.conflict_count) p.push(`同代碼內容矛盾 ${c.conflict_count} 筆，阻止啟用：` + c.conflicts.slice(0, 10).map((x) => `${x.code}（列 ${x.rows.join(',')}：${Object.keys(x.diffs).join(',')}）`).join('；'));
  if (c.code_error_count) p.push(`有 ${c.code_error_count} 列藥品代碼錯誤（如數值型、空白、科學記號），請修正來源後重新匯入`);
  if (c.identical_duplicate_count && !confirmMerge) p.push(`有 ${c.identical_duplicate_count} 個代碼完全相同重複列，須確認合併後再啟用`);
  if (!c.codes) p.push('沒有可匯入之品項');
  return p;
}

export function rowsFileText(importId, staged, meta) {
  const rows = [];
  for (const rec of staged.records.values()) rows.push(ROW_FIELDS.map((f) => (rec[f] === undefined ? null : rec[f])));
  return JSON.stringify({ format: 'specdrug-master', import_id: importId, base_date: staged.check.base_date, source_name: meta.source_name, source_sha256: meta.source_sha256, fields: ROW_FIELDS, rows }) + '\n';
}

// 啟用（於編輯模式）：①來源檔存為附件 ②列資料寫入 masters/ 並驗雜湊 ③建立主檔版本紀錄並停用舊版（整批成立）
// sources：[{role:'主檔'|'代碼檔'|'價格長表', name, bytes}]
export async function activateMaster(session, staged, sources, { confirmMerge, note, opId } = {}) {
  const problems = activationProblems(staged, { confirmMerge });
  if (problems.length) throw new SpecError('ACTIVATE_BLOCKED', problems.join('；'));
  if (session.mode !== 'edit') throw new SpecError('NOT_EDITING', '啟用主檔須先取得編輯牌');
  const main = sources.find((s) => s.role === '主檔');
  if (!main) throw new SpecError('NO_SOURCE', '缺主檔來源檔');
  const stored = [];
  for (const s of sources) stored.push({ ...s, ...(await storeBlob(session.fs, s.bytes)) });
  const importId = newId();
  const path = masterPath(importId);
  const text = rowsFileText(importId, staged, { source_name: main.name, source_sha256: stored.find((s) => s.role === '主檔').sha256 });
  const rowsSha = await sha256Text(text);
  await session.fs.create(path, text);
  const back = await session.fs.read(path);
  if (!back || (await sha256Text(back.text)) !== rowsSha) throw new SpecError('WRITE_VERIFY', '主檔列資料寫入後讀回雜湊不符；未啟用');
  const refs = [{ path, sha256: rowsSha, label: '主檔列資料' }, ...stored.map((s) => ({ path: s.path, sha256: s.sha256, label: `${s.role}來源檔 ${s.name}` }))];
  const mainSha = stored.find((s) => s.role === '主檔').sha256;
  return session.run((d, ctx) => {
    const prev = activeImport(d);
    const rec = insert(d, ctx, 'master_import', {
      kind: 'drug', source_name: main.name, sha256: mainSha, base_date: staged.check.base_date, sheet: staged.sheet || null,
      header_row: staged.headerRow || 1, mapping: { mapping: staged.mapping, lookups: staged.lookups, aux: sources.filter((s) => s.role !== '主檔').map((s) => ({ role: s.role, name: s.name })), price: staged.priceInfo || null },
      row_count: staged.check.codes, check: { ...staged.check, merged_duplicates: !!confirmMerge }, rows_file: path, rows_sha256: rowsSha,
      status: '已啟用', note: note || null,
    }, { action: '試匯入並啟用' });
    setDedicated(d, ctx, 'master_import', rec.id, { activated_by: ctx.actor, activated_at: ctx.now }, { action: '啟用主檔', fields: ['activated_by', 'activated_at'] });
    if (prev) setDedicated(d, ctx, 'master_import', prev.id, { status: '已停用' }, { action: '停用舊主檔版本（保留）', fields: ['status'] });
    for (const s of stored) addAttachmentRecord(d, ctx, { orig_name: s.name, sha256: s.sha256, size: s.size, mime: s.mime || null }, [{ entity: 'master_import', entity_id: rec.id }]);
    return { import_id: rec.id, previous: prev ? prev.id : null };
  }, { refs, opId, kind: '啟用主檔' });
}

export function activeImport(data) {
  return list(data, 'master_import').find((m) => m.status === '已啟用') || null;
}

export function listImports(data) {
  return list(data, 'master_import').slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// 讀取並驗證某版本列資料；回傳 {fields, rows, byCode(Map code→物件)}
export async function loadMasterRows(fs, imp) {
  const rec = typeof imp === 'string' ? null : imp;
  if (!rec) throw new SpecError('NOT_FOUND', '找不到主檔版本');
  const r = await fs.read(rec.rows_file);
  if (!r) throw new SpecError('REF_MISSING', `主檔列資料檔不存在：${rec.rows_file}`);
  if ((await sha256Text(r.text)) !== rec.rows_sha256) throw new SpecError('REF_HASH', `主檔列資料檔雜湊不符：${rec.rows_file}`);
  const f = JSON.parse(r.text);
  const byCode = new Map();
  for (const row of f.rows) {
    const o = {};
    f.fields.forEach((k, i) => { o[k] = row[i]; });
    byCode.set(o.drug_code, o);
  }
  return { importId: f.import_id, fields: f.fields, byCode };
}

export function diffMasters(oldRows, newRows, fields = COMPARE_FIELDS) {
  const added = []; const removed = []; const changed = [];
  for (const code of newRows.byCode.keys()) if (!oldRows.byCode.has(code)) added.push(code);
  for (const code of oldRows.byCode.keys()) if (!newRows.byCode.has(code)) removed.push(code);
  const fieldCount = {};
  for (const [code, n] of newRows.byCode) {
    const o = oldRows.byCode.get(code);
    if (!o) continue;
    const d = {};
    for (const f of fields) if ((o[f] ?? null) !== (n[f] ?? null)) { d[f] = [o[f] ?? null, n[f] ?? null]; fieldCount[f] = (fieldCount[f] || 0) + 1; }
    if (Object.keys(d).length) changed.push({ drug_code: code, diffs: d });
  }
  const sort = (a) => a.sort();
  return { added: sort(added), removed: sort(removed), changed: changed.sort((a, b) => (a.drug_code < b.drug_code ? -1 : 1)), fieldCount };
}

// 試匯入結果與目前版本比較（啟用前預覽）
export function stagedAsRows(staged) {
  return { byCode: staged.records };
}

export function masterOptions(rows, field) {
  const pairs = { group_code: 'group_name', atc_code: 'atc_name', dose_code: 'dose_name', drug_code: 'drug_name', firm_code: 'firm', multi_mark: null, spec_unit: null, firm: null };
  const nameF = pairs[field];
  const m = new Map();
  for (const r of rows.byCode.values()) {
    const v = r[field];
    if (v === null || v === undefined || v === '') continue;
    const e = m.get(v) || { value: v, label: nameF ? r[nameF] || '' : '', count: 0 };
    e.count++;
    m.set(v, e);
  }
  return [...m.values()].sort((a, b) => (a.value < b.value ? -1 : 1));
}

export async function fileSha(bytes) {
  return sha256Bytes(bytes);
}

