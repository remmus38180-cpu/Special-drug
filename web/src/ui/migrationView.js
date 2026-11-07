// Excel 移轉預覽（第12節）：選活頁簿→解析預覽→暫存（來源檔存為附件）→逐列核對、寫入或略過；合併候選只列不合併；匯出移轉核對清單。
import { h, table, dialog, alertBox } from './dom.js';
import { formDialog } from './forms.js';
import * as MG from '../core/migration.js';
import * as R from '../core/rules.js';
import { openTable } from '../core/table.js';
import { find, list } from '../core/model.js';
import { newId } from '../core/util.js';
import { taipeiToday } from '../core/values.js';
import { exportTable } from './exportUI.js';

const PAGE = 50;

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

function shortRule(ast) {
  if (!ast) return '（無）';
  const t = R.describe(ast).replace(/\s+/g, ' ');
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

export function migrationTab(env) {
  const { s, btn, guard, render } = env;
  env.ui.mig = env.ui.mig || { staged: null, batch: null, status: '待核對', page: 0, picked: new Set(), onlyIssues: false };
  const st = env.ui.mig;
  const d = data(env);
  const fileIn = h('input', { type: 'file', accept: '.xlsx', 'aria-label': '移轉活頁簿', on: { change: (e) => { const f = e.target.files[0]; if (f) guard(async () => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    st.staged = await MG.readWorkbook(openTable(f.name, bytes), { name: f.name, bytes, sheet: 'final' });
  }); } } });
  const box = h('section', { class: 'panel' }, h('h2', { text: 'Excel移轉預覽' }),
    h('p', { class: 'note', text: '移轉不直接成為現行有效資料：寫入時建立歷史案件、會議議案（結果待確認）及認定草稿版本；缺生效日、決議或合約者標記不完整。同來源同列重複匯入不重複建案；相似列只列合併候選。' }),
    s.mode === 'edit' ? h('label', null, '活頁簿（工作表 final） ', fileIn) : h('p', { class: 'note', text: '查詢模式僅可檢視暫存資料；匯入須先取得編輯牌。' }));
  if (st.staged) box.appendChild(previewStaged(env, st.staged));
  const batches = list(d, 'migration_batch');
  if (batches.length) {
    box.appendChild(h('h3', { text: '暫存批次' }));
    box.appendChild(table(['來源檔', 'SHA-256前12碼', '工作表', '列數', '待核對', '已寫入', '略過', ''], batches.map((b) => {
      const sm = MG.batchSummary(d, b.id);
      return [b.source_name, b.sha256.slice(0, 12), b.sheet, String(sm.total), String(sm['待核對']), String(sm['已寫入']), String(sm['略過']), btn(st.batch === b.id ? '核對中' : '核對', () => { st.batch = b.id; st.page = 0; st.picked = new Set(); render(); }, { primary: st.batch === b.id })];
    })));
  }
  const b = st.batch ? find(d, 'migration_batch', st.batch) : null;
  return h('div', null, box, b ? rowsPanel(env, b) : null);
}

function previewStaged(env, staged) {
  const { s, btn, guard } = env;
  const st = env.ui.mig;
  const cats = {};
  let withIssues = 0;
  for (const r of staged.rows) { cats[r.parsed.category_std] = (cats[r.parsed.category_std] || 0) + 1; if (r.issues.length) withIssues++; }
  const already = list(data(env), 'migration_row').filter((r) => r.source_sha256 === staged.sha256 && r.sheet === staged.sheet).length;
  return h('div', { class: 'panel current' }, h('h3', { text: `解析預覽：${staged.source_name}` }),
    h('p', { text: `資料列 ${staged.rows.length}；類別（B16 對照後）：${Object.entries(cats).map(([k, v]) => `${k} ${v}`).join('、')}；有待確認問題 ${withIssues} 列。` }),
    already ? h('p', { class: 'warn-text', text: `此來源（同 SHA-256、同工作表）已暫存 ${already} 列；再次暫存只加入新列，不重複建案。` }) : null,
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('暫存（來源檔存為附件）', () => guard(async () => {
      const r = await MG.stageToSession(s, staged, { opId: newId() });
      st.batch = r.batch_id; st.staged = null; st.page = 0;
      await alertBox('已暫存', `新增 ${r.new} 列，已暫存略過 ${r.already_staged} 列（共 ${r.total} 列）。請逐列核對後寫入；記得儲存。`);
    }), { primary: true }), btn('取消', () => { st.staged = null; env.render(); })) : null);
}

