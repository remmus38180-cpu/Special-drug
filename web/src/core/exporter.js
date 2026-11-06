// 匯出（第11.5節）：檔名規則、xlsx「匯出說明」工作表與文件屬性、CSV 說明列（或另產 _說明.txt）、資料夾匯出紀錄 logs/export-log.jsonl、依 SHA-256 反查。
// 匯出不改變業務資料、不產生未儲存變更。
import { SpecError } from './errors.js';
import { APP_VERSION, SCHEMA_VERSION, BUILD_COMMIT } from './version.js';
import { writeXlsx } from './xlsxWrite.js';
import { sha256Bytes, utf8, pad, isoUtc, taipeiDisplay } from './util.js';
import { P } from './paths.js';

export const EXPORT_KINDS = ['認定清單', '品項明細', '差異待辦', '查詢結果', '移轉核對', '備份'];

function stamp(ms) {
  const t = new Date(ms + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}-${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
}

export function revisionTag(revision, unsaved) {
  return `r${String(revision || 0).padStart(6, '0')}${unsaved ? '+未儲存' : ''}`;
}

// 同一秒內同類檔案再次匯出加 -2、-3（計數保留於本分頁）
export class ExportNamer {
  constructor() { this.seen = new Map(); }
  name(kind, ms, revision, unsaved, ext) {
    if (!EXPORT_KINDS.includes(kind)) throw new SpecError('BAD_VALUE', `匯出種類不正確：${kind}`);
    const st = stamp(ms);
    const key = `${kind}|${st}|${ext}`;
    const n = (this.seen.get(key) || 0) + 1;
    this.seen.set(key, n);
    return `特藥_${kind}_${st}${n > 1 ? '-' + n : ''}_${revisionTag(revision, unsaved)}.${ext}`;
  }
}

// info：{kind, ms, actor, revision, unsaved, versionSha, master:{base_date, source_name, sha256}, condition, day, count}
export function infoRows(info) {
  return [
    ['匯出內容', info.kind],
    ['匯出時間（台北）', taipeiDisplay(info.ms)],
    ['匯出時間（UTC）', isoUtc(info.ms)],
    ['操作者', info.actor || ''],
    ['程式版本', `${APP_VERSION}（${BUILD_COMMIT}）`],
    ['資料結構版本', String(SCHEMA_VERSION)],
    ['資料revision', revisionTag(info.revision, info.unsaved) + (info.unsaved ? '（含未儲存變更，非已儲存版本內容）' : '')],
    ['版本檔SHA-256前16碼', info.versionSha ? info.versionSha.slice(0, 16) : ''],
    ['主檔版本與資料基準日', info.master ? `${info.master.base_date}（${info.master.source_name}，${(info.master.sha256 || '').slice(0, 8)}）` : '（無已啟用主檔）'],
    ['查詢條件', info.condition || '（無）'],
    ['查詢日期', info.day || ''],
    ['筆數', String(info.count)],
  ];
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? (v.n !== undefined ? v.n : v.date !== undefined ? v.date : JSON.stringify(v)) : String(v);
  if (/^[=+@]/.test(s)) s = "'" + s; // 防公式注入；代碼與金額不以此開頭
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvText(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// 產出匯出檔（不寫入資料夾）；回傳 [{name, bytes, mime}]
export function buildExport({ format, info, headers, rows, sheetName, csvNotes = true, namer }) {
  const nm = namer || new ExportNamer();
  const meta = infoRows(info);
  if (format === 'xlsx') {
    const name = nm.name(info.kind, info.ms, info.revision, info.unsaved, 'xlsx');
    const bytes = writeXlsx([{ name: '匯出說明', rows: meta }, { name: sheetName || info.kind, rows: [headers, ...rows] }], {
      title: info.kind, author: info.actor || '', created: isoUtc(info.ms), subject: info.condition || '',
      custom: { 程式版本: APP_VERSION, 資料結構版本: String(SCHEMA_VERSION), 資料revision: revisionTag(info.revision, info.unsaved), 主檔基準日: info.master ? info.master.base_date : '' },
    });
    return [{ name, bytes, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }];
  }
  if (format !== 'csv') throw new SpecError('BAD_VALUE', `匯出格式不正確：${format}`);
  const name = nm.name(info.kind, info.ms, info.revision, info.unsaved, 'csv');
  const body = csvText(headers, rows);
  const notes = meta.map(([k, v]) => `# ${k}：${v}`).join('\r\n') + '\r\n';
  const bom = '﻿';
  if (csvNotes) return [{ name, bytes: utf8(bom + notes + body), mime: 'text/csv' }];
  return [{ name, bytes: utf8(bom + body), mime: 'text/csv' }, { name: name.replace(/\.csv$/, '_說明.txt'), bytes: utf8(bom + notes), mime: 'text/plain' }];
}

// 匯出紀錄：每檔一列追加；寫入失敗由呼叫端提示，不影響已下載檔案
export async function logExport(fs, file, info) {
  const entry = {
    exported_at: isoUtc(info.ms), file_name: file.name, kind: info.kind, condition: info.condition || null, count: info.count,
    revision: info.revision, unsaved: !!info.unsaved, app_version: APP_VERSION, schema_version: SCHEMA_VERSION, actor: info.actor || null,
    sha256: await sha256Bytes(file.bytes),
  };
  const cur = await fs.read(P.EXPORT_LOG);
  const text = (cur ? cur.text : '') + JSON.stringify(entry) + '\n';
  await fs.write(P.EXPORT_LOG, text);
  return entry;
}

export async function readExportLog(fs) {
  const r = await fs.read(P.EXPORT_LOG);
  if (!r) return [];
  const out = [];
  for (const line of r.text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { out.push({ broken: true, raw: line.slice(0, 80) }); }
  }
  return out;
}

export async function findExportBySha(fs, sha) {
  const s = String(sha || '').trim().toLowerCase();
  return (await readExportLog(fs)).filter((e) => e.sha256 === s);
}
