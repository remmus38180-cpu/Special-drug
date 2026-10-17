"""認定清單／詳情、規則編輯（條件點選＋預覽）、快照人工確認、公告複核。"""
from __future__ import annotations

import copy
import json
import tkinter as tk
from tkinter import ttk

from .. import pricing as P
from .. import recognition as R
from .. import rules
from ..master_import import active_import_id, options
from ..util import new_id
from . import widgets as W

TEMPLATES = {
    "依分組": {"op": "or", "children": []},
    "依ATC加劑型": {"op": "and", "children": []},
    "依分組加規格": {"op": "and", "children": []},
    "指定品項": {"op": "or", "children": []},
    "進階條件": {"op": "and", "children": []},
}


class ConditionDialog(tk.Toplevel):
    """單一條件：欄位下拉、運算子、值（由主檔選項多選）。"""

    def __init__(self, master, con, import_id, node=None):
        super().__init__(master)
        self.title("條件")
        self.transient(master)
        self.con, self.import_id = con, import_id
        self.result = None
        node = node or {"field": "group_code", "op": "in", "values": []}
        frm = ttk.Frame(self, padding=8)
        frm.pack(fill="both", expand=True)
        self.field = tk.StringVar(value=node.get("field"))
        self.op = tk.StringVar(value=node.get("op"))
        labels = {k: v[0] for k, v in rules.FIELDS.items()}
        self.label_to_key = {v: k for k, v in labels.items()}
        ttk.Label(frm, text="欄位").grid(row=0, column=0, sticky="e")
        self.fbox = ttk.Combobox(frm, values=list(labels.values()), state="readonly", width=20)
        self.fbox.set(labels[self.field.get()])
        self.fbox.grid(row=0, column=1, sticky="w")
        self.fbox.bind("<<ComboboxSelected>>", lambda e: self._field_changed())
        ttk.Label(frm, text="運算子").grid(row=1, column=0, sticky="e")
        self.obox = ttk.Combobox(frm, state="readonly", width=20)
        self.obox.grid(row=1, column=1, sticky="w")
        ttk.Label(frm, text="搜尋選項").grid(row=2, column=0, sticky="e")
        self.search = tk.StringVar()
        ttk.Entry(frm, textvariable=self.search, width=30).grid(row=2, column=1, sticky="w")
        self.search.trace_add("write", lambda *_: self._fill())
        self.lb = tk.Listbox(frm, selectmode="extended", width=80, height=16, font=W.FONT, exportselection=False)
        self.lb.grid(row=3, column=0, columnspan=2, sticky="nsew")
        ttk.Label(frm, text="已選值／前綴（逗號分隔，可手動）").grid(row=4, column=0, sticky="e")
        self.vals = tk.StringVar(value=",".join(node.get("values", [])) or node.get("value", "") or "")
        ttk.Entry(frm, textvariable=self.vals, width=60).grid(row=4, column=1, sticky="w")
        ttk.Label(frm, text="規格單位").grid(row=5, column=0, sticky="e")
        self.unit = ttk.Combobox(frm, width=20)
        self.unit.set(node.get("unit", ""))
        self.unit.grid(row=5, column=1, sticky="w")
        bt = ttk.Frame(frm)
        bt.grid(row=6, column=0, columnspan=2, pady=6)
        ttk.Button(bt, text="加入選取", command=self._add_sel).pack(side="left", padx=3)
        ttk.Button(bt, text="確定", command=self._ok).pack(side="left", padx=3)
        ttk.Button(bt, text="取消", command=self.destroy).pack(side="left", padx=3)
        self.opts = []
        self._field_changed(initial_op=node.get("op"))
        self.grab_set()

    def _key(self):
        return self.label_to_key[self.fbox.get()]

    def _field_changed(self, initial_op=None):
        k = self._key()
        ops = rules.QTY_OPS if rules.FIELDS[k][1] == "quantity" else rules.TEXT_OPS
        self.op_labels = {v: o for o, v in ops.items()}
        self.obox.config(values=list(self.op_labels))
        cur = initial_op if initial_op in ops else list(ops)[0]
        self.obox.set(ops[cur])
        opt_field = "spec_unit" if k == "spec" else (k if k in ("group_code", "atc_code", "dose_code", "multi_mark",
                                                                 "drug_code", "firm_code") else None)
        self.opts = options(self.con, self.import_id, opt_field) if (opt_field and self.import_id) else []
        if k == "spec":
            self.unit.config(values=[o[0] for o in self.opts])
            self.opts = []
        self._fill()

    def _fill(self):
        s = self.search.get().strip().lower()
        self.lb.delete(0, "end")
        self.shown = [o for o in self.opts if not s or s in o[0].lower() or s in o[1].lower()][:3000]
        for c, d in self.shown:
            self.lb.insert("end", f"{c}　{d}")

    def _add_sel(self):
        cur = [x.strip() for x in self.vals.get().split(",") if x.strip()]
        for i in self.lb.curselection():
            c = self.shown[i][0]
            if c not in cur:
                cur.append(c)
        self.vals.set(",".join(cur))

    def _ok(self):
        k = self._key()
        op = self.op_labels[self.obox.get()]
        vals = [x.strip() for x in self.vals.get().replace("，", ",").split(",") if x.strip()]
        if rules.FIELDS[k][1] == "quantity":
            node = {"field": k, "op": op, "value": vals[0] if vals else "", "unit": self.unit.get().strip()}
        elif op in ("in", "not_in"):
            node = {"field": k, "op": op, "values": vals}
        else:
            if len(vals) > 1:
                W.error(self, "此運算子只接受一個值；多值請用「屬於」或以任一符合群組組合。")
                return
            node = {"field": k, "op": op, "value": vals[0] if vals else ""}
        try:
            rules.validate(node)
        except rules.RuleError as e:
            W.error(self, e)
            return
        self.result = node
        self.destroy()


