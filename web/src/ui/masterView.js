// 主檔匯入畫面（第7節、第10節）：選檔、工作表與標題列、欄位映射、試匯入檢核、差異預覽、啟用、歷史版本。
import { h, table, dialog, alertBox } from './dom.js';
import * as M from '../core/masterImport.js';
import { openTable, readHeaders } from '../core/table.js';
import { parseDate, rocDisplay } from '../core/values.js';
import { newId } from '../core/util.js';
import { find } from '../core/model.js';

const rowsCache = new Map();

export async function masterRows(s, imp) {
  if (!imp) return null;
  if (rowsCache.has(imp.id)) return rowsCache.get(imp.id);
  const r = await M.loadMasterRows(s.fs, imp);
  rowsCache.set(imp.id, r);
  return r;
}

export function masterStatusText(data) {
  const a = M.activeImport(data);
  if (!a) return '主檔：尚未匯入';
  return `主檔：${a.source_name}（基準日 ${a.base_date || '未填'}，${a.row_count} 筆）`;
}

function nextTick() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

export function masterTab(env) {
  const { s, ui, btn, guard, render } = env;
  ui.master = ui.master || {};
  const st = ui.master;
  const d = data(env);
  const act = M.activeImport(d);
  const parts = [];
  parts.push(h('section', { class: 'panel' }, h('h2', { text: '目前主檔版本' }),
    act ? table(['項目', '內容'], [
      ['來源檔', act.source_name], ['來源檔SHA-256', act.sha256], ['資料基準日', act.base_date ? `${act.base_date}（${rocDisplay(act.base_date)}）` : '未填'],
      ['代碼數', String(act.row_count)], ['啟用', `${act.activated_by || ''}，${act.activated_at || ''}`], ['備註', act.note || ''],
      ['規則停用欄位（未映射）', (act.check && act.check.disabled_rule_fields || []).join('、') || '無'],
    ]) : h('p', { text: '尚未匯入主檔。規則預覽與快照須使用已啟用之主檔。' })));
  parts.push(historyPanel(env, d, act));
  if (s.mode === 'edit') parts.push(importPanel(env, act));
  else parts.push(h('section', { class: 'panel' }, h('p', { class: 'note', text: '匯入新主檔須先取得編輯牌。' })));
  if (st.diffView) parts.push(st.diffView);
  void guard; void btn; void render;
  return parts;
}

function historyPanel(env, d, act) {
  const { btn, guard, ui, render } = env;
  const imps = M.listImports(d);
  return h('section', { class: 'panel' }, h('h2', { text: `歷史版本（${imps.length}）` }),
    h('p', { class: 'note', text: '新版本啟用後舊版保留（已停用），列資料檔不覆寫。主檔消失品項不自動刪除認定或解讀成取消給付。' }),
    table(['狀態', '資料基準日', '代碼數', '來源檔', 'SHA-256前8碼', '啟用時間', ''], imps.map((m) => [
      m.status, m.base_date || '', String(m.row_count), m.source_name, (m.sha256 || '').slice(0, 8), m.activated_at || m.created_at,
      act && m.id !== act.id ? btn('與目前版本比較', () => guard(async () => {
        const [o, n] = [await masterRows(env.s, m), await masterRows(env.s, act)];
        ui.master.diffView = diffPanel(env, M.diffMasters(o, n), `${m.source_name}（${m.base_date}）→ ${act.source_name}（${act.base_date}）`);
        render();
      })) : '',
    ])));
}

function diffPanel(env, diff, title) {
  const fields = Object.entries(diff.fieldCount).map(([f, n]) => `${M.FIELD_LABEL[f] || f} ${n}`).join('、');
  return h('section', { class: 'panel' }, h('h2', { text: '版本差異：' + title }),
    table(['項目', '筆數'], [['新增品項', String(diff.added.length)], ['消失品項（不自動取消認定）', String(diff.removed.length)], ['欄位異動品項', String(diff.changed.length)], ['異動欄位分布', fields || '—']]),
    diff.added.length ? h('p', { class: 'note', text: '新增（前100）：' + diff.added.slice(0, 100).join('、') }) : null,
    diff.removed.length ? h('p', { class: 'note', text: '消失（前100）：' + diff.removed.slice(0, 100).join('、') }) : null,
    diff.changed.length ? table(['藥品代碼', '異動（舊→新）'], diff.changed.slice(0, 200).map((c) => [c.drug_code,
      Object.entries(c.diffs).map(([f, [a, b]]) => `${M.FIELD_LABEL[f] || f}：${a ?? '（空）'}→${b ?? '（空）'}`).join('；')])) : null,
    diff.changed.length > 200 ? h('p', { class: 'note', text: `僅列前200筆，共 ${diff.changed.length} 筆。` }) : null,
    env.btn('關閉差異', () => { env.ui.master.diffView = null; env.render(); }));
}

