// 業務資料集合（第6.2節）與設定。階段1只建立空集合；各集合欄位於後續階段補齊。
import { SpecError } from './errors.js';

export const COLLECTIONS = [
  'case_record', 'case_drug', 'recognition', 'recognition_revision', 'meeting', 'meeting_agenda',
  'decision', 'decision_drug', 'revision_decision', 'master_import', 'scope_snapshot', 'scope_member',
  'group_treatment', 'contract', 'contract_drug', 'price_action', 'annotation_event', 'attachment',
  'attachment_link', 'op_log', 'review_item', 'migration_batch', 'migration_row',
];

// Q13：預設值，可於設定調整
export const DEFAULT_SETTINGS = {
  heartbeat_sec: 30,
  stale_min: 5,
  keyword_max_fail: 5,
  keyword_lock_sec: 30,
  csv_header_notes: true,
  attachment_max_mb: 50,
};

const SETTING_RULES = {
  heartbeat_sec: { type: 'int', min: 5, max: 300, label: '心跳間隔（秒）' },
  stale_min: { type: 'int', min: 1, max: 120, label: '視為已關閉（分鐘）' },
  keyword_max_fail: { type: 'int', min: 1, max: 20, label: '關鍵詞連續輸錯次數' },
  keyword_lock_sec: { type: 'int', min: 5, max: 3600, label: '輸錯鎖定（秒）' },
  csv_header_notes: { type: 'bool', label: 'CSV加說明列' },
  attachment_max_mb: { type: 'int', min: 1, max: 500, label: '附件大小上限（MB）' },
};

export function settingLabel(key) {
  return SETTING_RULES[key] ? SETTING_RULES[key].label : key;
}

export function emptyData() {
  const collections = {};
  for (const name of COLLECTIONS) collections[name] = [];
  return { collections, settings: { ...DEFAULT_SETTINGS } };
}

export function effectiveSettings(data) {
  return { ...DEFAULT_SETTINGS, ...((data && data.settings) || {}) };
}

// 欄位白名單＋值域檢查；回傳 {next, diff}
export function validateSettingsPatch(current, patch) {
  const next = { ...DEFAULT_SETTINGS, ...current };
  const diff = {};
  for (const [k, raw] of Object.entries(patch)) {
    const rule = SETTING_RULES[k];
    if (!rule) throw new SpecError('FIELD_NOT_ALLOWED', `設定不允許修改欄位：${k}`);
    let v;
    if (rule.type === 'int') {
      v = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isInteger(v) || v < rule.min || v > rule.max) {
        throw new SpecError('BAD_VALUE', `${rule.label}須為 ${rule.min}～${rule.max} 的整數`);
      }
    } else {
      if (typeof raw !== 'boolean') throw new SpecError('BAD_VALUE', `${rule.label}須為是／否`);
      v = raw;
    }
    if (next[k] !== v) {
      diff[k] = { from: next[k], to: v };
      next[k] = v;
    }
  }
  if (next.stale_min * 60 < next.heartbeat_sec * 3) {
    throw new SpecError('BAD_VALUE', '「視為已關閉」時間須至少為心跳間隔的3倍');
  }
  return { next, diff };
}
