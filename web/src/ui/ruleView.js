// 規則編輯（條件點選，第8.1節）與範圍預覽。選項由已啟用主檔產生；同時顯示代碼與中文說明。首次不需看到JSON。
import { h, table, clear } from './dom.js';
import * as R from '../core/rules.js';
import * as M from '../core/masterImport.js';
import { masterRows } from './masterView.js';
import { deepClone } from '../core/util.js';

const PAGE = 100;
const OPTION_CACHE = new WeakMap();

export const TEMPLATES = [
  ['group', '依分組', () => ({ field: 'group_code', op: 'in', values: [] })],
  ['atc_dose', '依ATC加劑型', () => ({ op: 'and', children: [{ field: 'atc_code', op: 'in', values: [] }, { field: 'dose_code', op: 'in', values: [] }] })],
  ['group_spec', '依分組加規格', () => ({ op: 'and', children: [{ field: 'group_code', op: 'in', values: [] }, { field: 'spec', op: 'eq', value: '', unit: '' }] })],
  ['drugs', '指定品項', () => ({ field: 'drug_code', op: 'in', values: [] })],
  ['advanced', '進階條件', () => ({ op: 'and', children: [] })],
];

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

function newLeaf(field = 'group_code') {
  return field === 'spec' ? { field: 'spec', op: 'eq', value: '', unit: '' } : { field, op: 'in', values: [] };
}

// 依目前運算子調整值欄位結構
function setOp(node, op) {
  const f = R.FIELDS[node.field];
  node.op = op;
  if (f.type === 'quantity') return;
  const vals = node.values || (node.value ? [node.value] : []);
  delete node.value; delete node.values;
  if (op === 'in' || op === 'not_in') node.values = vals;
  else node.value = vals[0] || '';
}

function setField(node, field) {
  for (const k of Object.keys(node)) delete node[k];
  Object.assign(node, newLeaf(field));
}

