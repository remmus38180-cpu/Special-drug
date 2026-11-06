// 品項明細查詢（T21）：依藥品代碼回溯認定、案件與會議、公告調高、合約、註記、快照、差異待辦。純讀取。
import { list, find } from './model.js';
import { drugRecognitions, drugCategoryOn, listRecognitions, revisionHistory, revisionScope } from './recognition.js';
import { priceHistory, annotationOn, annotationHistory, contractDrugs } from './pricing.js';
import { caseTimeline } from './cases.js';

export function drugDetail(data, drugCode, day, { masterRow } = {}) {
  const code = String(drugCode || '').trim();
  const cases = list(data, 'case_drug').filter((d) => d.drug_code === code).map((cd) => {
    const c = find(data, 'case_record', cd.case_id) || {};
    const results = [];
    for (const a of caseTimeline(data, cd.case_id)) {
      for (const dec of a.decisions) {
        for (const r of dec.drugs) if (r.drug_code === code) results.push({ meeting_date: a.meeting_date, meeting_name: a.meeting_name, nature: dec.nature, result: r.result, conditions: r.conditions || null, superseded: !!dec.superseded });
      }
    }
    return { case_id: c.id, case_no: c.case_no, subject: c.subject, status: c.status, summary: c.result_summary, results };
  });
  const snapshots = list(data, 'scope_member').filter((m) => m.drug_code === code).map((m) => {
    const s = find(data, 'scope_snapshot', m.snapshot_id) || {};
    const rev = find(data, 'recognition_revision', s.revision_id) || {};
    const rec = find(data, 'recognition', rev.recognition_id) || {};
    const imp = find(data, 'master_import', s.import_id) || {};
    return { snapshot_id: s.id, status: s.status, recognition: rec.name, revision_no: rev.revision_no, base_date: imp.base_date, eval_result: m.eval_result, manual_result: m.manual_result, group_code: m.group_code };
  });
  const contracts = list(data, 'contract').filter((c) => contractDrugs(data, c.id).some((d) => d.drug_code === code))
    .map((c) => ({ ...c, item: contractDrugs(data, c.id).find((d) => d.drug_code === code) }));
  const prices = priceHistory(data, code).map((p) => {
    const rev = find(data, 'recognition_revision', p.revision_id) || {};
    const rec = find(data, 'recognition', rev.recognition_id) || {};
    return { ...p, recognition: rec.name, revision_no: rev.revision_no };
  });
  return {
    drug_code: code,
    master: masterRow || null,
    category: drugCategoryOn(data, code, day),
    recognitions: drugRecognitions(data, code, day),
    cases,
    snapshots,
    prices,
    contracts,
    annotation: annotationOn(data, code, day),
    annotations: annotationHistory(data, code),
    todos: list(data, 'review_item').filter((t) => t.drug_code === code),
  };
}

// 以藥品代碼或片段查詢系統中出現過之代碼（認定範圍、案件、調高、合約、註記）
export function knownCodes(data) {
  const s = new Set();
  for (const c of ['case_drug', 'scope_member', 'price_action', 'contract_drug', 'annotation_event', 'review_item']) for (const r of list(data, c)) if (r.drug_code) s.add(r.drug_code);
  return s;
}

// 認定清單匯出列：每個版本一列，並列出涵蓋品項數
export function recognitionExportRows(data, day) {
  const headers = ['認定編號', '認定名稱', `狀態（${day}）`, '版本', '類別', '起日（含）', '迄日（不含）', '版本狀態', '確認狀態', '涵蓋品項數', '涵蓋品項'];
  const rows = [];
  for (const r of listRecognitions(data, { day })) {
    for (const h of revisionHistory(data, r.id, day)) {
      const codes = h.confirm_status === '已確認' ? [...revisionScope(data, h.id)].sort() : [];
      rows.push([r.recognition_no, r.name, r.state, String(h.revision_no), h.category, h.effective_from ? { date: h.effective_from } : '', h.effective_to ? { date: h.effective_to } : '', h.state, h.confirm_status, { n: String(codes.length) }, codes.join(' ')]);
    }
  }
  return { headers, rows };
}
