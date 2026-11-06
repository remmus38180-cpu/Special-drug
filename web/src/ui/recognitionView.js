// 認定清單、認定詳情（版本、適用條件、快照與人工確認、確認、分組調價方式、歷程）（第9.2、10節）。
import { h, table, dialog } from './dom.js';
import { formDialog, opts } from './forms.js';
import * as RC from '../core/recognition.js';
import * as R from '../core/rules.js';
import * as M from '../core/masterImport.js';
import { E, find, list } from '../core/model.js';
import { taipeiToday } from '../core/values.js';
import { newId, deepClone } from '../core/util.js';
import { ruleEditor, previewPanel } from './ruleView.js';
import { masterRows } from './masterView.js';

const PAGE = 100;

function data(env) {
  return env.s.mode === 'edit' ? env.s.work : env.s.committed.data;
}

function today() {
  return taipeiToday(Date.now());
}

function period(a, b) {
  return `${a || '（起日未知）'} ～ ${b || ''}`;
}

export function recognitionTab(env) {
  env.ui.recog = env.ui.recog || { keyword: null, day: today(), selected: null, rev: null };
  return env.ui.recog.selected ? detail(env) : listView(env);
}

function listView(env) {
  const { s, ui, btn, guard, render } = env;
  const st = ui.recog;
  const d = data(env);
  const kw = h('input', { type: 'text', size: 18, value: st.keyword || '', placeholder: '名稱、編號、藥品代碼、分組', 'aria-label': '認定關鍵字' });
  const day = h('input', { type: 'text', size: 12, value: st.day, 'aria-label': '查詢日期' });
  const rows = RC.listRecognitions(d, { keyword: st.keyword, day: st.day });
  const t = table(['編號', '名稱', '類別', `狀態（${st.day}）`, '涵蓋品項數', '草稿／待確認版本', '最後更新'], []);
  for (const r of rows) {
    t.querySelector('tbody').appendChild(h('tr', { class: 'clickable', tabindex: '0', on: { click: () => { st.selected = r.id; st.rev = null; render(); } } },
      [r.recognition_no, r.name, r.category || '', r.state, String(r.drug_count), String(r.pending_revisions), r.last_updated].map((x) => h('td', { text: x }))));
  }
  return h('section', { class: 'panel' }, h('h2', { text: '認定清單' }),
    h('div', { class: 'filters' }, h('label', null, '關鍵字 ', kw), h('label', null, '查詢日期 ', day),
      btn('查詢', () => { st.keyword = kw.value.trim() || null; st.day = day.value.trim() || today(); render(); })),
    s.mode === 'edit' ? h('div', { class: 'toolbar' }, btn('新增認定項目', () => guard(() => newRecognition(env)), { primary: true })) : null,
    h('p', { class: 'note', text: `共 ${rows.length} 項。有效狀態依查詢日期計算；未到生效日之已確認版本顯示待生效。` }), t);
}

async function newRecognition(env) {
  const v = await formDialog('新增認定項目', [
    { key: 'name', label: '認定名稱', required: true }, { key: 'unit', label: '管理單位', type: 'select', options: [['', '（未填）'], ['核價', '核價'], ['調價', '調價']] },
    { key: 'description', label: '說明', type: 'textarea' },
    { type: 'note', label: '建立前請先搜尋既有認定項目；同一認定之變更請建立新版本，避免重複認定。' }]);
  if (!v) return;
  const r = await env.s.run((d, k) => RC.createRecognition(d, k, { ...v, unit: v.unit || null }));
  env.ui.recog.selected = r.id;
}

