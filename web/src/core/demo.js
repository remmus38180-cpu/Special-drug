// 模擬資料（非真實資料）：供教育訓練與驗收展示。只可載入「新資料夾」（尚無任何業務資料）。
// 內容：模擬主檔、通過／未通過／辦理中案件、多次會議、逐品項決議、認定版本與快照、合約、調高與註記。
import { SpecError } from './errors.js';
import { insert, setConfirmStatus, setDedicated, list, SCHEMA } from './model.js';
import { masterPath } from './paths.js';
import { ROW_FIELDS, normAnnotation } from './masterImport.js';

export const DEMO_MASTER_COLUMNS = ['drug_code', 'drug_name', 'firm', 'group_code', 'atc_code', 'dose_code', 'dose_name', 'multi_mark', 'spec_qty', 'spec_unit', 'price', 'annotation_raw'];

const DEMO_ROWS = [
  ['DEMO000001', '模擬注射劑甲 5ML', '模擬藥廠甲', 'DEMOGRP00001', 'J06BA01', '20', '注射劑', 'N', '5', 'ML', '120', '0'],
  ['DEMO000002', '模擬注射劑乙 10ML', '模擬藥廠乙', 'DEMOGRP00001', 'J06BA01', '20', '注射劑', 'N', '10', 'ML', '200', '0'],
  ['DEMO000003', '模擬錠劑丙', '模擬藥廠丙', 'DEMOGRP00002', 'L04AA03', '11', '一般錠劑膠囊劑', 'N', '', '', '8.5', '3'],
  ['DEMO000004', '模擬錠劑丁', '模擬藥廠甲', 'DEMOGRP00003', 'L04AA04', '11', '一般錠劑膠囊劑', 'Y', '', '', '6', '0'],
  ['DEMO000005', '模擬眼藥水', '模擬藥廠乙', 'DEMOGRP00004', 'S01FA01', '43', '眼用液劑', 'N', '5', 'ML', '45', '4'],
  ['0DEMO00006', '模擬前導零品項', '模擬藥廠丙', 'DEMOGRP00004', 'S01FA01', '43', '眼用液劑', 'N', '10', 'ML', '52.50', '0'],
];

export function hasBusinessData(data) {
  return Object.keys(SCHEMA).some((c) => c !== 'op_log' && (data.collections[c] || []).length > 0);
}

// 主檔列資料檔內容（masters/<import_id>.json）
export function demoMasterFile(importId) {
  const rows = DEMO_ROWS.map((r, i) => {
    const o = {};
    DEMO_MASTER_COLUMNS.forEach((c, j) => { o[c] = r[j] === '' ? null : r[j]; });
    o.drug_code_raw = o.drug_code;
    o.annotation = normAnnotation(o.annotation_raw);
    o.source_row = i + 2;
    return ROW_FIELDS.map((f) => (o[f] === undefined ? null : o[f]));
  });
  const file = {
    format: 'specdrug-master', import_id: importId, source_name: '模擬主檔.csv', base_date: '2026-10-01',
    source_sha256: null, fields: ROW_FIELDS, rows,
  };
  return { path: masterPath(importId), text: JSON.stringify(file) + '\n', rowCount: rows.length };
}

