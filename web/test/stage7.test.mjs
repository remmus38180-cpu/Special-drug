// 階段7：合約、公告複核、個別品項調高與註記（T08、T09、T10、T15、T17、T18、T20、B17、B18、B19、M3、M4、Q11）
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from '../src/core/dataset.js';
import * as RC from '../src/core/recognition.js';
import * as R from '../src/core/rules.js';
import * as P from '../src/core/pricing.js';
import * as C from '../src/core/cases.js';
import { insert } from '../src/core/model.js';
import { openFolder } from '../src/core/folder.js';
import { world, initWith } from './helpers.mjs';

let n = 0;
const F = ['drug_code', 'drug_name', 'group_code', 'atc_code'];
const CODES = Array.from({ length: 10 }, (_, i) => `A00000${i}100`);
function rowsOf(codes) {
  return { byCode: new Map(codes.map((c) => { const o = {}; F.forEach((k) => { o[k] = null; }); Object.assign(o, { drug_code: c, drug_name: c, group_code: 'G1', atc_code: 'J06BA01' }); return [c, o]; })) };
}
function mkCtx() { return { actor: '承辦A／PC-01', now: '2026-11-07T02:00:00.000Z', newId: () => `id-${++n}`, events: [] }; }

function addImport(data, ctx) {
  return insert(data, ctx, 'master_import', { source_name: 'm.csv', sha256: 'x'.repeat(64), base_date: '2026-11-01', row_count: CODES.length, status: '已啟用',
    check: { disabled_rule_fields: [], known_units: [] }, rows_file: 'masters/x.json', rows_sha256: 'y' });
}

// 建立「已確認」之認定版本，範圍10項
async function scope10(data, ctx, imp, { category = '特殊藥品', name = '認定甲' } = {}) {
  const rule = { field: 'group_code', op: 'in', values: ['G1'] };
  const rec = RC.createRecognition(data, ctx, { name });
  const rev = RC.createRevision(data, ctx, rec.id, { category, rule, effective_from: '2026-01-01', completeness: '完整' });
  const pv = await R.previewRule(rule, rowsOf(CODES), imp, {});
  const snap = RC.saveSnapshot(data, ctx, rev.id, imp, pv);
  RC.confirmSnapshot(data, ctx, snap.id);
  RC.confirmRevision(data, ctx, rev.id);
  return rev;
}

async function setup() {
  const data = emptyData();
  const ctx = mkCtx();
  const imp = addImport(data, ctx);
  const rev = await scope10(data, ctx, imp);
  return { data, ctx, imp, rev };
}

function signedContract(data, ctx, drugs, extra = {}) {
  return P.createContract(data, ctx, { contract_no: 'K-001', firm: '甲藥廠', signed_date: '2026-02-01', effective_from: '2026-02-01', expiry_date: '2027-02-01', status: '完成簽署', drugs, ...extra });
}

function ready(pa) {
  return { status: '已核定', announce_doc_no: '健保審字第1150000001號', announce_date: '2026-03-01', effective_date: '2026-04-01', price_before: '3.20', price_after: '4.38', ...pa };
}