function revisionFields(rev = {}, d, caseOptions) {
  return [
    { key: 'category', label: '認定類別', type: 'select', options: opts(E.REV_CATEGORY), value: rev.category || '特殊藥品', required: true },
    { key: 'scope_text', label: '適用範圍原文', type: 'textarea', value: rev.scope_text },
    { key: 'conditions_text', label: '附帶條件', type: 'textarea', value: rev.conditions_text },
    { key: 'effective_from', label: '生效日（起日含）', type: 'date', value: rev.effective_from, hint: '未知請留空，不以會議日補填' },
    { key: 'effective_to', label: '迄日（不含）', type: 'date', value: rev.effective_to, hint: '空白代表無已知終止日，不代表永久有效' },
    { key: 'case_id', label: '相關案件', type: 'select', options: [['', '（無）'], ...caseOptions], value: rev.case_id || '' },
  ];
}

function caseOptions(d) {
  return list(d, 'case_record').map((c) => [c.id, `${c.case_no} ${c.subject}`]);
}

function decisionOptions(d) {
  return list(d, 'decision').map((x) => {
    const a = find(d, 'meeting_agenda', x.agenda_id) || {};
    const m = find(d, 'meeting', a.meeting_id) || {};
    const c = find(d, 'case_record', a.case_id) || {};
    return [x.id, `${c.case_no || ''}｜${m.meeting_date || '日期未知'} ${m.name || ''}｜${x.nature}：${x.result}`];
  });
}

async function newRevision(env, rec, base) {
  const d = data(env);
  const fields = revisionFields(base ? { ...base, effective_from: null, effective_to: null } : {}, d, caseOptions(d));
  fields.push({ key: 'decision_ids', label: '依據決議', type: 'checks', options: decisionOptions(d), value: [] });
  if (base) fields.unshift({ key: 'correction_reason', label: '更正原因', required: true });
  const v = await formDialog(base ? `更正版本（取代第${base.revision_no}版，原版本保留）` : '新增認定版本', fields, {
    intro: base ? '適用條件沿用原版本，可於建立後修改；確認前須重新建立並確認快照。' : '建立後再設定適用條件（規則）並預覽建立快照。',
  });
  if (!v) return;
  const rev = await env.s.run((dd, k) => RC.createRevision(dd, k, rec.id, {
    ...v, case_id: v.case_id || null, rule: base ? deepClone(base.rule) : null, original_category: base ? base.original_category : null,
    supersedes_id: base ? base.id : null,
  }));
  env.ui.recog.rev = rev.id;
}

async function cancelRevision(env, rec) {
  const d = data(env);
  const v = await formDialog('建立取消認定版本', [
    { key: 'effective_from', label: '取消生效日', type: 'date', hint: '未知請留空並標示不完整' },
    { key: 'decision_ids', label: '依據決議', type: 'checks', options: decisionOptions(d), value: [] },
    { key: 'scope_text', label: '取消依據原文', type: 'textarea' },
    { type: 'note', label: '取消認定須另有依據（B15、Q07）；不自動取消品項註記或調價路徑，相關事件另行登錄。' }]);
  if (!v) return;
  const rev = await env.s.run((dd, k) => RC.createRevision(dd, k, rec.id, { ...v, category: '取消認定' }));
  env.ui.recog.rev = rev.id;
}

