// 階段8：查詢（T21）、差異待辦（T13、T14）、主檔註記比對（空白＝0）、匯出命名與紀錄（H15、H16）
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, DEFAULT_SETTINGS } from '../src/core/dataset.js';
import * as RC from '../src/core/recognition.js';
import * as R from '../src/core/rules.js';
import * as P from '../src/core/pricing.js';
import * as C from '../src/core/cases.js';
import * as D from '../src/core/diff.js';
import * as Q from '../src/core/query.js';
import * as X from '../src/core/exporter.js';
import { insert } from '../src/core/model.js';
import { readZip } from '../src/core/zip.js';
import { sha256Bytes } from '../src/core/util.js';
import { MemStore } from '../src/adapters/memfs.js';

let n = 0;
const ctx = () => ({ actor: '承辦A／PC-01', now: '2026-11-07T02:00:00.000Z', newId: () => `id-${++n}`, events: [] });
function rowsOf(list) {
  return { byCode: new Map(list.map(([c, g, ann]) => [c, { drug_code: c, drug_name: 'N' + c, group_code: g, atc_code: 'J06BA01', annotation: ann ?? '0' }])) };
}
function imp(data, k, base = '2026-11-01') {
  return insert(data, k, 'master_import', { source_name: `m${base}.csv`, sha256: 'x'.repeat(64), base_date: base, row_count: 3, status: '已啟用',
    check: { disabled_rule_fields: [], known_units: [] }, rows_file: 'masters/x.json', rows_sha256: 'y' });
}
const RULE = { field: 'group_code', op: 'in', values: ['G1'] };
const OLD = [['A000001100', 'G1', '4'], ['A000002100', 'G1'], ['A000003100', 'G2', '3']];

async function base() {
  const data = emptyData();
  const k = ctx();
  const im = imp(data, k);
  const rec = RC.createRecognition(data, k, { name: '甲' });
  const rev = RC.createRevision(data, k, rec.id, { category: '特殊藥品', rule: RULE, effective_from: '2026-01-01', completeness: '完整' });
  const pv = await R.previewRule(RULE, rowsOf(OLD), im, {});
  const snap = RC.saveSnapshot(data, k, rev.id, im, pv);
  RC.confirmSnapshot(data, k, snap.id);
  RC.confirmRevision(data, k, rev.id);
  return { data, k, im, rev, snap };
}

test('T13／T14 新主檔：新符合、不再符合、分組異動、主檔消失列為差異待辦；歷史快照不變；不自動註記或調高', async () => {
  const { data, k, im, rev, snap } = await base();
  const before = JSON.stringify(RC.snapshotMemberList(data, snap.id));
  im.status = '已停用';
  const im2 = imp(data, k, '2026-12-01');
  // A000002100 分組改 G9（不再符合＋分組異動）；A000001100 消失；新增 A000004100（新符合）
  const NEW = rowsOf([['A000002100', 'G9'], ['A000003100', 'G2'], ['A000004100', 'G1']]);
  const items = await D.computeDiffTodos(data, im2, NEW, DEFAULT_SETTINGS);
  assert.deepEqual(items.map((x) => [x.kind, x.drug_code]).sort(), [['不再符合', 'A000002100'], ['主檔消失', 'A000001100'], ['分組異動', 'A000002100'], ['新符合', 'A000004100']].sort());
  const r1 = D.addTodos(data, k, im2.id, items);
  const r2 = D.addTodos(data, k, im2.id, items);
  assert.deepEqual([r1.added, r2.added], [4, 0]);
  assert.equal(JSON.stringify(RC.snapshotMemberList(data, snap.id)), before);
  assert.equal(RC.revisionScope(data, rev.id).has('A000004100'), false);
  assert.equal(data.collections.price_action.length + data.collections.annotation_event.length, 0);
  const t = D.listTodos(data, { kind: '新符合' })[0];
  assert.throws(() => D.resolveTodo(data, k, t.id, '已處理', ''), (e) => e.code === 'REQUIRED');
  D.resolveTodo(data, k, t.id, '已處理', '已建新快照');
  assert.throws(() => D.resolveTodo(data, k, t.id, '不處理', 'x'), (e) => e.code === 'ALREADY');
  // 規則停用：新主檔未映射規則欄位
  const im3 = imp(data, k, '2027-01-01');
  im3.check = { disabled_rule_fields: ['group_code'] };
  const it3 = await D.computeDiffTodos(data, im3, NEW, DEFAULT_SETTINGS);
  assert.deepEqual(it3.map((x) => x.kind), ['規則停用']);
});

