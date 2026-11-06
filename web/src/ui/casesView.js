// 案件清單、案件詳情／會議時間序列、會議清單（第10節）。只呼叫業務模組函式改資料。
import { h, table, dialog } from './dom.js';
import { formDialog, opts } from './forms.js';
import * as C from '../core/cases.js';
import { E, find } from '../core/model.js';
import { rocDisplay } from '../core/values.js';
import { newId } from '../core/util.js';

const PAGE = 100;
const RESULT_OPTS = opts(E.RESULT);

function dateText(iso) {
  return iso ? `${iso}（${rocDisplay(iso)}）` : '（未知）';
}

function natureBadge(nature, superseded) {
  return h('span', { class: 'badge ' + (superseded ? 'badge-old' : nature === '專家建議' ? 'badge-expert' : 'badge-joint'),
    text: (superseded ? '已更正｜' : '') + nature });
}

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', null, v instanceof Node ? v : (v === null || v === undefined || v === '' ? '—' : String(v)))]));
}

export function casesTab(env) {
  const { s, ui } = env;
  ui.cases = ui.cases || { filters: {}, page: 0, selected: null };
  return ui.cases.selected ? caseDetail(env, ui.cases.selected) : caseList(env);
}

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

// ---------- 案件清單 ----------
function caseList(env) {
  const { s, ui, btn, guard, render } = env;
  const st = ui.cases;
  const f = st.filters;
  const kw = h('input', { type: 'text', size: 18, value: f.keyword || '', placeholder: '案號、主旨、廠商、文號、藥品代碼', 'aria-label': '關鍵字' });
  const sel = (key, label, list) => h('label', null, label + ' ', h('select', { 'aria-label': label, on: { change: (e) => { f[key] = e.target.value || null; st.page = 0; render(); } } },
    h('option', { value: '', text: '全部' }), list.map((x) => h('option', { value: x, text: x, selected: f[key] === x }))));
  const rows = C.listCases(data(env), f);
  const pageRows = rows.slice(st.page * PAGE, (st.page + 1) * PAGE);
  const box = h('section', { class: 'panel' },
    h('h2', { text: '案件清單' }),
    h('div', { class: 'filters' },
      h('label', null, '關鍵字 ', kw), btn('查詢', () => { f.keyword = kw.value.trim() || null; st.page = 0; render(); }),
      sel('status', '處理狀態', E.CASE_STATUS), sel('summary', '結果摘要', E.SUMMARY), sel('completeness', '完整性', E.COMPLETENESS),
      btn('清除條件', () => { st.filters = {}; st.page = 0; render(); })),
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('新增案件', () => guard(() => newCase(env)), { primary: true })) : null,
    h('p', { class: 'note', text: `共 ${rows.length} 筆；未通過、撤回、辦理中案件一併列出。點選列開啟詳情。` }));
  const t = table(['案號', '收文日', '文號', '主旨', '申請廠商', '品項', '承辦', '處理狀態', '結果摘要', '完整性'], []);
  const tbody = t.querySelector('tbody');
  for (const c of pageRows) {
    const tr = h('tr', { class: 'clickable', tabindex: '0', on: {
      click: () => { st.selected = c.id; render(); },
      keydown: (e) => { if (e.key === 'Enter') { st.selected = c.id; render(); } },
    } }, [c.case_no, c.recv_date || '', c.recv_doc_no || '', c.subject, c.applicant || '', c.drugs.join('、'), c.handler || '', c.status, c.result_summary, c.completeness]
      .map((x) => h('td', { text: x })));
    tbody.appendChild(tr);
  }
  box.appendChild(t);
  if (rows.length > PAGE) {
    const pages = Math.ceil(rows.length / PAGE);
    box.appendChild(h('div', { class: 'pager' },
      btn('上一頁', () => { st.page -= 1; render(); }, { disabled: st.page === 0 }),
      h('span', { text: `第 ${st.page + 1}／${pages} 頁` }),
      btn('下一頁', () => { st.page += 1; render(); }, { disabled: st.page >= pages - 1 })));
  }
  return box;
}