test('T08 範圍10項、本次僅2項調高：範圍保留10項，價格與註記僅作用於勾選2項；範圍外不可勾入', async () => {
  const { data, ctx, rev } = await setup();
  assert.equal(P.scopeCandidates(data, rev.id).length, 10);
  const k = signedContract(data, ctx, [CODES[0], CODES[1]]);
  const pas = P.createPriceActions(data, ctx, rev.id, [CODES[0], CODES[1], CODES[1]], { contract_requirement: '須簽約', contract_id: k.id, ...ready() });
  assert.equal(pas.length, 2);
  assert.ok(pas.every((p) => p.snapshot_id));
  const anns = pas.map((p) => P.createAnnotation(data, ctx, { drug_code: p.drug_code, action: '新增', category: rev.category, price_action_id: p.id, effective_date: '2026-04-01' }));
  const r = P.confirmAnnouncement(data, ctx, { priceActionIds: pas.map((p) => p.id), annotationIds: anns.map((a) => a.id) });
  assert.deepEqual(r.incomplete, []);
  assert.equal(RC.revisionScope(data, rev.id).size, 10);
  const cand = P.scopeCandidates(data, rev.id);
  assert.equal(cand.filter((c) => c.actions.length).length, 2);
  assert.equal(P.annotationOn(data, CODES[0], '2026-05-01').category, '特殊藥品');
  assert.equal(P.annotationOn(data, CODES[2], '2026-05-01').category, null);
  assert.equal(P.annotationOn(data, CODES[0], '2026-03-31').category, null);
  assert.equal(P.annotationOn(data, CODES[0], '2026-03-31').upcoming.effective_date, '2026-04-01');
  assert.throws(() => P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: 'Z000009100' }), (e) => e.code === 'OUT_OF_SCOPE');
  // 未確認快照之版本：範圍為空，不可勾入
  const rec2 = RC.createRecognition(data, ctx, { name: '草稿認定' });
  const rev2 = RC.createRevision(data, ctx, rec2.id, { category: '特殊藥品', rule: { field: 'group_code', op: 'in', values: ['G1'] } });
  assert.throws(() => P.createPriceAction(data, ctx, { revision_id: rev2.id, drug_code: CODES[0] }), (e) => e.code === 'OUT_OF_SCOPE');
  // 註記只能連結實際調高（B03）
  assert.throws(() => P.createAnnotation(data, ctx, { drug_code: CODES[3], action: '新增', category: '特殊藥品' }), (e) => e.code === 'NO_PRICE_ACTION');
  assert.throws(() => P.createAnnotation(data, ctx, { drug_code: CODES[3], action: '新增', category: '特殊藥品', price_action_id: pas[0].id }), (e) => e.code === 'MISMATCH');
});

test('T09 現行須簽約品項未完成簽署：阻止確認並顯示缺件；整批不成立', async () => {
  const { data, ctx, rev } = await setup();
  const k = P.createContract(data, ctx, { contract_no: 'K-009', status: '辦理中', drugs: [CODES[0]] });
  const ok = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[1], contract_requirement: '當時無須簽約', requirement_basis: '98年藥事小組，當時僅不可替代類別要求簽約', ...ready() });
  const bad = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], contract_requirement: '須簽約', contract_id: k.id, ...ready() });
  const none = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[2], contract_requirement: '須簽約', ...ready() });
  assert.throws(() => P.confirmAnnouncement(data, ctx, { priceActionIds: [ok.id, bad.id, none.id] }), (e) => {
    assert.equal(e.code, 'VALIDATION');
    assert.match(e.message, /未完成簽署（缺件）/);
    assert.match(e.message, /未對應合約（缺件）/);
    return true;
  });
  // 本函式於 run 之資料副本上執行；拋錯即整批作廢（此處直接檢查未部分寫入）
  assert.equal(ok.confirm_status, '草稿');
  // 合約完成簽署但未含此品項
  const k2 = signedContract(data, ctx, [CODES[5]], { contract_no: 'K-010' });
  P.updatePriceAction(data, ctx, bad.id, { contract_id: k2.id });
  assert.match(P.validatePriceAction(data, bad).join(), /適用品項未含此代碼/);
  // 缺公告文號、生效日、核定狀態
  const raw = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[3], contract_requirement: '當時無須簽約', requirement_basis: '依據' });
  const errs = P.validatePriceAction(data, raw).join('、');
  for (const s of ['已核定', '公告文號', '生效日', '調高後價格']) assert.ok(errs.includes(s), s);
});

test('T10 歷史案當時無須簽約：有依據可保存並確認，不列成未簽約違漏；無依據不可確認', async () => {
  const { data, ctx, rev } = await setup();
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], contract_requirement: '當時無須簽約', ...ready() });
  assert.match(P.validatePriceAction(data, a).join(), /須填說明／依據/);
  P.updatePriceAction(data, ctx, a.id, { requirement_basis: '二代健保前藥事小組認定，當時無簽約要求' });
  assert.deepEqual(P.validatePriceAction(data, a), []);
  P.confirmAnnouncement(data, ctx, { priceActionIds: [a.id] });
  assert.equal(a.confirm_status, '已確認');
  assert.equal(a.completeness, '完整');
});

