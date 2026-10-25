// 階段2：資料模型、值型別、欄位白名單（H13）、操作id（T17）、一致性檢查（T18部分）、模擬資料
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, initWith } from './helpers.mjs';
import { SCHEMA, insert, update, setConfirmStatus, setDedicated, validateData, E } from '../src/core/model.js';
import { COLLECTIONS, emptyData } from '../src/core/dataset.js';
import { normalizeMoney, compareMoney, addMoney, subMoney, parseDate, rocDisplay, inPeriod, normalizeCode } from '../src/core/values.js';
import { openFolder } from '../src/core/folder.js';

let n = 0;
const ctx = () => ({ actor: 'A001／PC-01', now: '2026-10-25T01:00:00.000Z', newId: () => `id-${++n}`, events: [] });

test('集合清單與資料模型一致', () => {
  assert.deepEqual([...COLLECTIONS].sort(), Object.keys(SCHEMA).sort());
});

test('金額：十進位字串，不用浮點', () => {
  assert.equal(normalizeMoney('1,234.50'), '1234.5');
  assert.equal(normalizeMoney('12.0'), '12');
  assert.equal(normalizeMoney('007'), '7');
  assert.equal(normalizeMoney('-0.00'), '0');
  assert.equal(normalizeMoney('abc'), null);
  assert.throws(() => normalizeMoney(0.1), (e) => e.code === 'MONEY_FLOAT');
  assert.equal(addMoney('0.1', '0.2'), '0.3');
  assert.equal(subMoney('180', '120.25'), '59.75');
  assert.equal(compareMoney('8.50', '8.5'), 0);
  assert.equal(compareMoney('10', '9.99'), 1);
  assert.equal(addMoney('99999999999999999.99', '0.01'), '100000000000000000');
});

test('日期：西元與民國；無法解析不猜測；起日含迄日不含', () => {
  assert.equal(parseDate('2026/8/1'), '2026-08-01');
  assert.equal(parseDate('115.08.01'), '2026-08-01');
  assert.equal(parseDate('1150801'), '2026-08-01');
  assert.equal(parseDate('20260801'), '2026-08-01');
  assert.equal(parseDate('2026-02-30'), null);
  assert.equal(parseDate('八月一日'), null);
  assert.equal(rocDisplay('2026-08-01'), '115/08/01');
  assert.equal(inPeriod('2026-08-01', '2026-08-01', '2026-09-01'), true);
  assert.equal(inPeriod('2026-09-01', '2026-08-01', '2026-09-01'), false);
  assert.equal(inPeriod('2026-08-01', null, null), false);
});

test('T01（代碼部分）代碼保留前導零與字母；數值型、科學記號列為錯誤；不改O/0', () => {
  assert.deepEqual(normalizeCode(' 0DEMO00006 '), { code: '0DEMO00006', error: null });
  assert.equal(normalizeCode('RO5DA04').code, 'RO5DA04');
  assert.match(normalizeCode(123).error, /數值型/);
  assert.match(normalizeCode('1.2E+10').error, /科學記號/);
  const d = emptyData();
  const c = insert(d, ctx(), 'case_record', { case_no: 'X1', subject: 's' });
  assert.throws(() => insert(d, ctx(), 'case_drug', { case_id: c.id, drug_code: 1234 }), (e) => e.code === 'BAD_CODE');
  const cd = insert(d, ctx(), 'case_drug', { case_id: c.id, drug_code: '0001234' });
  assert.equal(cd.drug_code, '0001234');
});

