// 資料模型（第6節）：集合欄位定義、狀態值域、通用建立／修改函式（欄位白名單，第11.4節）、
// 確認／撤銷專責函式、操作id、整體一致性檢查。純函式，操作傳入之 data 物件。
import { SpecError } from './errors.js';
import { normalizeMoney, isIsoDate, normalizeCode } from './values.js';

// ---------- 狀態值域（第6.3節） ----------
export const E = {
  CASE_STATUS: ['辦理中', '待補件', '待提會', '待後續辦理', '已結案', '撤回'],
  RESULT: ['同意', '不同意', '附條件同意', '補充資料後再議', '暫緩', '其他', '待確認'],
  SUMMARY: ['尚無結論', '全部同意', '部分同意', '全部不同意', '撤回', '其他'],
  MEETING_TYPE: ['專家', '藥事小組', '共同擬訂', '其他'],
  NATURE: ['專家建議', '會議決議'],
  CONFIRM: ['草稿', '待確認', '已確認', '撤銷'],
  COMPLETENESS: ['完整', '不完整', '待確認'],
  CONTRACT_REQ: ['須簽約', '當時無須簽約', '待確認'],
  CONTRACT_STATUS: ['辦理中', '完成簽署', '終止'],
  PRICE_STATUS: ['未辦', '辦理中', '已核定', '撤回／取消'],
  ANNOTATION_ACTION: ['新增', '改類', '取消', '更正'],
  // B16：系統類別選項只列現行名稱
  CATEGORY: ['不可替代特殊藥品', '特殊藥品'],
  METHOD: ['DET', '第25條', '待確認'],
  IMPORT_STATUS: ['試匯入', '已啟用', '已停用', '失敗'],
  SNAPSHOT_STATUS: ['預覽', '已確認', '撤銷'],
  EVAL: ['符合', '待確認'],
  MANUAL: ['納入', '排除'],
  REVIEW_STATUS: ['待處理', '已處理', '不處理'],
  MIGRATION_STATUS: ['待核對', '已寫入', '略過'],
  LINK_ENTITY: ['case_record', 'meeting', 'meeting_agenda', 'decision', 'contract', 'recognition_revision', 'price_action', 'master_import', 'migration_batch'],
  ANNOTATION_COMPARE: ['一致', '應有未有', '主檔有但無完整依據', '類別不同', '無法判定'],
};

// 共通欄位：一律由建立／修改函式設定
const COMMON = ['id', 'created_by', 'created_at', 'updated_by', 'updated_at', 'row_version'];
// 只能由對應的建立或確認函式設定（第11.4節第1點）
export const PROTECTED = new Set([...COMMON, 'confirm_status', 'confirmed_by', 'confirmed_at']);

// 欄位定義：t＝型別（text、date、money、int、bool、json、code、enum、ref）；
// e＝值域；r＝參照集合；req＝必填；fix＝建立後不可改；edit:false＝一般修改函式不可改（有專責函式）
const F = (t, o = {}) => ({ t, ...o });

