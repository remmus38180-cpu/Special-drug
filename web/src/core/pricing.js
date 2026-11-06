// 公告複核：合約、個別品項調高（price_action）、主檔註記事件（第9.2節、B03、B04、B08、B17、B18、M3、M4）。
// 認定範圍名單 ≠ 本次調高名單 ≠ 主檔註記名單：調高只能從已確認範圍名單勾選；只有實際調高的品項才註記。
// 系統登記確認不取代公文核定。函式皆於 session.run() 之資料副本上執行：fn(data, ctx)；任一驗證失敗即拋錯，整批不成立。
import { SpecError } from './errors.js';
import { E, insert, update, setConfirmStatus, setDedicated, find, must, list } from './model.js';
import { dateField, drugFollowupBasis } from './cases.js';
import { revisionScope, snapshotFinal } from './recognition.js';
import { normalizeCode, normalizeMoney } from './values.js';
import { canonical } from './rules.js';
import { storeBlob, addAttachmentRecord } from './attachments.js';

function txt(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function code(raw, label = '藥品代碼') {
  const { code: c, error } = normalizeCode(raw);
  if (error) throw new SpecError('BAD_CODE', `${label}錯誤：${error}`);
  return c;
}

function money(v, label) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const m = normalizeMoney(v);
  if (m === null) throw new SpecError('BAD_MONEY', `${label}「${v}」無法解析為金額`);
  return m;
}

function pick(input, keys) {
  const out = {};
  for (const k of Object.keys(input || {})) {
    if (!keys.includes(k)) throw new SpecError('FIELD_PROTECTED', `此功能不可設定欄位：${k}`);
    out[k] = input[k];
  }
  return out;
}

const DATE_LABEL = { signed_date: '簽訂日', effective_from: '生效日', expiry_date: '到期日', effective_to: '迄日', effective_date: '生效日', announce_date: '公告日期' };
function dates(obj) {
  for (const k of Object.keys(DATE_LABEL)) if (k in obj) obj[k] = dateField(obj[k], DATE_LABEL[k]);
  return obj;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

// ================= 合約 =================
export const CONTRACT_EDIT = ['contract_no', 'firm', 'signed_date', 'effective_from', 'expiry_date', 'doc_version', 'obligations', 'status'];

function checkSigned(rec) {
  if (rec.status === '完成簽署' && !rec.signed_date) throw new SpecError('REQUIRED', '合約「完成簽署」須填簽訂日');
}

// original_contract_id：補充協議／新版合約指向原合約，原件保留（T15）
export function createContract(data, ctx, input) {
  const { drugs = [], original_contract_id, ...rest } = input || {};
  const v = dates(pick(rest, CONTRACT_EDIT));
  if (!txt(v.contract_no)) throw new SpecError('REQUIRED', '請輸入合約編號');
  v.contract_no = txt(v.contract_no);
  checkSigned({ status: v.status || '辦理中', signed_date: v.signed_date });
  if (original_contract_id) must(data, 'contract', original_contract_id);
  const rec = insert(data, ctx, 'contract', { ...v, original_contract_id: original_contract_id || null });
  for (const d of drugs) {
    if (typeof d === 'string') addContractDrug(data, ctx, rec.id, d);
    else addContractDrug(data, ctx, rec.id, d.drug_code, d);
  }
  return rec;
}

export function addContractDrug(data, ctx, contractId, drugCode, { effective_from, effective_to } = {}) {
  must(data, 'contract', contractId);
  const c = code(drugCode);
  if (list(data, 'contract_drug').some((r) => r.contract_id === contractId && r.drug_code === c)) {
    throw new SpecError('DUPLICATE', `合約已含品項 ${c}`);
  }
  return insert(data, ctx, 'contract_drug', dates({ contract_id: contractId, drug_code: c, effective_from, effective_to }));
}

// 已確認調高引用之合約（Q11 暫採：可改，但列出受影響調高並須填原因）
export function contractAffected(data, contractId) {
  return list(data, 'price_action').filter((p) => p.contract_id === contractId && p.confirm_status === '已確認');
}

export function updateContract(data, ctx, id, changes, { expectedVersion, reason } = {}) {
  const v = dates(pick(changes, CONTRACT_EDIT));
  if ('contract_no' in v && !txt(v.contract_no)) throw new SpecError('REQUIRED', '請輸入合約編號');
  const cur = must(data, 'contract', id);
  checkSigned({ ...cur, ...v });
  const affected = contractAffected(data, id);
  if (affected.length && !txt(reason)) {
    throw new SpecError('NEED_REASON', `此合約已被 ${affected.length} 筆已確認調高引用（${affected.map((p) => p.drug_code).join('、')}），修改須填原因`, { affected: affected.map((p) => p.id) });
  }
  const r = txt(reason) ? (affected.length ? `${txt(reason)}（受影響調高：${affected.map((p) => p.drug_code).join('、')}）` : txt(reason)) : null;
  return update(data, ctx, 'contract', id, v, { expectedVersion, reason: r });
}

export function contractDrugs(data, contractId) {
  return list(data, 'contract_drug').filter((r) => r.contract_id === contractId).sort((a, b) => (a.drug_code < b.drug_code ? -1 : 1));
}

// 原合約及其後續補充協議／版本（T15）
export function contractChain(data, contractId) {
  let root = must(data, 'contract', contractId);
  const seen = new Set();
  while (root.original_contract_id && !seen.has(root.id)) { seen.add(root.id); root = must(data, 'contract', root.original_contract_id); }
  const out = [];
  const queue = [root];
  while (queue.length) {
    const c = queue.shift();
    const atts = list(data, 'attachment_link').filter((l) => l.entity === 'contract' && l.entity_id === c.id)
      .map((l) => find(data, 'attachment', l.attachment_id)).filter(Boolean).sort((a, b) => a.version - b.version);
    out.push({ ...c, drugs: contractDrugs(data, c.id), attachments: atts });
    queue.push(...list(data, 'contract').filter((x) => x.original_contract_id === c.id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)));
  }
  return out;
}

