// 階段4：主檔匯入（T01、T02、T14差異部分，及欄位映射、長表、代碼轉換、啟用寫檔）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeXlsx } from '../src/core/xlsxWrite.js';
import { openTable, readHeaders, parseCsv } from '../src/core/table.js';
import * as M from '../src/core/masterImport.js';
import { world, initWith } from './helpers.mjs';
import { openFolder } from '../src/core/folder.js';
import { validateData } from '../src/core/model.js';

const enc = (s) => new TextEncoder().encode(s);
const HEAD = ['CODE', '藥品名稱', '藥商名稱', '分組代碼', 'ATC7碼', 'PDOSE', '核價劑型', '複方藥品', '規格量', '規格單位', 'price11510', 'price11511', '必要藥品'];
const BASE = [
  ['A000001100', 'DRUG A1', '甲藥廠', 'G1AAA0000001', 'J06BA01', '20', '注射劑', 'N', '5', 'ML', '120', '120', '0'],
  ['A000002100', 'DRUG A2', '乙藥廠', 'G1AAA0000001', 'J06BA01', '20', '注射劑', 'N', '10', 'ml', '200', '210', ''],
  ['0A00005100', 'DRUG Z', '丙藥廠', 'G1BBB0000001', 'L04AA03', '11', '錠', 'N', '', '', '8.50', '8.5', '4'],
  ['B000004100', 'DRUG C1', '丁藥廠', 'G1CCC0000001', 'L04AA03', '11', '錠', 'Y', '1', 'VIAL', '6', '6', '3'],
];
const csv = (rows) => enc('﻿' + [HEAD, ...rows].map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n'));

async function stage(bytes, name = 'm.csv', opts = {}) {
  const table = openTable(name, bytes);
  const headers = readHeaders(table, table.sheets[0], 1);
  const mapping = opts.mapping || M.presetMapping('monthly', headers, opts.baseDate || '2026-11-01');
  return M.stageMaster({ table, sheet: table.sheets[0], mapping, baseDate: opts.baseDate === undefined ? '2026-11-01' : opts.baseDate, ...opts.extra });
}

test('CSV：BOM、引號、跨行欄位；非UTF-8拒絕', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n"x\ny",2'), [['a', 'b,c', 'd"e'], ['x\ny', '2']]);
  assert.throws(() => openTable('x.csv', new Uint8Array([0xb4, 0xfa, 0xb8, 0xd5])), (e) => e.code === 'CSV_ENCODING');
  assert.throws(() => openTable('x.xls', new Uint8Array(10)), /\.xls/);
});

test('預設映射：依基準日預選支付價欄；必要藥品空白視為0', async () => {
  const s = await stage(csv(BASE));
  assert.equal(s.mapping.price, 'price11511');
  assert.equal(s.check.codes, 4);
  assert.equal(s.records.get('A000002100').price, '210');
  assert.equal(s.records.get('A000002100').annotation_raw, null);
  assert.equal(s.records.get('A000002100').annotation, '0');
  assert.equal(s.records.get('0A00005100').price, '8.5');
  assert.equal(s.records.get('A000002100').spec_unit, 'ML');
  assert.deepEqual(s.check.unknown_units, { VIAL: 1 });
  assert.ok(s.check.disabled_rule_fields.includes('ingredient'));
  assert.ok(!s.check.disabled_rule_fields.includes('group_code'));
  const s2 = await stage(csv(BASE), 'm.csv', { baseDate: '2026-10-01' });
  assert.equal(s2.mapping.price, 'price11510');
  assert.equal(M.suggestPriceColumn(HEAD, '2027-01-01'), null);
});

