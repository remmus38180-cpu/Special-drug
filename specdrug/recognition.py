"""認定項目、認定版本、範圍預覽與快照、分組調價方式、衝突判斷。

認定範圍名單、本次調高名單、主檔註記名單三者分開。
"""
from __future__ import annotations

import json

from . import rules
from .core import (BizError, Ctx, ROLE_CLERK, ROLE_REVIEWER, audit, get, insert, op_record, op_seen,
                   update)
from .db import get_setting
from .master_import import mapped_fields
from .util import new_id, parse_date, today, utc_now

CATEGORIES = ("不可替代特殊藥品", "特殊藥品", "不可替代必要藥品", "必要藥品", "取消認定", "其他", "待確認")
EDIT_ROLES = (ROLE_CLERK, ROLE_REVIEWER)


def _date(v, label):
    if v in (None, ""):
        return None
    d = parse_date(v)
    if d is None:
        raise BizError(f"{label}「{v}」無法解析；未知請留空。")
    return d


def create_recognition(ctx: Ctx, *, name, recognition_no=None, unit=None, description=None) -> str:
    ctx.require(*EDIT_ROLES)
    if not name:
        raise BizError("請輸入認定名稱。")
    with ctx.tx():
        if recognition_no is None:
            n = ctx.con.execute("SELECT COUNT(*) FROM recognition").fetchone()[0] + 1
            while ctx.con.execute("SELECT 1 FROM recognition WHERE recognition_no=?", (f"R{n:05d}",)).fetchone():
                n += 1
            recognition_no = f"R{n:05d}"
        dup = ctx.con.execute("SELECT recognition_no FROM recognition WHERE name=?", (name,)).fetchone()
        if dup:
            raise BizError(f"已有同名認定項目（{dup[0]}），請改建立變更版本以避免重複認定。")
        return insert(ctx, "recognition", dict(recognition_no=recognition_no, name=name, unit=unit,
                                               description=description))


def create_revision(ctx: Ctx, recognition_id, *, category, original_category=None, scope_text=None, rule=None,
                    conditions_text=None, effective_from=None, effective_to=None, decision_ids=(), case_id=None,
                    supersedes_id=None, correction_reason=None, completeness=None) -> str:
    ctx.require(*EDIT_ROLES)
    if category not in CATEGORIES:
        raise BizError("認定類別不正確。")
    if rule is not None:
        rules.validate(rule)
    if supersedes_id:
        old = get(ctx, "recognition_revision", supersedes_id)
        if not old or old["recognition_id"] != recognition_id:
            raise BizError("被更正版本不屬於此認定項目。")
        if not correction_reason:
            raise BizError("更正版本須填寫更正原因。")
    ef = _date(effective_from, "生效日")
    et = _date(effective_to, "迄日")
    if ef and et and et <= ef:
        raise BizError("迄日須晚於起日（起日含、迄日不含）。")
    if completeness is None:
        completeness = "完整" if ef and (decision_ids or case_id) else "不完整"
    with ctx.tx():
        no = ctx.con.execute("SELECT COALESCE(MAX(revision_no),0)+1 FROM recognition_revision WHERE recognition_id=?",
                             (recognition_id,)).fetchone()[0]
        rid = insert(ctx, "recognition_revision", dict(
            recognition_id=recognition_id, revision_no=no, category=category, original_category=original_category,
            scope_text=scope_text, rule_json=rules.canonical(rule) if rule is not None else None,
            conditions_text=conditions_text, effective_from=ef, effective_to=et,
            decision_id=decision_ids[0] if decision_ids else None, case_id=case_id,
            supersedes_id=supersedes_id, correction_reason=correction_reason, completeness=completeness))
        for did in decision_ids:
            ctx.con.execute("INSERT INTO revision_decision(revision_id, decision_id, link_type) VALUES (?,?,?)",
                            (rid, did, "依據"))
    return rid