export const SCHEMA = {
  case_record: {
    label: '案件',
    unique: [['case_no']],
    fields: {
      case_no: F('text', { req: true, fix: true }),
      recv_date: F('date'), recv_doc_no: F('text'), subject: F('text', { req: true }), applicant: F('text'),
      request_item: F('text'), unit: F('text'), handler: F('text'),
      status: F('enum', { e: E.CASE_STATUS, def: '辦理中' }),
      result_summary: F('enum', { e: E.SUMMARY, def: '尚無結論', edit: false }),
      result_summary_note: F('text', { edit: false }),
      result_decision_ids: F('json', { edit: false }),
      result_confirmed_by: F('text', { edit: false }), result_confirmed_at: F('text', { edit: false }),
      completeness: F('enum', { e: E.COMPLETENESS, def: '完整' }), pending_fields: F('text'),
      close_reason: F('text', { edit: false }), close_basis: F('text', { edit: false }),
      prior_case_id: F('ref', { r: 'case_record', fix: true }),
      source_ref: F('text'), notes: F('text'),
    },
  },
  case_drug: {
    label: '案件品項',
    unique: [['case_id', 'drug_code']],
    fields: {
      case_id: F('ref', { r: 'case_record', req: true, fix: true }),
      drug_code: F('code', { req: true, fix: true }),
      drug_name_text: F('text'), role: F('text', { def: '申請品項' }), note: F('text'),
    },
  },
  meeting: {
    label: '會議',
    fields: {
      meeting_type: F('enum', { e: E.MEETING_TYPE, req: true }), name: F('text', { req: true }),
      meeting_date: F('date'), session_no: F('text'), notes: F('text'),
    },
  },
  meeting_agenda: {
    label: '議案',
    fields: {
      meeting_id: F('ref', { r: 'meeting', req: true }),
      case_id: F('ref', { r: 'case_record', req: true, fix: true }),
      agenda_no: F('text'), subject: F('text'), proposal: F('text'), discussion: F('text'), original_text: F('text'),
    },
  },
  decision: {
    label: '決議',
    fields: {
      agenda_id: F('ref', { r: 'meeting_agenda', req: true, fix: true }),
      nature: F('enum', { e: E.NATURE, req: true }),
      result: F('enum', { e: E.RESULT, req: true }),
      result_text: F('text'), conditions: F('text'), approval_doc_no: F('text'), approval_date: F('date'),
      supersedes_id: F('ref', { r: 'decision', fix: true }), correction_reason: F('text', { fix: true }),
    },
    check: (r) => (r.result === '其他' && !(r.result_text && String(r.result_text).trim()) ? '結果為「其他」須填結果原文說明' : null),
  },
  decision_drug: {
    label: '決議品項結果',
    unique: [['decision_id', 'case_drug_id']],
    fields: {
      decision_id: F('ref', { r: 'decision', req: true, fix: true }),
      case_drug_id: F('ref', { r: 'case_drug', req: true, fix: true }),
      result: F('enum', { e: E.RESULT, req: true }), conditions: F('text'), note: F('text'),
    },
    check: (r) => (r.result === '其他' && !(r.note && String(r.note).trim()) ? '品項結果為「其他」須填說明' : null),
  },
  recognition: {
    label: '認定項目',
    unique: [['recognition_no']],
    fields: {
      recognition_no: F('text', { req: true, fix: true }), name: F('text', { req: true }), unit: F('text'), description: F('text'),
    },
  },
  recognition_revision: {
    label: '認定版本',
    confirmable: true,
    unique: [['recognition_id', 'revision_no']],
    fields: {
      recognition_id: F('ref', { r: 'recognition', req: true, fix: true }),
      revision_no: F('int', { req: true, fix: true }),
      category: F('enum', { e: E.CATEGORY }), original_category: F('text', { fix: true }),
      scope_text: F('text'), rule: F('json'), conditions_text: F('text'),
      effective_from: F('date'), effective_to: F('date'),
      decision_id: F('ref', { r: 'decision' }), case_id: F('ref', { r: 'case_record' }),
      supersedes_id: F('ref', { r: 'recognition_revision', fix: true }), correction_reason: F('text', { fix: true }),
      completeness: F('enum', { e: E.COMPLETENESS, def: '完整' }),
      confirm_status: F('enum', { e: E.CONFIRM, def: '草稿' }), confirmed_by: F('text'), confirmed_at: F('text'),
      revoke_reason: F('text', { edit: false }),
    },
  },
  revision_decision: {
    label: '認定依據',
    unique: [['revision_id', 'decision_id', 'link_type']],
    fields: {
      revision_id: F('ref', { r: 'recognition_revision', req: true, fix: true }),
      decision_id: F('ref', { r: 'decision', req: true, fix: true }),
      link_type: F('text', { def: '依據', fix: true }),
    },
  },
  master_import: {
    label: '主檔匯入',
    fields: {
      kind: F('text', { def: 'drug', fix: true }), source_name: F('text', { req: true, fix: true }),
      sha256: F('text', { req: true, fix: true }), base_date: F('date'), sheet: F('text', { fix: true }),
      header_row: F('int', { fix: true }), mapping: F('json', { fix: true }), row_count: F('int', { fix: true }),
      check: F('json', { fix: true }), rows_file: F('text', { fix: true }), rows_sha256: F('text', { fix: true }),
      status: F('enum', { e: E.IMPORT_STATUS, req: true, edit: false }),
      activated_by: F('text', { edit: false }), activated_at: F('text', { edit: false }), note: F('text'),
    },
  },
  scope_snapshot: {
    label: '範圍快照',
    fields: {
      revision_id: F('ref', { r: 'recognition_revision', req: true, fix: true }),
      import_id: F('ref', { r: 'master_import', req: true, fix: true }),
      rule_hash: F('text', { req: true, fix: true }), rule: F('json', { fix: true }),
      evaluated_at: F('text', { fix: true }), match_count: F('int', { fix: true }), pending_count: F('int', { fix: true }),
      status: F('enum', { e: E.SNAPSHOT_STATUS, def: '預覽', edit: false }),
      confirmed_by: F('text'), confirmed_at: F('text'), note: F('text'),
    },
  },
  scope_member: {
    label: '範圍名單',
    unique: [['snapshot_id', 'drug_code']],
    fields: {
      snapshot_id: F('ref', { r: 'scope_snapshot', req: true, fix: true }), drug_code: F('code', { req: true, fix: true }),
      eval_result: F('enum', { e: E.EVAL, req: true, fix: true }), path: F('text', { fix: true }),
      manual_result: F('enum', { e: E.MANUAL }), manual_reason: F('text'),
      group_code: F('text', { fix: true }), source_row: F('int', { fix: true }),
    },
  },
  group_treatment: {
    label: '分組調價方式',
    confirmable: true,
    fields: {
      group_code: F('code', { req: true, fix: true }), revision_id: F('ref', { r: 'recognition_revision', fix: true }),
      method: F('enum', { e: E.METHOD, req: true }), partial_cover: F('bool', { def: false }),
      effective_from: F('date'), effective_to: F('date'), basis: F('text'),
      confirm_status: F('enum', { e: E.CONFIRM, def: '草稿' }), confirmed_by: F('text'), confirmed_at: F('text'),
      revoke_reason: F('text', { edit: false }),
    },
  },
  contract: {
    label: '合約',
    fields: {
      contract_no: F('text', { req: true }), firm: F('text'), signed_date: F('date'), effective_from: F('date'),
      expiry_date: F('date'), doc_version: F('text'), obligations: F('text'),
      status: F('enum', { e: E.CONTRACT_STATUS, def: '辦理中' }),
      original_contract_id: F('ref', { r: 'contract', fix: true }),
    },
  },
  contract_drug: {
    label: '合約品項',
    unique: [['contract_id', 'drug_code']],
    fields: {
      contract_id: F('ref', { r: 'contract', req: true, fix: true }), drug_code: F('code', { req: true, fix: true }),
      effective_from: F('date'), effective_to: F('date'),
    },
  },
  price_action: {
    label: '調高紀錄',
    confirmable: true,
    fields: {
      case_id: F('ref', { r: 'case_record' }),
      drug_code: F('code', { req: true, fix: true }),
      revision_id: F('ref', { r: 'recognition_revision', req: true, fix: true }),
      snapshot_id: F('ref', { r: 'scope_snapshot', fix: true }),
      contract_requirement: F('enum', { e: E.CONTRACT_REQ, def: '待確認' }), requirement_basis: F('text'),
      contract_id: F('ref', { r: 'contract' }),
      price_before: F('money'), price_after: F('money'), effective_date: F('date'),
      announce_doc_no: F('text'), announce_date: F('date'),
      status: F('enum', { e: E.PRICE_STATUS, def: '未辦' }),
      completeness: F('enum', { e: E.COMPLETENESS, def: '完整' }),
      supersedes_id: F('ref', { r: 'price_action', fix: true }),
      confirm_status: F('enum', { e: E.CONFIRM, def: '草稿' }), confirmed_by: F('text'), confirmed_at: F('text'),
      revoke_reason: F('text', { edit: false }), note: F('text'),
    },
  },
  annotation_event: {
    label: '註記事件',
    confirmable: true,
    fields: {
      drug_code: F('code', { req: true, fix: true }),
      revision_id: F('ref', { r: 'recognition_revision', fix: true }),
      price_action_id: F('ref', { r: 'price_action', fix: true }),
      category: F('enum', { e: E.CATEGORY }),
      action: F('enum', { e: E.ANNOTATION_ACTION, req: true, fix: true }),
      effective_date: F('date'), basis: F('text'),
      original_event_id: F('ref', { r: 'annotation_event', fix: true }),
      confirm_status: F('enum', { e: E.CONFIRM, def: '草稿' }), confirmed_by: F('text'), confirmed_at: F('text'),
      revoke_reason: F('text', { edit: false }),
    },
  },
  attachment: {
    label: '附件',
    fields: {
      orig_name: F('text', { req: true, fix: true }), storage_key: F('text', { req: true, fix: true }),
      sha256: F('text', { req: true, fix: true }), size: F('int', { req: true, fix: true }), mime: F('text', { fix: true }),
      version: F('int', { def: 1, fix: true }),
    },
  },
  attachment_link: {
    label: '附件關聯',
    unique: [['attachment_id', 'entity', 'entity_id']],
    fields: {
      attachment_id: F('ref', { r: 'attachment', req: true, fix: true }),
      entity: F('enum', { e: E.LINK_ENTITY, req: true, fix: true }), entity_id: F('text', { req: true, fix: true }),
    },
  },
  op_log: {
    label: '操作紀錄',
    unique: [['op_id']],
    fields: { op_id: F('text', { req: true, fix: true }), kind: F('text', { fix: true }), result: F('json', { fix: true }) },
  },
  review_item: {
    label: '差異待辦',
    fields: {
      kind: F('text', { req: true, fix: true }), drug_code: F('code', { fix: true }), group_code: F('code', { fix: true }),
      revision_id: F('ref', { r: 'recognition_revision', fix: true }), import_id: F('ref', { r: 'master_import', fix: true }),
      detail: F('text', { fix: true }), status: F('enum', { e: E.REVIEW_STATUS, def: '待處理' }), conclusion: F('text'),
    },
  },
  migration_batch: {
    label: '移轉批次',
    fields: {
      source_name: F('text', { req: true, fix: true }), sha256: F('text', { req: true, fix: true }),
      sheet: F('text', { req: true, fix: true }), row_count: F('int', { fix: true }),
    },
  },
  migration_row: {
    label: '移轉列',
    unique: [['source_sha256', 'sheet', 'row_no']],
    fields: {
      batch_id: F('ref', { r: 'migration_batch', req: true, fix: true }), source_sha256: F('text', { req: true, fix: true }),
      sheet: F('text', { req: true, fix: true }), row_no: F('int', { req: true, fix: true }),
      raw: F('json', { req: true, fix: true }), parsed: F('json'), issues: F('json'),
      status: F('enum', { e: E.MIGRATION_STATUS, def: '待核對', edit: false }),
      committed_case_id: F('ref', { r: 'case_record', edit: false }), committed_recognition_id: F('ref', { r: 'recognition', edit: false }),
      decided_by: F('text', { edit: false }), decided_at: F('text', { edit: false }),
    },
  },
};