function rowsPanel(env, b) {
  const { s, btn, guard, render } = env;
  const st = env.ui.mig;
  const d = data(env);
  const stSel = h('select', { 'aria-label': '移轉列狀態' }, ['', '待核對', '已寫入', '略過'].map((v) => h('option', { value: v, text: v || '（全部）', selected: v === st.status })));
  const onlyIss = h('input', { type: 'checkbox', checked: st.onlyIssues, 'aria-label': '只看有待確認問題' });
  let rows = MG.listRows(d, { sha: b.sha256, status: st.status || null }).filter((r) => r.batch_id === b.id || r.source_sha256 === b.sha256);
  if (st.onlyIssues) rows = rows.filter((r) => r.issues && r.issues.length);
  const page = rows.slice(st.page * PAGE, (st.page + 1) * PAGE);
  const t = table(['選', '列', '公告序號', '公告名稱／分組', '類別（原文→對照）', '規則草稿', '待確認問題', '狀態', ''], []);
  for (const r of page) {
    const p = r.parsed;
    const cb = r.status === '待核對' && s.mode === 'edit' ? h('input', { type: 'checkbox', checked: st.picked.has(r.id), 'aria-label': `選第${r.row_no}列`, on: { change: (e) => { if (e.target.checked) st.picked.add(r.id); else st.picked.delete(r.id); } } }) : '';
    const iss = r.issues && r.issues.length ? h('details', null, h('summary', { text: `${r.issues.length} 項` }), h('ul', null, r.issues.map((x) => h('li', { text: x })))) : '';
    const ops = s.mode === 'edit' && r.status === '待核對' ? h('span', null,
      btn('寫入', () => guard(() => s.run((dd, k) => MG.commitRow(dd, k, r.id), { opId: newId(), kind: '移轉寫入' }))),
      btn('略過', () => guard(async () => { const v = await formDialog(`略過第${r.row_no}列`, [{ key: 'reason', label: '理由', required: true }]); if (v) await s.run((dd, k) => MG.skipRow(dd, k, r.id, v.reason)); }))) : '';
    t.querySelector('tbody').appendChild(h('tr', null, [cb, String(r.row_no), p.seq || '', `${p.ann_name || ''}｜${p.group_code || ''}`,
      `${(p.category || '（空白）').replace(/\n/g, ' ')} → ${p.category_std}${p.not_recognized ? '（非認列）' : ''}`, shortRule(p.rule_ast), iss, r.status, ops]
      .map((x) => (x instanceof Node ? h('td', null, x) : h('td', { text: x })))));
  }
  const cands = MG.mergeCandidates(d, b.sha256);
  return h('section', { class: 'panel' }, h('h3', { text: `核對：${b.source_name}（${rows.length} 列）` }),
    h('div', { class: 'filters' }, h('label', null, '狀態 ', stSel), h('label', null, onlyIss, ' 只看有待確認問題'),
      btn('篩選', () => { st.status = stSel.value; st.onlyIssues = onlyIss.checked; st.page = 0; render(); }),
      btn('匯出移轉核對清單', () => guard(() => exportTable(s, { kind: '移轉核對', condition: `來源 ${b.source_name}；狀態=${st.status || '全部'}`, day: taipeiToday(Date.now()),
        headers: ['列號', '公告序號', '公告名稱', '分組代碼', '類別原文', '類別對照', '篩選原則原文', '規則草稿', '生效日', '待確認問題', '狀態'],
        rows: rows.map((r) => [{ n: String(r.row_no) }, r.parsed.seq || '', r.parsed.ann_name || '', r.parsed.group_code || '', r.parsed.category || '', r.parsed.category_std, r.parsed.rule || '', r.parsed.rule_ast ? R.describe(r.parsed.rule_ast).replace(/\s+/g, ' ') : '', r.parsed.eff_date_iso || '', (r.issues || []).join('；'), r.status]) })))),
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('寫入勾選列', () => guard(() => commitPicked(env)), { primary: true }),
      h('span', { class: 'note', text: '勾選僅作用於本頁明確勾選之列。' })) : null,
    rows.length > PAGE ? h('div', { class: 'pager' }, btn('上一頁', () => { st.page = Math.max(0, st.page - 1); render(); }, { disabled: st.page === 0 }),
      h('span', { text: `第 ${st.page + 1}／${Math.ceil(rows.length / PAGE)} 頁` }),
      btn('下一頁', () => { st.page += 1; render(); }, { disabled: (st.page + 1) * PAGE >= rows.length })) : null,
    t,
    h('h3', { text: `合併候選（${cands.length}）` }),
    h('p', { class: 'note', text: '同公告序號、公告名稱或分組代碼之列只列出供核對，系統不自行合併；認定範圍是否相同由使用者判斷。' }),
    cands.length ? table(['依據', '值', '列號'], cands.map((c) => [c.key, c.value.replace(/\n/g, ' '), c.rows.join('、')])) : h('p', { class: 'note', text: '無' }));
}

async function commitPicked(env) {
  const st = env.ui.mig;
  const ids = [...st.picked];
  if (!ids.length) { await alertBox('未勾選', '請先勾選要寫入的列。'); return; }
  const ok = await dialog('寫入移轉列', [h('p', { text: `將寫入 ${ids.length} 列：建立歷史案件、會議議案（結果待確認）及認定草稿版本；不產生有效認定、調高或註記。` })],
    [{ label: '取消', value: false }, { label: '寫入', value: true, primary: true }]);
  if (!ok) return;
  await env.s.run((d, k) => ids.map((id) => MG.commitRow(d, k, id)), { opId: newId(), kind: '移轉寫入（批次）' });
  st.picked = new Set();
}
