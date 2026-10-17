"""附件：以SHA-256為儲存鍵，不以使用者檔名當路徑；新版本不覆蓋舊檔。"""
from __future__ import annotations

import json
import mimetypes
import os
import shutil
from pathlib import Path

from .core import BizError, Ctx, ROLE_CLERK, ROLE_REVIEWER, audit
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