test('T01 前導零及字母代碼原樣保存；科學記號、xlsx數值型代碼列為錯誤並阻止啟用', async () => {
  const s = await stage(csv([...BASE, ['1.23E+10', 'SCI', '', '', '', '', '', '', '', '', '', '', '']]));
  assert.ok(s.records.has('0A00005100'));
  assert.equal(s.check.code_error_count, 1);
  assert.match(s.check.code_errors[0].error, /科學記號/);
  const x = writeXlsx([{ name: '主檔', rows: [['CODE', '藥品名稱', '分組代碼'], [{ n: '12345' }, 'NUM', 'G1'], ['0012345', 'TXT', { n: '7' }]] }]);
  const t = openTable('n.xlsx', x);
  const sx = await M.stageMaster({ table: t, sheet: '主檔', mapping: { drug_code: 'CODE', drug_name: '藥品名稱', group_code: '分組代碼' }, baseDate: '2026-11-01' });
  assert.equal(sx.check.code_error_count, 1);
  assert.match(sx.check.code_errors[0].error, /前導零/);
  assert.equal([...sx.records.keys()][0], '0012345');
  assert.ok(sx.check.warnings.some((w) => w.includes('分組代碼 為數值型')));
  assert.ok(M.activationProblems(sx).some((p) => p.includes('代碼錯誤')));
});

test('T02 同代碼兩列內容矛盾：阻止啟用並指出列號及差異；完全相同重複須確認合併', async () => {
  const bad = [...BASE, ['A000001100', 'DRUG A1', '甲藥廠', 'G1AAA0000001', 'J06BA01', '20', '注射劑', 'N', '5', 'ML', '120', '999', '0']];
  const s = await stage(csv(bad));
  const p = M.activationProblems(s);
  assert.ok(p.some((x) => x.includes('A000001100') && x.includes('列 2,6') && x.includes('price')), p.join('|'));
  const s2 = await stage(csv([...BASE, BASE[0]]));
  assert.ok(M.activationProblems(s2).some((x) => x.includes('確認合併')));
  assert.deepEqual(M.activationProblems(s2, { confirmMerge: true }), []);
  const s3 = await stage(csv(BASE), 'm.csv', { baseDate: null });
  assert.ok(M.activationProblems(s3).some((x) => x.includes('基準日')));
});

test('映射：找不到欄位、未映射代碼、未知目標皆拒絕', async () => {
  await assert.rejects(() => stage(csv(BASE), 'm.csv', { mapping: { drug_name: '藥品名稱' } }), (e) => e.code === 'MAP_REQUIRED');
  await assert.rejects(() => stage(csv(BASE), 'm.csv', { mapping: { drug_code: 'CODE', price: '不存在欄' } }), (e) => e.code === 'MAP_MISSING');
  await assert.rejects(() => stage(csv(BASE), 'm.csv', { mapping: { drug_code: 'CODE', evil: 'CODE' } }), (e) => e.code === 'MAP_UNKNOWN');
});

test('xlsx：共用字串、日期格式、空白列、達列數上限警告', async () => {
  const x = writeXlsx([{ name: 'S', rows: [['CODE', '日期'], ['A1', { date: '2026-10-01' }], [], ['A2', '文字']] }]);
  const t = openTable('a.xlsx', x);
  const rows = [...t.rows('S')];
  assert.equal(rows[1].cells.get(1).iso, '2026-10-01');
  assert.equal(rows[1].cells.get(1).t, 'd');
  assert.equal(rows.length, 4);
});

