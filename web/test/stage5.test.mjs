// 階段5：條件判定引擎與預覽（T03–T07，及驗證、說明、原文解析）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/core/rules.js';

const F = ['drug_code', 'drug_name', 'group_code', 'atc_code', 'dose_code', 'multi_mark', 'spec_qty', 'spec_unit', 'firm'];
const ROWS = [
  ['A000001100', 'DRUG A1', 'G1AAA0000001', 'J06BA01', '20', 'N', '5', 'ML', '甲'],
  ['A000002100', 'DRUG A2', 'G1AAA0000001', 'J06BA01', '20', 'N', '10', 'ML', '乙'],
  ['A000003100', 'DRUG A3', 'G1AAA0000001', 'J06BA01', '20', 'N', '5', 'VIAL', '丙'],
  ['A000006100', 'DRUG A6', 'G1AAA0000001', 'J06BB16', '20', 'N', null, null, '丁'],
  ['0A00005100', 'DRUG Z', 'G1BBB0000001', 'L04AA03', '11', 'N', null, null, '戊'],
  ['B000004100', 'DRUG C1', 'G1CCC0000001', 'L04AA03', '11', 'Y', null, null, '己'],
  ['B000007100', 'DRUG C7', 'G1CCC0000001', 'L04AA04', '11', null, null, null, '庚'],
  ['C000008100', 'DRUG X', null, 'C01AA05', '11', 'N', null, null, '辛'],
];
const rows = { byCode: new Map(ROWS.map((r) => { const o = {}; F.forEach((k, i) => { o[k] = r[i]; }); return [o.drug_code, o]; })) };
const imp = { id: 'imp-1', status: '已啟用', base_date: '2026-11-01', check: { disabled_rule_fields: ['ingredient'], known_units: ['ML', 'MG', 'GM'] } };
const codes = (pv, res) => pv.members.filter((m) => !res || m.result === res).map((m) => m.drug_code).sort();

test('T03 選兩個分組：列出聯集並去重', async () => {
  const pv = await R.previewRule({ field: 'group_code', op: 'in', values: ['G1AAA0000001', 'G1CCC0000001', 'G1AAA0000001'] }, rows, imp);
  assert.deepEqual(codes(pv, '符合'), ['A000001100', 'A000002100', 'A000003100', 'A000006100', 'B000004100', 'B000007100']);
  assert.equal(pv.match, 6);
  // 分組代碼空白：視為不符合【使用者 2026-11-07 決定】
  assert.deepEqual(codes(pv, '待確認'), []);
  assert.ok(!codes(pv).includes('C000008100'));
  assert.ok(!pv.warnings.some((w) => w.includes('部分涵蓋')));
});

test('T04 ATC＋單複方＋劑型：僅全部符合者列入；缺值列待確認', async () => {
  const pv = await R.previewRule({ op: 'and', children: [
    { field: 'atc_code', op: 'in', values: ['L04AA03', 'L04AA04', 'C01AA05'] },
    { field: 'multi_mark', op: 'eq', value: 'N' },
    { field: 'dose_code', op: 'eq', value: '11' }] }, rows, imp);
  assert.deepEqual(codes(pv, '符合'), ['0A00005100', 'C000008100']);
  assert.deepEqual(codes(pv, '待確認'), ['B000007100']);
  assert.ok(pv.reasons['單複方缺值'] === 1);
});

test('T05 J06B前綴排除J06BB16，再OR其他ATC：括號與排除邏輯正確', async () => {
  const rule = { op: 'or', children: [
    { op: 'and', children: [{ field: 'atc_code', op: 'starts_with', value: 'J06B' }, { field: 'atc_code', op: 'not_in', values: ['J06BB16'] }] },
    { field: 'atc_code', op: 'in', values: ['L04AA03', 'L04AA04'] }] };
  const pv = await R.previewRule(rule, rows, imp);
  assert.deepEqual(codes(pv), ['0A00005100', 'A000001100', 'A000002100', 'A000003100', 'B000004100', 'B000007100']);
  assert.ok(!codes(pv).includes('A000006100'));
  // NOT 形式
  const pv2 = await R.previewRule({ op: 'and', children: [{ field: 'atc_code', op: 'starts_with', value: 'J06B' }, { op: 'not', child: { field: 'atc_code', op: 'eq', value: 'J06BB16' } }] }, rows, imp);
  assert.deepEqual(codes(pv2), ['A000001100', 'A000002100', 'A000003100']);
});