function detail(env) {
  const { s, ui, btn, guard, render } = env;
  const st = ui.recog;
  const d = data(env);
  const rec = find(d, 'recognition', st.selected);
  if (!rec) { st.selected = null; return listView(env); }
  const editing = s.mode === 'edit';
  const hist = RC.revisionHistory(d, rec.id, st.day);
  const status = RC.statusOn(d, rec.id, st.day);
  const parts = [];
  parts.push(h('section', { class: 'panel' },
    h('div', { class: 'toolbar' }, btn('← 回認定清單', () => { st.selected = null; render(); })),
    h('h2', { text: `${rec.recognition_no}｜${rec.name}` }),
    h('p', { text: `${st.day} 狀態：${status.state}${status.revision ? `（第${status.revision.revision_no}版，${status.revision.category}）` : ''}` }),
    rec.description ? h('p', { class: 'note', text: rec.description }) : null,
    h('h3', { text: '版本與歷程' }),
    table(['版', '類別', '期間（起含迄不含）', `狀態（${st.day}）`, '完整性', '範圍品項', '快照', ''], hist.map((r) => {
      const snaps = list(d, 'scope_snapshot').filter((x) => x.revision_id === r.id);
      return [String(r.revision_no) + (r.supersedes_id ? '（更正）' : ''), r.category, period(r.effective_from, r.period_end), r.state, r.completeness,
        String(r.rule ? RC.revisionScope(d, r.id).size : 0), `${snaps.filter((x) => x.status === '已確認').length}/${snaps.length}`,
        btn(st.rev === r.id ? '已開啟' : '開啟', () => { st.rev = r.id; st.preview = null; render(); }, { disabled: st.rev === r.id })];
    })),
    editing ? h('div', { class: 'toolbar' },
      btn('新增版本', () => guard(() => newRevision(env, rec)), { primary: !hist.length }),
      btn('建立取消認定版本', () => guard(() => cancelRevision(env, rec)), { disabled: !hist.some((x) => x.confirm_status === '已確認') })) : null));
  const rev = st.rev ? find(d, 'recognition_revision', st.rev) : null;
  if (rev) parts.push(...revisionPanel(env, rec, rev));
  return parts;
}

