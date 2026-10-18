"""第二輪獨立審查重現測試（規格書 v0.3.1）。

每個測試在目前程式（分支 ccr-77e3d4b8-ar999t @85f84fd）下預期失敗；修正後應通過。
不修改 specdrug/ 程式。測試名稱對應 REVIEW_round2.md 各項。
"""
import csv
import fcntl
import json
import shutil
from pathlib import Path

import pytest

from specdrug import cases as C
from specdrug import master_import as M
from specdrug import pricing as P
from specdrug import recognition as R
from specdrug.auth import set_user
from specdrug.core import BizError, Ctx, PermissionDenied, ROLE_CLERK, ROLE_REVIEWER, ROLE_VIEWER
from specdrug.store import LockLost, SharedStore, StoreError
from specdrug.workspace import Workspace

HEAD = ["CODE", "藥品名稱", "分組代碼", "ATC7碼"]
MAP = {"drug_code": "CODE", "drug_name": "藥品名稱", "group_code": "分組代碼", "atc_code": "ATC7碼"}


def _csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEAD)
        w.writerows(rows)
    return path


def _store(tmp_path):
    s = SharedStore(tmp_path / "share")
    s.init("admin")
    return s


def _publish_users(tmp_path, s, users):
    """管理者在共用槽設定帳號後發布。"""
    ws = Workspace(tmp_path / "adm", s.root, "admin")
    ws.refresh_view()
    ws.start_edit()
    for acc, roles in users.items():
        set_user(ws.ctx(), acc, roles)
    ws.end_edit("publish")
    ws.close()


def _confirmed_revision(ctx, tmp_path):
    """reviewer 建立已確認認定：G1 分組（目前主檔只有 A1、A2）。"""
    iid = M.stage_import(ctx, _csv(tmp_path / "m1.csv", [["A000001100", "A1", "G1", "J01AA01"],
                                                          ["A000002100", "A2", "G1", "J01AA01"]]),
                         MAP, base_date="2026-10-01")
    M.activate(ctx, iid)
    rec = R.create_recognition(ctx, name="G1認定")
    rev = R.create_revision(ctx, rec, category="特殊藥品", rule={"field": "group_code", "op": "eq", "value": "G1"},
                            effective_from="2020-01-01", completeness="完整")
    sid = R.save_snapshot(ctx, rev, iid)
    R.confirm_snapshot(ctx, sid)
    R.confirm_revision(ctx, rev)
    return rev


# ======================================================================
# 一、共用槽鎖定／發布（§4.3、§11、T28、T29）
# ======================================================================

def test_R2_01_revived_editor_cannot_publish_while_new_editor_holds_lock(tmp_path):
    """§4.3、T28：舊編輯者鎖已被伺服端釋放（控制代碼仍開），新編輯者已取得鎖但尚未發布。
    舊編輯者 EditLock.valid() 只判斷「別人試不到鎖」，新編輯者持鎖時誤判仍有效 → 舊者可發布，形成兩個編輯者。"""
    s = _store(tmp_path)
    old = Workspace(tmp_path / "old", s.root, "admin")
    old.refresh_view()
    old.start_edit()
    C.create_case(old.ctx(), subject="舊編輯者草稿")
    fcntl.flock(old.lock.fh.fileno(), fcntl.LOCK_UN)  # 模擬斷線：伺服端釋放鎖，但本機控制代碼仍開啟

    new = Workspace(tmp_path / "new", s.root, "admin")
    new.refresh_view()
    new.start_edit()  # 新編輯者合法取得全系統編輯權，尚未發布
    C.create_case(new.ctx(), subject="新編輯者草稿")
    base = s.current()["release_id"]
    try:
        with pytest.raises(LockLost):
            old.publish()  # 期待：舊者不再持有編輯權 → 禁止發布
    finally:
        moved = s.current()["release_id"] != base
        new.close()
        old.lock = None
        old.close()
    assert not moved, "新編輯者持鎖期間，舊編輯者仍切換了共用版本指標"


def test_R2_02_restart_after_lost_publish_ack_recognizes_op_id(tmp_path):
    """§11：發布已完成（指標已切到本操作），但本機未收到結果（draft.json 未更新）即中斷。
    重新開始編輯時應以 op_id 辨識「已發布」，不應當作基準衝突移入 recovery 要求重套（會導致重複建立事件）。"""
    s = _store(tmp_path)
    ws = Workspace(tmp_path / "loc", s.root, "admin")
    ws.refresh_view()
    ws.start_edit()
    C.create_case(ws.ctx(), subject="已發布但未收到回應")
    d = json.loads((ws.work_dir / "draft.json").read_text(encoding="utf-8"))
    # 等同 Workspace.publish 中 store.publish 成功、寫回 draft.json 前斷線
    rid = s.publish(ws.lock, ws.db_path, base_release_id=d["base"], op_id=d["op_id"], operator="admin",
                    pending_attach_dir=ws.pending_dir)
    assert s.current()["release_id"] == rid
    ws.close()

    ws2 = Workspace(tmp_path / "loc", s.root, "admin")
    ws2.refresh_view()
    try:
        status = ws2.start_edit()
        assert status != "recovered", "本操作已成為目前版本，卻被判為基準衝突、要求使用者重套變更"
    finally:
        ws2.close()


# ======================================================================
# 二、備份還原（§13、T22）
# ======================================================================