// 於資料副本上建立模擬資料；master：{importId, path, sha256, rowCount}
export function buildDemo(data, ctx, master) {
  if (hasBusinessData(data)) throw new SpecError('NOT_NEW_FOLDER', '此資料夾已有業務資料；示範資料只能載入到新資料夾');
  const I = (coll, v, o) => insert(data, ctx, coll, v, o);
  data.info = { ...(data.info || {}), demo: true, demo_loaded_at: ctx.now };

  const imp = I('master_import', {
    source_name: '模擬主檔.csv', sha256: master.sha256, base_date: '2026-10-01', sheet: null, header_row: 1,
    mapping: Object.fromEntries(DEMO_MASTER_COLUMNS.map((c) => [c, c])), row_count: master.rowCount,
    check: { duplicates: 0, conflicts: 0, missing: 0 }, rows_file: master.path, rows_sha256: master.sha256,
    status: '試匯入', note: '模擬資料',
  });
  setDedicated(data, ctx, 'master_import', imp.id, { status: '已啟用', activated_by: ctx.actor, activated_at: ctx.now },
    { action: '啟用主檔', fields: ['status', 'activated_by', 'activated_at'] });

  // 案件一：多次會議，部分同意，接續認定、簽約、調高
  const ok = I('case_record', {
    case_no: 'DEMO2026-0001', subject: '模擬注射劑建議列特殊藥品', applicant: '模擬藥廠甲', recv_date: '2026-03-02',
    recv_doc_no: '模擬收文001', unit: '調價', handler: '承辦A',
  });
  const cd1 = I('case_drug', { case_id: ok.id, drug_code: 'DEMO000001', drug_name_text: '模擬注射劑甲 5ML' });
  const cd2 = I('case_drug', { case_id: ok.id, drug_code: 'DEMO000002', drug_name_text: '模擬注射劑乙 10ML' });
  const m1 = I('meeting', { meeting_type: '專家', name: '模擬專家會議115年4月', meeting_date: '2026-04-10', session_no: '115-1' });
  const m2 = I('meeting', { meeting_type: '共同擬訂', name: '模擬擬訂會議115年6月', meeting_date: '2026-06-18', session_no: '115-2' });
  const a1 = I('meeting_agenda', { meeting_id: m1.id, case_id: ok.id, agenda_no: '3', subject: '模擬注射劑建議列特殊藥品' });
  const d1 = I('decision', { agenda_id: a1.id, nature: '專家建議', result: '同意', result_text: '建議同意甲品項；乙品項暫緩。' });
  I('decision_drug', { decision_id: d1.id, case_drug_id: cd1.id, result: '同意' });
  I('decision_drug', { decision_id: d1.id, case_drug_id: cd2.id, result: '暫緩' });
  const a2 = I('meeting_agenda', { meeting_id: m2.id, case_id: ok.id, agenda_no: '5', subject: '模擬注射劑建議列特殊藥品' });
  const d2 = I('decision', { agenda_id: a2.id, nature: '會議決議', result: '附條件同意', result_text: '甲品項附條件同意；乙品項不同意。', conditions: '須完成穩定供貨簽約' });
  I('decision_drug', { decision_id: d2.id, case_drug_id: cd1.id, result: '附條件同意', conditions: '須完成穩定供貨簽約' });
  I('decision_drug', { decision_id: d2.id, case_drug_id: cd2.id, result: '不同意' });
  setDedicated(data, ctx, 'case_record', ok.id, {
    result_summary: '部分同意', result_decision_ids: [d2.id], result_confirmed_by: ctx.actor, result_confirmed_at: ctx.now,
  }, { action: '確認結果摘要', fields: ['result_summary', 'result_decision_ids', 'result_confirmed_by', 'result_confirmed_at'] });

  const rec = I('recognition', { recognition_no: 'DEMO-R0001', name: '模擬注射劑（5ML規格）', unit: '調價' });
  const rule = { op: 'and', children: [
    { field: 'group_code', op: 'eq', value: 'DEMOGRP00001' },
    { field: 'spec', op: 'eq', value: '5', unit: 'ML' },
  ] };
  const rev = I('recognition_revision', {
    recognition_id: rec.id, revision_no: 1, category: '不可替代特殊藥品', scope_text: '分組代碼=DEMOGRP00001 & 規格量=5mL',
    rule, conditions_text: '須完成穩定供貨簽約', effective_from: '2026-08-01', decision_id: d2.id, case_id: ok.id,
  });
  I('revision_decision', { revision_id: rev.id, decision_id: d2.id, link_type: '依據' });
  const snap = I('scope_snapshot', {
    revision_id: rev.id, import_id: imp.id, rule_hash: 'demo', rule, evaluated_at: ctx.now, match_count: 1, pending_count: 0,
    note: '模擬資料：DEMOGRP00001 僅 5ML 規格符合（部分涵蓋分組）',
  });
  I('scope_member', { snapshot_id: snap.id, drug_code: 'DEMO000001', eval_result: '符合', path: 'group_code=DEMOGRP00001 且 規格=5 ML', group_code: 'DEMOGRP00001', source_row: 2 });
  setDedicated(data, ctx, 'scope_snapshot', snap.id, { status: '已確認', confirmed_by: ctx.actor, confirmed_at: ctx.now },
    { action: '確認快照', fields: ['status', 'confirmed_by', 'confirmed_at'] });
  setConfirmStatus(data, ctx, 'recognition_revision', rev.id, '已確認');
  I('group_treatment', { group_code: 'DEMOGRP00001', revision_id: rev.id, method: '待確認', partial_cover: true, basis: '部分涵蓋分組，調價方式待確認（Q02）' });

  const cont = I('contract', {
    contract_no: '模擬合約-001', firm: '模擬藥廠甲', status: '完成簽署', signed_date: '2026-07-01', effective_from: '2026-08-01',
    expiry_date: '2029-07-31', obligations: '穩定供貨三年', doc_version: '1',
  });
  I('contract_drug', { contract_id: cont.id, drug_code: 'DEMO000001', effective_from: '2026-08-01' });
  const pa = I('price_action', {
    case_id: ok.id, drug_code: 'DEMO000001', revision_id: rev.id, snapshot_id: snap.id, contract_requirement: '須簽約',
    requirement_basis: '模擬：現行須簽約', contract_id: cont.id, price_before: '120', price_after: '180', effective_date: '2026-08-01',
    announce_doc_no: '模擬公告001', announce_date: '2026-07-15', status: '已核定',
  });
  const an = I('annotation_event', {
    drug_code: 'DEMO000001', revision_id: rev.id, price_action_id: pa.id, category: '不可替代特殊藥品', action: '新增',
    effective_date: '2026-08-01', basis: '模擬公告001',
  });
  setConfirmStatus(data, ctx, 'price_action', pa.id, '已確認');
  setConfirmStatus(data, ctx, 'annotation_event', an.id, '已確認');

  // 案件二：未通過（兩種會議），已結案
  const no = I('case_record', { case_no: 'DEMO2026-0002', subject: '模擬眼藥水申請提高', applicant: '模擬藥廠乙', recv_date: '2026-02-01', recv_doc_no: '模擬收文002', unit: '核價', handler: '承辦B' });
  const cd5 = I('case_drug', { case_id: no.id, drug_code: 'DEMO000005', drug_name_text: '模擬眼藥水' });
  const a3 = I('meeting_agenda', { meeting_id: m1.id, case_id: no.id, agenda_no: '4', subject: '模擬眼藥水申請提高' });
  const d3 = I('decision', { agenda_id: a3.id, nature: '專家建議', result: '補充資料後再議' });
  I('decision_drug', { decision_id: d3.id, case_drug_id: cd5.id, result: '補充資料後再議' });
  const a4 = I('meeting_agenda', { meeting_id: m2.id, case_id: no.id, agenda_no: '6', subject: '模擬眼藥水申請提高（重提）' });
  const d4 = I('decision', { agenda_id: a4.id, nature: '會議決議', result: '不同意' });
  I('decision_drug', { decision_id: d4.id, case_drug_id: cd5.id, result: '不同意' });
  setDedicated(data, ctx, 'case_record', no.id, {
    result_summary: '全部不同意', result_decision_ids: [d4.id], result_confirmed_by: ctx.actor, result_confirmed_at: ctx.now,
  }, { action: '確認結果摘要', fields: ['result_summary', 'result_decision_ids', 'result_confirmed_by', 'result_confirmed_at'] });
  setDedicated(data, ctx, 'case_record', no.id, { status: '已結案', close_reason: '共擬不同意', close_basis: '模擬擬訂會議115年6月紀錄' },
    { action: '結案', fields: ['status', 'close_reason', 'close_basis'] });

  // 案件三：辦理中、收文資料不完整（歷史補登）
  I('case_record', { case_no: 'DEMO2026-0003', subject: '模擬錠劑丙申請列特殊藥品', applicant: null, completeness: '待確認', pending_fields: 'recv_date,recv_doc_no,applicant', status: '待提會' });

  return { importId: imp.id, counts: Object.fromEntries(Object.keys(SCHEMA).map((c) => [c, list(data, c).length])) };
}
