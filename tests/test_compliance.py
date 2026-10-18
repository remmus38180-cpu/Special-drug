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


# ---------------- §5、§9.1-3、T15、T22 附件下載與入口 ----------------

def test_viewer_downloads_attachment_with_hash_check(tmp_path):
    from specdrug import cases as C
    from specdrug.attachments import add_attachment, fetch_attachment
    from specdrug.auth import set_user
    from specdrug.core import Ctx, PermissionDenied, ROLE_VIEWER
    from specdrug.store import StoreError
    from specdrug.workspace import Workspace
    s, ws = _shared(tmp_path)
    ws.start_edit()
    set_user(ws.ctx(), "viewer", [ROLE_VIEWER])
    cid = C.create_case(ws.ctx(), subject="附件案")
    f = tmp_path / "決議.pdf"
    f.write_bytes(b"minutes")
    aid = add_attachment(ws.ctx(), f, "case_record", cid, ws.pending_dir)
    # 編輯者發布前可由本機待上傳區取得
    assert ws.fetch_attachment(aid, tmp_path / "pre.pdf").read_bytes() == b"minutes"
    ws.publish()
    ws.end_edit("keep")
    q = Workspace(tmp_path / "q", s.root, "viewer")
    q.refresh_view()
    assert not q.editing
    out = q.fetch_attachment(aid, tmp_path / "dl" / "x.pdf")
    assert out.read_bytes() == b"minutes"
    # 無角色帳號不得下載
    with pytest.raises(PermissionDenied):
        fetch_attachment(Ctx(q.con, "nobody", set(), False), aid, tmp_path / "n.pdf", store=s)
    # 共用槽檔案遭竄改→雜湊不符，不留下壞檔
    a = q.con.execute("SELECT storage_key FROM attachment WHERE id=?", (aid,)).fetchone()
    (s.attachments / a[0]).write_bytes(b"tampered")
    dest = tmp_path / "bad.pdf"
    with pytest.raises(StoreError, match="雜湊不符"):
        q.fetch_attachment(aid, dest)
    assert not dest.exists()
    q.close()
    ws.close()


def test_attachment_targets_for_decision_agenda_revision_price(ctx, master, tmp_path):
    from specdrug import cases as C
    from specdrug import pricing as P
    from specdrug.attachments import add_attachment, attachment_targets, attachments_of
    cid = C.create_case(ctx, subject="入口案", drugs=["B000004100"])
    mid = C.create_meeting(ctx, meeting_type="專家", name="專家會議", meeting_date="2026-05-01")
    ag = C.add_agenda(ctx, meeting_id=mid, case_id=cid)
    dec = C.add_decision(ctx, agenda_id=ag, nature="專家建議", result="同意")
    t = attachment_targets(ctx.con, "case_record", cid)
    assert [(e, i) for e, i, _ in t] == [("case_record", cid), ("meeting_agenda", ag), ("decision", dec)]
    assert [(e, i) for e, i, _ in attachment_targets(ctx.con, "meeting", mid)] == [
        ("meeting", mid), ("meeting_agenda", ag), ("decision", dec)]
    rec = R.create_recognition(ctx, name="附件認定")
    rev = R.create_revision(ctx, rec, category="特殊藥品", rule=B4, effective_from="2020-01-01", decision_ids=[dec])
    R.confirm_snapshot(ctx, R.save_snapshot(ctx, rev, master))
    R.confirm_revision(ctx, rev)
    assert [(e, i) for e, i, _ in attachment_targets(ctx.con, "recognition_revision", rev)] == [
        ("recognition_revision", rev), ("decision", dec)]
    pa = P.create_price_action(ctx, revision_id=rev, drug_code="B000004100")
    assert [(e, i) for e, i, _ in attachment_targets(ctx.con, "price_action", pa)] == [("price_action", pa)]
    f = tmp_path / "a.pdf"
    f.write_bytes(b"x")
    for e, i in (("decision", dec), ("meeting_agenda", ag), ("recognition_revision", rev), ("price_action", pa)):
        add_attachment(ctx, f, e, i, tmp_path / "pending")
        assert len(attachments_of(ctx.con, e, i)) == 1