function revisionPanel(env, rec, rev) {
  const { s, ui, btn, guard } = env;
  const st = ui.recog;
  const d = data(env);
  const editing = s.mode === 'edit';
  const draft = rev.confirm_status === '草稿' || rev.confirm_status === '待確認';
  const decs = list(d, 'revision_decision').filter((x) => x.revision_id === rev.id).map((x) => find(d, 'decision', x.decision_id)).filter(Boolean);
  const decLabel = new Map(decisionOptions(d));
  const caseRec = rev.case_id ? find(d, 'case_record', rev.case_id) : null;
  const out = [];
  const box = h('section', { class: 'panel' }, h('h2', { text: `第 ${rev.revision_no} 版（${rev.confirm_status}）` }),
    table(['項目', '內容'], [
      ['類別', rev.category + (rev.original_category ? `（原始：${rev.original_category}）` : '')],
      ['期間', period(rev.effective_from, rev.effective_to)], ['完整性', rev.completeness],
      ['適用範圍原文', rev.scope_text || ''], ['附帶條件', rev.conditions_text || ''],
      ['相關案件', caseRec ? `${caseRec.case_no} ${caseRec.subject}` : ''],
      ['依據決議', decs.map((x) => decLabel.get(x.id)).join('；')],
      ['更正', rev.supersedes_id ? `取代版本 ${(find(d, 'recognition_revision', rev.supersedes_id) || {}).revision_no}；原因：${rev.correction_reason}` : ''],
      ['確認', rev.confirmed_by ? `${rev.confirmed_by}，${rev.confirmed_at}` : ''], ['撤銷原因', rev.revoke_reason || ''],
    ]),
    h('h3', { text: '適用條件' }),
    rev.rule ? h('pre', { class: 'rule-text', text: R.describe(rev.rule) }) : h('p', { class: 'note', text: rev.category === '取消認定' ? '取消認定版本不需適用條件。' : '尚未設定適用條件。' }));
  if (editing && draft) {
    box.appendChild(h('div', { class: 'toolbar' },
      btn('修改版本資料', () => guard(async () => {
        const v = await formDialog('修改認定版本', [...revisionFields(rev, d, caseOptions(d)), { key: 'reason', label: '修改原因' }]);
        if (!v) return;
        const { reason, ...ch } = v;
        ch.case_id = ch.case_id || null;
        await s.run((dd, k) => RC.updateRevision(dd, k, rev.id, ch, { expectedVersion: rev.row_version, reason }));
      })),
      btn('連結依據決議', () => guard(async () => {
        const v = await formDialog('連結依據決議', [{ key: 'id', label: '決議', type: 'select', options: decisionOptions(d), required: true }]);
        if (v) await s.run((dd, k) => RC.addRevisionDecision(dd, k, rev.id, v.id));
      })),
      rev.category !== '取消認定' ? btn(st.editRule ? '關閉條件編輯' : '編輯適用條件', () => { st.editRule = !st.editRule; st.ruleHolder = { rule: deepClone(rev.rule) }; env.render(); }) : null,
      rev.confirm_status === '草稿' ? btn('送待確認', () => guard(() => s.run((dd, k) => RC.submitRevision(dd, k, rev.id)))) : null,
      btn('撤銷此版本', () => guard(async () => {
        const v = await formDialog('撤銷版本', [{ key: 'reason', label: '撤銷原因', type: 'textarea', required: true }]);
        if (v) await s.run((dd, k) => RC.withdrawRevision(dd, k, rev.id, v.reason));
      }))));
  }
  if (editing && rev.confirm_status === '已確認') {
    box.appendChild(h('div', { class: 'toolbar' }, btn('建立更正版本', () => guard(() => newRevision(env, rec, rev)))));
  }
  out.push(box);
  const imp = M.activeImport(d);
  if (editing && draft && st.editRule && rev.category !== '取消認定') {
    const eb = h('section', { class: 'panel' }, h('h2', { text: '編輯適用條件' }));
    if (!imp) eb.appendChild(h('p', { class: 'warn-text', text: '尚無已啟用主檔，無法點選條件。' }));
    else if (!st.rows || st.rowsFor !== imp.id) eb.appendChild(btn('載入主檔選項', () => guard(async () => { st.rows = await masterRows(s, imp); st.rowsFor = imp.id; })));
    else {
      eb.appendChild(ruleEditor(env, st.ruleHolder, { rows: st.rows, imp }));
      eb.appendChild(h('div', { class: 'toolbar' }, btn('套用條件至此版本', () => guard(async () => {
        R.validateRule(st.ruleHolder.rule);
        await s.run((dd, k) => RC.updateRevision(dd, k, rev.id, { rule: deepClone(st.ruleHolder.rule) }, { expectedVersion: rev.row_version }));
        st.editRule = false; st.preview = null;
      }), { primary: true })));
    }
    out.push(eb);
  }
  if (rev.rule && rev.category !== '取消認定') out.push(...snapshotSection(env, rev, imp));
  if (rev.rule && rev.category !== '取消認定') out.push(groupSection(env, rev));
  if (editing && draft) {
    out.push(h('section', { class: 'panel' }, h('h3', { text: '確認認定版本' }),
      h('p', { class: 'note', text: '確認前須有與目前條件一致之已確認快照；類別與其他認定衝突時須指定處理依據。系統內確認不取代公文核定。' }),
      btn('確認此認定版本', () => guard(() => confirmRevisionUI(env, rev)), { primary: true })));
  }
  return out;
}

async function confirmRevisionUI(env, rev) {
  const d = data(env);
  const opId = newId();
  let basis = null;
  const conflicts = RC.categoryConflicts(d, rev.id);
  const scope = rev.rule ? RC.revisionScope(d, rev.id).size : 0;
  const body = [h('p', { text: `第 ${rev.revision_no} 版：${rev.category}，期間 ${period(rev.effective_from, rev.effective_to)}，範圍 ${scope} 品項，完整性 ${rev.completeness}。` })];
  if (conflicts.length) {
    body.push(h('p', { class: 'warn-text', text: `與其他認定類別衝突 ${conflicts.length} 筆：` + conflicts.slice(0, 10).map((c) => `${c.drug_code}（${c.other_name}：${c.other_category}）`).join('；') }));
    const inp = h('textarea', { rows: 2, cols: 40 });
    body.push(h('label', null, '處理依據＊ ', inp));
    const ok = await dialog('確認認定版本', body, [{ label: '取消', value: null }, { label: '確認', value: true, primary: true, validate: () => !!inp.value.trim() }]);
    if (!ok) return;
    basis = inp.value.trim();
  } else {
    const ok = await dialog('確認認定版本', body, [{ label: '取消', value: null }, { label: '確認', value: true, primary: true }]);
    if (!ok) return;
  }
  await env.s.run((dd, k) => { RC.confirmRevision(dd, k, rev.id, { conflictBasis: basis }); return { id: rev.id }; }, { opId, kind: '確認認定版本' });
}