def update_revision(ctx: Ctx, revision_id, changes: dict, expected_version=None):
    ctx.require(*EDIT_ROLES)
    rev = get(ctx, "recognition_revision", revision_id)
    if rev["confirm_status"] not in ("草稿", "待確認"):
        raise BizError("已確認或撤銷的版本不可修改；請建立更正版本。")
    changes = dict(changes)
    if "rule" in changes:
        r = changes.pop("rule")
        if r is not None:
            rules.validate(r)
        changes["rule_json"] = rules.canonical(r) if r is not None else None
    for k in ("effective_from", "effective_to"):
        if k in changes:
            changes[k] = _date(changes[k], k)
    allowed = {"category", "original_category", "scope_text", "rule_json", "conditions_text", "effective_from",
               "effective_to", "case_id", "completeness", "decision_id"}
    bad = set(changes) - allowed
    if bad:
        raise BizError(f"不可修改：{', '.join(sorted(bad))}")
    with ctx.tx():
        return update(ctx, "recognition_revision", revision_id, changes, expected_version)


def submit_revision(ctx: Ctx, revision_id):
    ctx.require(*EDIT_ROLES)
    with ctx.tx():
        rev = get(ctx, "recognition_revision", revision_id)
        if rev["confirm_status"] != "草稿":
            raise BizError("只有草稿可送待確認。")
        update(ctx, "recognition_revision", revision_id, {"confirm_status": "待確認"})


def withdraw_revision(ctx: Ctx, revision_id, reason):
    ctx.require(*EDIT_ROLES)
    if not reason:
        raise BizError("撤銷須填寫原因。")
    with ctx.tx():
        rev = get(ctx, "recognition_revision", revision_id)
        if rev["confirm_status"] == "已確認":
            raise BizError("已確認版本不可撤銷覆寫；請建立取消或更正版本。")
        update(ctx, "recognition_revision", revision_id, {"confirm_status": "撤銷"}, reason=reason)


# ---------------- 預覽與快照 ----------------

def evaluator(con) -> rules.Evaluator:
    return rules.Evaluator(json.loads(get_setting(con, "known_units", "[]")),
                           json.loads(get_setting(con, "unit_conversions", "{}")))


def preview(con, rule: dict, import_id: str) -> dict:
    """依主檔版本預覽符合名單；空規則、未映射欄位均報錯。"""
    if not import_id:
        raise BizError("尚未選取主檔版本。")
    rules.validate(rule)
    used = rules.fields_used(rule)
    available = mapped_fields(con, import_id)
    need = set()
    for f in used:
        col = rules.FIELDS[f][2]
        need |= set(col) if isinstance(col, tuple) else {col}
    missing = sorted(need - available - {"drug_code"})
    if missing:
        raise BizError("此主檔版本未映射欄位：" + "、".join(missing) + "；相關規則停用，請改用含該欄位的主檔或修改條件。")
    ev = evaluator(con)
    members = []
    group_total = {}
    for r in con.execute("SELECT * FROM master_drug WHERE import_id=?", (import_id,)):
        d = dict(r)
        g = d.get("group_code")
        if g:
            group_total[g] = group_total.get(g, 0) + 1
        res, path = ev.evaluate(rule, d)
        if res != rules.FALSE:
            members.append({"drug_code": d["drug_code"], "result": res, "path": path, "group_code": g,
                            "drug_name": d.get("drug_name"), "firm": d.get("firm"),
                            "spec": f"{d.get('spec_qty') or ''}{d.get('spec_unit') or ''}",
                            "source_row": d.get("source_row")})
    groups = {}
    for m in members:
        g = m["group_code"]
        if not g:
            continue
        x = groups.setdefault(g, {"group_code": g, "matched": 0, "pending": 0, "total": group_total.get(g, 0)})
        x["matched" if m["result"] == rules.TRUE else "pending"] += 1
    for g in groups.values():
        g["partial"] = (g["matched"] + g["pending"]) < g["total"]
    match = sum(1 for m in members if m["result"] == rules.TRUE)
    pending = len(members) - match
    warnings = []
    if match + pending == 0:
        warnings.append("零筆符合，請檢查條件。")
    threshold = int(get_setting(con, "large_scope_threshold", "500"))
    if match + pending > threshold:
        warnings.append(f"符合筆數 {match + pending} 超過警示門檻 {threshold}，請確認範圍。")
    partial = [g["group_code"] for g in groups.values() if g["partial"]]
    if partial:
        warnings.append("部分涵蓋分組：" + "、".join(partial) + "；分組調價方式須另確認，不得直接將整組排除DET。")
    if rules.has_manual(rule):
        warnings.append("含人工條件（如跨品項關係），相關品項列為待確認，須逐項人工確認。")
    reasons = pending_reasons(members)
    if reasons:
        warnings.append("待確認原因：" + "；".join(f"{k} {v}筆" for k, v in reasons.items()))
    return {"members": members, "match": match, "pending": pending, "groups": sorted(groups.values(),
            key=lambda g: g["group_code"]), "warnings": warnings, "rule_hash": rules.rule_hash(rule),
            "import_id": import_id}