# ---------------- B16 歷史類別名稱不作為認定類別；移轉對照保留 ----------------

def test_historical_category_names_removed(ctx):
    from specdrug import migration as MG
    assert "不可替代必要藥品" not in R.CATEGORIES and "必要藥品" not in R.CATEGORIES
    rec = R.create_recognition(ctx, name="類別")
    for cat in ("不可替代必要藥品", "必要藥品"):
        with pytest.raises(BizError, match="類別"):
            R.create_revision(ctx, rec, category=cat)
    assert MG.HIST_TO_STD["不可替代必要藥品"] == "不可替代特殊藥品" and MG.HIST_TO_STD["必要藥品"] == "特殊藥品"
    rev = R.create_revision(ctx, rec, category="特殊藥品")
    with pytest.raises(BizError, match="類別"):
        R.update_revision(ctx, rev, {"category": "必要藥品"})


# ---------------- 次要：Excel移轉 ----------------

def _workbook(tmp_path, rows, name="w.xlsx"):
    import openpyxl
    from specdrug import migration as MG
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "final"
    ws.append([MG.COLS[k] for k in MG.COLS])
    base = {k: None for k in MG.COLS}
    for r in rows:
        ws.append([dict(base, **r)[k] for k in MG.COLS])
    wb.save(tmp_path / name)
    return tmp_path / name


def test_migration_expert_meeting_is_expert_advice(ctx, tmp_path):
    from specdrug import cases as C
    from specdrug import migration as MG
    p = _workbook(tmp_path, [dict(seq="1", group_code="G1", category="特殊藥品", rule="分組代碼=G1",
                                  history="專家會議113年3月\n擬訂會議113年8月")])
    MG.stage_workbook(ctx, p)
    res = MG.commit_row(ctx, MG.list_rows(ctx.con)[0]["id"])
    tl = C.case_timeline(ctx.con, res["case_id"])
    assert [(a["meeting_type"], a["decisions"][0]["nature"]) for a in tl] == [("專家", "專家建議"),
                                                                              ("共同擬訂", "會議決議")]


def test_migration_meetings_not_auto_merged(ctx, tmp_path):
    from specdrug import cases as C
    from specdrug import migration as MG
    p = _workbook(tmp_path, [dict(seq="1", group_code="G1", category="特殊藥品", rule="分組代碼=G1",
                                  history="擬訂會議113年8月"),
                             dict(seq="2", group_code="G2", category="特殊藥品", rule="分組代碼=G2",
                                  history="擬訂會議113年8月")])
    MG.stage_workbook(ctx, p)
    res = [MG.commit_row(ctx, r["id"]) for r in MG.list_rows(ctx.con)]
    mids = [C.case_timeline(ctx.con, r["case_id"])[0]["meeting_id"] for r in res]
    assert mids[0] != mids[1]  # 不以原文自動合併
    cands = MG.meeting_merge_candidates(ctx.con)
    assert len(cands) == 1 and set(cands[0]["meeting_ids"]) == set(mids)
    with pytest.raises(BizError, match="理由"):
        C.merge_meetings(ctx, mids[0], [mids[1]], "")
    C.merge_meetings(ctx, mids[0], [mids[1]], "人工核對為同一次會議")
    assert [C.case_timeline(ctx.con, r["case_id"])[0]["meeting_id"] for r in res] == [mids[0], mids[0]]
    assert MG.meeting_merge_candidates(ctx.con) == []
    assert ctx.con.execute("SELECT COUNT(*) FROM meeting WHERE id=?", (mids[1],)).fetchone()[0] == 1  # 不硬刪


# ---------------- 次要：主檔啟用須資料基準日、來源檔存附件 ----------------

def test_master_activation_requires_base_date(ctx, tmp_path):
    from conftest import BASE_ROWS, write_master
    from specdrug import master_import as M
    iid = M.stage_import(ctx, write_master(tmp_path / "nb.csv", BASE_ROWS), MAPPING)
    with pytest.raises(BizError, match="資料基準日"):
        M.activate(ctx, iid)
    assert M.active_import_id(ctx.con) is None


