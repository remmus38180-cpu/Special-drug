// 階段3：基本收案及歷次會議（T33–T36、T39、T40，及收案、結案、再提、決議更正）
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from '../src/core/dataset.js';
import * as C from '../src/core/cases.js';
import { insert, setConfirmStatus, update } from '../src/core/model.js';
import { world, initWith } from './helpers.mjs';
import { openFolder } from '../src/core/folder.js';

let n = 0;
function setup() {
  const data = emptyData();
  const ctx = { actor: '承辦A／PC-01', now: '2026-11-06T02:00:00.000Z', newId: () => `id-${++n}`, events: [] };
  return { data, ctx };
}
const cdOf = (data, caseId, code) => data.collections.case_drug.find((d) => d.case_id === caseId && d.drug_code === code).id;

test('收案：自動案號、缺收文資料標示待確認、品項代碼保留原樣', () => {
  const { data, ctx } = setup();
  const c = C.createCase(data, ctx, { subject: ' 甲案 ', drugs: ['0A00001100', { drug_code: 'B00002', drug_name_text: '乙' }] });
  assert.equal(c.case_no, 'SD2026-0001');
  assert.equal(c.subject, '甲案');
  assert.equal(c.completeness, '待確認');
  assert.equal(c.pending_fields, 'recv_date,recv_doc_no,applicant');
  assert.deepEqual(C.caseDrugs(data, c.id).map((d) => d.drug_code), ['0A00001100', 'B00002']);
  const c2 = C.createCase(data, ctx, { subject: '乙案', applicant: '廠', recv_date: '115/03/02', recv_doc_no: '1150001' });
  assert.equal(c2.case_no, 'SD2026-0002');
  assert.equal(c2.recv_date, '2026-03-02');
  assert.equal(c2.completeness, '完整');
  assert.throws(() => C.createCase(data, ctx, { subject: '丙', recv_date: '三月' }), (e) => e.code === 'BAD_DATE');
  assert.throws(() => C.createCase(data, ctx, { subject: '' }), (e) => e.code === 'REQUIRED');
  assert.throws(() => C.addCaseDrug(data, ctx, c.id, { drug_code: '0A00001100' }), (e) => e.code === 'DUPLICATE');
  assert.throws(() => C.addCaseDrug(data, ctx, c.id, { drug_code: 12345 }), (e) => e.code === 'BAD_CODE');
  assert.throws(() => C.updateCase(data, ctx, c.id, { status: '已結案' }), /結案/);
  assert.throws(() => C.updateCase(data, ctx, c.id, { result_summary: '全部同意' }), (e) => e.code === 'FIELD_NOT_ALLOWED');
});

test('T33 建立未通過案件並登錄兩種會議：無認定仍可保存，查詢可見完整歷程', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  const id = await a.run((d, k) => {
    const c = C.createCase(d, k, { subject: '未通過案', applicant: '甲', drugs: ['A000001100'] });
    const cd = cdOf(d, c.id, 'A000001100');
    const m1 = C.createMeeting(d, k, { meeting_type: '專家', name: '專家會議115年3月', meeting_date: '2026-03-10' });
    const m2 = C.createMeeting(d, k, { meeting_type: '共同擬訂', name: '擬訂會議115年4月', meeting_date: '2026-04-16' });
    const d1 = C.addDecision(d, k, { agenda_id: C.addAgenda(d, k, { meeting_id: m1.id, case_id: c.id }).id, nature: '專家建議', result: '不同意', drugResults: { [cd]: '不同意' } });
    const d2 = C.addDecision(d, k, { agenda_id: C.addAgenda(d, k, { meeting_id: m2.id, case_id: c.id }).id, nature: '會議決議', result: '不同意', drugResults: { [cd]: '不同意' } });
    C.setCaseSummary(d, k, c.id, { summary: '全部不同意', decisionIds: [d1.id, d2.id] });
    C.closeCase(d, k, c.id, { status: '已結案', reason: '共擬不同意', basis: '擬訂會議115年4月紀錄' });
    return c.id;
  });
  await a.save();
  const o = await openFolder(w.store.client());
  const tl = C.caseTimeline(o.data, id);
  assert.deepEqual(tl.map((x) => x.meeting_type), ['專家', '共同擬訂']);
  assert.deepEqual(tl.map((x) => x.decisions[0].nature), ['專家建議', '會議決議']);
  assert.equal(o.data.collections.recognition.length, 0);
  assert.equal(C.listCases(o.data, { summary: '全部不同意' })[0].id, id);
  assert.equal(C.listCases(o.data, { status: '已結案' })[0].close_reason, '共擬不同意');
  assert.ok(o.audit.some((e) => e.action === '結案' && e.entity_id === id));
});

