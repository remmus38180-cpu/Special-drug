import csv
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from specdrug.core import Ctx, ROLE_ADMIN, ROLE_CLERK, ROLE_REVIEWER  # noqa: E402
from specdrug.db import open_db  # noqa: E402
from specdrug import master_import as M  # noqa: E402

HEAD = ["CODE", "藥品名稱", "藥商名稱", "分組代碼", "ATC7碼", "PDOSE", "核價劑型", "複方藥品", "規格量", "規格單位",
        "price", "必要藥品"]

BASE_ROWS = [
    ["A000001100", "DRUG A1", "甲藥廠", "G1AAA0000001", "J06BA01", "20", "注射劑", "N", "5", "ML", "100.5", "0"],
    ["A000002100", "DRUG A2", "乙藥廠", "G1AAA0000001", "J06BA01", "20", "注射劑", "N", "10", "ML", "90", "0"],
    ["A000003100", "DRUG B1", "甲藥廠", "G1BBB0000001", "J06BB16", "20", "注射劑", "N", "", "", "200", "4"],
    ["B000004100", "DRUG C1", "丙藥廠", "G1CCC0000001", "L04AA03", "11", "一般錠劑膠囊劑", "N", "", "", "12.3", "3"],
    ["0A00005100", "DRUG D1", "丁藥廠", "G1DDD0000001", "L04AA04", "11", "一般錠劑膠囊劑", "Y", "", "", "8", "0"],
    ["A000006100", "DRUG E1", "甲藥廠", "G1AAA0000001", "J06BA01", "20", "注射劑", "N", "5", "XYZ", "70", "0"],
    ["A000007100", "DRUG F1", "戊藥廠", "G1FFF0000001", "C01AA05", "11", "一般錠劑膠囊劑", "", "", "", "3", "0"],
]


def write_master(path, rows, head=HEAD):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(head)
        w.writerows(rows)
    return path


MAPPING = {"drug_code": "CODE", "drug_name": "藥品名稱", "firm": "藥商名稱", "group_code": "分組代碼",
           "atc_code": "ATC7碼", "dose_code": "PDOSE", "dose_name": "核價劑型", "multi_mark": "複方藥品",
           "spec_qty": "規格量", "spec_unit": "規格單位", "price": "price", "annotation_raw": "必要藥品"}


@pytest.fixture
def con(tmp_path):
    c = open_db(tmp_path / "t.sqlite")
    yield c
    c.close()


@pytest.fixture
def ctx(con):
    return Ctx(con, "reviewer", {ROLE_ADMIN, ROLE_CLERK, ROLE_REVIEWER}, True)


@pytest.fixture
def master(ctx, tmp_path):
    p = write_master(tmp_path / "m1.csv", BASE_ROWS)
    iid = M.stage_import(ctx, p, MAPPING, base_date="2026-10-01")
    M.activate(ctx, iid)
    return iid
