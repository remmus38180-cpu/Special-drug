// 既有 Excel（活頁簿1 final）歷史資料移轉（第12節）：暫存→預覽核對→逐列確認寫入。
// - 每列保存來源雜湊、工作表、列號、原始欄位、解析結果、待確認問題。
// - 不直接寫成現行有效資料：認定版本一律為草稿；缺日期／決議／合約標記不完整。
// - 同來源同列重複暫存／寫入不重複建案；相似列僅列合併候選，不自行合併。未提供之未通過案件不編造。
import { SpecError } from './errors.js';
import { insert, setDedicated, find, must, list } from './model.js';
import { parseRuleText, validateRule } from './rules.js';
import { parseDate } from './values.js';
import { cellText, readHeaders } from './table.js';
import { createCase, createMeeting, addAgenda, addDecision, findMeeting } from './cases.js';
import { createRecognition, createRevision } from './recognition.js';
import { storeBlob, addAttachmentRecord } from './attachments.js';
import { sha256Bytes } from './util.js';

export const COLS = {
  seq: '調整時公告序號', cancel: '取消註記', group_code: '分組代碼', group_name: '分組名稱',
  group_item: '分組項目', ingredient: '成分/含量', dosage: '劑型', history: '討論歷程',
  price_history: '價格異動歷程', category: '類別', side_decision: '附帶決議', ann_name: '調整時公告名稱',
  rule: '篩選原則', review_10512: '原特殊品項_10512擬訂會議檢討結果', old_rule: '原篩選條件',
  eff_date: '特殊藥品生效日期', contract_codes: '有簽訂協議為不可替代必要/特殊(藥品代碼)',
};
// B16：歷史名稱為改名
const HIST_TO_STD = { 不可替代必要藥品: '不可替代特殊藥品', 必要藥品: '特殊藥品', 不可替代特殊藥品: '不可替代特殊藥品', 特殊藥品: '特殊藥品' };
const MEET_DATE = /(\d{2,3})年(\d{1,2})月(?:(\d{1,2})日)?/;
const CODE_RE = /\b[A-Z][A-Z0-9]\d{6,8}[0-9A-Z]{0,2}\b/g;

const norm = (h) => String(h ?? '').replace(/\s+/g, '');

function txt(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function matchCols(headers) {
  const idx = {};
  for (const [k, name] of Object.entries(COLS)) {
    const i = headers.findIndex((h) => norm(h).startsWith(norm(name)));
    if (i >= 0) idx[k] = i;
  }
  const missing = ['seq', 'group_code', 'category', 'rule'].filter((k) => idx[k] === undefined).map((k) => COLS[k]);
  if (missing.length) throw new SpecError('MIG_COLUMNS', '找不到必要欄位：' + missing.join('、') + '；請確認是 final 工作表');
  return idx;
}

// 回傳 {std, flags, issues}；混合文字須人工拆解
export function parseCategory(raw) {
  const flags = [];
  const issues = [];
  if (!raw) return { std: '待確認', flags, issues: ['類別空白'] };
  const t = raw.replace(/\n/g, '/');
  for (const m of t.matchAll(/(\d{2,3}\.\d{2}\.\d{2})藥價歸零/g)) flags.push(`藥價歸零 ${m[1]}`);
  if (t.includes('未簽約')) flags.push('未簽約');
  if (t.includes('取消') || t.includes('(刪)')) flags.push('取消候選');
  const base = t.replace(/\(.*?\)/g, '').replace(/^[\s/]+|[\s/]+$/g, '');
  const parts = base.split(/[/→]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) return { std: '待確認', flags, issues: [`類別含多個或變更文字「${raw}」，須人工拆解`] };
  if (!parts.length) return { std: '待確認', flags, issues: [`類別「${raw}」無法對應`] };
  if (parts[0].startsWith('取消')) return { std: '取消認定', flags, issues };
  if (/\(取消[^)]*\)/.test(t)) return { std: '待確認', flags, issues: [`類別「${raw}」含取消／改類文字，須人工拆解`] };
  const std = HIST_TO_STD[parts[0]];
  if (!std) return { std: '待確認', flags, issues: [`類別「${raw}」無法對應`] };
  return { std, flags, issues };
}

// 討論歷程拆成議案候選；每行一個，保留原文；日期只取有明確年月日者（不以年月補日）
export function parseMeetings(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    let ln = line.trim().replace(/[，,]$/, '').replace(/^\d+\.\s*/, '');
    if (!ln) continue;
    let type = '其他';
    if (ln.includes('藥事小組')) type = '藥事小組';
    else if (/擬訂|擬定|共擬/.test(ln)) type = '共同擬訂';
    else if (ln.includes('專家')) type = '專家';
    const m = MEET_DATE.exec(ln);
    const date = m && m[3] ? parseDate(`${m[1]}/${m[2]}/${m[3]}`) : null;
    out.push({ type, name: ln, date, original: line.trim() });
  }
  return out;
}

