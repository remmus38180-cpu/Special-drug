// 公告與合約：從已確認範圍名單勾選調高品項、登錄價格／簽約要求／合約／預定註記、整批確認；合約與補充協議、附件、到期提醒（第9.2、10節）。
import { h, table, dialog } from './dom.js';
import { formDialog, opts } from './forms.js';
import { saveBlobAs } from './files.js';
import * as P from '../core/pricing.js';
import * as RC from '../core/recognition.js';
import { readBlob } from '../core/attachments.js';
import { E, find, list } from '../core/model.js';
import { taipeiToday } from '../core/values.js';
import { newId } from '../core/util.js';
import { SpecError } from '../core/errors.js';

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

function today() {
  return taipeiToday(Date.now());
}

export function pricingTab(env) {
  env.ui.pricing = env.ui.pricing || { view: 'announce', rev: null, picked: new Set(), contract: null, kw: null };
  const st = env.ui.pricing;
  const sub = h('div', { class: 'toolbar' },
    env.btn('公告複核登記', () => { st.view = 'announce'; env.render(); }, { primary: st.view === 'announce' }),
    env.btn('合約', () => { st.view = 'contracts'; st.contract = null; env.render(); }, { primary: st.view === 'contracts' }));
  return h('div', null, sub, st.view === 'contracts' ? (st.contract ? contractDetail(env) : contractList(env)) : announce(env));
}

// ================= 公告複核登記 =================
function revOptions(d) {
  return list(d, 'recognition_revision').filter((r) => r.confirm_status === '已確認' && r.category !== '取消認定').map((r) => {
    const rec = find(d, 'recognition', r.recognition_id) || {};
    return [r.id, `${rec.recognition_no || ''} ${rec.name || ''}｜第${r.revision_no}版 ${r.category}`];
  });
}

function contractOptions(d) {
  return [['', '（無）'], ...list(d, 'contract').map((c) => [c.id, `${c.contract_no} ${c.firm || ''}（${c.status}）`])];
}

function caseOpts(d) {
  return [['', '（無）'], ...list(d, 'case_record').map((c) => [c.id, `${c.case_no} ${c.subject}`])];
}

function paFields(d, pa = {}) {
  return [
    { key: 'case_id', label: '公告案件', type: 'select', options: caseOpts(d), value: pa.case_id || '' },
    { key: 'contract_requirement', label: '簽約要求', type: 'select', options: opts(E.CONTRACT_REQ), value: pa.contract_requirement || '待確認',
      hint: '「當時無須簽約」須填依據；「待確認」可確認但標示不完整（B17）' },
    { key: 'requirement_basis', label: '要求依據／說明', type: 'textarea', value: pa.requirement_basis },
    { key: 'contract_id', label: '對應合約', type: 'select', options: contractOptions(d), value: pa.contract_id || '', hint: '不檢查合約起訖是否涵蓋生效日（B18）' },
    { key: 'price_before', label: '調高前價格', value: pa.price_before, size: 12 },
    { key: 'price_after', label: '調高後價格', value: pa.price_after, size: 12 },
    { key: 'effective_date', label: '調高生效日', type: 'date', value: pa.effective_date },
    { key: 'announce_doc_no', label: '公告文號', value: pa.announce_doc_no },
    { key: 'announce_date', label: '公告日期', type: 'date', value: pa.announce_date },
    { key: 'status', label: '辦理狀態', type: 'select', options: opts(E.PRICE_STATUS), value: pa.status || '辦理中' },
    { key: 'note', label: '備註', type: 'textarea', value: pa.note },
  ];
}

function clean(v) {
  const out = { ...v };
  for (const k of ['case_id', 'contract_id']) if (k in out && !out[k]) out[k] = null;
  return out;
}

