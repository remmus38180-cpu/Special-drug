"""效能驗收（設計測試量）：主檔5萬品項、認定2千筆。輸出各操作耗時。

用法：python tools/perf_check.py [品項數] [認定數]
"""
import csv
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from specdrug import cases as C  # noqa: E402
from specdrug import master_import as M  # noqa: E402
from specdrug import recognition as R  # noqa: E402
from specdrug.core import Ctx  # noqa: E402
from specdrug.db import open_db  # noqa: E402
from specdrug.query import drug_detail, search_drugs  # noqa: E402


def timed(label, fn):
    t = time.time()
    r = fn()
    print(f"{label}：{time.time() - t:.2f}s")
    return r


def main(n_drug=50000, n_rec=2000):
    d = Path(tempfile.mkdtemp())
    con = open_db(d / "perf.sqlite")
    ctx = Ctx(con, "perf", {"管理者", "登記者", "複核登記者"}, True)
    p = d / "m.csv"
    with open(p, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["CODE", "NAME", "GROUP", "ATC", "PDOSE", "MULTI", "QTY", "UNIT", "PRICE"])
        for i in range(n_drug):
            w.writerow([f"A{i:09d}", f"DRUG {i}", f"G{i // 10:011d}", f"A{i % 90:02d}AA{i % 97:02d}", str(10 + i % 40),
                        "N" if i % 5 else "Y", str(1 + i % 20), "ML" if i % 3 else "MG", f"{i % 1000}.5"])
    mapping = {"drug_code": "CODE", "drug_name": "NAME", "group_code": "GROUP", "atc_code": "ATC",
               "dose_code": "PDOSE", "multi_mark": "MULTI", "spec_qty": "QTY", "spec_unit": "UNIT", "price": "PRICE"}
    iid = timed(f"試匯入 {n_drug} 品項", lambda: M.stage_import(ctx, p, mapping, base_date="2026-10-01"))
    M.activate(ctx, iid)
    t = time.time()
    for k in range(n_rec):
        rec = R.create_recognition(ctx, name=f"認定{k}")
        rev = R.create_revision(ctx, rec, category="特殊藥品", effective_from="2020-01-01",
                                rule={"field": "group_code", "op": "eq", "value": f"G{k:011d}"})
        if k < 200:  # 建快照較慢，抽樣
            sid = R.save_snapshot(ctx, rev, iid)
            R.confirm_snapshot(ctx, sid)
            R.confirm_revision(ctx, rev)
    print(f"建立 {n_rec} 認定（200筆含快照確認）：{time.time() - t:.1f}s")
    for k in range(500):
        C.create_case(ctx, subject=f"案{k}", drugs=[f"A{k:09d}"])
    rule = {"op": "and", "children": [{"field": "atc_code", "op": "starts_with", "value": "A1"},
                                      {"field": "multi_mark", "op": "eq", "value": "N"},
                                      {"field": "spec", "op": "eq", "value": "5", "unit": "ML"}]}
    timed("規則預覽（目標10s內）", lambda: R.preview(con, rule, iid))
    timed("認定清單全部（目標3s內）", lambda: R.list_recognitions(con))
    timed("認定清單關鍵字查詢", lambda: R.list_recognitions(con, "G00000000012"))
    timed("案件清單一頁", lambda: C.list_cases(con, limit=300))
    timed("品項搜尋", lambda: search_drugs(con, iid, "DRUG 4999"))
    timed("品項明細時間序列", lambda: drug_detail(con, "A000000005"))


if __name__ == "__main__":
    main(*(int(x) for x in sys.argv[1:3]))