test('T06 分組加規格5mL：排除其他規格，未知單位待確認；提示部分涵蓋分組', async () => {
  const pv = await R.previewRule({ op: 'and', children: [{ field: 'group_code', op: 'eq', value: 'G1AAA0000001' }, { field: 'spec', op: 'eq', value: '5', unit: 'ml' }] }, rows, imp);
  assert.deepEqual(codes(pv, '符合'), ['A000001100']);
  assert.deepEqual(codes(pv, '待確認'), ['A000003100', 'A000006100']);
  assert.ok(!codes(pv).includes('A000002100'));
  assert.ok(pv.warnings.some((w) => w.includes('部分涵蓋分組：G1AAA0000001')));
  assert.equal(pv.groups[0].partial, true);
  assert.equal(pv.reasons['規格單位未知或無換算'], 1);
  assert.equal(pv.reasons['規格缺值'], 1);
  // 數值比較以十進位，不受浮點影響
  const pv2 = await R.previewRule({ field: 'spec', op: 'eq', value: '5.0', unit: 'ML' }, rows, imp);
  assert.deepEqual(codes(pv2, '符合'), ['A000001100']);
  const pv3 = await R.previewRule({ field: 'spec', op: 'gt', value: '5', unit: 'MG' }, rows, imp);
  assert.ok(pv3.members.filter((m) => m.drug_code === 'A000001100').every((m) => m.result === '待確認'));
  // 經確認之換算才換算（預設無）
  const pv4 = await R.previewRule({ field: 'spec', op: 'eq', value: '0.005', unit: 'L' }, rows, { ...imp, check: { ...imp.check, known_units: ['ML', 'L'] } }, { conversions: { 'L|ML': '1000' } });
  assert.deepEqual(codes(pv4, '符合'), ['A000001100']);
});

test('T07 跨品項條件尚未人工確認：不自動當作全部符合，列待確認', async () => {
  const { ast, issues } = R.parseRuleText('ATC7碼=B01AA03 且 同廠牌其他規格');
  assert.equal(ast.op, 'manual');
  assert.ok(issues.some((x) => x.includes('跨品項')));
  const pv = await R.previewRule({ op: 'and', children: [{ field: 'group_code', op: 'eq', value: 'G1CCC0000001' }, ast] }, rows, imp);
  assert.equal(pv.match, 0);
  assert.deepEqual(codes(pv, '待確認'), ['B000004100', 'B000007100']);
  assert.ok(pv.warnings.some((w) => w.includes('人工條件')));
});

test('驗證：空規則、未知欄位／運算子、多餘屬性、空值皆拒絕；未映射欄位停用；須已啟用主檔', async () => {
  for (const bad of [{ op: 'and', children: [] }, { field: 'evil', op: 'eq', value: 'x' }, { field: 'group_code', op: 'like', value: 'x' },
    { field: 'group_code', op: 'eq', value: 'x', sql: '1=1' }, { field: 'group_code', op: 'in', values: [] }, { field: 'spec', op: 'eq', value: 'abc', unit: 'ML' },
    { field: 'spec', op: 'eq', value: '5' }, { op: 'not' }, null, 'group_code=1']) {
    assert.throws(() => R.validateRule(bad), (e) => e.code === 'RULE', JSON.stringify(bad));
  }
  await assert.rejects(() => R.previewRule({ field: 'ingredient', op: 'eq', value: 'X' }, rows, imp), (e) => e.code === 'FIELD_DISABLED');
  await assert.rejects(() => R.previewRule({ field: 'group_code', op: 'eq', value: 'X' }, rows, { ...imp, status: '已停用' }), (e) => e.code === 'MASTER_NOT_ACTIVE');
  const pv = await R.previewRule({ field: 'drug_code', op: 'eq', value: 'NONE' }, rows, imp);
  assert.ok(pv.warnings.some((w) => w.includes('零筆')));
  const big = await R.previewRule({ field: 'dose_code', op: 'ne', value: 'ZZ' }, rows, imp, { threshold: 3 });
  assert.ok(big.warnings.some((w) => w.includes('超過警示門檻')));
});

