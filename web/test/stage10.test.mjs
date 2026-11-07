// 階段10：Excel移轉預覽（T24、T37、T38、T40；Warfarin 同申請商規則；許可證對應）
// 真實活頁簿：設定環境變數 SPECDRUG_WORKBOOK 指向 活頁簿1.xlsx（不 commit 進 repo）；未設定則跳過並說明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as MG from '../src/core/migration.js';
import * as RC from '../src/core/recognition.js';
import * as R from '../src/core/rules.js';
import * as C from '../src/core/cases.js';
import * as M from '../src/core/masterImport.js';
import { writeXlsx } from '../src/core/xlsxWrite.js';
import { openTable, parseCsv } from '../src/core/table.js';
import { utf8 } from '../src/core/util.js';
import { world, initWith } from './helpers.mjs';

const KEYS = Object.keys(MG.COLS);
function book(rows) {
  const bytes = writeXlsx([{ name: 'final', rows: [KEYS.map((k) => MG.COLS[k]), ...rows.map((r) => KEYS.map((k) => r[k] ?? null))] }]);
  return { bytes, table: openTable('w.xlsx', bytes) };
}

async function session() {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  return { w, a };
}

async function stageAndCommit(a, rows) {
  const { bytes, table } = book(rows);
  const st = await MG.readWorkbook(table, { name: 'w.xlsx', bytes });
  const r = await MG.stageToSession(a, st);
  const res = [];
  for (const row of MG.listRows(a.work, { sha: st.sha256 })) res.push(await a.run((d, k) => MG.commitRow(d, k, row.id)));
  return { st, r, res };
}

test('T24 Rufinamide 參考特殊藥品精神、非認列：保留價格案件及原文，不建立有效特殊身分', async () => {
  const { a } = await session();
  const { res } = await stageAndCommit(a, [{ seq: '172', group_code: 'N03RUF212116', category: '特殊藥品', rule: '分組代碼=N03RUF212116', price_history: 'Rufinamide參考特殊藥品精神調高，非認列特殊藥品', history: '擬訂會議113年8月' }]);
  assert.equal(res[0].recognition_id, null);
  assert.equal(a.work.collections.recognition.length, 0);
  const c = a.work.collections.case_record.find((x) => x.id === res[0].case_id);
  assert.match(c.notes, /非認列/);
  assert.equal(c.completeness, '不完整');
});

test('T37 缺日期或混有取消：保存原文及待確認；B16 類別對照；多次會議拆成議案；只有年月不補日', async () => {
  const { a } = await session();
  const { res, st } = await stageAndCommit(a, [
    { seq: '1', group_code: 'L01DOX412202', cancel: '取消', category: '取消特殊藥品註記', rule: '分組代碼=L01DOX412202', history: '擬訂會議110年6月' },
    { seq: '2', group_code: 'X01', category: '不可替代必要藥品(104.05.01藥價歸零)', rule: '分組代碼=X01', history: '藥事小組第9-11次 (101年2月9日)\n擬訂會議113年8月' },
  ]);
  assert.ok(res[0].cancel_revision_id);
  const rv = a.work.collections.recognition_revision.find((x) => x.id === res[1].revision_id);
  assert.equal(rv.category, '不可替代特殊藥品');
  assert.ok(rv.original_category.startsWith('不可替代必要藥品'));
  assert.deepEqual([rv.effective_from, rv.completeness, rv.confirm_status], [null, '不完整', '草稿']);
  assert.ok(st.rows[1].parsed.category_flags.some((f) => f.includes('藥價歸零')));
  const tl = C.caseTimeline(a.work, res[1].case_id);
  assert.deepEqual(tl.map((x) => x.meeting_type), ['藥事小組', '共同擬訂']);
  assert.deepEqual(tl.map((x) => x.meeting_date), ['2012-02-09', null]);
  assert.ok(tl.every((x) => x.decisions[0].result === '待確認'));
  assert.equal(a.work.collections.annotation_event.length + a.work.collections.price_action.length, 0);
  for (const r of a.work.collections.recognition) assert.notEqual(RC.statusOn(a.work, r.id, '2026-11-07').state, '有效');
});