function caseFields(c = {}) {
  return [
    { key: 'subject', label: '主旨', required: true, value: c.subject },
    { key: 'applicant', label: '申請廠商', value: c.applicant },
    { key: 'request_item', label: '申請事項', value: c.request_item },
    { key: 'recv_date', label: '收文日', type: 'date', value: c.recv_date },
    { key: 'recv_doc_no', label: '收文文號', value: c.recv_doc_no },
    { key: 'unit', label: '承辦單位', type: 'select', options: [['', '（未填）'], ['核價', '核價'], ['調價', '調價'], ['其他', '其他']], value: c.unit || '' },
    { key: 'handler', label: '承辦人員', value: c.handler },
    { key: 'notes', label: '備註', type: 'textarea', value: c.notes },
  ];
}

async function newCase(env) {
  const v = await formDialog('新增案件', [
    ...caseFields(),
    { key: 'drugs', label: '品項（藥品代碼）', type: 'textarea', hint: '一行一個或以逗號、空白分隔；代碼原樣保存，不補零' },
    { key: 'case_no', label: '案號', hint: '空白則自動編號（SD西元年-流水號）' },
    { type: 'note', label: '歷史補登時，未知的收文日、文號、廠商請留空，系統標示「待確認」，不以會議日補填。' },
  ], { okLabel: '建立' });
  if (!v) return;
  const drugs = (v.drugs || '').split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean);
  const rec = await env.s.run((d, k) => C.createCase(d, k, { ...v, drugs }));
  env.ui.cases.selected = rec.id;
}

