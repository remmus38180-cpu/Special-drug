"""基本收案、歷次會議、議案、決議及逐品項結果（P0）。

案件與認定分開；未通過案件也完整保存。專家建議與會議決議分開標示。
"""
from __future__ import annotations

from .core import BizError, Ctx, ROLE_CLERK, ROLE_REVIEWER, audit, get, insert, update
from .util import normalize_code, parse_date, utc_now

CASE_STATUS = ("辦理中", "待補件", "待提會", "待後續辦理", "已結案", "撤回")
RESULTS = ("同意", "不同意", "附條件同意", "補充資料後再議", "暫緩", "其他", "待確認")
SUMMARIES = ("尚無結論", "全部同意", "部分同意", "全部不同意", "撤回", "其他")
MEETING_TYPES = ("專家", "藥事小組", "共同擬訂", "其他")
APPROVING = ("同意", "附條件同意")
EDIT_ROLES = (ROLE_CLERK, ROLE_REVIEWER)


def _date(v, label):
    if v in (None, ""):
        return None
    d = parse_date(v)
    if d is None:
        raise BizError(f"{label}「{v}」無法解析；未知請留空並標示待確認。")
    return d


def next_case_no(con, prefix="SD") -> str:
    year = utc_now()[:4]
    n = con.execute("SELECT COUNT(*) FROM case_record WHERE case_no LIKE ?", (f"{prefix}{year}-%",)).fetchone()[0]
    while True:
        n += 1
        no = f"{prefix}{year}-{n:04d}"
        if not con.execute("SELECT 1 FROM case_record WHERE case_no=?", (no,)).fetchone():
            return no


def create_case(ctx: Ctx, *, subject, applicant=None, request_item=None, recv_date=None, recv_doc_no=None,
                unit=None, handler=None, case_no=None, drugs=(), completeness=None, pending_fields=None,
                prior_case_id=None, source_ref=None, notes=None) -> str:
    ctx.require(*EDIT_ROLES)
    if not subject or not str(subject).strip():
        raise BizError("請輸入主旨。")
    with ctx.tx():
        values = dict(
            case_no=case_no or next_case_no(ctx.con), subject=subject.strip(), applicant=applicant,
            request_item=request_item, recv_date=_date(recv_date, "收文日"), recv_doc_no=recv_doc_no,
            unit=unit, handler=handler, prior_case_id=prior_case_id, source_ref=source_ref, notes=notes,
        )
        missing = [k for k, lab in (("recv_date", "收文日"), ("recv_doc_no", "文號"), ("applicant", "申請廠商"))
                   if not values.get(k)]
        values["completeness"] = completeness or ("待確認" if missing else "完整")
        values["pending_fields"] = pending_fields or (",".join(missing) if missing else None)
        if ctx.con.execute("SELECT 1 FROM case_record WHERE case_no=?", (values["case_no"],)).fetchone():
            raise BizError(f"案號 {values['case_no']} 已存在。")
        cid = insert(ctx, "case_record", values)
        for d in drugs:
            if isinstance(d, str):
                d = {"drug_code": d}
            add_case_drug(ctx, cid, **d)
    return cid


def update_case(ctx: Ctx, case_id, changes: dict, expected_version=None, reason=None):
    ctx.require(*EDIT_ROLES)
    allowed = {"subject", "applicant", "request_item", "recv_date", "recv_doc_no", "unit", "handler", "status",
               "completeness", "pending_fields", "notes", "source_ref"}
    bad = set(changes) - allowed
    if bad:
        raise BizError(f"不可直接修改：{', '.join(sorted(bad))}")
    if "status" in changes and changes["status"] not in CASE_STATUS:
        raise BizError("處理狀態不正確。")
    if changes.get("status") in ("已結案", "撤回"):
        raise BizError("結案或撤回請使用「結案」功能並記錄原因與依據。")
    if "recv_date" in changes:
        changes["recv_date"] = _date(changes["recv_date"], "收文日")
    with ctx.tx():
        return update(ctx, "case_record", case_id, changes, expected_version, reason)