function announce(env) {
  const { s, btn, guard, render } = env;
  const st = env.ui.pricing;
  const d = data(env);
  const ro = revOptions(d);
  if (st.rev && !find(d, 'recognition_revision', st.rev)) st.rev = null;
  const sel = h('select', { 'aria-label': '認定版本', on: { change: (e) => { st.rev = e.target.value || null; st.picked = new Set(); render(); } } },
    [h('option', { value: '', text: '（請選已確認之認定版本）' }), ...ro.map(([v, l]) => h('option', { value: v, text: l, selected: v === st.rev }))]);
  const head = h('section', { class: 'panel' }, h('h2', { text: '公告複核登記' }),
    h('p', { class: 'note', text: '認定範圍名單 ≠ 本次調高名單 ≠ 主檔註記名單。只能從已確認範圍名單勾選；範圍外品項須另補認定依據。陳核階段儲存為草稿／待確認，不更新正式現況。' }),
    h('label', null, '認定版本 ', sel));
  if (!st.rev) return h('div', null, head, ro.length ? null : h('p', { class: 'note', text: '尚無已確認之認定版本。請先於「認定」頁確認範圍快照與版本。' }));
  const rev = find(d, 'recognition_revision', st.rev);
  const snap = RC.confirmedSnapshotOf(d, rev.id);
  const groupOf = new Map(snap ? RC.snapshotMemberList(d, snap.id).map((m) => [m.drug_code, m.group_code]) : []);
  const cands = P.scopeCandidates(d, rev.id);
  const ct = table(['勾選', '藥品代碼', '分組', '已有調高紀錄'], []);
  for (const c of cands) {
    const cb = h('input', { type: 'checkbox', checked: st.picked.has(c.drug_code), 'aria-label': `勾選 ${c.drug_code}`, on: { change: (e) => { if (e.target.checked) st.picked.add(c.drug_code); else st.picked.delete(c.drug_code); } } });
    ct.querySelector('tbody').appendChild(h('tr', null, h('td', null, cb), h('td', { text: c.drug_code }), h('td', { text: groupOf.get(c.drug_code) || '' }),
      h('td', { text: c.actions.map((a) => `${a.confirm_status}${a.price_after ? ' ' + a.price_after : ''}`).join('；') })));
  }
  const scopePanel = h('section', { class: 'panel' }, h('h3', { text: `範圍名單（${cands.length} 項）` }),
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('建立調高紀錄（勾選品項）', () => guard(() => createPAs(env, rev)), { primary: true })) : null, ct);
  return h('div', null, head, scopePanel, paPanel(env, rev), annPanel(env, rev));
}

async function createPAs(env, rev) {
  const st = env.ui.pricing;
  const codes = [...st.picked].sort();
  if (!codes.length) throw new SpecError('REQUIRED', '請先勾選本次調高品項');
  const d = data(env);
  const fields = paFields(d);
  fields.push({ key: 'annotate', label: '預定註記', type: 'select', options: [['Y', `同時建立「新增」註記（${rev.category}）`], ['N', '不建立']], value: rev.category === '待確認' ? 'N' : 'Y' });
  fields.push({ key: 'ann_date', label: '註記生效日', type: 'date', hint: '與調高生效日分欄保存（B08、Q04）；未知留空' });
  const v = await formDialog(`建立調高紀錄：${codes.length} 項（${codes.join('、')}）`, fields);
  if (!v) return;
  const { annotate, ann_date, ...pa } = v;
  await env.s.run((dd, k) => {
    const pas = P.createPriceActions(dd, k, rev.id, codes, clean(pa));
    if (annotate === 'Y') for (const p of pas) P.createAnnotation(dd, k, { drug_code: p.drug_code, action: '新增', category: rev.category, price_action_id: p.id, effective_date: ann_date });
    return pas.map((p) => p.id);
  }, { opId: newId(), kind: '建立調高紀錄' });
  st.picked = new Set();
}