test('B17 簽約要求待確認：不以案件來源限制確認；確認時標示不完整', async () => {
  const { data, ctx, rev } = await setup();
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], ...ready() });
  assert.equal(a.contract_requirement, '待確認');
  assert.deepEqual(P.validatePriceAction(data, a), []);
  const r = P.confirmAnnouncement(data, ctx, { priceActionIds: [a.id] });
  assert.deepEqual(r.incomplete, [CODES[0]]);
  assert.equal(a.completeness, '不完整');
  assert.equal(a.confirm_status, '已確認');
});

test('B18 不檢查合約生效日／到期日是否涵蓋調高生效日；仍檢查完成簽署及適用品項', async () => {
  const { data, ctx, rev } = await setup();
  const k = P.createContract(data, ctx, { contract_no: 'K-OLD', signed_date: '2020-01-01', effective_from: '2020-01-01', expiry_date: '2021-01-01', status: '完成簽署',
    drugs: [{ drug_code: CODES[0], effective_from: '2020-01-01', effective_to: '2021-01-01' }] });
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], contract_requirement: '須簽約', contract_id: k.id, ...ready() });
  assert.deepEqual(P.validatePriceAction(data, a), []);
});

test('B19／案件依據：附條件同意可接續調高，不另檢核條件達成；不同意者不能接續', async () => {
  const { data, ctx, rev } = await setup();
  const c = C.createCase(data, ctx, { subject: '案', drugs: [CODES[0], CODES[1]] });
  const cds = C.caseDrugs(data, c.id);
  const m = C.createMeeting(data, ctx, { meeting_type: '共同擬訂', name: '共擬', meeting_date: '2026-01-10' });
  C.addDecision(data, ctx, { agenda_id: C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c.id }).id, nature: '會議決議', result: '其他', result_text: '品項結果不同',
    drugResults: { [cds[0].id]: { result: '附條件同意', conditions: '須簽訂穩定供貨協議' }, [cds[1].id]: '不同意' } });
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], case_id: c.id });
  assert.equal(a.case_id, c.id);
  assert.throws(() => P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[1], case_id: c.id }), (e) => e.code === 'NO_BASIS');
});

test('M3 調高一般修改白名單：不可改確認狀態、確認者、品項、認定版本、快照；已確認不可修改', async () => {
  const { data, ctx, rev } = await setup();
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], ...ready() });
  for (const k of ['confirm_status', 'confirmed_by', 'drug_code', 'revision_id', 'snapshot_id', 'supersedes_id', 'created_by', 'completeness', 'id']) {
    assert.throws(() => P.updatePriceAction(data, ctx, a.id, { [k]: 'x' }), (e) => e.code === 'FIELD_PROTECTED', k);
  }
  assert.throws(() => P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[1], confirm_status: '已確認' }), (e) => e.code === 'FIELD_PROTECTED');
  assert.throws(() => P.updatePriceAction(data, ctx, a.id, { price_after: '1.2.3' }), (e) => e.code === 'BAD_MONEY');
  P.updatePriceAction(data, ctx, a.id, { price_after: '4.380', effective_date: '115/04/01' });
  assert.equal(a.price_after, '4.38');
  assert.equal(a.effective_date, '2026-04-01');
  P.confirmAnnouncement(data, ctx, { priceActionIds: [a.id] });
  assert.throws(() => P.updatePriceAction(data, ctx, a.id, { note: '改' }), (e) => e.code === 'CONFIRMED_READONLY');
  assert.throws(() => P.withdrawPriceAction(data, ctx, a.id, '錯'), (e) => e.code === 'CONFIRMED_READONLY');
  // 更正：新增更正紀錄，原紀錄保留並標示被取代
  const fix = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], supersedes_id: a.id, ...ready({ price_after: '4.40' }) });
  assert.throws(() => P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], supersedes_id: a.id }), (e) => e.code === 'DUPLICATE');
  assert.throws(() => P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[1], supersedes_id: a.id }), (e) => e.code === 'BAD_SUPERSEDE');
  P.confirmAnnouncement(data, ctx, { priceActionIds: [fix.id] });
  const h = P.priceHistory(data, CODES[0]);
  assert.deepEqual(h.map((x) => [x.price_after, x.superseded]), [['4.38', true], ['4.4', false]]);
});