// holder：{rule}；opts：{rows, imp, onChange}
export function ruleEditor(env, holder, opts) {
  const box = h('div', { class: 'rule-editor' });
  const changed = () => { if (opts.onChange) opts.onChange(holder.rule); env.render(); };
  const options = (col) => {
    if (!opts.rows) return [];
    let m = OPTION_CACHE.get(opts.rows);
    if (!m) { m = new Map(); OPTION_CACHE.set(opts.rows, m); }
    if (!m.has(col)) m.set(col, M.masterOptions(opts.rows, col));
    return m.get(col);
  };
  const disabled = new Set((opts.imp && opts.imp.check && opts.imp.check.disabled_rule_fields) || []);

  function picker(node) {
    const f = R.FIELDS[node.field];
    const multi = node.op === 'in' || node.op === 'not_in';
    const prefix = node.op === 'starts_with' || node.op === 'not_starts_with';
    const wrap = h('div', { class: 'picker' });
    if (prefix) {
      const inp = h('input', { type: 'text', size: 12, value: node.value || '', 'aria-label': `${f.label}前綴` });
      inp.addEventListener('change', () => { node.value = inp.value.trim(); changed(); });
      wrap.appendChild(inp);
      const n = node.value ? options(f.col).filter((o) => o.value.startsWith(node.value)).length : 0;
      if (node.value) wrap.appendChild(h('span', { class: 'note', text: ` 主檔中 ${n} 個${f.label}符合此前綴` }));
      return wrap;
    }
    const chosen = multi ? node.values : (node.value ? [node.value] : []);
    const opts2 = options(f.col);
    const byVal = new Map(opts2.map((o) => [o.value, o]));
    wrap.appendChild(h('div', { class: 'chips' }, chosen.map((v) => {
      const o = byVal.get(v);
      return h('span', { class: 'chip' + (o ? '' : ' chip-warn'), title: o ? '' : '主檔無此值' },
        `${v}${o && o.label ? ' ' + o.label : ''}${o ? `（${o.count}筆）` : '（主檔無此值）'} `,
        h('button', { type: 'button', class: 'chip-x', 'aria-label': `移除 ${v}`, text: '×', on: { click: () => {
          if (multi) node.values = node.values.filter((x) => x !== v); else node.value = '';
          changed();
        } } }));
    })));
    const q = h('input', { type: 'text', size: 18, placeholder: `搜尋${f.label}或名稱`, 'aria-label': `搜尋${f.label}` });
    const list = h('div', { class: 'pick-list' });
    const showList = () => {
      clear(list);
      const s = q.value.trim().toUpperCase();
      if (!s) return;
      const hit = opts2.filter((o) => o.value.toUpperCase().includes(s) || (o.label && o.label.toUpperCase().includes(s))).slice(0, 50);
      if (!hit.length) list.appendChild(h('div', { class: 'note', text: '主檔中無符合之值' }));
      for (const o of hit) {
        list.appendChild(h('button', { type: 'button', class: 'pick-item', text: `${o.value}　${o.label || ''}（${o.count}筆）`, on: { click: () => {
          if (multi) { if (!node.values.includes(o.value)) node.values.push(o.value); } else node.value = o.value;
          changed();
        } } }));
      }
    };
    q.addEventListener('input', showList);
    wrap.appendChild(h('div', null, q));
    wrap.appendChild(list);
    if (multi) {
      const ta = h('textarea', { rows: 2, cols: 30, placeholder: '貼上多個值（換行、逗號或空白分隔）', 'aria-label': `貼上${f.label}` });
      wrap.appendChild(h('div', null, ta, ' ', env.btn('加入', () => {
        const vals = ta.value.split(/[\s,，、]+/).map((x) => x.trim()).filter(Boolean);
        for (const v of vals) if (!node.values.includes(v)) node.values.push(v);
        changed();
      })));
    }
    return wrap;
  }

  function leaf(node, onDelete) {
    const f = R.FIELDS[node.field];
    const fieldSel = h('select', { 'aria-label': '欄位' }, Object.entries(R.FIELDS).map(([k, x]) => h('option', { value: k, text: x.label + (disabled.has(k) ? '（此主檔未映射）' : ''), selected: k === node.field })));
    fieldSel.addEventListener('change', () => { setField(node, fieldSel.value); changed(); });
    const ops = f.type === 'quantity' ? R.QTY_OPS : R.TEXT_OPS;
    const opSel = h('select', { 'aria-label': '運算子' }, Object.entries(ops).map(([k, x]) => h('option', { value: k, text: x, selected: k === node.op })));
    opSel.addEventListener('change', () => { setOp(node, opSel.value); changed(); });
    let valueEl;
    if (f.type === 'quantity') {
      const qty = h('input', { type: 'text', size: 8, value: node.value || '', 'aria-label': '規格數值' });
      qty.addEventListener('change', () => { node.value = qty.value.trim(); changed(); });
      const units = (opts.imp && opts.imp.check && opts.imp.check.known_units) || M.KNOWN_UNITS;
      const used = options('spec_unit');
      const unitSel = h('select', { 'aria-label': '規格單位' }, h('option', { value: '', text: '（選單位）' }),
        used.map((o) => h('option', { value: o.value, text: `${o.value}（${o.count}筆）${units.includes(o.value) ? '' : '【未知單位】'}`, selected: o.value === node.unit })));
      unitSel.addEventListener('change', () => { node.unit = unitSel.value; changed(); });
      valueEl = h('span', null, qty, ' ', unitSel, h('span', { class: 'note', text: ' 只比較同單位；未經確認不換算' }));
    } else {
      valueEl = picker(node);
    }
    return h('div', { class: 'rule-leaf' + (disabled.has(node.field) ? ' rule-bad' : '') }, fieldSel, ' ', opSel, ' ', valueEl, ' ',
      onDelete ? env.btn('刪除', onDelete) : null);
  }

  function group(node, onDelete, depth) {
    if (node.op === 'manual') {
      const ta = h('textarea', { rows: 2, cols: 50, 'aria-label': '人工條件原文' });
      ta.value = node.text;
      ta.addEventListener('change', () => { node.text = ta.value; changed(); });
      return h('div', { class: 'rule-group rule-manual' }, h('strong', { text: '人工條件（不自動判定，相關品項一律待確認）' }), h('div', null, ta), onDelete ? env.btn('刪除', onDelete) : null);
    }
    if (node.op === 'same_applicant') {
      return h('div', { class: 'rule-group' }, h('strong', { text: '同申請商（統編，取自藥品許可證檔）另有其他品項符合下列條件：' }), ' ', onDelete ? env.btn('刪除此條件', onDelete) : null,
        render(node.child, null, depth + 1));
    }
    if (node.op === 'not') {
      return h('div', { class: 'rule-group rule-not' }, h('strong', { text: '排除下列條件：' }), ' ', onDelete ? env.btn('刪除排除', onDelete) : null,
        render(node.child, null, depth + 1));
    }
    const logic = h('select', { 'aria-label': '組合方式' }, [['and', '全部符合（AND）'], ['or', '任一符合（OR）']].map(([k, x]) => h('option', { value: k, text: x, selected: k === node.op })));
    logic.addEventListener('change', () => { node.op = logic.value; changed(); });
    return h('div', { class: 'rule-group' }, h('div', { class: 'toolbar' }, logic,
      env.btn('＋條件', () => { node.children.push(newLeaf()); changed(); }),
      env.btn('＋群組', () => { node.children.push({ op: 'or', children: [newLeaf()] }); changed(); }),
      env.btn('＋排除', () => { node.children.push({ op: 'not', child: newLeaf() }); changed(); }),
      env.btn('＋同申請商另有', () => { node.children.push({ op: 'same_applicant', child: newLeaf() }); changed(); }),
      onDelete ? env.btn('刪除群組', onDelete) : null),
    node.children.length ? null : h('p', { class: 'warn-text', text: '群組內尚無條件（空規則不得當作全選）' }),
    node.children.map((c, i) => render(c, () => { node.children.splice(i, 1); changed(); }, depth + 1)));
  }

  function render(node, onDelete, depth = 0) {
    if (node.op === 'and' || node.op === 'or' || node.op === 'not' || node.op === 'manual' || node.op === 'same_applicant') return group(node, onDelete, depth);
    return leaf(node, onDelete);
  }

  function draw() {
    const tpl = h('div', { class: 'toolbar' }, h('span', { text: '常用範本：' }), TEMPLATES.map(([k, label, make]) => env.btn(label, () => { holder.rule = make(); changed(); })));
    box.appendChild(tpl);
    if (!holder.rule) { box.appendChild(h('p', { class: 'note', text: '請先選一個範本，再點選條件值。' })); return; }
    const isGroup = ['and', 'or'].includes(holder.rule.op);
    box.appendChild(render(holder.rule, null));
    if (!isGroup && !['not', 'manual', 'same_applicant'].includes(holder.rule.op)) {
      box.appendChild(h('div', { class: 'toolbar' }, env.btn('包成群組（加入其他條件）', () => { holder.rule = { op: 'and', children: [holder.rule] }; changed(); })));
    }
    let valid = null;
    try { R.validateRule(holder.rule); } catch (e) { valid = e.message; }
    box.appendChild(h('div', { class: 'rule-desc' }, h('strong', { text: '條件說明：' }), h('pre', { text: R.describe(holder.rule) }),
      valid ? h('p', { class: 'warn-text', text: '條件尚未完整：' + valid }) : h('p', { class: 'note', text: '條件格式正確。' })));
    const json = h('details', null, h('summary', { text: '進階：檢視條件結構（JSON）' }), h('pre', { text: JSON.stringify(holder.rule, null, 2) }));
    box.appendChild(json);
  }
  draw();
  return box;
}

