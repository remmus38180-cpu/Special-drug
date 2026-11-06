// 差異待辦與主檔註記比對：依目前主檔產生差異待辦（新符合、不再符合、分組異動、主檔消失、規則停用）、主檔註記比對、處理結論、匯出。
import { h, table, alertBox } from './dom.js';
import { formDialog, opts } from './forms.js';
import * as D from '../core/diff.js';
import * as M from '../core/masterImport.js';
import { E, find } from '../core/model.js';
import { taipeiToday } from '../core/values.js';
import { newId } from '../core/util.js';
import { masterRows } from './masterView.js';
import { exportTable } from './exportUI.js';

const PAGE = 200;

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

function revLabelOf(d, revId) {
  const r = revId ? find(d, 'recognition_revision', revId) : null;
  if (!r) return '';
  const rec = find(d, 'recognition', r.recognition_id) || {};
  return `${rec.recognition_no || ''} ${rec.name || ''} 第${r.revision_no}版`;
}

export function diffTab(env) {
  const { s, btn, guard, render } = env;
  env.ui.diff = env.ui.diff || { kind: '', status: '待處理', page: 0, compare: null, day: taipeiToday(Date.now()) };
  const st = env.ui.diff;
  const d = data(env);
  const imp = M.activeImport(d);
  const kindSel = h('select', { 'aria-label': '待辦種類' }, [['', '（全部種類）'], ...opts(D.TODO_KINDS)].map(([v, l]) => h('option', { value: v, text: l, selected: v === st.kind })));
  const stSel = h('select', { 'aria-label': '處理狀態' }, [['', '（全部狀態）'], ...opts(E.REVIEW_STATUS)].map(([v, l]) => h('option', { value: v, text: l, selected: v === st.status })));
  const todos = D.listTodos(d, { kind: st.kind || null, status: st.status || null });
  const pageRows = todos.slice(st.page * PAGE, (st.page + 1) * PAGE);
  const t = table(['種類', '藥品代碼', '分組', '認定版本', '主檔版本', '說明', '狀態', '結論', ''], pageRows.map((x) => [
    x.kind, x.drug_code || '', x.group_code || '', revLabelOf(d, x.revision_id), D.importLabel(d, x.import_id), x.detail || '', x.status, x.conclusion || '',
    s.mode === 'edit' && x.status === '待處理' ? btn('處理', () => guard(() => resolveUI(env, x))) : '']));
  const condition = `種類=${st.kind || '全部'}；狀態=${st.status || '全部'}`;
  const box = h('section', { class: 'panel' }, h('h2', { text: '差異待辦' }),
    h('p', { class: 'note', text: '新主檔啟用後比對已確認認定：新符合須確認後形成新快照；不自動註記、調高或刪除認定；歷史快照不變。' }),
    s.mode === 'edit' ? h('div', { class: 'toolbar' },
      btn(`依目前主檔產生差異待辦${imp ? `（${imp.base_date}）` : ''}`, () => guard(() => generate(env)), { primary: true, disabled: !imp })) : null,
    h('div', { class: 'filters' }, h('label', null, '種類 ', kindSel), h('label', null, '狀態 ', stSel),
      btn('篩選', () => { st.kind = kindSel.value; st.status = stSel.value; st.page = 0; render(); }),
      btn('匯出差異待辦', () => guard(() => exportTable(s, { kind: '差異待辦', condition, day: taipeiToday(Date.now()),
        headers: ['種類', '藥品代碼', '分組', '認定版本', '主檔版本', '說明', '狀態', '結論'],
        rows: todos.map((x) => [x.kind, x.drug_code || '', x.group_code || '', revLabelOf(d, x.revision_id), D.importLabel(d, x.import_id), x.detail || '', x.status, x.conclusion || '']) })))),
    h('p', { class: 'note', text: `共 ${todos.length} 筆${todos.length > PAGE ? `，第 ${st.page + 1} 頁（每頁 ${PAGE}）` : ''}。` }),
    todos.length > PAGE ? h('div', { class: 'pager' }, btn('上一頁', () => { st.page = Math.max(0, st.page - 1); render(); }, { disabled: st.page === 0 }),
      btn('下一頁', () => { st.page += 1; render(); }, { disabled: (st.page + 1) * PAGE >= todos.length })) : null,
    todos.length ? t : h('p', { class: 'note', text: '無符合之待辦。' }));
  return h('div', null, box, comparePanel(env, imp));
}