test('M4 合約修改白名單；Q11 已確認調高引用之合約可改，但須填原因並列受影響調高', async () => {
  const { data, ctx, rev } = await setup();
  const k = signedContract(data, ctx, [CODES[0]]);
  for (const f of ['created_by', 'original_contract_id', 'id', 'row_version']) {
    assert.throws(() => P.updateContract(data, ctx, k.id, { [f]: 'x' }), (e) => e.code === 'FIELD_PROTECTED', f);
  }
  assert.throws(() => P.updateContract(data, ctx, k.id, { status: '已失效' }), (e) => e.code === 'BAD_VALUE');
  assert.throws(() => P.createContract(data, ctx, { contract_no: 'K-2', status: '完成簽署' }), /簽訂日/);
  P.updateContract(data, ctx, k.id, { obligations: '每月供貨' });
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], contract_requirement: '須簽約', contract_id: k.id, ...ready() });
  P.confirmAnnouncement(data, ctx, { priceActionIds: [a.id] });
  assert.throws(() => P.updateContract(data, ctx, k.id, { expiry_date: '2028-02-01' }), (e) => e.code === 'NEED_REASON' && e.detail.affected[0] === a.id);
  ctx.events.length = 0;
  P.updateContract(data, ctx, k.id, { expiry_date: '2028-02-01' }, { reason: '原到期日登錄錯誤' });
  assert.equal(k.expiry_date, '2028-02-01');
  assert.match(ctx.events.at(-1).reason, /受影響調高：A000000100/);
});

test('T15 一份合約涵蓋多藥，後有補充協議：可查各版本及適用代碼，原件保留', async () => {
  const { data, ctx } = await setup();
  const k1 = signedContract(data, ctx, [CODES[0], CODES[1], CODES[2]]);
  const k2 = P.createContract(data, ctx, { contract_no: 'K-001-補1', signed_date: '2026-06-01', status: '完成簽署', original_contract_id: k1.id, drugs: [CODES[3]] });
  insert(data, ctx, 'attachment', { orig_name: '合約.pdf', storage_key: 'attachments/aa/aa', sha256: 'a'.repeat(64), size: 3 });
  const att = data.collections.attachment.at(-1);
  insert(data, ctx, 'attachment_link', { attachment_id: att.id, entity: 'contract', entity_id: k1.id });
  const chain = P.contractChain(data, k2.id);
  assert.deepEqual(chain.map((c) => c.contract_no), ['K-001', 'K-001-補1']);
  assert.deepEqual(chain[0].drugs.map((d) => d.drug_code), CODES.slice(0, 3));
  assert.deepEqual(chain[1].drugs.map((d) => d.drug_code), [CODES[3]]);
  assert.equal(chain[0].attachments[0].orig_name, '合約.pdf');
  assert.throws(() => P.addContractDrug(data, ctx, k1.id, CODES[0]), (e) => e.code === 'DUPLICATE');
  assert.deepEqual(P.listContracts(data, { drugCode: CODES[3] }).map((c) => c.contract_no), ['K-001-補1']);
});