// 預覽結果
export function previewPanel(env, pv, st) {
  st.filter = st.filter || '';
  st.page = st.page || 0;
  const rows = pv.members.filter((m) => !st.filter || m.result === st.filter);
  const pageRows = rows.slice(st.page * PAGE, (st.page + 1) * PAGE);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const fsel = h('select', { 'aria-label': '判定篩選' }, [['', '全部'], ['符合', '符合'], ['待確認', '待確認']].map(([k, x]) => h('option', { value: k, text: x, selected: k === st.filter })));
  fsel.addEventListener('change', () => { st.filter = fsel.value; st.page = 0; env.render(); });
  return h('section', { class: 'panel' }, h('h2', { text: '範圍預覽（認定範圍名單；不等於本次調高名單、不等於主檔註記名單）' }),
    table(['項目', '結果'], [['主檔版本', `${pv.base_date}（${pv.import_id.slice(0, 8)}）`], ['符合', String(pv.match)], ['待確認', String(pv.pending)], ['規則雜湊', pv.rule_hash.slice(0, 16)]]),
    pv.warnings.length ? h('ul', { class: 'warn-list' }, pv.warnings.map((w) => h('li', { class: 'warn-text', text: w }))) : null,
    pv.groups.length ? h('div', null, h('h3', { text: `涉及分組（${pv.groups.length}）` }),
      table(['分組代碼', '符合', '待確認', '分組總數', '涵蓋'], pv.groups.slice(0, 300).map((g) => [g.group_code, String(g.matched), String(g.pending), String(g.total), g.partial ? '部分涵蓋' : '全組']))) : null,
    h('h3', { text: '品項名單' }),
    h('div', { class: 'filters' }, h('label', null, '判定 ', fsel), h('span', { text: `共 ${rows.length} 筆` }),
      env.btn('上一頁', () => { st.page -= 1; env.render(); }, { disabled: st.page === 0 }), h('span', { text: `第 ${st.page + 1}／${pages} 頁` }),
      env.btn('下一頁', () => { st.page += 1; env.render(); }, { disabled: st.page >= pages - 1 })),
    table(['藥品代碼', '品名', '藥商', '分組', '規格', '判定', '判定路徑', '主檔必要藥品註記'],
      pageRows.map((m) => [m.drug_code, m.drug_name || '', m.firm || '', m.group_code || '', m.spec, m.result, m.path, m.annotation ?? ''])));
}