test('T38 同一Excel重複匯入：不重複暫存、不重複建案或會議', async () => {
  const { a } = await session();
  const rows = [{ seq: '1', group_code: 'G1', category: '特殊藥品', rule: '分組代碼=G1', history: '擬訂會議113年8月' }, { seq: '2', group_code: 'G2', category: '特殊藥品', rule: '分組代碼=G2', history: '擬訂會議113年8月' }];
  const { st, r } = await stageAndCommit(a, rows);
  assert.deepEqual([r.new, r.already_staged], [2, 0]);
  // 兩列同一會議（同類型、同名、同日期）共用
  assert.equal(a.work.collections.meeting.length, 1);
  const nCase = a.work.collections.case_record.length;
  const r2 = await MG.stageToSession(a, await MG.readWorkbook(book(rows).table, { name: 'w.xlsx', bytes: book(rows).bytes }));
  assert.deepEqual([r2.new, r2.already_staged], [0, 2]);
  const row = MG.listRows(a.work, { sha: st.sha256 })[0];
  await assert.rejects(() => a.run((d, k) => MG.commitRow(d, k, row.id)), (e) => e.code === 'ALREADY');
  assert.equal(a.work.collections.case_record.length, nCase);
  assert.equal(a.work.collections.migration_batch.length, 1);
  assert.deepEqual(MG.mergeCandidates(a.work, st.sha256).map((g) => g.key), []);
  await a.save();
});

test('T40 未提供未通過案件：不生成假案件；人工補登入口可用；略過須理由', async () => {
  const { a } = await session();
  const { bytes, table } = book([{ seq: '1', group_code: 'G1', category: '特殊藥品', rule: '分組代碼=G1', history: '擬訂會議113年8月' }, { seq: '1', group_code: 'G1', category: '特殊藥品', rule: '分組代碼=G1' }]);
  const st = await MG.readWorkbook(table, { name: 'one.xlsx', bytes });
  await MG.stageToSession(a, st);
  const rows = MG.listRows(a.work);
  await a.run((d, k) => MG.commitRow(d, k, rows[0].id));
  await assert.rejects(() => a.run((d, k) => MG.skipRow(d, k, rows[1].id, '')), (e) => e.code === 'REQUIRED');
  await a.run((d, k) => MG.skipRow(d, k, rows[1].id, '與第2列重複'));
  assert.equal(a.work.collections.case_record.length, 1);
  assert.ok(a.work.collections.case_record.every((c) => c.result_summary === '尚無結論'));
  assert.deepEqual(MG.mergeCandidates(a.work, st.sha256).map((g) => g.key).sort(), ['分組代碼', '調整時公告序號'].sort());
  const c = await a.run((d, k) => C.createCase(d, k, { subject: '人工補登之未通過案', applicant: '乙' }));
  assert.equal(C.listCases(a.work, { keyword: '人工補登' })[0].id, c.id);
  assert.ok(a.work.collections.attachment_link.some((l) => l.entity === 'migration_batch'));
});

