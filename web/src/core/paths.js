// 資料夾結構（第4.4節）。所有檔名由程式產生並以白名單驗證；不以使用者輸入組成路徑。
import { SpecError } from './errors.js';
import { pad, compactUtc } from './util.js';

export const P = {
  META: 'specdrug.json',
  TOKEN: 'control/editing.json',
  KEYWORD: 'control/keyword.json',
  CURRENT: 'data/current.json',
  VERSIONS: 'data/versions',
  EXPORT_LOG: 'logs/export-log.jsonl',
};

const FILE_PATTERNS = [
  /^specdrug\.json$/,
  /^control\/editing\.json$/,
  /^control\/keyword\.json$/,
  /^control\/_writetest-[0-9a-f-]{36}\.tmp$/,
  /^data\/current\.json$/,
  /^data\/versions\/r\d{6}-\d{8}T\d{6}Z-[0-9a-f]{8}\.json$/,
  /^masters\/[0-9a-f-]{36}\.json$/,
  /^attachments\/[0-9a-f]{2}\/[0-9a-f]{64}$/,
  /^logs\/export-log\.jsonl$/,
];

const DIR_PATTERNS = [/^$/, /^control$/, /^data$/, /^data\/versions$/, /^masters$/, /^attachments$/, /^attachments\/[0-9a-f]{2}$/, /^backups$/, /^logs$/];

export function isValidPath(p) {
  return typeof p === 'string' && FILE_PATTERNS.some((re) => re.test(p));
}

export function assertPath(p) {
  if (!isValidPath(p)) throw new SpecError('BAD_PATH', `不允許的檔案路徑：${p}`);
  return p;
}

export function assertDir(d) {
  if (typeof d !== 'string' || !DIR_PATTERNS.some((re) => re.test(d))) {
    throw new SpecError('BAD_PATH', `不允許的資料夾路徑：${d}`);
  }
  return d;
}

export function versionFileName(revision, ms, sha256) {
  return `r${pad(revision, 6)}-${compactUtc(ms)}-${sha256.slice(0, 8)}.json`;
}

const VERSION_RE = /^r(\d{6})-(\d{8}T\d{6}Z)-([0-9a-f]{8})\.json$/;

export function parseVersionFileName(name) {
  const m = VERSION_RE.exec(name);
  if (!m) return null;
  return { name, revision: Number(m[1]), stamp: m[2], sha8: m[3] };
}

export function attachmentPath(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SpecError('BAD_PATH', '附件雜湊格式錯誤');
  return `attachments/${sha256.slice(0, 2)}/${sha256}`;
}

export function masterPath(importId) {
  return assertPath(`masters/${importId}.json`);
}