// ---------- 操作情境 ----------
// ctx：{actor:'員編／電腦', now:'ISO', newId:()=>uuid, events:[]}（events 由 session 轉為稽核紀錄）
export function actorText(session) {
  return `${session.user}／${session.pc}`;
}

function schemaOf(coll) {
  const s = SCHEMA[coll];
  if (!s) throw new SpecError('NO_COLLECTION', `未知的資料集合：${coll}`);
  return s;
}

export function list(data, coll) {
  schemaOf(coll);
  return data.collections[coll] || (data.collections[coll] = []);
}

export function find(data, coll, id) {
  return list(data, coll).find((r) => r.id === id) || null;
}

export function must(data, coll, id) {
  const r = find(data, coll, id);
  if (!r) throw new SpecError('NOT_FOUND', `找不到${schemaOf(coll).label}（${id}）`);
  return r;
}

// 單一欄位值檢查與正規化
function coerce(coll, name, def, v) {
  const label = `${schemaOf(coll).label}.${name}`;
  if (v === undefined || v === null || v === '') return def.t === 'bool' ? !!v : null;
  switch (def.t) {
    case 'text': return String(v);
    case 'date': {
      if (!isIsoDate(v)) throw new SpecError('BAD_VALUE', `${label} 日期須為 YYYY-MM-DD：${v}`);
      return v;
    }
    case 'money': {
      const m = normalizeMoney(v);
      if (m === null) throw new SpecError('BAD_VALUE', `${label} 金額格式錯誤：${v}`);
      return m;
    }
    case 'int': {
      if (!Number.isInteger(v)) throw new SpecError('BAD_VALUE', `${label} 須為整數：${v}`);
      return v;
    }
    case 'bool': return !!v;
    case 'json': return JSON.parse(JSON.stringify(v));
    case 'code': {
      const { code, error } = normalizeCode(v);
      if (error) throw new SpecError('BAD_CODE', `${label}：${error}`);
      return code;
    }
    case 'enum': {
      if (!def.e.includes(v)) throw new SpecError('BAD_VALUE', `${label} 須為：${def.e.join('／')}（收到「${v}」）`);
      return v;
    }
    case 'ref': return String(v);
    default: throw new SpecError('BAD_SCHEMA', `未知型別 ${def.t}`);
  }
}