function fileInput(label, onFile) {
  return h('label', null, label + ' ', h('input', { type: 'file', accept: '.xlsx,.csv', on: { change: (e) => { const f = e.target.files[0]; if (f) onFile(f); } } }));
}

function importPanel(env, act) {
  const { btn, guard, ui, render } = env;
  const st = ui.master;
  const box = h('section', { class: 'panel' }, h('h2', { text: '匯入新主檔' }),
    h('p', { class: 'note', text: '支援 .xlsx 及 CSV UTF-8。不依固定欄序：請選工作表、標題列並確認欄位映射。試匯入不改目前主檔；確認後才啟用。大量匯入前建議先匯出備份。' }));
  const status = h('p', { class: 'note', role: 'status' }, st.progress || '');
  st.progressEl = status;
  box.appendChild(h('div', { class: 'filters' }, fileInput('主檔檔案', (f) => guard(async () => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    status.textContent = `讀取 ${f.name}（${(bytes.length / 1048576).toFixed(1)} MB）…`;
    await nextTick();
    const t = openTable(f.name, bytes);
    Object.assign(st, { file: { name: f.name, bytes }, table: t, sheet: t.sheets[0], headerRow: 1, headers: null, staged: null, diffView: null, progress: '' });
  }))));
  if (st.table) {
    const sheetSel = h('select', { 'aria-label': '工作表', on: { change: (e) => { st.sheet = e.target.value; st.headers = null; st.staged = null; render(); } } },
      st.table.sheets.map((n) => h('option', { value: n, text: n, selected: n === st.sheet })));
    const hdr = h('input', { type: 'number', value: String(st.headerRow), min: '1', style: 'width:5em', 'aria-label': '標題列' });
    box.appendChild(h('div', { class: 'filters' }, h('span', { text: `檔案：${st.file.name}` }), h('label', null, '工作表 ', sheetSel), h('label', null, '標題列 ', hdr),
      btn('讀取標題列', () => guard(async () => {
        st.headerRow = Math.max(1, Number(hdr.value) || 1);
        status.textContent = '讀取標題列…';
        await nextTick();
        st.headers = readHeaders(st.table, st.sheet, st.headerRow);
        st.mapping = M.presetMapping(st.preset || 'monthly', st.headers, parseDate(st.baseDate || '') || null);
        st.staged = null;
      }))));
  }
  if (st.headers) box.appendChild(mappingForm(env));
  if (st.staged) box.appendChild(stagedPanel(env, act));
  box.appendChild(status);
  return box;
}