function paPanel(env, rev) {
  const { s, btn, guard } = env;
  const d = data(env);
  const pas = P.listPriceActions(d, { revisionId: rev.id });
  const t = table(['選', '代碼', '調高前→後', '生效日', '公告文號／日期', '簽約要求', '合約', '辦理', '確認', '完整性', '檢核', '操作'], []);
  const chosen = new Set();
  for (const p of pas) {
    const c = p.contract_id ? find(d, 'contract', p.contract_id) : null;
    const errs = p.confirm_status === '已確認' || p.confirm_status === '撤銷' ? [] : P.validatePriceAction(d, p);
    const cb = p.confirm_status === '草稿' || p.confirm_status === '待確認' ? h('input', { type: 'checkbox', 'aria-label': `選 ${p.drug_code}`, on: { change: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); } } }) : '';
    const ops = [];
    if (s.mode === 'edit') {
      if (p.confirm_status === '草稿' || p.confirm_status === '待確認') {
        ops.push(btn('編輯', () => guard(() => editPA(env, p))));
        if (p.confirm_status === '草稿') ops.push(btn('送待確認', () => guard(() => s.run((dd, k) => P.submitPriceAction(dd, k, p.id)))));
        ops.push(btn('撤銷', () => guard(() => withdrawPA(env, p))));
      }
      if (p.confirm_status === '已確認' && !p.superseded) ops.push(btn('更正', () => guard(() => correctPA(env, rev, p))));
      ops.push(btn('附件', () => guard(() => uploadTo(env, 'price_action', p.id))));
    }
    const label = p.superseded ? `${p.confirm_status}（已更正取代）` : p.confirm_status;
    t.querySelector('tbody').appendChild(h('tr', null, [cb, p.drug_code, `${p.price_before || '—'} → ${p.price_after || '—'}`, p.effective_date || '', `${p.announce_doc_no || ''} ${p.announce_date || ''}`,
      p.contract_requirement, c ? `${c.contract_no}（${c.status}）` : '', p.status, label, p.completeness,
      errs.length ? h('span', { class: 'warn-text', text: errs.join('；') }) : (p.confirm_status === '已確認' ? '' : '可確認'), h('span', null, ops)]
      .map((x) => (x instanceof Node ? h('td', null, x) : h('td', { text: x })))));
  }
  return h('section', { class: 'panel' }, h('h3', { text: `本次調高名單（${pas.length} 筆）` }),
    s.mode === 'edit' && pas.length ? h('div', { class: 'toolbar' }, btn('確認公告（勾選之調高及其註記）', () => guard(() => confirmUI(env, rev, [...chosen])), { primary: true })) : null,
    pas.length ? t : h('p', { class: 'note', text: '尚無調高紀錄。' }));
}

async function editPA(env, p) {
  const v = await formDialog(`編輯調高紀錄 ${p.drug_code}`, paFields(data(env), p));
  if (!v) return;
  await env.s.run((dd, k) => P.updatePriceAction(dd, k, p.id, clean(v), { expectedVersion: p.row_version }));
}

async function withdrawPA(env, p) {
  const v = await formDialog(`撤銷調高紀錄 ${p.drug_code}`, [{ key: 'reason', label: '撤銷原因', required: true },
    { type: 'note', label: '連結之未確認註記一併撤銷；紀錄保留不刪除。' }]);
  if (!v) return;
  await env.s.run((dd, k) => P.withdrawPriceAction(dd, k, p.id, v.reason));
}

async function correctPA(env, rev, p) {
  const v = await formDialog(`更正調高紀錄 ${p.drug_code}（原紀錄保留並標示取代）`, paFields(data(env), p));
  if (!v) return;
  await env.s.run((dd, k) => P.createPriceAction(dd, k, { ...clean(v), revision_id: rev.id, drug_code: p.drug_code, supersedes_id: p.id }), { opId: newId(), kind: '更正調高紀錄' });
}

async function confirmUI(env, rev, paIds) {
  const d = data(env);
  if (!paIds.length) throw new SpecError('REQUIRED', '請勾選要確認的調高紀錄');
  const pas = paIds.map((id) => find(d, 'price_action', id));
  const anns = list(d, 'annotation_event').filter((a) => paIds.includes(a.price_action_id) && (a.confirm_status === '草稿' || a.confirm_status === '待確認'));
  const errs = [];
  for (const p of pas) { const e = P.validatePriceAction(d, p); if (e.length) errs.push(`調高 ${p.drug_code}：${e.join('、')}`); }
  for (const a of anns) { const e = P.validateAnnotation(d, a, paIds); if (e.length) errs.push(`註記 ${a.drug_code}：${e.join('、')}`); }
  if (errs.length) throw new SpecError('VALIDATION', `驗證未通過，整批未確認：${errs.join('；')}`);
  const fileIn = h('input', { type: 'file', multiple: true, 'aria-label': '公告附件' });
  const incomplete = pas.filter((p) => p.contract_requirement === '待確認').map((p) => p.drug_code);
  const opId = newId();
  const ok = await dialog('確認公告', [
    h('p', { text: `將確認調高 ${pas.length} 筆、註記 ${anns.length} 筆；整批成立或整批不成立。系統登記確認不取代公文核定。` }),
    table(['代碼', '調高後', '生效日', '公告文號', '簽約要求'], pas.map((p) => [p.drug_code, p.price_after, p.effective_date, p.announce_doc_no, p.contract_requirement])),
    incomplete.length ? h('p', { class: 'warn-text', text: `簽約要求待確認者將標示「不完整」：${incomplete.join('、')}` }) : null,
    h('label', null, '公告附件（選填） ', fileIn)], [{ label: '取消', value: false }, { label: '確認', value: true, primary: true }]);
  if (!ok) return;
  const files = [];
  for (const f of fileIn.files) files.push({ name: f.name, mime: f.type || null, bytes: new Uint8Array(await f.arrayBuffer()) });
  await P.confirmAnnouncementWithFiles(env.s, { priceActionIds: paIds, annotationIds: anns.map((a) => a.id) }, files, { opId });
}