test('主檔註記比對：空白＝0；一致／應有未有／主檔有但無完整依據／類別不同／無法判定', async () => {
  const { data, k, rev } = await base();
  for (const c of ['A000001100', 'A000002100']) {
    const pa = P.createPriceAction(data, k, { revision_id: rev.id, drug_code: c, contract_requirement: '當時無須簽約', requirement_basis: '歷史', status: '已核定', announce_doc_no: '文', announce_date: '2026-02-01', effective_date: '2026-03-01', price_after: '5' });
    const an = P.createAnnotation(data, k, { drug_code: c, action: '新增', category: '特殊藥品', price_action_id: pa.id, effective_date: '2026-03-01' });
    P.confirmAnnouncement(data, k, { priceActionIds: [pa.id], annotationIds: [an.id] });
  }
  const rows = rowsOf([['A000001100', 'G1', '4'], ['A000002100', 'G1', '0'], ['A000003100', 'G2', '3'], ['A000005100', 'G3', '9']]);
  rows.byCode.get('A000002100').annotation = '0';
  const items = D.compareMaster(data, rows, '2026-11-07', DEFAULT_SETTINGS);
  const m = Object.fromEntries(items.map((x) => [x.drug_code, x.result]));
  assert.deepEqual(m, { A000001100: '一致', A000002100: '應有未有', A000003100: '主檔有但無完整依據' });
  // 類別不同
  const items2 = D.compareMaster(data, rowsOf([['A000001100', 'G1', '3'], ['A000002100', 'G1', '4']]), '2026-11-07', DEFAULT_SETTINGS);
  assert.equal(items2.find((x) => x.drug_code === 'A000001100').result, '類別不同');
  // 主檔無此代碼 → 無法判定；註記值無對照 → 無法判定
  const items3 = D.compareMaster(data, rowsOf([['A000002100', 'G1', '7']]), '2026-11-07', DEFAULT_SETTINGS);
  assert.deepEqual(items3.map((x) => x.result), ['無法判定', '無法判定']);
  // 未到註記生效日：系統無註記
  const items4 = D.compareMaster(data, rowsOf([['A000001100', 'G1', '0']]), '2026-02-01', DEFAULT_SETTINGS);
  assert.deepEqual(items4.map((x) => [x.drug_code, x.result]), [['A000001100', '一致'], ['A000002100', '無法判定']]);
  assert.deepEqual(D.parseCodeMap(DEFAULT_SETTINGS.annotation_code_map), { 不可替代特殊藥品: '3', 特殊藥品: '4' });
  assert.equal(D.mismatchTodos(items).length, 2);
});

test('T21 依藥品代碼查詢：可回溯認定、案件會議、調高、合約及歷次註記', async () => {
  const { data, k, rev } = await base();
  const c = C.createCase(data, k, { subject: '案', drugs: ['A000001100'] });
  const cd = C.caseDrugs(data, c.id)[0];
  const m = C.createMeeting(data, k, { meeting_type: '共同擬訂', name: '共擬', meeting_date: '2026-01-10' });
  C.addDecision(data, k, { agenda_id: C.addAgenda(data, k, { meeting_id: m.id, case_id: c.id }).id, nature: '會議決議', result: '同意', drugResults: { [cd.id]: '同意' } });
  const kc = P.createContract(data, k, { contract_no: 'K1', signed_date: '2026-01-20', status: '完成簽署', drugs: ['A000001100'] });
  const pa = P.createPriceAction(data, k, { revision_id: rev.id, drug_code: 'A000001100', case_id: c.id, contract_requirement: '須簽約', contract_id: kc.id, status: '已核定', announce_doc_no: '文', announce_date: '2026-02-01', effective_date: '2026-03-01', price_after: '5.5' });
  const an = P.createAnnotation(data, k, { drug_code: 'A000001100', action: '新增', category: '特殊藥品', price_action_id: pa.id, effective_date: '2026-03-01' });
  P.confirmAnnouncement(data, k, { priceActionIds: [pa.id], annotationIds: [an.id] });
  const dd = Q.drugDetail(data, 'A000001100', '2026-11-07');
  assert.equal(dd.category.category, '特殊藥品');
  assert.equal(dd.recognitions[0].name, '甲');
  assert.equal(dd.cases[0].results[0].result, '同意');
  assert.equal(dd.prices[0].price_after, '5.5');
  assert.equal(dd.contracts[0].contract_no, 'K1');
  assert.equal(dd.annotation.category, '特殊藥品');
  assert.equal(dd.annotations.length, 1);
  assert.equal(dd.snapshots[0].status, '已確認');
  const ex = Q.recognitionExportRows(data, '2026-11-07');
  assert.equal(ex.rows.length, 1);
  assert.equal(ex.rows[0][10], 'A000001100 A000002100');
});