test('T34 專家補件、重提後同意、共擬不同意：三次結果分別保存；摘要須有依據；專家同意不當最終通過', () => {
  const { data, ctx } = setup();
  const c = C.createCase(data, ctx, { subject: 'T34', drugs: ['A000001100'] });
  const cd = cdOf(data, c.id, 'A000001100');
  const m1 = C.createMeeting(data, ctx, { meeting_type: '專家', name: '專家1', meeting_date: '2026-01-01' });
  const m2 = C.createMeeting(data, ctx, { meeting_type: '專家', name: '專家2', meeting_date: '2026-03-01' });
  const m3 = C.createMeeting(data, ctx, { meeting_type: '共同擬訂', name: '共擬', meeting_date: '2026-05-01' });
  // 故意倒序建立，時間序列仍依會議日期
  const d3 = C.addDecision(data, ctx, { agenda_id: C.addAgenda(data, ctx, { meeting_id: m3.id, case_id: c.id }).id, nature: '會議決議', result: '不同意', drugResults: { [cd]: '不同意' } });
  C.addDecision(data, ctx, { agenda_id: C.addAgenda(data, ctx, { meeting_id: m1.id, case_id: c.id }).id, nature: '專家建議', result: '補充資料後再議', drugResults: { [cd]: '補充資料後再議' } });
  C.addDecision(data, ctx, { agenda_id: C.addAgenda(data, ctx, { meeting_id: m2.id, case_id: c.id }).id, nature: '專家建議', result: '同意', drugResults: { [cd]: '同意' } });
  assert.deepEqual(C.caseTimeline(data, c.id).map((x) => x.decisions[0].result), ['補充資料後再議', '同意', '不同意']);
  assert.deepEqual(C.drugFollowupBasis(data, c.id, 'A000001100'), []);
  assert.throws(() => C.setCaseSummary(data, ctx, c.id, { summary: '全部不同意', decisionIds: [] }), /依據/);
  C.setCaseSummary(data, ctx, c.id, { summary: '全部不同意', decisionIds: [d3.id] });
  assert.equal(data.collections.case_record[0].result_summary, '全部不同意');
  assert.equal(data.collections.case_record[0].result_confirmed_by, '承辦A／PC-01');
  assert.throws(() => C.setCaseSummary(data, ctx, c.id, { summary: '其他', decisionIds: [d3.id] }), /說明/);
});

test('T35 同案三品項同次會議分別同意、不同意、暫緩：各品項獨立；只有同意者可接續', () => {
  const { data, ctx } = setup();
  const c = C.createCase(data, ctx, { subject: 'T35', drugs: ['A000001100', 'A000002100', 'A000006100'] });
  const m = C.createMeeting(data, ctx, { meeting_type: '共同擬訂', name: '共擬T35', meeting_date: '2026-06-01' });
  assert.throws(() => C.addDecision(data, ctx, { agenda_id: C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c.id }).id, nature: '會議決議', result: '其他' }), /說明/);
  const ag = C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c.id, agenda_no: '2' });
  C.addDecision(data, ctx, {
    agenda_id: ag.id, nature: '會議決議', result: '其他', result_text: '逐品項不同',
    drugResults: { [cdOf(data, c.id, 'A000001100')]: '同意', [cdOf(data, c.id, 'A000002100')]: '不同意', [cdOf(data, c.id, 'A000006100')]: '暫緩' },
  });
  assert.equal(C.drugFollowupBasis(data, c.id, 'A000001100').length, 1);
  assert.equal(C.drugFollowupBasis(data, c.id, 'A000002100').length, 0);
  assert.equal(C.drugFollowupBasis(data, c.id, 'A000006100').length, 0);
});

