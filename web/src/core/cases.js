// 基本收案、歷次會議、議案、決議及逐品項結果（第9.1節、P0）。
// 案件與認定分開；未通過案件也完整保存。專家建議與會議決議分開標示，不相互覆蓋（B12–B15）。
// 函式皆於 session.run() 之資料副本上執行：fn(data, ctx)。
import { SpecError } from './errors.js';
import { E, insert, update, setDedicated, find, must, list } from './model.js';
import { parseDate, normalizeCode } from './values.js';

export const APPROVING = ['同意', '附條件同意'];
const CASE_EDITABLE = ['subject', 'applicant', 'request_item', 'recv_date', 'recv_doc_no', 'unit', 'handler', 'status', 'completeness', 'pending_fields', 'notes', 'source_ref'];
const PENDING_LABELS = { recv_date: '收文日', recv_doc_no: '文號', applicant: '申請廠商' };

function txt(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// 日期欄：空白→null；無法解析→錯誤（未知請留空並標示待確認）
export function dateField(v, label) {
  const s = txt(v);
  if (!s) return null;
  const d = parseDate(s);
  if (!d) throw new SpecError('BAD_DATE', `${label}「${s}」無法解析；未知請留空並標示待確認`);
  return d;
}

function taipeiYear(iso) {
  return new Date(Date.parse(iso) + 8 * 3600 * 1000).getUTCFullYear();
}

export function nextCaseNo(data, ctx, prefix = 'SD') {
  const y = taipeiYear(ctx.now);
  const used = new Set(list(data, 'case_record').map((c) => c.case_no));
  let n = list(data, 'case_record').filter((c) => c.case_no.startsWith(`${prefix}${y}-`)).length;
  for (;;) {
    n += 1;
    const no = `${prefix}${y}-${String(n).padStart(4, '0')}`;
    if (!used.has(no)) return no;
  }
}

function missingFields(v) {
  return Object.keys(PENDING_LABELS).filter((k) => !v[k]);
}

export function createCase(data, ctx, input) {
  const subject = txt(input.subject);
  if (!subject) throw new SpecError('REQUIRED', '請輸入主旨');
  if (input.prior_case_id) must(data, 'case_record', input.prior_case_id);
  const v = {
    case_no: txt(input.case_no) || nextCaseNo(data, ctx),
    subject,
    applicant: txt(input.applicant),
    request_item: txt(input.request_item),
    recv_date: dateField(input.recv_date, '收文日'),
    recv_doc_no: txt(input.recv_doc_no),
    unit: txt(input.unit),
    handler: txt(input.handler),
    prior_case_id: input.prior_case_id || null,
    source_ref: txt(input.source_ref),
    notes: txt(input.notes),
  };
  if (input.status) {
    if (input.status === '已結案' || input.status === '撤回') throw new SpecError('BAD_VALUE', '結案或撤回請使用「結案」功能並記錄原因與依據');
    v.status = input.status;
  }
  const missing = missingFields(v);
  v.completeness = input.completeness || (missing.length ? '待確認' : '完整');
  v.pending_fields = txt(input.pending_fields) || (missing.length ? missing.join(',') : null);
  const rec = insert(data, ctx, 'case_record', v);
  for (const d of input.drugs || []) addCaseDrug(data, ctx, rec.id, typeof d === 'string' ? { drug_code: d } : d);
  return rec;
}

export function updateCase(data, ctx, caseId, changes, opts = {}) {
  const bad = Object.keys(changes).filter((k) => !CASE_EDITABLE.includes(k));
  if (bad.length) throw new SpecError('FIELD_NOT_ALLOWED', `案件不可直接修改：${bad.join('、')}`);
  const c = { ...changes };
  if (c.status === '已結案' || c.status === '撤回') throw new SpecError('BAD_VALUE', '結案或撤回請使用「結案」功能並記錄原因與依據');
  const cur = must(data, 'case_record', caseId);
  if (cur.status === '已結案' || cur.status === '撤回') {
    if (c.status !== undefined) throw new SpecError('CASE_CLOSED', '案件已結案／撤回；再提或重新開案請建立新案並連結前案');
  }
  if ('recv_date' in c) c.recv_date = dateField(c.recv_date, '收文日');
  for (const k of ['subject', 'applicant', 'request_item', 'recv_doc_no', 'unit', 'handler', 'pending_fields', 'notes', 'source_ref']) {
    if (k in c) c[k] = txt(c[k]);
  }
  return update(data, ctx, 'case_record', caseId, c, opts);
}

export function addCaseDrug(data, ctx, caseId, { drug_code, drug_name_text, role, note }) {
  must(data, 'case_record', caseId);
  const { code, error } = normalizeCode(drug_code);
  if (error) throw new SpecError('BAD_CODE', `藥品代碼錯誤：${error}`);
  if (list(data, 'case_drug').some((r) => r.case_id === caseId && r.drug_code === code)) {
    throw new SpecError('DUPLICATE', `案件已有品項 ${code}`);
  }
  return insert(data, ctx, 'case_drug', { case_id: caseId, drug_code: code, drug_name_text: txt(drug_name_text), role: txt(role) || '申請品項', note: txt(note) });
}

export function findMeeting(data, { meeting_type, name, meeting_date }) {
  return list(data, 'meeting').find((m) => m.meeting_type === meeting_type && m.name === txt(name) && (m.meeting_date || null) === (meeting_date || null)) || null;
}

// 同類型、同名、同日之會議已存在時拒絕，避免每案重複登打（同會議資料共用）
export function createMeeting(data, ctx, { meeting_type, name, meeting_date, session_no, notes }) {
  if (!E.MEETING_TYPE.includes(meeting_type)) throw new SpecError('BAD_VALUE', '會議類型須為：' + E.MEETING_TYPE.join('／'));
  const n = txt(name);
  if (!n) throw new SpecError('REQUIRED', '請輸入會議正式名稱');
  const date = dateField(meeting_date, '會議日期');
  const dup = findMeeting(data, { meeting_type, name: n, meeting_date: date });
  if (dup) throw new SpecError('DUPLICATE', `已有同一會議（${dup.name}${dup.meeting_date ? '，' + dup.meeting_date : ''}），請直接選用`, { id: dup.id });
  return insert(data, ctx, 'meeting', { meeting_type, name: n, meeting_date: date, session_no: txt(session_no), notes: txt(notes) });
}

export function updateMeeting(data, ctx, id, changes, opts = {}) {
  const allowed = ['name', 'meeting_date', 'session_no', 'notes'];
  const bad = Object.keys(changes).filter((k) => !allowed.includes(k));
  if (bad.length) throw new SpecError('FIELD_NOT_ALLOWED', `會議不可直接修改：${bad.join('、')}`);
  const c = { ...changes };
  if ('meeting_date' in c) c.meeting_date = dateField(c.meeting_date, '會議日期');
  if ('name' in c) { c.name = txt(c.name); if (!c.name) throw new SpecError('REQUIRED', '請輸入會議正式名稱'); }
  return update(data, ctx, 'meeting', id, c, opts);
}

// 同案重提新增議案紀錄，不覆蓋前次；以明確關聯連結案件
export function addAgenda(data, ctx, { meeting_id, case_id, agenda_no, subject, proposal, discussion, original_text }) {
  must(data, 'meeting', meeting_id);
  must(data, 'case_record', case_id);
  return insert(data, ctx, 'meeting_agenda', {
    meeting_id, case_id, agenda_no: txt(agenda_no), subject: txt(subject), proposal: txt(proposal),
    discussion: txt(discussion), original_text: txt(original_text),
  });
}

export function updateAgenda(data, ctx, id, changes, opts = {}) {
  const allowed = ['agenda_no', 'subject', 'proposal', 'discussion', 'original_text'];
  const bad = Object.keys(changes).filter((k) => !allowed.includes(k));
  if (bad.length) throw new SpecError('FIELD_NOT_ALLOWED', `議案不可直接修改：${bad.join('、')}`);
  return update(data, ctx, 'meeting_agenda', id, changes, opts);
}

function agendaCaseId(data, decisionId) {
  const dec = must(data, 'decision', decisionId);
  return must(data, 'meeting_agenda', dec.agenda_id).case_id;
}

// drugResults：{case_drug_id: 結果 或 {result, conditions, note}}；未列入者不推定
export function addDecision(data, ctx, input) {
  const { agenda_id, nature, result } = input;
  must(data, 'meeting_agenda', agenda_id);
  if (!E.NATURE.includes(nature)) throw new SpecError('BAD_VALUE', '結果性質須為「專家建議」或「會議決議」');
  if (!E.RESULT.includes(result)) throw new SpecError('BAD_VALUE', '結果不正確');
  if (result === '其他' && !txt(input.result_text)) throw new SpecError('REQUIRED', '結果為「其他」時須填結果原文說明');
  if (input.supersedes_id) {
    if (!txt(input.correction_reason)) throw new SpecError('REQUIRED', '更正或取代既有決議須填寫原因');
    const old = must(data, 'decision', input.supersedes_id);
    if (old.agenda_id !== agenda_id) throw new SpecError('BAD_REF', '更正之決議須屬同一議案');
    if (list(data, 'decision').some((d) => d.supersedes_id === old.id)) throw new SpecError('DUPLICATE', '此決議已被更正，請更正最新一筆');
  }
  const dec = insert(data, ctx, 'decision', {
    agenda_id, nature, result, result_text: txt(input.result_text), conditions: txt(input.conditions),
    approval_doc_no: txt(input.approval_doc_no), approval_date: dateField(input.approval_date, '核定日期'),
    supersedes_id: input.supersedes_id || null, correction_reason: txt(input.correction_reason),
  }, { action: input.supersedes_id ? '更正決議' : '新增' });
  for (const [cdId, val] of Object.entries(input.drugResults || {})) {
    const v = typeof val === 'string' ? { result: val } : val;
    setDecisionDrug(data, ctx, dec.id, cdId, v);
  }
  return dec;
}

// 逐品項結果；同決議同品項再登錄即修改（Q10暫採：修改留稽核前後差異）
export function setDecisionDrug(data, ctx, decisionId, caseDrugId, { result, conditions, note }, opts = {}) {
  if (!E.RESULT.includes(result)) throw new SpecError('BAD_VALUE', '品項結果不正確');
  if (result === '其他' && !txt(note) && !txt(conditions)) throw new SpecError('REQUIRED', '品項結果為「其他」時須說明');
  const cd = must(data, 'case_drug', caseDrugId);
  if (agendaCaseId(data, decisionId) !== cd.case_id) throw new SpecError('BAD_REF', '品項不屬於此議案的案件，不能串接');
  const exist = list(data, 'decision_drug').find((r) => r.decision_id === decisionId && r.case_drug_id === caseDrugId);
  const note2 = txt(note) || (result === '其他' ? txt(conditions) : null);
  if (exist) return update(data, ctx, 'decision_drug', exist.id, { result, conditions: txt(conditions), note: note2 }, opts);
  return insert(data, ctx, 'decision_drug', { decision_id: decisionId, case_drug_id: caseDrugId, result, conditions: txt(conditions), note: note2 });
}

// 結果摘要：須連結形成摘要的決議，由承辦確認；不以最後一次會議日期自動認定
export function setCaseSummary(data, ctx, caseId, { summary, decisionIds = [], note, reason }) {
  const c = must(data, 'case_record', caseId);
  if (!E.SUMMARY.includes(summary)) throw new SpecError('BAD_VALUE', '結果摘要不正確');
  if (summary !== '尚無結論' && !decisionIds.length) throw new SpecError('REQUIRED', '結果摘要須連結至少一項會議決議或專家建議作為依據');
  if (summary === '其他' && !txt(note)) throw new SpecError('REQUIRED', '摘要為「其他」時須說明');
  for (const id of decisionIds) {
    if (agendaCaseId(data, id) !== caseId) throw new SpecError('BAD_REF', '所選決議不屬於此案件');
  }
  return setDedicated(data, ctx, 'case_record', c.id, {
    result_summary: summary, result_decision_ids: decisionIds.length ? [...decisionIds] : null, result_summary_note: txt(note),
    result_confirmed_by: ctx.actor, result_confirmed_at: ctx.now,
  }, { action: '確認結果摘要', reason, fields: ['result_summary', 'result_decision_ids', 'result_summary_note', 'result_confirmed_by', 'result_confirmed_at'] });
}

export function closeCase(data, ctx, caseId, { status, reason, basis }) {
  const c = must(data, 'case_record', caseId);
  if (status !== '已結案' && status !== '撤回') throw new SpecError('BAD_VALUE', '結案狀態須為「已結案」或「撤回」');
  if (!txt(reason) || !txt(basis)) throw new SpecError('REQUIRED', '結案須記錄原因與依據');
  if (c.status === '已結案' || c.status === '撤回') throw new SpecError('CASE_CLOSED', '案件已結案／撤回');
  return setDedicated(data, ctx, 'case_record', caseId, { status, close_reason: txt(reason), close_basis: txt(basis) },
    { action: status === '撤回' ? '撤回案件' : '結案', reason: txt(reason), fields: ['status', 'close_reason', 'close_basis'] });
}

// 再提或重新開案：新建案件並保留與前案關聯；品項沿用前案（可另增減）
export function reopenAsNew(data, ctx, priorCaseId, input = {}) {
  const prior = must(data, 'case_record', priorCaseId);
  const drugs = input.drugs || list(data, 'case_drug').filter((d) => d.case_id === prior.id)
    .map((d) => ({ drug_code: d.drug_code, drug_name_text: d.drug_name_text, role: d.role }));
  return createCase(data, ctx, {
    subject: prior.subject, applicant: prior.applicant, request_item: prior.request_item, unit: prior.unit, handler: prior.handler,
    ...input, drugs, prior_case_id: prior.id,
  });
}

// ---------- 查詢（唯讀） ----------

function meetingOf(data, agenda) {
  return find(data, 'meeting', agenda.meeting_id) || {};
}

// 依序列出各次會議、議案、決議及逐品項結果；日期未知者排最後
export function caseTimeline(data, caseId) {
  const agendas = list(data, 'meeting_agenda').filter((a) => a.case_id === caseId).map((a) => {
    const m = meetingOf(data, a);
    const decisions = list(data, 'decision').filter((d) => d.agenda_id === a.id)
      .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0))
      .map((d) => ({
        ...d,
        superseded: list(data, 'decision').some((z) => z.supersedes_id === d.id),
        drugs: list(data, 'decision_drug').filter((r) => r.decision_id === d.id).map((r) => ({
          ...r, drug_code: (find(data, 'case_drug', r.case_drug_id) || {}).drug_code,
        })).sort((p, q) => (p.drug_code < q.drug_code ? -1 : 1)),
      }));
    return { ...a, meeting_type: m.meeting_type, meeting_name: m.name, meeting_date: m.meeting_date || null, session_no: m.session_no, decisions };
  });
  agendas.sort((a, b) => {
    if (!a.meeting_date !== !b.meeting_date) return a.meeting_date ? -1 : 1;
    if (a.meeting_date !== b.meeting_date) return a.meeting_date < b.meeting_date ? -1 : 1;
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
  return agendas;
}

// 可接續認定／調高之依據：未被更正之「會議決議」中，該品項為同意或附條件同意者（專家建議不當最終通過）
export function drugFollowupBasis(data, caseId, drugCode) {
  const out = [];
  for (const a of caseTimeline(data, caseId)) {
    for (const d of a.decisions) {
      if (d.nature !== '會議決議' || d.superseded) continue;
      for (const r of d.drugs) {
        if (r.drug_code === drugCode && APPROVING.includes(r.result)) {
          out.push({ decision_id: d.id, result: r.result, conditions: r.conditions, meeting_name: a.meeting_name, meeting_date: a.meeting_date });
        }
      }
    }
  }
  return out;
}

export function caseDrugs(data, caseId) {
  return list(data, 'case_drug').filter((d) => d.case_id === caseId).sort((a, b) => (a.drug_code < b.drug_code ? -1 : 1));
}

export function listCases(data, { keyword, status, summary, completeness } = {}) {
  const kw = txt(keyword);
  const drugsBy = new Map();
  for (const d of list(data, 'case_drug')) {
    if (!drugsBy.has(d.case_id)) drugsBy.set(d.case_id, []);
    drugsBy.get(d.case_id).push(d.drug_code);
  }
  return list(data, 'case_record').filter((c) => {
    if (status && c.status !== status) return false;
    if (summary && c.result_summary !== summary) return false;
    if (completeness && c.completeness !== completeness) return false;
    if (kw) {
      const hay = [c.case_no, c.subject, c.applicant, c.recv_doc_no, ...(drugsBy.get(c.id) || [])].filter(Boolean).join(' ');
      if (!hay.includes(kw)) return false;
    }
    return true;
  }).map((c) => ({ ...c, drugs: (drugsBy.get(c.id) || []).sort() })).sort((a, b) => {
    if (!a.recv_date !== !b.recv_date) return a.recv_date ? -1 : 1;
    if (a.recv_date !== b.recv_date) return a.recv_date < b.recv_date ? 1 : -1;
    return a.case_no < b.case_no ? 1 : -1;
  });
}

export function listMeetings(data, { keyword } = {}) {
  const kw = txt(keyword);
  const counts = new Map();
  for (const a of list(data, 'meeting_agenda')) counts.set(a.meeting_id, (counts.get(a.meeting_id) || 0) + 1);
  return list(data, 'meeting').filter((m) => !kw || [m.name, m.session_no].filter(Boolean).join(' ').includes(kw))
    .map((m) => ({ ...m, agenda_count: counts.get(m.id) || 0 }))
    .sort((a, b) => {
      if (!a.meeting_date !== !b.meeting_date) return a.meeting_date ? -1 : 1;
      return a.meeting_date === b.meeting_date ? 0 : a.meeting_date < b.meeting_date ? 1 : -1;
    });
}

export function meetingAgendas(data, meetingId) {
  return list(data, 'meeting_agenda').filter((a) => a.meeting_id === meetingId).map((a) => ({
    ...a, case_no: (find(data, 'case_record', a.case_id) || {}).case_no, case_subject: (find(data, 'case_record', a.case_id) || {}).subject,
  })).sort((a, b) => String(a.agenda_no || '').localeCompare(String(b.agenda_no || ''), 'zh-Hant', { numeric: true }));
}