function mappingForm(env) {
  const { btn, guard, ui, render } = env;
  const st = ui.master;
  const presetSel = h('select', { 'aria-label': '預設映射', on: { change: (e) => {
    st.preset = e.target.value;
    st.mapping = M.presetMapping(st.preset, st.headers, parseDate(st.baseDate || '') || null);
    st.staged = null; render();
  } } }, M.PRESETS.map((p) => h('option', { value: p.key, text: p.label, selected: p.key === (st.preset || 'monthly') })));
  const base = h('input', { type: 'text', size: 14, value: st.baseDate || '', placeholder: 'YYYY-MM-DD 或 115/11/01', 'aria-label': '資料基準日' });
  base.addEventListener('change', () => {
    st.baseDate = base.value.trim();
    const iso = parseDate(st.baseDate);
    if (iso && (st.preset || 'monthly') === 'monthly') { const pc = M.suggestPriceColumn(st.headers, iso); if (pc) st.mapping.price = pc; }
    st.staged = null; render();
  });
  const preset = M.PRESETS.find((p) => p.key === (st.preset || 'monthly'));
  const sel = {};
  const rows = M.MASTER_FIELDS.map(([k, label]) => {
    const s = h('select', { 'aria-label': label }, h('option', { value: '', text: '（不映射）' }),
      st.headers.map((x) => h('option', { value: x, text: x, selected: st.mapping[k] === x })));
    sel[k] = s;
    const lk = preset.lookups && preset.lookups[k];
    return [label, s, lk ? `經代碼檔 type ${lk.type} 轉換` : ''];
  });
  const usePrice = h('input', { type: 'checkbox', checked: !!st.usePriceLong });
  usePrice.addEventListener('change', () => { st.usePriceLong = usePrice.checked; render(); });
  const form = h('div', null,
    h('div', { class: 'filters' }, h('label', null, '預設映射 ', presetSel), h('label', null, '資料基準日＊ ', base)),
    h('p', { class: 'note', text: preset.note }),
    table(['系統欄位', '來源欄', '說明'], rows),
    h('div', { class: 'filters' }, h('label', null, usePrice, ' 支付價改由多期價格長表（如 DWM_DRPAY）依基準日取得')),
    st.usePriceLong ? h('div', { class: 'filters' }, fileInput('價格長表', (f) => guard(async () => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      st.priceFile = { name: f.name, bytes, table: openTable(f.name, bytes) };
      st.priceFile.headers = readHeaders(st.priceFile.table, st.priceFile.table.sheets[0], 1);
    })), st.priceFile ? h('span', { text: `${st.priceFile.name}：欄位 ${st.priceFile.headers.length} 個；預設 DRUG_CODE／PAY_S_DATE／PAY_E_DATE（含）／PAY_PRICE` }) : null) : null,
    h('div', { class: 'filters' }, fileInput(preset.lookups ? '代碼檔（DWM_DRUG_RCODE，必要）' : '代碼檔（DWM_DRUG_RCODE，選用：提供規格單位清單）', (f) => guard(async () => {
      const bytes = new Uint8Array(await f.arrayBuffer());
      st.rcodeFile = { name: f.name, bytes };
    })), st.rcodeFile ? h('span', { text: st.rcodeFile.name }) : h('span', { class: 'note', text: '未提供時，已知規格單位用內建清單（14種）；提供時取 type 2 規格單位代碼之英文名。' })),
    h('div', { class: 'toolbar' }, btn('試匯入（不改目前主檔）', () => guard(async () => {
      const mapping = {};
      for (const [k, s] of Object.entries(sel)) if (s.value) mapping[k] = s.value;
      st.mapping = mapping;
      st.baseDate = base.value.trim();
      const iso = parseDate(st.baseDate);
      if (!iso) { await alertBox('請填資料基準日', '主檔啟用須有資料基準日（例：2026-11-01）。'); return; }
      const prog = (label) => async (n) => { st.progressEl.textContent = `${label}：已處理 ${n.toLocaleString()} 列…`; await nextTick(); };
      let rcode = null; let price = null;
      if (preset.lookups && !st.rcodeFile) { await alertBox('缺代碼檔', '此預設映射需 DWM_DRUG_RCODE 代碼檔。'); return; }
      if (st.rcodeFile) {
        const t = openTable(st.rcodeFile.name, st.rcodeFile.bytes);
        rcode = await M.loadRcode(t, { sheet: t.sheets[0], tick: prog('讀取代碼檔') });
      }
      if (st.usePriceLong) {
        if (!st.priceFile) { await alertBox('缺價格長表', '請選擇價格長表檔案。'); return; }
        price = await M.loadPriceLong(st.priceFile.table, { sheet: st.priceFile.table.sheets[0], cols: { code: 'DRUG_CODE', from: 'PAY_S_DATE', to: 'PAY_E_DATE', price: 'PAY_PRICE' }, baseDate: iso, tick: prog('讀取價格長表') });
        delete mapping.price;
      }
      const t0 = Date.now();
      const staged = await M.stageMaster({ table: st.table, sheet: st.sheet, headerRow: st.headerRow, mapping, baseDate: iso, lookups: preset.lookups || null, rcode, price, tick: prog('試匯入') });
      staged.priceInfo = st.usePriceLong ? { source: st.priceFile.name, rule: '起日≤基準日≤迄日（迄日含）' } : null;
      st.staged = staged;
      st.progress = `試匯入完成：${staged.check.total_rows.toLocaleString()} 列、${staged.check.codes.toLocaleString()} 代碼，耗時 ${((Date.now() - t0) / 1000).toFixed(1)} 秒。`;
      const act = M.activeImport(data(env));
      st.stagedDiff = act ? M.diffMasters(await masterRows(env.s, act), M.stagedAsRows(staged)) : null;
    }), { primary: true })));
  return form;
}

