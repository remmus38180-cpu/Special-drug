"""案件清單、案件詳情／會議時間序列、會議清單。"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from .. import cases as C
from ..attachments import attachments_of
from ..util import to_taipei
from . import widgets as W
from .attach import open_dialog


class CaseTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        self.status = tk.StringVar()
        self.summary = tk.StringVar()
        self.kw = tk.StringVar()
        ttk.Label(top, text="關鍵字").pack(side="left")
        ttk.Entry(top, textvariable=self.kw, width=18).pack(side="left")
        ttk.Label(top, text="進度").pack(side="left")
        ttk.Combobox(top, textvariable=self.status, values=("",) + C.CASE_STATUS, width=10,
                     state="readonly").pack(side="left")
        ttk.Label(top, text="結果").pack(side="left")
        ttk.Combobox(top, textvariable=self.summary, values=("",) + C.SUMMARIES, width=10,
                     state="readonly").pack(side="left")
        ttk.Button(top, text="查詢", command=self.refresh).pack(side="left", padx=4)
        for t, cmd in (("新增案件", self.new_case), ("修改", self.edit_case), ("新增品項", self.add_drug),
                       ("登錄提會", self.add_agenda), ("登錄決議", self.add_decision), ("結果摘要", self.set_summary),
                       ("結案", self.close_case), ("再提新案", self.reopen), ("附件（案件／議案／決議）", self.attach),
                       ("匯出", lambda: self.table.export(self.app.con, "案件清單"))):
            ttk.Button(top, text=t, command=cmd).pack(side="left", padx=1)
        pw = ttk.PanedWindow(self, orient="vertical")
        pw.pack(fill="both", expand=True)
        self.table = Table = W.Table(pw, [
            ("case_no", "案號", 130), ("recv_date", "收文日", 90), ("recv_doc_no", "文號", 110),
            ("subject", "主旨", 260), ("applicant", "廠商", 120), ("request_item", "申請事項", 160),
            ("drugs", "品項", 160), ("handler", "承辦", 70), ("status", "進度", 70),
            ("result_summary", "結果摘要", 80), ("completeness", "完整性", 60)], height=12,
            on_select=self.show_detail)
        pw.add(Table, weight=3)
        self.detail = tk.Text(pw, height=14, font=W.FONT, wrap="word")
        pw.add(self.detail, weight=2)

    def refresh(self):
        rows = C.list_cases(self.app.con, keyword=self.kw.get() or None, status=self.status.get() or None,
                            summary=self.summary.get() or None, limit=100000)
        self.table.set_rows(rows)

    def _case(self):
        return self.table.one(self)

    def show_detail(self, sel):
        self.detail.delete("1.0", "end")
        if len(sel) != 1:
            return
        c = sel[0]
        con = self.app.con
        lines = [f"【{c['case_no']}】{c['subject']}",
                 f"收文 {c['recv_date'] or '待確認'}／{c['recv_doc_no'] or '待確認'}；廠商 {c['applicant'] or '待確認'}；"
                 f"承辦 {c['unit'] or ''} {c['handler'] or ''}",
                 f"處理狀態：{c['status']}；結果摘要：{c['result_summary']}"
                 f"{'（確認：' + c['result_confirmed_by'] + '）' if c['result_confirmed_by'] else ''}；"
                 f"資料完整性：{c['completeness']} {c['pending_fields'] or ''}"]
        if c["prior_case_id"]:
            p = con.execute("SELECT case_no FROM case_record WHERE id=?", (c["prior_case_id"],)).fetchone()
            lines.append(f"前案：{p[0] if p else c['prior_case_id']}")
        if c["close_reason"]:
            lines.append(f"結案原因：{c['close_reason']}；依據：{c['close_basis']}")
        drugs = con.execute("SELECT * FROM case_drug WHERE case_id=? ORDER BY drug_code", (c["id"],)).fetchall()
        lines.append("品項：" + ("、".join(f"{d['drug_code']}({d['role']})" for d in drugs) or "（無）"))
        lines.append("—— 會議時間序列（專家建議與會議決議分別標示）——")
        for a in C.case_timeline(con, c["id"]):
            lines.append(f"◆ {a['meeting_date'] or '日期待確認'} {a['meeting_type']}｜{a['meeting_name']} "
                         f"{a['session_no'] or ''} 案次 {a['agenda_no'] or '—'}")
            if a["original_text"]:
                lines.append(f"   原文：{a['original_text']}")
            if a["discussion"]:
                lines.append(f"   討論：{a['discussion']}")
            for d in a["decisions"]:
                lines.append(f"   ▸［{d['nature']}］{d['result']} {d['result_text'] or ''}"
                             f"{'；條件：' + d['conditions'] if d['conditions'] else ''}"
                             f"{'；核定 ' + (d['approval_doc_no'] or '') + ' ' + (d['approval_date'] or '') if d['approval_doc_no'] else ''}")
                for x in d["drugs"]:
                    lines.append(f"      - {x['drug_code']}：{x['result']} {x['conditions'] or ''} {x['note'] or ''}")
        atts = attachments_of(con, "case_record", c["id"])
        if atts:
            lines.append("附件：" + "、".join(f"{a['orig_name']} v{a['version']}" for a in atts))
        if c["notes"]:
            lines.append("—— 備註 ——\n" + c["notes"])
        self.detail.insert("1.0", "\n".join(lines))

    def new_case(self):
        def ok(v):
            drugs = [x.strip() for x in (v.pop("drugs") or "").replace("，", ",").split(",") if x.strip()]
            return C.create_case(self.app.ctx(), drugs=drugs, **v)
        if self.app.run(W.form, self, "新增案件", [
            ("subject", "主旨*", "text"), ("recv_date", "收文日", "text"), ("recv_doc_no", "文號", "text"),
            ("applicant", "申請廠商", "text"), ("request_item", "申請事項", "text"), ("unit", "承辦單位", "combo",
                                                                                ("核價", "調價")),
            ("handler", "承辦人", "text"), ("drugs", "品項代碼（逗號分隔）", "text"), ("notes", "備註", "long")],
                on_ok=ok):
            self.refresh()

    def edit_case(self):
        c = self._case()
        if not c:
            return
        fields = [("subject", "主旨", "text"), ("recv_date", "收文日", "text"), ("recv_doc_no", "文號", "text"),
                  ("applicant", "申請廠商", "text"), ("request_item", "申請事項", "text"),
                  ("unit", "承辦單位", "combo", ("核價", "調價")), ("handler", "承辦人", "text"),
                  ("status", "處理狀態", "choice", C.CASE_STATUS[:4]),
                  ("completeness", "完整性", "choice", ("完整", "不完整", "待確認")),
                  ("pending_fields", "待確認欄位", "text"), ("notes", "備註", "long")]

        def ok(v):
            changed = {k: v[k] for k, *_ in fields if v[k] != c.get(k)}
            return C.update_case(self.app.ctx(), c["id"], changed, expected_version=c["row_version"]) if changed else True
        if self.app.run(W.form, self, "修改案件", fields, initial=c, on_ok=ok):
            self.refresh()

    def add_drug(self):
        c = self._case()
        if c and self.app.run(W.form, self, "新增品項", [("drug_code", "藥品代碼*", "text"),
                                                       ("drug_name_text", "品名", "text"),
                                                       ("role", "角色", "combo", ("申請品項", "比較品項", "其他")),
                                                       ("note", "說明", "text")],
                              on_ok=lambda v: C.add_case_drug(self.app.ctx(), c["id"], **v)):
            self.refresh()

    def add_agenda(self):
        c = self._case()
        if not c:
            return
        meetings = C.list_meetings(self.app.con)
        labels = [f"{m['meeting_date'] or '日期待確認'}｜{m['meeting_type']}｜{m['name']}｜{m['id'][:8]}" for m in meetings]

        def ok(v):
            ctx = self.app.ctx()
            if v["meeting"]:
                mid = meetings[labels.index(v["meeting"])]["id"]
            else:
                if not v["new_name"]:
                    raise ValueError("請選既有會議或輸入新會議名稱。")
                mid = C.create_meeting(ctx, meeting_type=v["new_type"], name=v["new_name"],
                                       meeting_date=v["new_date"], session_no=v["new_session"])
            return C.add_agenda(ctx, meeting_id=mid, case_id=c["id"], agenda_no=v["agenda_no"],
                                subject=v["subject"], proposal=v["proposal"], discussion=v["discussion"],
                                original_text=v["original_text"])
        if self.app.run(W.form, self, "登錄提會（同案重提請新增，不覆蓋前次）", [
            ("meeting", "選既有會議", "choice", [""] + labels),
            ("new_type", "或新增會議：類型", "choice", C.MEETING_TYPES), ("new_name", "正式名稱", "text"),
            ("new_date", "日期", "text"), ("new_session", "次別", "text"),
            ("agenda_no", "案次", "text"), ("subject", "提案主旨", "text"), ("proposal", "提案資料", "long"),
            ("discussion", "討論摘要", "long"), ("original_text", "原文紀錄", "long")], on_ok=ok):
            self.refresh()

    def add_decision(self):
        c = self._case()
        if not c:
            return
        con = self.app.con
        ags = con.execute("SELECT a.id, m.name, m.meeting_date, a.agenda_no FROM meeting_agenda a JOIN meeting m ON"
                          " m.id=a.meeting_id WHERE a.case_id=? ORDER BY m.meeting_date", (c["id"],)).fetchall()
        if not ags:
            W.error(self, "此案件尚無提會紀錄，請先「登錄提會」。")
            return
        labels = [f"{a['meeting_date'] or '日期待確認'}｜{a['name']}｜案次{a['agenda_no'] or '—'}｜{a['id'][:8]}" for a in ags]
        drugs = con.execute("SELECT * FROM case_drug WHERE case_id=? ORDER BY drug_code", (c["id"],)).fetchall()
        fields = [("agenda", "議案*", "choice", labels), ("nature", "結果性質*", "choice", ("專家建議", "會議決議")),
                  ("result", "結果*", "choice", C.RESULTS), ("result_text", "結果原文", "long"),
                  ("conditions", "附帶條件", "long"), ("approval_doc_no", "核定文號", "text"),
                  ("approval_date", "核定日期", "text")]
        for d in drugs:
            fields.append((f"drug::{d['id']}", f"品項 {d['drug_code']} 結果（空白=未列入討論）", "choice",
                           ("",) + C.RESULTS))

        def ok(v):
            dr = {k.split("::")[1]: v[k] for k in v if k.startswith("drug::") and v[k]}
            return C.add_decision(self.app.ctx(), agenda_id=ags[labels.index(v["agenda"])]["id"], nature=v["nature"],
                                  result=v["result"], result_text=v["result_text"], conditions=v["conditions"],
                                  approval_doc_no=v["approval_doc_no"], approval_date=v["approval_date"],
                                  drug_results=dr)
        if self.app.run(W.form, self, "登錄決議（逐品項結果）", fields, on_ok=ok):
            self.refresh()

    def set_summary(self):
        c = self._case()
        if not c:
            return
        con = self.app.con
        decs = con.execute("SELECT d.id, d.nature, d.result, m.name, m.meeting_date FROM decision d JOIN meeting_agenda a"
                           " ON a.id=d.agenda_id JOIN meeting m ON m.id=a.meeting_id WHERE a.case_id=?"
                           " ORDER BY m.meeting_date", (c["id"],)).fetchall()
        fields = [("summary", "結果摘要*", "choice", C.SUMMARIES), ("note", "說明", "long")]
        for d in decs:
            fields.append((f"dec::{d['id']}", f"依據：{d['meeting_date'] or '日期待確認'} {d['name']}［{d['nature']}］{d['result']}",
                           "check"))
        if self.app.run(W.form, self, "結果摘要（須連結依據，由承辦確認）", fields,
                        on_ok=lambda v: C.set_case_summary(self.app.ctx(), c["id"], v["summary"],
                                                           [k.split("::")[1] for k in v if k.startswith("dec::") and v[k]],
                                                           v["note"])):
            self.refresh()

    def close_case(self):
        c = self._case()
        if c and self.app.run(W.form, self, "結案", [("status", "狀態", "choice", ("已結案", "撤回")),
                                                    ("reason", "原因*", "long"), ("basis", "依據*", "text")],
                              on_ok=lambda v: C.close_case(self.app.ctx(), c["id"], **v)):
            self.refresh()

    def reopen(self):
        c = self._case()
        if c and self.app.run(W.form, self, "再提新案（保留與前案關聯）", [
                ("subject", "主旨", "text"), ("recv_date", "收文日", "text"), ("recv_doc_no", "文號", "text")],
                initial={"subject": c["subject"]},
                on_ok=lambda v: C.reopen_as_new(self.app.ctx(), c["id"], **v)):
            self.refresh()

    def attach(self):
        c = self._case()
        if not c:
            return
        open_dialog(self, self.app, "case_record", c["id"])


class MeetingTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        ttk.Button(top, text="新增會議", command=self.new).pack(side="left")
        ttk.Button(top, text="附件（紀錄文件／議案／決議）", command=self.attach).pack(side="left")
        ttk.Button(top, text="匯出", command=lambda: self.table.export(self.app.con, "會議清單")).pack(side="left")
        pw = ttk.PanedWindow(self, orient="vertical")
        pw.pack(fill="both", expand=True)
        self.table = W.Table(pw, [("meeting_date", "日期", 90), ("meeting_type", "類型", 80), ("name", "名稱", 360),
                                  ("session_no", "次別", 80), ("agenda_count", "關聯議案數", 90)],
                             on_select=self.show)
        pw.add(self.table, weight=3)
        self.detail = tk.Text(pw, height=10, font=W.FONT)
        pw.add(self.detail, weight=2)

    def refresh(self):
        self.table.set_rows(C.list_meetings(self.app.con))

    def show(self, sel):
        self.detail.delete("1.0", "end")
        if len(sel) != 1:
            return
        m = sel[0]
        rows = self.app.con.execute(
            "SELECT a.agenda_no, c.case_no, c.subject, (SELECT GROUP_CONCAT(nature||':'||result,'；') FROM decision d"
            " WHERE d.agenda_id=a.id) AS res FROM meeting_agenda a JOIN case_record c ON c.id=a.case_id"
            " WHERE a.meeting_id=? ORDER BY a.agenda_no", (m["id"],)).fetchall()
        txt = [f"{m['name']}（{m['meeting_type']}，{m['meeting_date'] or '日期待確認'}）"]
        txt += [f"案次 {r['agenda_no'] or '—'}｜{r['case_no']} {r['subject']}｜{r['res'] or '尚無結果'}" for r in rows]
        txt += ["附件：" + "、".join(a["orig_name"] for a in attachments_of(self.app.con, "meeting", m["id"]))]
        self.detail.insert("1.0", "\n".join(txt))

    def new(self):
        if self.app.run(W.form, self, "新增會議", [("meeting_type", "類型", "choice", C.MEETING_TYPES),
                                                ("name", "正式名稱*", "text"), ("meeting_date", "日期", "text"),
                                                ("session_no", "次別", "text"), ("notes", "備註", "long")],
                        on_ok=lambda v: C.create_meeting(self.app.ctx(), **v)):
            self.refresh()

    def attach(self):
        m = self.table.one(self)
        if not m:
            return
        open_dialog(self, self.app, "meeting", m["id"])