function annPanel(env, rev) {
  const { s, btn, guard } = env;
  const d = data(env);
  const anns = P.listAnnotations(d, { revisionId: rev.id });
  const t = table(['代碼', '動作', '類別', '註記生效日', '依據', '連結調高', '確認', '操作'], []);
  for (const a of anns) {
    const pa = a.price_action_id ? find(d, 'price_action', a.price_action_id) : null;
    const ops = [];
    if (s.mode === 'edit' && (a.confirm_status === '草稿' || a.confirm_status === '待確認')) {
      ops.push(btn('編輯', () => guard(() => editAnn(env, a))));
      ops.push(btn('撤銷', () => guard(async () => {
        const v = await formDialog('撤銷註記事件', [{ key: 'reason', label: '原因', required: true }]);
        if (v) await s.run((dd, k) => P.withdrawAnnotation(dd, k, a.id, v.reason));
      })));
    }
    if (s.mode === 'edit' && a.confirm_status === '已確認' && a.action !== '更正') ops.push(btn('更正', () => guard(() => newAnn(env, rev, '更正', a))));
    t.querySelector('tbody').appendChild(h('tr', null, [a.drug_code, a.action, a.category || '', a.effective_date || '（未知）', a.basis || '', pa ? `${pa.price_after || ''}（${pa.confirm_status}）` : '', a.confirm_status, h('span', null, ops)]
      .map((x) => (x instanceof Node ? h('td', null, x) : h('td', { text: x })))));
  }
  return h('section', { class: 'panel' }, h('h3', { text: `註記事件（${anns.length} 筆）` }),
    h('p', { class: 'note', text: '新增／改類須連結實際調高（B03）；取消、更正須填依據，不自動批次取消（Q07）。本系統不直接更新正式主檔。' }),
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('新增取消註記事件', () => guard(() => newAnn(env, rev, '取消'))),
      btn('確認選定註記（取消／更正）', () => guard(() => confirmAnnUI(env, rev)))) : null,
    anns.length ? t : h('p', { class: 'note', text: '尚無註記事件。' }));
}

async function editAnn(env, a) {
  const v = await formDialog(`編輯註記 ${a.drug_code}（${a.action}）`, [
    { key: 'category', label: '註記類別', type: 'select', options: [['', '（無）'], ...opts(E.CATEGORY)], value: a.category || '' },
    { key: 'effective_date', label: '註記生效日', type: 'date', value: a.effective_date }, { key: 'basis', label: '依據', type: 'textarea', value: a.basis }]);
  if (!v) return;
  await env.s.run((dd, k) => P.updateAnnotation(dd, k, a.id, { ...v, category: v.category || null }, { expectedVersion: a.row_version }));
}

async function newAnn(env, rev, action, orig) {
  const fields = [];
  if (!orig) fields.push({ key: 'drug_code', label: '藥品代碼', required: true, hint: '取消事件逐品項登錄並填依據' });
  if (action === '更正') fields.push({ key: 'category', label: '更正後類別', type: 'select', options: [['', '（無）'], ...opts(E.CATEGORY)], value: orig.category || '' });
  fields.push({ key: 'effective_date', label: '生效日', type: 'date', value: orig ? orig.effective_date : null }, { key: 'basis', label: '依據', type: 'textarea', required: true });
  const v = await formDialog(action === '更正' ? `更正註記 ${orig.drug_code}（原事件保留）` : '新增取消註記事件', fields);
  if (!v) return;
  await env.s.run((dd, k) => P.createAnnotation(dd, k, { drug_code: orig ? orig.drug_code : v.drug_code, action, category: v.category || null, revision_id: rev.id,
    effective_date: v.effective_date, basis: v.basis, original_event_id: orig ? orig.id : null }), { opId: newId(), kind: `註記${action}` });
}