// ---------- 案件詳情 ----------
function caseDetail(env, caseId) {
  const { s, ui, btn, guard, render } = env;
  const d = data(env);
  const c = find(d, 'case_record', caseId);
  if (!c) { ui.cases.selected = null; return caseList(env); }
  const editing = s.mode === 'edit';
  const closed = c.status === '已結案' || c.status === '撤回';
  const drugs = C.caseDrugs(d, c.id);
  const prior = c.prior_case_id ? find(d, 'case_record', c.prior_case_id) : null;
  const later = d.collections.case_record.filter((x) => x.prior_case_id === c.id);
  const summaryDecs = (c.result_decision_ids || []).map((id) => find(d, 'decision', id)).filter(Boolean);

  const info = h('section', { class: 'panel' },
    h('div', { class: 'toolbar' }, btn('← 回案件清單', () => { ui.cases.selected = null; render(); })),
    h('h2', { text: `案件 ${c.case_no}：${c.subject}` }),
    c.completeness !== '完整' ? h('p', { class: 'warn-text', text: `資料完整性：${c.completeness}${c.pending_fields ? `（待補：${c.pending_fields}）` : ''}` }) : null,
    kv([
      ['收文日', dateText(c.recv_date)], ['收文文號', c.recv_doc_no], ['申請廠商', c.applicant], ['申請事項', c.request_item],
      ['承辦', [c.unit, c.handler].filter(Boolean).join('／')], ['處理狀態', c.status],
      ['結果摘要', `${c.result_summary}${c.result_summary_note ? `（${c.result_summary_note}）` : ''}`],
      ['摘要依據', summaryDecs.length ? summaryDecs.map((x) => `${x.nature}：${x.result}`).join('；') : null],
      ['摘要確認', c.result_confirmed_by ? `${c.result_confirmed_by}，${c.result_confirmed_at}` : null],
      ['結案', closed ? `${c.status}：${c.close_reason}（依據：${c.close_basis}）` : null],
      ['前案', prior ? h('a', { href: '#', text: `${prior.case_no} ${prior.subject}`, on: { click: (e) => { e.preventDefault(); ui.cases.selected = prior.id; render(); } } }) : null],
      ['後續再提', later.length ? h('span', null, later.map((x) => h('a', { href: '#', text: `${x.case_no} `, on: { click: (e) => { e.preventDefault(); ui.cases.selected = x.id; render(); } } }))) : null],
      ['來源', c.source_ref], ['備註', c.notes],
      ['建立／更新', `${c.created_by}，${c.created_at}／${c.updated_by}，${c.updated_at}（第${c.row_version}版）`],
    ]),
    editing ? h('div', { class: 'toolbar' },
      btn('修改基本資料', () => guard(() => editCase(env, c))),
      btn('確認結果摘要', () => guard(() => confirmSummary(env, c))),
      closed ? null : btn('結案／撤回', () => guard(() => closeCaseUI(env, c))),
      closed ? btn('再提（開新案並連結前案）', () => guard(() => reopenUI(env, c))) : null) : null);

  const drugBox = h('section', { class: 'panel' }, h('h3', { text: '申請品項' }),
    table(['藥品代碼', '品名（原文）', '角色', '可接續之會議決議（同意／附條件同意）'], drugs.map((x) => {
      const basis = C.drugFollowupBasis(d, c.id, x.drug_code);
      return [x.drug_code, x.drug_name_text || '', x.role || '', basis.length ? basis.map((b) => `${b.meeting_name}：${b.result}`).join('；') : '無'];
    })),
    editing && !closed ? h('div', { class: 'toolbar' }, btn('新增品項', () => guard(() => addDrugUI(env, c)))) : null);

  const tl = C.caseTimeline(d, c.id);
  const tlBox = h('section', { class: 'panel' }, h('h3', { text: '會議時間序列' }),
    h('p', { class: 'note', text: '專家建議與共同擬訂會議決議分別標示；同案重提為新議案，不覆蓋前次。未列入某次討論的品項不推定結果。' }),
    tl.length ? null : h('p', { text: '尚無會議紀錄。' }),
    h('div', { class: 'timeline' }, tl.map((a) => h('div', { class: 'tl-item' },
      h('h4', { text: `${a.meeting_date ? `${a.meeting_date}（${rocDisplay(a.meeting_date)}）` : '日期未知'}｜${a.meeting_type}｜${a.meeting_name}${a.session_no ? `（${a.session_no}）` : ''}` }),
      h('p', { text: `議案 ${a.agenda_no || '—'}：${a.subject || ''}` }),
      a.proposal ? h('p', { class: 'note', text: '提案資料：' + a.proposal }) : null,
      a.discussion ? h('p', { class: 'note', text: '討論摘要：' + a.discussion }) : null,
      a.original_text ? h('p', { class: 'note', text: '原文紀錄：' + a.original_text }) : null,
      a.decisions.map((dec) => h('div', { class: 'decision' },
        h('p', null, natureBadge(dec.nature, dec.superseded), h('strong', { text: dec.result }),
          dec.result_text ? '：' + dec.result_text : '', dec.conditions ? `（條件：${dec.conditions}）` : '',
          dec.approval_doc_no ? `｜核定文號 ${dec.approval_doc_no}` : '', dec.approval_date ? `｜核定日 ${dec.approval_date}` : '',
          dec.correction_reason ? `｜更正原因：${dec.correction_reason}` : ''),
        dec.drugs.length ? table(['藥品代碼', '品項結果', '條件', '說明', ''], dec.drugs.map((r) => [r.drug_code, r.result, r.conditions || '', r.note || '',
          editing && !dec.superseded ? btn('修改', () => guard(() => editDrugResult(env, dec, r))) : ''])) : h('p', { class: 'note', text: '未登錄逐品項結果。' }),
        editing && !dec.superseded ? h('div', { class: 'toolbar' },
          btn('補登品項結果', () => guard(() => addDrugResults(env, c, dec))),
          btn('更正此決議', () => guard(() => correctDecision(env, c, a, dec)))) : null)),
      editing ? h('div', { class: 'toolbar' }, btn('新增決議／建議', () => guard(() => newDecision(env, c, a)))) : null))),
    editing ? h('div', { class: 'toolbar' }, btn('新增議案（選會議）', () => guard(() => newAgenda(env, c)), { primary: true })) : null);
  return [info, drugBox, tlBox];
}

async function editCase(env, c) {
  const fields = [...caseFields(c),
    { key: 'status', label: '處理狀態', type: 'select', options: opts(E.CASE_STATUS.filter((x) => x !== '已結案' && x !== '撤回')), value: c.status },
    { key: 'completeness', label: '完整性', type: 'select', options: opts(E.COMPLETENESS), value: c.completeness },
    { key: 'pending_fields', label: '待補欄位', value: c.pending_fields },
    { key: 'reason', label: '修改原因' }];
  if (c.status === '已結案' || c.status === '撤回') fields.splice(fields.findIndex((x) => x.key === 'status'), 1);
  const v = await formDialog('修改案件基本資料', fields);
  if (!v) return;
  const { reason, ...changes } = v;
  if (!changes.unit) changes.unit = null;
  await env.s.run((d, k) => C.updateCase(d, k, c.id, changes, { expectedVersion: c.row_version, reason }));
}