def test_import_sources_saved_as_attachments(ctx, tmp_path):
    from conftest import BASE_ROWS, write_master
    from specdrug import master_import as M
    from specdrug import migration as MG
    from specdrug.attachments import attachments_of
    from specdrug.util import sha256_file
    pend = tmp_path / "pending"
    src = write_master(tmp_path / "src.csv", BASE_ROWS)
    iid = M.stage_import(ctx, src, MAPPING, base_date="2026-10-01", pending_dir=pend)
    atts = attachments_of(ctx.con, "master_import", iid)
    assert [a["sha256"] for a in atts] == [sha256_file(src)]
    assert (pend / atts[0]["storage_key"]).exists()
    wb = _workbook(tmp_path, [dict(seq="1", group_code="G1", category="特殊藥品", rule="分組代碼=G1")])
    r = MG.stage_workbook(ctx, wb, pending_dir=pend)
    assert [a["sha256"] for a in attachments_of(ctx.con, "migration_batch", r["batch_id"])] == [sha256_file(wb)]


def test_schema_upgrade_keeps_attachment_links(tmp_path):
    import sqlite3
    from specdrug.db import SCHEMA_VERSION, open_db, schema_version
    p = tmp_path / "old.sqlite"
    con = open_db(p)
    con.execute("INSERT INTO attachment(id, orig_name, storage_key, sha256, size) VALUES ('a','f','k','s',1)")
    con.execute("INSERT INTO attachment_link VALUES ('a','case_record','c1')")
    # 模擬第1版資料結構
    con.executescript("""
        CREATE TABLE t AS SELECT * FROM attachment_link; DROP TABLE attachment_link;
        CREATE TABLE attachment_link (attachment_id TEXT NOT NULL REFERENCES attachment(id), entity TEXT NOT NULL
          CHECK (entity IN ('case_record','meeting','meeting_agenda','decision','contract','recognition_revision','price_action')),
          entity_id TEXT NOT NULL, PRIMARY KEY (attachment_id, entity, entity_id));
        INSERT INTO attachment_link SELECT * FROM t; DROP TABLE t;
        UPDATE meta SET value='1' WHERE key='schema_version';""")
    con.close()
    con = open_db(p)
    assert schema_version(con) == SCHEMA_VERSION >= 2
    assert con.execute("SELECT entity_id FROM attachment_link").fetchone()[0] == "c1"
    con.execute("INSERT INTO attachment_link VALUES ('a','master_import','i1')")
    con.close()
    ro = sqlite3.connect(p)
    assert ro.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    ro.close()


# ---------------- 次要：鎖有效性與指標切換重試 ----------------

@pytest.mark.skipif(__import__("sys").platform == "win32", reason="以POSIX flock模擬伺服端釋放鎖")
def test_editlock_valid_detects_lost_lock(tmp_path):
    import fcntl
    from specdrug.store import EditLock
    p = tmp_path / "edit.lock"
    p.touch()
    lock = EditLock(p)
    lock.acquire()
    assert lock.valid()
    fcntl.flock(lock.fh.fileno(), fcntl.LOCK_UN)  # 模擬伺服端已釋放（如斷線後復原）
    assert not lock.valid()
    other = EditLock(p)
    other.acquire()  # 失效判定未佔住鎖
    other.release()
    lock.release()


def test_switch_retries_permission_error(tmp_path, monkeypatch):
    from specdrug import store as S
    s, ws = _shared(tmp_path)
    ws.start_edit()
    real = S.os.replace
    calls = {"n": 0}

    def flaky(src, dst):
        if str(dst).endswith("current.json") and calls["n"] < 2:
            calls["n"] += 1
            raise PermissionError("檔案被占用")
        return real(src, dst)
    monkeypatch.setattr(S.os, "replace", flaky)
    monkeypatch.setattr(S.time, "sleep", lambda x: None)
    rid = ws.publish()
    assert s.current()["release_id"] == rid and calls["n"] == 2
    before = s.current()["release_id"]

    def always(src, dst):
        if str(dst).endswith("current.json"):
            raise PermissionError("檔案被占用")
        return real(src, dst)
    monkeypatch.setattr(S.os, "replace", always)
    with pytest.raises(PermissionError):
        ws.publish()
    assert s.current()["release_id"] == before
    assert not list(s.control.glob(".current.json.*.tmp"))
    ws.close()
