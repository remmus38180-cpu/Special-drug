"""產生模擬資料（非真實資料）到離線原型資料庫，供教育訓練與驗收展示。

用法：python tools/seed_demo.py [本機資料夾]
內容：模擬主檔、通過／未通過／多次會議案件、逐品項決議、認定版本與快照、合約、調高與註記。
"""
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from specdrug import cases as C  # noqa: E402
from specdrug import master_import as M  # noqa: E402
from specdrug import pricing as P  # noqa: E402
from specdrug import recognition as R  # noqa: E402
from specdrug.workspace import Workspace  # noqa: E402

ROWS = [
    ["DEMO000001", "模擬注射劑甲 5ML", "模擬藥廠甲", "DEMOGRP00001", "J06BA01", "20", "注射劑", "N", "5", "ML", "120", "0"],
    ["DEMO000002", "模擬注射劑乙 10ML", "模擬藥廠乙", "DEMOGRP00001", "J06BA01", "20", "注射劑", "N", "10", "ML", "200", "0"],
    ["DEMO000003", "模擬錠劑丙", "模擬藥廠丙", "DEMOGRP00002", "L04AA03", "11", "一般錠劑膠囊劑", "N", "", "", "8.5", "3"],
    ["DEMO000004", "模擬錠劑丁", "模擬藥廠甲", "DEMOGRP00003", "L04AA04", "11", "一般錠劑膠囊劑", "Y", "", "", "6", "0"],
    ["DEMO000005", "模擬眼藥水", "模擬藥廠乙", "DEMOGRP00004", "S01FA01", "43", "眼用液劑", "N", "5", "ML", "45", "4"],
]
HEAD = ["CODE", "藥品名稱", "藥商名稱", "分組代碼", "ATC7碼", "PDOSE", "核價劑型", "複方藥品", "規格量", "規格單位",
        "price11510", "必要藥品"]


def main(local_dir):
    local = Path(local_dir)
    ws = Workspace(local, None, "demo")
    ctx = ws.ctx()
    src = local / "demo_master.csv"
    with open(src, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEAD)
        w.writerows(ROWS)
    mapping = {k: v for k, v in M.PRESETS["dwm_drug 月產製處理檔（如 dwm_drug_11509.xlsx）"]["mapping"].items()
               if v in HEAD}
    iid = M.stage_import(ctx, src, mapping, base_date="2026-10-01", note="模擬資料")
    M.activate(ctx, iid)

    # 通過案件
    ok = C.create_case(ctx, subject="模擬注射劑建議列特殊藥品", applicant="模擬藥廠甲", recv_date="2026-03-02",
                       recv_doc_no="模擬收文001", unit="調價", handler="承辦A", drugs=["DEMO000001", "DEMO000002"])
    cds = {r["drug_code"]: r["id"] for r in ws.con.execute("SELECT * FROM case_drug WHERE case_id=?", (ok,))}
    m1 = C.create_meeting(ctx, meeting_type="專家", name="模擬專家會議115年4月", meeting_date="2026-04-10")
    m2 = C.create_meeting(ctx, meeting_type="共同擬訂", name="模擬擬訂會議115年6月", meeting_date="2026-06-18")
    C.add_decision(ctx, agenda_id=C.add_agenda(ctx, meeting_id=m1, case_id=ok, agenda_no="3"), nature="專家建議",
                   result="同意", drug_results={cds["DEMO000001"]: "同意", cds["DEMO000002"]: "暫緩"})
    d2 = C.add_decision(ctx, agenda_id=C.add_agenda(ctx, meeting_id=m2, case_id=ok, agenda_no="5"),
                        nature="會議決議", result="附條件同意", conditions="須完成穩定供貨簽約",
                        drug_results={cds["DEMO000001"]: "附條件同意", cds["DEMO000002"]: "不同意"})
    C.set_case_summary(ctx, ok, "部分同意", [d2])
    rec = R.create_recognition(ctx, name="模擬注射劑（5ML規格）")
    rev = R.create_revision(ctx, rec, category="不可替代特殊藥品", case_id=ok, decision_ids=[d2],
                            scope_text="分組代碼=DEMOGRP00001 & 規格量=5mL", effective_from="2026-08-01",
                            rule={"op": "and", "children": [
                                {"field": "group_code", "op": "eq", "value": "DEMOGRP00001"},
                                {"field": "spec", "op": "eq", "value": "5", "unit": "ML"}]})
    sid = R.save_snapshot(ctx, rev, iid)
    R.confirm_snapshot(ctx, sid)
    R.confirm_revision(ctx, rev)
    cont = P.create_contract(ctx, contract_no="模擬合約-001", firm="模擬藥廠甲", status="完成簽署",
                             signed_date="2026-07-01", effective_from="2026-08-01", expiry_date="2029-07-31",
                             obligations="穩定供貨三年", drugs=["DEMO000001"])
    pa = P.create_price_action(ctx, revision_id=rev, drug_code="DEMO000001", case_id=ok, contract_requirement="須簽約",
                               contract_id=cont, price_before="120", price_after="180", effective_date="2026-08-01",
                               announce_doc_no="模擬公告001", announce_date="2026-07-15", status="已核定")
    an = P.create_annotation(ctx, drug_code="DEMO000001", action="新增", category="不可替代特殊藥品", revision_id=rev,
                             price_action_id=pa, effective_date="2026-08-01", basis="模擬公告001")
    P.confirm_announcement(ctx, price_action_ids=[pa], annotation_ids=[an])

    # 未通過案件（兩種會議）
    no = C.create_case(ctx, subject="模擬眼藥水申請提高", applicant="模擬藥廠乙", recv_date="2026-02-01",
                       drugs=["DEMO000005"])
    cd5 = ws.con.execute("SELECT id FROM case_drug WHERE case_id=?", (no,)).fetchone()[0]
    C.add_decision(ctx, agenda_id=C.add_agenda(ctx, meeting_id=m1, case_id=no, agenda_no="4"), nature="專家建議",
                   result="補充資料後再議", drug_results={cd5: "補充資料後再議"})
    d5 = C.add_decision(ctx, agenda_id=C.add_agenda(ctx, meeting_id=m2, case_id=no, agenda_no="6"),
                        nature="會議決議", result="不同意", drug_results={cd5: "不同意"})
    C.set_case_summary(ctx, no, "全部不同意", [d5])
    C.close_case(ctx, no, status="已結案", reason="共擬不同意", basis="模擬擬訂會議115年6月紀錄")
    print(f"已建立模擬資料於 {local}（離線原型）。")
    ws.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "demo_data")