def add_case_drug(ctx: Ctx, case_id, drug_code, drug_name_text=None, role="申請品項", note=None) -> str:
    ctx.require(*EDIT_ROLES)
    code, err = normalize_code(drug_code)
    if err:
        raise BizError(f"藥品代碼錯誤：{err}")
    with ctx.tx():
        if ctx.con.execute("SELECT 1 FROM case_drug WHERE case_id=? AND drug_code=?", (case_id, code)).fetchone():
            raise BizError(f"案件已有品項 {code}。")
        return insert(ctx, "case_drug", dict(case_id=case_id, drug_code=code, drug_name_text=drug_name_text,
                                             role=role, note=note))


def create_meeting(ctx: Ctx, *, meeting_type, name, meeting_date=None, session_no=None, notes=None) -> str:
    ctx.require(*EDIT_ROLES)
    if meeting_type not in MEETING_TYPES:
        raise BizError("會議類型須為：" + "／".join(MEETING_TYPES))
    if not name:
        raise BizError("請輸入會議正式名稱。")
    with ctx.tx():
        return insert(ctx, "meeting", dict(meeting_type=meeting_type, name=name,
                                           meeting_date=_date(meeting_date, "會議日期"),
                                           session_no=session_no, notes=notes))


def find_meeting(con, meeting_type, name, meeting_date=None):
    row = con.execute("SELECT id FROM meeting WHERE meeting_type=? AND name=? AND COALESCE(meeting_date,'')=?",
                      (meeting_type, name, meeting_date or "")).fetchone()
    return row[0] if row else None


def merge_meetings(ctx: Ctx, keep_id, merge_ids, reason) -> int:
    """使用者確認為同一次會議後合併：議案及附件改連保留會議；被併會議保留紀錄並註明，不硬刪。"""
    ctx.require(*EDIT_ROLES)
    if not reason:
        raise BizError("合併會議須填寫理由（核對依據）。")
    keep = get(ctx, "meeting", keep_id)
    if not keep:
        raise BizError("找不到保留的會議。")
    moved = 0
    with ctx.tx():
        for mid in merge_ids:
            m = get(ctx, "meeting", mid)
            if not m or mid == keep_id:
                raise BizError("合併對象不正確。")
            if m["meeting_type"] != keep["meeting_type"]:
                raise BizError("會議類型不同，不能合併。")
            agendas = [r[0] for r in ctx.con.execute("SELECT id FROM meeting_agenda WHERE meeting_id=?", (mid,))]
            for aid in agendas:
                update(ctx, "meeting_agenda", aid, {"meeting_id": keep_id}, reason=reason)
            ctx.con.execute("INSERT OR IGNORE INTO attachment_link(attachment_id, entity, entity_id)"
                            " SELECT attachment_id, entity, ? FROM attachment_link WHERE entity='meeting' AND entity_id=?",
                            (keep_id, mid))
            update(ctx, "meeting", mid, {"notes": f"{m['notes'] or ''}\n【已併入會議 {keep['name']}（{keep_id}）】"
                                                  f"理由：{reason}".strip()}, reason=reason)
            moved += len(agendas)
    return moved


def add_agenda(ctx: Ctx, *, meeting_id, case_id, agenda_no=None, subject=None, proposal=None, discussion=None,
               original_text=None) -> str:
    """同案重提新增議案紀錄，不覆蓋前次。以明確關聯連結案件。"""
    ctx.require(*EDIT_ROLES)
    if not get(ctx, "meeting", meeting_id):
        raise BizError("找不到會議。")
    if not get(ctx, "case_record", case_id):
        raise BizError("找不到案件。")
    with ctx.tx():
        return insert(ctx, "meeting_agenda", dict(meeting_id=meeting_id, case_id=case_id, agenda_no=agenda_no,
                                                  subject=subject, proposal=proposal, discussion=discussion,
                                                  original_text=original_text))


