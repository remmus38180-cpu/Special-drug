"""以使用者提供之真實檔案驗證主檔匯入、代碼轉換、價格長表與規則預覽效能（不入版控資料）。

用法：python tools/real_data_check.py <資料夾>
資料夾需含 dwm_drug_*.xlsx、DWM_DRPAY.xlsx、DWM_DRUG_RCODE.xlsx（資料檔）、活頁簿1.xlsx。
"""
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from specdrug import master_import as M  # noqa: E402
from specdrug import migration as MG  # noqa: E402
from specdrug import recognition as R  # noqa: E402
from specdrug.core import Ctx  # noqa: E402
from specdrug.db import open_db  # noqa: E402


def find(folder, *keys):
    for p in sorted(Path(folder).glob("*.xlsx")):
        if all(k.lower() in p.name.lower() for k in keys):
            return p
    return None


def main(folder):
    con = open_db(Path(tempfile.mkdtemp()) / "real.sqlite")
    ctx = Ctx(con, "tester", {"管理者", "登記者", "複核登記者"}, True)
    drug = find(folder, "dwm_drug_1")
    t = time.time()
    preset = M.PRESETS["dwm_drug 月產製處理檔（如 dwm_drug_11509.xlsx）"]
    iid = M.stage_import(ctx, drug, preset["mapping"], base_date="2026-10-01")
    chk = M.check_of(con, iid)
    print(f"[月檔] {drug.name} 試匯入 {time.time() - t:.1f}s 代碼 {chk['codes']} 錯誤 {chk['code_error_count']}"
          f" 矛盾 {chk['conflict_count']} 警告 {chk['warning_count']}")
    M.activate(ctx, iid)
    drpay = find(folder, "drpay")
    if drpay:
        t = time.time()
        prices, conflicts, trunc = M.load_price_long(drpay, "2026-10-01")
        print(f"[DRPAY] {time.time() - t:.1f}s 基準日價格 {len(prices)} 筆，同日多價 {len(conflicts)}，截斷疑慮 {trunc}")
        same = diff = 0
        for code, price in con.execute("SELECT drug_code, price FROM master_drug WHERE import_id=?", (iid,)):
            if code in prices:
                same += prices[code] == price
                diff += prices[code] != price
        print(f"        與月檔 price11510 比對：相同 {same}、不同 {diff}")
    rc = [p for p in Path(folder).glob("*RCODE*.xlsx") if p.stat().st_size > 100000]
    if rc:
        t = time.time()
        codes = M.load_rcode(rc[0])
        print(f"[RCODE] {time.time() - t:.1f}s 代碼 {len(codes)}；type L：",
              {k[1]: v["cname"] for k, v in codes.items() if k[0] == "L"})
    wb = find(folder, "1") if not find(folder, "活頁簿") else find(folder, "活頁簿")
    if wb:
        MG.stage_workbook(ctx, wb)
        n = slow = 0
        worst = 0
        stats = {"符合0筆": 0, "有待確認": 0}
        for r in MG.list_rows(con):
            ast = r["parsed"]["rule_ast"]
            if not ast:
                continue
            t = time.time()
            pv = R.preview(con, ast, iid)
            dt = time.time() - t
            worst = max(worst, dt)
            n += 1
            stats["符合0筆"] += pv["match"] + pv["pending"] == 0
            stats["有待確認"] += pv["pending"] > 0
        print(f"[規則預覽] {n} 條原文規則，最慢 {worst:.2f}s（目標10s內），{stats}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
