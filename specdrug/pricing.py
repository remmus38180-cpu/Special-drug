"""公告複核：合約、個別品項調高（price_action）、主檔註記事件。

只有實際調高的品項才註記；範圍外品項不可直接勾入。系統登記確認不取代公文核定。
"""
from __future__ import annotations

import json

from .cases import drug_followup_basis
from .core import (BizError, Ctx, ROLE_CLERK, ROLE_REVIEWER, audit, get, insert, op_record, op_seen,
                   update)
from .db import get_setting
from .recognition import current_rule_hash, revision_scope
from .util import dec_text, normalize_code, parse_date, today, utc_now

EDIT_ROLES = (ROLE_CLERK, ROLE_REVIEWER)


def _date(v, label):
    if v in (None, ""):
        return None
    d = parse_date(v)
    if d is None:
        raise BizError(f"{label}「{v}」無法解析。")
    return d


# ---------------- 合約 ----------------

def create_contract(ctx: Ctx, *, contract_no, firm=None, signed_date=None, effective_from=None, expiry_date=None,
                    doc_version=None, obligations=None, status="辦理中", original_contract_id=None,
                    drugs=()) -> str:
    """original_contract_id：補充協議／新版合約指向原合約，原件保留。"""
    ctx.require(*EDIT_ROLES)
    if not contract_no:
        raise BizError("請輸入合約編號。")
    if status not in ("辦理中", "完成簽署", "終止"):
        raise BizError("合約狀態不正確。")
    if status == "完成簽署" and not signed_date:
        raise BizError("完成簽署須填簽訂日。")
    with ctx.tx():
        cid = insert(ctx, "contract", dict(
            contract_no=contract_no, firm=firm, signed_date=_date(signed_date, "簽訂日"),
            effective_from=_date(effective_from, "生效日"), expiry_date=_date(expiry_date, "到期日"),
            doc_version=doc_version, obligations=obligations, status=status,
            original_contract_id=original_contract_id))
        for d in drugs:
            if isinstance(d, str):
                d = {"drug_code": d}
            add_contract_drug(ctx, cid, **d)
    return cid


def add_contract_drug(ctx: Ctx, contract_id, drug_code, effective_from=None, effective_to=None) -> str:
    ctx.require(*EDIT_ROLES)
    code, err = normalize_code(drug_code)
    if err:
        raise BizError(f"藥品代碼錯誤：{err}")
    with ctx.tx():
        return insert(ctx, "contract_drug", dict(contract_id=contract_id, drug_code=code,
                                                 effective_from=_date(effective_from, "起日"),
                                                 effective_to=_date(effective_to, "迄日")))


def update_contract(ctx: Ctx, contract_id, changes, expected_version=None):
    ctx.require(*EDIT_ROLES)
    for k in ("signed_date", "effective_from", "expiry_date"):
        if k in changes:
            changes[k] = _date(changes[k], k)
    with ctx.tx():
        cur = get(ctx, "contract", contract_id)
        if changes.get("status") == "完成簽署" and not (changes.get("signed_date") or cur["signed_date"]):
            raise BizError("完成簽署須填簽訂日。")
        return update(ctx, "contract", contract_id, changes, expected_version)


def contract_chain(con, contract_id) -> list[dict]:
    """原合約及其後續補充協議／版本。"""
    root = contract_id
    while True:
        r = get(con, "contract", root)
        if not r or not r["original_contract_id"]:
            break
        root = r["original_contract_id"]
    out, queue = [], [root]
    while queue:
        cid = queue.pop(0)
        c = get(con, "contract", cid)
        c["drugs"] = [dict(x) for x in con.execute("SELECT * FROM contract_drug WHERE contract_id=?", (cid,))]
        c["attachments"] = [dict(x) for x in con.execute(
            "SELECT a.* FROM attachment a JOIN attachment_link l ON l.attachment_id=a.id"
            " WHERE l.entity='contract' AND l.entity_id=? ORDER BY a.version", (cid,))]
        out.append(c)
        queue += [r[0] for r in con.execute("SELECT id FROM contract WHERE original_contract_id=? ORDER BY created_at",
                                            (cid,))]
    return out


