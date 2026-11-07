// 匯出共用流程：選格式→有未儲存變更先提示→另存對話框帶預設檔名→寫入匯出紀錄（失敗僅提示）。
import { h, dialog, alertBox } from './dom.js';
import { saveBlobAs } from './files.js';
import * as X from '../core/exporter.js';
import * as M from '../core/masterImport.js';
import { actorText } from '../core/model.js';

const namer = new X.ExportNamer();

export function exportNamer() {
  return namer;
}

function data(s) {
  return s.mode === 'edit' ? s.work : s.committed.data;
}

// spec：{kind, condition, day, headers, rows, sheetName}
export async function exportTable(s, spec) {
  const unsaved = s.mode === 'edit' && s.dirty > 0;
  const fmt = h('select', { 'aria-label': '匯出格式' }, h('option', { value: 'xlsx', text: 'Excel（.xlsx）' }), h('option', { value: 'csv', text: 'CSV（UTF-8）' }));
  const ok = await dialog(`匯出${spec.kind}`, [
    h('p', { text: `共 ${spec.rows.length} 筆。條件：${spec.condition || '（無）'}` }),
    unsaved ? h('p', { class: 'warn-text', text: `目前有 ${s.dirty} 項未儲存變更；匯出內容含未儲存資料，檔名將標示「+未儲存」。建議先儲存再匯出。` }) : null,
    h('label', null, '格式 ', fmt),
    h('p', { class: 'note', text: '將以「另存」對話框帶入預設檔名；檔名可改，檔內「匯出說明」仍保留版本資訊。' })],
  [{ label: '取消', value: false }, { label: '匯出', value: true, primary: true }]);
  if (!ok) return null;
  const d = data(s);
  const imp = M.activeImport(d);
  const info = {
    kind: spec.kind, ms: Date.now(), actor: actorText(s.session), revision: s.current ? s.current.revision : 0, unsaved,
    versionSha: s.current ? s.current.sha256 : null, master: imp ? { base_date: imp.base_date, source_name: imp.source_name, sha256: imp.sha256 } : null,
    condition: spec.condition, day: spec.day, count: spec.rows.length,
  };
  const files = X.buildExport({ format: fmt.value, info, headers: spec.headers, rows: spec.rows, sheetName: spec.sheetName, csvNotes: s.settings.csv_header_notes !== false, namer });
  const saved = [];
  for (const f of files) {
    const r = await saveBlobAs(f.name, new Blob([f.bytes], { type: f.mime }));
    if (!r || !r.saved) break;
    saved.push(f);
  }
  const fails = [];
  for (const f of saved) {
    try { await X.logExport(s.fs, f, info); } catch (e) { fails.push(f.name); }
  }
  if (fails.length) await alertBox('匯出紀錄未寫入', `檔案已匯出，但寫入資料夾匯出紀錄失敗：${fails.join('、')}`, '可能為查詢模式無寫入權；不影響已下載檔案。');
  return saved;
}