test('T36 同次會議處理多案：共用會議，議案與決議各自關聯，不串錯案件', () => {
  const { data, ctx } = setup();
  const m = C.createMeeting(data, ctx, { meeting_type: '共同擬訂', name: '擬訂會議115年6月', meeting_date: '2026-06-18' });
  assert.throws(() => C.createMeeting(data, ctx, { meeting_type: '共同擬訂', name: '擬訂會議115年6月', meeting_date: '2026-06-18' }), (e) => e.code === 'DUPLICATE' && e.detail.id === m.id);
  const c1 = C.createCase(data, ctx, { subject: '甲案', drugs: ['A000001100'] });
  const c2 = C.createCase(data, ctx, { subject: '乙案', drugs: ['A000002100'] });
  const a1 = C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c1.id, agenda_no: '1' });
  const a2 = C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c2.id, agenda_no: '2' });
  const d1 = C.addDecision(data, ctx, { agenda_id: a1.id, nature: '會議決議', result: '同意' });
  C.addDecision(data, ctx, { agenda_id: a2.id, nature: '會議決議', result: '不同意' });
  assert.equal(C.caseTimeline(data, c1.id)[0].decisions[0].result, '同意');
  assert.equal(C.caseTimeline(data, c2.id)[0].decisions[0].result, '不同意');
  assert.throws(() => C.setDecisionDrug(data, ctx, d1.id, cdOf(data, c2.id, 'A000002100'), { result: '同意' }), /不能串接/);
  assert.throws(() => C.addDecision(data, ctx, { agenda_id: a1.id, nature: '會議決議', result: '同意', drugResults: { [cdOf(data, c2.id, 'A000002100')]: '同意' } }), /不能串接/);
  assert.equal(data.collections.meeting.length, 1);
  assert.deepEqual(C.meetingAgendas(data, m.id).map((x) => x.case_subject), ['甲案', '乙案']);
  assert.equal(C.listMeetings(data)[0].agenda_count, 2);
});

test('T39 已有有效認定品項的新申請被否決：新案保留不同意，既有認定不被自動取消', () => {
  const { data, ctx } = setup();
  const r = insert(data, ctx, 'recognition', { recognition_no: 'R1', name: '既有認定' });
  const rev = insert(data, ctx, 'recognition_revision', { recognition_id: r.id, revision_no: 1, category: '特殊藥品', effective_from: '2025-01-01', rule: { field: 'drug_code', op: 'eq', value: 'B000004100' } });
  setConfirmStatus(data, ctx, 'recognition_revision', rev.id, '已確認');
  const an = insert(data, ctx, 'annotation_event', { drug_code: 'B000004100', revision_id: rev.id, category: '特殊藥品', action: '新增', effective_date: '2025-01-01' });
  setConfirmStatus(data, ctx, 'annotation_event', an.id, '已確認');
  const before = JSON.stringify({ r: data.collections.recognition_revision, a: data.collections.annotation_event });
  const c = C.createCase(data, ctx, { subject: '新申請', drugs: ['B000004100'] });
  const m = C.createMeeting(data, ctx, { meeting_type: '共同擬訂', name: '共擬T39', meeting_date: '2026-08-01' });
  const d = C.addDecision(data, ctx, { agenda_id: C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c.id }).id, nature: '會議決議', result: '不同意', drugResults: { [cdOf(data, c.id, 'B000004100')]: '不同意' } });
  C.setCaseSummary(data, ctx, c.id, { summary: '全部不同意', decisionIds: [d.id] });
  C.closeCase(data, ctx, c.id, { status: '已結案', reason: '不同意', basis: '共擬T39紀錄' });
  assert.equal(JSON.stringify({ r: data.collections.recognition_revision, a: data.collections.annotation_event }), before);
  assert.equal(data.collections.recognition_revision[0].confirm_status, '已確認');
});

test('T40 未提供未通過案件來源：不生成假案件；提供人工補登入口', () => {
  const { data, ctx } = setup();
  assert.equal(data.collections.case_record.length, 0);
  const c = C.createCase(data, ctx, { subject: '人工補登之未通過案', applicant: '乙', completeness: '不完整', notes: '依115年紙本卷宗補登' });
  assert.equal(C.listCases(data, { keyword: '人工補登' })[0].id, c.id);
  assert.equal(C.listCases(data, { completeness: '不完整' }).length, 1);
  assert.equal(c.result_summary, '尚無結論');
});