def add_decision(ctx: Ctx, *, agenda_id, nature, result, result_text=None, conditions=None,
                 approval_doc_no=None, approval_date=None, drug_results=None, supersedes_id=None,
                 correction_reason=None) -> str:
    """drug_results: {case_drug_id: result 或 (result, conditions, note)}；未列入者不推定。"""
    ctx.require(*EDIT_ROLES)
    if nature not in ("專家建議", "會議決議"):
        raise BizError("結果性質須為「專家建議」或「會議決議」。")
    if result not in RESULTS:
        raise BizError("結果不正確。")
    if result == "其他" and not (result_text or "").strip():
        raise BizError("結果為「其他」時須說明。")
    if supersedes_id and not correction_reason:
        raise BizError("更正或取代既有決議須填寫原因。")
    ag = get(ctx, "meeting_agenda", agenda_id)
    if not ag:
        raise BizError("找不到議案。")
    with ctx.tx():
        did = insert(ctx, "decision", dict(agenda_id=agenda_id, nature=nature, result=result,
                                           result_text=result_text, conditions=conditions,
                                           approval_doc_no=approval_doc_no,
                                           approval_date=_date(approval_date, "核定日期"),
                                           supersedes_id=supersedes_id, correction_reason=correction_reason))
        for cd_id, val in (drug_results or {}).items():
            if isinstance(val, str):
                val = (val, None, None)
            set_decision_drug(ctx, did, cd_id, *val)
    return did


def set_decision_drug(ctx: Ctx, decision_id, case_drug_id, result, conditions=None, note=None) -> str:
    ctx.require(*EDIT_ROLES)
    if result not in RESULTS:
        raise BizError("品項結果不正確。")
    if result == "其他" and not (note or conditions):
        raise BizError("品項結果為「其他」時須說明。")
    dec = get(ctx, "decision", decision_id)
    cd = get(ctx, "case_drug", case_drug_id)
    if not dec or not cd:
        raise BizError("找不到決議或品項。")
    ag = get(ctx, "meeting_agenda", dec["agenda_id"])
    if ag["case_id"] != cd["case_id"]:
        raise BizError("品項不屬於此議案的案件，不能串接。")
    with ctx.tx():
        row = ctx.con.execute("SELECT id FROM decision_drug WHERE decision_id=? AND case_drug_id=?",
                              (decision_id, case_drug_id)).fetchone()
        if row:
            update(ctx, "decision_drug", row[0], dict(result=result, conditions=conditions, note=note))
            return row[0]
        return insert(ctx, "decision_drug", dict(decision_id=decision_id, case_drug_id=case_drug_id,
                                                 result=result, conditions=conditions, note=note))


def set_case_summary(ctx: Ctx, case_id, summary, decision_ids=(), note=None):
    """結果摘要須連結形成摘要的會議／決議，由承辦確認；不以最後一次會議日期自動認定。"""
    ctx.require(*EDIT_ROLES)
    if summary not in SUMMARIES:
        raise BizError("結果摘要不正確。")
    if summary not in ("尚無結論",) and not decision_ids:
        raise BizError("結果摘要須連結至少一項會議決議或專家建議作為依據。")
    if summary == "其他" and not note:
        raise BizError("摘要為「其他」時須說明。")
    with ctx.tx():
        for did in decision_ids:
            dec = get(ctx, "decision", did)
            if not dec:
                raise BizError("找不到決議。")
            ag = get(ctx, "meeting_agenda", dec["agenda_id"])
            if ag["case_id"] != case_id:
                raise BizError("所選決議不屬於此案件。")
        ctx.con.execute("DELETE FROM case_summary_decision WHERE case_id=?", (case_id,))
        for did in decision_ids:
            ctx.con.execute("INSERT INTO case_summary_decision(case_id, decision_id) VALUES (?,?)", (case_id, did))
        update(ctx, "case_record", case_id, dict(result_summary=summary, result_summary_note=note,
                                                  result_confirmed_by=ctx.actor, result_confirmed_at=utc_now()))


def close_case(ctx: Ctx, case_id, *, status, reason, basis):
    ctx.require(*EDIT_ROLES)
    if status not in ("已結案", "撤回"):
        raise BizError("結案狀態須為「已結案」或「撤回」。")
    if not reason or not basis:
        raise BizError("結案須記錄原因與依據。")
    with ctx.tx():
        update(ctx, "case_record", case_id, dict(status=status, close_reason=reason, close_basis=basis))