def contract_alerts(con, day=None, within_days=60) -> list[dict]:
    """到期提醒：只提醒檢視，不自動取消認定、註記或價格。無到期日不猜測。"""
    import datetime as _dt
    day = day or today()
    limit = (_dt.date.fromisoformat(day) + _dt.timedelta(days=within_days)).isoformat()
    return [dict(r, alert="已到期" if r["expiry_date"] < day else "即將到期") for r in con.execute(
        "SELECT * FROM contract WHERE status='完成簽署' AND expiry_date IS NOT NULL AND expiry_date<=?"
        " ORDER BY expiry_date", (limit,))]


def _contract_covers(con, contract_id, drug_code, day) -> bool:
    for r in con.execute("SELECT * FROM contract_drug WHERE contract_id=? AND drug_code=?", (contract_id, drug_code)):
        if (not r["effective_from"] or r["effective_from"] <= day) and (not r["effective_to"] or day < r["effective_to"]):
            return True
    return False


# ---------------- 調高 ----------------

def create_price_action(ctx: Ctx, *, revision_id, drug_code, case_id=None, contract_requirement="待確認",
                        requirement_basis=None, contract_id=None, price_before=None, price_after=None,
                        effective_date=None, announce_doc_no=None, announce_date=None, status="辦理中",
                        completeness="完整", note=None) -> str:
    ctx.require(*EDIT_ROLES)
    code, err = normalize_code(drug_code)
    if err:
        raise BizError(f"藥品代碼錯誤：{err}")
    rev = get(ctx, "recognition_revision", revision_id)
    if not rev:
        raise BizError("找不到認定版本。")
    scope = revision_scope(ctx.con, revision_id)
    if code not in scope:
        raise BizError(f"{code} 不在此認定已確認的範圍名單內；範圍外品項不可直接勾入，須另補認定依據。")
    if case_id and ctx.con.execute("SELECT 1 FROM case_drug WHERE case_id=? AND drug_code=?", (case_id, code)).fetchone():
        if not drug_followup_basis(ctx.con, case_id, code):
            raise BizError(f"{code} 在此案件沒有「同意／附條件同意」的會議決議，不能接續調高。")
    if contract_requirement not in ("須簽約", "當時無須簽約", "待確認"):
        raise BizError("簽約要求不正確。")
    for label, v in (("調高前價格", price_before), ("調高後價格", price_after)):
        if v not in (None, "") and dec_text(v) is None:
            raise BizError(f"{label}無法解析為金額。")
    snap = ctx.con.execute("SELECT ss.id FROM scope_snapshot ss JOIN scope_member sm ON sm.snapshot_id=ss.id"
                           " WHERE ss.revision_id=? AND ss.status='已確認' AND ss.rule_hash IS ? AND sm.drug_code=?"
                           " ORDER BY ss.confirmed_at DESC LIMIT 1",
                           (revision_id, current_rule_hash(ctx.con, revision_id), code)).fetchone()
    with ctx.tx():
        return insert(ctx, "price_action", dict(
            case_id=case_id, drug_code=code, revision_id=revision_id, snapshot_id=snap[0] if snap else None,
            contract_requirement=contract_requirement, requirement_basis=requirement_basis, contract_id=contract_id,
            price_before=dec_text(price_before), price_after=dec_text(price_after),
            effective_date=_date(effective_date, "生效日"), announce_doc_no=announce_doc_no,
            announce_date=_date(announce_date, "公告日期"), status=status, completeness=completeness, note=note))


def update_price_action(ctx: Ctx, pa_id, changes, expected_version=None):
    ctx.require(*EDIT_ROLES)
    pa = get(ctx, "price_action", pa_id)
    if pa["confirm_status"] in ("已確認", "撤銷"):
        raise BizError("已確認的調高紀錄不可修改；請新增更正紀錄。")
    for k in ("price_before", "price_after"):
        if k in changes:
            if changes[k] not in (None, "") and dec_text(changes[k]) is None:
                raise BizError("金額無法解析。")
            changes[k] = dec_text(changes[k])
    for k in ("effective_date", "announce_date"):
        if k in changes:
            changes[k] = _date(changes[k], k)
    with ctx.tx():
        return update(ctx, "price_action", pa_id, changes, expected_version)