class RuleEditor(tk.Toplevel):
    def __init__(self, master, app, revision):
        super().__init__(master)
        self.app = app
        self.rev = revision
        self.title(f"規則編輯：版本 {revision['revision_no']}")
        self.geometry("1300x760")
        self.import_id = active_import_id(app.con)
        self.rule = json.loads(revision["rule_json"]) if revision["rule_json"] else None
        self.saved = copy.deepcopy(self.rule)
        top = ttk.Frame(self, padding=4)
        top.pack(fill="x")
        ttk.Label(top, text="範本：").pack(side="left")
        for t in TEMPLATES:
            ttk.Button(top, text=t, command=lambda t=t: self._template(t)).pack(side="left")
        ttk.Label(top, text=f"｜主檔版本：{self.import_id[:8] if self.import_id else '未啟用主檔'}").pack(side="left")
        pw = ttk.PanedWindow(self, orient="horizontal")
        pw.pack(fill="both", expand=True)
        left = ttk.Frame(pw)
        pw.add(left, weight=2)
        self.tree = ttk.Treeview(left, show="tree", height=24)
        self.tree.pack(fill="both", expand=True)
        bt = ttk.Frame(left)
        bt.pack(fill="x")
        for t, cmd in (("加全部符合群組", lambda: self._add({"op": "and", "children": []})),
                       ("加任一符合群組", lambda: self._add({"op": "or", "children": []})),
                       ("加排除", self._add_not), ("加條件", self._add_cond), ("加人工條件", self._add_manual),
                       ("修改", self._edit), ("刪除", self._delete)):
            ttk.Button(bt, text=t, command=cmd).pack(side="left", padx=1)
        bt2 = ttk.Frame(left)
        bt2.pack(fill="x")
        ttk.Button(bt2, text="預覽", command=self.preview).pack(side="left")
        ttk.Button(bt2, text="儲存條件", command=self.save).pack(side="left")
        ttk.Button(bt2, text="檢視JSON", command=lambda: W.TextView(self, "結構化條件",
                                                                   json.dumps(self.rule, ensure_ascii=False, indent=2))).pack(side="left")
        if revision["scope_text"]:
            t = tk.Text(left, height=5, font=W.FONT, wrap="word")
            t.insert("1.0", "適用範圍原文：\n" + revision["scope_text"])
            t.config(state="disabled")
            t.pack(fill="x")
        right = ttk.Frame(pw)
        pw.add(right, weight=3)
        self.warn = ttk.Label(right, text="", style="Warn.TLabel", wraplength=700)
        self.warn.pack(fill="x")
        self.groups = W.Table(right, [("group_code", "分組", 130), ("matched", "符合", 60), ("pending", "待確認", 60),
                                      ("total", "主檔該組", 70), ("partial_txt", "涵蓋", 90)], height=6,
                              filter_box=False)
        self.groups.pack(fill="x")
        self.members = W.Table(right, [("drug_code", "代碼", 110), ("result", "結果", 60), ("drug_name", "品名", 220),
                                       ("group_code", "分組", 110), ("spec", "規格", 70), ("firm", "藥商", 140),
                                       ("path", "符合條件路徑", 320)], height=14)
        self.members.pack(fill="both", expand=True)
        self._render()
        self.protocol("WM_DELETE_WINDOW", self._close)

    def _template(self, t):
        if self.rule and not W.ask(self, "套用範本將取代目前條件，確定？"):
            return
        self.rule = copy.deepcopy(TEMPLATES[t])
        self._render()
        W.info(self, f"已建立「{t}」群組，請以「加條件」從主檔點選。")

    def _render(self):
        self.tree.delete(*self.tree.get_children())
        self.paths = {}
        if self.rule:
            self._ins("", self.rule, ())
        for i in self.tree.get_children(""):
            self._expand(i)

    def _expand(self, i):
        self.tree.item(i, open=True)
        for c in self.tree.get_children(i):
            self._expand(c)

    def _ins(self, parent, node, path):
        op = node.get("op")
        if op in ("and", "or"):
            text = f"〔{rules.LOGIC_OPS[op]}〕"
        elif op == "not":
            text = "〔排除〕"
        else:
            text = rules.describe(node).strip()
        iid = self.tree.insert(parent, "end", text=text)
        self.paths[iid] = path
        if op in ("and", "or"):
            for k, c in enumerate(node["children"]):
                self._ins(iid, c, path + (k,))
        elif op == "not":
            self._ins(iid, node["child"], path + ("child",))

    def _node(self, path):
        n = self.rule
        for p in path:
            n = n["child"] if p == "child" else n["children"][p]
        return n

    def _target_group(self):
        sel = self.tree.selection()
        if not self.rule:
            return None
        path = self.paths[sel[0]] if sel else ()
        n = self._node(path)
        while n.get("op") not in ("and", "or"):
            if not path:
                return None
            path = path[:-1]
            n = self._node(path)
        return n

    def _add(self, node):
        if not self.rule:
            self.rule = node
        else:
            g = self._target_group()
            if g is None:
                self.rule = {"op": "and", "children": [self.rule, node]}
            else:
                g["children"].append(node)
        self._render()

    def _add_not(self):
        d = ConditionDialog(self, self.app.con, self.import_id)
        self.wait_window(d)
        if d.result:
            self._add({"op": "not", "child": d.result})

    def _add_cond(self):
        d = ConditionDialog(self, self.app.con, self.import_id)
        self.wait_window(d)
        if d.result:
            self._add(d.result)

    def _add_manual(self):
        v = W.form(self, "人工條件（保留原文，判定為待確認）", [("text", "條件原文*", "long")])
        if v and v["text"]:
            self._add({"op": "manual", "text": v["text"]})

    def _edit(self):
        sel = self.tree.selection()
        if not sel:
            return
        path = self.paths[sel[0]]
        n = self._node(path)
        if n.get("op") in ("and", "or"):
            n["op"] = "or" if n["op"] == "and" else "and"
        elif n.get("op") == "manual":
            v = W.form(self, "人工條件", [("text", "條件原文*", "long")], initial=n)
            if v and v["text"]:
                n["text"] = v["text"]
        elif n.get("op") != "not":
            d = ConditionDialog(self, self.app.con, self.import_id, n)
            self.wait_window(d)
            if d.result:
                n.clear()
                n.update(d.result)
        self._render()

    def _delete(self):
        sel = self.tree.selection()
        if not sel:
            return
        path = self.paths[sel[0]]
        if not path:
            self.rule = None
        else:
            parent = self._node(path[:-1])
            if path[-1] == "child":
                gp = path[:-2]
                if not path[:-1]:
                    self.rule = None
                else:
                    g = self._node(gp)
                    g["children"].pop(path[-2])
            else:
                parent["children"].pop(path[-1])
        self._render()

    def preview(self):
        if not self.rule:
            W.error(self, "空規則不得當作全選，請先建立條件。")
            return
        try:
            pv = R.preview(self.app.con, self.rule, self.import_id)
        except Exception as e:  # noqa: BLE001
            W.error(self, e)
            return
        self.warn.config(text=f"符合 {pv['match']}、待確認 {pv['pending']}。" + " ".join(pv["warnings"]))
        for g in pv["groups"]:
            g["partial_txt"] = "部分涵蓋" if g["partial"] else "全組"
        self.groups.set_rows(pv["groups"])
        self.members.set_rows(pv["members"])

    def save(self):
        try:
            if self.rule is not None:
                rules.validate(self.rule)
        except rules.RuleError as e:
            W.error(self, e)
            return
        if self.app.run(R.update_revision, self.app.ctx(), self.rev["id"], {"rule": self.rule},
                        ok="已儲存條件；確認範圍前須重新建立快照。"):
            self.saved = copy.deepcopy(self.rule)

    def _close(self):
        if self.rule != self.saved and not W.ask(self, "條件尚未儲存，確定離開？"):
            return
        self.destroy()