function stagedPanel(env, act) {
  const { btn, guard, ui } = env;
  const st = ui.master;
  const c = st.staged.check;
  const problems = M.activationProblems(st.staged, { confirmMerge: true });
  const list = (arr, fmt) => (arr.length ? h('ul', null, arr.slice(0, 50).map((x) => h('li', { text: fmt(x) }))) : null);
  return h('div', null,
    h('h3', { text: '試匯入檢核結果' }),
    table(['項目', '結果'], [
      ['資料列', String(c.total_rows)], ['代碼數', String(c.codes)], ['資料基準日', c.base_date || '未填'],
      ['代碼錯誤（阻止啟用）', String(c.code_error_count)], ['同代碼內容矛盾（阻止啟用）', String(c.conflict_count)],
      ['完全相同重複（確認後合併）', String(c.identical_duplicate_count)], ['警告', String(c.warning_count)],
      ['已知規格單位來源', `${c.unit_source}（${c.known_units.length} 種）`],
      ['未知規格單位（規則判定待確認）', Object.entries(c.unknown_units).map(([u, n]) => `${u}（${n}）`).join('、') || '無'],
      ['代碼轉換找不到', Object.entries(c.unknown_lookup_count).map(([k, n]) => `${M.FIELD_LABEL[k]} ${n}`).join('、') || '無'],
      ['未映射欄位', c.unmapped_fields.map((k) => M.FIELD_LABEL[k]).join('、') || '無'],
      ['因此停用之規則欄位', c.disabled_rule_fields.join('、') || '無'],
      ['缺值筆數', Object.entries(c.missing_values).filter(([, n]) => n).map(([k, n]) => `${M.FIELD_LABEL[k]} ${n}`).join('、') || '無'],
    ]),
    c.code_errors.length ? h('div', null, h('h4', { text: '代碼錯誤（前50）' }), list(c.code_errors, (x) => `第${x.row}列：${x.error}`)) : null,
    c.conflicts.length ? h('div', null, h('h4', { text: '矛盾（前50）' }), list(c.conflicts, (x) => `${x.code}（列 ${x.rows.join(',')}）：${Object.entries(x.diffs).map(([k, v]) => `${M.FIELD_LABEL[k] || k} ${v.join(' ≠ ')}`).join('；')}${x.note ? '（' + x.note + '）' : ''}`)) : null,
    c.warnings.length ? h('div', null, h('h4', { text: '警告（前50）' }), list(c.warnings, (x) => x)) : null,
    st.stagedDiff ? diffPanel(env, st.stagedDiff, `目前版本（${act.base_date}）→ 本次試匯入（${c.base_date}）`) : h('p', { class: 'note', text: '目前無已啟用主檔，無差異可比。' }),
    problems.filter((p) => !p.includes('確認合併')).length
      ? h('p', { class: 'warn-text', text: '不可啟用：' + problems.join('；') })
      : h('div', { class: 'toolbar' }, btn('確認並啟用此版本', () => guard(() => doActivate(env)), { primary: true })));
}

async function doActivate(env) {
  const st = env.ui.master;
  const c = st.staged.check;
  const opId = newId();
  const merge = h('input', { type: 'checkbox' });
  const note = h('input', { type: 'text', size: 30 });
  const v = await dialog('啟用主檔版本', [
    h('p', { text: `將啟用 ${st.file.name}（基準日 ${c.base_date}，${c.codes} 代碼）。舊版改為「已停用」並保留；來源檔另存為附件。` }),
    c.identical_duplicate_count ? h('label', null, merge, ` 確認合併 ${c.identical_duplicate_count} 個完全相同重複代碼`) : null,
    h('br'), h('label', null, '備註 ', note),
  ], [{ label: '取消', value: null }, { label: '啟用', value: true, primary: true }]);
  if (!v) return;
  const sources = [{ role: '主檔', name: st.file.name, bytes: st.file.bytes, mime: st.file.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }];
  if (st.usePriceLong && st.priceFile) sources.push({ role: '價格長表', name: st.priceFile.name, bytes: st.priceFile.bytes });
  if (st.rcodeFile) sources.push({ role: '代碼檔', name: st.rcodeFile.name, bytes: st.rcodeFile.bytes });
  st.progressEl.textContent = '寫入來源檔與列資料…';
  const r = await M.activateMaster(env.s, st.staged, sources, { confirmMerge: merge.checked, note: note.value.trim() || null, opId });
  env.ui.master = { progress: `已啟用（成為未儲存變更，請按「儲存」）。版本 ${r.import_id.slice(0, 8)}。` };
  const imp = find(env.s.work, 'master_import', r.import_id);
  if (imp) rowsCache.delete(imp.id);
}