function checkRef(data, coll, name, def, v) {
  if (def.t === 'ref' && v !== null && !find(data, def.r, v)) {
    throw new SpecError('BAD_REF', `${schemaOf(coll).label}.${name} 參照之${schemaOf(def.r).label}不存在（${v}）`);
  }
}

function checkUnique(data, coll, rec) {
  for (const keys of schemaOf(coll).unique || []) {
    const dup = list(data, coll).find((r) => r.id !== rec.id && keys.every((k) => r[k] === rec[k]));
    if (dup) throw new SpecError('DUPLICATE', `${schemaOf(coll).label}重複：${keys.map((k) => `${k}=${rec[k]}`).join('、')}`);
  }
}

function diffOf(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (k === 'row_version' || k === 'updated_at' || k === 'updated_by') continue;
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a === undefined ? null : a, to: b === undefined ? null : b };
  }
  return out;
}

function emit(ctx, coll, id, action, diff, reason) {
  ctx.events.push({ entity: coll, entity_id: id, action, diff, reason: reason || null, op_id: ctx.opId || null });
}

// 建立：保護欄位不得由呼叫端給；確認狀態一律從預設（草稿）開始
export function insert(data, ctx, coll, values, { reason, action } = {}) {
  const s = schemaOf(coll);
  const rec = { id: ctx.newId() };
  for (const k of Object.keys(values)) {
    if (PROTECTED.has(k)) throw new SpecError('FIELD_PROTECTED', `${s.label}：欄位 ${k} 只能由專責函式設定`);
    if (!s.fields[k]) throw new SpecError('FIELD_UNKNOWN', `${s.label} 無欄位：${k}`);
  }
  for (const [name, def] of Object.entries(s.fields)) {
    if (name === 'confirmed_by' || name === 'confirmed_at') { rec[name] = null; continue; }
    const v = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : def.def;
    rec[name] = coerce(coll, name, def, v);
    if (def.req && (rec[name] === null || rec[name] === '')) throw new SpecError('REQUIRED', `${s.label}：${name} 必填`);
    checkRef(data, coll, name, def, rec[name]);
  }
  if (s.check) { const m = s.check(rec); if (m) throw new SpecError('BAD_VALUE', `${s.label}：${m}`); }
  rec.created_by = ctx.actor;
  rec.created_at = ctx.now;
  rec.updated_by = ctx.actor;
  rec.updated_at = ctx.now;
  rec.row_version = 1;
  checkUnique(data, coll, rec);
  list(data, coll).push(rec);
  emit(ctx, coll, rec.id, action || '新增', diffOf(null, rec), reason);
  return rec;
}

