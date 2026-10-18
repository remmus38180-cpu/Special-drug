"""業務模組共用：操作情境、權限檢查、稽核、樂觀版本檢查。"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

from .db import Tx
from .util import new_id, utc_now

ROLE_VIEWER = "查詢者"
ROLE_CLERK = "登記者"
ROLE_REVIEWER = "複核登記者"
ROLE_ADMIN = "管理者"
ALL_ROLES = (ROLE_VIEWER, ROLE_CLERK, ROLE_REVIEWER, ROLE_ADMIN)


class BizError(Exception):
    """業務規則錯誤；訊息為繁體中文原因與下一步。"""


class PermissionDenied(BizError):
    pass


class VersionConflict(BizError):
    pass


@dataclass
class Ctx:
    con: sqlite3.Connection
    actor: str
    roles: set = field(default_factory=set)
    editable: bool = True  # 查詢模式（未取得編輯權）為False
    request_id: str | None = None

    def require(self, *roles: str) -> None:
        if not self.editable:
            raise PermissionDenied("目前為查詢模式，請先「開始編輯」取得編輯權。")
        if not (self.roles & set(roles)):
            raise PermissionDenied(f"帳號 {self.actor} 無「{'／'.join(roles)}」權限。")

    def require_role(self, *roles: str) -> None:
        """只檢查角色（不要求編輯權），供查詢模式可用之管理或下載功能。"""
        if not (self.roles & set(roles)):
            raise PermissionDenied(f"帳號 {self.actor} 無「{'／'.join(roles)}」權限。")

    def tx(self):
        return Tx(self.con)


def audit(ctx: Ctx, entity: str, entity_id: str | None, action: str,
          before: dict | None = None, after: dict | None = None, reason: str | None = None) -> None:
    diff = None
    if before is not None or after is not None:
        b = before or {}
        a = after or {}
        keys = sorted(set(b) | set(a))
        diff = {k: [b.get(k), a.get(k)] for k in keys if b.get(k) != a.get(k)}
    ctx.con.execute(
        "INSERT INTO audit_event(id, at, actor, entity, entity_id, action, diff_json, reason, request_id)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (new_id(), utc_now(), ctx.actor, entity, entity_id, action,
         json.dumps(diff, ensure_ascii=False, default=str) if diff is not None else None,
         reason, ctx.request_id),
    )


def row_dict(row) -> dict | None:
    return dict(row) if row is not None else None


def insert(ctx: Ctx, table: str, values: dict, reason: str | None = None) -> str:
    values = dict(values)
    values.setdefault("id", new_id())
    now = utc_now()
    cols = {r[1] for r in ctx.con.execute(f"PRAGMA table_info({table})")}
    if "created_by" in cols:
        values.setdefault("created_by", ctx.actor)
        values.setdefault("created_at", now)
        values.setdefault("updated_by", ctx.actor)
        values.setdefault("updated_at", now)
    unknown = set(values) - cols
    if unknown:
        raise BizError(f"{table} 無欄位：{', '.join(sorted(unknown))}")
    keys = list(values)
    ctx.con.execute(
        f"INSERT INTO {table} ({', '.join(keys)}) VALUES ({', '.join('?' * len(keys))})",
        [values[k] for k in keys],
    )
    audit(ctx, table, values["id"], "新增", None, values, reason)
    return values["id"]


def update(ctx: Ctx, table: str, id_: str, changes: dict, expected_version: int | None = None,
           reason: str | None = None) -> dict:
    """更新並檢查row_version，避免舊資料覆蓋新版。"""
    before = row_dict(ctx.con.execute(f"SELECT * FROM {table} WHERE id=?", (id_,)).fetchone())
    if before is None:
        raise BizError(f"找不到 {table} 資料（{id_}）。")
    if expected_version is not None and before.get("row_version") != expected_version:
        raise VersionConflict("資料已被更新（版本不符），請重新載入核對後再儲存；本次修改未寫入。")
    changes = dict(changes)
    if "row_version" in before:
        changes["row_version"] = before["row_version"] + 1
        changes["updated_by"] = ctx.actor
        changes["updated_at"] = utc_now()
    sets = ", ".join(f"{k}=?" for k in changes)
    ctx.con.execute(f"UPDATE {table} SET {sets} WHERE id=?", [*changes.values(), id_])
    after = dict(before, **changes)
    audit(ctx, table, id_, "修改", before, after, reason)
    return after


def get(ctx_or_con, table: str, id_: str) -> dict | None:
    con = ctx_or_con.con if isinstance(ctx_or_con, Ctx) else ctx_or_con
    return row_dict(con.execute(f"SELECT * FROM {table} WHERE id=?", (id_,)).fetchone())


def op_seen(ctx: Ctx, op_id: str | None):
    """唯一操作id：已執行過則回傳先前結果id，避免重送產生第二份正式結果。"""
    if not op_id:
        return None
    row = ctx.con.execute("SELECT entity_id FROM op_log WHERE op_id=?", (op_id,)).fetchone()
    return row[0] if row else None


def op_record(ctx: Ctx, op_id: str | None, kind: str, entity_id: str) -> None:
    if op_id:
        ctx.con.execute("INSERT INTO op_log(op_id, kind, entity_id, at) VALUES (?,?,?,?)",
                        (op_id, kind, entity_id, utc_now()))