def test_R2_03_restore_rejects_backup_whose_manifest_omits_data_hash(tmp_path):
    """§13：還原前須完成雜湊驗證。verify_backup 只檢查 manifest 有列出的檔案；
    manifest 未列 data.sqlite 時，被替換的 data.sqlite 仍通過驗證並被還原發布。"""
    s = _store(tmp_path)
    ws = Workspace(tmp_path / "loc", s.root, "admin")
    ws.refresh_view()
    ws.start_edit()
    C.create_case(ws.ctx(), subject="原始案")
    rid = ws.publish()
    bk = s.backup(rid, ctx=ws.ctx())
    # 以另一份有效資料庫替換 data.sqlite，並從 manifest 拿掉 data.sqlite
    C.create_case(ws.ctx(), subject="被夾帶的案")
    ws.con.commit() if ws.con.in_transaction else None
    shutil.copyfile(ws.db_path, bk / "data.sqlite")
    m = json.loads((bk / "backup_manifest.json").read_text(encoding="utf-8"))
    m["files"].pop("data.sqlite")
    (bk / "backup_manifest.json").write_text(json.dumps(m), encoding="utf-8")
    try:
        with pytest.raises(StoreError):
            s.restore(ws.lock, bk, ctx=ws.ctx(), reason="演練", op_id="r2-03")
    finally:
        ws.close()


def test_R2_04_verify_backup_rejects_paths_outside_backup(tmp_path):
    """§13 路徑安全：backup_manifest 的 files 鍵為相對路徑，未限制在備份目錄內（可指向 ../ 之外的檔案）。"""
    from specdrug.store import verify_backup
    from specdrug.util import sha256_file
    bk = tmp_path / "bk"
    bk.mkdir()
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"x")
    (bk / "backup_manifest.json").write_text(json.dumps(
        {"release_id": "x", "files": {"../outside.bin": sha256_file(outside)}}), encoding="utf-8")
    assert verify_backup(bk), "manifest 指向備份目錄外的檔案仍判定驗證通過"


# ======================================================================
# 三、角色權限（§5、T23）
# ======================================================================

def test_R2_05_viewer_role_cannot_take_edit_lock_or_publish(tmp_path):
    """§5、T23：查詢者不得發布。start_edit 只檢查「有任何角色」，查詢者可取得全系統編輯權並發布新版本。"""
    s = _store(tmp_path)
    _publish_users(tmp_path, s, {"viewer": [ROLE_VIEWER]})
    ws = Workspace(tmp_path / "v", s.root, "viewer")
    ws.refresh_view()
    before = s.current()["release_id"]
    try:
        with pytest.raises((PermissionDenied, StoreError)):
            ws.start_edit()
            ws.publish()
    finally:
        ws.close()
    assert s.current()["release_id"] == before, "查詢者發布了新版本"


def test_R2_06_clerk_cannot_set_confirm_status_via_update_price_action(ctx, tmp_path):
    """§5（確認限複核登記者）、§9.2：update_price_action 未限制可改欄位，
    登記者可直接把草稿調高設為「已確認」，跳過 confirm_announcement 的角色與缺件檢查（T09）。"""
    rev = _confirmed_revision(ctx, tmp_path)
    clerk = Ctx(ctx.con, "clerk", {ROLE_CLERK}, True)
    pa = P.create_price_action(clerk, revision_id=rev, drug_code="A000001100", contract_requirement="須簽約",
                               price_after="999", status="辦理中")  # 無合約、無公告文號
    with pytest.raises(BizError):
        P.update_price_action(clerk, pa, {"confirm_status": "已確認", "confirmed_by": "clerk"})
    st = ctx.con.execute("SELECT confirm_status FROM price_action WHERE id=?", (pa,)).fetchone()[0]
    assert st != "已確認"


def test_R2_07_update_contract_cannot_rewrite_creator_fields(ctx):
    """§6.1：須記錄建立者、建立時間。update_contract 未限制可改欄位，可改寫 created_by／created_at。"""
    cid = P.create_contract(ctx, contract_no="C-1", status="完成簽署", signed_date="2026-01-01",
                            drugs=["A000001100"])
    clerk = Ctx(ctx.con, "clerk", {ROLE_CLERK}, True)
    with pytest.raises(BizError):
        P.update_contract(clerk, cid, {"created_by": "someone_else", "created_at": "2000-01-01T00:00:00Z"})
    assert ctx.con.execute("SELECT created_by FROM contract WHERE id=?", (cid,)).fetchone()[0] == "reviewer"


def test_R2_08_clerk_cannot_expand_scope_of_confirmed_revision(ctx, tmp_path):
    """§5（確認限複核登記者）、§6.1／B10（已確認不覆寫）：已確認認定的範圍名單（revision_scope）
    可由登記者單獨以「新快照＋確認快照」擴大，無須複核登記者，亦不形成新認定版本。"""
    rev = _confirmed_revision(ctx, tmp_path)
    before = R.revision_scope(ctx.con, rev)
    clerk = Ctx(ctx.con, "clerk", {ROLE_CLERK}, True)
    iid2 = M.stage_import(clerk, _csv(tmp_path / "m2.csv", [["A000001100", "A1", "G1", "J01AA01"],
                                                            ["A000002100", "A2", "G1", "J01AA01"],
                                                            ["Z000009100", "Z9", "G1", "J01AA01"]]),
                          MAP, base_date="2026-11-01")  # 試匯入，未啟用
    try:
        sid = R.save_snapshot(clerk, rev, iid2)
        R.confirm_snapshot(clerk, sid)
    except (PermissionDenied, BizError):
        pass
    after = R.revision_scope(ctx.con, rev)
    assert after == before, f"登記者擴大了已確認認定範圍：新增 {sorted(after - before)}"