test('結案須原因與依據；結案後不可改狀態；再提開新案並保留前案關聯', () => {
  const { data, ctx } = setup();
  const c = C.createCase(data, ctx, { subject: '原案', applicant: '甲', drugs: ['A1', 'A2'] });
  assert.throws(() => C.closeCase(data, ctx, c.id, { status: '撤回', reason: '廠商撤回' }), /原因與依據/);
  C.closeCase(data, ctx, c.id, { status: '撤回', reason: '廠商撤回', basis: '撤回函1150101' });
  assert.throws(() => C.closeCase(data, ctx, c.id, { status: '已結案', reason: 'x', basis: 'y' }), (e) => e.code === 'CASE_CLOSED');
  assert.throws(() => C.updateCase(data, ctx, c.id, { status: '辦理中' }), (e) => e.code === 'CASE_CLOSED');
  C.updateCase(data, ctx, c.id, { notes: '補記' });
  const r = C.reopenAsNew(data, ctx, c.id, { recv_date: '2026-09-01' });
  assert.equal(r.prior_case_id, c.id);
  assert.equal(r.subject, '原案');
  assert.deepEqual(C.caseDrugs(data, r.id).map((x) => x.drug_code), ['A1', 'A2']);
  assert.equal(data.collections.case_record.find((x) => x.id === c.id).status, '撤回');
});

test('決議更正：新增取代紀錄，不覆蓋原決議；被更正之會議決議不作接續依據', () => {
  const { data, ctx } = setup();
  const c = C.createCase(data, ctx, { subject: '更正', drugs: ['A1'] });
  const cd = cdOf(data, c.id, 'A1');
  const m = C.createMeeting(data, ctx, { meeting_type: '共同擬訂', name: '共擬', meeting_date: '2026-06-01' });
  const ag = C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c.id });
  const d1 = C.addDecision(data, ctx, { agenda_id: ag.id, nature: '會議決議', result: '同意', drugResults: { [cd]: '同意' } });
  assert.equal(C.drugFollowupBasis(data, c.id, 'A1').length, 1);
  assert.throws(() => C.addDecision(data, ctx, { agenda_id: ag.id, nature: '會議決議', result: '不同意', supersedes_id: d1.id }), /原因/);
  const d2 = C.addDecision(data, ctx, { agenda_id: ag.id, nature: '會議決議', result: '不同意', supersedes_id: d1.id, correction_reason: '紀錄誤植', drugResults: { [cd]: '不同意' } });
  assert.equal(data.collections.decision.find((x) => x.id === d1.id).result, '同意');
  assert.equal(C.drugFollowupBasis(data, c.id, 'A1').length, 0);
  const tl = C.caseTimeline(data, c.id)[0].decisions;
  assert.deepEqual(tl.map((x) => [x.id, x.superseded]), [[d1.id, true], [d2.id, false]]);
  assert.throws(() => C.addDecision(data, ctx, { agenda_id: ag.id, nature: '會議決議', result: '同意', supersedes_id: d1.id, correction_reason: 'x' }), /最新一筆/);
  assert.throws(() => update(data, ctx, 'decision', d1.id, { result: '不同意', supersedes_id: d2.id }), (e) => e.code === 'FIELD_FIXED');
});

test('Q10暫採：逐品項結果可改，稽核留前後差異', () => {
  const { data, ctx } = setup();
  const c = C.createCase(data, ctx, { subject: 'Q10', drugs: ['A1'] });
  const cd = cdOf(data, c.id, 'A1');
  const m = C.createMeeting(data, ctx, { meeting_type: '專家', name: '專家', meeting_date: '2026-06-01' });
  const d = C.addDecision(data, ctx, { agenda_id: C.addAgenda(data, ctx, { meeting_id: m.id, case_id: c.id }).id, nature: '專家建議', result: '同意', drugResults: { [cd]: '同意' } });
  ctx.events.length = 0;
  C.setDecisionDrug(data, ctx, d.id, cd, { result: '暫緩', note: '更正' }, { reason: '紀錄誤植' });
  assert.equal(ctx.events[0].action, '修改');
  assert.deepEqual(ctx.events[0].diff.result, { from: '同意', to: '暫緩' });
  assert.equal(ctx.events[0].reason, '紀錄誤植');
});
