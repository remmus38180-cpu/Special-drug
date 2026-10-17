"""共用介面元件：表格、表單對話框、訊息。"""
from __future__ import annotations

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

FONT = ("Microsoft JhengHei UI", 10)
BG = "#f2f2f2"
ACCENT = "#1f6feb"


def setup_style(root):
    root.configure(bg=BG)
    st = ttk.Style(root)
    try:
        st.theme_use("clam")
    except tk.TclError:
        pass
    st.configure(".", font=FONT, background=BG)
    st.configure("Treeview", rowheight=24, fieldbackground="white", bordercolor="#222", borderwidth=1)
    st.configure("Treeview.Heading", font=(FONT[0], 10, "bold"), background="#ddd", bordercolor="#222")
    st.configure("Banner.TLabel", background="#222", foreground="white", padding=6)
    st.configure("Warn.TLabel", foreground="#b00020")
    st.configure("Accent.TButton", foreground="white", background=ACCENT)
    st.configure("TNotebook.Tab", padding=(10, 4))


def error(parent, exc_or_msg):
    messagebox.showerror("無法完成", str(exc_or_msg), parent=parent)


def info(parent, msg):
    messagebox.showinfo("訊息", msg, parent=parent)


def ask(parent, msg) -> bool:
    return messagebox.askyesno("請確認", msg, parent=parent)


