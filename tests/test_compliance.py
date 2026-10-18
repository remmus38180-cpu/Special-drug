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