test('H13 一般修改函式：拒絕改確認狀態、建立者、建立後不可改欄位、專責欄位；已確認資料不可改', () => {
  const d = emptyData();
  const k = ctx();
  const r = insert(d, k, 'recognition', { recognition_no: 'R1', name: '甲' });
  const rev = insert(d, k, 'recognition_revision', { recognition_id: r.id, revision_no: 1, category: '特殊藥品' });
  assert.equal(rev.confirm_status, '草稿');
  assert.throws(() => insert(d, k, 'recognition_revision', { recognition_id: r.id, revision_no: 2, confirm_status: '已確認' }), (e) => e.code === 'FIELD_PROTECTED');
  for (const f of ['confirm_status', 'confirmed_by', 'confirmed_at', 'created_by', 'created_at', 'id', 'row_version']) {
    assert.throws(() => update(d, k, 'recognition_revision', rev.id, { [f]: 'x' }), (e) => e.code === 'FIELD_PROTECTED', f);
  }
  assert.throws(() => update(d, k, 'recognition_revision', rev.id, { recognition_id: r.id }), (e) => e.code === 'FIELD_FIXED');
  assert.throws(() => update(d, k, 'recognition_revision', rev.id, { evil: 1 }), (e) => e.code === 'FIELD_UNKNOWN');
  // 調高紀錄 revision_id、drug_code 建立後不可改（第11.4節第2點；M3）
  const pa = insert(d, k, 'price_action', { drug_code: 'A1', revision_id: rev.id, price_after: '10' });
  assert.throws(() => update(d, k, 'price_action', pa.id, { drug_code: 'B2' }), (e) => e.code === 'FIELD_FIXED');
  assert.throws(() => update(d, k, 'price_action', pa.id, { revision_id: rev.id }), (e) => e.code === 'FIELD_FIXED');
  assert.throws(() => update(d, k, 'price_action', pa.id, { confirm_status: '已確認' }), (e) => e.code === 'FIELD_PROTECTED');
  // 合約建立者、原合約不可改（M4）
  const ct = insert(d, k, 'contract', { contract_no: 'C1' });
  assert.throws(() => update(d, k, 'contract', ct.id, { created_by: '別人' }), (e) => e.code === 'FIELD_PROTECTED');
  assert.throws(() => update(d, k, 'contract', ct.id, { original_contract_id: ct.id }), (e) => e.code === 'FIELD_FIXED');
  assert.throws(() => update(d, k, 'contract', ct.id, { status: '亂填' }), (e) => e.code === 'BAD_VALUE');
  // 案件結果摘要、結案欄位須以專責功能
  const c = insert(d, k, 'case_record', { case_no: 'C-1', subject: 's' });
  assert.throws(() => update(d, k, 'case_record', c.id, { result_summary: '全部同意' }), (e) => e.code === 'FIELD_PROTECTED');
  // 確認後不可經一般修改函式改
  update(d, k, 'recognition_revision', rev.id, { scope_text: '原文' });
  setConfirmStatus(d, k, 'recognition_revision', rev.id, '已確認');
  assert.equal(rev.confirmed_by, 'A001／PC-01');
  assert.throws(() => update(d, k, 'recognition_revision', rev.id, { scope_text: '改' }), (e) => e.code === 'CONFIRMED_READONLY');
  assert.throws(() => setConfirmStatus(d, k, 'recognition_revision', rev.id, '草稿'), (e) => e.code === 'BAD_TRANSITION');
  assert.throws(() => setConfirmStatus(d, k, 'price_action', pa.id, '撤銷'), (e) => e.code === 'REQUIRED');
  // 專責函式只能設定指定欄位
  assert.throws(() => setDedicated(d, k, 'case_record', c.id, { subject: 'x' }, { action: '結案', fields: ['status'] }), (e) => e.code === 'FIELD_PROTECTED');
});

test('樂觀版本檢查與稽核差異', () => {
  const d = emptyData();
  const k = ctx();
  const c = insert(d, k, 'case_record', { case_no: 'C-2', subject: '舊' });
  update(d, k, 'case_record', c.id, { subject: '新' }, { expectedVersion: 1 });
  assert.equal(c.row_version, 2);
  assert.throws(() => update(d, k, 'case_record', c.id, { subject: '再' }, { expectedVersion: 1 }), (e) => e.code === 'VERSION_CONFLICT');
  const ev = k.events.at(-1);
  assert.equal(ev.action, '修改');
  assert.deepEqual(ev.diff.subject, { from: '舊', to: '新' });
});

test('值域、必填、參照、唯一、其他須說明', () => {
  const d = emptyData();
  const k = ctx();
  assert.throws(() => insert(d, k, 'case_record', { case_no: 'C' }), (e) => e.code === 'REQUIRED');
  insert(d, k, 'case_record', { case_no: 'C', subject: 's' });
  assert.throws(() => insert(d, k, 'case_record', { case_no: 'C', subject: 's' }), (e) => e.code === 'DUPLICATE');
  assert.throws(() => insert(d, k, 'meeting_agenda', { meeting_id: 'nope', case_id: 'nope' }), (e) => e.code === 'BAD_REF');
  assert.throws(() => insert(d, k, 'meeting', { meeting_type: '理監事', name: 'x' }), (e) => e.code === 'BAD_VALUE');
  const m = insert(d, k, 'meeting', { meeting_type: '專家', name: 'm' });
  const c = d.collections.case_record[0];
  const a = insert(d, k, 'meeting_agenda', { meeting_id: m.id, case_id: c.id });
  assert.throws(() => insert(d, k, 'decision', { agenda_id: a.id, nature: '會議決議', result: '其他' }), (e) => /其他/.test(e.message));
  const rr = insert(d, k, 'recognition', { recognition_no: 'R', name: 'r' });
  assert.throws(() => insert(d, k, 'recognition_revision', { recognition_id: rr.id, revision_no: 1, category: '必要藥品' }), (e) => e.code === 'BAD_VALUE');
  assert.deepEqual(E.CATEGORY, ['不可替代特殊藥品', '特殊藥品']);
  assert.throws(() => insert(d, k, 'price_action', { drug_code: 'A', revision_id: 'x', price_after: 1.5 }));
  assert.throws(() => insert(d, k, 'recognition_revision', { recognition_id: rr.id, revision_no: 1, effective_from: '115/8/1' }), (e) => e.code === 'BAD_VALUE');
});