test('價格長表（DWM_DRPAY）：依基準日取價、迄日含；同日多價為矛盾', async () => {
  const pr = writeXlsx([{ name: 'P', rows: [
    ['DRUG_CODE', 'PAY_S_DATE', 'PAY_E_DATE', 'PAY_PRICE'],
    ['A000001100', { date: '2020-01-01' }, { date: '2026-09-30' }, { n: '100' }],
    ['A000001100', { date: '2026-10-01' }, { date: '2910-12-31' }, { n: '130.5' }],
    ['A000002100', { date: '2026-10-01' }, { date: '2910-12-31' }, { n: '50' }],
    ['A000002100', { date: '2026-10-01' }, { date: '2910-12-31' }, { n: '55' }],
  ] }]);
  const price = await M.loadPriceLong(openTable('p.xlsx', pr), { sheet: 'P', cols: { code: 'DRUG_CODE', from: 'PAY_S_DATE', to: 'PAY_E_DATE', price: 'PAY_PRICE' }, baseDate: '2026-10-01' });
  assert.equal(price.prices.get('A000001100'), '130.5');
  const s = await stage(csv(BASE), 'm.csv', { baseDate: '2026-10-01', extra: { price } });
  assert.equal(s.records.get('A000001100').price, '130.5');
  assert.equal(s.records.get('0A00005100').price, null);
  assert.ok(s.check.conflicts.some((c) => c.code === 'A000002100' && c.note));
  await assert.rejects(() => M.loadPriceLong(openTable('p.xlsx', pr), { sheet: 'P', cols: { code: 'DRUG_CODE', from: 'PAY_S_DATE', to: 'PAY_E_DATE', price: 'PAY_PRICE' } }), (e) => e.code === 'NEED_BASE_DATE');
});

test('代碼轉換（DWM_DRUG_RCODE）：規格量／單位／名稱；未知代碼列出', async () => {
  const rc = writeXlsx([{ name: 'R', rows: [
    ['DRUG_REL_CODE_TYPE', 'DRUG_REL_CODE', 'DRUG_REL_CODE_CNAME', 'DRUG_REL_CODE_ENAME', 'DRUG_STD_QTY'],
    ['5', '51', '', '', { n: '5.00' }], ['2', '003', '公撮', 'ML', ''], ['8', 'G1', '分組一', '', ''],
  ] }]);
  const rcode = await M.loadRcode(openTable('r.xlsx', rc), { sheet: 'R' });
  const daily = enc('DRUG_CODE,DRUG_GROUP_CODE,DRUG_STD_QTY_CODE,DRUG_STD_CODE\nX1,G1,51,003\nX2,G9,99,003\n');
  const t = openTable('d.csv', daily);
  const lookups = { spec_qty: { type: '5', field: 'std_qty' }, spec_unit: { type: '2', field: 'ename' }, group_name: { type: '8', field: 'cname', from: 'group_code' } };
  const s = await M.stageMaster({ table: t, mapping: { drug_code: 'DRUG_CODE', group_code: 'DRUG_GROUP_CODE', spec_qty: 'DRUG_STD_QTY_CODE', spec_unit: 'DRUG_STD_CODE' }, lookups, rcode, baseDate: '2026-10-01' });
  assert.deepEqual([s.records.get('X1').spec_qty, s.records.get('X1').spec_unit, s.records.get('X1').group_name], ['5', 'ML', '分組一']);
  assert.equal(s.records.get('X2').spec_qty, null);
  assert.deepEqual(s.check.unknown_lookup.spec_qty, ['99']);
  await assert.rejects(() => M.stageMaster({ table: t, mapping: { drug_code: 'DRUG_CODE' }, lookups, baseDate: '2026-10-01' }), (e) => e.code === 'NEED_RCODE');
});

