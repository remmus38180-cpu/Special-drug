// 品項明細（T21）：依藥品代碼回溯主檔、認定、案件與會議、範圍快照、調高、合約、註記、差異待辦；可匯出。
import { h, table } from './dom.js';
import * as Q from '../core/query.js';
import * as M from '../core/masterImport.js';
import { taipeiToday } from '../core/values.js';
import { masterRows } from './masterView.js';
import { exportTable } from './exportUI.js';

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

export function queryTab(env) {
  const { btn, guard, render } = env;
  env.ui.query = env.ui.query || { code: '', day: taipeiToday(Date.now()), master: null };
  const st = env.ui.query;
  const d = data(env);
  const code = h('input', { type: 'text', size: 14, value: st.code, 'aria-label': '藥品代碼', placeholder: '例 A000001100' });
  const day = h('input', { type: 'text', size: 12, value: st.day, 'aria-label': '查詢日期' });
  const run = () => guard(async () => {
    st.code = code.value.trim();
    st.day = day.value.trim() || taipeiToday(Date.now());
    const imp = M.activeImport(d);
    const rows = imp ? await masterRows(env.s, imp) : null;
    st.master = rows ? rows.byCode.get(st.code) || null : null;
    st.masterLabel = imp ? `${imp.base_date}（${imp.source_name}）` : null;
  });
  const box = h('section', { class: 'panel' }, h('h2', { text: '品項明細' }),
    h('div', { class: 'filters' }, h('label', null, '藥品代碼 ', code), h('label', null, '查詢日期 ', day), btn('查詢', run, { primary: true })),
    h('p', { class: 'note', text: '認定範圍、本次調高、主檔註記分開列示。有效狀態依查詢日期計算。' }));
  if (!st.code) return box;
  const dd = Q.drugDetail(d, st.code, st.day, { masterRow: st.master });
  const lines = detailRows(dd, st);
  box.appendChild(btn('匯出品項明細', () => guard(() => exportTable(env.s, { kind: '品項明細', condition: `藥品代碼=${st.code}`, day: st.day, headers: ['區塊', '日期', '項目', '內容', '狀態'], rows: lines }))));
  const m = dd.master;
  box.appendChild(h('h3', { text: `${st.code}${m ? ' ' + (m.drug_name || '') : ''}` }));
  box.appendChild(h('p', { text: m ? `目前主檔 ${st.masterLabel}：分組 ${m.group_code || '（空白）'}；ATC ${m.atc_code || ''}；廠商 ${m.firm || ''}；支付價 ${m.price || ''}；必要藥品註記 ${m.annotation ?? ''}`
    : st.masterLabel ? `目前主檔 ${st.masterLabel} 無此代碼（不視為取消）。` : '尚無已啟用主檔。' }));
  const cat = dd.category;
  box.appendChild(h('p', { class: cat.conflict ? 'warn-text' : '', text: `認定類別（${st.day}）：${cat.conflict ? '類別衝突，不產生單一類別：' + cat.sources.map((x) => `${x.name}（${x.category}）`).join('、') : cat.category || '無有效認定'}` }));
  box.appendChild(h('p', { text: `主檔註記（系統，${st.day}）：${dd.annotation.category || '無'}${dd.annotation.upcoming ? `；待生效：${dd.annotation.upcoming.action} ${dd.annotation.upcoming.category || ''} ${dd.annotation.upcoming.effective_date}` : ''}${dd.annotation.unknown_date ? '；有生效日未知之事件' : ''}` }));
  const sec = (title, headers, rows) => [h('h3', { text: `${title}（${rows.length}）` }), rows.length ? table(headers, rows) : h('p', { class: 'note', text: '無' })];
  box.append(...sec('認定', ['認定', '版本', '類別', '期間', '狀態', '涵蓋'], dd.recognitions.map((r) => [`${r.recognition_no} ${r.name}`, r.revision_no, r.category, `${r.effective_from || '起日未知'}～${r.effective_to || ''}`, r.state, r.covers ? '是' : '否'])));
  box.append(...sec('案件與會議', ['案件', '主旨', '處理狀態', '結果摘要', '逐次結果'], dd.cases.map((c) => [c.case_no, c.subject, c.status, c.summary, c.results.map((r) => `${r.meeting_date || '日期未知'} ${r.meeting_name} ${r.nature}：${r.result}${r.superseded ? '（已更正）' : ''}`).join('；')])));
  box.append(...sec('範圍快照', ['認定', '版本', '主檔基準日', '判定', '人工確認', '快照狀態', '分組'], dd.snapshots.map((x) => [x.recognition, x.revision_no, x.base_date, x.eval_result, x.manual_result || '', x.status, x.group_code || ''])));
  box.append(...sec('調高', ['認定', '調高前→後', '生效日', '公告文號', '簽約要求', '確認', '完整性'], dd.prices.map((p) => [`${p.recognition} 第${p.revision_no}版`, `${p.price_before || '—'} → ${p.price_after || '—'}`, p.effective_date || '', p.announce_doc_no || '', p.contract_requirement, p.superseded ? `${p.confirm_status}（已更正取代）` : p.confirm_status, p.completeness])));
  box.append(...sec('合約', ['合約編號', '廠商', '狀態', '簽訂日', '到期日', '品項適用期間'], dd.contracts.map((c) => [c.contract_no, c.firm || '', c.status, c.signed_date || '', c.expiry_date || '（無）', `${c.item.effective_from || ''}～${c.item.effective_to || ''}`])));
  box.append(...sec('註記事件', ['動作', '類別', '生效日', '依據', '確認'], dd.annotations.map((a) => [a.action, a.category || '', a.effective_date || '（未知）', a.basis || '', a.confirm_status])));
  box.append(...sec('差異待辦', ['種類', '說明', '狀態', '結論'], dd.todos.map((t) => [t.kind, t.detail || '', t.status, t.conclusion || ''])));
  return box;
}

