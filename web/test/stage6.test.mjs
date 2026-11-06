// 階段6：認定項目、版本、快照、分組調價方式（T07後半、T08範圍部分、T11、T12、T13、T19、M5、全域排除）
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from '../src/core/dataset.js';
import * as RC from '../src/core/recognition.js';
import * as R from '../src/core/rules.js';
import { insert, setDedicated, update } from '../src/core/model.js';

let n = 0;
const F = ['drug_code', 'drug_name', 'group_code', 'atc_code', 'dose_code', 'multi_mark', 'spec_qty', 'spec_unit', 'web_hidden'];
function mkRows(list) {
  return { byCode: new Map(list.map((r) => { const o = {}; F.forEach((k, i) => { o[k] = r[i] ?? null; }); return [o.drug_code, o]; })) };
}
const BASE = [
  ['A000001100', 'A1', 'G1', 'J06BA01', '20', 'N', '5', 'ML', 'N'],
  ['A000002100', 'A2', 'G1', 'J06BA01', '20', 'N', '10', 'ML', 'N'],
  ['B000004100', 'C1', 'G3', 'L04AA03', '11', 'Y', null, null, 'N'],
  ['TPN0000001', 'TPN', null, 'B05BA10', '20', 'N', null, null, 'Y'],
  ['X000000900', 'HIDE', 'G1', 'J06BA01', '20', 'N', '5', 'ML', 'Y'],
  ['N000000100', 'NOGROUP', null, 'J06BA01', '20', 'N', null, null, 'N'],
];
function setup(rowsList = BASE) {
  const data = emptyData();
  const ctx = { actor: '承辦A／PC-01', now: '2026-11-07T02:00:00.000Z', newId: () => `id-${++n}`, events: [] };
  const imp = insert(data, ctx, 'master_import', { source_name: 'm.csv', sha256: 'x'.repeat(64), base_date: '2026-11-01', row_count: rowsList.length, status: '已啟用',
    check: { disabled_rule_fields: [], known_units: ['ML'] }, rows_file: 'masters/x.json', rows_sha256: 'y' });
  return { data, ctx, imp, rows: mkRows(rowsList) };
}
const EX = R.exclusionOf({ scope_exclude_code_prefixes: 'TPN', scope_exclude_web_hidden: true });

async function recognized(env, rule, { name = '認定', category = '特殊藥品', eff = '2020-01-01', confirm = true, decide = '排除' } = {}) {
  const { data, ctx, imp, rows } = env;
  const rec = RC.createRecognition(data, ctx, { name });
  const rev = RC.createRevision(data, ctx, rec.id, { category, rule, effective_from: eff, completeness: '完整' });
  const pv = await R.previewRule(rule, rows, imp, { exclusions: EX });
  const snap = RC.saveSnapshot(data, ctx, rev.id, imp, pv);
  for (const m of RC.snapshotMemberList(data, snap.id)) if (m.eval_result === '待確認') RC.setMemberDecision(data, ctx, snap.id, m.drug_code, decide, '測試人工確認');
  RC.confirmSnapshot(data, ctx, snap.id);
  if (confirm) RC.confirmRevision(data, ctx, rev.id);
  return { rec, rev, snap };
}