// 到期提醒：只提醒檢視，不自動取消認定、註記或價格（T20、B11）；無到期日不猜測
export function contractAlerts(data, day, withinDays = 60) {
  const limit = addDays(day, withinDays);
  return list(data, 'contract').filter((c) => c.status === '完成簽署' && c.expiry_date && c.expiry_date <= limit)
    .map((c) => ({ ...c, alert: c.expiry_date <= day ? '已到期' : '即將到期' }))
    .sort((a, b) => (a.expiry_date < b.expiry_date ? -1 : 1));
}

export function contractExpiryText(c, day) {
  if (!c.expiry_date) return '無到期日（不推定）';
  return c.expiry_date <= day ? '已到期' : '未到期';
}

export function listContracts(data, { keyword, drugCode } = {}) {
  const kw = txt(keyword);
  const dc = txt(drugCode);
  return list(data, 'contract').filter((c) => {
    if (dc && !contractDrugs(data, c.id).some((d) => d.drug_code === dc)) return false;
    if (!kw) return true;
    return [c.contract_no, c.firm, c.obligations, c.doc_version].some((x) => x && String(x).includes(kw)) ||
      contractDrugs(data, c.id).some((d) => d.drug_code.includes(kw));
  }).sort((a, b) => (a.contract_no < b.contract_no ? -1 : 1));
}

// ================= 調高 =================
// 一般修改白名單（M3）：確認狀態、確認者、revision_id、drug_code、snapshot_id、supersedes_id、建立者皆不可經此改
export const PA_EDIT = ['case_id', 'contract_requirement', 'requirement_basis', 'contract_id', 'price_before', 'price_after',
  'effective_date', 'announce_doc_no', 'announce_date', 'status', 'note'];

function snapshotOfCode(data, revId, drugCode) {
  const rev = must(data, 'recognition_revision', revId);
  const snaps = list(data, 'scope_snapshot').filter((s) => s.revision_id === revId && s.status === '已確認' && s.rule && rev.rule && canonical(s.rule) === canonical(rev.rule))
    .sort((a, b) => (a.confirmed_at < b.confirmed_at ? 1 : -1));
  for (const s of snaps) if (snapshotFinal(data, s.id).some((m) => m.drug_code === drugCode)) return s.id;
  return null;
}

function checkCaseBasis(data, caseId, drugCode) {
  if (!caseId) return;
  must(data, 'case_record', caseId);
  const inCase = list(data, 'case_drug').some((d) => d.case_id === caseId && d.drug_code === drugCode);
  if (inCase && !drugFollowupBasis(data, caseId, drugCode).length) {
    throw new SpecError('NO_BASIS', `${drugCode} 在此案件沒有「同意／附條件同意」的會議決議，不能接續調高`);
  }
}

