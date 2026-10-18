"""合約、品項明細、主檔匯入、差異待辦、Excel移轉、稽核／管理。"""
from __future__ import annotations

import json
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, ttk

from .. import master_import as M
from .. import migration as MG
from .. import pricing as P
from ..auth import set_setting, set_user
from ..core import ALL_ROLES, ROLE_ADMIN
from ..query import drug_detail, search_drugs
from ..store import environment_check, verify_backup
from ..util import new_id, to_taipei
from . import widgets as W
from .attach import open_dialog


class ContractTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        for t, cmd in (("新增合約", self.new), ("補充協議／新版", self.supplement), ("修改", self.edit),
                       ("加入品項", self.add_drug), ("文件（開啟／另存／上傳）", self.attach), ("到期提醒", self.alerts),
                       ("匯出", lambda: self.table.export(self.app.con, "合約清單"))):
            ttk.Button(top, text=t, command=cmd).pack(side="left", padx=1)
        pw = ttk.PanedWindow(self, orient="vertical")
        pw.pack(fill="both", expand=True)
        self.table = W.Table(pw, [("contract_no", "合約編號", 130), ("firm", "廠商", 160), ("status", "狀態", 80),
                                  ("signed_date", "簽署日", 90), ("effective_from", "起日", 90),
                                  ("expiry_date", "到期日", 90), ("doc_version", "文件版本", 80),
                                  ("drugs", "品項", 240), ("expired", "到期顯示", 80)], on_select=self.show)
        pw.add(self.table, weight=3)
        self.detail = tk.Text(pw, height=10, font=W.FONT)
        pw.add(self.detail, weight=2)

    def refresh(self):
        from ..util import today
        d = today()
        rows = []
        for r in self.app.con.execute("SELECT c.*, (SELECT GROUP_CONCAT(drug_code, ',') FROM contract_drug WHERE"
                                      " contract_id=c.id) AS drugs FROM contract c ORDER BY contract_no"):
            x = dict(r)
            x["expired"] = "" if not r["expiry_date"] else ("已到期" if r["expiry_date"] < d else "有效期內")
            rows.append(x)
        self.table.set_rows(rows)

    def show(self, sel):
        self.detail.delete("1.0", "end")
        if len(sel) != 1:
            return
        out = []
        for c in P.contract_chain(self.app.con, sel[0]["id"]):
            out.append(f"■ {c['contract_no']}（{c['status']}）簽署 {c['signed_date'] or '—'} 到期 {c['expiry_date'] or '未填'}"
                       f"{'；原合約 ' + c['original_contract_id'][:8] if c['original_contract_id'] else ''}")
            out.append("   品項：" + "、".join(f"{d['drug_code']}[{d['effective_from'] or ''}~{d['effective_to'] or ''}]"
                                           for d in c["drugs"]))
            out.append("   文件：" + "、".join(f"{a['orig_name']} v{a['version']}" for a in c["attachments"]))
            if c["obligations"]:
                out.append("   供貨義務：" + c["obligations"])
        self.detail.insert("1.0", "\n".join(out))

    FIELDS = [("contract_no", "合約編號*", "text"), ("firm", "簽約廠商", "text"),
              ("status", "狀態", "choice", ("辦理中", "完成簽署", "終止")), ("signed_date", "簽訂日", "text"),
              ("effective_from", "生效日", "text"), ("expiry_date", "到期日（無則留空）", "text"),
              ("doc_version", "文件版本", "text"), ("obligations", "供貨義務摘要", "long")]

    def new(self, original=None):
        fields = self.FIELDS + [("drugs", "品項代碼（逗號分隔）", "text")]

        def ok(v):
            drugs = [x.strip() for x in (v.pop("drugs") or "").replace("，", ",").split(",") if x.strip()]
            return P.create_contract(self.app.ctx(), original_contract_id=original, drugs=drugs, **v)
        if self.app.run(W.form, self, "新增合約" if not original else "補充協議／新版合約", fields, on_ok=ok):
            self.refresh()

    def supplement(self):
        c = self.table.one(self)
        if c:
            self.new(c["id"])

    def edit(self):
        c = self.table.one(self)
        if c and self.app.run(W.form, self, "修改合約", self.FIELDS, initial=c,
                              on_ok=lambda v: P.update_contract(self.app.ctx(), c["id"], v, c["row_version"])):
            self.refresh()

    def add_drug(self):
        c = self.table.one(self)
        if c and self.app.run(W.form, self, "加入品項", [("drug_code", "藥品代碼*", "text"),
                                                       ("effective_from", "適用起日", "text"),
                                                       ("effective_to", "適用迄日", "text")],
                              on_ok=lambda v: P.add_contract_drug(self.app.ctx(), c["id"], **v)):
            self.refresh()

    def attach(self):
        c = self.table.one(self)
        if not c:
            return
        open_dialog(self, self.app, "contract", c["id"])

    def alerts(self):
        rows = P.contract_alerts(self.app.con)
        W.TextView(self, "合約到期提醒（不自動取消認定、註記或價格）",
                   "\n".join(f"{r['alert']}｜{r['contract_no']} {r['firm'] or ''} 到期 {r['expiry_date']}" for r in rows)
                   or "無")


class DrugTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        self.kw = tk.StringVar()
        self.day = tk.StringVar()
        ttk.Label(top, text="代碼／品名／成分／ATC／分組／廠商").pack(side="left")
        ttk.Entry(top, textvariable=self.kw, width=20).pack(side="left")
        ttk.Label(top, text="指定日期").pack(side="left")
        ttk.Entry(top, textvariable=self.day, width=11).pack(side="left")
        ttk.Button(top, text="搜尋", command=self.search).pack(side="left", padx=3)
        ttk.Button(top, text="依代碼直接查（含主檔外）", command=self.direct).pack(side="left")
        pw = ttk.PanedWindow(self, orient="vertical")
        pw.pack(fill="both", expand=True)
        self.table = W.Table(pw, [("drug_code", "代碼", 110), ("drug_name", "品名", 260), ("firm", "藥商", 160),
                                  ("group_code", "分組", 120), ("atc_code", "ATC", 80), ("dose_name", "劑型", 100),
                                  ("spec_qty", "規格", 60), ("spec_unit", "單位", 50), ("price", "支付價", 70),
                                  ("annotation_raw", "必要藥品註記", 90)], height=10, on_select=self.show)
        pw.add(self.table, weight=2)
        self.detail = tk.Text(pw, height=16, font=W.FONT, wrap="word")
        pw.add(self.detail, weight=3)

    def refresh(self):
        pass

    def search(self):
        imp = M.active_import_id(self.app.con)
        if not imp:
            W.error(self, "尚未啟用主檔；可用「依代碼直接查」。")
            return
        self.table.set_rows(search_drugs(self.app.con, imp, self.kw.get().strip(), limit=2000))

    def direct(self):
        code = self.kw.get().strip()
        if code:
            self.show([{"drug_code": code}])

    def show(self, sel):
        self.detail.delete("1.0", "end")
        if len(sel) != 1:
            return
        d = drug_detail(self.app.con, sel[0]["drug_code"], self.day.get().strip() or None)
        cat = d["category"]
        lines = [f"【{d['drug_code']}】查詢日期 {d['day']}"]
        if cat["conflict"]:
            lines.append("⚠ 多項認定類別衝突，不產生單一類別：" + "、".join(f"{s['name']}({s['category']})" for s in cat["sources"]))
        else:
            lines.append(f"有效認定類別：{cat['category'] or '無'}" +
                         (f"（來源：{'、'.join(s['name'] for s in cat['sources'])}）" if cat["sources"] else ""))
        lines.append(f"系統註記（已確認事件）：{d['annotation']['category'] or '無'}"
                     f"{'；有生效日未知事件' if d['annotation']['unknown_date'] else ''}")
        for m in d["master"][:3]:
            lines.append(f"主檔 {m['source_name']}（基準 {m['base_date'] or '未指定'}）：{m['drug_name']}｜分組 {m['group_code']}"
                         f"｜支付價 {m['price']}｜必要藥品註記 {m['annotation_raw']}")
        lines.append("—— 完整時間序列 ——")
        for e in d["events"]:
            lines.append(f"{e['date'] or '日期待確認'}｜{e['kind']}｜{e['text']}{'｜' + e['status'] if e['status'] else ''}")
        self.detail.insert("1.0", "\n".join(lines))


class MasterTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        for t, cmd in (("試匯入新主檔", self.wizard), ("檢視檢核", self.view_check), ("啟用", self.activate),
                       ("放棄試匯入", self.discard), ("與目前版本比較", self.diff)):
            ttk.Button(top, text=t, command=cmd).pack(side="left", padx=2)
        self.cur = ttk.Label(top, text="")
        self.cur.pack(side="left", padx=10)
        self.table = W.Table(self, [("status", "狀態", 70), ("active", "目前引用", 70), ("source_name", "來源檔", 220),
                                    ("base_date", "基準日", 90), ("row_count", "代碼數", 70),
                                    ("imported_by", "匯入者", 90), ("imported_at_l", "匯入時間", 150),
                                    ("sha", "SHA-256", 120), ("note", "備註", 200)], height=18)
        self.table.pack(fill="both", expand=True)

    def refresh(self):
        act = M.active_import_id(self.app.con)
        rows = []
        for r in self.app.con.execute("SELECT * FROM master_import ORDER BY imported_at DESC"):
            x = dict(r)
            x["active"] = "●" if r["id"] == act else ""
            x["imported_at_l"] = to_taipei(r["imported_at"])
            x["sha"] = r["sha256"][:16]
            rows.append(x)
        self.table.set_rows(rows)
        self.cur.config(text=f"目前引用主檔：{act[:8] if act else '尚未啟用'}")

    def wizard(self):
        path = filedialog.askopenfilename(parent=self, filetypes=[("Excel / CSV", "*.xlsx *.csv")])
        if not path:
            return
        try:
            sheets = M.list_sheets(path)
        except Exception as e:  # noqa: BLE001
            W.error(self, e)
            return
        v = W.form(self, "選工作表與標題列", [("sheet", "工作表", "choice", sheets), ("header_row", "標題列", "text"),
                                        ("preset", "預設映射（仍可修改）", "choice", [""] + list(M.PRESETS))],
                   initial={"header_row": "1"})
        if not v:
            return
        sheet = None if v["sheet"] == "(CSV)" else v["sheet"]
        hr = int(v["header_row"] or 1)
        try:
            headers = M.headers_of(path, sheet, hr)
        except Exception as e:  # noqa: BLE001
            W.error(self, e)
            return
        preset = M.PRESETS.get(v["preset"] or "", {"mapping": {}, "lookups": {}, "note": ""})
        fields = [(t, label, "choice", [""] + headers) for t, label in M.MASTER_FIELDS.items()]
        fields += [("base_date", "資料基準日*", "text"), ("rcode", "代碼檔 DWM_DRUG_RCODE（需代碼轉換時）", "text"),
                   ("price", "價格長表 DWM_DRPAY（選填）", "text"), ("note", "備註", "text")]
        init = {t: s for t, s in preset["mapping"].items() if s in headers}
        if preset.get("note"):
            W.info(self, preset["note"])
        rc = filedialog.askopenfilename(parent=self, title="（選填）選 DWM_DRUG_RCODE 代碼檔，取消則略過",
                                        filetypes=[("Excel / CSV", "*.xlsx *.csv")]) if preset.get("lookups") else ""
        pr = filedialog.askopenfilename(parent=self, title="（選填）選 DWM_DRPAY 價格長表，取消則略過",
                                        filetypes=[("Excel / CSV", "*.xlsx *.csv")])
        init["rcode"], init["price"] = rc or "", pr or ""

        def ok(vals):
            mapping = {t: vals[t] for t in M.MASTER_FIELDS if vals.get(t)}
            lookups = {k: lk for k, lk in preset.get("lookups", {}).items() if vals.get("rcode")
                       and (k in mapping or lk.get("from") in mapping)}
            return M.stage_import(self.app.ctx(), path, mapping, sheet=sheet, header_row=hr,
                                  base_date=vals["base_date"], lookups=lookups, rcode_path=vals["rcode"] or None,
                                  price_path=vals["price"] or None, note=vals["note"])
        self.config(cursor="watch")
        self.update()
        try:
            iid = self.app.run(W.form, self, "欄位映射（不依固定欄序）", fields, initial=init, on_ok=ok)
        finally:
            self.config(cursor="")
        if iid:
            self.refresh()
            self._show_check(iid)

    def _show_check(self, iid):
        c = M.check_of(self.app.con, iid)
        lines = [f"總列數 {c['total_rows']}、代碼數 {c['codes']}、基準日 {c['base_date'] or '未指定'}",
                 f"代碼錯誤 {c['code_error_count']}、完全相同重複 {c['identical_duplicate_count']}、內容矛盾 {c['conflict_count']}",
                 "未映射欄位（相關規則停用）：" + ("、".join(c["unmapped_fields"]) or "無")]
        lines += [f"⚠ {w}" for w in c["warnings"][:50]]
        lines += [f"代碼錯誤 第{e['row']}列：{e['error']}" for e in c["code_errors"][:50]]
        lines += [f"矛盾 {x['code']} 列{x['rows']}：{x['diffs']}" for x in c["conflicts"][:100]]
        lines += [f"重複 {x['code']} 列{x['rows']}" for x in c["identical_duplicates"][:50]]
        for k, v in c["unknown_lookup"].items():
            lines.append(f"代碼轉換找不到（{k}）：{'、'.join(v)}")
        W.TextView(self, "試匯入檢核結果", "\n".join(lines))

    def view_check(self):
        r = self.table.one(self)
        if r:
            self._show_check(r["id"])

    def activate(self):
        r = self.table.one(self)
        if not r:
            return
        c = M.check_of(self.app.con, r["id"])
        merge = False
        if c["identical_duplicate_count"]:
            merge = W.ask(self, f"有 {c['identical_duplicate_count']} 個完全相同重複代碼，確認合併後啟用？")
            if not merge:
                return
        if self.app.run(M.activate, self.app.ctx(), r["id"], confirm_merge_duplicates=merge, ok="已啟用為目前主檔。"):
            pass
        if W.ask(self, "是否產生既有認定的差異待辦（新符合／不再符合／分組異動）？"):
            n = self.app.run(P.generate_diff_todos, self.app.ctx(), r["id"])
            if n is not None:
                W.info(self, f"新增差異待辦 {n} 筆。")
        self.refresh()

    def discard(self):
        r = self.table.one(self)
        if r and W.ask(self, "放棄此試匯入？"):
            self.app.run(M.discard, self.app.ctx(), r["id"])
            self.refresh()

    def diff(self):
        r = self.table.one(self)
        act = M.active_import_id(self.app.con)
        if not r or not act:
            return
        d = M.diff_imports(self.app.con, act, r["id"])
        lines = [f"新增 {len(d['added'])}、消失 {len(d['removed'])}（不視為取消給付）、異動 {len(d['changed'])}"]
        lines += ["新增：" + "、".join(d["added"][:300])]
        lines += ["消失：" + "、".join(d["removed"][:300])]
        lines += [f"{c['drug_code']}：" + "；".join(f"{k} {a}→{b}" for k, (a, b) in c["diffs"].items())
                  for c in d["changed"][:1000]]
        W.TextView(self, "主檔版本差異", "\n".join(lines))


class DiffTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        ttk.Button(top, text="記錄處理結論", command=self.resolve).pack(side="left")
        ttk.Button(top, text="必要藥品註記比對", command=self.compare).pack(side="left", padx=4)
        ttk.Button(top, text="匯出", command=lambda: self.table.export(self.app.con, "差異待辦")).pack(side="left")
        self.table = W.Table(self, [("kind", "類型", 110), ("drug_code", "代碼", 110), ("group_code", "分組", 120),
                                    ("rec", "認定", 220), ("detail", "說明", 360), ("status", "狀態", 70),
                                    ("conclusion", "結論", 200)], height=14)
        self.table.pack(fill="both", expand=True)
        self.cmp = W.Table(self, [("drug_code", "代碼", 110), ("drug_name", "品名", 220), ("result", "比對", 140),
                                  ("detail", "說明", 360)], height=10)
        self.cmp.pack(fill="both", expand=True)

    def refresh(self):
        rows = [dict(r) for r in self.app.con.execute(
            "SELECT ri.*, r.name AS rec FROM review_item ri LEFT JOIN recognition_revision rv ON rv.id=ri.revision_id"
            " LEFT JOIN recognition r ON r.id=rv.recognition_id ORDER BY ri.status, ri.kind, ri.drug_code")]
        self.table.set_rows(rows)

    def resolve(self):
        sel = self.table.selected()
        if not sel:
            W.error(self, "請明確選取待辦。")
            return
        v = W.form(self, f"處理結論（{len(sel)} 筆）", [("status", "結果", "choice", ("已處理", "不處理")),
                                                     ("conclusion", "結論*", "long")])
        if v:
            for r in sel:
                self.app.run(P.resolve_todo, self.app.ctx(), r["id"], v["status"], v["conclusion"])
            self.refresh()

    def compare(self):
        imp = M.active_import_id(self.app.con)
        if not imp:
            W.error(self, "尚未啟用主檔。")
            return
        self.cmp.set_rows(P.compare_master(self.app.con, imp))


class MigrationTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        for t, cmd in (("讀入Excel（final工作表）", self.stage), ("合併候選", self.candidates),
                       ("確認寫入選取列", self.commit), ("略過", self.skip)):
            ttk.Button(top, text=t, command=cmd).pack(side="left", padx=2)
        self.only = tk.StringVar(value="待核對")
        ttk.Combobox(top, textvariable=self.only, values=("", "待核對", "已寫入", "略過"), width=8,
                     state="readonly").pack(side="left")
        ttk.Button(top, text="篩選", command=self.refresh).pack(side="left")
        ttk.Label(top, text="寫入後認定一律為草稿、不視為現行有效；未提供的未通過案件請由案件頁人工補登。",
                  style="Warn.TLabel").pack(side="left", padx=8)
        pw = ttk.PanedWindow(self, orient="vertical")
        pw.pack(fill="both", expand=True)
        self.table = W.Table(pw, [("row_no", "列號", 50), ("status", "狀態", 60), ("seq", "公告序號", 70),
                                  ("group_code", "分組代碼", 120), ("ann_name", "公告名稱", 200),
                                  ("category", "類別原文", 160), ("category_std", "標準類別", 110),
                                  ("meetings", "會議候選", 60), ("issue_count", "待確認數", 60)],
                             height=14, on_select=self.show)
        pw.add(self.table, weight=3)
        self.detail = tk.Text(pw, height=12, font=W.FONT, wrap="word")
        pw.add(self.detail, weight=2)

    def refresh(self):
        rows = []
        for r in MG.list_rows(self.app.con, status=self.only.get() or None):
            p = r["parsed"]
            rows.append({"id": r["id"], "row_no": r["row_no"], "status": r["status"], "seq": p.get("seq"),
                         "group_code": p.get("group_code"), "ann_name": p.get("ann_name"),
                         "category": p.get("category"), "category_std": p.get("category_std"),
                         "meetings": len(p.get("meetings", [])), "issue_count": len(r["issues"]), "_r": r,
                         "sha": r["source_sha256"]})
        self.table.set_rows(rows)

    def show(self, sel):
        self.detail.delete("1.0", "end")
        if len(sel) != 1:
            return
        r = sel[0]["_r"]
        p = r["parsed"]
        lines = [f"來源 SHA-256 {r['source_sha256'][:16]}… 工作表 {r['sheet']} 第{r['row_no']}列", "—— 待確認 ——"]
        lines += [f"• {i}" for i in r["issues"]]
        lines.append("—— 會議候選（每行一議案，日期僅有年月者留空）——")
        lines += [f"  {m['type']}｜{m['name']}｜{m['date'] or '日期待確認'}" for m in p.get("meetings", [])]
        lines.append("—— 條件草稿 ——")
        from ..rules import describe
        lines.append(describe(p["rule_ast"]) if p.get("rule_ast") else "（無）")
        lines.append("—— 原始欄位 ——")
        for k, v in json.loads(r["raw_json"]).items():
            lines.append(f"{MG.COLS.get(k, k)}：{v}")
        self.detail.insert("1.0", "\n".join(lines))

    def stage(self):
        path = filedialog.askopenfilename(parent=self, filetypes=[("Excel", "*.xlsx")])
        if path:
            r = self.app.run(MG.stage_workbook, self.app.ctx(), path)
            if r:
                W.info(self, f"讀入 {r['total']} 列：新暫存 {r['new']}、先前已暫存 {r['already_staged']}（不重複）。")
                self.refresh()

    def candidates(self):
        sha = self.table.rows[0]["sha"] if self.table.rows else None
        if not sha:
            return
        c = MG.merge_candidates(self.app.con, sha)
        W.TextView(self, "合併候選（不自動合併；確認範圍相同時，寫入時選既有認定）",
                   "\n".join(f"{x['key']}＝{x['value']}：列 {x['rows']}" for x in c) or "無")

    def commit(self):
        sel = [r for r in self.table.selected() if r["status"] == "待核對"]
        if not sel:
            W.error(self, "請明確選取待核對列。")
            return
        recs = self.app.con.execute("SELECT id, recognition_no, name FROM recognition ORDER BY recognition_no").fetchall()
        rmap = {f"{r['recognition_no']} {r['name']}": r["id"] for r in recs}
        v = W.form(self, f"確認寫入 {len(sel)} 列", [("merge", "併入既有認定（確認範圍相同才選）", "choice",
                                                     [""] + list(rmap))])
        if v is None:
            return
        n = 0
        for r in sel:
            if self.app.run(MG.commit_row, self.app.ctx(), r["id"],
                            merge_into_recognition_id=rmap.get(v["merge"]) if v["merge"] else None):
                n += 1
        W.info(self, f"已寫入 {n} 列（案件、會議、議案；認定為草稿）。")
        self.refresh()

    def skip(self):
        sel = self.table.selected()
        v = W.form(self, "略過", [("reason", "理由*", "long")]) if sel else None
        if v:
            for r in sel:
                self.app.run(MG.skip_row, self.app.ctx(), r["id"], v["reason"])
            self.refresh()


class AdminTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=6)
        self.app = app
        top = ttk.Frame(self)
        top.pack(fill="x")
        for t, cmd in (("帳號設定", self.users), ("系統設定", self.settings), ("共用槽環境驗證", self.envcheck), ("備份目前版本", self.backup),
                       ("驗證備份", self.verify), ("還原備份", self.restore), ("版本歷史", self.releases),
                       ("匯出稽核", lambda: self.table.export(self.app.con, "稽核紀錄"))):
            ttk.Button(top, text=t, command=cmd).pack(side="left", padx=2)
        self.table = W.Table(self, [("at_l", "時間", 150), ("actor", "操作者", 110), ("entity", "實體", 120),
                                    ("entity_id", "ID", 120), ("action", "動作", 80), ("reason", "理由", 200),
                                    ("diff_json", "前後差異", 500)], height=24, page_size=500)
        self.table.pack(fill="both", expand=True)

    def refresh(self):
        rows = []
        for r in self.app.con.execute("SELECT * FROM audit_event ORDER BY at DESC LIMIT 20000"):
            x = dict(r)
            x["at_l"] = to_taipei(r["at"])
            rows.append(x)
        self.table.set_rows(rows)

    def _admin(self):
        """管理功能限「管理者」角色；權限仍由業務／發布模組再檢查，不僅隱藏按鈕。"""
        ctx = self.app.ctx()
        if ROLE_ADMIN not in ctx.roles:
            W.error(self, f"帳號 {ctx.actor} 無「管理者」權限。")
            return None
        return ctx

    def users(self):
        if not self._admin():
            return
        users = self.app.con.execute("SELECT * FROM app_user ORDER BY account").fetchall()
        txt = "；".join(f"{u['account']}:{u['roles']}{'' if u['active'] else '(停用)'}" for u in users)
        fields = [("account", "帳號（作業系統帳號）*", "text"), ("display_name", "顯示名稱", "text")]
        fields += [(f"role::{r}", r, "check") for r in ALL_ROLES] + [("active", "啟用", "check")]
        W.info(self, "目前帳號：" + txt)
        self.app.run(W.form, self, "帳號設定（管理者不自動取得核定權）", fields, initial={"active": True},
                     on_ok=lambda v: set_user(self.app.ctx(), v["account"],
                                              [k.split("::")[1] for k in v if k.startswith("role::") and v[k]],
                                              v["display_name"], bool(v["active"])))

    def settings(self):
        if not self._admin():
            return
        from ..db import DEFAULT_SETTINGS
        cur = {r[0]: r[1] for r in self.app.con.execute("SELECT key, value FROM settings")}
        fields = [(k, k, "text") for k in DEFAULT_SETTINGS]

        def ok(v):
            for k in DEFAULT_SETTINGS:
                if v[k] is not None and v[k] != cur.get(k):
                    set_setting(self.app.ctx(), k, v[k])
            return True
        self.app.run(W.form, self, "系統設定（JSON值；修改留稽核）", fields, initial=cur, on_ok=ok)

    def _store(self):
        if self.app.ws.mode != "shared":
            W.error(self, "離線原型無共用槽。")
            return None
        return self.app.ws.store

    def envcheck(self):
        ctx = self._admin()
        if not ctx:
            return
        if self.app.ws.store:
            res = self.app.run(self.app.ws.store.verify_environment, ctx=ctx)
            if res is None:
                return
        else:
            root = filedialog.askdirectory(parent=self, title="選共用槽測試目錄")
            if not root:
                return
            res = environment_check(root)
        W.TextView(self, "共用槽環境驗證", "\n".join(f"{k}：{v}" for k, v in res.items()) +
                   "\n\n另須在實際共用槽人工測試：斷線、重新連線、快取、檔案占用及舊編輯者復活（見 docs/驗收）。"
                   "\n未通過者不得以簡易檔案旗標替代，正式編輯模式應停用。")

    def backup(self):
        s = self._store()
        ctx = self._admin() if s else None
        if ctx:
            p = self.app.run(s.backup, ctx=ctx)
            if p:
                W.info(self, f"已備份並驗證：{p}")

    def verify(self):
        if not self._admin():
            return
        d = filedialog.askdirectory(parent=self, title="選備份資料夾")
        if d:
            probs = verify_backup(Path(d))
            W.info(self, "備份驗證通過。" if not probs else "；".join(probs))

    def restore(self):
        s = self._store()
        if not s:
            return
        if not self.app.ws.editing:
            W.error(self, "還原須先取得編輯權。")
            return
        if not self._admin():
            return
        d = filedialog.askdirectory(parent=self, title="選備份資料夾")
        v = W.form(self, "還原（以新發布版本引用舊內容）", [("reason", "還原原因*", "long")]) if d else None
        if v:
            rid = self.app.run(s.restore, self.app.ws.lock, Path(d), ctx=self.app.ctx(), reason=v["reason"],
                               op_id=new_id())
            if rid:
                W.info(self, f"已還原為新版本 {rid}。請結束編輯並重新開始以載入。")

    def releases(self):
        s = self._store()
        if s:
            W.TextView(self, "發布版本歷史", "\n".join(
                f"{m['release_id']}｜{to_taipei(m['at'])}｜{m['operator']}@{m.get('host', '')}｜父 {m['parent']}"
                for m in s.list_releases()))