test('全域排除：代碼前綴TPN、不上網註＝Y 不列入範圍；分組代碼空白視為不符合', async () => {
  const env = setup();
  const pv = await R.previewRule({ field: 'atc_code', op: 'starts_with', value: '' + 'J06B' }, env.rows, env.imp, { exclusions: EX });
  assert.deepEqual(pv.members.map((m) => m.drug_code), ['A000001100', 'A000002100', 'N000000100']);
  assert.deepEqual(pv.excluded, { '不上網註＝Y': 1 });
  const pv2 = await R.previewRule({ field: 'atc_code', op: 'eq', value: 'B05BA10' }, env.rows, env.imp, { exclusions: EX });
  assert.deepEqual(pv2.excluded, { '代碼前綴TPN': 1 });
  assert.ok(pv2.warnings.some((w) => w.includes('全域排除')));
  const pv3 = await R.previewRule({ field: 'group_code', op: 'in', values: ['G1'] }, env.rows, env.imp, { exclusions: EX });
  assert.deepEqual(pv3.members.map((m) => [m.drug_code, m.result]), [['A000001100', '符合'], ['A000002100', '符合']]);
  assert.equal(pv3.pending, 0);
  // 排除群組內分組空白：非(不符合)＝符合
  const pv4 = await R.previewRule({ op: 'and', children: [{ field: 'atc_code', op: 'eq', value: 'J06BA01' }, { op: 'not', child: { field: 'group_code', op: 'eq', value: 'G1' } }] }, env.rows, env.imp, { exclusions: EX });
  assert.deepEqual(pv4.members.map((m) => m.drug_code), ['N000000100']);
  // 未映射不上網註：提示未套用
  const env2 = setup(BASE.map((r) => r.slice(0, 8)));
  const pv5 = await R.previewRule({ field: 'atc_code', op: 'eq', value: 'J06BA01' }, env2.rows, env2.imp, { exclusions: EX });
  assert.ok(pv5.warnings.some((w) => w.includes('未映射「不上網註」')));
  assert.equal(R.exclusionOf({ scope_exclude_code_prefixes: 'TPN, ABC', scope_exclude_web_hidden: false }).code_prefixes.join(), 'TPN,ABC');
});

test('認定項目：同名不可重複（改建變更版本）；版本序號遞增；完整性自動判定', () => {
  const { data, ctx } = setup();
  const r = RC.createRecognition(data, ctx, { name: '模擬' });
  assert.equal(r.recognition_no, 'R00001');
  assert.throws(() => RC.createRecognition(data, ctx, { name: '模擬' }), (e) => e.code === 'DUPLICATE');
  const v1 = RC.createRevision(data, ctx, r.id, { category: '特殊藥品' });
  const v2 = RC.createRevision(data, ctx, r.id, { category: '特殊藥品', effective_from: '115/08/01', effective_to: '2027-08-01' });
  assert.deepEqual([v1.revision_no, v2.revision_no], [1, 2]);
  assert.equal(v1.completeness, '不完整');
  assert.equal(v2.effective_from, '2026-08-01');
  assert.throws(() => RC.createRevision(data, ctx, r.id, { category: '必要藥品' }), (e) => e.code === 'BAD_VALUE');
  assert.throws(() => RC.createRevision(data, ctx, r.id, { category: '特殊藥品', effective_from: '2026-08-01', effective_to: '2026-08-01' }), /迄日/);
  assert.throws(() => RC.createRevision(data, ctx, r.id, { category: '特殊藥品', rule: { op: 'and', children: [] } }), (e) => e.code === 'RULE');
  assert.throws(() => RC.updateRevision(data, ctx, v1.id, { confirm_status: '已確認' }), (e) => e.code === 'FIELD_NOT_ALLOWED');
  RC.submitRevision(data, ctx, v1.id);
  assert.equal(v1.confirm_status, '待確認');
  RC.withdrawRevision(data, ctx, v1.id, '重複建立');
  assert.equal(v1.confirm_status, '撤銷');
});