def save_snapshot(ctx: Ctx, revision_id, import_id) -> str:
    """以版本目前的規則及指定主檔重新判定並保存快照（證據），不覆寫既有快照。"""
    ctx.require(*EDIT_ROLES)
    rev = get(ctx, "recognition_revision", revision_id)
    if not rev or not rev["rule_json"]:
        raise BizError("此版本尚未設定適用條件。")
    if rev["confirm_status"] == "撤銷":
        raise BizError("已撤銷版本不可建立快照。")
    rule = json.loads(rev["rule_json"])
    pv = preview(ctx.con, rule, import_id)
    with ctx.tx():
        sid = new_id()
        ctx.con.execute(
            "INSERT INTO scope_snapshot(id, revision_id, import_id, rule_hash, rule_json, evaluated_at, match_count,"
            " pending_count, status) VALUES (?,?,?,?,?,?,?,?,'預覽')",
            (sid, revision_id, import_id, pv["rule_hash"], rev["rule_json"], utc_now(), pv["match"], pv["pending"]))
        ctx.con.executemany(
            "INSERT INTO scope_member(snapshot_id, drug_code, eval_result, path, group_code, source_row)"
            " VALUES (?,?,?,?,?,?)",
            [(sid, m["drug_code"], m["result"], m["path"], m["group_code"], m["source_row"]) for m in pv["members"]])
        audit(ctx, "scope_snapshot", sid, "建立快照", after={"revision_id": revision_id, "import_id": import_id,
                                                         "match": pv["match"], "pending": pv["pending"]})
    return sid


def set_member_decision(ctx: Ctx, snapshot_id, drug_code, decision, reason):
    """人工確認：納入／排除，須理由。"""
    ctx.require(*EDIT_ROLES)
    if decision not in ("納入", "排除"):
        raise BizError("人工確認結果須為「納入」或「排除」。")
    if not reason:
        raise BizError("人工確認須填寫理由。")
    snap = get(ctx, "scope_snapshot", snapshot_id)
    if snap["status"] != "預覽":
        raise BizError("已確認快照不可修改；如需調整請建立新快照。")
    with ctx.tx():
        cur = ctx.con.execute("SELECT * FROM scope_member WHERE snapshot_id=? AND drug_code=?",
                              (snapshot_id, drug_code)).fetchone()
        if not cur:
            raise BizError("此品項不在快照名單內；範圍外品項須另補認定依據。")
        ctx.con.execute("UPDATE scope_member SET manual_result=?, manual_reason=? WHERE snapshot_id=? AND drug_code=?",
                        (decision, reason, snapshot_id, drug_code))
        audit(ctx, "scope_member", f"{snapshot_id}:{drug_code}", "人工確認",
              {"manual_result": cur["manual_result"]}, {"manual_result": decision}, reason)