// 「同廠牌」條件【使用者 2026-11-07 確認，Q05】：同廠牌＝同申請商（統編）；原 SPSS「必要藥品_分組=0」為排除旗標。
// 1mg 列（本列分組＝原文分組）：同申請商另有同系列其他規格；其他規格列：同申請商有原文分組（1mg）品項（依附帶決議「同一廠商須同時生產1mg併其他高規格」）。
export function sameBrandRule(text, ownGroup, sideDecision) {
  const t = String(text || '').replace(/＝/g, '=').replace(/\s+/g, ' ');
  if (!t.includes('同廠牌') || !ownGroup) return null;
  const x = /分組代碼\s*=\s*([A-Z0-9]+)/.exec(t);
  const pre = /分組代碼前(\d+)碼\s*=\s*([A-Z0-9]+)/.exec(t);
  if (!x || !pre) return null;
  const neqs = [...t.matchAll(/分組代碼\s*<>\s*([A-Z0-9]+)/g)].map((m) => m[1]);
  const issues = ['「同廠牌」依使用者確認（Q05）改為「同申請商（統編）」條件，須匯入藥品許可證檔；原文「=0」為排除旗標'];
  let child;
  if (ownGroup === x[1]) {
    child = { op: 'and', children: [{ field: 'group_code', op: 'starts_with', value: pre[2] }, ...neqs.map((v) => ({ field: 'group_code', op: 'ne', value: v })), { field: 'group_code', op: 'ne', value: ownGroup }] };
  } else {
    child = { field: 'group_code', op: 'eq', value: x[1] };
    issues.push(`原文分組代碼 ${x[1]} 與本列分組 ${ownGroup} 不同（疑似複製上一列），規則改為本列分組且同申請商有 ${x[1]} 品項${sideDecision ? `（附帶決議：${sideDecision}）` : ''}，請預覽核對`);
  }
  const ast = { op: 'and', children: [{ field: 'group_code', op: 'eq', value: ownGroup }, { op: 'same_applicant', child }] };
  validateRule(ast);
  return { ast, issues };
}

export function parseRow(raw) {
  const issues = [];
  const p = {};
  for (const k of Object.keys(COLS)) p[k] = txt(raw[k]);
  const c = parseCategory(p.category);
  issues.push(...c.issues);
  p.category_std = c.std;
  p.category_flags = c.flags;
  const special = sameBrandRule(p.rule, p.group_code, p.side_decision);
  if (special) {
    p.rule_ast = special.ast;
    issues.push(...special.issues);
  } else {
    const r = parseRuleText(p.rule);
    p.rule_ast = r.ast;
    issues.push(...r.issues.map((x) => `篩選原則：${x}`));
  }
  if (p.eff_date) {
    p.eff_date_iso = parseDate(p.eff_date);
    if (!p.eff_date_iso) issues.push(`特殊藥品生效日期「${p.eff_date}」無法解析`);
  } else {
    p.eff_date_iso = null;
    issues.push('特殊藥品生效日期空白（未知，不以會議日補）');
  }
  p.meetings = parseMeetings(p.history);
  if (!p.meetings.length) issues.push('無可辨識的會議紀錄');
  for (const m of p.meetings) if (m.type === '其他') issues.push(`討論歷程「${m.name}」無法判斷會議類型`);
  p.contract_code_clues = [...new Set((p.contract_codes || '').match(CODE_RE) || [])].sort();
  if (p.contract_code_clues.length) issues.push('有協議藥品代碼線索，僅為合約關聯線索，不視為已核驗正式合約');
  if (p.cancel) issues.push('取消註記：建立取消候選版本，須補依據與日期');
  const whole = Object.values(raw).filter(Boolean).join(' ');
  p.not_recognized = /非認列|參考特殊藥品精神/.test(whole);
  if (p.not_recognized) issues.push('原文註明非認列（參考特殊藥品精神調高），保留價格案件及原文，不建立有效特殊身分');
  if (p.seq && /重複|包含在/.test(p.seq)) issues.push(`公告序號註記「${p.seq}」，可能與其他列重複，請核對`);
  if (p.group_item !== null) issues.push('分組項目意義未確認，僅保存原值');
  return { parsed: p, issues };
}