test('T07（後半）跨品項人工條件：快照全為待確認；未人工確認不能確認快照／認定；批次確認後可確認', async () => {
  const env = setup();
  const { data, ctx, imp, rows } = env;
  const rule = { op: 'and', children: [{ field: 'group_code', op: 'eq', value: 'G1' }, { op: 'manual', text: '同廠牌尚有不同規格品項' }] };
  const rec = RC.createRecognition(data, ctx, { name: 'Warfarin' });
  const rev = RC.createRevision(data, ctx, rec.id, { category: '不可替代特殊藥品', rule, effective_from: '2020-01-01' });
  const pv = await R.previewRule(rule, rows, imp, { exclusions: EX });
  const snap = RC.saveSnapshot(data, ctx, rev.id, imp, pv);
  assert.deepEqual([...new Set(RC.snapshotMemberList(data, snap.id).map((m) => m.eval_result))], ['待確認']);
  assert.throws(() => RC.confirmSnapshot(data, ctx, snap.id), (e) => e.code === 'PENDING_UNDECIDED');
  assert.throws(() => RC.confirmRevision(data, ctx, rev.id), (e) => e.code === 'NO_SNAPSHOT');
  assert.deepEqual(RC.snapshotFinal(data, snap.id), []);
  assert.deepEqual(RC.pendingReasonCounts(RC.snapshotMemberList(data, snap.id)), { 人工條件: 2 });
  assert.throws(() => RC.bulkMemberDecision(data, ctx, snap.id, '人工條件', '納入', ''), (e) => e.code === 'REQUIRED');
  assert.equal(RC.bulkMemberDecision(data, ctx, snap.id, '人工條件', '納入', '人工核對同廠牌'), 2);
  assert.ok(ctx.events.some((e) => e.action === '批次人工確認' && e.diff.count === 2));
  RC.confirmSnapshot(data, ctx, snap.id);
  assert.equal(RC.snapshotFinal(data, snap.id).length, 2);
  assert.throws(() => RC.setMemberDecision(data, ctx, snap.id, 'A000001100', '排除', 'x'), (e) => e.code === 'CONFIRMED_READONLY');
  RC.confirmRevision(data, ctx, rev.id);
  assert.equal(rev.confirm_status, '已確認');
});

test('T08（範圍部分）範圍名單保留全部；範圍外品項不可人工納入', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => [`A0000${String(i).padStart(2, '0')}100`, `D${i}`, 'G9', 'A01AA01', '11', 'N', null, null, 'N']);
  const env = setup(rows);
  const { rev, snap } = await recognized(env, { field: 'group_code', op: 'eq', value: 'G9' });
  assert.equal(RC.revisionScope(env.data, rev.id).size, 10);
  assert.throws(() => RC.setMemberDecision(env.data, env.ctx, snap.id, 'Z999999999', '納入', 'x'), (e) => e.code === 'CONFIRMED_READONLY' || e.code === 'OUT_OF_SCOPE');
});

test('預覽後規則或主檔改變須重新預覽；快照只採已啟用主檔', async () => {
  const env = setup();
  const { data, ctx, imp, rows } = env;
  const rec = RC.createRecognition(data, ctx, { name: 'X' });
  const rule = { field: 'group_code', op: 'eq', value: 'G1' };
  const rev = RC.createRevision(data, ctx, rec.id, { category: '特殊藥品', rule, effective_from: '2020-01-01' });
  const pv = await R.previewRule(rule, rows, imp, { exclusions: EX });
  RC.updateRevision(data, ctx, rev.id, { rule: { field: 'group_code', op: 'eq', value: 'G3' } });
  assert.throws(() => RC.saveSnapshot(data, ctx, rev.id, imp, pv), (e) => e.code === 'PREVIEW_STALE');
  const pv2 = await R.previewRule(rev.rule, rows, imp, { exclusions: EX });
  const snap = RC.saveSnapshot(data, ctx, rev.id, imp, pv2);
  RC.updateRevision(data, ctx, rev.id, { rule: { field: 'group_code', op: 'eq', value: 'G1' } });
  assert.throws(() => RC.confirmSnapshot(data, ctx, snap.id), (e) => e.code === 'PREVIEW_STALE');
  setDedicated(data, ctx, 'master_import', imp.id, { status: '已停用' }, { action: 't', fields: ['status'] });
  const pv3 = await R.previewRule(rev.rule, rows, { ...imp, status: '已啟用' }, { exclusions: EX });
  assert.throws(() => RC.saveSnapshot(data, ctx, rev.id, imp, pv3), (e) => e.code === 'MASTER_NOT_ACTIVE');
});

test('T11 已確認但下月生效：今日待生效，指定下月日期有效', async () => {
  const env = setup();
  const { rec } = await recognized(env, { field: 'drug_code', op: 'eq', value: 'B000004100' }, { eff: '2026-12-01' });
  assert.equal(RC.statusOn(env.data, rec.id, '2026-11-07').state, '待生效');
  assert.equal(RC.statusOn(env.data, rec.id, '2026-12-01').state, '有效');
});