def pending_reasons(members) -> dict:
    out = {}
    for m in members:
        if m.get("result", m.get("eval_result")) == rules.UNKNOWN:
            out[m["path"]] = out.get(m["path"], 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def bulk_member_decision(ctx: Ctx, snapshot_id, path, decision, reason) -> int:
    """依同一待確認原因批次人工確認（明確選定原因，作用範圍即該原因的全部品項）。"""
    ctx.require(*EDIT_ROLES)
    if decision not in ("納入", "排除") or not reason:
        raise BizError("請選納入／排除並填寫理由。")
    snap = get(ctx, "scope_snapshot", snapshot_id)
    if snap["status"] != "預覽":
        raise BizError("已確認快照不可修改。")
    codes = [r[0] for r in ctx.con.execute(
        "SELECT drug_code FROM scope_member WHERE snapshot_id=? AND eval_result='待確認' AND path=?",
        (snapshot_id, path))]
    with ctx.tx():
        ctx.con.execute("UPDATE scope_member SET manual_result=?, manual_reason=? WHERE snapshot_id=? AND"
                        " eval_result='待確認' AND path=?", (decision, reason, snapshot_id, path))
        audit(ctx, "scope_snapshot", snapshot_id, "批次人工確認",
              after={"path": path, "decision": decision, "count": len(codes), "codes": codes}, reason=reason)
    return len(codes)


def confirm_snapshot(ctx: Ctx, snapshot_id):
    ctx.require(*EDIT_ROLES)
    snap = get(ctx, "scope_snapshot", snapshot_id)
    rev = get(ctx, "recognition_revision", snap["revision_id"])
    if snap["status"] != "預覽":
        raise BizError("快照狀態不是預覽。")
    if rules.rule_hash(json.loads(rev["rule_json"])) != snap["rule_hash"]:
        raise BizError("預覽後規則已變更，請重新預覽建立新快照。")
    undecided = ctx.con.execute(
        "SELECT COUNT(*) FROM scope_member WHERE snapshot_id=? AND eval_result='待確認' AND manual_result IS NULL",
        (snapshot_id,)).fetchone()[0]
    if undecided:
        raise BizError(f"尚有 {undecided} 筆待確認品項未人工確認，不能確認範圍名單。")
    with ctx.tx():
        update_snapshot(ctx, snapshot_id, {"status": "已確認", "confirmed_by": ctx.actor, "confirmed_at": utc_now()})


def update_snapshot(ctx, snapshot_id, changes):
    before = get(ctx, "scope_snapshot", snapshot_id)
    sets = ", ".join(f"{k}=?" for k in changes)
    ctx.con.execute(f"UPDATE scope_snapshot SET {sets} WHERE id=?", [*changes.values(), snapshot_id])
    audit(ctx, "scope_snapshot", snapshot_id, "修改", before, dict(before, **changes))


def snapshot_members(con, snapshot_id) -> list[dict]:
    """快照最終名單：符合且未排除，或人工納入。"""
    return [dict(r) for r in con.execute(
        "SELECT * FROM scope_member WHERE snapshot_id=? AND ((eval_result='符合' AND COALESCE(manual_result,'')<>'排除')"
        " OR manual_result='納入') ORDER BY drug_code", (snapshot_id,))]


def current_rule_hash(con, revision_id) -> str | None:
    """版本目前規則的雜湊；未設定規則為None。"""
    row = con.execute("SELECT rule_json FROM recognition_revision WHERE id=?", (revision_id,)).fetchone()
    return rules.rule_hash(json.loads(row[0])) if row and row[0] else None


def confirmed_snapshot(con, revision_id):
    """與目前規則一致的最新已確認快照；規則變更後的舊快照不採用。"""
    row = con.execute("SELECT * FROM scope_snapshot WHERE revision_id=? AND status='已確認' AND rule_hash IS ?"
                      " ORDER BY confirmed_at DESC LIMIT 1",
                      (revision_id, current_rule_hash(con, revision_id))).fetchone()
    return dict(row) if row else None


def revision_scope(con, revision_id) -> set:
    """版本的認定範圍代碼：與目前規則一致的已確認快照之聯集（新符合經確認後形成新快照）。"""
    codes = set()
    for s in con.execute("SELECT id FROM scope_snapshot WHERE revision_id=? AND status='已確認' AND rule_hash IS ?",
                         (revision_id, current_rule_hash(con, revision_id))):
        codes |= {m["drug_code"] for m in snapshot_members(con, s[0])}
    return codes


# ---------------- 確認與現行狀態 ----------------

def confirm_revision(ctx: Ctx, revision_id, *, op_id=None, conflict_basis=None) -> str:
    """複核登記者確認。範圍需已確認快照；與其他認定類別衝突時須指定處理依據。"""
    ctx.require(ROLE_REVIEWER)
    done = op_seen(ctx, op_id)
    if done:
        return done
    with ctx.tx():
        rev = get(ctx, "recognition_revision", revision_id)
        if rev["confirm_status"] == "已確認":
            return revision_id
        if rev["confirm_status"] not in ("草稿", "待確認"):
            raise BizError("撤銷版本不可確認。")
        if rev["rule_json"] and rev["category"] != "取消認定":
            snap = confirmed_snapshot(ctx.con, revision_id)
            if not snap:
                if ctx.con.execute("SELECT 1 FROM scope_snapshot WHERE revision_id=? AND status='已確認'",
                                   (revision_id,)).fetchone():
                    raise BizError("已確認快照的規則雜湊與目前規則不一致（預覽後規則已變更），"
                                   "請重新預覽並確認新快照後再確認認定。")
                raise BizError("適用條件尚未確認範圍名單（快照），不能確認認定。")
        conflicts = category_conflicts(ctx.con, revision_id)
        if conflicts and not conflict_basis:
            lines = "；".join(f"{c['drug_code']}：{c['other_name']}（{c['other_category']}）" for c in conflicts[:10])
            raise BizError(f"與其他認定類別衝突 {len(conflicts)} 筆，請指定處理依據後再確認：{lines}")
        changes = {"confirm_status": "已確認", "confirmed_by": ctx.actor, "confirmed_at": utc_now()}
        update(ctx, "recognition_revision", revision_id, changes,
               reason=f"衝突處理依據：{conflict_basis}" if conflict_basis else None)
        op_record(ctx, op_id, "confirm_revision", revision_id)
    return revision_id


def _active_revisions(con, recognition_id):
    """排除被更正取代者後的已確認版本。"""
    revs = [dict(r) for r in con.execute(
        "SELECT * FROM recognition_revision WHERE recognition_id=? AND confirm_status='已確認' ORDER BY revision_no",
        (recognition_id,))]
    replaced = {r["supersedes_id"] for r in revs if r["supersedes_id"]}
    return [r for r in revs if r["id"] not in replaced]


def status_on(con, recognition_id, day=None) -> dict:
    """指定日期之認定狀態；現行有效由查詢日期計算，不依排程。"""
    day = day or today()
    revs = _active_revisions(con, recognition_id)
    if not revs:
        has_draft = con.execute("SELECT 1 FROM recognition_revision WHERE recognition_id=? AND confirm_status IN"
                                " ('草稿','待確認')", (recognition_id,)).fetchone()
        return {"state": "草稿／待確認" if has_draft else "無已確認版本", "revision": None}
    applicable = [r for r in revs if r["effective_from"] and r["effective_from"] <= day
                  and (not r["effective_to"] or day < r["effective_to"])]
    if applicable:
        cur = applicable[-1]
        if cur["category"] == "取消認定":
            return {"state": "已取消", "revision": cur}
        return {"state": "有效", "revision": cur}
    future = [r for r in revs if r["effective_from"] and r["effective_from"] > day]
    if future:
        return {"state": "待生效", "revision": future[0]}
    unknown = [r for r in revs if not r["effective_from"]]
    if unknown:
        return {"state": "生效日待確認", "revision": unknown[-1]}
    return {"state": "已失效", "revision": revs[-1]}


def revision_history(con, recognition_id, day=None) -> list[dict]:
    """認定項目全部已確認版本：期間（起日含、迄日不含；迄日為版本迄日或下一版本起日較早者）及指定日期狀態。

    含已取消、已失效、已被更正取代者；不覆寫任何歷程。
    """
    day = day or today()
    revs = [dict(r) for r in con.execute(
        "SELECT * FROM recognition_revision WHERE recognition_id=? AND confirm_status='已確認' ORDER BY revision_no",
        (recognition_id,))]
    replaced = {r["supersedes_id"] for r in revs if r["supersedes_id"]}
    timeline = sorted((r for r in revs if r["id"] not in replaced and r["effective_from"]),
                      key=lambda r: (r["effective_from"], r["revision_no"]))
    st = status_on(con, recognition_id, day)
    cur_id = st["revision"]["id"] if st["revision"] else None
    out = []
    for r in revs:
        nxt = None
        if r["effective_from"] and r["id"] not in replaced:
            nxt = next((t for t in timeline if t["effective_from"] > r["effective_from"]), None)
        end = r["effective_to"]
        if nxt and (not end or nxt["effective_from"] < end):
            end = nxt["effective_from"]
        if r["id"] in replaced:
            state = "已更正取代"
        elif r["id"] == cur_id:
            state = st["state"]
        elif not r["effective_from"]:
            state = "生效日待確認"
        elif r["effective_from"] > day:
            state = "待生效"
        elif nxt and end == nxt["effective_from"] and nxt["effective_from"] <= day and nxt["category"] == "取消認定":
            state = "已取消"
        else:
            state = "已失效"
        out.append(dict(r, state=state, period_end=end, current=r["id"] == cur_id))
    return out


def drug_recognitions(con, drug_code, day=None) -> list[dict]:
    """該藥曾被涵蓋的全部認定版本（含已取消、已失效），標示各版本狀態與期間。

    covers：此版本範圍（與目前規則一致之已確認快照）含該藥；取消認定版本一併列出。
    current：該認定項目於指定日期所採的版本。
    """
    day = day or today()
    out = []
    rows = con.execute(
        "SELECT DISTINCT rv.recognition_id FROM scope_member sm JOIN scope_snapshot ss ON ss.id=sm.snapshot_id"
        " JOIN recognition_revision rv ON rv.id=ss.revision_id WHERE sm.drug_code=? AND ss.status='已確認'",
        (drug_code,)).fetchall()
    for (rec_id,) in rows:
        hist = revision_history(con, rec_id, day)
        covers = {h["id"]: drug_code in revision_scope(con, h["id"]) for h in hist}
        if not any(covers.values()):
            continue
        rec = get(con, "recognition", rec_id)
        for h in hist:
            if not covers[h["id"]] and h["category"] != "取消認定":
                continue
            out.append({"recognition_id": rec_id, "recognition_no": rec["recognition_no"], "name": rec["name"],
                        "state": h["state"], "category": h["category"], "revision_id": h["id"],
                        "revision_no": h["revision_no"], "effective_from": h["effective_from"],
                        "effective_to": h["effective_to"], "period_end": h["period_end"],
                        "current": h["current"], "covers": covers[h["id"]]})
    return out


def drug_category_on(con, drug_code, day=None) -> dict:
    """單一類別；多來源類別衝突時不產生單一結果，不採最後儲存者優先。"""
    srcs = [s for s in drug_recognitions(con, drug_code, day) if s["current"] and s["covers"] and s["state"] == "有效"]
    cats = {s["category"] for s in srcs}
    if len(cats) > 1:
        return {"category": None, "conflict": True, "sources": srcs}
    return {"category": next(iter(cats)) if cats else None, "conflict": False, "sources": srcs}


def category_conflicts(con, revision_id) -> list[dict]:
    rev = get(con, "recognition_revision", revision_id)
    if rev["category"] in ("取消認定", "待確認"):
        return []
    mine = revision_scope(con, revision_id)
    out = []
    for other in con.execute(
            "SELECT rv.*, r.name FROM recognition_revision rv JOIN recognition r ON r.id=rv.recognition_id"
            " WHERE rv.confirm_status='已確認' AND rv.recognition_id<>? AND rv.category NOT IN ('取消認定','待確認')",
            (rev["recognition_id"],)):
        if other["category"] == rev["category"]:
            continue
        if not _overlap(rev["effective_from"], rev["effective_to"], other["effective_from"], other["effective_to"]):
            continue
        for code in sorted(mine & revision_scope(con, other["id"])):
            out.append({"drug_code": code, "other_name": other["name"], "other_category": other["category"],
                        "other_revision_id": other["id"]})
    return out


def _overlap(a1, a2, b1, b2) -> bool:
    if not a1 or not b1:
        return True  # 期間未知時保守視為可能重疊
    return a1 < (b2 or "9999-12-31") and b1 < (a2 or "9999-12-31")


# ---------------- 分組調價方式 ----------------

def set_group_treatment(ctx: Ctx, *, group_code, revision_id, method, effective_from=None, effective_to=None,
                        basis=None, partial_cover=None) -> str:
    """分組適用DET／第25條／待確認。部分涵蓋分組不得自動推導整組；起日不由會議日推定。"""
    ctx.require(*EDIT_ROLES)
    if method not in ("DET", "第25條", "待確認"):
        raise BizError("調價方式不正確。")
    if partial_cover is None:
        snap = confirmed_snapshot(ctx.con, revision_id)
        partial_cover = 0
        if snap:
            total = ctx.con.execute("SELECT COUNT(*) FROM master_drug WHERE import_id=? AND group_code=?",
                                    (snap["import_id"], group_code)).fetchone()[0]
            inside = sum(1 for m in snapshot_members(ctx.con, snap["id"]) if m["group_code"] == group_code)
            partial_cover = int(inside < total)
    if method == "第25條" and partial_cover and not basis:
        raise BizError("此分組僅部分涵蓋，改依第25條須填寫依據。")
    with ctx.tx():
        return insert(ctx, "group_treatment", dict(
            group_code=group_code, revision_id=revision_id, method=method, partial_cover=int(bool(partial_cover)),
            effective_from=_date(effective_from, "起日"), effective_to=_date(effective_to, "迄日"), basis=basis))


def confirm_group_treatment(ctx: Ctx, gt_id):
    ctx.require(ROLE_REVIEWER)
    gt = get(ctx, "group_treatment", gt_id)
    if gt["method"] != "待確認" and not gt["effective_from"]:
        raise BizError("適用起日未確認（Q01），請保留待確認，不由會議日推定。")
    with ctx.tx():
        update(ctx, "group_treatment", gt_id, {"confirm_status": "已確認"})


def list_recognitions(con, keyword=None, day=None) -> list[dict]:
    day = day or today()
    sql = "SELECT * FROM recognition"
    args = []
    if keyword:
        sql += (" WHERE name LIKE ? OR recognition_no LIKE ? OR id IN (SELECT rv.recognition_id FROM recognition_revision rv"
                " LEFT JOIN scope_snapshot ss ON ss.revision_id=rv.id LEFT JOIN scope_member sm ON sm.snapshot_id=ss.id"
                " WHERE rv.scope_text LIKE ? OR rv.rule_json LIKE ? OR sm.drug_code LIKE ? OR sm.group_code LIKE ?)")
        args = [f"%{keyword}%"] * 6
    sql += " ORDER BY recognition_no"
    out = []
    for r in con.execute(sql, args).fetchall():
        st = status_on(con, r["id"], day)
        rev = st["revision"]
        latest = con.execute("SELECT * FROM recognition_revision WHERE recognition_id=? ORDER BY revision_no DESC"
                             " LIMIT 1", (r["id"],)).fetchone()
        scope = revision_scope(con, rev["id"]) if rev else set()
        pend = con.execute("SELECT COUNT(*) FROM recognition_revision WHERE recognition_id=? AND"
                           " confirm_status IN ('草稿','待確認')", (r["id"],)).fetchone()[0]
        out.append(dict(r, state=st["state"], category=(rev or latest or {})["category"] if (rev or latest) else None,
                        drug_count=len(scope), pending_revisions=pend,
                        last_updated=(latest["updated_at"] if latest else r["updated_at"])))
    return out
