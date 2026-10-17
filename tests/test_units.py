"""補充單元測試：每日檔映射、價格長表、匯出防公式、附件路徑、規則白名單。"""
import csv

import pytest

from conftest import write_master
from specdrug import master_import as M
from specdrug import rules
from specdrug.core import BizError
from specdrug.export import export_csv, safe_cell
from specdrug.store import StoreError, storage_path


def _csv(path, head, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(head)
        w.writerows(rows)
    return path


def test_daily_dwm_drug_with_rcode_and_drpay(ctx, tmp_path):
    drug = _csv(tmp_path / "DWM_DRUG.csv",
                ["DRUG_CODE", "DRUG_ENAME", "DRUGGIST_ID", "DRUG_GROUP_CODE", "DRUG_ATC7_CODE", "DRUG_APV_DOSE_CODE",
                 "DRUG_ING_CODE", "DRUG_ING_QTY", "DRUG_MULTI_MARK", "DRUG_STD_QTY_CODE", "DRUG_STD_CODE",
                 "DRUG_NECESSARY", "LICID_7"],
                [["A000015421", "YEN KUANG", "0411130200", "S01SUL212432", "S01AB91", "43", "0824001510", "20", "1",
                  "21", "003", "4", "A000015"]])
    rcode = _csv(tmp_path / "RCODE.csv", ["DRUG_REL_CODE_TYPE", "DRUG_REL_CODE", "DRUG_REL_CODE_CNAME",
                                          "DRUG_REL_CODE_ENAME", "DRUG_STD_QTY"],
                 [["5", "21", "", "", "5"], ["2", "003", "", "ML", ""], ["1", "43", "眼用液劑", "", ""],
                  ["8", "S01SUL212432", "SULFAMETHOXAZOLE 眼用液劑", "", ""]])
    pay = _csv(tmp_path / "DRPAY.csv", ["DRUG_CODE", "PAY_S_DATE", "PAY_PRICE", "PAY_E_DATE"],
               [["A000015421", "2018-01-01", "12", "2026-09-30"], ["A000015421", "2026-10-01", "10.0", "2910-12-31"]])
    preset = M.PRESETS["DWM_DRUG SQL Server每日檔（依table layout欄名）"]
    iid = M.stage_import(ctx, drug, preset["mapping"], base_date="2026-10-01", lookups=preset["lookups"],
                         rcode_path=rcode, price_path=pay)
    r = ctx.con.execute("SELECT * FROM master_drug WHERE import_id=?", (iid,)).fetchone()
    assert (r["spec_qty"], r["spec_unit"], r["dose_name"], r["price"], r["annotation_raw"]) == ("5", "ML", "眼用液劑",
                                                                                              "10", "4")
    assert r["group_name"].startswith("SULFAMETHOXAZOLE")
    chk = M.check_of(ctx.con, iid)
    assert chk["unknown_lookup"] == {"atc_name": ["S01AB91"]}  # RCODE缺此ATC→列出，不猜測
    with pytest.raises(BizError, match="基準日"):
        M.load_price_long(pay, None)


def test_price_conflict_same_day(ctx, tmp_path):
    p = write_master(tmp_path / "m.csv", [["A1", "X", "", "", "", "", "", "", "", "", "", ""]])
    pay = _csv(tmp_path / "p.csv", ["DRUG_CODE", "PAY_S_DATE", "PAY_PRICE", "PAY_E_DATE"],
               [["A1", "2026-01-01", "5", "2910-12-31"], ["A1", "2026-06-01", "6", "2910-12-31"]])
    iid = M.stage_import(ctx, p, {"drug_code": "CODE"}, base_date="2026-10-01", price_path=pay)
    with pytest.raises(BizError, match="矛盾"):
        M.activate(ctx, iid)


def test_formula_injection_export(con, tmp_path):
    assert safe_cell("=1+1") == "'=1+1" and safe_cell("@SUM(A1)") == "'@SUM(A1)" and safe_cell(12) == 12
    p = tmp_path / "o.csv"
    export_csv(con, p, ["代碼"], [["=HYPERLINK(\"x\")"], ["0012"]], conditions="=cmd")
    text = p.read_text(encoding="utf-8-sig")
    assert "'=HYPERLINK" in text and "'=cmd" in text and "0012" in text


def test_attachment_path_traversal(tmp_path):
    with pytest.raises(StoreError):
        storage_path(tmp_path, "../" + "a" * 64)
    with pytest.raises(StoreError):
        storage_path(tmp_path, "ab/../../etc/passwd")
    ok = storage_path(tmp_path, "ab/" + "a" * 64)
    assert tmp_path.resolve() in ok.parents


def test_rule_whitelist_and_empty():
    for bad in ({"op": "and", "children": []}, {"field": "sql", "op": "eq", "value": "1; DROP TABLE"},
                {"field": "group_code", "op": "like", "value": "%"}, {"field": "group_code", "op": "in", "values": []},
                {"field": "group_code", "op": "eq", "value": "x", "extra": 1}):
        with pytest.raises(rules.RuleError):
            rules.validate(bad)
    ev = rules.Evaluator(["ML"], {})
    assert ev.evaluate({"op": "not", "child": {"field": "atc_code", "op": "eq", "value": "X"}}, {"atc_code": None})[0] \
        == rules.UNKNOWN


def test_rule_text_parser_samples():
    ast, iss = rules.parse_rule_text("ATC7碼=S01FA01 & 複方藥品=N &核價劑型PDOSE=42,43")
    assert ast == {"op": "and", "children": [{"field": "atc_code", "op": "eq", "value": "S01FA01"},
                                              {"field": "multi_mark", "op": "eq", "value": "N"},
                                              {"field": "dose_code", "op": "in", "values": ["42", "43"]}]}
    ast, _ = rules.parse_rule_text("分組代碼 IN (B05PER26621C、B05PER26621E、B05PER26621G)")
    assert ast["values"] == ["B05PER26621C", "B05PER26621E", "B05PER26621G"]
    ast, _ = rules.parse_rule_text("分組代碼=C01LID212202 &規格量=5mL")
    assert ast["children"][1] == {"field": "spec", "op": "eq", "value": "5", "unit": "ML"}
    ast, iss = rules.parse_rule_text("ATC7碼=RO5DA04 & 核價劑型PDOSE=20,23")
    assert ast["children"][0]["value"] == "RO5DA04" and any("O／數字0" in i for i in iss)