test('T12 取消後重新認定：各段歷史正確，原版本與快照不被覆寫', async () => {
  const env = setup();
  const { data, ctx, imp, rows } = env;
  const rule = { field: 'drug_code', op: 'eq', value: 'B000004100' };
  const { rec, rev: rev1, snap: snap1 } = await recognized(env, rule, { eff: '2020-01-01' });
  const rev2 = RC.createRevision(data, ctx, rec.id, { category: '取消認定', effective_from: '2022-01-01', completeness: '完整' });
  RC.confirmRevision(data, ctx, rev2.id);
  const rev3 = RC.createRevision(data, ctx, rec.id, { category: '不可替代特殊藥品', rule, effective_from: '2024-01-01' });
  const s3 = RC.saveSnapshot(data, ctx, rev3.id, imp, await R.previewRule(rule, rows, imp, { exclusions: EX }));
  RC.confirmSnapshot(data, ctx, s3.id);
  RC.confirmRevision(data, ctx, rev3.id);
  assert.equal(RC.statusOn(data, rec.id, '2021-06-01').state, '有效');
  assert.equal(RC.statusOn(data, rec.id, '2023-06-01').state, '已取消');
  const st = RC.statusOn(data, rec.id, '2025-06-01');
  assert.equal(st.state, '有效');
  assert.equal(st.revision.category, '不可替代特殊藥品');
  assert.deepEqual([rev1.confirm_status, rev1.category], ['已確認', '特殊藥品']);
  assert.equal(snap1.status, '已確認');
  assert.throws(() => RC.updateRevision(data, ctx, rev1.id, { category: '特殊藥品' }), (e) => e.code === 'CONFIRMED_READONLY');
  const hist = RC.revisionHistory(data, rec.id, '2025-06-01');
  assert.deepEqual(hist.map((h) => h.state), ['已取消', '已失效', '有效']);
  assert.equal(hist[0].period_end, '2022-01-01');
  const dr = RC.drugRecognitions(data, 'B000004100', '2025-06-01');
  assert.ok(dr.some((x) => x.category === '取消認定'));
  assert.equal(RC.drugCategoryOn(data, 'B000004100', '2023-06-01').category, null);
  assert.equal(RC.drugCategoryOn(data, 'B000004100', '2025-06-01').category, '不可替代特殊藥品');
});

test('T13／M5 新主檔多一符合品項：不自動納入；已確認認定擴增範圍須確認對話框列出新增品項並留稽核', async () => {
  const env = setup();
  const { data, ctx } = env;
  const rule = { field: 'group_code', op: 'eq', value: 'G3' };
  const { rev } = await recognized(env, rule);
  assert.deepEqual([...RC.revisionScope(data, rev.id)], ['B000004100']);
  const imp2 = insert(data, ctx, 'master_import', { source_name: 'm2.csv', sha256: 'z'.repeat(64), base_date: '2026-12-01', row_count: 7, status: '已啟用', check: { disabled_rule_fields: [] }, rows_file: 'masters/y.json', rows_sha256: 'q' });
  setDedicated(data, ctx, 'master_import', env.imp.id, { status: '已停用' }, { action: 't', fields: ['status'] });
  const rows2 = mkRows([...BASE, ['B000009100', 'C2', 'G3', 'L04AA03', '11', 'N', null, null, 'N']]);
  const snap2 = RC.saveSnapshot(data, ctx, rev.id, imp2, await R.previewRule(rule, rows2, imp2, { exclusions: EX }));
  assert.deepEqual(RC.snapshotAddedCodes(data, snap2.id), ['B000009100']);
  assert.deepEqual([...RC.revisionScope(data, rev.id)], ['B000004100']);
  assert.throws(() => RC.confirmSnapshot(data, ctx, snap2.id), (e) => e.code === 'NEED_ACK' && e.detail.added[0] === 'B000009100');
  assert.throws(() => RC.confirmSnapshot(data, ctx, snap2.id, { acknowledgedAdded: [] }), (e) => e.code === 'NEED_ACK');
  RC.confirmSnapshot(data, ctx, snap2.id, { acknowledgedAdded: ['B000009100'] });
  assert.deepEqual(snap2.added_codes, ['B000009100']);
  assert.ok(ctx.events.some((e) => e.action === '確認快照（擴增已確認認定範圍）'));
  assert.deepEqual([...RC.revisionScope(data, rev.id)].sort(), ['B000004100', 'B000009100']);
  // 舊快照不因新主檔重算
  const old = data.collections.scope_snapshot[0];
  assert.equal(RC.snapshotFinal(data, old.id).length, 1);
  assert.equal(data.collections.price_action.length, 0);
  assert.equal(data.collections.annotation_event.length, 0);
});

