"""附件：以SHA-256為儲存鍵，不以使用者檔名當路徑；新版本不覆蓋舊檔。"""
from __future__ import annotations

import json
import mimetypes
import os
import shutil
from pathlib import Path

from .core import ALL_ROLES, BizError, Ctx, ROLE_CLERK, ROLE_REVIEWER, audit
from .db import get_setting
from .util import new_id, sha256_file, utc_now

ENTITIES = ("case_record", "meeting", "meeting_agenda", "decision", "contract", "recognition_revision", "price_action")


def storage_key(sha: str) -> str:
    return f"{sha[:2]}/{sha}"


def add_attachment(ctx: Ctx, src_path, entity, entity_id, pending_dir: Path) -> str:
    ctx.require(ROLE_CLERK, ROLE_REVIEWER)
    if entity not in ENTITIES:
        raise BizError("不支援的附件關聯對象。")
    src = Path(src_path)
    if not src.is_file():
        raise BizError("找不到檔案。")
    ext = src.suffix.lower()
    allowed = json.loads(get_setting(ctx.con, "attachment_allowed_ext", "[]"))
    if allowed and ext not in allowed:
        raise BizError(f"不允許的檔案類型 {ext}。")
    size = src.stat().st_size
    limit = int(get_setting(ctx.con, "attachment_max_mb", "50")) * 1024 * 1024
    if size > limit:
        raise BizError(f"檔案超過上限 {limit // 1024 // 1024}MB。")
    sha = sha256_file(src)
    key = storage_key(sha)
    dst = Path(pending_dir) / key
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        tmp = dst.with_name(f".{dst.name}.{new_id()}.tmp")
        shutil.copyfile(src, tmp)
        if sha256_file(tmp) != sha:
            tmp.unlink(missing_ok=True)
            raise BizError("附件複製後雜湊不符，請重試。")
        os.replace(tmp, dst)
    name = src.name
    with ctx.tx():
        ver = ctx.con.execute(
            "SELECT COALESCE(MAX(a.version),0)+1 FROM attachment a JOIN attachment_link l ON l.attachment_id=a.id"
            " WHERE l.entity=? AND l.entity_id=? AND a.orig_name=?", (entity, entity_id, name)).fetchone()[0]
        aid = new_id()
        ctx.con.execute("INSERT INTO attachment(id, orig_name, storage_key, sha256, size, mime, version, uploaded_by,"
                        " uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)",
                        (aid, name, key, sha, size, mimetypes.guess_type(name)[0], ver, ctx.actor, utc_now()))
        ctx.con.execute("INSERT INTO attachment_link(attachment_id, entity, entity_id) VALUES (?,?,?)",
                        (aid, entity, entity_id))
        audit(ctx, "attachment", aid, "上傳", after={"name": name, "sha256": sha, "entity": entity,
                                                   "entity_id": entity_id, "version": ver})
    return aid


def attachments_of(con, entity, entity_id) -> list[dict]:
    return [dict(r) for r in con.execute(
        "SELECT a.* FROM attachment a JOIN attachment_link l ON l.attachment_id=a.id WHERE l.entity=? AND l.entity_id=?"
        " ORDER BY a.orig_name, a.version", (entity, entity_id))]


def fetch_attachment(ctx: Ctx, attachment_id, dest, *, store=None, pending_dir=None) -> Path:
    """開啟／另存附件：具任一角色（查詢者以上）者可下載，查詢模式亦可；一律驗證SHA-256。

    尚未發布的附件取自本機待上傳區，已發布者經 store.fetch_attachment 自共用槽取得。
    """
    from .store import StoreError, copy_verified, storage_path
    ctx.require_role(*ALL_ROLES)
    a = ctx.con.execute("SELECT * FROM attachment WHERE id=?", (attachment_id,)).fetchone()
    if not a:
        raise BizError("找不到附件紀錄。")
    if pending_dir:
        local = storage_path(Path(pending_dir), a["storage_key"])
        if local.exists():
            return copy_verified(local, a["sha256"], Path(dest))
    if store is None:
        raise StoreError("附件不在本機，且未連接共用槽。")
    return store.fetch_attachment(a["storage_key"], a["sha256"], Path(dest))


