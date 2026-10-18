"""附件對話框：上傳、開啟、另存。開啟／另存一律經雜湊驗證；查詢者依角色可下載。"""
from __future__ import annotations

import os
import subprocess
import sys
import tkinter as tk
from tkinter import filedialog, ttk

from ..attachments import add_attachment, attachment_targets, attachments_of, safe_name
from ..util import to_taipei
from . import widgets as W


class AttachmentDialog(tk.Toplevel):
    def __init__(self, master, app, entity, entity_id):
        super().__init__(master)
        self.app = app
        self.title("附件（開啟／另存／上傳）")
        self.targets = attachment_targets(app.con, entity, entity_id)
        top = ttk.Frame(self, padding=6)
        top.pack(fill="x")
        ttk.Label(top, text="附件對象").pack(side="left")
        self.target = ttk.Combobox(top, width=70, state="readonly", values=[t[2] for t in self.targets])
        self.target.current(0)
        self.target.pack(side="left")
        self.target.bind("<<ComboboxSelected>>", lambda e: self.load())
        bar = ttk.Frame(self, padding=(6, 0))
        bar.pack(fill="x")
        for t, cmd in (("開啟", self.open), ("另存", self.save_as), ("上傳新檔／新版本", self.upload)):
            ttk.Button(bar, text=t, command=cmd).pack(side="left", padx=2)
        self.table = W.Table(self, [("orig_name", "檔名", 260), ("version", "版本", 50), ("size", "大小", 80),
                                    ("sha_short", "SHA-256", 110), ("uploaded_by", "上傳者", 110),
                                    ("at_l", "上傳時間", 150)], height=10, filter_box=False, on_double=self.open)
        self.table.pack(fill="both", expand=True, padx=6, pady=6)
        self.load()

    def _target(self):
        return self.targets[self.target.current()]

    def load(self):
        entity, eid, _ = self._target()
        rows = []
        for a in attachments_of(self.app.con, entity, eid):
            a["sha_short"] = a["sha256"][:12]
            a["at_l"] = to_taipei(a["uploaded_at"]) if a["uploaded_at"] else ""
            rows.append(a)
        self.table.set_rows(rows)

    def _fetch(self, dest):
        a = self.table.one(self)
        if not a:
            return None
        return self.app.run(self.app.ws.fetch_attachment, a["id"], dest(a))

    def open(self, *_):
        out = self._fetch(lambda a: self.app.ws.local / "downloads" / a["id"][:8] / safe_name(a["orig_name"]))
        if not out:
            return
        try:
            if sys.platform == "win32":
                os.startfile(str(out))  # noqa: S606
            else:
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(out)])
        except OSError as e:
            W.error(self, f"已驗證並取得檔案，但無法以預設程式開啟：{e}\n檔案位置：{out}")

    def save_as(self):
        a = self.table.one(self)
        if not a:
            return
        path = filedialog.asksaveasfilename(parent=self, initialfile=safe_name(a["orig_name"]))
        if path and self.app.run(self.app.ws.fetch_attachment, a["id"], path):
            W.info(self, f"已驗證雜湊並另存：{path}")

    def upload(self):
        entity, eid, _ = self._target()
        path = filedialog.askopenfilename(parent=self)
        if path and self.app.run(add_attachment, self.app.ctx(), path, entity, eid, self.app.ws.pending_dir,
                                 ok="附件已加入（新版本不覆蓋舊檔；發布後他人可取得）。"):
            self.load()


def open_dialog(master, app, entity, entity_id):
    try:
        AttachmentDialog(master, app, entity, entity_id)
    except Exception as e:  # noqa: BLE001
        W.error(master, e)
