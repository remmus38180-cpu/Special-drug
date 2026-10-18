"""合規修正（規格書v0.3.1）：每項先有失敗測試，再修程式。"""
import pytest

from conftest import MAPPING
from specdrug import recognition as R
from specdrug.core import BizError

B4 = {"field": "drug_code", "op": "eq", "value": "B000004100"}
D5 = {"field": "drug_code", "op": "eq", "value": "0A00005100"}


# ---------------- §11 確認前比對規則雜湊 ----------------

def test_confirm_revision_rejects_snapshot_of_old_rule(ctx, master):
    rec = R.create_recognition(ctx, name="規則變更")
    rev = R.create_revision(ctx, rec, category="特殊藥品", rule=B4, effective_from="2020-01-01")
    R.confirm_snapshot(ctx, R.save_snapshot(ctx, rev, master))
    R.update_revision(ctx, rev, {"rule": D5})
    with pytest.raises(BizError, match="重新預覽"):
        R.confirm_revision(ctx, rev)
    # 舊規則快照不計入範圍
    assert R.revision_scope(ctx.con, rev) == set()
    assert R.confirmed_snapshot(ctx.con, rev) is None
    R.confirm_snapshot(ctx, R.save_snapshot(ctx, rev, master))
    R.confirm_revision(ctx, rev)
    assert R.revision_scope(ctx.con, rev) == {"0A00005100"}


# ---------------- §8.2 已知單位不同且無確認換算 ----------------

@pytest.mark.parametrize("op,expected", [("eq", "不符合"), ("ne", "符合"), ("gt", "待確認"), ("ge", "待確認"),
                                         ("lt", "待確認"), ("le", "待確認")])
def test_qty_known_units_without_conversion(op, expected):
    from specdrug import rules
    ev = rules.Evaluator(["ML", "GM"], {})
    res, _ = ev.evaluate({"field": "spec", "op": op, "value": "5", "unit": "ML"}, {"spec_qty": "5", "spec_unit": "GM"})
    assert res == expected


# ---------------- §5 管理功能限管理者 ----------------

def _shared(tmp_path):
    from specdrug.store import SharedStore
    from specdrug.workspace import Workspace
    s = SharedStore(tmp_path / "share")
    s.init("admin")
    ws = Workspace(tmp_path / "loc", s.root, "admin")
    ws.refresh_view()
    return s, ws


def test_admin_only_backup_restore_envcheck(tmp_path):
    from specdrug.auth import set_user
    from specdrug.core import Ctx, PermissionDenied, ROLE_CLERK, ROLE_REVIEWER, ROLE_VIEWER
    s, ws = _shared(tmp_path)
    ws.start_edit()
    set_user(ws.ctx(), "clerk", [ROLE_CLERK, ROLE_REVIEWER])
    rid = ws.publish()
    clerk = Ctx(ws.con, "clerk", {ROLE_CLERK, ROLE_REVIEWER}, True)
    viewer = Ctx(ws.con, "viewer", {ROLE_VIEWER}, False)
    for c in (clerk, viewer):
        with pytest.raises(PermissionDenied):
            s.backup(rid, ctx=c)
        with pytest.raises(PermissionDenied):
            s.verify_environment(ctx=c)
    bk = s.backup(rid, ctx=ws.ctx())
    assert s.verify_environment(ctx=ws.ctx())["通過"]
    with pytest.raises(PermissionDenied):
        s.restore(ws.lock, bk, ctx=clerk, reason="x", op_id="r-clerk")
    with pytest.raises(PermissionDenied):  # 空角色不得還原
        s.restore(ws.lock, bk, ctx=Ctx(ws.con, "admin", set(), True), reason="x", op_id="r-empty")
    rid2 = s.restore(ws.lock, bk, ctx=ws.ctx(), reason="演練", op_id="r-admin")
    assert s.current()["release_id"] == rid2
    ws.close()


# ---------------- §13、§6.1 還原保留還原前完整稽核歷程 ----------------