function moneyFields(v) {
  if ('price_before' in v) v.price_before = money(v.price_before, '調高前價格');
  if ('price_after' in v) v.price_after = money(v.price_after, '調高後價格');
  return v;
}

// 從範圍名單勾選建立調高紀錄；範圍外品項不可直接勾入（§9.2-6、T08）
export function createPriceAction(data, ctx, input) {
  const { revision_id, drug_code, supersedes_id, ...rest } = input || {};
  const rev = must(data, 'recognition_revision', revision_id);
  if (rev.confirm_status === '撤銷') throw new SpecError('REVOKED', '認定版本已撤銷');
  if (rev.category === '取消認定') throw new SpecError('BAD_CATEGORY', '取消認定版本不可建立調高紀錄');
  const c = code(drug_code);
  if (!revisionScope(data, revision_id).has(c)) {
    throw new SpecError('OUT_OF_SCOPE', `${c} 不在此認定已確認的範圍名單內；範圍外品項不可直接勾入，須另補認定依據`);
  }
  const v = moneyFields(dates(pick(rest, PA_EDIT)));
  checkCaseBasis(data, v.case_id, c);
  if (v.contract_id) must(data, 'contract', v.contract_id);
  if (supersedes_id) {
    const old = must(data, 'price_action', supersedes_id);
    if (old.confirm_status !== '已確認') throw new SpecError('BAD_SUPERSEDE', '只能更正已確認之調高紀錄；未確認者請直接修改');
    if (old.drug_code !== c || old.revision_id !== revision_id) throw new SpecError('BAD_SUPERSEDE', '更正紀錄須與原紀錄同品項、同認定版本');
    if (list(data, 'price_action').some((p) => p.supersedes_id === supersedes_id && p.confirm_status !== '撤銷')) {
      throw new SpecError('DUPLICATE', '此調高紀錄已有更正紀錄');
    }
  }
  return insert(data, ctx, 'price_action', {
    ...v, revision_id, drug_code: c, snapshot_id: snapshotOfCode(data, revision_id, c), supersedes_id: supersedes_id || null,
  }, { action: supersedes_id ? '新增（更正）' : '新增' });
}

export function createPriceActions(data, ctx, revisionId, codes, common = {}) {
  const uniq = [...new Set(codes)];
  if (!uniq.length) throw new SpecError('REQUIRED', '請勾選本次調高品項');
  return uniq.map((c) => createPriceAction(data, ctx, { ...common, revision_id: revisionId, drug_code: c }));
}

export function updatePriceAction(data, ctx, id, changes, { expectedVersion } = {}) {
  const v = moneyFields(dates(pick(changes, PA_EDIT)));
  const pa = must(data, 'price_action', id);
  if ('case_id' in v) checkCaseBasis(data, v.case_id, pa.drug_code);
  if (v.contract_id) must(data, 'contract', v.contract_id);
  return update(data, ctx, 'price_action', id, v, { expectedVersion });
}

export function submitPriceAction(data, ctx, id) {
  return setConfirmStatus(data, ctx, 'price_action', id, '待確認');
}

export function withdrawPriceAction(data, ctx, id, reason) {
  const pa = must(data, 'price_action', id);
  if (pa.confirm_status === '已確認') throw new SpecError('CONFIRMED_READONLY', '已確認之調高紀錄不可撤銷；請新增更正紀錄');
  for (const a of list(data, 'annotation_event')) {
    if (a.price_action_id === id && (a.confirm_status === '草稿' || a.confirm_status === '待確認')) {
      setConfirmStatus(data, ctx, 'annotation_event', a.id, '撤銷', { reason: `連結之調高紀錄撤銷：${txt(reason) || ''}` });
    }
  }
  return setConfirmStatus(data, ctx, 'price_action', id, '撤銷', { reason });
}

// 合約涵蓋：完成簽署且合約品項含此代碼；不檢查合約及品項起訖是否涵蓋調高生效日（B18）
export function contractCovers(data, contractId, drugCode) {
  return list(data, 'contract_drug').some((r) => r.contract_id === contractId && r.drug_code === drugCode);
}