// 一般修改函式：欄位白名單；保護欄位、建立後不可改欄位、專責欄位一律拒絕；已確認或撤銷之資料無修改入口
export function update(data, ctx, coll, id, changes, { expectedVersion, reason, allow } = {}) {
  const s = schemaOf(coll);
  const rec = must(data, coll, id);
  if (expectedVersion !== undefined && expectedVersion !== null && rec.row_version !== expectedVersion) {
    throw new SpecError('VERSION_CONFLICT', '資料已被更新（版本不符），請重新載入核對後再修改；本次修改未寫入');
  }
  if (s.fields.confirm_status && (rec.confirm_status === '已確認' || rec.confirm_status === '撤銷')) {
    throw new SpecError('CONFIRMED_READONLY', `${s.label}已${rec.confirm_status}，不可修改；更正請建立新版本或取代紀錄`);
  }
  const allowSet = new Set(allow || []);
  const before = { ...rec };
  const next = { ...rec };
  for (const [k, v] of Object.entries(changes)) {
    const def = s.fields[k];
    if (PROTECTED.has(k)) throw new SpecError('FIELD_PROTECTED', `${s.label}：欄位 ${k} 不得經一般修改函式改變`);
    if (!def) throw new SpecError('FIELD_UNKNOWN', `${s.label} 無欄位：${k}`);
    if (def.fix) throw new SpecError('FIELD_FIXED', `${s.label}：欄位 ${k} 建立後不可修改；如需改，請撤銷後重建`);
    if (def.edit === false && !allowSet.has(k)) throw new SpecError('FIELD_PROTECTED', `${s.label}：欄位 ${k} 須以專責功能修改`);
    next[k] = coerce(coll, k, def, v);
    if (def.req && (next[k] === null || next[k] === '')) throw new SpecError('REQUIRED', `${s.label}：${k} 必填`);
    checkRef(data, coll, k, def, next[k]);
  }
  if (s.check) { const m = s.check(next); if (m) throw new SpecError('BAD_VALUE', `${s.label}：${m}`); }
  const diff = diffOf(before, next);
  if (!Object.keys(diff).length) return rec;
  next.updated_by = ctx.actor;
  next.updated_at = ctx.now;
  next.row_version = rec.row_version + 1;
  checkUnique(data, coll, next);
  Object.assign(rec, next);
  emit(ctx, coll, id, '修改', diff, reason);
  return rec;
}