async function addDrugUI(env, c) {
  const v = await formDialog('新增品項', [
    { key: 'drug_code', label: '藥品代碼', required: true, hint: '原樣保存，不補零、不改O/0' },
    { key: 'drug_name_text', label: '品名（原文）' }, { key: 'role', label: '角色', value: '申請品項' }, { key: 'note', label: '備註' }]);
  if (!v) return;
  await env.s.run((d, k) => C.addCaseDrug(d, k, c.id, v));
}

async function pickMeeting(env) {
  const d = data(env);
  const ms = C.listMeetings(d);
  const v = await formDialog('選擇會議', [
    { key: 'meeting_id', label: '既有會議', type: 'select', options: [['', '（新增會議）'], ...ms.map((m) => [m.id, `${m.meeting_date || '日期未知'}｜${m.meeting_type}｜${m.name}`])] },
    { type: 'note', label: '同次會議處理多案時請選用既有會議，避免重複登打；選「新增會議」則下一步填寫會議資料。' },
  ], { okLabel: '下一步' });
  if (!v) return null;
  if (v.meeting_id) return v.meeting_id;
  return newMeetingUI(env);
}

async function newMeetingUI(env) {
  const v = await formDialog('新增會議', [
    { key: 'meeting_type', label: '會議類型', type: 'select', options: opts(E.MEETING_TYPE), required: true, hint: '二代健保實施前多為藥事小組，實施後為共同擬訂會議' },
    { key: 'name', label: '正式名稱', required: true }, { key: 'meeting_date', label: '會議日期', type: 'date', hint: '只知年月者請留空並於備註記載，不補日' },
    { key: 'session_no', label: '次別' }, { key: 'notes', label: '備註', type: 'textarea' }]);
  if (!v) return null;
  const m = await env.s.run((d, k) => C.createMeeting(d, k, v));
  return m.id;
}

async function newAgenda(env, c) {
  const mid = await pickMeeting(env);
  if (!mid) return;
  const v = await formDialog('新增議案', [
    { key: 'agenda_no', label: '案次' }, { key: 'subject', label: '提案主旨', value: c.subject },
    { key: 'proposal', label: '提案資料', type: 'textarea' }, { key: 'discussion', label: '討論摘要', type: 'textarea' },
    { key: 'original_text', label: '原文紀錄', type: 'textarea' }]);
  if (!v) return;
  await env.s.run((d, k) => C.addAgenda(d, k, { ...v, meeting_id: mid, case_id: c.id }));
}

function drugResultFields(drugs, current = {}) {
  return drugs.map((x) => ({ key: 'dr_' + x.id, label: `品項 ${x.drug_code}`, type: 'select', options: [['', '（未列入本次討論）'], ...RESULT_OPTS], value: current[x.id] || '' }));
}

function collectDrugResults(v, drugs) {
  const out = {};
  for (const x of drugs) if (v['dr_' + x.id]) out[x.id] = v['dr_' + x.id];
  return out;
}

async function newDecision(env, c, a, base) {
  const d = data(env);
  const drugs = C.caseDrugs(d, c.id);
  const meeting = find(d, 'meeting', a.meeting_id) || {};
  const defNature = meeting.meeting_type === '專家' ? '專家建議' : '會議決議';
  const fields = [
    { key: 'nature', label: '結果性質', type: 'select', options: opts(E.NATURE), value: base ? base.nature : defNature, required: true },
    { key: 'result', label: '結果', type: 'select', options: RESULT_OPTS, value: base ? base.result : '待確認', required: true },
    { key: 'result_text', label: '結果原文', type: 'textarea', value: base && base.result_text, hint: '結果為「其他」時必填' },
    { key: 'conditions', label: '附帶條件', type: 'textarea', value: base && base.conditions, hint: '附條件同意者，條件內容保存於此（B19：系統不另設達成檢核）' },
    { key: 'approval_doc_no', label: '核定文號', value: base && base.approval_doc_no }, { key: 'approval_date', label: '核定日期', type: 'date', value: base && base.approval_date },
    ...drugResultFields(drugs),
  ];
  if (base) fields.unshift({ key: 'correction_reason', label: '更正原因', required: true });
  const v = await formDialog(base ? '更正決議（新增取代紀錄，原決議保留）' : '新增決議／建議', fields, {
    validate: (x) => (x.result === '其他' && !x.result_text ? '結果為「其他」時須填結果原文' : null),
  });
  if (!v) return;
  const drugResults = collectDrugResults(v, drugs);
  await env.s.run((dd, k) => C.addDecision(dd, k, {
    agenda_id: a.id, nature: v.nature, result: v.result, result_text: v.result_text, conditions: v.conditions,
    approval_doc_no: v.approval_doc_no, approval_date: v.approval_date, drugResults,
    supersedes_id: base ? base.id : null, correction_reason: base ? v.correction_reason : null,
  }));
}

