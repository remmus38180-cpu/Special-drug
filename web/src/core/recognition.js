// 認定項目、認定版本、範圍快照、分組調價方式、衝突判斷、依日期查詢（第6、8、9.2節）。
// 認定範圍名單、本次調高名單、主檔註記名單三者分開；快照為當時判斷之證據，不因新主檔重算覆寫。
// 函式皆於 session.run() 之資料副本上執行：fn(data, ctx)；預覽（非同步）於外部完成後傳入。
import { SpecError } from './errors.js';
import { E, insert, update, setConfirmStatus, setDedicated, find, must, list } from './model.js';
import { validateRule, canonical, pendingReason, UNKNOWN, TRUE } from './rules.js';
import { dateField } from './cases.js';

function txt(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function sameRule(a, b) {
  if (!a || !b) return false;
  return canonical(a) === canonical(b);
}

// ---------- 認定項目 ----------
export function createRecognition(data, ctx, { name, recognition_no, unit, description }) {
  const n = txt(name);
  if (!n) throw new SpecError('REQUIRED', '請輸入認定名稱');
  const dup = list(data, 'recognition').find((r) => r.name === n);
  if (dup) throw new SpecError('DUPLICATE', `已有同名認定項目（${dup.recognition_no}），請改建立變更版本以避免重複認定`, { id: dup.id });
  let no = txt(recognition_no);
  if (!no) {
    const used = new Set(list(data, 'recognition').map((r) => r.recognition_no));
    let k = list(data, 'recognition').length + 1;
    while (used.has(`R${String(k).padStart(5, '0')}`)) k++;
    no = `R${String(k).padStart(5, '0')}`;
  }
  return insert(data, ctx, 'recognition', { recognition_no: no, name: n, unit: txt(unit), description: txt(description) });
}

export function updateRecognition(data, ctx, id, changes, opts = {}) {
  const allowed = ['name', 'unit', 'description'];
  const bad = Object.keys(changes).filter((k) => !allowed.includes(k));
  if (bad.length) throw new SpecError('FIELD_NOT_ALLOWED', `認定項目不可直接修改：${bad.join('、')}`);
  if ('name' in changes) {
    const n = txt(changes.name);
    if (!n) throw new SpecError('REQUIRED', '請輸入認定名稱');
    if (list(data, 'recognition').some((r) => r.id !== id && r.name === n)) throw new SpecError('DUPLICATE', '已有同名認定項目');
  }
  return update(data, ctx, 'recognition', id, changes, opts);
}

// ---------- 認定版本 ----------
function checkPeriod(ef, et) {
  if (ef && et && et <= ef) throw new SpecError('BAD_VALUE', '迄日須晚於起日（起日含、迄日不含）');
}

export function createRevision(data, ctx, recognitionId, input) {
  const rec = must(data, 'recognition', recognitionId);
  const category = input.category;
  if (!E.REV_CATEGORY.includes(category)) throw new SpecError('BAD_VALUE', '認定類別須為：' + E.REV_CATEGORY.join('／'));
  if (input.rule !== null && input.rule !== undefined) validateRule(input.rule);
  if (input.supersedes_id) {
    const old = must(data, 'recognition_revision', input.supersedes_id);
    if (old.recognition_id !== rec.id) throw new SpecError('BAD_REF', '被更正版本不屬於此認定項目');
    if (!txt(input.correction_reason)) throw new SpecError('REQUIRED', '更正版本須填寫更正原因');
    if (list(data, 'recognition_revision').some((r) => r.supersedes_id === old.id && r.confirm_status !== '撤銷')) {
      throw new SpecError('DUPLICATE', '此版本已有更正版本');
    }
  }
  const ef = dateField(input.effective_from, '生效日');
  const et = dateField(input.effective_to, '迄日');
  checkPeriod(ef, et);
  const decisionIds = input.decision_ids || [];
  for (const id of decisionIds) must(data, 'decision', id);
  if (input.case_id) must(data, 'case_record', input.case_id);
  const completeness = input.completeness || (ef && (decisionIds.length || input.case_id) ? '完整' : '不完整');
  const no = Math.max(0, ...list(data, 'recognition_revision').filter((r) => r.recognition_id === rec.id).map((r) => r.revision_no)) + 1;
  const rev = insert(data, ctx, 'recognition_revision', {
    recognition_id: rec.id, revision_no: no, category, original_category: txt(input.original_category),
    scope_text: txt(input.scope_text), rule: input.rule ?? null, conditions_text: txt(input.conditions_text),
    effective_from: ef, effective_to: et, decision_id: decisionIds[0] || null, case_id: input.case_id || null,
    supersedes_id: input.supersedes_id || null, correction_reason: txt(input.correction_reason), completeness,
  });
  for (const id of decisionIds) insert(data, ctx, 'revision_decision', { revision_id: rev.id, decision_id: id, link_type: '依據' });
  return rev;
}

const REV_EDITABLE = ['category', 'scope_text', 'rule', 'conditions_text', 'effective_from', 'effective_to', 'case_id', 'completeness', 'decision_id'];

export function updateRevision(data, ctx, revId, changes, opts = {}) {
  const rev = must(data, 'recognition_revision', revId);
  if (rev.confirm_status !== '草稿' && rev.confirm_status !== '待確認') throw new SpecError('CONFIRMED_READONLY', '已確認或撤銷的版本不可修改；請建立更正版本');
  const bad = Object.keys(changes).filter((k) => !REV_EDITABLE.includes(k));
  if (bad.length) throw new SpecError('FIELD_NOT_ALLOWED', `認定版本不可修改：${bad.join('、')}`);
  const c = { ...changes };
  if ('category' in c && !E.REV_CATEGORY.includes(c.category)) throw new SpecError('BAD_VALUE', '認定類別不正確');
  if ('rule' in c && c.rule !== null) validateRule(c.rule);
  for (const k of ['effective_from', 'effective_to']) if (k in c) c[k] = dateField(c[k], k === 'effective_from' ? '生效日' : '迄日');
  checkPeriod('effective_from' in c ? c.effective_from : rev.effective_from, 'effective_to' in c ? c.effective_to : rev.effective_to);
  for (const k of ['scope_text', 'conditions_text']) if (k in c) c[k] = txt(c[k]);
  return update(data, ctx, 'recognition_revision', revId, c, opts);
}

export function addRevisionDecision(data, ctx, revId, decisionId) {
  const rev = must(data, 'recognition_revision', revId);
  if (rev.confirm_status === '已確認' || rev.confirm_status === '撤銷') throw new SpecError('CONFIRMED_READONLY', '已確認或撤銷的版本不可增加依據；請建立更正版本');
  must(data, 'decision', decisionId);
  if (list(data, 'revision_decision').some((x) => x.revision_id === revId && x.decision_id === decisionId)) throw new SpecError('DUPLICATE', '已連結此決議');
  return insert(data, ctx, 'revision_decision', { revision_id: revId, decision_id: decisionId, link_type: '依據' });
}

export function submitRevision(data, ctx, revId) {
  const rev = must(data, 'recognition_revision', revId);
  if (rev.confirm_status !== '草稿') throw new SpecError('BAD_TRANSITION', '只有草稿可送待確認');
  return setConfirmStatus(data, ctx, 'recognition_revision', revId, '待確認');
}

export function withdrawRevision(data, ctx, revId, reason) {
  const rev = must(data, 'recognition_revision', revId);
  if (rev.confirm_status === '已確認') throw new SpecError('CONFIRMED_READONLY', '已確認版本不可撤銷覆寫；請建立取消或更正版本');
  return setConfirmStatus(data, ctx, 'recognition_revision', revId, '撤銷', { reason });
}

// ---------- 範圍快照 ----------
// pv：previewRule() 之結果（以同一規則、指定主檔計算）；imp：主檔版本紀錄
export function saveSnapshot(data, ctx, revId, imp, pv) {
  const rev = must(data, 'recognition_revision', revId);
  if (!rev.rule) throw new SpecError('NO_RULE', '此版本尚未設定適用條件');
  if (rev.confirm_status === '撤銷') throw new SpecError('REVOKED', '已撤銷版本不可建立快照');
  const cur = must(data, 'master_import', imp.id);
  // 快照只能採已啟用主檔（REVIEW M5／G5）
  if (cur.status !== '已啟用') throw new SpecError('MASTER_NOT_ACTIVE', '快照只能採用已啟用之主檔版本');
  if (pv.import_id !== imp.id) throw new SpecError('PREVIEW_STALE', '預覽所用主檔與指定主檔不同，請重新預覽');
  if (!pv.rule_canonical || pv.rule_canonical !== canonical(rev.rule)) throw new SpecError('PREVIEW_STALE', '預覽後規則已變更，請重新預覽');
  const snap = insert(data, ctx, 'scope_snapshot', {
    revision_id: rev.id, import_id: imp.id, rule_hash: pv.rule_hash, rule: rev.rule, evaluated_at: ctx.now,
    match_count: pv.match, pending_count: pv.pending, exclusions: pv.exclusions || null, excluded: pv.excluded || null,
    groups: Object.fromEntries(pv.groups.map((g) => [g.group_code, { inside: g.matched + g.pending, total: g.total }])),
  }, { action: '建立快照' });
  for (const m of pv.members) {
    insert(data, ctx, 'scope_member', {
      snapshot_id: snap.id, drug_code: m.drug_code, eval_result: m.result, path: m.path, group_code: m.group_code, source_row: m.source_row,
    }, { action: '快照名單' });
  }
  // 名單逐筆稽核過多：合併為一筆
  compactMemberEvents(ctx, snap.id, pv.members.length);
  return snap;
}

function compactMemberEvents(ctx, snapId, n) {
  const kept = ctx.events.filter((e) => !(e.entity === 'scope_member' && e.action === '快照名單'));
  ctx.events.length = 0;
  ctx.events.push(...kept, { entity: 'scope_snapshot', entity_id: snapId, action: '寫入快照名單', diff: { count: n }, reason: null, op_id: ctx.opId || null });
}

function editableSnapshot(data, snapId) {
  const snap = must(data, 'scope_snapshot', snapId);
  if (snap.status !== '預覽') throw new SpecError('CONFIRMED_READONLY', '已確認或撤銷之快照不可修改；如需調整請建立新快照');
  return snap;
}

export function snapshotMemberList(data, snapId) {
  return list(data, 'scope_member').filter((m) => m.snapshot_id === snapId);
}

export function setMemberDecision(data, ctx, snapId, drugCode, decision, reason) {
  editableSnapshot(data, snapId);
  if (!E.MANUAL.includes(decision)) throw new SpecError('BAD_VALUE', '人工確認結果須為「納入」或「排除」');
  if (!txt(reason)) throw new SpecError('REQUIRED', '人工確認須填寫理由');
  const m = snapshotMemberList(data, snapId).find((x) => x.drug_code === drugCode);
  if (!m) throw new SpecError('OUT_OF_SCOPE', '此品項不在快照名單內；範圍外品項須另補認定依據');
  return update(data, ctx, 'scope_member', m.id, { manual_result: decision, manual_reason: txt(reason) }, { reason: txt(reason) });
}

export function pendingReasonCounts(members) {
  const out = {};
  for (const m of members) {
    if (m.eval_result !== UNKNOWN) continue;
    for (const k of new Set(m.path.split('；').map(pendingReason))) out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// 依待確認原因批次人工確認（明確選定原因；作用範圍即含該原因之全部待確認品項）
export function bulkMemberDecision(data, ctx, snapId, reasonKey, decision, reason) {
  editableSnapshot(data, snapId);
  if (!E.MANUAL.includes(decision) || !txt(reason)) throw new SpecError('REQUIRED', '請選納入／排除並填寫理由');
  const targets = snapshotMemberList(data, snapId).filter((m) => m.eval_result === UNKNOWN && m.path.split('；').map(pendingReason).includes(reasonKey));
  const before = ctx.events.length;
  for (const m of targets) update(data, ctx, 'scope_member', m.id, { manual_result: decision, manual_reason: txt(reason) });
  ctx.events.splice(before);
  ctx.events.push({ entity: 'scope_snapshot', entity_id: snapId, action: '批次人工確認', diff: { reason_key: reasonKey, decision, count: targets.length, codes: targets.map((m) => m.drug_code) }, reason: txt(reason), op_id: ctx.opId || null });
  return targets.length;
}

// 最終名單：符合且未人工排除，或人工納入
export function snapshotFinal(data, snapId) {
  return snapshotMemberList(data, snapId).filter((m) => (m.eval_result === TRUE && m.manual_result !== '排除') || m.manual_result === '納入')
    .sort((a, b) => (a.drug_code < b.drug_code ? -1 : 1));
}

// 版本之認定範圍：與目前規則一致之已確認快照名單聯集
export function revisionScope(data, revId) {
  const rev = must(data, 'recognition_revision', revId);
  const codes = new Set();
  for (const s of list(data, 'scope_snapshot')) {
    if (s.revision_id !== revId || s.status !== '已確認' || !sameRule(s.rule, rev.rule)) continue;
    for (const m of snapshotFinal(data, s.id)) codes.add(m.drug_code);
  }
  return codes;
}

export function snapshotAddedCodes(data, snapId) {
  const snap = must(data, 'scope_snapshot', snapId);
  const cur = revisionScope(data, snap.revision_id);
  return snapshotFinal(data, snapId).map((m) => m.drug_code).filter((c) => !cur.has(c));
}

// 確認快照；已確認之認定版本擴增範圍，須經確認對話框列出新增品項（acknowledgedAdded 與實際相同），並記錄稽核（第11.4節第3點、M5）
export function confirmSnapshot(data, ctx, snapId, { acknowledgedAdded } = {}) {
  const snap = editableSnapshot(data, snapId);
  const rev = must(data, 'recognition_revision', snap.revision_id);
  if (rev.confirm_status === '撤銷') throw new SpecError('REVOKED', '認定版本已撤銷');
  if (!sameRule(snap.rule, rev.rule)) throw new SpecError('PREVIEW_STALE', '預覽後規則已變更，請重新預覽建立新快照');
  const imp = must(data, 'master_import', snap.import_id);
  if (imp.status === '試匯入' || imp.status === '失敗') throw new SpecError('MASTER_NOT_ACTIVE', '快照所用主檔未啟用');
  const undecided = snapshotMemberList(data, snapId).filter((m) => m.eval_result === UNKNOWN && !m.manual_result).length;
  if (undecided) throw new SpecError('PENDING_UNDECIDED', `尚有 ${undecided} 筆待確認品項未人工確認，不能確認範圍名單`);
  const added = snapshotAddedCodes(data, snapId);
  if (rev.confirm_status === '已確認') {
    const ack = acknowledgedAdded ? [...acknowledgedAdded].sort() : null;
    if (!ack || ack.join(',') !== [...added].sort().join(',')) {
      throw new SpecError('NEED_ACK', `已確認之認定版本擴增範圍 ${added.length} 項，須於確認對話框列出新增品項並確認`, { added });
    }
  }
  return setDedicated(data, ctx, 'scope_snapshot', snapId, { status: '已確認', confirmed_by: ctx.actor, confirmed_at: ctx.now, added_codes: rev.confirm_status === '已確認' ? added : null },
    { action: rev.confirm_status === '已確認' ? '確認快照（擴增已確認認定範圍）' : '確認快照', fields: ['status', 'confirmed_by', 'confirmed_at', 'added_codes'] });
}

export function revokeSnapshot(data, ctx, snapId, reason) {
  editableSnapshot(data, snapId);
  if (!txt(reason)) throw new SpecError('REQUIRED', '撤銷須填原因');
  return setDedicated(data, ctx, 'scope_snapshot', snapId, { status: '撤銷', note: txt(reason) }, { action: '撤銷快照', reason: txt(reason), fields: ['status', 'note'] });
}

// ---------- 確認認定版本 ----------
export function confirmedSnapshotOf(data, revId) {
  const rev = must(data, 'recognition_revision', revId);
  return list(data, 'scope_snapshot').filter((s) => s.revision_id === revId && s.status === '已確認' && sameRule(s.rule, rev.rule))
    .sort((a, b) => (a.confirmed_at < b.confirmed_at ? 1 : -1))[0] || null;
}

function overlap(a1, a2, b1, b2) {
  if (!a1 || !b1) return true; // 期間未知時保守視為可能重疊
  return a1 < (b2 || '9999-12-31') && b1 < (a2 || '9999-12-31');
}

export function categoryConflicts(data, revId) {
  const rev = must(data, 'recognition_revision', revId);
  if (rev.category === '取消認定' || rev.category === '待確認') return [];
  const mine = revisionScope(data, revId);
  const out = [];
  for (const other of list(data, 'recognition_revision')) {
    if (other.confirm_status !== '已確認' || other.recognition_id === rev.recognition_id) continue;
    if (other.category === '取消認定' || other.category === '待確認' || other.category === rev.category) continue;
    if (!overlap(rev.effective_from, rev.effective_to, other.effective_from, other.effective_to)) continue;
    const theirs = revisionScope(data, other.id);
    const r = find(data, 'recognition', other.recognition_id) || {};
    for (const code of [...mine].filter((c) => theirs.has(c)).sort()) out.push({ drug_code: code, other_name: r.name, other_category: other.category, other_revision_id: other.id });
  }
  return out;
}

// 確認版本：範圍需與目前規則一致之已確認快照；類別衝突須指定處理依據（不採最後儲存者優先）
export function confirmRevision(data, ctx, revId, { conflictBasis } = {}) {
  const rev = must(data, 'recognition_revision', revId);
  if (rev.confirm_status === '已確認') return rev;
  if (rev.confirm_status !== '草稿' && rev.confirm_status !== '待確認') throw new SpecError('REVOKED', '撤銷版本不可確認');
  if (rev.category === '待確認') throw new SpecError('CATEGORY_PENDING', '認定類別待確認，請先選定類別');
  if (rev.rule && rev.category !== '取消認定' && !confirmedSnapshotOf(data, revId)) {
    if (list(data, 'scope_snapshot').some((s) => s.revision_id === revId && s.status === '已確認')) {
      throw new SpecError('PREVIEW_STALE', '已確認快照的規則與目前規則不一致（預覽後規則已變更），請重新預覽並確認新快照後再確認認定');
    }
    throw new SpecError('NO_SNAPSHOT', '適用條件尚未確認範圍名單（快照），不能確認認定');
  }
  if (!rev.rule && rev.category !== '取消認定') throw new SpecError('NO_RULE', '尚未設定適用條件，不能確認認定');
  const conflicts = categoryConflicts(data, revId);
  if (conflicts.length && !txt(conflictBasis)) {
    throw new SpecError('CONFLICT_CATEGORY', `與其他認定類別衝突 ${conflicts.length} 筆，請指定處理依據後再確認：` + conflicts.slice(0, 10).map((c) => `${c.drug_code}：${c.other_name}（${c.other_category}）`).join('；'), { conflicts });
  }
  return setConfirmStatus(data, ctx, 'recognition_revision', revId, '已確認', { reason: conflicts.length ? `衝突處理依據：${txt(conflictBasis)}` : null });
}

// ---------- 依日期查詢（現行有效由查詢日期計算，不依排程） ----------
function activeRevisions(data, recId) {
  const revs = list(data, 'recognition_revision').filter((r) => r.recognition_id === recId && r.confirm_status === '已確認').sort((a, b) => a.revision_no - b.revision_no);
  const replaced = new Set(revs.map((r) => r.supersedes_id).filter(Boolean));
  return revs.filter((r) => !replaced.has(r.id));
}

export function statusOn(data, recId, day) {
  const revs = activeRevisions(data, recId);
  if (!revs.length) {
    const draft = list(data, 'recognition_revision').some((r) => r.recognition_id === recId && (r.confirm_status === '草稿' || r.confirm_status === '待確認'));
    return { state: draft ? '草稿／待確認' : '無已確認版本', revision: null };
  }
  const applicable = revs.filter((r) => r.effective_from && r.effective_from <= day && (!r.effective_to || day < r.effective_to))
    .sort((a, b) => (a.effective_from === b.effective_from ? a.revision_no - b.revision_no : a.effective_from < b.effective_from ? -1 : 1));
  if (applicable.length) {
    const cur = applicable[applicable.length - 1];
    return { state: cur.category === '取消認定' ? '已取消' : '有效', revision: cur };
  }
  const future = revs.filter((r) => r.effective_from && r.effective_from > day).sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  if (future.length) return { state: '待生效', revision: future[0] };
  const unknown = revs.filter((r) => !r.effective_from);
  if (unknown.length) return { state: '生效日待確認', revision: unknown[unknown.length - 1] };
  return { state: '已失效', revision: revs[revs.length - 1] };
}

export function revisionHistory(data, recId, day) {
  const revs = list(data, 'recognition_revision').filter((r) => r.recognition_id === recId).sort((a, b) => a.revision_no - b.revision_no);
  const confirmed = revs.filter((r) => r.confirm_status === '已確認');
  const replaced = new Set(confirmed.map((r) => r.supersedes_id).filter(Boolean));
  const timeline = confirmed.filter((r) => !replaced.has(r.id) && r.effective_from).sort((a, b) => (a.effective_from === b.effective_from ? a.revision_no - b.revision_no : a.effective_from < b.effective_from ? -1 : 1));
  const st = statusOn(data, recId, day);
  const curId = st.revision ? st.revision.id : null;
  return revs.map((r) => {
    if (r.confirm_status !== '已確認') return { ...r, state: r.confirm_status, period_end: r.effective_to, current: false };
    const nxt = r.effective_from && !replaced.has(r.id) ? timeline.find((t) => t.effective_from > r.effective_from) : null;
    let end = r.effective_to;
    if (nxt && (!end || nxt.effective_from < end)) end = nxt.effective_from;
    let state;
    if (replaced.has(r.id)) state = '已更正取代';
    else if (r.id === curId) state = st.state;
    else if (!r.effective_from) state = '生效日待確認';
    else if (r.effective_from > day) state = '待生效';
    else if (nxt && end === nxt.effective_from && nxt.effective_from <= day && nxt.category === '取消認定') state = '已取消';
    else state = '已失效';
    return { ...r, state, period_end: end, current: r.id === curId };
  });
}

// 該藥曾被涵蓋之全部認定版本（含已取消、已失效）
export function drugRecognitions(data, drugCode, day) {
  const recIds = new Set();
  for (const m of list(data, 'scope_member')) {
    if (m.drug_code !== drugCode) continue;
    const s = find(data, 'scope_snapshot', m.snapshot_id);
    if (s && s.status === '已確認') { const rv = find(data, 'recognition_revision', s.revision_id); if (rv) recIds.add(rv.recognition_id); }
  }
  const out = [];
  for (const recId of recIds) {
    const hist = revisionHistory(data, recId, day).filter((h) => h.confirm_status === '已確認');
    const covers = new Map(hist.map((h) => [h.id, revisionScope(data, h.id).has(drugCode)]));
    if (![...covers.values()].some(Boolean)) continue;
    const rec = find(data, 'recognition', recId);
    for (const h of hist) {
      if (!covers.get(h.id) && h.category !== '取消認定') continue;
      out.push({ recognition_id: recId, recognition_no: rec.recognition_no, name: rec.name, state: h.state, category: h.category, revision_id: h.id,
        revision_no: h.revision_no, effective_from: h.effective_from, effective_to: h.effective_to, period_end: h.period_end, current: h.current, covers: covers.get(h.id) });
    }
  }
  return out;
}

// 單一類別；多來源類別衝突時不產生單一結果
export function drugCategoryOn(data, drugCode, day) {
  const srcs = drugRecognitions(data, drugCode, day).filter((s) => s.current && s.covers && s.state === '有效');
  const cats = new Set(srcs.map((s) => s.category));
  if (cats.size > 1) return { category: null, conflict: true, sources: srcs };
  return { category: cats.size ? [...cats][0] : null, conflict: false, sources: srcs };
}

export function listRecognitions(data, { keyword, day }) {
  const kw = txt(keyword);
  return list(data, 'recognition').map((r) => {
    const st = statusOn(data, r.id, day);
    const revs = list(data, 'recognition_revision').filter((x) => x.recognition_id === r.id);
    const latest = revs.sort((a, b) => b.revision_no - a.revision_no)[0] || null;
    const scope = st.revision && st.revision.rule ? revisionScope(data, st.revision.id) : new Set();
    return { ...r, state: st.state, category: (st.revision || latest || {}).category || null, drug_count: scope.size,
      pending_revisions: revs.filter((x) => x.confirm_status === '草稿' || x.confirm_status === '待確認').length,
      last_updated: latest ? latest.updated_at : r.updated_at, _revs: revs };
  }).filter((r) => {
    if (!kw) return true;
    if ([r.recognition_no, r.name, r.description].filter(Boolean).join(' ').includes(kw)) return true;
    return r._revs.some((v) => (v.scope_text || '').includes(kw) || JSON.stringify(v.rule || '').includes(kw) ||
      list(data, 'scope_snapshot').some((s) => s.revision_id === v.id && list(data, 'scope_member').some((m) => m.snapshot_id === s.id && (m.drug_code === kw || m.group_code === kw))));
  }).map(({ _revs, ...x }) => x).sort((a, b) => (a.recognition_no < b.recognition_no ? -1 : 1));
}

// ---------- 分組調價方式（部分涵蓋分組不自動推導整組；起日不由會議日推定） ----------
export function setGroupTreatment(data, ctx, { group_code, revision_id, method, effective_from, effective_to, basis }) {
  if (!E.METHOD.includes(method)) throw new SpecError('BAD_VALUE', '調價方式須為：' + E.METHOD.join('／'));
  const rev = must(data, 'recognition_revision', revision_id);
  const snap = confirmedSnapshotOf(data, rev.id);
  let partial = false;
  if (snap && snap.groups && snap.groups[group_code]) partial = snap.groups[group_code].inside < snap.groups[group_code].total;
  if (method === '第25條' && partial && !txt(basis)) throw new SpecError('REQUIRED', '此分組僅部分涵蓋，改依第25條須填寫依據（Q02）');
  const ef = dateField(effective_from, '起日');
  const et = dateField(effective_to, '迄日');
  checkPeriod(ef, et);
  return insert(data, ctx, 'group_treatment', { group_code, revision_id: rev.id, method, partial_cover: partial, effective_from: ef, effective_to: et, basis: txt(basis) });
}

export function confirmGroupTreatment(data, ctx, id) {
  const gt = must(data, 'group_treatment', id);
  if (gt.method !== '待確認' && !gt.effective_from) throw new SpecError('NEED_DATE', '適用起日未確認（Q01），請保留待確認，不由會議日推定');
  return setConfirmStatus(data, ctx, 'group_treatment', id, '已確認');
}
