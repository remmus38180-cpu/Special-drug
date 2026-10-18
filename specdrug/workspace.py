"""工作階段：查詢模式（已發布版本本機唯讀副本）與編輯模式（本機工作副本）。

- 離線原型：單機資料庫，不涉共用槽；畫面明示「離線原型」。
- 共用版：開始編輯取得全系統獨占權；草稿存本機可復原工作區；發布才供他人取得。
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from .auth import bootstrap_admin, os_account, roles_of
from .core import Ctx
from .db import SCHEMA_VERSION, open_db, schema_version
from .store import LockBusy, PublishConflict, SharedStore, StoreError, _read_json, _write_json_atomic
from .util import new_id, utc_now


class Workspace:
    def __init__(self, local_dir, store_root=None, account=None):
        self.local = Path(local_dir)
        self.local.mkdir(parents=True, exist_ok=True)
        self.account = account or os_account()
        self.store = SharedStore(store_root) if store_root else None
        self.mode = "shared" if self.store else "offline"
        self.lock = None
        self.con = None
        self.view_release = None
        self.view_info = {}
        self.work_dir = self.local / "work"
        self.cache_dir = self.local / "cache"
        self.pending_dir = self.work_dir / "attachments_pending"
        if self.mode == "offline":
            self.work_dir.mkdir(parents=True, exist_ok=True)
            self.db_path = self.local / "offline.sqlite"
            self.con = open_db(self.db_path)
            bootstrap_admin(self.con, self.account)

    # ---------- 狀態 ----------
    @property
    def editing(self) -> bool:
        return self.mode == "offline" or self.lock is not None

    def ctx(self) -> Ctx:
        return Ctx(self.con, self.account, roles_of(self.con, self.account), self.editing)

    def banner(self) -> str:
        if self.mode == "offline":
            return "離線原型（單機資料，未經共用槽驗收，不是正式共用版）"
        info = self.view_info
        s = f"查詢版本 {info.get('release_id', '—')}（發布 {info.get('at', '—')}）"
        if info.get("stale"):
            s += "；共用槽無法取得新版，使用本機已驗證副本（離線）"
        if info.get("newer"):
            s += "；共用槽已有新版，請重新整理"
        if self.editing:
            s = f"編輯中（基準 {self._draft().get('base')}）｜" + s
        else:
            ed = self.store.editor_info() if self.store else None
            if ed and ed.get("account"):
                s += f"｜目前編輯者：{ed['account']}（{ed.get('host', '')}，自 {ed.get('since', '')}）"
        return s

    # ---------- 查詢 ----------
    def refresh_view(self) -> dict:
        if self.mode == "offline":
            return {}
        if self.editing:
            return self.view_info
        prev = self.view_release
        try:
            cur = self.store.current()
            if not cur:
                raise StoreError("共用槽尚未初始化。")
            path = self.store.fetch_release(cur["release_id"], self.cache_dir)
            con = open_db(path, readonly=True)
            if schema_version(con) > SCHEMA_VERSION:
                con.close()
                raise StoreError("共用版本資料格式新於本程式，請更新程式。")
            if self.con:
                self.con.close()
            self.con = con
            self.view_release = cur["release_id"]
            m = self.store._manifest(cur["release_id"])
            self.view_info = {"release_id": cur["release_id"], "at": m["at"] if m else "", "stale": False,
                              "newer": False}
        except (OSError, StoreError) as e:
            if prev and self.con:
                self.view_info["stale"] = True
                self.view_info["error"] = str(e)
            else:
                cached = sorted(self.cache_dir.glob("*.sqlite")) if self.cache_dir.exists() else []
                if not cached:
                    raise
                self.con = open_db(cached[-1], readonly=True)
                self.view_release = cached[-1].stem
                self.view_info = {"release_id": self.view_release, "at": "", "stale": True, "error": str(e)}
        return self.view_info

    def check_newer(self) -> bool:
        if self.mode == "offline" or self.editing:
            return False
        try:
            cur = self.store.current()
        except OSError:
            return False
        newer = bool(cur and cur["release_id"] != self.view_release)
        self.view_info["newer"] = newer
        return newer

    # ---------- 編輯 ----------
    def _draft(self) -> dict:
        return _read_json(self.work_dir / "draft.json") or {}

    def start_edit(self) -> str:
        """回傳 'new'、'resumed' 或 'recovered'（舊草稿基準已變更，另存待核對）。"""
        if self.mode == "offline":
            return "new"
        if not self.store.environment_ok():
            raise StoreError("共用槽尚未通過鎖定／不可分割替換環境驗證，正式編輯模式停用（請管理者執行環境驗證）。")
        self.lock = self.store.acquire_lock(self.account)
        try:
            cur = self.store.current()
            base = cur["release_id"] if cur else None
            self.work_dir.mkdir(parents=True, exist_ok=True)
            draft = self._draft()
            work_db = self.work_dir / "work.sqlite"
            status = "new"
            if draft and work_db.exists():
                if draft.get("base") == base:
                    status = "resumed"
                else:
                    rec = self.local / f"recovery-{utc_now()[:19].replace(':', '')}"
                    shutil.move(str(self.work_dir), str(rec))
                    self.work_dir.mkdir(parents=True)
                    status = "recovered"
            if status != "resumed":
                src = self.store.fetch_release(base, self.cache_dir)
                shutil.copyfile(src, work_db)
                _write_json_atomic(self.work_dir / "draft.json",
                                   {"base": base, "op_id": new_id(), "started_at": utc_now(), "account": self.account})
            if self.con:
                self.con.close()
            self.con = open_db(work_db)
            if not roles_of(self.con, self.account):
                self.con.close()
                self.con = None
                raise StoreError(f"帳號 {self.account} 未授權編輯。")
            self.db_path = work_db
            return status
        except Exception:
            self.store.release_lock(self.lock)
            self.lock = None
            raise

    def publish(self) -> str:
        if self.mode == "offline":
            raise StoreError("離線原型不提供共用槽發布。")
        if not self.lock:
            raise StoreError("尚未取得編輯權。")
        d = self._draft()
        rid = self.store.publish(self.lock, self.db_path, base_release_id=d["base"], op_id=d["op_id"],
                                 operator=self.account, pending_attach_dir=self.pending_dir)
        _write_json_atomic(self.work_dir / "draft.json",
                           {"base": rid, "op_id": new_id(), "started_at": utc_now(), "account": self.account})
        return rid

    def fetch_attachment(self, attachment_id, dest) -> Path:
        """開啟／另存附件（驗證雜湊）；查詢模式依角色可下載。"""
        from .attachments import fetch_attachment
        return fetch_attachment(self.ctx(), attachment_id, dest, store=self.store, pending_dir=self.pending_dir)

    def lock_valid(self) -> bool:
        return bool(self.lock and self.lock.valid())

    def end_edit(self, action: str):
        """action：publish（發布後結束）／keep（保留本機草稿）／discard（放棄）。"""
        if self.mode == "offline":
            return
        if action == "publish":
            self.publish()
            shutil.rmtree(self.work_dir, ignore_errors=True)
        elif action == "discard":
            if self.con:
                self.con.close()
                self.con = None
            shutil.rmtree(self.work_dir, ignore_errors=True)
        elif action != "keep":
            raise ValueError(action)
        if self.con:
            self.con.close()
            self.con = None
        self.store.release_lock(self.lock)
        self.lock = None
        self.view_release = None
        self.refresh_view()

    def close(self):
        if self.con:
            self.con.close()
            self.con = None
        if self.lock and self.store:
            self.store.release_lock(self.lock)
            self.lock = None
