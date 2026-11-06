// 差異待辦（T13、T14）與主檔註記比對（§9.2-11）。新主檔匯入後比對已確認認定：新符合、不再符合、分組異動、主檔消失、規則停用；
// 主檔註記比對：一致／應有未有／主檔有但無完整依據／類別不同／無法判定。不自動註記、調高或更新正式主檔。
// 計算（非同步，讀主檔列）於 run 之外完成，結果以 addTodos 於 run 內寫入。
import { SpecError } from './errors.js';
import { insert, update, must, list, find } from './model.js';
import { previewRule, exclusionOf, canonical } from './rules.js';
import { revisionScope } from './recognition.js';
import { annotationOn } from './pricing.js';

export const TODO_KINDS = ['新符合', '不再符合', '分組異動', '主檔消失', '規則停用', '主檔註記不一致'];

function txt(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function confirmedRevisions(data) {
  const replaced = new Set(list(data, 'recognition_revision').filter((r) => r.confirm_status === '已確認' && r.supersedes_id).map((r) => r.supersedes_id));
  return list(data, 'recognition_revision').filter((r) => r.confirm_status === '已確認' && r.rule && r.category !== '取消認定' && !replaced.has(r.id));
}

function snapshotGroups(data, revId) {
  const rev = must(data, 'recognition_revision', revId);
  const out = new Map();
  for (const s of list(data, 'scope_snapshot')) {
    if (s.revision_id !== revId || s.status !== '已確認' || !s.rule || canonical(s.rule) !== canonical(rev.rule)) continue;
    for (const m of list(data, 'scope_member')) if (m.snapshot_id === s.id && m.group_code) out.set(m.drug_code, m.group_code);
  }
  return out;
}

// 計算差異待辦項目（不寫入）；rows＝新主檔列（{byCode}）
export async function computeDiffTodos(data, imp, rows, settings, { tick } = {}) {
  if (!imp || imp.status !== '已啟用') throw new SpecError('MASTER_NOT_ACTIVE', '差異比對須使用已啟用之主檔版本');
  const exclusions = exclusionOf(settings);
  const items = [];
  const revs = confirmedRevisions(data);
  let i = 0;
  for (const rev of revs) {
    i += 1;
    if (tick) await tick(i, revs.length);
    const scope = revisionScope(data, rev.id);
    if (!scope.size) continue;
    let pv;
    try {
      pv = await previewRule(rev.rule, rows, imp, { exclusions, threshold: Infinity });
    } catch (e) {
      if (e && e.code === 'FIELD_DISABLED') {
        items.push({ kind: '規則停用', drug_code: null, group_code: null, revision_id: rev.id, detail: `${e.message}；此認定本次停用比對，未產生新符合／不再符合` });
        continue;
      }
      throw e;
    }
    const hit = new Map(pv.members.map((m) => [m.drug_code, m]));
    const groups = snapshotGroups(data, rev.id);
    for (const m of pv.members) {
      if (!scope.has(m.drug_code)) items.push({ kind: '新符合', drug_code: m.drug_code, group_code: m.group_code, revision_id: rev.id, detail: `${m.result}：${m.path || ''}；須確認後形成新快照，不自動註記或調高` });
    }
    for (const code of [...scope].sort()) {
      const d = rows.byCode.get(code);
      if (!d) { items.push({ kind: '主檔消失', drug_code: code, group_code: groups.get(code) || null, revision_id: rev.id, detail: '新主檔無此代碼；不自動刪除認定或解讀成取消給付' }); continue; }
      if (!hit.has(code)) items.push({ kind: '不再符合', drug_code: code, group_code: d.group_code || null, revision_id: rev.id, detail: '新主檔依目前條件為不符合或屬全域排除；認定與註記不自動變更' });
      const g0 = groups.get(code);
      const g1 = d.group_code || null;
      if (g0 && g0 !== g1) items.push({ kind: '分組異動', drug_code: code, group_code: g1, revision_id: rev.id, detail: `快照分組 ${g0} → 新主檔 ${g1 || '（空白）'}；歷史快照不變` });
    }
  }
  return items;
}

// 寫入差異待辦（同種類＋品項＋認定版本＋主檔版本不重複）
export function addTodos(data, ctx, importId, items) {
  must(data, 'master_import', importId);
  const key = (k, c, r) => `${k}|${c || ''}|${r || ''}`;
  const seen = new Set(list(data, 'review_item').filter((t) => t.import_id === importId).map((t) => key(t.kind, t.drug_code, t.revision_id)));
  let added = 0;
  for (const it of items) {
    const k = key(it.kind, it.drug_code, it.revision_id);
    if (seen.has(k)) continue;
    seen.add(k);
    insert(data, ctx, 'review_item', { kind: it.kind, drug_code: it.drug_code || null, group_code: it.group_code || null, revision_id: it.revision_id || null, import_id: importId, detail: it.detail || null });
    added += 1;
  }
  return { added, skipped: items.length - added };
}

export function resolveTodo(data, ctx, id, status, conclusion) {
  const t = must(data, 'review_item', id);
  if (status !== '已處理' && status !== '不處理') throw new SpecError('BAD_VALUE', '處理結果須為「已處理」或「不處理」');
  if (!txt(conclusion)) throw new SpecError('REQUIRED', '請填寫處理結論');
  if (t.status !== '待處理') throw new SpecError('ALREADY', '此待辦已處理；如需改結論請另記於新待辦或備註');
  return update(data, ctx, 'review_item', id, { status, conclusion: txt(conclusion) });
}

export function listTodos(data, { kind, status, importId, drugCode } = {}) {
  return list(data, 'review_item').filter((t) => (!kind || t.kind === kind) && (!status || t.status === status) && (!importId || t.import_id === importId) && (!drugCode || t.drug_code === drugCode))
    .sort((a, b) => (a.kind === b.kind ? ((a.drug_code || '') < (b.drug_code || '') ? -1 : 1) : TODO_KINDS.indexOf(a.kind) - TODO_KINDS.indexOf(b.kind)));
}

// ---------- 主檔註記比對 ----------
export function parseCodeMap(text) {
  const map = {};
  for (const part of String(text || '').split(/[,，;；]+/)) {
    const m = part.split('=');
    if (m.length !== 2) continue;
    const k = m[0].trim();
    const v = m[1].trim();
    if (k && v) map[k] = v;
  }
  return map;
}

// rows：該主檔版本列（{byCode}）；必要藥品註記空白已於匯入時正規化為 0（一般藥品）
export function compareMaster(data, rows, day, settings) {
  const cmap = parseCodeMap(settings && settings.annotation_code_map);
  const rev = {};
  for (const [k, v] of Object.entries(cmap)) rev[v] = k;
  const codes = new Set(list(data, 'annotation_event').filter((e) => e.confirm_status === '已確認').map((e) => e.drug_code));
  for (const [c, d] of rows.byCode) if (d.annotation && rev[d.annotation]) codes.add(c);
  const out = [];
  for (const code of [...codes].sort()) {
    const st = annotationOn(data, code, day);
    const d = rows.byCode.get(code);
    const sys = st.category;
    let result;
    let detail;
    if (!d) { result = '無法判定'; detail = '主檔版本無此代碼（以來源涵蓋範圍判讀，不視為取消）'; }
    else if (d.annotation === undefined || d.annotation === null) { result = '無法判定'; detail = '主檔版本未映射必要藥品註記欄'; }
    else if (st.unknown_date && !sys) { result = '無法判定'; detail = '系統註記生效日未知'; }
    else {
      const raw = String(d.annotation); // 匯入時已正規化：空白＝0（一般藥品）
      const mcat = rev[raw] || null;
      if (!mcat && raw !== '0' && !['1', '2'].includes(raw)) { result = '無法判定'; detail = `必要藥品註記值 ${raw} 無對照設定`; }
      else if (sys && mcat) { result = cmap[sys] === raw ? '一致' : '類別不同'; detail = `系統：${sys}；主檔：${mcat}（${raw}）`; }
      else if (sys && !mcat) { result = '應有未有'; detail = `系統：${sys}；主檔必要藥品註記為 ${raw}`; }
      else if (!sys && mcat) { result = '主檔有但無完整依據'; detail = `主檔：${mcat}（${raw}）；系統無已確認註記`; }
      else { result = '一致'; detail = '皆無註記'; }
    }
    out.push({ drug_code: code, drug_name: d ? d.drug_name || null : null, result, detail, system_category: sys, master_raw: d ? d.annotation ?? null : null });
  }
  return out;
}

export function compareCounts(items) {
  const c = {};
  for (const it of items) c[it.result] = (c[it.result] || 0) + 1;
  return c;
}

// 不一致項目轉為差異待辦
export function mismatchTodos(items) {
  return items.filter((x) => x.result !== '一致').map((x) => ({ kind: '主檔註記不一致', drug_code: x.drug_code, revision_id: null, group_code: null, detail: `${x.result}：${x.detail}` }));
}

export function importLabel(data, importId) {
  const m = find(data, 'master_import', importId);
  return m ? `${m.base_date}（${m.source_name}）` : '';
}