// ---------- 暫存（解析，不寫入） ----------
export async function readWorkbook(table, { sheet = 'final', name, bytes } = {}) {
  if (!table.sheets.includes(sheet)) throw new SpecError('MIG_SHEET', `找不到工作表「${sheet}」`);
  const headers = readHeaders(table, sheet, 1);
  const idx = matchCols(headers);
  const rows = [];
  for (const r of table.rows(sheet)) {
    if (r.rowNo === 1) continue;
    const raw = {};
    let any = false;
    for (const [k, i] of Object.entries(idx)) { const v = cellText(r.cells.get(i)); raw[k] = v; if (v !== null) any = true; }
    if (!any) continue;
    const { parsed, issues } = parseRow(raw);
    rows.push({ row_no: r.rowNo, raw, parsed, issues });
  }
  return { source_name: name, sha256: await sha256Bytes(bytes), sheet, rows, bytes };
}

// 寫入暫存區（session）；同來源同工作表同列不重複
export async function stageToSession(session, staged, { opId } = {}) {
  const st = await storeBlob(session.fs, staged.bytes);
  return session.run((d, ctx) => {
    let batch = list(d, 'migration_batch').find((b) => b.sha256 === staged.sha256 && b.sheet === staged.sheet);
    const first = !batch;
    if (!batch) batch = insert(d, ctx, 'migration_batch', { source_name: staged.source_name, sha256: staged.sha256, sheet: staged.sheet, row_count: staged.rows.length });
    const seen = new Set(list(d, 'migration_row').filter((r) => r.source_sha256 === staged.sha256 && r.sheet === staged.sheet).map((r) => r.row_no));
    let added = 0;
    for (const r of staged.rows) {
      if (seen.has(r.row_no)) continue;
      insert(d, ctx, 'migration_row', { batch_id: batch.id, source_sha256: staged.sha256, sheet: staged.sheet, row_no: r.row_no, raw: r.raw, parsed: r.parsed, issues: r.issues });
      added++;
    }
    if (first) addAttachmentRecord(d, ctx, { orig_name: staged.source_name, sha256: st.sha256, size: st.size, mime: null }, [{ entity: 'migration_batch', entity_id: batch.id }]);
    return { batch_id: batch.id, new: added, already_staged: staged.rows.length - added, total: staged.rows.length };
  }, { opId, kind: '移轉暫存', refs: [{ path: st.path, sha256: st.sha256, label: `移轉來源檔 ${staged.source_name}` }] });
}

export function listRows(data, { sha, status } = {}) {
  return list(data, 'migration_row').filter((r) => (!sha || r.source_sha256 === sha) && (!status || r.status === status))
    .sort((a, b) => (a.source_sha256 === b.source_sha256 ? a.row_no - b.row_no : a.source_sha256 < b.source_sha256 ? -1 : 1));
}

// 同公告序號、公告名稱或分組代碼之列，僅列合併候選
export function mergeCandidates(data, sha) {
  const groups = new Map();
  for (const r of listRows(data, { sha })) {
    for (const k of ['seq', 'ann_name', 'group_code']) {
      const v = r.parsed && r.parsed[k];
      if (!v) continue;
      const key = `${k}|${v}`;
      if (!groups.has(key)) groups.set(key, { key: COLS[k], value: v, rows: [] });
      groups.get(key).rows.push(r.row_no);
    }
  }
  return [...groups.values()].filter((g) => new Set(g.rows).size > 1);
}