test('T19 同品項兩項認定類別衝突：須指定處理依據；查詢不產生單一類別', async () => {
  const env = setup();
  const { data, ctx, imp, rows } = env;
  const rule = { field: 'drug_code', op: 'eq', value: 'B000004100' };
  await recognized(env, rule, { name: '甲認定', category: '特殊藥品' });
  const rec2 = RC.createRecognition(data, ctx, { name: '乙認定' });
  const rev2 = RC.createRevision(data, ctx, rec2.id, { category: '不可替代特殊藥品', rule, effective_from: '2021-01-01' });
  const s = RC.saveSnapshot(data, ctx, rev2.id, imp, await R.previewRule(rule, rows, imp, { exclusions: EX }));
  RC.confirmSnapshot(data, ctx, s.id);
  assert.throws(() => RC.confirmRevision(data, ctx, rev2.id), (e) => e.code === 'CONFLICT_CATEGORY' && e.detail.conflicts.length === 1);
  RC.confirmRevision(data, ctx, rev2.id, { conflictBasis: '擬訂會議決議另案處理' });
  const r = RC.drugCategoryOn(data, 'B000004100', '2026-11-07');
  assert.equal(r.conflict, true);
  assert.equal(r.category, null);
  assert.equal(r.sources.length, 2);
  assert.ok(ctx.events.some((e) => e.reason === '衝突處理依據：擬訂會議決議另案處理'));
});

test('分組調價方式：部分涵蓋自動判定、第25條須依據、未確認起日不得確認', async () => {
  const env = setup();
  const { data, ctx } = env;
  const { rev } = await recognized(env, { op: 'and', children: [{ field: 'group_code', op: 'eq', value: 'G1' }, { field: 'spec', op: 'eq', value: '5', unit: 'ML' }] });
  assert.throws(() => RC.setGroupTreatment(data, ctx, { group_code: 'G1', revision_id: rev.id, method: '第25條' }), /部分涵蓋/);
  const gt = RC.setGroupTreatment(data, ctx, { group_code: 'G1', revision_id: rev.id, method: '第25條', basis: '共擬決議' });
  assert.equal(gt.partial_cover, true);
  assert.throws(() => RC.confirmGroupTreatment(data, ctx, gt.id), (e) => e.code === 'NEED_DATE');
  const gt2 = RC.setGroupTreatment(data, ctx, { group_code: 'G1', revision_id: rev.id, method: '待確認' });
  RC.confirmGroupTreatment(data, ctx, gt2.id);
  assert.equal(gt2.confirm_status, '已確認');
  assert.throws(() => update(data, ctx, 'group_treatment', gt2.id, { method: 'DET' }), (e) => e.code === 'CONFIRMED_READONLY');
});

test('認定清單：狀態、類別、涵蓋品項數、待確認版本、關鍵字（代碼、分組）', async () => {
  const env = setup();
  await recognized(env, { field: 'group_code', op: 'eq', value: 'G1' }, { name: '甲' });
  const rec2 = RC.createRecognition(env.data, env.ctx, { name: '乙' });
  RC.createRevision(env.data, env.ctx, rec2.id, { category: '特殊藥品' });
  const l = RC.listRecognitions(env.data, { day: '2026-11-07' });
  assert.deepEqual(l.map((x) => [x.name, x.state, x.drug_count, x.pending_revisions]), [['甲', '有效', 2, 0], ['乙', '草稿／待確認', 0, 1]]);
  assert.deepEqual(RC.listRecognitions(env.data, { day: '2026-11-07', keyword: 'A000002100' }).map((x) => x.name), ['甲']);
});