def validate_price_action(con, pa: dict) -> list[str]:
    """逐項驗證錯誤；空清單代表可確認。"""
    errs = []
    rev = get(con, "recognition_revision", pa["revision_id"])
    if rev["confirm_status"] != "已確認":
        errs.append("認定版本尚未確認")
    if pa["drug_code"] not in revision_scope(con, pa["revision_id"]):
        errs.append("品項不在已確認範圍名單內")
    if pa["status"] != "已核定":
        errs.append("辦理狀態尚非「已核定」（請於核定後補正式文號、日期）")
    if not pa["announce_doc_no"] or not pa["announce_date"]:
        errs.append("缺正式公告文號或日期")
    if not pa["effective_date"]:
        errs.append("缺調高生效日")
    if pa["price_after"] is None:
        errs.append("缺調高後價格")
    req = pa["contract_requirement"]
    day = pa["effective_date"] or today()
    if req == "須簽約":
        if not pa["contract_id"]:
            errs.append("須簽約但未對應合約（缺件）")
        else:
            c = get(con, "contract", pa["contract_id"])
            if c["status"] != "完成簽署":
                errs.append(f"對應合約狀態為「{c['status']}」，未完成簽署（缺件）")
            elif not _contract_covers(con, c["id"], pa["drug_code"], day):
                errs.append("對應合約未涵蓋此品項或適用期間（缺件）")
    elif req == "當時無須簽約":
        if not pa["requirement_basis"]:
            errs.append("選「當時無須簽約」須填說明／依據")
    # 簽約要求「待確認」：不以案件來源限制確認，由複核登記者依個案判斷；確認時系統標示「不完整」（B17）
    return errs


def create_annotation(ctx: Ctx, *, drug_code, action, category=None, revision_id=None, price_action_id=None,
                      effective_date=None, basis=None, original_event_id=None) -> str:
    ctx.require(*EDIT_ROLES)
    code, err = normalize_code(drug_code)
    if err:
        raise BizError(f"藥品代碼錯誤：{err}")
    if action not in ("新增", "改類", "取消", "更正"):
        raise BizError("註記動作不正確。")
    if action in ("新增", "改類"):
        if not price_action_id:
            raise BizError("只有實際調高的個別品項才註記：新增／改類須連結調高紀錄。")
        pa = get(ctx, "price_action", price_action_id)
        if not pa or pa["drug_code"] != code:
            raise BizError("調高紀錄與註記品項不一致。")
        if not category:
            raise BizError("請選註記類別。")
    if action in ("取消", "更正") and not basis:
        raise BizError("取消或更正註記須填依據；不自動批次取消。")
    if action == "更正" and not original_event_id:
        raise BizError("更正須指定原註記事件。")
    with ctx.tx():
        return insert(ctx, "annotation_event", dict(
            drug_code=code, revision_id=revision_id, price_action_id=price_action_id, category=category,
            action=action, effective_date=_date(effective_date, "註記生效日"), basis=basis,
            original_event_id=original_event_id))


def validate_annotation(con, ev: dict, confirming_pa_ids=()) -> list[str]:
    errs = []
    if not ev["effective_date"]:
        errs.append("缺註記生效日")
    if ev["action"] in ("新增", "改類"):
        pa = get(con, "price_action", ev["price_action_id"])
        if pa["confirm_status"] != "已確認" and pa["id"] not in confirming_pa_ids:
            errs.append("連結的調高紀錄尚未確認")
    return errs