test('T20 合約到期：提醒檢視，不自動取消認定、註記或價格；無到期日不猜測', async () => {
  const { data, ctx, rev } = await setup();
  const k = signedContract(data, ctx, [CODES[0]], { expiry_date: '2026-12-01' });
  P.createContract(data, ctx, { contract_no: 'K-NOEXP', signed_date: '2026-01-01', status: '完成簽署' });
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], contract_requirement: '須簽約', contract_id: k.id, ...ready() });
  const an = P.createAnnotation(data, ctx, { drug_code: CODES[0], action: '新增', category: '特殊藥品', price_action_id: a.id, effective_date: '2026-04-01' });
  P.confirmAnnouncement(data, ctx, { priceActionIds: [a.id], annotationIds: [an.id] });
  assert.deepEqual(P.contractAlerts(data, '2026-11-07').map((x) => [x.contract_no, x.alert]), [['K-001', '即將到期']]);
  assert.deepEqual(P.contractAlerts(data, '2027-01-01').map((x) => x.alert), ['已到期']);
  assert.equal(P.contractExpiryText({ expiry_date: null }, '2027-01-01'), '無到期日（不推定）');
  assert.equal(P.annotationOn(data, CODES[0], '2027-06-01').category, '特殊藥品');
  assert.equal(a.confirm_status, '已確認');
  assert.equal(RC.statusOn(data, rev.recognition_id, '2027-06-01').state, '有效');
});

test('註記事件：取消／更正須依據；更正指向原事件；未確認調高不可單獨確認新增註記', async () => {
  const { data, ctx, rev } = await setup();
  const a = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0], ...ready() });
  const an = P.createAnnotation(data, ctx, { drug_code: CODES[0], action: '新增', category: '特殊藥品', price_action_id: a.id });
  assert.throws(() => P.confirmAnnouncement(data, ctx, { annotationIds: [an.id] }), (e) => /缺註記生效日/.test(e.message) && /尚未確認/.test(e.message));
  P.updateAnnotation(data, ctx, an.id, { effective_date: '2026-05-01' });
  assert.throws(() => P.updateAnnotation(data, ctx, an.id, { action: '取消' }), (e) => e.code === 'FIELD_PROTECTED');
  P.confirmAnnouncement(data, ctx, { priceActionIds: [a.id], annotationIds: [an.id] });
  assert.throws(() => P.createAnnotation(data, ctx, { drug_code: CODES[0], action: '取消' }), /依據/);
  assert.throws(() => P.createAnnotation(data, ctx, { drug_code: CODES[0], action: '更正', basis: 'x' }), /原註記事件/);
  const fix = P.createAnnotation(data, ctx, { drug_code: CODES[0], action: '更正', basis: '生效日誤植', original_event_id: an.id, category: '特殊藥品', effective_date: '2026-04-01' });
  P.confirmAnnouncement(data, ctx, { annotationIds: [fix.id] });
  assert.equal(P.annotationOn(data, CODES[0], '2026-04-15').category, '特殊藥品');
  const cancel = P.createAnnotation(data, ctx, { drug_code: CODES[0], action: '取消', basis: '取消認定公告', effective_date: '2027-01-01' });
  P.confirmAnnouncement(data, ctx, { annotationIds: [cancel.id] });
  assert.equal(P.annotationOn(data, CODES[0], '2027-01-02').category, null);
  assert.equal(P.annotationOn(data, CODES[0], '2026-12-31').category, '特殊藥品');
  const und = P.createAnnotation(data, ctx, { drug_code: CODES[1], action: '取消', basis: '歷史資料' });
  assert.equal(und.effective_date, null);
  // 撤銷調高時，連結之未確認註記一併撤銷
  const b = P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[2] });
  const bn = P.createAnnotation(data, ctx, { drug_code: CODES[2], action: '新增', category: '特殊藥品', price_action_id: b.id });
  P.withdrawPriceAction(data, ctx, b.id, '誤建');
  assert.equal(bn.confirm_status, '撤銷');
});

test('取消認定版本不可建立調高', async () => {
  const { data, ctx, imp } = await setup();
  const rec = RC.createRecognition(data, ctx, { name: '取消' });
  const rev = RC.createRevision(data, ctx, rec.id, { category: '取消認定', effective_from: '2026-01-01' });
  assert.throws(() => P.createPriceAction(data, ctx, { revision_id: rev.id, drug_code: CODES[0] }), (e) => e.code === 'BAD_CATEGORY');
  assert.ok(imp);
});

