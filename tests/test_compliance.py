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