class Table(ttk.Frame):
    """表格：排序、篩選、分頁、明確選取。勾選只作用於明確選取的列。"""

    def __init__(self, master, columns, *, height=12, page_size=300, selectmode="extended", on_select=None,
                 on_double=None, filter_box=True):
        super().__init__(master)
        self.columns = columns  # [(key, 標題, 寬)]
        self.rows = []
        self.view = []
        self.page = 0
        self.page_size = page_size
        self.sort_key = None
        self.sort_rev = False
        top = ttk.Frame(self)
        top.pack(fill="x")
        self.filter_var = tk.StringVar()
        if filter_box:
            ttk.Label(top, text="篩選：").pack(side="left")
            e = ttk.Entry(top, textvariable=self.filter_var, width=24)
            e.pack(side="left")
            self.filter_var.trace_add("write", lambda *_: self._apply())
        self.count_lbl = ttk.Label(top, text="")
        self.count_lbl.pack(side="left", padx=8)
        ttk.Button(top, text="下一頁", command=lambda: self._go(1)).pack(side="right")
        ttk.Button(top, text="上一頁", command=lambda: self._go(-1)).pack(side="right")
        body = ttk.Frame(self)
        body.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(body, columns=[c[0] for c in columns], show="headings", height=height,
                                 selectmode=selectmode)
        for key, title, width in columns:
            self.tree.heading(key, text=title, command=lambda k=key: self._sort(k))
            self.tree.column(key, width=width, stretch=width > 150, anchor="w")
        ys = ttk.Scrollbar(body, orient="vertical", command=self.tree.yview)
        xs = ttk.Scrollbar(body, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        ys.grid(row=0, column=1, sticky="ns")
        xs.grid(row=1, column=0, sticky="ew")
        body.rowconfigure(0, weight=1)
        body.columnconfigure(0, weight=1)
        if on_select:
            self.tree.bind("<<TreeviewSelect>>", lambda e: on_select(self.selected()))
        if on_double:
            self.tree.bind("<Double-1>", lambda e: on_double(self.selected()))

    def set_rows(self, rows):
        self.rows = list(rows)
        self.page = 0
        self._apply()

    def _apply(self):
        f = self.filter_var.get().strip().lower()
        v = self.rows
        if f:
            v = [r for r in v if any(f in str(r.get(c[0], "") or "").lower() for c in self.columns)]
        if self.sort_key:
            v = sorted(v, key=lambda r: (r.get(self.sort_key) is None, str(r.get(self.sort_key) or "")),
                       reverse=self.sort_rev)
        self.view = v
        self._render()

    def _render(self):
        self.tree.delete(*self.tree.get_children())
        pages = max(1, (len(self.view) + self.page_size - 1) // self.page_size)
        self.page = min(self.page, pages - 1)
        s = self.page * self.page_size
        for i, r in enumerate(self.view[s:s + self.page_size]):
            vals = []
            for c in self.columns:
                x = r.get(c[0])
                vals.append("" if x is None else str(x).replace("\n", " ⏎ "))
            self.tree.insert("", "end", iid=str(s + i), values=vals)
        self.count_lbl.config(text=f"共 {len(self.view)} 筆（第 {self.page + 1}/{pages} 頁）")

    def _go(self, d):
        self.page = max(0, self.page + d)
        self._render()

    def _sort(self, key):
        self.sort_rev = (not self.sort_rev) if self.sort_key == key else False
        self.sort_key = key
        self._apply()

    def selected(self):
        return [self.view[int(i)] for i in self.tree.selection()]

    def one(self, parent=None):
        s = self.selected()
        if len(s) != 1:
            error(parent or self, "請先選取一筆資料。")
            return None
        return s[0]

    def export(self, con, conditions="", import_id=None):
        from ..export import export_csv, export_xlsx
        path = filedialog.asksaveasfilename(parent=self, defaultextension=".xlsx",
                                            filetypes=[("Excel", "*.xlsx"), ("CSV UTF-8", "*.csv")])
        if not path:
            return
        heads = [c[1] for c in self.columns]
        rows = [[r.get(c[0]) for c in self.columns] for r in self.view]
        f = export_csv if path.lower().endswith(".csv") else export_xlsx
        n = f(con, path, heads, rows, conditions=(conditions + " 篩選:" + self.filter_var.get()).strip(),
              import_id=import_id)
        info(self, f"已匯出 {n} 筆。")


class FormDialog(tk.Toplevel):
    """欄位規格：(key, 標題, 型別, 選項/預設)。型別：text/long/choice/check。"""

    def __init__(self, master, title, fields, initial=None, on_ok=None):
        super().__init__(master)
        self.title(title)
        self.configure(bg=BG)
        self.transient(master)
        self.result = None
        self.on_ok = on_ok
        self.vars = {}
        initial = initial or {}
        frm = ttk.Frame(self, padding=10)
        frm.pack(fill="both", expand=True)
        for i, f in enumerate(fields):
            key, label, typ = f[0], f[1], f[2]
            opt = f[3] if len(f) > 3 else None
            ttk.Label(frm, text=label).grid(row=i, column=0, sticky="ne", padx=4, pady=3)
            val = initial.get(key)
            if typ == "long":
                w = tk.Text(frm, width=60, height=5, font=FONT, relief="solid", borderwidth=1)
                if val:
                    w.insert("1.0", str(val))
                self.vars[key] = w
            elif typ == "choice":
                v = tk.StringVar(value=val if val is not None else (opt[0] if opt else ""))
                w = ttk.Combobox(frm, textvariable=v, values=list(opt or []), state="readonly", width=40)
                self.vars[key] = v
            elif typ == "combo":
                v = tk.StringVar(value=val or "")
                w = ttk.Combobox(frm, textvariable=v, values=list(opt or []), width=40)
                self.vars[key] = v
            elif typ == "check":
                v = tk.BooleanVar(value=bool(val))
                w = ttk.Checkbutton(frm, variable=v)
                self.vars[key] = v
            else:
                v = tk.StringVar(value="" if val is None else str(val))
                w = ttk.Entry(frm, textvariable=v, width=60)
                self.vars[key] = v
            w.grid(row=i, column=1, sticky="w", padx=4, pady=3)
        bt = ttk.Frame(frm)
        bt.grid(row=len(fields), column=0, columnspan=2, pady=8)
        ttk.Button(bt, text="確定", command=self._ok).pack(side="left", padx=4)
        ttk.Button(bt, text="取消", command=self.destroy).pack(side="left", padx=4)
        self.protocol("WM_DELETE_WINDOW", self._close)
        self.grab_set()
        self.dirty_check = initial

    def values(self):
        out = {}
        for k, v in self.vars.items():
            if isinstance(v, tk.Text):
                x = v.get("1.0", "end").strip()
            else:
                x = v.get()
                if isinstance(x, str):
                    x = x.strip()
            out[k] = x if x != "" else None
        return out

    def _ok(self):
        vals = self.values()
        if self.on_ok:
            try:
                self.result = self.on_ok(vals)
            except Exception as e:  # noqa: BLE001
                error(self, e)
                return
        else:
            self.result = vals
        self.destroy()

    def _close(self):
        vals = self.values()
        changed = any(v not in (None, False) and v != self.dirty_check.get(k) for k, v in vals.items())
        if changed and not ask(self, "有未儲存的修改，確定離開？"):
            return
        self.destroy()


def form(master, title, fields, initial=None, on_ok=None):
    d = FormDialog(master, title, fields, initial, on_ok)
    master.wait_window(d)
    return d.result


class TextView(tk.Toplevel):
    def __init__(self, master, title, text):
        super().__init__(master)
        self.title(title)
        t = tk.Text(self, width=110, height=36, font=FONT, wrap="word")
        t.insert("1.0", text)
        t.config(state="disabled")
        t.pack(fill="both", expand=True)