// 逐項驗證錯誤；空陣列代表可確認
export function validatePriceAction(data, pa) {
  const errs = [];
  const rev = find(data, 'recognition_revision', pa.revision_id);
  if (!rev || rev.confirm_status !== '已確認') errs.push('認定版本尚未確認');
  else if (!revisionScope(data, pa.revision_id).has(pa.drug_code)) errs.push('品項不在已確認範圍名單內');
  if (pa.status !== '已核定') errs.push('辦理狀態尚非「已核定」（請於核定後補正式文號、日期）');
  if (!pa.announce_doc_no || !pa.announce_date) errs.push('缺正式公告文號或日期');
  if (!pa.effective_date) errs.push('缺調高生效日');
  if (pa.price_after === null || pa.price_after === undefined) errs.push('缺調高後價格');
  if (pa.contract_requirement === '須簽約') {
    if (!pa.contract_id) errs.push('須簽約但未對應合約（缺件）');
    else {
      const c = find(data, 'contract', pa.contract_id);
      if (!c) errs.push('對應合約不存在（缺件）');
      else if (c.status !== '完成簽署') errs.push(`對應合約狀態為「${c.status}」，未完成簽署（缺件）`);
      else if (!contractCovers(data, c.id, pa.drug_code)) errs.push('對應合約之適用品項未含此代碼（缺件）');
    }
  } else if (pa.contract_requirement === '當時無須簽約') {
    if (!txt(pa.requirement_basis)) errs.push('選「當時無須簽約」須填說明／依據');
  }
  // 「待確認」：不以案件來源限制確認，由確認者依個案判斷；確認時標示「不完整」（B17）
  return errs;
}

// ================= 註記 =================
export const ANNOT_EDIT = ['category', 'effective_date', 'basis'];

export function createAnnotation(data, ctx, input) {
  const { drug_code, action, category, revision_id, price_action_id, effective_date, basis, original_event_id } = input || {};
  const c = code(drug_code);
  if (!E.ANNOTATION_ACTION.includes(action)) throw new SpecError('BAD_VALUE', '註記動作不正確');
  let revId = revision_id || null;
  if (action === '新增' || action === '改類') {
    if (!price_action_id) throw new SpecError('NO_PRICE_ACTION', '只有實際調高的個別品項才註記：新增／改類須連結調高紀錄（B03）');
    const pa = must(data, 'price_action', price_action_id);
    if (pa.drug_code !== c) throw new SpecError('MISMATCH', '調高紀錄與註記品項不一致');
    if (pa.confirm_status === '撤銷') throw new SpecError('REVOKED', '連結之調高紀錄已撤銷');
    if (!category) throw new SpecError('REQUIRED', '請選註記類別');
    revId = revId || pa.revision_id;
  }
  if ((action === '取消' || action === '更正') && !txt(basis)) throw new SpecError('REQUIRED', '取消或更正註記須填依據；不自動批次取消（Q07）');
  if (action === '更正') {
    if (!original_event_id) throw new SpecError('REQUIRED', '更正須指定原註記事件');
    const o = must(data, 'annotation_event', original_event_id);
    if (o.drug_code !== c) throw new SpecError('MISMATCH', '原註記事件與品項不一致');
    if (o.confirm_status !== '已確認') throw new SpecError('BAD_SUPERSEDE', '只能更正已確認之註記事件');
  }
  if (revId) must(data, 'recognition_revision', revId);
  return insert(data, ctx, 'annotation_event', dates({
    drug_code: c, action, category: category || null, revision_id: revId, price_action_id: price_action_id || null,
    effective_date, basis: txt(basis), original_event_id: original_event_id || null,
  }));
}

export function updateAnnotation(data, ctx, id, changes, { expectedVersion } = {}) {
  return update(data, ctx, 'annotation_event', id, dates(pick(changes, ANNOT_EDIT)), { expectedVersion });
}

export function submitAnnotation(data, ctx, id) {
  return setConfirmStatus(data, ctx, 'annotation_event', id, '待確認');
}

export function withdrawAnnotation(data, ctx, id, reason) {
  const a = must(data, 'annotation_event', id);
  if (a.confirm_status === '已確認') throw new SpecError('CONFIRMED_READONLY', '已確認之註記事件不可撤銷；請以「取消」或「更正」事件辦理');
  return setConfirmStatus(data, ctx, 'annotation_event', id, '撤銷', { reason });
}