test('一致性檢查：參照斷裂、重複、金額型別', () => {
  const d = emptyData();
  const k = ctx();
  const c = insert(d, k, 'case_record', { case_no: 'C', subject: 's' });
  insert(d, k, 'case_drug', { case_id: c.id, drug_code: 'A' });
  assert.deepEqual(validateData(d), []);
  d.collections.case_drug.push({ ...d.collections.case_drug[0], id: 'dup' });
  d.collections.case_drug.push({ id: 'x2', case_id: 'missing', drug_code: 'B', row_version: 1 });
  const p = validateData(d);
  assert.ok(p.some((x) => x.includes('重複')));
  assert.ok(p.some((x) => x.includes('參照不存在')));
});

test('T17 確認類操作重送只生效一次', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  const fn = (d, k) => {
    const c = insert(d, k, 'case_record', { case_no: 'OP-1', subject: '一次' });
    return { id: c.id };
  };
  const r1 = await a.run(fn, { opId: 'op-123', kind: '建立案件' });
  const r2 = await a.run(fn, { opId: 'op-123', kind: '建立案件' });
  assert.equal(r2.replayed, true);
  assert.equal(r2.id, r1.id);
  assert.equal(a.work.collections.case_record.length, 1);
  await a.save();
  const r3 = await a.run(fn, { opId: 'op-123', kind: '建立案件' });
  assert.equal(r3.replayed, true);
  assert.equal(a.work.collections.case_record.length, 1);
});

test('T18（資料部分）業務操作失敗整批不成立；一致性不符拒絕儲存', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  await assert.rejects(() => a.run((d, k) => {
    insert(d, k, 'case_record', { case_no: 'T18', subject: '先建' });
    insert(d, k, 'case_drug', { case_id: 'missing', drug_code: 'A' });
  }));
  assert.equal(a.work.collections.case_record.length, 0);
  assert.equal(a.unsavedCount, 0);
  // 被外力弄壞的工作副本：存檔前檢出
  await a.run((d, k) => { insert(d, k, 'case_record', { case_no: 'T18b', subject: 's' }); });
  a.work.collections.case_drug.push({ id: 'bad', case_id: 'none', drug_code: 'A', row_version: 1 });
  await assert.rejects(() => a.save(), (e) => e.code === 'DATA_INVALID');
  assert.equal(JSON.parse(w.store.rawGet('data/current.json')).revision, 0);
});

test('T18（附件部分）引用檔案缺失或雜湊不符：拒絕儲存', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  await a.run((d, k) => { insert(d, k, 'case_record', { case_no: 'R1', subject: 's' }); },
    { refs: [{ path: 'attachments/ab/' + 'ab'.padEnd(64, '0'), sha256: 'ab'.padEnd(64, '0'), label: '公告附件' }] });
  await assert.rejects(() => a.save(), (e) => e.code === 'REF_MISSING');
  w.store.rawSet('attachments/ab/' + 'ab'.padEnd(64, '0'), '內容不符');
  await assert.rejects(() => a.save(), (e) => e.code === 'REF_HASH');
  assert.equal(JSON.parse(w.store.rawGet('data/current.json')).revision, 0);
});

test('模擬資料：只能載入新資料夾；主檔列資料寫入masters並驗雜湊；儲存後可開啟', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  const r = await a.loadDemo();
  assert.equal(r.counts.case_record, 3);
  assert.equal(r.counts.meeting, 2);
  assert.equal(w.store.names('masters/').length, 1);
  await a.save();
  const o = await openFolder(w.store.client());
  assert.equal(o.ok, true);
  assert.equal(o.data.info.demo, true);
  assert.deepEqual(validateData(o.data), []);
  const pa = o.data.collections.price_action[0];
  assert.equal(pa.price_after, '180');
  assert.equal(typeof pa.price_after, 'string');
  assert.equal(pa.confirm_status, '已確認');
  const no = o.data.collections.case_record.find((c) => c.case_no === 'DEMO2026-0002');
  assert.equal(no.status, '已結案');
  assert.equal(no.result_summary, '全部不同意');
  assert.equal(o.data.collections.recognition_revision.length, 1);
  assert.ok(o.audit.length > 30);
  await assert.rejects(() => a.loadDemo(), (e) => e.code === 'NOT_NEW_FOLDER');
  // 已有業務資料之資料夾
  const w2 = world();
  const b = await initWith(w2);
  await b.startEdit();
  await b.run((d, k) => { insert(d, k, 'case_record', { case_no: 'REAL-1', subject: '正式' }); });
  await assert.rejects(() => b.loadDemo(), (e) => e.code === 'NOT_NEW_FOLDER');
});