test('Warfarin「同廠牌」：依使用者確認改為同申請商條件；非1mg列要求同申請商有1mg；許可證對應統編', async () => {
  const t = '分組代碼= B01WAR212112，且同廠牌尚有不同規格品項，﹛分組代碼前11碼=B01WAR21211 & 分組代碼<>B01WAR21211A & CODE_aggr<>B023572100,B023573100)=0﹜';
  const one = MG.sameBrandRule(t, 'B01WAR212112', '同一廠商須同時生產1mg併其他高規格');
  const five = MG.sameBrandRule(t, 'B01WAR212118', '同一廠商須同時生產1mg併其他高規格');
  assert.equal(R.describe(one.ast).includes('同申請商'), true);
  assert.deepEqual(five.ast.children[1].child, { field: 'group_code', op: 'eq', value: 'B01WAR212112' });
  assert.ok(five.issues.some((x) => x.includes('疑似複製上一列')));
  // 許可證檔→申請商統編
  const csv = '許可證字號,申請商統一編號,註銷狀態\n衛署藥製字第052559號,14078416,\n衛部藥製字第060391號,44988454,\n衛署藥輸字第023572號,43199950,\n衛署成製字第000001號,1,\n';
  const lic = await M.loadLicenses(openTable('l.csv', utf8(csv)), { sheet: openTable('l.csv', utf8(csv)).sheets[0] });
  assert.equal(lic.map.size, 3);
  assert.equal(M.licenseKeyOfCode('AC52559100'), 'A52559');
  const mk = (c, g, app) => [c, { drug_code: c, group_code: g, applicant_id: app }];
  const rows = { byCode: new Map([mk('A052559100', 'B01WAR212112', '14078416'), mk('A050095100', 'B01WAR212118', '14078416'), mk('B023572100', 'B01WAR212118', '43199950'),
    mk('B023573100', 'B01WAR212116', '43199950'), mk('AC60391100', 'B01WAR212112', '44988454'), mk('X000140100', 'B01WAR212112', null)]) };
  const imp = { id: 'i', status: '已啟用', base_date: '2026-11-01', check: { disabled_rule_fields: [] } };
  const pv5 = await R.previewRule(five.ast, rows, imp, {});
  assert.deepEqual(pv5.members.map((m) => [m.drug_code, m.result]), [['A050095100', '符合']]);
  const pv1 = await R.previewRule(one.ast, rows, imp, {});
  assert.deepEqual(pv1.members.map((m) => [m.drug_code, m.result]), [['A052559100', '符合'], ['X000140100', '待確認']]);
  assert.equal(pv1.reasons['申請商統編缺值'], 1);
  // 主檔版本未匯入許可證：全列待確認
  const noLic = { byCode: new Map([mk('A052559100', 'B01WAR212112', null)]) };
  assert.match((await R.previewRule(one.ast, noLic, imp, {})).members[0].path, /未匯入藥品許可證檔/);
});

const WB = process.env.SPECDRUG_WORKBOOK;
test('T37／T38 真實活頁簿（SPECDRUG_WORKBOOK）', { skip: !WB || !existsSync(WB) ? '未設定 SPECDRUG_WORKBOOK 或檔案不存在：真實活頁簿為使用者提供之業務資料，不放入 repo' : false }, async () => {
  const bytes = new Uint8Array(readFileSync(WB));
  const st = await MG.readWorkbook(openTable('活頁簿1.xlsx', bytes), { name: '活頁簿1.xlsx', bytes });
  const { a } = await session();
  const r1 = await MG.stageToSession(a, st);
  for (const row of MG.listRows(a.work)) await a.run((d, k) => MG.commitRow(d, k, row.id));
  const revs = a.work.collections.recognition_revision;
  assert.equal(revs.filter((x) => x.confirm_status !== '草稿').length, 0);
  assert.equal(a.work.collections.annotation_event.length, 0);
  assert.equal(revs.filter((x) => x.category === '取消認定').length, 4); // 5列取消註記，其中Rufinamide非認列不建認定
  assert.ok(revs.filter((x) => !x.effective_from && x.completeness === '不完整').length > 200);
  const war = revs.filter((x) => x.rule && JSON.stringify(x.rule).includes('same_applicant'));
  assert.equal(war.length, 3);
  assert.equal(revs.filter((x) => x.rule && R.hasManual(x.rule)).length < 10, true);
  const nCase = a.work.collections.case_record.length;
  const r2 = await MG.stageToSession(a, st);
  assert.deepEqual([r2.new, r2.already_staged], [0, r1.total]);
  assert.equal(a.work.collections.case_record.length, nCase);
  await a.save();
});

test('parseCsv 健全性（許可證檔多行欄位）', () => {
  const rows = parseCsv('a,b\n"x\ny",2\n');
  assert.deepEqual(rows[1], ['x\ny', '2']);
});