test('規則雜湊與鍵順序無關；說明文字', async () => {
  const a = { op: 'and', children: [{ field: 'group_code', op: 'eq', value: 'G1' }] };
  const b = { children: [{ value: 'G1', op: 'eq', field: 'group_code' }], op: 'and' };
  assert.equal(await R.ruleHash(a), await R.ruleHash(b));
  assert.match(R.describe({ op: 'or', children: [{ field: 'atc_code', op: 'starts_with', value: 'J06B' }, { op: 'not', child: { field: 'spec', op: 'eq', value: '5', unit: 'ML' } }] }), /任一符合：\n　ATC碼 前綴為 J06B\n　排除：\n　　規格 = 5 ML/);
});

test('原文規則解析：分組、ATC前綴、排除、規格；=0 與 O/0 疑義標示不修正；無法解析保存為人工條件', () => {
  let r = R.parseRuleText('(ATC前4碼=J06B & ATC7碼<>J06BB16) or ATC7碼=L04AA03  or ATC7碼=L04AA04');
  assert.deepEqual(r.ast, { op: 'or', children: [{ op: 'and', children: [{ field: 'atc_code', op: 'starts_with', value: 'J06B' }, { field: 'atc_code', op: 'ne', value: 'J06BB16' }] },
    { field: 'atc_code', op: 'eq', value: 'L04AA03' }, { field: 'atc_code', op: 'eq', value: 'L04AA04' }] });
  r = R.parseRuleText('分類分組代碼＝N06FLU212114');
  assert.deepEqual(r.ast, { field: 'group_code', op: 'eq', value: 'N06FLU212114' });
  r = R.parseRuleText('分組代碼=L01DOX412202 & 規格量=20MG');
  assert.deepEqual(r.ast.children[1], { field: 'spec', op: 'eq', value: '20', unit: 'MG' });
  r = R.parseRuleText('ATC7碼=RO5DA04');
  assert.ok(r.issues.some((x) => x.includes('O／數字0')));
  assert.equal(r.ast.value, 'RO5DA04');
  r = R.parseRuleText('(分組代碼=B01WAR) =0');
  assert.ok(r.issues.some((x) => x.includes('=0')));
  r = R.parseRuleText('看起來像中文描述的條件');
  assert.equal(r.ast.op, 'manual');
  assert.equal(R.parseRuleText('').ast, null);
});

test('真實資料（SPECDRUG_WORKBOOK＋SPECDRUG_MASTER）：活頁簿1 篩選原則全數預覽於10秒內', { skip: !(process.env.SPECDRUG_WORKBOOK && process.env.SPECDRUG_MASTER) && '未提供 SPECDRUG_WORKBOOK／SPECDRUG_MASTER，略過' }, async () => {
  const { readFileSync } = await import('node:fs');
  const { openTable, readHeaders, cellText } = await import('../src/core/table.js');
  const M = await import('../src/core/masterImport.js');
  const mt = openTable(process.env.SPECDRUG_MASTER, new Uint8Array(readFileSync(process.env.SPECDRUG_MASTER)));
  const s = await M.stageMaster({ table: mt, sheet: mt.sheets[0], mapping: M.presetMapping('monthly', readHeaders(mt, mt.sheets[0], 1), '2026-11-01'), baseDate: '2026-11-01' });
  const realRows = M.stagedAsRows(s);
  const realImp = { id: 'real', status: '已啟用', base_date: '2026-11-01', check: s.check };
  const wb = openTable(process.env.SPECDRUG_WORKBOOK, new Uint8Array(readFileSync(process.env.SPECDRUG_WORKBOOK)));
  const h = readHeaders(wb, 'final', 1);
  const ci = h.findIndex((x) => x.replace(/\s/g, '').startsWith('篩選原則'));
  let n = 0; let manual = 0; let worst = 0; let zero = 0;
  for (const r of wb.rows('final')) {
    if (r.rowNo === 1) continue;
    const { ast } = R.parseRuleText(cellText(r.cells.get(ci)));
    if (!ast) continue;
    n++;
    if (ast.op === 'manual') manual++;
    const t = Date.now();
    const pv = await R.previewRule(ast, realRows, realImp);
    worst = Math.max(worst, Date.now() - t);
    if (!pv.members.length) zero++;
  }
  console.log(`活頁簿1：${n} 條規則，人工條件 ${manual}，零筆 ${zero}，單條最慢 ${worst} ms`);
  assert.ok(n > 250);
  assert.ok(worst < 10000);
});