def test_restore_merges_current_audit_history(tmp_path):
    import sqlite3
    from specdrug import cases as C
    s, ws = _shared(tmp_path)
    ws.start_edit()
    C.create_case(ws.ctx(), subject="備份前")
    rid1 = ws.publish()
    bk = s.backup(rid1, ctx=ws.ctx())
    C.create_case(ws.ctx(), subject="備份後")
    rid2 = ws.publish()
    con2 = sqlite3.connect(s.releases / rid2 / "data.sqlite")
    before = {r[0] for r in con2.execute("SELECT id FROM audit_event")}
    con2.close()
    rid3 = s.restore(ws.lock, bk, ctx=ws.ctx(), reason="演練", op_id="r-1")
    con3 = sqlite3.connect(s.releases / rid3 / "data.sqlite")
    ids = [r[0] for r in con3.execute("SELECT id FROM audit_event")]
    subjects = [r[0] for r in con3.execute("SELECT subject FROM case_record")]
    after_case = con3.execute("SELECT COUNT(*) FROM audit_event WHERE entity='case_record' AND action='新增'"
                              " AND diff_json LIKE '%備份後%'").fetchone()[0]
    con3.close()
    assert subjects == ["備份前"]  # 業務資料回到備份
    assert before <= set(ids) and len(ids) == len(set(ids))  # 稽核只追加、不重複
    assert after_case == 1
    ws.close()


# ---------------- T21 品項時間序列列出曾涵蓋之全部認定版本 ----------------

def _confirmed_rev(ctx, rec, imp, rule, category, eff_from, eff_to=None):
    rev = R.create_revision(ctx, rec, category=category, rule=rule, effective_from=eff_from, effective_to=eff_to,
                            completeness="完整")
    if rule is not None:
        R.confirm_snapshot(ctx, R.save_snapshot(ctx, rev, imp))
    R.confirm_revision(ctx, rev)
    return rev


def test_drug_timeline_lists_all_revisions(ctx, master):
    from specdrug.query import drug_detail
    rec = R.create_recognition(ctx, name="甲")
    v1 = _confirmed_rev(ctx, rec, master, B4, "特殊藥品", "2020-01-01")
    v2 = _confirmed_rev(ctx, rec, master, None, "取消認定", "2022-01-01")
    v3 = _confirmed_rev(ctx, rec, master, B4, "不可替代特殊藥品", "2024-01-01")
    rec2 = R.create_recognition(ctx, name="乙")
    w1 = _confirmed_rev(ctx, rec2, master, B4, "特殊藥品", "2018-01-01", "2019-01-01")
    srcs = {s["revision_id"]: s for s in R.drug_recognitions(ctx.con, "B000004100", "2025-06-01")}
    assert set(srcs) == {v1, v2, v3, w1}
    assert srcs[v1]["state"] == "已取消" and srcs[v1]["period_end"] == "2022-01-01"
    assert srcs[v2]["state"] == "已失效" and srcs[v2]["period_end"] == "2024-01-01"
    assert srcs[v3]["state"] == "有效" and srcs[v3]["current"]
    assert srcs[w1]["state"] == "已失效" and srcs[w1]["period_end"] == "2019-01-01"
    # 單一類別計算不受歷史版本影響
    assert R.drug_category_on(ctx.con, "B000004100", "2025-06-01")["category"] == "不可替代特殊藥品"
    d = drug_detail(ctx.con, "B000004100", "2025-06-01")
    rec_events = [e for e in d["events"] if e["kind"] == "認定"]
    assert len(rec_events) == 4
    assert {e["status"] for e in rec_events} == {"已取消", "已失效", "有效"}
    assert any("2020-01-01～2022-01-01" in e["text"] for e in rec_events)


# ---------------- §7.2 新主檔缺規則欄位：停用該認定比對 ----------------

def test_diff_todos_skip_rule_with_unmapped_field(ctx, master, tmp_path):
    from conftest import BASE_ROWS, write_master
    from specdrug import master_import as M
    from specdrug import pricing as P
    rec = R.create_recognition(ctx, name="ATC認定")
    _confirmed_rev(ctx, rec, master, {"field": "atc_code", "op": "eq", "value": "L04AA03"}, "特殊藥品", "2020-01-01")
    mapping = {k: v for k, v in MAPPING.items() if k != "atc_code"}
    iid2 = M.stage_import(ctx, write_master(tmp_path / "no_atc.csv", BASE_ROWS), mapping, base_date="2026-11-01")
    M.activate(ctx, iid2)
    P.generate_diff_todos(ctx, iid2)
    P.generate_diff_todos(ctx, iid2)  # 重跑不重複
    kinds = [r[0] for r in ctx.con.execute("SELECT kind FROM review_item")]
    assert kinds == ["規則停用"]
    detail = ctx.con.execute("SELECT detail FROM review_item").fetchone()[0]
    assert "atc_code" in detail