// 確認類狀態轉換之專責函式（業務模組於驗證後呼叫）
const TRANSITIONS = { 草稿: ['待確認', '已確認', '撤銷'], 待確認: ['草稿', '已確認', '撤銷'], 已確認: [], 撤銷: [] };

export function setConfirmStatus(data, ctx, coll, id, status, { reason } = {}) {
  const s = schemaOf(coll);
  if (!s.confirmable) throw new SpecError('NOT_CONFIRMABLE', `${s.label}無確認狀態`);
  const rec = must(data, coll, id);
  if (!E.CONFIRM.includes(status)) throw new SpecError('BAD_VALUE', `確認狀態不正確：${status}`);
  if (!TRANSITIONS[rec.confirm_status].includes(status)) {
    throw new SpecError('BAD_TRANSITION', `${s.label}由「${rec.confirm_status}」不可改為「${status}」`);
  }
  if (status === '撤銷' && !(reason && String(reason).trim())) throw new SpecError('REQUIRED', '撤銷須填原因');
  const before = { ...rec };
  rec.confirm_status = status;
  if (status === '已確認') { rec.confirmed_by = ctx.actor; rec.confirmed_at = ctx.now; }
  if (status === '撤銷') rec.revoke_reason = String(reason).trim();
  rec.updated_by = ctx.actor;
  rec.updated_at = ctx.now;
  rec.row_version += 1;
  emit(ctx, coll, id, status === '已確認' ? '確認' : status === '撤銷' ? '撤銷' : `改為${status}`, diffOf(before, rec), reason);
  return rec;
}