test('啟用：來源檔存附件、列資料寫入masters並驗雜湊、舊版停用保留；T14 差異比較', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  const b1 = csv(BASE);
  const s1 = await stage(b1);
  const r1 = await M.activateMaster(a, s1, [{ role: '主檔', name: '主檔11511.csv', bytes: b1 }]);
  await a.save();
  const rows = [...BASE.map((r) => [...r])];
  rows[3][3] = 'G1ZZZ0000001';
  rows.push(['C000009100', 'NEW', '戊', 'G1CCC0000001', 'L04AA03', '11', '錠', 'N', '', '', '5', '5', '0']);
  rows.splice(0, 1);
  const b2 = csv(rows);
  const s2 = await stage(b2, 'm2.csv', { baseDate: '2026-12-01', mapping: { ...M.presetMapping('monthly', HEAD, null), price: 'price11511' } });
  const r2 = await M.activateMaster(a, s2, [{ role: '主檔', name: '主檔11512.csv', bytes: b2 }], { note: '12月' });
  await a.save();
  const o = await openFolder(w.store.client());
  assert.deepEqual(validateData(o.data), []);
  const imps = o.data.collections.master_import;
  assert.equal(imps.find((x) => x.id === r1.import_id).status, '已停用');
  assert.equal(M.activeImport(o.data).id, r2.import_id);
  assert.equal(o.data.collections.attachment.length, 2);
  assert.equal(o.data.collections.attachment_link.filter((l) => l.entity === 'master_import').length, 2);
  assert.equal(w.store.names('masters/').length, 2);
  assert.equal(w.store.names('attachments/').length, 2);
  const old = await M.loadMasterRows(w.store.client(), imps.find((x) => x.id === r1.import_id));
  const neu = await M.loadMasterRows(w.store.client(), M.activeImport(o.data));
  assert.equal(old.byCode.get('0A00005100').drug_code_raw, '0A00005100');
  const d = M.diffMasters(old, neu);
  assert.deepEqual(d.added, ['C000009100']);
  assert.deepEqual(d.removed, ['A000001100']);
  assert.deepEqual(d.changed.find((x) => x.drug_code === 'B000004100').diffs.group_code, ['G1CCC0000001', 'G1ZZZ0000001']);
  assert.ok(o.audit.some((e) => e.action === '停用舊主檔版本（保留）'));
  // 列資料被改：讀取時檢出
  const p = M.activeImport(o.data).rows_file;
  w.store.rawSet(p, w.store.rawGet(p).replace('NEW', 'NEX'));
  await assert.rejects(() => M.loadMasterRows(w.store.client(), M.activeImport(o.data)), (e) => e.code === 'REF_HASH');
  // 選項由主檔產生
  assert.deepEqual(M.masterOptions(old, 'group_code').map((x) => [x.value, x.count]), [['G1AAA0000001', 2], ['G1BBB0000001', 1], ['G1CCC0000001', 1]]);
});

test('啟用失敗（矛盾）：不寫任何檔、不改目前主檔', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  const b = csv([...BASE, ['A000001100', 'X', '', '', '', '', '', '', '', '', '', '1', '']]);
  const s = await stage(b);
  await assert.rejects(() => M.activateMaster(a, s, [{ role: '主檔', name: 'x.csv', bytes: b }]), (e) => e.code === 'ACTIVATE_BLOCKED');
  assert.equal(w.store.names('masters/').length, 0);
  assert.equal(w.store.names('attachments/').length, 0);
  assert.equal(a.unsavedCount, 0);
});

test('真實月檔（SPECDRUG_MASTER 指定時）：可讀取、無代碼錯誤', { skip: !process.env.SPECDRUG_MASTER && '未提供 SPECDRUG_MASTER（真實主檔路徑），略過' }, async () => {
  const { readFileSync } = await import('node:fs');
  const bytes = new Uint8Array(readFileSync(process.env.SPECDRUG_MASTER));
  const t0 = Date.now();
  const table = openTable(process.env.SPECDRUG_MASTER, bytes);
  const headers = readHeaders(table, table.sheets[0], 1);
  const s = await M.stageMaster({ table, sheet: table.sheets[0], mapping: M.presetMapping('monthly', headers, '2026-11-01'), baseDate: '2026-11-01' });
  console.log(`真實月檔：${s.check.codes} 代碼，錯誤 ${s.check.code_error_count}，矛盾 ${s.check.conflict_count}，重複 ${s.check.identical_duplicate_count}，${Date.now() - t0} ms，未知單位 ${Object.keys(s.check.unknown_units).length} 種`);
  assert.ok(s.check.codes > 40000);
});

test('示範資料之主檔列資料可依正式格式讀取', async () => {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  await a.loadDemo();
  const rows = await M.loadMasterRows(a.fs, M.activeImport(a.work));
  assert.equal(rows.byCode.size, 6);
  assert.equal(rows.byCode.get('0DEMO00006').price, '52.50');
  assert.equal(rows.byCode.get('DEMO000001').annotation, '0');
});