class SnapshotDialog(tk.Toplevel):
    """快照名單與人工確認（納入／排除需理由）。"""

    def __init__(self, master, app, snapshot_id):
        super().__init__(master)
        self.app, self.sid = app, snapshot_id
        snap = app.con.execute("SELECT * FROM scope_snapshot WHERE id=?", (snapshot_id,)).fetchone()
        self.title(f"範圍快照 {snapshot_id[:8]}（{snap['status']}）")
        self.geometry("1100x640")
        top = ttk.Frame(self, padding=4)
        top.pack(fill="x")
        ttk.Label(top, text=f"主檔 {snap['import_id'][:8]}｜評估 {snap['evaluated_at']}｜符合 {snap['match_count']}"
                            f"｜待確認 {snap['pending_count']}").pack(side="left")
        for t, d in (("人工納入", "納入"), ("人工排除", "排除")):
            ttk.Button(top, text=t, command=lambda d=d: self.decide(d)).pack(side="left", padx=2)
        ttk.Button(top, text="依原因批次確認", command=self.bulk).pack(side="left", padx=2)
        ttk.Button(top, text="確認範圍名單", command=self.confirm).pack(side="left", padx=2)
        ttk.Button(top, text="匯出", command=lambda: self.table.export(app.con, f"快照 {snapshot_id}",
                                                                     snap["import_id"])).pack(side="left")
        self.table = W.Table(self, [("drug_code", "代碼", 110), ("eval_result", "判定", 60),
                                    ("manual_result", "人工", 60), ("manual_reason", "理由", 160),
                                    ("group_code", "分組", 110), ("drug_name", "品名", 220), ("path", "路徑", 300)],
                             height=20)
        self.table.pack(fill="both", expand=True)
        self.load()

    def load(self):
        snap = self.app.con.execute("SELECT import_id FROM scope_snapshot WHERE id=?", (self.sid,)).fetchone()
        rows = [dict(r) for r in self.app.con.execute(
            "SELECT sm.*, md.drug_name FROM scope_member sm LEFT JOIN master_drug md ON md.import_id=? AND"
            " md.drug_code=sm.drug_code WHERE sm.snapshot_id=? ORDER BY sm.eval_result DESC, sm.drug_code",
            (snap[0], self.sid))]
        self.table.set_rows(rows)

    def decide(self, d):
        sel = self.table.selected()
        if not sel:
            W.error(self, "請明確選取品項。")
            return
        v = W.form(self, f"人工{d}（{len(sel)} 筆）", [("reason", "理由*", "long")])
        if not v:
            return
        for r in sel:
            if self.app.run(R.set_member_decision, self.app.ctx(), self.sid, r["drug_code"], d, v["reason"]) is None:
                break
        self.load()

    def bulk(self):
        reasons = R.pending_reasons(self.table.rows)
        if not reasons:
            W.info(self, "沒有待確認品項。")
            return
        labels = {f"{k}（{v}筆）": k for k, v in reasons.items()}
        v = W.form(self, "依待確認原因批次人工確認", [("path", "原因*", "choice", list(labels)),
                                                 ("decision", "結果", "choice", ("排除", "納入")),
                                                 ("reason", "理由*", "long")])
        if v:
            n = self.app.run(R.bulk_member_decision, self.app.ctx(), self.sid, labels[v["path"]], v["decision"],
                             v["reason"])
            if n is not None:
                W.info(self, f"已人工確認 {n} 筆。")
            self.load()

    def confirm(self):
        self.app.run(R.confirm_snapshot, self.app.ctx(), self.sid, ok="範圍名單已確認。")
        self.load()


class RecognitionTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        self.kw = tk.StringVar()
        self.day = tk.StringVar()
        ttk.Label(top, text="代碼／成分／ATC／分組／名稱").pack(side="left")
        ttk.Entry(top, textvariable=self.kw, width=16).pack(side="left")
        ttk.Label(top, text="查詢日期").pack(side="left")
        ttk.Entry(top, textvariable=self.day, width=11).pack(side="left")
        ttk.Button(top, text="查詢", command=self.refresh).pack(side="left", padx=3)
        for t, cmd in (("新增認定", self.new_rec), ("新增版本", self.new_rev), ("更正版本", self.correct_rev),
                       ("規則編輯／預覽", self.edit_rule), ("建立快照", self.snapshot), ("快照名單", self.open_snapshot),
                       ("送待確認", self.submit), ("確認版本", self.confirm), ("撤銷版本", self.withdraw),
                       ("分組調價方式", self.group_treatment),
                       ("匯出", lambda: self.table.export(self.app.con, "認定清單"))):
            ttk.Button(top, text=t, command=cmd).pack(side="left", padx=1)
        pw = ttk.PanedWindow(self, orient="vertical")
        pw.pack(fill="both", expand=True)
        self.table = W.Table(pw, [("recognition_no", "編號", 80), ("name", "名稱", 320), ("category", "類別", 120),
                                  ("drug_count", "涵蓋品項", 70), ("state", "有效狀態", 100),
                                  ("pending_revisions", "待確認版本", 80), ("last_updated", "最後更新", 160)],
                             height=10, on_select=self.show)
        pw.add(self.table, weight=2)
        self.revs = W.Table(pw, [("revision_no", "版本", 50), ("category", "類別", 120),
                                 ("original_category", "原始名稱", 160), ("confirm_status", "確認", 60),
                                 ("effective_from", "起日", 90), ("effective_to", "迄日", 90),
                                 ("completeness", "完整性", 60), ("rule_desc", "結構化條件", 300),
                                 ("scope_text", "範圍原文", 300), ("snapshots", "快照", 160)], height=8,
                            on_select=self.show_rev, filter_box=False)
        pw.add(self.revs, weight=2)
        self.detail = tk.Text(pw, height=8, font=W.FONT, wrap="word")
        pw.add(self.detail, weight=1)

    def refresh(self):
        self.table.set_rows(R.list_recognitions(self.app.con, self.kw.get() or None, self.day.get() or None))

    def show(self, sel):
        if len(sel) != 1:
            self.revs.set_rows([])
            return
        rows = []
        for r in self.app.con.execute("SELECT * FROM recognition_revision WHERE recognition_id=? ORDER BY revision_no",
                                      (sel[0]["id"],)):
            d = dict(r)
            d["rule_desc"] = rules.describe(json.loads(r["rule_json"])).replace("\n", " ") if r["rule_json"] else ""
            snaps = self.app.con.execute("SELECT id, status, match_count FROM scope_snapshot WHERE revision_id=?"
                                         " ORDER BY evaluated_at", (r["id"],)).fetchall()
            d["snapshots"] = "；".join(f"{s['id'][:8]}:{s['status']}({s['match_count']})" for s in snaps)
            rows.append(d)
        self.revs.set_rows(rows)

    def show_rev(self, sel):
        self.detail.delete("1.0", "end")
        if len(sel) != 1:
            return
        r = sel[0]
        con = self.app.con
        txt = [f"版本 {r['revision_no']}｜{r['category']}｜{r['confirm_status']}｜完整性 {r['completeness']}"]
        if r["supersedes_id"]:
            txt.append(f"更正前版：{r['supersedes_id'][:8]}；原因：{r['correction_reason']}")
        txt.append("條件說明：\n" + (rules.describe(json.loads(r["rule_json"])) if r["rule_json"] else "（未設定）"))
        txt.append("附帶條件：" + (r["conditions_text"] or ""))
        for d in con.execute("SELECT d.*, m.name FROM revision_decision rd JOIN decision d ON d.id=rd.decision_id"
                             " JOIN meeting_agenda a ON a.id=d.agenda_id JOIN meeting m ON m.id=a.meeting_id"
                             " WHERE rd.revision_id=?", (r["id"],)):
            txt.append(f"依據：{d['name']}［{d['nature']}］{d['result']} {d['approval_doc_no'] or ''}")
        for g in con.execute("SELECT * FROM group_treatment WHERE revision_id=?", (r["id"],)):
            txt.append(f"分組 {g['group_code']}：{g['method']}（{'部分涵蓋' if g['partial_cover'] else '全組'}）"
                       f" {g['effective_from'] or '起日待確認'} {g['confirm_status']}")
        self.detail.insert("1.0", "\n".join(txt))

    def _rec(self):
        return self.table.one(self)

    def _rev(self):
        return self.revs.one(self)

    def new_rec(self):
        if self.app.run(W.form, self, "新增認定項目（請先搜尋避免重複）", [
                ("name", "名稱*", "text"), ("unit", "管理單位", "combo", ("核價", "調價")), ("description", "說明", "long")],
                on_ok=lambda v: R.create_recognition(self.app.ctx(), **v)):
            self.refresh()

    def _rev_fields(self):
        con = self.app.con
        cases = con.execute("SELECT id, case_no, subject FROM case_record ORDER BY case_no DESC LIMIT 2000").fetchall()
        self._cases = {f"{c['case_no']} {c['subject'][:30]}": c["id"] for c in cases}
        decs = con.execute("SELECT d.id, d.nature, d.result, m.name, c.case_no FROM decision d JOIN meeting_agenda a ON"
                           " a.id=d.agenda_id JOIN meeting m ON m.id=a.meeting_id JOIN case_record c ON c.id=a.case_id"
                           " WHERE d.nature='會議決議' ORDER BY m.meeting_date DESC LIMIT 2000").fetchall()
        self._decs = {f"{d['case_no']}｜{d['name']}｜{d['result']}｜{d['id'][:6]}": d["id"] for d in decs}
        return [("category", "類別*", "choice", R.CATEGORIES), ("original_category", "原始名稱", "text"),
                ("scope_text", "適用範圍原文", "long"), ("conditions_text", "附帶條件", "long"),
                ("effective_from", "生效日（起日含）", "text"), ("effective_to", "迄日（不含）", "text"),
                ("case", "關聯案件", "choice", [""] + list(self._cases)),
                ("decision", "依據決議", "choice", [""] + list(self._decs)),
                ("completeness", "完整性", "choice", ("", "完整", "不完整", "待確認"))]

    def _rev_values(self, v):
        v = dict(v)
        case = v.pop("case")
        dec = v.pop("decision")
        v["case_id"] = self._cases.get(case) if case else None
        v["decision_ids"] = [self._decs[dec]] if dec else []
        v["completeness"] = v["completeness"] or None
        return v

    def new_rev(self):
        rec = self._rec()
        if rec and self.app.run(W.form, self, "新增認定版本", self._rev_fields(),
                                on_ok=lambda v: R.create_revision(self.app.ctx(), rec["id"], **self._rev_values(v))):
            self.show([rec])

    def correct_rev(self):
        rec, rev = self._rec(), self._rev()
        if not rec or not rev:
            return
        fields = self._rev_fields() + [("correction_reason", "更正原因*", "long")]

        def ok(v):
            vals = self._rev_values(v)
            return R.create_revision(self.app.ctx(), rec["id"], supersedes_id=rev["id"],
                                     rule=json.loads(rev["rule_json"]) if rev["rule_json"] else None, **vals)
        if self.app.run(W.form, self, "建立更正版本（不覆寫原版本）", fields, initial=rev, on_ok=ok):
            self.show([rec])

    def edit_rule(self):
        rev = self._rev()
        if rev:
            RuleEditor(self, self.app, rev)

    def snapshot(self):
        rev = self._rev()
        if not rev:
            return
        imp = active_import_id(self.app.con)
        sid = self.app.run(R.save_snapshot, self.app.ctx(), rev["id"], imp)
        if sid:
            SnapshotDialog(self, self.app, sid)
            self.show([self._rec()])

    def open_snapshot(self):
        rev = self._rev()
        if not rev:
            return
        s = self.app.con.execute("SELECT id FROM scope_snapshot WHERE revision_id=? ORDER BY evaluated_at DESC LIMIT 1",
                                 (rev["id"],)).fetchone()
        if not s:
            W.error(self, "此版本尚無快照。")
            return
        SnapshotDialog(self, self.app, s[0])

    def submit(self):
        rev = self._rev()
        if rev:
            self.app.run(R.submit_revision, self.app.ctx(), rev["id"], ok="已送待確認。")
            self.show(self.table.selected())

    def confirm(self):
        rev = self._rev()
        if not rev:
            return
        conflicts = R.category_conflicts(self.app.con, rev["id"])
        basis = None
        if conflicts:
            v = W.form(self, f"類別衝突 {len(conflicts)} 筆，須指定處理依據", [
                ("basis", "處理依據*", "long")],
                initial={"basis": ""})
            if not v or not v["basis"]:
                return
            basis = v["basis"]
        self.app.run(R.confirm_revision, self.app.ctx(), rev["id"], op_id=new_id(), conflict_basis=basis,
                     ok="認定版本已確認（發布後他人可見）。")
        self.refresh()

    def withdraw(self):
        rev = self._rev()
        if rev:
            v = W.form(self, "撤銷版本", [("reason", "原因*", "long")])
            if v:
                self.app.run(R.withdraw_revision, self.app.ctx(), rev["id"], v["reason"])
                self.show([self._rec()])

    def group_treatment(self):
        rev = self._rev()
        if not rev:
            return
        snap = R.confirmed_snapshot(self.app.con, rev["id"])
        groups = sorted({m["group_code"] for m in R.snapshot_members(self.app.con, snap["id"]) if m["group_code"]}) \
            if snap else []
        self.app.run(W.form, self, "分組調價方式（部分涵蓋不自動擴及全組）", [
            ("group_code", "分組*", "combo", groups), ("method", "調價方式", "choice", ("待確認", "DET", "第25條")),
            ("effective_from", "適用起日（不由會議日推定）", "text"), ("effective_to", "迄日", "text"),
            ("basis", "依據", "long")],
            on_ok=lambda v: R.set_group_treatment(self.app.ctx(), revision_id=rev["id"], **v))