async function confirmAnnUI(env, rev) {
  const d = data(env);
  const cands = P.listAnnotations(d, { revisionId: rev.id }).filter((a) => (a.confirm_status === '草稿' || a.confirm_status === '待確認') && (a.action === '取消' || a.action === '更正'));
  if (!cands.length) throw new SpecError('REQUIRED', '沒有待確認之取消／更正註記事件（新增註記隨調高一併確認）');
  const v = await formDialog('確認註記事件', [{ key: 'ids', label: '選擇', type: 'checks', required: true, options: cands.map((a) => [a.id, `${a.drug_code} ${a.action} ${a.effective_date || '（生效日未知）'}`]) }]);
  if (!v) return;
  await env.s.run((dd, k) => P.confirmAnnouncement(dd, k, { annotationIds: v.ids }), { opId: newId(), kind: '確認註記' });
}

// ================= 合約 =================
function contractFields(c = {}) {
  return [
    { key: 'contract_no', label: '合約編號', required: true, value: c.contract_no }, { key: 'firm', label: '簽約廠商', value: c.firm },
    { key: 'signed_date', label: '簽訂日', type: 'date', value: c.signed_date }, { key: 'effective_from', label: '生效日', type: 'date', value: c.effective_from },
    { key: 'expiry_date', label: '到期日', type: 'date', value: c.expiry_date, hint: '無到期日請留空，系統不推定' },
    { key: 'doc_version', label: '文件版本', value: c.doc_version }, { key: 'obligations', label: '供貨義務摘要', type: 'textarea', value: c.obligations },
    { key: 'status', label: '合約狀態', type: 'select', options: opts(E.CONTRACT_STATUS), value: c.status || '辦理中' },
  ];
}

function contractList(env) {
  const { s, btn, guard, render } = env;
  const st = env.ui.pricing;
  const d = data(env);
  const day = today();
  const alerts = P.contractAlerts(d, day);
  const kw = h('input', { type: 'text', size: 18, value: st.kw || '', placeholder: '合約編號、廠商、藥品代碼', 'aria-label': '合約關鍵字' });
  const rows = P.listContracts(d, { keyword: st.kw });
  const t = table(['合約編號', '簽約廠商', '狀態', '簽訂日', '到期', '品項數', '原合約'], []);
  for (const c of rows) {
    const orig = c.original_contract_id ? find(d, 'contract', c.original_contract_id) : null;
    t.querySelector('tbody').appendChild(h('tr', { class: 'clickable', tabindex: '0', on: { click: () => { st.contract = c.id; render(); } } },
      [c.contract_no, c.firm || '', c.status, c.signed_date || '', `${c.expiry_date || ''} ${P.contractExpiryText(c, day)}`, String(P.contractDrugs(d, c.id).length), orig ? orig.contract_no : '']
        .map((x) => h('td', { text: x }))));
  }
  return h('section', { class: 'panel' }, h('h2', { text: '合約' }),
    alerts.length ? h('div', { class: 'alert' }, h('strong', { text: `合約到期提醒（60日內，${alerts.length} 份）：` }),
      alerts.map((a) => `${a.contract_no} ${a.expiry_date} ${a.alert}`).join('；'), h('p', { class: 'note', text: '僅提醒檢視，不自動取消認定、註記或價格（B11）。' })) : null,
    h('div', { class: 'filters' }, h('label', null, '關鍵字 ', kw), btn('查詢', () => { st.kw = kw.value.trim() || null; render(); })),
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('新增合約', () => guard(() => newContract(env)), { primary: true })) : null,
    h('p', { class: 'note', text: `共 ${rows.length} 份。` }), t);
}

function codesOf(text) {
  return String(text || '').split(/[\s,，、;；]+/).map((x) => x.trim()).filter(Boolean);
}

async function newContract(env, original) {
  const fields = contractFields(original ? { contract_no: `${original.contract_no}-補`, firm: original.firm } : {});
  fields.push({ key: 'drugs', label: '適用藥品代碼', type: 'textarea', hint: '以空白、逗號或換行分隔' });
  const v = await formDialog(original ? `新增補充協議／新版合約（原合約 ${original.contract_no} 保留）` : '新增合約', fields);
  if (!v) return;
  const { drugs, ...rest } = v;
  const r = await env.s.run((dd, k) => P.createContract(dd, k, { ...rest, drugs: codesOf(drugs), original_contract_id: original ? original.id : null }).id, { opId: newId(), kind: '新增合約' });
  env.ui.pricing.contract = r;
}