async function generate(env) {
  const d = data(env);
  const imp = M.activeImport(d);
  const rows = await masterRows(env.s, imp);
  const items = await D.computeDiffTodos(d, imp, rows, env.s.settings);
  const r = await env.s.run((dd, k) => D.addTodos(dd, k, imp.id, items), { opId: newId(), kind: '產生差異待辦' });
  const c = {};
  for (const it of items) c[it.kind] = (c[it.kind] || 0) + 1;
  await alertBox('差異待辦', `比對主檔 ${imp.base_date}：新增 ${r.added} 筆，已存在略過 ${r.skipped} 筆。`, Object.entries(c).map(([k, v]) => `${k} ${v}`).join('、') || '無差異');
}

async function resolveUI(env, x) {
  const v = await formDialog(`處理差異待辦：${x.kind} ${x.drug_code || ''}`, [
    { key: 'status', label: '處理結果', type: 'select', options: [['已處理', '已處理'], ['不處理', '不處理']], value: '已處理' },
    { key: 'conclusion', label: '處理結論', type: 'textarea', required: true }]);
  if (!v) return;
  await env.s.run((dd, k) => D.resolveTodo(dd, k, x.id, v.status, v.conclusion));
}

function comparePanel(env, imp) {
  const { s, btn, guard, render } = env;
  const st = env.ui.diff;
  const day = h('input', { type: 'text', size: 12, value: st.day, 'aria-label': '比對日期' });
  const box = h('section', { class: 'panel' }, h('h2', { text: '主檔註記比對' }),
    h('p', { class: 'note', text: `以目前主檔「必要藥品」註記與系統已確認註記事件比對（空白＝0 一般藥品；對照：${s.settings.annotation_code_map}）。本系統不直接更新正式主檔。` }),
    h('div', { class: 'filters' }, h('label', null, '比對日期 ', day),
      btn('執行比對', () => guard(async () => {
        st.day = day.value.trim() || taipeiToday(Date.now());
        const rows = await masterRows(s, imp);
        st.compare = { imp: imp.id, items: D.compareMaster(data(env), rows, st.day, s.settings) };
      }), { disabled: !imp })));
  if (!st.compare || !imp || st.compare.imp !== imp.id) return box;
  const items = st.compare.items;
  const cnt = D.compareCounts(items);
  const bad = items.filter((x) => x.result !== '一致');
  box.appendChild(h('p', { text: `比對 ${items.length} 項：` + E.ANNOTATION_COMPARE.map((k) => `${k} ${cnt[k] || 0}`).join('、') }));
  box.appendChild(h('div', { class: 'toolbar' },
    btn('匯出比對結果', () => guard(() => exportTable(s, { kind: '查詢結果', condition: `主檔註記比對；主檔 ${imp.base_date}`, day: st.day,
      headers: ['藥品代碼', '品名', '比對結果', '說明', '系統類別', '主檔必要藥品註記'], rows: items.map((x) => [x.drug_code, x.drug_name || '', x.result, x.detail, x.system_category || '', x.master_raw ?? '']) }))),
    s.mode === 'edit' && bad.length ? btn(`不一致 ${bad.length} 項轉為差異待辦`, () => guard(async () => {
      const r = await s.run((dd, k) => D.addTodos(dd, k, imp.id, D.mismatchTodos(items)), { opId: newId(), kind: '註記比對轉待辦' });
      await alertBox('已轉為差異待辦', `新增 ${r.added} 筆，已存在略過 ${r.skipped} 筆。`);
    })) : null));
  box.appendChild(table(['藥品代碼', '品名', '比對結果', '說明'], bad.slice(0, PAGE).map((x) => [x.drug_code, x.drug_name || '', x.result, x.detail])));
  if (bad.length > PAGE) box.appendChild(h('p', { class: 'note', text: `僅顯示前 ${PAGE} 筆不一致項目；完整結果請匯出。` }));
  return box;
}
