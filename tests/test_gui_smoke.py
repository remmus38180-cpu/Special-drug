"""GUI煙霧測試：附件入口（案件／議案／決議／會議／認定版本／調高／合約）開啟、另存，及管理功能權限。

需tkinter與顯示器（Linux可用 xvfb-run）；無則略過。
"""
import os
import sys

import pytest

tk = pytest.importorskip("tkinter")
if not sys.platform.startswith("linux") or not os.environ.get("DISPLAY"):
    pytest.skip("僅於Linux顯示器環境執行（可用 xvfb-run）", allow_module_level=True)

from conftest import BASE_ROWS, MAPPING, write_master  # noqa: E402
from specdrug import cases as C  # noqa: E402
from specdrug import master_import as M  # noqa: E402
from specdrug import pricing as P  # noqa: E402
from specdrug import recognition as R  # noqa: E402
from specdrug.attachments import add_attachment  # noqa: E402
from specdrug.auth import set_user  # noqa: E402
from specdrug.core import ROLE_VIEWER  # noqa: E402
from specdrug.store import SharedStore  # noqa: E402
from specdrug.workspace import Workspace  # noqa: E402


def test_gui_attachment_entries_and_admin_guard(tmp_path, monkeypatch):
    from specdrug.gui import attach as A
    from specdrug.gui import widgets as W
    from specdrug.gui.app import App
    msgs, opened = [], []
    monkeypatch.setattr(W, "error", lambda p, m: msgs.append(("error", str(m))))
    monkeypatch.setattr(W, "info", lambda p, m: msgs.append(("info", str(m))))
    monkeypatch.setattr(A.filedialog, "asksaveasfilename",
                        lambda **k: str(tmp_path / "out" / f"{len(msgs)}_{k['initialfile']}"))
    s = SharedStore(tmp_path / "share")
    s.init("admin")
    ws = Workspace(tmp_path / "ed", s.root, "admin")
    ws.refresh_view()
    ws.start_edit()
    ctx = ws.ctx()
    set_user(ctx, "viewer", [ROLE_VIEWER])
    iid = M.stage_import(ctx, write_master(tmp_path / "m.csv", BASE_ROWS), MAPPING, base_date="2026-10-01")
    M.activate(ctx, iid)
    cid = C.create_case(ctx, subject="GUI案", drugs=["B000004100"])
    mid = C.create_meeting(ctx, meeting_type="專家", name="專家會議", meeting_date="2026-05-01")
    ag = C.add_agenda(ctx, meeting_id=mid, case_id=cid)
    dec = C.add_decision(ctx, agenda_id=ag, nature="專家建議", result="同意")
    rec = R.create_recognition(ctx, name="GUI認定")
    rev = R.create_revision(ctx, rec, category="特殊藥品", rule={"field": "drug_code", "op": "eq", "value": "B000004100"},
                            effective_from="2020-01-01", decision_ids=[dec])
    R.confirm_snapshot(ctx, R.save_snapshot(ctx, rev, iid))
    R.confirm_revision(ctx, rev)
    pa = P.create_price_action(ctx, revision_id=rev, drug_code="B000004100")
    kid = P.create_contract(ctx, contract_no="K1", drugs=["B000004100"])
    f = tmp_path / "doc.pdf"
    f.write_bytes(b"pdfdata")
    for e, i in (("decision", dec), ("meeting_agenda", ag), ("recognition_revision", rev), ("price_action", pa),
                 ("contract", kid), ("meeting", mid), ("case_record", cid)):
        add_attachment(ctx, f, e, i, ws.pending_dir)
    ws.publish()
    ws.end_edit("keep")
    monkeypatch.setattr(A.subprocess, "Popen", lambda args: opened.append(args[-1]))
    cases = [("case_record", cid, ["case_record", "meeting_agenda", "decision"]),
             ("meeting", mid, ["meeting", "meeting_agenda", "decision"]),
             ("recognition_revision", rev, ["recognition_revision", "decision"]),
             ("price_action", pa, ["price_action"]), ("contract", kid, ["contract"])]
    for account in ("admin", "viewer"):
        q = Workspace(tmp_path / f"q-{account}", s.root, account)
        q.refresh_view()
        app = App(q)
        msgs.clear()
        opened.clear()
        for entity, eid, expect in cases:
            d = A.AttachmentDialog(app, app, entity, eid)
            assert [t[0] for t in d.targets] == expect
            for k in range(len(d.targets)):
                d.target.current(k)
                d.load()
                d.table.tree.selection_set("0")
                d.save_as()
                d.open()
            d.destroy()
        assert not [m for m in msgs if m[0] == "error"], msgs
        assert len(opened) == 10 and all(open(p, "rb").read() == b"pdfdata" for p in opened)
        tabs = {type(t).__name__: t for t in app.tabs}
        for name in ("CaseTab", "MeetingTab", "ContractTab", "RecognitionTab", "AnnounceTab"):
            assert callable(tabs[name].attach)
        msgs.clear()
        tabs["AdminTab"].backup()
        if account == "viewer":
            assert msgs[0][0] == "error" and "管理者" in msgs[0][1]
        else:
            assert msgs[0][0] == "info" and "已備份" in msgs[0][1]
        app.destroy()
        q.close()