export function validateAnnotation(data, ev, confirmingPaIds = []) {
  const errs = [];
  if (!ev.effective_date) errs.push('缺註記生效日');
  if (ev.action === '新增' || ev.action === '改類') {
    const pa = find(data, 'price_action', ev.price_action_id);
    if (!pa || pa.confirm_status === '撤銷') errs.push('連結的調高紀錄不存在或已撤銷');
    else if (pa.confirm_status !== '已確認' && !confirmingPaIds.includes(pa.id)) errs.push('連結的調高紀錄尚未確認（請一併確認）');
  }
  return errs;
}

// ================= 確認公告（整批） =================
// 任一驗證失敗整批不成立；op_id 由 session.run 處理（T17）
export function confirmAnnouncement(data, ctx, { priceActionIds = [], annotationIds = [] } = {}) {
  if (!priceActionIds.length && !annotationIds.length) throw new SpecError('REQUIRED', '請選擇要確認的調高或註記');
  const errors = [];
  const pas = priceActionIds.map((id) => must(data, 'price_action', id));
  const evs = annotationIds.map((id) => must(data, 'annotation_event', id));
  for (const pa of pas) {
    if (pa.confirm_status === '已確認') continue;
    if (pa.confirm_status === '撤銷') { errors.push(`調高 ${pa.drug_code}：已撤銷`); continue; }
    const e = validatePriceAction(data, pa);
    if (e.length) errors.push(`調高 ${pa.drug_code}：${e.join('、')}`);
  }
  for (const ev of evs) {
    if (ev.confirm_status === '已確認') continue;
    if (ev.confirm_status === '撤銷') { errors.push(`註記 ${ev.drug_code}：已撤銷`); continue; }
    const e = validateAnnotation(data, ev, priceActionIds);
    if (e.length) errors.push(`註記 ${ev.drug_code}（${ev.action}）：${e.join('、')}`);
  }
  if (errors.length) throw new SpecError('VALIDATION', `驗證未通過，整批未確認：${errors.join('；')}`, { errors });
  const incomplete = [];
  for (const pa of pas) {
    if (pa.confirm_status === '已確認') continue;
    if (pa.contract_requirement === '待確認') {
      setDedicated(data, ctx, 'price_action', pa.id, { completeness: '不完整' }, { action: '標示不完整（簽約要求待確認，B17）', fields: ['completeness'] });
      incomplete.push(pa.drug_code);
    }
    setConfirmStatus(data, ctx, 'price_action', pa.id, '已確認');
  }
  for (const ev of evs) if (ev.confirm_status !== '已確認') setConfirmStatus(data, ctx, 'annotation_event', ev.id, '已確認');
  return { price_actions: priceActionIds.slice(), annotations: annotationIds.slice(), incomplete };
}

// ================= 查詢 =================
function supersededSet(data) {
  return new Set(list(data, 'price_action').filter((p) => p.supersedes_id && p.confirm_status === '已確認').map((p) => p.supersedes_id));
}

// 品項之調高歷程（已確認者；被更正取代者標示）
export function priceHistory(data, drugCode) {
  const rep = supersededSet(data);
  return list(data, 'price_action').filter((p) => p.drug_code === drugCode)
    .map((p) => ({ ...p, superseded: rep.has(p.id) }))
    .sort((a, b) => ((a.effective_date || '') + a.created_at < (b.effective_date || '') + b.created_at ? -1 : 1));
}

// 依已確認註記事件計算指定日期之註記類別
export function annotationOn(data, drugCode, day) {
  const evs = list(data, 'annotation_event').filter((e) => e.drug_code === drugCode && e.confirm_status === '已確認')
    .sort((a, b) => ((a.effective_date || '') + a.created_at < (b.effective_date || '') + b.created_at ? -1 : 1));
  const corrected = new Map();
  for (const e of evs) if (e.action === '更正') corrected.set(e.original_event_id, e);
  let category = null;
  let unknownDate = false;
  let pendingFuture = null;
  for (const e of evs) {
    if (e.action === '更正') continue;
    const eff = corrected.get(e.id) || e;
    const effDate = eff.effective_date || e.effective_date;
    if (!effDate) { unknownDate = true; continue; }
    if (effDate > day) { if (!pendingFuture) pendingFuture = { action: e.action, category: eff.category || e.category, effective_date: effDate }; continue; }
    if (e.action === '新增' || e.action === '改類') category = eff.category || e.category;
    else if (e.action === '取消') category = null;
  }
  return { category, unknown_date: unknownDate, upcoming: pendingFuture };
}