async function correctDecision(env, c, a, dec) {
  await newDecision(env, c, a, dec);
}

async function addDrugResults(env, c, dec) {
  const d = data(env);
  const drugs = C.caseDrugs(d, c.id);
  const cur = Object.fromEntries(dec.drugs.map((r) => [r.case_drug_id, r.result]));
  const v = await formDialog('登錄逐品項結果', [...drugResultFields(drugs, cur), { key: 'reason', label: '修改原因', hint: '修改既有結果時請填' }]);
  if (!v) return;
  const res = collectDrugResults(v, drugs);
  await env.s.run((dd, k) => {
    for (const [cdId, result] of Object.entries(res)) {
      if (cur[cdId] === result) continue;
      C.setDecisionDrug(dd, k, dec.id, cdId, { result }, { reason: v.reason });
    }
  });
}

async function editDrugResult(env, dec, r) {
  const v = await formDialog(`修改品項 ${r.drug_code} 結果`, [
    { key: 'result', label: '結果', type: 'select', options: RESULT_OPTS, value: r.result, required: true },
    { key: 'conditions', label: '條件', type: 'textarea', value: r.conditions }, { key: 'note', label: '說明', type: 'textarea', value: r.note },
    { key: 'reason', label: '修改原因', required: true },
    { type: 'note', label: 'Q10暫採：逐品項結果可修改，稽核保留修改前後內容。' }]);
  if (!v) return;
  await env.s.run((dd, k) => C.setDecisionDrug(dd, k, dec.id, r.case_drug_id, v, { expectedVersion: r.row_version, reason: v.reason }));
}

async function confirmSummary(env, c) {
  const d = data(env);
  const opId = newId();
  const decs = C.caseTimeline(d, c.id).flatMap((a) => a.decisions.filter((x) => !x.superseded).map((x) => [x.id, `${a.meeting_date || '日期未知'}｜${a.meeting_name}｜${x.nature}：${x.result}`]));
  const v = await formDialog('確認結果摘要', [
    { key: 'summary', label: '結果摘要', type: 'select', options: opts(E.SUMMARY), value: c.result_summary, required: true },
    { key: 'decisionIds', label: '形成摘要之決議', type: 'checks', options: decs, value: c.result_decision_ids || [] },
    { key: 'note', label: '說明', type: 'textarea', value: c.result_summary_note, hint: '摘要為「其他」時必填' },
    { type: 'note', label: '須連結形成摘要的會議決議或專家建議，由承辦確認；系統不以最後一次會議自動認定。專家建議同意不等於最終通過。' },
  ], { okLabel: '下一步', validate: (x) => (x.summary !== '尚無結論' && !x.decisionIds.length ? '請勾選至少一項決議作為依據' : x.summary === '其他' && !x.note ? '摘要為「其他」時須說明' : null) });
  if (!v) return;
  const ok = await dialog('確認', [h('p', { text: `將案件 ${c.case_no} 結果摘要確認為「${v.summary}」，依據 ${v.decisionIds.length} 項決議，確認者 ${env.s.session.user}。` })],
    [{ label: '取消', value: null }, { label: '確認', value: true, primary: true }]);
  if (!ok) return;
  await env.s.run((dd, k) => { C.setCaseSummary(dd, k, c.id, v); return { case_id: c.id }; }, { opId, kind: '確認結果摘要' });
}

async function closeCaseUI(env, c) {
  const opId = newId();
  const v = await formDialog('結案／撤回', [
    { key: 'status', label: '狀態', type: 'select', options: [['已結案', '已結案'], ['撤回', '撤回']], required: true },
    { key: 'reason', label: '原因', type: 'textarea', required: true }, { key: 'basis', label: '依據', type: 'textarea', required: true, hint: '例：會議紀錄、撤回函文號' },
    { type: 'note', label: '結案不自動更動主檔註記；既有認定之取消或改類須另建有依據之事件（B15）。' }], { okLabel: '下一步' });
  if (!v) return;
  const ok = await dialog('確認', [h('p', { text: `案件 ${c.case_no} 將改為「${v.status}」。結案後再提須開新案並連結前案。` })],
    [{ label: '取消', value: null }, { label: '確認', value: true, primary: true }]);
  if (!ok) return;
  await env.s.run((dd, k) => { C.closeCase(dd, k, c.id, v); return { case_id: c.id }; }, { opId, kind: '結案' });
}