// ---------- 寫入（使用者確認後） ----------
export function commitRow(data, ctx, rowId, { mergeIntoRecognitionId, ruleOverride } = {}) {
  const row = must(data, 'migration_row', rowId);
  if (row.status === '已寫入') throw new SpecError('ALREADY', `第${row.row_no}列已寫入（案件已建立），不重複建案`);
  if (row.status === '略過') throw new SpecError('SKIPPED', '此列已標示略過');
  const p = row.parsed;
  const batch = must(data, 'migration_batch', row.batch_id);
  const src = `${batch.source_name}#${row.sheet}!${row.row_no}（SHA-256 ${row.source_sha256.slice(0, 12)}）`;
  const title = p.ann_name || p.group_name || p.group_code || `第${row.row_no}列`;
  const notes = [];
  if (p.price_history) notes.push(`價格異動歷程（原文，待人工拆成決議／價格事件）：\n${p.price_history}`);
  if (p.contract_code_clues && p.contract_code_clues.length) notes.push('協議藥品代碼線索（未核驗）：' + p.contract_code_clues.join('、'));
  if (p.review_10512) notes.push(`原特殊品項_10512擬訂會議檢討結果（歷史證據）：${p.review_10512}`);
  if (p.group_item) notes.push(`分組項目原值：${p.group_item}`);
  if (p.not_recognized) notes.push('原文註明非認列（參考特殊藥品精神調高）');
  if (row.issues && row.issues.length) notes.push('移轉待確認：' + row.issues.join('；'));
  const result = { reused_meetings: 0 };
  const c = createCase(data, ctx, {
    subject: title, request_item: '特殊藥品認定／調高（歷史移轉）', case_no: `HIST-${row.source_sha256.slice(0, 6)}-${String(row.row_no).padStart(4, '0')}`,
    completeness: '不完整', pending_fields: 'recv_date,recv_doc_no,applicant', source_ref: src, notes: notes.join('\n\n'),
  });
  result.case_id = c.id;
  (p.meetings || []).forEach((m, i) => {
    // 同類型、同原文名稱、同日期之會議沿用（同次會議可處理多案）；其他不自動合併
    let mt = findMeeting(data, { meeting_type: m.type, name: m.name, meeting_date: m.date });
    if (mt) result.reused_meetings++;
    else mt = createMeeting(data, ctx, { meeting_type: m.type, name: m.name, meeting_date: m.date, notes: m.date ? '歷史移轉建立' : '歷史移轉建立；日期僅有年月或未知者留空待確認' });
    const ag = addAgenda(data, ctx, { meeting_id: mt.id, case_id: c.id, subject: title, original_text: m.original, discussion: `移轉候選議案（第${i + 1}次）；決議內容須由價格異動歷程人工拆解` });
    // 專家會議僅為專家建議（B14）
    addDecision(data, ctx, { agenda_id: ag.id, nature: m.type === '專家' ? '專家建議' : '會議決議', result: '待確認', result_text: '歷史移轉：結果待人工依原文確認' });
  });
  if (p.not_recognized) {
    result.recognition_id = null;
  } else if (p.category_std || p.rule_ast) {
    let recId = mergeIntoRecognitionId;
    if (recId) must(data, 'recognition', recId);
    else {
      const name = list(data, 'recognition').some((r) => r.name === title) ? `${title}（移轉第${row.row_no}列）` : title;
      recId = createRecognition(data, ctx, { name, description: `歷史移轉：${src}` }).id;
    }
    const rule = ruleOverride !== undefined ? ruleOverride : p.rule_ast;
    const scope = [p.rule && `篩選原則：${p.rule}`, p.old_rule && `原篩選條件（歷史）：${p.old_rule}`, p.group_code && `分組：${p.group_code} ${p.group_name || ''}`,
      p.ingredient && `成分/含量：${p.ingredient}`, p.dosage && `劑型：${p.dosage}`].filter(Boolean).join('；');
    const cat = p.category_std !== '取消認定' ? p.category_std : '待確認';
    const rev = createRevision(data, ctx, recId, {
      category: cat, original_category: p.category, scope_text: scope, rule: rule || null, conditions_text: p.side_decision,
      effective_from: p.eff_date_iso, case_id: c.id, completeness: '不完整',
    });
    result.recognition_id = recId;
    result.revision_id = rev.id;
    if (p.cancel || (p.category_flags || []).includes('取消候選')) {
      result.cancel_revision_id = createRevision(data, ctx, recId, { category: '取消認定', original_category: p.category, scope_text: '取消候選（歷史移轉）：須補依據與日期', case_id: c.id, completeness: '不完整' }).id;
    }
  }
  setDedicated(data, ctx, 'migration_row', rowId, { status: '已寫入', committed_case_id: c.id, committed_recognition_id: result.recognition_id || null, decided_by: ctx.actor, decided_at: ctx.now },
    { action: '移轉寫入', fields: ['status', 'committed_case_id', 'committed_recognition_id', 'decided_by', 'decided_at'] });
  return result;
}

export function skipRow(data, ctx, rowId, reason) {
  const row = must(data, 'migration_row', rowId);
  if (!txt(reason)) throw new SpecError('REQUIRED', '略過須填理由');
  if (row.status !== '待核對') throw new SpecError('BAD_STATE', '只有待核對列可略過');
  return setDedicated(data, ctx, 'migration_row', rowId, { status: '略過', decided_by: ctx.actor, decided_at: ctx.now }, { action: '移轉略過', reason: txt(reason), fields: ['status', 'decided_by', 'decided_at'] });
}

export function batchSummary(data, batchId) {
  const rows = list(data, 'migration_row').filter((r) => r.batch_id === batchId);
  const c = { 待核對: 0, 已寫入: 0, 略過: 0 };
  for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
  return { total: rows.length, ...c, issues: rows.filter((r) => r.issues && r.issues.length).length, batch: find(data, 'migration_batch', batchId) };
}