function detailRows(dd, st) {
  const out = [];
  const m = dd.master;
  out.push(['主檔', st.masterLabel || '', '主檔列', m ? `${m.drug_name || ''}｜分組 ${m.group_code || ''}｜ATC ${m.atc_code || ''}｜支付價 ${m.price || ''}｜註記 ${m.annotation ?? ''}` : '目前主檔無此代碼', '']);
  out.push(['認定類別', st.day, '查詢日類別', dd.category.conflict ? '類別衝突' : dd.category.category || '無有效認定', '']);
  for (const r of dd.recognitions) out.push(['認定', r.effective_from ? { date: r.effective_from } : '', `${r.recognition_no} ${r.name} 第${r.revision_no}版`, r.category, r.state]);
  for (const c of dd.cases) for (const x of c.results) out.push(['會議', x.meeting_date ? { date: x.meeting_date } : '', `${c.case_no} ${x.meeting_name}`, `${x.nature}：${x.result}${x.conditions ? '（' + x.conditions + '）' : ''}`, x.superseded ? '已更正' : '']);
  for (const p of dd.prices) out.push(['調高', p.effective_date ? { date: p.effective_date } : '', `${p.recognition} 第${p.revision_no}版`, `${p.price_before || ''} → ${p.price_after || ''}；${p.contract_requirement}`, p.superseded ? '已更正取代' : p.confirm_status]);
  for (const c of dd.contracts) out.push(['合約', c.signed_date ? { date: c.signed_date } : '', c.contract_no, `${c.firm || ''} 到期 ${c.expiry_date || '無'}`, c.status]);
  for (const a of dd.annotations) out.push(['註記', a.effective_date ? { date: a.effective_date } : '', a.action, a.category || '', a.confirm_status]);
  for (const t of dd.todos) out.push(['差異待辦', '', t.kind, t.detail || '', t.status]);
  return out;
}