function contractDetail(env) {
  const { s, btn, guard, render } = env;
  const st = env.ui.pricing;
  const d = data(env);
  const c = find(d, 'contract', st.contract);
  if (!c) { st.contract = null; return contractList(env); }
  const chain = P.contractChain(d, c.id);
  const affected = P.contractAffected(d, c.id);
  const parts = chain.map((x) => h('div', { class: x.id === c.id ? 'panel current' : 'panel' },
    h('h3', { text: `${x.contract_no}${x.original_contract_id ? '（補充協議／新版）' : '（原合約）'}｜${x.status}` }),
    h('p', { text: `廠商：${x.firm || ''}；簽訂 ${x.signed_date || '—'}；生效 ${x.effective_from || '—'}；到期 ${x.expiry_date || '—'}（${P.contractExpiryText(x, today())}）；文件版本 ${x.doc_version || '—'}` }),
    x.obligations ? h('p', { text: `供貨義務：${x.obligations}` }) : null,
    h('p', { text: `適用品項（${x.drugs.length}）：${x.drugs.map((dd) => dd.drug_code + (dd.effective_from || dd.effective_to ? `（${dd.effective_from || ''}～${dd.effective_to || ''}）` : '')).join('、') || '（無）'}` }),
    h('div', null, ' 附件：', x.attachments.length ? x.attachments.map((a) => btn(`${a.orig_name} v${a.version}`, () => guard(() => download(env, a)))) : '（無）')));
  return h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, btn('← 回合約清單', () => { st.contract = null; render(); })),
    h('h2', { text: `合約 ${c.contract_no}` }),
    affected.length ? h('p', { class: 'warn-text', text: `已被 ${affected.length} 筆已確認調高引用（${affected.map((p) => p.drug_code).join('、')}）；修改須填原因（Q11）。` }) : null,
    s.mode === 'edit' ? h('div', { class: 'toolbar' },
      btn('編輯', () => guard(() => editContract(env, c))),
      btn('新增適用品項', () => guard(() => addDrugs(env, c))),
      btn('上傳附件', () => guard(() => uploadTo(env, 'contract', c.id))),
      btn('新增補充協議／新版', () => guard(() => newContract(env, c)))) : null,
    h('p', { class: 'note', text: '合約版本鏈（原件保留）：' }), parts);
}

async function editContract(env, c) {
  const affected = P.contractAffected(data(env), c.id);
  const fields = contractFields(c);
  if (affected.length) fields.push({ key: 'reason', label: '修改原因', type: 'textarea', required: true, hint: `受影響調高：${affected.map((p) => p.drug_code).join('、')}` });
  const v = await formDialog(`編輯合約 ${c.contract_no}`, fields);
  if (!v) return;
  const { reason, ...changes } = v;
  await env.s.run((dd, k) => P.updateContract(dd, k, c.id, changes, { expectedVersion: c.row_version, reason }));
}

async function addDrugs(env, c) {
  const v = await formDialog(`合約 ${c.contract_no} 新增適用品項`, [{ key: 'drugs', label: '藥品代碼', type: 'textarea', required: true, hint: '以空白、逗號或換行分隔' },
    { key: 'effective_from', label: '適用起日', type: 'date' }, { key: 'effective_to', label: '適用迄日（不含）', type: 'date' }]);
  if (!v) return;
  await env.s.run((dd, k) => codesOf(v.drugs).map((code) => P.addContractDrug(dd, k, c.id, code, v).id), { opId: newId(), kind: '新增合約品項' });
}

async function uploadTo(env, entity, id) {
  const fileIn = h('input', { type: 'file', multiple: true, 'aria-label': '選擇附件' });
  const ok = await dialog('上傳附件', [h('p', { text: '原檔以雜湊保存於資料夾 attachments/；同名再上傳者版本＋1，原件保留。' }), fileIn],
    [{ label: '取消', value: false }, { label: '上傳', value: true, primary: true }]);
  if (!ok || !fileIn.files.length) return;
  const files = [];
  for (const f of fileIn.files) files.push({ name: f.name, mime: f.type || null, bytes: new Uint8Array(await f.arrayBuffer()) });
  await P.attachFiles(env.s, entity, id, files, { opId: newId() });
}

async function download(env, a) {
  const bytes = await readBlob(env.s.fs, a.sha256);
  await saveBlobAs(a.orig_name, new Blob([bytes], { type: a.mime || 'application/octet-stream' }));
}