class AnnounceTab(ttk.Frame):
    """公告複核：範圍名單 → 勾選本次調高品項 → 逐項登錄 → 驗證 → 單一交易確認。"""

    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        ttk.Label(top, text="認定版本").pack(side="left")
        self.rev_box = ttk.Combobox(top, width=70, state="readonly")
        self.rev_box.pack(side="left")
        self.rev_box.bind("<<ComboboxSelected>>", lambda e: self.load())
        for t, cmd in (("勾選品項建立調高", self.create_actions), ("修改調高", self.edit_action),
                       ("建立註記", self.create_annotation), ("驗證", self.validate), ("確認發布結果", self.confirm)):
            ttk.Button(top, text=t, command=cmd).pack(side="left", padx=2)
        pw = ttk.PanedWindow(self, orient="vertical")
        pw.pack(fill="both", expand=True)
        f1 = ttk.LabelFrame(pw, text="認定範圍名單（已確認快照）— 只能從此勾選；範圍≠調高≠註記")
        self.scope = W.Table(f1, [("drug_code", "代碼", 110), ("drug_name", "品名", 260), ("group_code", "分組", 120),
                                  ("price", "主檔支付價", 90), ("has_action", "已有調高紀錄", 90)], height=8)
        self.scope.pack(fill="both", expand=True)
        pw.add(f1, weight=2)
        f2 = ttk.LabelFrame(pw, text="本次調高名單")
        self.actions = W.Table(f2, [("drug_code", "代碼", 110), ("price_before", "調高前", 80),
                                    ("price_after", "調高後", 80), ("effective_date", "調高生效日", 90),
                                    ("contract_requirement", "簽約要求", 100), ("contract_no", "合約", 120),
                                    ("announce_doc_no", "公告文號", 120), ("status", "辦理", 70),
                                    ("confirm_status", "確認", 60), ("errors", "驗證錯誤", 360)], height=8)
        self.actions.pack(fill="both", expand=True)
        pw.add(f2, weight=2)
        f3 = ttk.LabelFrame(pw, text="預定註記（只對實際調高品項）")
        self.annos = W.Table(f3, [("drug_code", "代碼", 110), ("action", "動作", 60), ("category", "類別", 120),
                                  ("effective_date", "註記生效日", 90), ("basis", "依據", 200),
                                  ("confirm_status", "確認", 60)], height=5, filter_box=False)
        self.annos.pack(fill="both", expand=True)
        pw.add(f3, weight=1)

    def refresh(self):
        revs = self.app.con.execute(
            "SELECT rv.id, rv.revision_no, rv.category, rv.confirm_status, r.name, r.recognition_no FROM"
            " recognition_revision rv JOIN recognition r ON r.id=rv.recognition_id WHERE EXISTS (SELECT 1 FROM"
            " scope_snapshot s WHERE s.revision_id=rv.id AND s.status='已確認') ORDER BY r.recognition_no, rv.revision_no"
        ).fetchall()
        self.rev_map = {f"{r['recognition_no']} {r['name']}｜v{r['revision_no']} {r['category']}（{r['confirm_status']}）":
                        r["id"] for r in revs}
        self.rev_box.config(values=list(self.rev_map))
        self.load()

    def _rid(self):
        return self.rev_map.get(self.rev_box.get())

    def load(self):
        rid = self._rid()
        if not rid:
            for t in (self.scope, self.actions, self.annos):
                t.set_rows([])
            return
        con = self.app.con
        imp = active_import_id(con)
        act = {r[0] for r in con.execute("SELECT drug_code FROM price_action WHERE revision_id=? AND confirm_status<>'撤銷'",
                                         (rid,))}
        rows = []
        for code in sorted(R.revision_scope(con, rid)):
            m = con.execute("SELECT drug_name, group_code, price FROM master_drug WHERE import_id=? AND drug_code=?",
                            (imp, code)).fetchone() if imp else None
            rows.append({"drug_code": code, "drug_name": m["drug_name"] if m else "（目前主檔無）",
                         "group_code": m["group_code"] if m else "", "price": m["price"] if m else "",
                         "has_action": "是" if code in act else ""})
        self.scope.set_rows(rows)
        acts = []
        for r in con.execute("SELECT pa.*, c.contract_no FROM price_action pa LEFT JOIN contract c ON c.id=pa.contract_id"
                             " WHERE pa.revision_id=? ORDER BY pa.drug_code", (rid,)):
            d = dict(r)
            d["errors"] = "" if r["confirm_status"] == "已確認" else "；".join(P.validate_price_action(con, d))
            acts.append(d)
        self.actions.set_rows(acts)
        self.annos.set_rows([dict(r) for r in con.execute("SELECT * FROM annotation_event WHERE revision_id=?"
                                                          " ORDER BY drug_code", (rid,))])

    def _contract_choices(self):
        cs = self.app.con.execute("SELECT id, contract_no, firm, status FROM contract ORDER BY contract_no").fetchall()
        self._contracts = {f"{c['contract_no']} {c['firm'] or ''}（{c['status']}）": c["id"] for c in cs}
        return [""] + list(self._contracts)

    def create_actions(self):
        rid = self._rid()
        sel = self.scope.selected()
        if not rid or not sel:
            W.error(self, "請選認定版本並明確選取範圍內品項。")
            return
        cases = self.app.con.execute("SELECT id, case_no, subject FROM case_record ORDER BY case_no DESC LIMIT 2000").fetchall()
        cmap = {f"{c['case_no']} {c['subject'][:30]}": c["id"] for c in cases}
        fields = [("case", "關聯案件", "choice", [""] + list(cmap)),
                  ("contract_requirement", "簽約要求", "choice", ("須簽約", "當時無須簽約", "待確認")),
                  ("requirement_basis", "要求依據／說明", "text"), ("contract", "對應合約", "choice", self._contract_choices()),
                  ("price_after", "調高後價格（逐項可再修改）", "text"), ("effective_date", "調高生效日", "text"),
                  ("announce_doc_no", "公告文號", "text"), ("announce_date", "公告日期", "text"),
                  ("status", "辦理狀態", "choice", ("辦理中", "已核定", "未辦")),
                  ("completeness", "完整性", "choice", ("完整", "不完整"))]
        v = W.form(self, f"建立調高紀錄（{len(sel)} 品項）", fields)
        if not v:
            return
        ctx = self.app.ctx()
        imp = active_import_id(self.app.con)
        for r in sel:
            self.app.run(P.create_price_action, ctx, revision_id=rid, drug_code=r["drug_code"],
                         case_id=cmap.get(v["case"]) if v["case"] else None,
                         contract_requirement=v["contract_requirement"], requirement_basis=v["requirement_basis"],
                         contract_id=self._contracts.get(v["contract"]) if v["contract"] else None,
                         price_before=r["price"] or None, price_after=v["price_after"],
                         effective_date=v["effective_date"], announce_doc_no=v["announce_doc_no"],
                         announce_date=v["announce_date"], status=v["status"], completeness=v["completeness"])
        self.load()

    def edit_action(self):
        a = self.actions.one(self)
        if not a:
            return
        fields = [("price_before", "調高前", "text"), ("price_after", "調高後", "text"),
                  ("effective_date", "調高生效日", "text"), ("announce_doc_no", "公告文號", "text"),
                  ("announce_date", "公告日期", "text"), ("status", "辦理", "choice", ("未辦", "辦理中", "已核定", "撤回／取消")),
                  ("contract_requirement", "簽約要求", "choice", ("須簽約", "當時無須簽約", "待確認")),
                  ("requirement_basis", "依據", "text"), ("contract", "合約", "choice", self._contract_choices()),
                  ("completeness", "完整性", "choice", ("完整", "不完整"))]

        def ok(v):
            c = v.pop("contract")
            v["contract_id"] = self._contracts.get(c) if c else None
            return P.update_price_action(self.app.ctx(), a["id"], v, expected_version=a["row_version"])
        self.app.run(W.form, self, "修改調高", fields, initial=a, on_ok=ok)
        self.load()

    def create_annotation(self):
        sel = self.actions.selected()
        if not sel:
            W.error(self, "請選取本次調高品項（只對實際調高品項註記）。")
            return
        v = W.form(self, "預定註記", [("category", "註記類別", "choice", ("不可替代特殊藥品", "特殊藥品")),
                                     ("effective_date", "註記生效日（與調高生效日分欄）", "text"), ("basis", "依據", "text")])
        if not v:
            return
        for a in sel:
            self.app.run(P.create_annotation, self.app.ctx(), drug_code=a["drug_code"], action="新增",
                         category=v["category"], revision_id=a["revision_id"], price_action_id=a["id"],
                         effective_date=v["effective_date"], basis=v["basis"])
        self.load()

    def validate(self):
        self.load()
        bad = [a for a in self.actions.rows if a["errors"]]
        W.info(self, f"驗證完成：{len(bad)} 筆有錯誤。" if bad else "全部通過，可確認。")

    def confirm(self):
        acts = [a["id"] for a in self.actions.selected() if a["confirm_status"] != "已確認"]
        annos = [a["id"] for a in self.annos.rows if a["confirm_status"] != "已確認"
                 and a["price_action_id"] in acts]
        if not acts:
            W.error(self, "請明確選取要確認的調高紀錄。")
            return
        if not W.ask(self, f"確認 {len(acts)} 筆調高及 {len(annos)} 筆註記？任一失敗將整批不寫入。"):
            return
        self.app.run(P.confirm_announcement, self.app.ctx(), price_action_ids=acts, annotation_ids=annos,
                     op_id=new_id(), ok="已確認（請發布供他人查詢）。")
        self.load()