function snapshotSection(env, rev, imp) {
  const { s, ui, btn, guard } = env;
  const st = ui.recog;
  const d = data(env);
  const editing = s.mode === 'edit';
  const snaps = list(d, 'scope_snapshot').filter((x) => x.revision_id === rev.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const out = [];
  const box = h('section', { class: 'panel' }, h('h2', { text: '範圍快照（認定範圍名單之證據）' }),
    h('p', { class: 'note', text: '快照為當時判斷之證據，不因新主檔重算覆寫。新主檔之新符合品項經確認後形成新快照。' }),
    table(['建立', '主檔基準日', '符合', '待確認', '全域排除', '狀態', '規則一致', '確認', ''], snaps.map((x) => {
      const mi = find(d, 'master_import', x.import_id) || {};
      return [x.created_at, mi.base_date || '', String(x.match_count), String(x.pending_count),
        x.excluded ? Object.entries(x.excluded).map(([k, v]) => `${k} ${v}`).join('；') : '', x.status,
        R.canonical(x.rule) === R.canonical(rev.rule) ? '是' : '否（規則已變更）', x.confirmed_by ? `${x.confirmed_by}，${x.confirmed_at}` : '',
        btn(st.snap === x.id ? '已開啟' : '開啟', () => { st.snap = x.id; st.memberPage = 0; env.render(); }, { disabled: st.snap === x.id })];
    })));
  if (editing && rev.confirm_status !== '撤銷') {
    if (!imp) box.appendChild(h('p', { class: 'warn-text', text: '尚無已啟用主檔，無法建立快照。' }));
    else {
      box.appendChild(h('div', { class: 'toolbar' }, btn(`以目前主檔（${imp.base_date}）預覽`, () => guard(async () => {
        const rows = await masterRows(s, imp);
        st.preview = await R.previewRule(deepClone(rev.rule), rows, imp, { threshold: s.settings.large_scope_threshold, exclusions: R.exclusionOf(s.settings) });
        st.previewFor = { rev: rev.id, rule: R.canonical(rev.rule), imp: imp.id };
        st.pvState = {};
      }), { primary: true })));
    }
  }
  out.push(box);
  if (st.preview && st.previewFor && st.previewFor.rev === rev.id && st.previewFor.rule === R.canonical(rev.rule)) {
    const pp = previewPanel(env, st.preview, st.pvState);
    if (editing) pp.appendChild(h('div', { class: 'toolbar' }, btn('保存為快照（預覽狀態）', () => guard(async () => {
      const pv = st.preview;
      const snap = await s.run((dd, k) => RC.saveSnapshot(dd, k, rev.id, find(dd, 'master_import', pv.import_id), pv));
      st.preview = null; st.snap = snap.id; st.memberPage = 0;
    }), { primary: true })));
    out.push(pp);
  }
  const snap = st.snap ? find(d, 'scope_snapshot', st.snap) : null;
  if (snap && snap.revision_id === rev.id) out.push(memberPanel(env, rev, snap));
  return out;
}

function memberPanel(env, rev, snap) {
  const { s, ui, btn, guard } = env;
  const st = ui.recog;
  const d = data(env);
  const editable = s.mode === 'edit' && snap.status === '預覽';
  const members = RC.snapshotMemberList(d, snap.id).sort((a, b) => (a.drug_code < b.drug_code ? -1 : 1));
  const reasons = RC.pendingReasonCounts(members);
  const undecided = members.filter((m) => m.eval_result === '待確認' && !m.manual_result).length;
  const final = RC.snapshotFinal(d, snap.id).length;
  st.memberFilter = st.memberFilter || '';
  const rows = members.filter((m) => !st.memberFilter || (st.memberFilter === '未確認' ? m.eval_result === '待確認' && !m.manual_result : m.eval_result === st.memberFilter));
  const page = st.memberPage || 0;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const fsel = h('select', { 'aria-label': '名單篩選' }, [['', '全部'], ['符合', '符合'], ['待確認', '待確認'], ['未確認', '待確認且未人工確認']].map(([k, x]) => h('option', { value: k, text: x, selected: k === st.memberFilter })));
  fsel.addEventListener('change', () => { st.memberFilter = fsel.value; st.memberPage = 0; env.render(); });
  const box = h('section', { class: 'panel' }, h('h2', { text: `快照名單（${snap.status}）` }),
    h('p', { text: `名單 ${members.length} 筆；最終範圍 ${final} 筆；待確認未人工確認 ${undecided} 筆。` }),
    Object.keys(reasons).length ? table(['待確認原因', '筆數', ''], Object.entries(reasons).map(([k, v]) => [k, String(v), editable ? h('span', null,
      btn('全部納入', () => guard(() => bulkUI(env, snap, k, '納入', v))), ' ', btn('全部排除', () => guard(() => bulkUI(env, snap, k, '排除', v)))) : ''])) : null,
    h('div', { class: 'filters' }, h('label', null, '篩選 ', fsel), h('span', { text: `共 ${rows.length} 筆` }),
      btn('上一頁', () => { st.memberPage = page - 1; env.render(); }, { disabled: page === 0 }), h('span', { text: `第 ${page + 1}／${pages} 頁` }),
      btn('下一頁', () => { st.memberPage = page + 1; env.render(); }, { disabled: page >= pages - 1 })),
    table(['藥品代碼', '分組', '判定', '判定路徑', '人工確認', '理由', ''], rows.slice(page * PAGE, (page + 1) * PAGE).map((m) => [m.drug_code, m.group_code || '', m.eval_result, m.path,
      m.manual_result || '', m.manual_reason || '', editable && m.eval_result === '待確認' ? h('span', null,
        btn('納入', () => guard(() => memberUI(env, snap, m, '納入'))), ' ', btn('排除', () => guard(() => memberUI(env, snap, m, '排除')))) : ''])));
  if (editable) {
    box.appendChild(h('div', { class: 'toolbar' },
      btn('確認此快照名單', () => guard(() => confirmSnapshotUI(env, rev, snap)), { primary: true, disabled: undecided > 0, title: undecided ? '尚有待確認品項未人工確認' : '' }),
      btn('撤銷此快照', () => guard(async () => {
        const v = await formDialog('撤銷快照', [{ key: 'reason', label: '原因', type: 'textarea', required: true }]);
        if (v) await s.run((dd, k) => RC.revokeSnapshot(dd, k, snap.id, v.reason));
      }))));
  }
  if (snap.added_codes && snap.added_codes.length) box.appendChild(h('p', { class: 'note', text: '本快照擴增已確認認定範圍之品項：' + snap.added_codes.join('、') }));
  return box;
}

async function memberUI(env, snap, m, decision) {
  const v = await formDialog(`人工確認：${m.drug_code} ${decision}`, [{ key: 'reason', label: '理由', type: 'textarea', required: true }, { type: 'note', label: `判定路徑：${m.path}` }]);
  if (v) await env.s.run((dd, k) => RC.setMemberDecision(dd, k, snap.id, m.drug_code, decision, v.reason));
}

async function bulkUI(env, snap, key, decision, n) {
  const v = await formDialog(`依原因批次${decision}`, [{ type: 'note', label: `待確認原因「${key}」之 ${n} 筆品項將全部人工確認為「${decision}」。` }, { key: 'reason', label: '理由', type: 'textarea', required: true }]);
  if (v) await env.s.run((dd, k) => RC.bulkMemberDecision(dd, k, snap.id, key, decision, v.reason));
}

async function confirmSnapshotUI(env, rev, snap) {
  const d = data(env);
  const opId = newId();
  const added = RC.snapshotAddedCodes(d, snap.id);
  const body = [h('p', { text: `確認後名單不可修改。最終範圍 ${RC.snapshotFinal(d, snap.id).length} 筆。` })];
  if (rev.confirm_status === '已確認') {
    body.push(h('p', { class: 'warn-text', text: `此認定版本已確認；本快照將擴增範圍 ${added.length} 項：` }));
    body.push(h('p', { text: added.join('、') || '（無新增）' }));
    body.push(h('p', { class: 'note', text: '新增品項僅擴增認定範圍名單，不自動調高或註記（T13）。' }));
  }
  const ok = await dialog('確認快照名單', body, [{ label: '取消', value: null }, { label: '確認', value: true, primary: true }]);
  if (!ok) return;
  await env.s.run((dd, k) => { RC.confirmSnapshot(dd, k, snap.id, { acknowledgedAdded: added }); return { id: snap.id }; }, { opId, kind: '確認快照' });
}

function groupSection(env, rev) {
  const { s, btn, guard } = env;
  const d = data(env);
  const editing = s.mode === 'edit';
  const gts = list(d, 'group_treatment').filter((g) => g.revision_id === rev.id);
  const snap = RC.confirmedSnapshotOf(d, rev.id);
  const groups = snap && snap.groups ? Object.entries(snap.groups) : [];
  return h('section', { class: 'panel' }, h('h2', { text: '分組調價方式' }),
    h('p', { class: 'note', text: 'B02：有品項建議提高通過後，相關分組不再依DET調整，改依第25條；適用起日待確認（Q01），不由會議日推定。部分涵蓋分組不自動推導整組（Q02）。' }),
    groups.length ? table(['分組', '範圍內', '分組總數', '涵蓋'], groups.map(([g, x]) => [g, String(x.inside), String(x.total), x.inside < x.total ? '部分涵蓋' : '全組'])) : h('p', { class: 'note', text: '尚無已確認快照。' }),
    gts.length ? table(['分組', '調價方式', '部分涵蓋', '期間', '依據', '狀態', ''], gts.map((g) => [g.group_code, g.method, g.partial_cover ? '是' : '否', period(g.effective_from, g.effective_to), g.basis || '', g.confirm_status,
      editing && (g.confirm_status === '草稿' || g.confirm_status === '待確認') ? btn('確認', () => guard(async () => {
        const ok = await dialog('確認分組調價方式', [h('p', { text: `${g.group_code}：${g.method}，期間 ${period(g.effective_from, g.effective_to)}` })], [{ label: '取消', value: null }, { label: '確認', value: true, primary: true }]);
        if (ok) await s.run((dd, k) => RC.confirmGroupTreatment(dd, k, g.id), { opId: newId(), kind: '確認分組調價方式' });
      })) : ''])) : null,
    editing && groups.length ? btn('登錄分組調價方式', () => guard(async () => {
      const v = await formDialog('登錄分組調價方式', [
        { key: 'group_code', label: '分組', type: 'select', options: groups.map(([g, x]) => [g, `${g}（${x.inside}/${x.total}）`]), required: true },
        { key: 'method', label: '調價方式', type: 'select', options: opts(E.METHOD), value: '待確認', required: true },
        { key: 'effective_from', label: '適用起日', type: 'date' }, { key: 'effective_to', label: '迄日（不含）', type: 'date' },
        { key: 'basis', label: '依據', type: 'textarea' }]);
      if (v) await s.run((dd, k) => RC.setGroupTreatment(dd, k, { ...v, revision_id: rev.id }));
    })) : null);
}

