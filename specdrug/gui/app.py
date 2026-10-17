"""主視窗：模式橫幅、編輯控制、分頁。全程繁體中文。"""
from __future__ import annotations

import json
import os
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, ttk

from .. import __version__
from ..auth import os_account
from ..store import LockBusy, SharedStore, StoreError
from ..workspace import Workspace
from . import widgets as W


def config_path() -> Path:
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[2]
    return base / "config.json"


def load_config() -> dict:
    p = config_path()
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def default_local_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "specdrug"


class App(tk.Tk):
    def __init__(self, ws: Workspace):
        super().__init__()
        self.ws = ws
        self.title(f"特殊藥品認定、調高及供貨合約管理系統 v{__version__}")
        self.geometry("1400x860")
        W.setup_style(self)
        bar = ttk.Frame(self)
        bar.pack(fill="x")
        self.banner = ttk.Label(bar, text="", style="Banner.TLabel")
        self.banner.pack(side="left", fill="x", expand=True)
        self.btn_edit = ttk.Button(bar, text="開始編輯", command=self.start_edit)
        self.btn_pub = ttk.Button(bar, text="發布", command=self.publish)
        self.btn_end = ttk.Button(bar, text="結束編輯", command=self.end_edit)
        self.btn_ref = ttk.Button(bar, text="重新整理", command=self.reload)
        for b in (self.btn_ref, self.btn_end, self.btn_pub, self.btn_edit):
            b.pack(side="right", padx=2)
        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True)
        from .tabs_case import CaseTab, MeetingTab
        from .tabs_recog import AnnounceTab, RecognitionTab
        from .tabs_misc import AdminTab, ContractTab, DiffTab, DrugTab, MasterTab, MigrationTab
        self.tabs = []
        for cls, title in ((CaseTab, "案件"), (MeetingTab, "會議"), (RecognitionTab, "認定"),
                           (AnnounceTab, "公告複核"), (ContractTab, "合約"), (DrugTab, "品項明細"),
                           (MasterTab, "主檔匯入"), (DiffTab, "差異待辦"), (MigrationTab, "Excel移轉"),
                           (AdminTab, "稽核／管理")):
            t = cls(self.nb, self)
            self.nb.add(t, text=title)
            self.tabs.append(t)
        self.nb.bind("<<NotebookTabChanged>>", lambda e: self.current_tab().refresh())
        self.protocol("WM_DELETE_WINDOW", self.on_close)
        self.update_banner()
        self.after(100, lambda: self.current_tab().refresh())
        self.after(60000, self.poll)

    # ---------- 共用 ----------
    @property
    def con(self):
        return self.ws.con

    def ctx(self):
        return self.ws.ctx()

    def current_tab(self):
        return self.tabs[self.nb.index(self.nb.select())]

    def run(self, fn, *a, ok=None, **kw):
        """執行業務操作；錯誤以繁體中文說明。"""
        if self.ws.mode == "shared" and self.ws.editing and not self.ws.lock_valid():
            W.error(self, "編輯權有效性不明（可能斷線），已禁止寫入與發布；請結束編輯並保留草稿後重新取得編輯權。")
            return None
        try:
            r = fn(*a, **kw)
        except Exception as e:  # noqa: BLE001
            W.error(self, e)
            return None
        if ok:
            W.info(self, ok)
        return r

    def update_banner(self):
        self.banner.config(text=self.ws.banner() + f"｜帳號 {self.ws.account}")
        shared = self.ws.mode == "shared"
        self.btn_edit.state(["!disabled"] if shared and not self.ws.editing else ["disabled"])
        self.btn_pub.state(["!disabled"] if shared and self.ws.editing else ["disabled"])
        self.btn_end.state(["!disabled"] if shared and self.ws.editing else ["disabled"])

    def reload(self):
        if self.ws.mode == "shared" and not self.ws.editing:
            try:
                self.ws.refresh_view()
            except Exception as e:  # noqa: BLE001
                W.error(self, e)
        self.update_banner()
        self.current_tab().refresh()

    def poll(self):
        try:
            if self.ws.check_newer():
                self.update_banner()
        finally:
            self.after(60000, self.poll)

    # ---------- 編輯控制 ----------
    def start_edit(self):
        try:
            st = self.ws.start_edit()
        except LockBusy as e:
            ed = self.ws.store.editor_info() or {}
            W.error(self, f"{e}\n目前編輯者：{ed.get('account')}（{ed.get('host')}，自 {ed.get('since')}）")
            return
        except Exception as e:  # noqa: BLE001
            W.error(self, e)
            return
        msg = {"new": "已取得編輯權。", "resumed": "已取得編輯權，並復原本機未發布草稿。",
               "recovered": "已取得編輯權。先前本機草稿的基準版本已變更，已另存於 recovery 資料夾，請核對後重套變更。"}[st]
        W.info(self, msg)
        self.reload()

    def publish(self):
        if not W.ask(self, "確定發布目前內容供他人查詢？"):
            return
        rid = self.run(self.ws.publish)
        if rid:
            W.info(self, f"已發布版本 {rid}。")
        self.update_banner()

    def end_edit(self):
        d = tk.Toplevel(self)
        d.title("結束編輯")
        ttk.Label(d, text="結束編輯前請選擇：未發布草稿不會被他人看到。", padding=10).pack()
        choice = {"v": None}

        def pick(v):
            choice["v"] = v
            d.destroy()
        for v, t in (("publish", "發布後結束"), ("keep", "保留本機草稿"), ("discard", "放棄修改")):
            ttk.Button(d, text=t, command=lambda v=v: pick(v)).pack(side="left", padx=6, pady=8)
        d.transient(self)
        d.grab_set()
        self.wait_window(d)
        if not choice["v"]:
            return
        if choice["v"] == "discard" and not W.ask(self, "確定放棄所有未發布修改？"):
            return
        self.run(self.ws.end_edit, choice["v"])
        self.reload()

    def on_close(self):
        if self.ws.mode == "shared" and self.ws.editing:
            if not W.ask(self, "仍在編輯中；關閉將保留本機草稿並釋放編輯權。確定關閉？"):
                return
            try:
                self.ws.end_edit("keep")
            except Exception:  # noqa: BLE001
                pass
        self.ws.close()
        self.destroy()


def choose_workspace() -> Workspace | None:
    cfg = load_config()
    local = Path(cfg.get("local_dir") or default_local_dir())
    root = cfg.get("store_root")
    account = os_account()
    if root:
        store = SharedStore(root)
        if not store.current():
            r = tk.Tk()
            r.withdraw()
            if W.ask(r, f"共用槽 {root} 尚未初始化。以 {account} 為管理者初始化？"):
                try:
                    store.init(account)
                except Exception as e:  # noqa: BLE001
                    W.error(r, e)
                    r.destroy()
                    return None
            else:
                r.destroy()
                return None
            r.destroy()
        ws = Workspace(local, root, account)
        ws.refresh_view()
        return ws
    return Workspace(local / "offline", None, account)


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "--probe-lock":
        from ..store import probe_lock
        probe_lock(sys.argv[2], sys.argv[3])
        return
    try:
        ws = choose_workspace()
    except Exception as e:  # noqa: BLE001
        r = tk.Tk()
        r.withdraw()
        W.error(r, f"無法開啟資料：{e}")
        return
    if ws is None:
        return
    App(ws).mainloop()
