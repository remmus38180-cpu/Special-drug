// 表格來源統一介面：xlsx 或 CSV（UTF-8，含BOM與否皆可）。CSV 一律文字讀入，保留前導零。
import { SpecError } from './errors.js';
import { openXlsx } from './xlsx.js';

export const EXCEL_MAX_ROW = 1048576;

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += c; i++;
  }
  if (q) throw new SpecError('CSV', 'CSV引號未閉合（檔案可能不完整）');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function decodeCsv(bytes) {
  let b = bytes;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch (e) {
    throw new SpecError('CSV_ENCODING', 'CSV非UTF-8編碼，請於Excel另存為「CSV UTF-8（逗號分隔）」後再匯入');
  }
}

export function openTable(fileName, bytes) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const rows = parseCsv(decodeCsv(bytes));
    return {
      kind: 'csv',
      sheets: ['(CSV)'],
      *rows() {
        for (let r = 0; r < rows.length; r++) {
          const cells = new Map();
          rows[r].forEach((v, c) => { if (v !== '') cells.set(c, { v, t: 's' }); });
          yield { rowNo: r + 1, cells };
        }
      },
    };
  }
  if (lower.endsWith('.xls')) throw new SpecError('XLSX', '不支援舊版 .xls；請於Excel另存為 .xlsx 或 CSV UTF-8');
  const x = openXlsx(bytes);
  return { kind: 'xlsx', sheets: x.sheets, rows: (sheet, opts) => x.rows(sheet, opts) };
}

export function cellText(cell) {
  if (!cell || cell.v === null || cell.v === undefined) return null;
  const s = String(cell.v).trim();
  return s === '' ? null : s;
}

// 讀標題列：回傳欄名陣列（空白欄名以「(第N欄)」表示）與工作表最後列號估計不必
export function readHeaders(table, sheet, headerRow = 1) {
  for (const r of table.rows(sheet)) {
    if (r.rowNo < headerRow) continue;
    if (r.rowNo > headerRow) break;
    const max = r.cells.size ? Math.max(...r.cells.keys()) : -1;
    const out = [];
    for (let c = 0; c <= max; c++) out.push(cellText(r.cells.get(c)) || `(第${c + 1}欄)`);
    return out;
  }
  throw new SpecError('NO_HEADER', `找不到第 ${headerRow} 列標題列`);
}