def confirm_announcement(ctx: Ctx, *, price_action_ids=(), annotation_ids=(), op_id=None) -> dict:
    """單一交易確認多筆調高與註記；任一驗證失敗整體不寫入。相同op_id重送只生效一次。"""
    ctx.require(ROLE_REVIEWER)
    done = op_seen(ctx, op_id)
    if done:
        return json.loads(done)
    errors = {}
    for pid in price_action_ids:
        pa = get(ctx, "price_action", pid)
        if pa["confirm_status"] == "已確認":
            continue
        e = validate_price_action(ctx.con, pa)
        if e:
            errors[f"調高 {pa['drug_code']}"] = e
    for aid in annotation_ids:
        ev = get(ctx, "annotation_event", aid)
        if ev["confirm_status"] == "已確認":
            continue
        e = validate_annotation(ctx.con, ev, price_action_ids)
        if e:
            errors[f"註記 {ev['drug_code']}"] = e
    if errors:
        msg = "；".join(f"{k}：{'、'.join(v)}" for k, v in errors.items())
        raise BizError(f"驗證未通過，整批未確認：{msg}")
    result = {"price_actions": list(price_action_ids), "annotations": list(annotation_ids)}
    with ctx.tx():
        now = utc_now()
        for pid in price_action_ids:
            pa = get(ctx, "price_action", pid)
            if pa["confirm_status"] != "已確認":
                changes = {"confirm_status": "已確認", "confirmed_by": ctx.actor, "confirmed_at": now}
                if pa["contract_requirement"] == "待確認":
                    changes["completeness"] = "不完整"
                update(ctx, "price_action", pid, changes)
        for aid in annotation_ids:
            if get(ctx, "annotation_event", aid)["confirm_status"] != "已確認":
                update(ctx, "annotation_event", aid, {"confirm_status": "已確認", "confirmed_by": ctx.actor,
                                                      "confirmed_at": now})
        op_record(ctx, op_id, "confirm_announcement", json.dumps(result))
    return result


def annotation_on(con, drug_code, day=None) -> dict:
    """依已確認註記事件計算指定日期的註記類別。"""
    day = day or today()
    evs = [dict(r) for r in con.execute(
        "SELECT * FROM annotation_event WHERE drug_code=? AND confirm_status='已確認' ORDER BY effective_date, created_at",
        (drug_code,))]
    corrected = {e["original_event_id"]: e for e in evs if e["action"] == "更正"}
    state = None
    unknown_date = False
    for e in evs:
        if e["action"] == "更正":
            continue
        e2 = corrected.get(e["id"], e)
        eff = e2["effective_date"] or e["effective_date"]
        if not eff:
            unknown_date = True
            continue
        if eff > day:
            continue
        if e["action"] in ("新增", "改類"):
            state = e2["category"] or e["category"]
        elif e["action"] == "取消":
            state = None
    return {"category": state, "unknown_date": unknown_date}


def compare_master(con, import_id, day=None) -> list[dict]:
    """主檔必要藥品註記（DRUG_NECESSARY）比對：一致／應有未有／主檔有但無完整依據／類別不同／無法判定。不直接更新正式主檔。"""
    day = day or today()
    cmap = json.loads(get_setting(con, "annotation_code_map", "{}"))
    rev_map = {v: k for k, v in cmap.items()}
    codes = {r[0] for r in con.execute("SELECT DISTINCT drug_code FROM annotation_event WHERE confirm_status='已確認'")}
    master = {}
    for r in con.execute("SELECT drug_code, annotation_raw, drug_name FROM master_drug WHERE import_id=?", (import_id,)):
        master[r[0]] = (r[1], r[2])
        if r[1] in rev_map:
            codes.add(r[0])
    out = []
    for code in sorted(codes):
        sys_state = annotation_on(con, code, day)
        raw, name = master.get(code, (None, None))
        sys_cat = sys_state["category"]
        if code not in master:
            res = "無法判定"
            why = "主檔版本無此代碼（以來源涵蓋範圍判讀，不視為取消）"
        elif sys_state["unknown_date"] and sys_cat is None:
            res, why = "無法判定", "系統註記生效日未知"
        elif raw not in rev_map and raw not in (None, "", "0") :
            res, why = "無法判定", f"必要藥品註記值 {raw} 無對照設定"
        else:
            m_cat = rev_map.get(raw)
            if sys_cat and m_cat:
                res = "一致" if cmap.get(sys_cat) == raw else "類別不同"
                why = f"系統：{sys_cat}；主檔：{m_cat}"
            elif sys_cat and not m_cat:
                res, why = "應有未有", f"系統：{sys_cat}；主檔必要藥品註記未標示"
            elif m_cat and not sys_cat:
                res, why = "主檔有但無完整依據", f"主檔：{m_cat}；系統無已確認註記"
            else:
                res, why = "一致", "皆無註記"
        if res != "一致" or sys_cat:
            out.append({"drug_code": code, "drug_name": name, "result": res, "detail": why,
                        "system_category": sys_cat, "master_raw": raw})
    return out


