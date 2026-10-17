"""帳號與角色：以作業系統帳號識別；角色存於資料庫並由業務模組檢查。

注意：可直接寫入共用槽者仍可能繞過程式；應用層角色與稽核不是防竄改安全邊界。
"""
from __future__ import annotations

import getpass
import os

from .core import ALL_ROLES, BizError, Ctx, ROLE_ADMIN, ROLE_REVIEWER, audit
from .util import utc_now


def os_account() -> str:
    dom = os.environ.get("USERDOMAIN")
    user = getpass.getuser()
    return f"{dom}\\{user}" if dom and os.name == "nt" else user


def bootstrap_admin(con, account, display_name=None):
    if con.execute("SELECT COUNT(*) FROM app_user").fetchone()[0]:
        return
    now = utc_now()
    con.execute("INSERT INTO app_user(account, display_name, roles, created_by, created_at, updated_by, updated_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (account, display_name or account, f"{ROLE_ADMIN},{ROLE_REVIEWER}", account, now, account, now))
    audit(Ctx(con, account, set(), True), "app_user", account, "初始化管理者")


def roles_of(con, account) -> set:
    row = con.execute("SELECT roles, active FROM app_user WHERE account=?", (account,)).fetchone()
    if not row or not row["active"]:
        return set()
    return {r.strip() for r in row["roles"].split(",") if r.strip()}


def set_user(ctx: Ctx, account, roles, display_name=None, active=True):
    """管理者設定帳號；管理權限不自動取得業務核定權限（須明確指派）。"""
    ctx.require(ROLE_ADMIN)
    bad = set(roles) - set(ALL_ROLES)
    if bad:
        raise BizError(f"未知角色：{', '.join(bad)}")
    with ctx.tx():
        before = ctx.con.execute("SELECT * FROM app_user WHERE account=?", (account,)).fetchone()
        now = utc_now()
        if before:
            ctx.con.execute("UPDATE app_user SET roles=?, display_name=?, active=?, updated_by=?, updated_at=?,"
                            " row_version=row_version+1 WHERE account=?",
                            (",".join(roles), display_name or before["display_name"], int(active), ctx.actor, now,
                             account))
        else:
            ctx.con.execute("INSERT INTO app_user(account, display_name, roles, active, created_by, created_at,"
                            " updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                            (account, display_name or account, ",".join(roles), int(active), ctx.actor, now,
                             ctx.actor, now))
        audit(ctx, "app_user", account, "設定帳號", dict(before) if before else None,
              {"roles": ",".join(roles), "active": int(active)})


def set_setting(ctx: Ctx, key, value):
    """管理者修改系統設定（JSON值須可解析），留稽核。"""
    import json
    ctx.require(ROLE_ADMIN)
    from .db import DEFAULT_SETTINGS
    if key not in DEFAULT_SETTINGS:
        raise BizError(f"不支援的設定：{key}")
    try:
        json.loads(value)
    except (TypeError, ValueError):
        raise BizError("設定值須為有效JSON（數字、字串須加引號、清單或物件）。")
    with ctx.tx():
        before = ctx.con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        ctx.con.execute("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (key, value))
        audit(ctx, "settings", key, "修改", {"value": before[0] if before else None}, {"value": value})