async function reopenUI(env, c) {
  const v = await formDialog('再提（開新案）', [
    { key: 'subject', label: '主旨', value: c.subject, required: true }, { key: 'recv_date', label: '收文日', type: 'date' },
    { key: 'recv_doc_no', label: '收文文號' }, { key: 'notes', label: '備註', type: 'textarea' }],
  { intro: `新案將連結前案 ${c.case_no}，品項沿用前案。` });
  if (!v) return;
  const r = await env.s.run((d, k) => C.reopenAsNew(d, k, c.id, v));
  env.ui.cases.selected = r.id;
}

// ---------- 會議清單 ----------
export function meetingsTab(env) {
  const { s, ui, btn, guard, render } = env;
  ui.meetings = ui.meetings || { keyword: null, selected: null };
  const st = ui.meetings;
  const d = data(env);
  if (st.selected) {
    const m = find(d, 'meeting', st.selected);
    if (m) {
      const ags = C.meetingAgendas(d, m.id);
      return h('section', { class: 'panel' },
        h('div', { class: 'toolbar' }, btn('← 回會議清單', () => { st.selected = null; render(); })),
        h('h2', { text: `${m.meeting_type}｜${m.name}` }),
        kv([['日期', dateText(m.meeting_date)], ['次別', m.session_no], ['備註', m.notes]]),
        s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('修改會議資料', () => guard(async () => {
          const v = await formDialog('修改會議', [{ key: 'name', label: '正式名稱', value: m.name, required: true }, { key: 'meeting_date', label: '會議日期', type: 'date', value: m.meeting_date },
            { key: 'session_no', label: '次別', value: m.session_no }, { key: 'notes', label: '備註', type: 'textarea', value: m.notes }, { key: 'reason', label: '修改原因' }]);
          if (!v) return;
          const { reason, ...ch } = v;
          await s.run((dd, k) => C.updateMeeting(dd, k, m.id, ch, { expectedVersion: m.row_version, reason }));
        }))) : null,
        h('h3', { text: `議案（${ags.length}）` }),
        (() => {
          const t = table(['案次', '案號', '案件主旨', '提案主旨', '決議'], []);
          for (const a of ags) {
            const decs = d.collections.decision.filter((x) => x.agenda_id === a.id).map((x) => `${x.nature}：${x.result}`).join('；');
            t.querySelector('tbody').appendChild(h('tr', { class: 'clickable', on: { click: () => { ui.tab = 'cases'; ui.cases = ui.cases || { filters: {}, page: 0 }; ui.cases.selected = a.case_id; render(); } } },
              [a.agenda_no || '', a.case_no, a.case_subject, a.subject || '', decs].map((x) => h('td', { text: x }))));
          }
          return t;
        })());
    }
    st.selected = null;
  }
  const kw = h('input', { type: 'text', size: 18, value: st.keyword || '', 'aria-label': '會議關鍵字' });
  const rows = C.listMeetings(d, { keyword: st.keyword });
  const t = table(['日期', '類型', '正式名稱', '次別', '議案數'], []);
  for (const m of rows) {
    t.querySelector('tbody').appendChild(h('tr', { class: 'clickable', on: { click: () => { st.selected = m.id; render(); } } },
      [m.meeting_date ? `${m.meeting_date}（${rocDisplay(m.meeting_date)}）` : '日期未知', m.meeting_type, m.name, m.session_no || '', m.agenda_count].map((x) => h('td', { text: x }))));
  }
  return h('section', { class: 'panel' }, h('h2', { text: '會議清單' }),
    h('div', { class: 'filters' }, h('label', null, '關鍵字 ', kw), btn('查詢', () => { st.keyword = kw.value.trim() || null; render(); })),
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('新增會議', () => guard(() => newMeetingUI(env)), { primary: true })) : null,
    h('p', { class: 'note', text: `共 ${rows.length} 次會議。同次會議可連多案。` }), t);
}