def generate_diff_todos(ctx: Ctx, new_import_id) -> int:
    """新主檔匯入後比對已確認認定：新符合、不再符合、分組異動 → 差異待辦。不自動註記或調高。

    規則用到新主檔未映射的欄位時，跳過該認定並產生「規則停用」待辦說明原因（§7.2）。
    """
    from .master_import import MASTER_FIELDS
    from .recognition import evaluator, missing_fields
    import json as _j
    ctx.require(*EDIT_ROLES)
    ev = evaluator(ctx.con)
    count = 0
    master = {r["drug_code"]: dict(r) for r in ctx.con.execute("SELECT * FROM master_drug WHERE import_id=?",
                                                                 (new_import_id,))}
    with ctx.tx():
        for rev in ctx.con.execute("SELECT * FROM recognition_revision WHERE confirm_status='已確認' AND rule_json IS NOT NULL"
                                   " AND category<>'取消認定'").fetchall():
            rule = _j.loads(rev["rule_json"])
            scope = revision_scope(ctx.con, rev["id"])
            if not scope:
                continue
            missing = missing_fields(ctx.con, rule, new_import_id)
            if missing:
                count += _todo(ctx, "規則停用", None, None, rev["id"], new_import_id,
                               "新主檔未映射規則欄位：" + "、".join(f"{MASTER_FIELDS.get(c, c)}（{c}）" for c in missing)
                               + "；此認定本次停用比對，未產生新符合／不再符合，請改用含該欄位的主檔或修改條件")
                continue
            snap_groups = {r[0]: r[1] for r in ctx.con.execute(
                "SELECT sm.drug_code, sm.group_code FROM scope_member sm JOIN scope_snapshot ss ON ss.id=sm.snapshot_id"
                " WHERE ss.revision_id=? AND ss.status='已確認' AND ss.rule_hash IS ?",
                (rev["id"], current_rule_hash(ctx.con, rev["id"])))}
            for code, d in master.items():
                res, path = ev.evaluate(rule, d)
                if code not in scope and res != "不符合":
                    count += _todo(ctx, "新符合", code, d.get("group_code"), rev["id"], new_import_id,
                                   f"{res}：{path}；須確認後形成新快照")
                elif code in scope and res == "不符合":
                    count += _todo(ctx, "不再符合", code, d.get("group_code"), rev["id"], new_import_id, path)
                if code in scope and snap_groups.get(code) and d.get("group_code") != snap_groups.get(code):
                    count += _todo(ctx, "分組異動", code, d.get("group_code"), rev["id"], new_import_id,
                                   f"快照分組 {snap_groups.get(code)} → 新主檔 {d.get('group_code')}")
            for code in scope - set(master):
                count += _todo(ctx, "主檔消失", code, None, rev["id"], new_import_id,
                               "新主檔無此代碼；不自動刪除認定或解讀成取消給付")
    return count


def _todo(ctx, kind, code, group, rev_id, import_id, detail) -> int:
    exists = ctx.con.execute("SELECT 1 FROM review_item WHERE kind=? AND drug_code IS ? AND revision_id=? AND import_id=?",
                             (kind, code, rev_id, import_id)).fetchone()
    if exists:
        return 0
    insert(ctx, "review_item", dict(kind=kind, drug_code=code, group_code=group, revision_id=rev_id,
                                    import_id=import_id, detail=detail))
    return 1


def resolve_todo(ctx: Ctx, item_id, status, conclusion):
    ctx.require(*EDIT_ROLES)
    if status not in ("已處理", "不處理") or not conclusion:
        raise BizError("請選處理結果並填寫結論。")
    with ctx.tx():
        update(ctx, "review_item", item_id, {"status": status, "conclusion": conclusion})