def safe_name(name: str) -> str:
    """使用者原檔名僅作顯示及另存預設名；去除路徑與不合法字元。"""
    n = Path(str(name).replace("\\", "/")).name
    n = "".join("_" if c in '<>:"/\\|?*' or ord(c) < 32 else c for c in n).strip(" .")
    return n or "附件"


def attachment_targets(con, entity, entity_id) -> list[tuple[str, str, str]]:
    """附件入口可掛載的對象（實體, id, 說明）：案件含其議案及決議；會議含議案及決議；
    認定版本含其依據決議；合約含補充協議；調高紀錄、議案、決議為其本身。"""
    def agenda_items(where, arg):
        out = []
        for a in con.execute(
                "SELECT a.id, a.agenda_no, m.name, m.meeting_type, m.meeting_date, c.case_no FROM meeting_agenda a"
                " JOIN meeting m ON m.id=a.meeting_id JOIN case_record c ON c.id=a.case_id"
                f" WHERE {where} ORDER BY COALESCE(m.meeting_date,''), a.created_at", (arg,)):
            out.append(("meeting_agenda", a["id"], f"議案：{a['case_no']}｜{a['meeting_date'] or '日期待確認'} "
                                                   f"{a['name']} 案次{a['agenda_no'] or '—'}"))
            for d in con.execute("SELECT id, nature, result FROM decision WHERE agenda_id=? ORDER BY created_at",
                                 (a["id"],)):
                out.append(("decision", d["id"], f"決議：［{d['nature']}］{d['result']}（{a['name']}）"))
        return out

    if entity == "case_record":
        c = con.execute("SELECT case_no, subject FROM case_record WHERE id=?", (entity_id,)).fetchone()
        return [(entity, entity_id, f"案件：{c['case_no']} {c['subject'] or ''}")] + agenda_items("a.case_id=?", entity_id)
    if entity == "meeting":
        m = con.execute("SELECT name, meeting_date FROM meeting WHERE id=?", (entity_id,)).fetchone()
        return [(entity, entity_id, f"會議：{m['name']} {m['meeting_date'] or ''}")] + agenda_items("a.meeting_id=?",
                                                                                                 entity_id)
    if entity == "recognition_revision":
        r = con.execute("SELECT rv.revision_no, r.name FROM recognition_revision rv JOIN recognition r"
                        " ON r.id=rv.recognition_id WHERE rv.id=?", (entity_id,)).fetchone()
        out = [(entity, entity_id, f"認定版本：{r['name']} 第{r['revision_no']}版")]
        for d in con.execute("SELECT d.id, d.nature, d.result, m.name FROM revision_decision rd JOIN decision d"
                             " ON d.id=rd.decision_id JOIN meeting_agenda a ON a.id=d.agenda_id JOIN meeting m"
                             " ON m.id=a.meeting_id WHERE rd.revision_id=? ORDER BY d.created_at", (entity_id,)):
            out.append(("decision", d["id"], f"依據決議：［{d['nature']}］{d['result']}（{d['name']}）"))
        return out
    if entity == "contract":
        from .pricing import contract_chain
        return [("contract", c["id"], f"合約：{c['contract_no']}（{c['status']}）")
                for c in contract_chain(con, entity_id)]
    if entity == "price_action":
        pa = con.execute("SELECT drug_code, effective_date FROM price_action WHERE id=?", (entity_id,)).fetchone()
        return [(entity, entity_id, f"調高紀錄：{pa['drug_code']} 生效 {pa['effective_date'] or '待填'}")]
    if entity in ("meeting_agenda", "decision"):
        return [(entity, entity_id, "議案" if entity == "meeting_agenda" else "決議")]
    raise BizError("不支援的附件關聯對象。")