def reopen_as_new(ctx: Ctx, prior_case_id, **kwargs) -> str:
    """再提或重新開案：新建案件並保留與前案關聯。"""
    prior = get(ctx, "case_record", prior_case_id)
    if not prior:
        raise BizError("找不到前案。")
    kwargs.setdefault("subject", prior["subject"])
    kwargs.setdefault("applicant", prior["applicant"])
    return create_case(ctx, prior_case_id=prior_case_id, **kwargs)


# ---------------- 查詢 ----------------

def case_timeline(con, case_id) -> list[dict]:
    """依序列出各次會議、議案、決議及逐品項結果。日期未知者排最後並標示。"""
    out = []
    agendas = con.execute(
        "SELECT a.*, m.meeting_type, m.name AS meeting_name, m.meeting_date, m.session_no"
        " FROM meeting_agenda a JOIN meeting m ON m.id=a.meeting_id WHERE a.case_id=?"
        " ORDER BY m.meeting_date IS NULL, m.meeting_date, a.created_at", (case_id,)).fetchall()
    for a in agendas:
        decs = []
        for d in con.execute("SELECT * FROM decision WHERE agenda_id=? ORDER BY created_at", (a["id"],)):
            items = [dict(r) for r in con.execute(
                "SELECT dd.*, cd.drug_code FROM decision_drug dd JOIN case_drug cd ON cd.id=dd.case_drug_id"
                " WHERE dd.decision_id=? ORDER BY cd.drug_code", (d["id"],))]
            decs.append(dict(d, drugs=items))
        out.append(dict(a, decisions=decs))
    return out


def drug_followup_basis(con, case_id, drug_code) -> list[dict]:
    """可接續認定／調高的依據：會議決議中該品項為同意或附條件同意者。"""
    return [dict(r) for r in con.execute(
        "SELECT d.id AS decision_id, dd.result, dd.conditions, m.name AS meeting_name, m.meeting_date"
        " FROM decision_drug dd JOIN case_drug cd ON cd.id=dd.case_drug_id"
        " JOIN decision d ON d.id=dd.decision_id JOIN meeting_agenda a ON a.id=d.agenda_id"
        " JOIN meeting m ON m.id=a.meeting_id"
        " WHERE cd.case_id=? AND cd.drug_code=? AND d.nature='會議決議' AND dd.result IN ('同意','附條件同意')"
        " AND NOT EXISTS (SELECT 1 FROM decision d2 WHERE d2.supersedes_id=d.id)",
        (case_id, drug_code))]


def list_cases(con, *, keyword=None, status=None, summary=None, completeness=None, limit=500, offset=0):
    sql = ("SELECT c.*, (SELECT GROUP_CONCAT(drug_code, ',') FROM case_drug WHERE case_id=c.id) AS drugs"
           " FROM case_record c WHERE 1=1")
    args = []
    if keyword:
        sql += (" AND (c.case_no LIKE ? OR c.subject LIKE ? OR c.applicant LIKE ? OR c.recv_doc_no LIKE ?"
                " OR EXISTS (SELECT 1 FROM case_drug d WHERE d.case_id=c.id AND d.drug_code LIKE ?))")
        args += [f"%{keyword}%"] * 5
    if status:
        sql += " AND c.status=?"
        args.append(status)
    if summary:
        sql += " AND c.result_summary=?"
        args.append(summary)
    if completeness:
        sql += " AND c.completeness=?"
        args.append(completeness)
    sql += " ORDER BY c.recv_date IS NULL, c.recv_date DESC, c.case_no DESC LIMIT ? OFFSET ?"
    args += [limit, offset]
    return [dict(r) for r in con.execute(sql, args)]


def list_meetings(con, keyword=None):
    sql = ("SELECT m.*, (SELECT COUNT(*) FROM meeting_agenda a WHERE a.meeting_id=m.id) AS agenda_count"
           " FROM meeting m")
    args = []
    if keyword:
        sql += " WHERE m.name LIKE ? OR m.session_no LIKE ?"
        args = [f"%{keyword}%"] * 2
    sql += " ORDER BY m.meeting_date IS NULL, m.meeting_date DESC"
    return [dict(r) for r in con.execute(sql, args)]


def audit_note(ctx: Ctx, entity, entity_id, text):
    with ctx.tx():
        audit(ctx, entity, entity_id, "備註", reason=text)
