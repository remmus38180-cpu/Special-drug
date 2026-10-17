"""匯出：附匯出時間、查詢條件、主檔版本及基準日；防公式注入。"""
from __future__ import annotations

import csv

from .util import to_taipei, utc_now

_DANGER = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(v):
    """文字開頭為公式字元時前置單引號，避免被Excel當公式執行。數值保持原樣。"""
    if v is None:
        return ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    s = str(v)
    if s.startswith(_DANGER):
        return "'" + s
    return s


def _meta_lines(con, conditions: str | None, import_id: str | None):
    lines = [("匯出時間", to_taipei(utc_now()) + "（Asia/Taipei）"), ("查詢條件", conditions or "（無）")]
    if import_id:
        r = con.execute("SELECT source_name, base_date, sha256 FROM master_import WHERE id=?", (import_id,)).fetchone()
        if r:
            lines.append(("主檔版本", f"{r['source_name']}（{import_id[:8]}，SHA-256 {r['sha256'][:12]}…）"))
            lines.append(("資料基準日", r["base_date"] or "未指定"))
    rel = con.execute("SELECT value FROM meta WHERE key='release_id'").fetchone()
    lines.append(("資料版本", rel[0] if rel else "本機未發布"))
    return lines


def export_csv(con, path, headers: list[str], rows, *, conditions=None, import_id=None) -> int:
    n = 0
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        for k, v in _meta_lines(con, conditions, import_id):
            w.writerow([safe_cell(k), safe_cell(v)])
        w.writerow([])
        w.writerow([safe_cell(h) for h in headers])
        for r in rows:
            w.writerow([safe_cell(c) for c in r])
            n += 1
    return n


def export_xlsx(con, path, headers: list[str], rows, *, conditions=None, import_id=None, sheet="資料") -> int:
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet
    for k, v in _meta_lines(con, conditions, import_id):
        ws.append([k, v])
    ws.append([])
    ws.append(list(headers))
    n = 0
    for r in rows:
        row = []
        for c in r:
            c = safe_cell(c)
            row.append(c)
        ws.append(row)
        n += 1
    # 文字儲存格明確設為文字型別，避免代碼被轉數字或公式
    for row in ws.iter_rows():
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"
                cell.number_format = "@"
    wb.save(path)
    return n