// 獨立之「規則預覽」頁（階段6起併入認定版本）
export function ruleTab(env) {
  const { ui, s, btn, guard, render } = env;
  ui.rule = ui.rule || { holder: { rule: null }, preview: null, pv: {} };
  const st = ui.rule;
  const d = data(env);
  const imp = M.activeImport(d);
  if (!imp) return h('section', { class: 'panel' }, h('h2', { text: '規則編輯與預覽' }), h('p', { text: '尚未有已啟用之主檔；請先至「主檔」頁匯入並啟用。' }));
  const parts = [];
  const head = h('section', { class: 'panel' }, h('h2', { text: '規則編輯與預覽' }),
    h('p', { class: 'note', text: `選項來自目前主檔：${imp.source_name}（基準日 ${imp.base_date}）。條件以結構化方式保存，不執行使用者輸入。預覽後規則或主檔改變須重新預覽。` }));
  parts.push(head);
  if (!st.rows || st.rowsFor !== imp.id) {
    head.appendChild(btn('載入主檔選項', () => guard(async () => { st.rows = await masterRows(s, imp); st.rowsFor = imp.id; })));
    return parts;
  }
  head.appendChild(ruleEditor(env, st.holder, { rows: st.rows, imp, onChange: () => { st.preview = null; } }));
  head.appendChild(h('div', { class: 'toolbar' }, btn('預覽符合名單', () => guard(async () => {
    const t0 = Date.now();
    st.preview = await R.previewRule(deepClone(st.holder.rule), st.rows, imp, { threshold: s.settings.large_scope_threshold });
    st.preview.ms = Date.now() - t0;
    st.pv = {};
  }), { primary: true, disabled: !st.holder.rule })));
  if (st.preview) {
    parts.push(previewPanel(env, st.preview, st.pv));
    head.appendChild(h('p', { class: 'note', text: `預覽耗時 ${st.preview.ms} ms。` }));
  }
  void render;
  return parts;
}