// 專責欄位設定（例：案件結果摘要、結案、主檔啟用、快照確認）；只供業務模組呼叫，限定欄位
export function setDedicated(data, ctx, coll, id, changes, { action, reason, fields }) {
  const allowed = new Set(fields);
  for (const k of Object.keys(changes)) {
    if (!allowed.has(k)) throw new SpecError('FIELD_PROTECTED', `${schemaOf(coll).label}：此功能不可設定 ${k}`);
  }
  const s = schemaOf(coll);
  const rec = must(data, coll, id);
  const before = { ...rec };
  for (const [k, v] of Object.entries(changes)) {
    const def = s.fields[k];
    rec[k] = coerce(coll, k, def, v);
    checkRef(data, coll, k, def, rec[k]);
  }
  rec.updated_by = ctx.actor;
  rec.updated_at = ctx.now;
  rec.row_version += 1;
  emit(ctx, coll, id, action, diffOf(before, rec), reason);
  return rec;
}

// ---------- 操作id（第11.3節、T17）----------
export function opSeen(data, opId) {
  if (!opId) return null;
  return list(data, 'op_log').find((r) => r.op_id === opId) || null;
}

export function opRecord(data, ctx, opId, kind, result) {
  if (!opId) return;
  const rec = { id: ctx.newId(), op_id: opId, kind, result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
    created_by: ctx.actor, created_at: ctx.now, updated_by: ctx.actor, updated_at: ctx.now, row_version: 1 };
  list(data, 'op_log').push(rec);
}

// ---------- 整體一致性檢查（儲存前；第4.5節步驟2） ----------
export function validateData(data) {
  const problems = [];
  if (!data || !data.collections) return ['資料格式錯誤：缺 collections'];
  for (const [coll, s] of Object.entries(SCHEMA)) {
    const rows = data.collections[coll];
    if (!Array.isArray(rows)) { problems.push(`缺集合 ${coll}`); continue; }
    const ids = new Set();
    for (const r of rows) {
      if (!r.id) { problems.push(`${s.label}有一筆缺id`); continue; }
      if (ids.has(r.id)) problems.push(`${s.label} id重複：${r.id}`);
      ids.add(r.id);
      for (const [name, def] of Object.entries(s.fields)) {
        const v = r[name];
        if (def.req && (v === null || v === undefined || v === '')) problems.push(`${s.label}（${r.id}）${name} 必填`);
        if (v === null || v === undefined) continue;
        try { coerce(coll, name, def, v); } catch (e) { problems.push(`${e.message}（${r.id}）`); }
        if (def.t === 'ref' && !(data.collections[def.r] || []).some((x) => x.id === v)) {
          problems.push(`${s.label}（${r.id}）${name} 參照不存在：${v}`);
        }
        if (def.t === 'money' && typeof v !== 'string') problems.push(`${s.label}（${r.id}）${name} 金額須為文字`);
        if (def.t === 'code' && typeof v !== 'string') problems.push(`${s.label}（${r.id}）${name} 代碼須為文字`);
      }
      if (s.check) { const m = s.check(r); if (m) problems.push(`${s.label}（${r.id}）${m}`); }
    }
    for (const keys of s.unique || []) {
      const seen = new Set();
      for (const r of rows) {
        const k = JSON.stringify(keys.map((x) => r[x]));
        if (seen.has(k)) problems.push(`${s.label}重複：${keys.join('+')}=${k}`);
        seen.add(k);
      }
    }
  }
  return problems;
}