test('H15 匯出檔名：同秒加序號、跨秒不重複、未儲存標示；xlsx 匯出說明與屬性；CSV 說明列或另產說明檔', async () => {
  const nm = new X.ExportNamer();
  const t = Date.UTC(2026, 9, 18, 4, 48, 5);
  assert.equal(nm.name('認定清單', t, 123, false, 'xlsx'), '特藥_認定清單_20261018-124805_r000123.xlsx');
  assert.equal(nm.name('認定清單', t + 300, 123, false, 'xlsx'), '特藥_認定清單_20261018-124805-2_r000123.xlsx');
  assert.equal(nm.name('認定清單', t + 1000, 123, true, 'xlsx'), '特藥_認定清單_20261018-124806_r000123+未儲存.xlsx');
  assert.equal(nm.name('差異待辦', t, 123, false, 'xlsx'), '特藥_差異待辦_20261018-124805_r000123.xlsx');
  assert.throws(() => nm.name('自訂', t, 1, false, 'csv'), (e) => e.code === 'BAD_VALUE');
  const info = { kind: '認定清單', ms: t, actor: '承辦A', revision: 123, unsaved: false, versionSha: 'ab'.repeat(32), master: { base_date: '2026-11-01', source_name: 'm.xlsx', sha256: 'cd'.repeat(32) }, condition: '全部', day: '2026-10-18', count: 1 };
  const [x] = X.buildExport({ format: 'xlsx', info, headers: ['代碼'], rows: [['0A01']], namer: nm });
  const z = readZip(x.bytes);
  const s1 = (z.text('xl/worksheets/sheet1.xml'));
  assert.ok(s1.includes('匯出說明') || (z.text('xl/workbook.xml')).includes('匯出說明'));
  assert.ok(s1.includes('r000123') && s1.includes('abababababababab') && s1.includes('2026-11-01'));
  assert.ok((z.text('docProps/core.xml')).includes('<dc:creator>承辦A</dc:creator>'));
  assert.ok((z.text('docProps/custom.xml')).includes('資料revision'));
  assert.ok((z.text('xl/worksheets/sheet2.xml')).includes('0A01'));
  const [c1] = X.buildExport({ format: 'csv', info: { ...info, kind: '查詢結果' }, headers: ['代碼', '說明'], rows: [['0A01', '=SUM(1)']], namer: nm });
  const t1 = new TextDecoder('utf-8', { ignoreBOM: true }).decode(c1.bytes);
  assert.ok(t1.startsWith('﻿# 匯出內容：查詢結果'));
  assert.ok(t1.includes("0A01,'=SUM(1)"));
  const two = X.buildExport({ format: 'csv', info: { ...info, kind: '查詢結果' }, headers: ['代碼'], rows: [['0A01']], csvNotes: false, namer: nm });
  assert.equal(two.length, 2);
  assert.ok(two[1].name.endsWith('_說明.txt'));
  assert.ok(!new TextDecoder().decode(two[0].bytes).includes('#'));
});

test('H16 匯出紀錄：追加至 logs/export-log.jsonl；改名後可依 SHA-256 反查來源版本', async () => {
  const store = new MemStore({ serverNow: () => 0 });
  const fs = store.client({ name: 'A' });
  const info = { kind: '差異待辦', ms: Date.UTC(2026, 10, 7), actor: 'A', revision: 7, unsaved: false, condition: '待處理', day: '2026-11-07', count: 2 };
  const files = X.buildExport({ format: 'xlsx', info, headers: ['a'], rows: [['1'], ['2']] });
  const e1 = await X.logExport(fs, files[0], info);
  await X.logExport(fs, X.buildExport({ format: 'csv', info, headers: ['a'], rows: [] })[0], info);
  assert.equal((await X.readExportLog(fs)).length, 2);
  const found = await X.findExportBySha(fs, await sha256Bytes(files[0].bytes));
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].file_name, found[0].revision, found[0].condition, found[0].kind], [e1.file_name, 7, '待處理', '差異待辦']);
});