export function annotationHistory(data, drugCode) {
  return list(data, 'annotation_event').filter((e) => e.drug_code === drugCode)
    .sort((a, b) => ((a.effective_date || '') + a.created_at < (b.effective_date || '') + b.created_at ? -1 : 1));
}

// 調高選取用：版本範圍名單，標示已有調高紀錄者
export function scopeCandidates(data, revId) {
  const scope = [...revisionScope(data, revId)].sort();
  const pas = list(data, 'price_action').filter((p) => p.revision_id === revId && p.confirm_status !== '撤銷');
  return scope.map((c) => ({ drug_code: c, actions: pas.filter((p) => p.drug_code === c) }));
}

export function listPriceActions(data, { revisionId, caseId, confirm, drugCode } = {}) {
  const rep = supersededSet(data);
  return list(data, 'price_action').filter((p) => (!revisionId || p.revision_id === revisionId) && (!caseId || p.case_id === caseId) &&
    (!confirm || p.confirm_status === confirm) && (!drugCode || p.drug_code === drugCode))
    .map((p) => ({ ...p, superseded: rep.has(p.id) }))
    .sort((a, b) => (a.drug_code === b.drug_code ? (a.created_at < b.created_at ? -1 : 1) : a.drug_code < b.drug_code ? -1 : 1));
}

export function listAnnotations(data, { revisionId, priceActionId, confirm } = {}) {
  return list(data, 'annotation_event').filter((a) => (!revisionId || a.revision_id === revisionId) &&
    (!priceActionId || a.price_action_id === priceActionId) && (!confirm || a.confirm_status === confirm))
    .sort((a, b) => (a.drug_code === b.drug_code ? (a.created_at < b.created_at ? -1 : 1) : a.drug_code < b.drug_code ? -1 : 1));
}

// ================= 附件（先寫入並讀回驗雜湊，再於同一批成立紀錄；附件失敗則整批不成立，T18） =================
async function storeFiles(session, files) {
  if (session.mode !== 'edit') throw new SpecError('NOT_EDITING', '目前為查詢模式，請先取得編輯牌');
  const stored = [];
  for (const f of files || []) stored.push({ ...f, ...(await storeBlob(session.fs, f.bytes)) });
  return stored;
}

function refsOf(stored, label) {
  return stored.map((s) => ({ path: s.path, sha256: s.sha256, label: `${label} ${s.name}` }));
}

// 公告確認（可附公告文件）；整批成立或整批不成立
export async function confirmAnnouncementWithFiles(session, sel, files = [], { opId } = {}) {
  const stored = await storeFiles(session, files);
  return session.run((d, ctx) => {
    const r = confirmAnnouncement(d, ctx, sel);
    const links = sel.priceActionIds && sel.priceActionIds.length ? sel.priceActionIds.map((id) => ({ entity: 'price_action', entity_id: id })) : [];
    for (const s of stored) addAttachmentRecord(d, ctx, { orig_name: s.name, sha256: s.sha256, size: s.size, mime: s.mime || null }, links);
    return { ...r, attachments: stored.length };
  }, { opId, kind: '確認公告', refs: refsOf(stored, '公告附件') });
}

// 合約、調高等附件上傳（原件保留；同名再上傳版本＋1）
export async function attachFiles(session, entity, entityId, files, { opId } = {}) {
  if (!files || !files.length) throw new SpecError('REQUIRED', '請選擇檔案');
  const stored = await storeFiles(session, files);
  return session.run((d, ctx) => {
    must(d, entity, entityId);
    return stored.map((s) => addAttachmentRecord(d, ctx, { orig_name: s.name, sha256: s.sha256, size: s.size, mime: s.mime || null }, [{ entity, entity_id: entityId }]).id);
  }, { opId, kind: '上傳附件', refs: refsOf(stored, '附件') });
}

export function attachmentsOf(data, entity, entityId) {
  return list(data, 'attachment_link').filter((l) => l.entity === entity && l.entity_id === entityId)
    .map((l) => find(data, 'attachment', l.attachment_id)).filter(Boolean).sort((a, b) => (a.orig_name === b.orig_name ? a.version - b.version : a.orig_name < b.orig_name ? -1 : 1));
}