// ---------- 透過 session（op_id、附件、儲存） ----------
async function sessionSetup() {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  let revId;
  await a.run((d, k) => { addImport(d, k); });
  const imp = a.work.collections.master_import[0];
  const pv = await R.previewRule({ field: 'group_code', op: 'in', values: ['G1'] }, rowsOf(CODES), imp, {});
  await a.run((d, k) => {
    const rec = RC.createRecognition(d, k, { name: '認定S' });
    const rev = RC.createRevision(d, k, rec.id, { category: '不可替代特殊藥品', rule: { field: 'group_code', op: 'in', values: ['G1'] }, effective_from: '2026-01-01', completeness: '完整' });
    const snap = RC.saveSnapshot(d, k, rev.id, d.collections.master_import[0], pv);
    RC.confirmSnapshot(d, k, snap.id);
    RC.confirmRevision(d, k, rev.id);
    revId = rev.id;
  });
  const ids = await a.run((d, k) => {
    const pas = P.createPriceActions(d, k, revId, [CODES[0], CODES[1]], { contract_requirement: '當時無須簽約', requirement_basis: '歷史', ...ready() });
    return pas.map((p) => p.id);
  });
  return { w, a, revId, ids };
}

test('T17 確認對話框重複點擊或重送：同 op_id 只產生一份正式結果', async () => {
  const { w, a, ids } = await sessionSetup();
  const r1 = await P.confirmAnnouncementWithFiles(a, { priceActionIds: ids }, [], { opId: 'op-confirm-1' });
  const n1 = a.pending.length;
  const r2 = await P.confirmAnnouncementWithFiles(a, { priceActionIds: ids }, [], { opId: 'op-confirm-1' });
  assert.equal(r2.replayed, true);
  assert.equal(a.pending.length, n1);
  assert.deepEqual(r1.price_actions, ids);
  await a.save();
  const o = await openFolder(w.store.client());
  assert.equal(o.audit.filter((e) => e.entity === 'price_action' && e.action === '確認').length, 2);
  assert.equal(o.data.collections.op_log.filter((x) => x.op_id === 'op-confirm-1').length, 1);
});

test('T18 附件寫入失敗或資料驗證失敗：整批不成立，不存半完成狀態', async () => {
  const { w, a, ids } = await sessionSetup();
  const before = JSON.stringify(a.work);
  // 附件寫入失敗
  const orig = a.fs.create.bind(a.fs);
  a.fs.create = async (p, b) => { if (p.startsWith('attachments/')) throw new Error('磁碟已滿'); return orig(p, b); };
  await assert.rejects(() => P.confirmAnnouncementWithFiles(a, { priceActionIds: ids }, [{ name: '公告.pdf', bytes: new Uint8Array([1, 2, 3]) }], { opId: 'op-x' }), /磁碟已滿/);
  assert.equal(JSON.stringify(a.work), before);
  a.fs.create = orig;
  // 驗證失敗（其中一筆缺公告文號）：整批不成立
  const third = await a.run((d, k) => P.createPriceAction(d, k, { revision_id: d.collections.recognition_revision[0].id, drug_code: CODES[2] }).id);
  const mid = JSON.stringify(a.work);
  await assert.rejects(() => P.confirmAnnouncementWithFiles(a, { priceActionIds: [...ids, third] }, [{ name: '公告.pdf', bytes: new Uint8Array([1, 2, 3]) }], { opId: 'op-y' }), (e) => e.code === 'VALIDATION');
  assert.equal(JSON.stringify(a.work), mid);
  assert.ok(a.work.collections.price_action.every((p) => p.confirm_status === '草稿'));
  // 正常：附件與確認同批成立，儲存後附件可驗
  const r = await P.confirmAnnouncementWithFiles(a, { priceActionIds: ids }, [{ name: '公告.pdf', bytes: new Uint8Array([1, 2, 3]) }], { opId: 'op-z' });
  assert.equal(r.attachments, 1);
  await a.save();
  const o = await openFolder(w.store.client());
  assert.equal(P.attachmentsOf(o.data, 'price_action', ids[0])[0].orig_name, '公告.pdf');
  assert.equal(P.attachmentsOf(o.data, 'price_action', ids[1]).length, 1);
});
