"""查詢：依藥品代碼回溯完整時間序列、指定日期狀態。"""
from __future__ import annotations

from .pricing import annotation_on
from .recognition import drug_category_on, drug_recognitions
from .util import today


def drug_detail(con, drug_code, day=None) -> dict:
    day = day or today()
    masters = [dict(r) for r in con.execute(
        "SELECT md.*, mi.source_name, mi.base_date, mi.status AS import_status FROM master_drug md"
        " JOIN master_import mi ON mi.id=md.import_id WHERE md.drug_code=? AND mi.status='已啟用'"
        " ORDER BY mi.base_date DESC, mi.activated_at DESC", (drug_code,))]
    events = []

    def ev(date, kind, text, ref=None, status=None):
        events.append({"date": date, "kind": kind, "text": text, "ref": ref, "status": status})

    for r in con.execute(
            "SELECT c.*, cd.role FROM case_drug cd JOIN case_record c ON c.id=cd.case_id WHERE cd.drug_code=?",
            (drug_code,)):
        ev(r["recv_date"], "收案", f"{r['case_no']} {r['subject']}（{r['status']}／{r['result_summary']}）", r["id"])
    for r in con.execute(
            "SELECT dd.result, dd.conditions, d.nature, d.result_text, m.name, m.meeting_date, m.meeting_type, c.case_no"
            " FROM decision_drug dd JOIN case_drug cd ON cd.id=dd.case_drug_id JOIN decision d ON d.id=dd.decision_id"
            " JOIN meeting_agenda a ON a.id=d.agenda_id JOIN meeting m ON m.id=a.meeting_id"
            " JOIN case_record c ON c.id=cd.case_id WHERE cd.drug_code=?", (drug_code,)):
        ev(r["meeting_date"], f"{r['meeting_type']}會議／{r['nature']}",
           f"{r['case_no']} {r['name']}：{r['result']}{('（' + r['conditions'] + '）') if r['conditions'] else ''}")
    for s in drug_recognitions(con, drug_code, day):
        ev(s["effective_from"], "認定", f"{s['recognition_no']} {s['name']}：{s['category']}（{s['state']}）",
           s["revision_id"])
    for r in con.execute(
            "SELECT pa.*, r.name FROM price_action pa JOIN recognition_revision rv ON rv.id=pa.revision_id"
            " JOIN recognition r ON r.id=rv.recognition_id WHERE pa.drug_code=? ORDER BY pa.effective_date",
            (drug_code,)):
        ev(r["effective_date"], "調高",
           f"{r['name']}：{r['price_before'] or '?'} → {r['price_after'] or '?'}；簽約要求 {r['contract_requirement']}"
           f"；公告 {r['announce_doc_no'] or '未填'}", r["id"], f"{r['status']}／{r['confirm_status']}")
    for r in con.execute(
            "SELECT c.*, cd.effective_from AS cd_from, cd.effective_to AS cd_to FROM contract_drug cd"
            " JOIN contract c ON c.id=cd.contract_id WHERE cd.drug_code=?", (drug_code,)):
        ev(r["signed_date"] or r["effective_from"], "合約",
           f"{r['contract_no']} {r['firm'] or ''}（{r['status']}，到期 {r['expiry_date'] or '未填'}）", r["id"])
    for r in con.execute("SELECT * FROM annotation_event WHERE drug_code=?", (drug_code,)):
        ev(r["effective_date"], "註記", f"{r['action']} {r['category'] or ''}：{r['basis'] or ''}", r["id"],
           r["confirm_status"])
    events.sort(key=lambda e: (e["date"] is None, e["date"] or ""))
    return {
        "drug_code": drug_code, "day": day, "master": masters,
        "category": drug_category_on(con, drug_code, day),
        "annotation": annotation_on(con, drug_code, day),
        "events": events,
    }


def search_drugs(con, import_id, keyword, limit=200) -> list[dict]:
    k = f"%{keyword}%"
    return [dict(r) for r in con.execute(
        "SELECT drug_code, drug_name, firm, group_code, atc_code, dose_name, spec_qty, spec_unit, price, annotation_raw"
        " FROM master_drug WHERE import_id=? AND (drug_code LIKE ? OR drug_name LIKE ? OR ingredient LIKE ?"
        " OR atc_code LIKE ? OR group_code LIKE ? OR firm LIKE ?) ORDER BY drug_code LIMIT ?",
        (import_id, k, k, k, k, k, k, limit))]
