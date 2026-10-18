"""共用槽：獨占編輯權、不可變發布版本、版本指標、附件、查詢副本、備份還原。

目錄：app／control／releases／attachments／staging／backups
- 編輯權：control/edit.lock 由檔案伺服端仲裁的獨占鎖（Windows byte-range lock、POSIX flock）；
  鎖檔永不刪除重建；control/editor.json 僅供顯示。
- 發布：staging寫完整資料→驗證→改名為releases/<id>→同一獨占權下以os.replace切換control/current.json。
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import sqlite3
import sys
from pathlib import Path

from . import __version__
from .core import ROLE_ADMIN, Ctx, audit
from .db import SCHEMA_VERSION, open_db
from .util import new_id, sha256_file, utc_now

DIRS = ("app", "control", "releases", "attachments", "staging", "backups")


class StoreError(Exception):
    pass


class LockBusy(StoreError):
    pass


class LockLost(StoreError):
    pass


class PublishConflict(StoreError):
    pass


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.{new_id()}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read_json(path: Path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def storage_path(root: Path, key: str) -> Path:
    """附件以雜湊為儲存鍵；拒絕任何路徑穿越。"""
    if not key or len(key) != 67 or key[2] != "/" or not all(c in "0123456789abcdef/" for c in key):
        raise StoreError("附件儲存鍵格式錯誤。")
    p = (root / key).resolve()
    if root.resolve() not in p.parents:
        raise StoreError("附件路徑不合法。")
    return p


class EditLock:
    """持有期間維持同一個已開啟的鎖控制物件。"""

    def __init__(self, path: Path):
        self.path = path
        self.fh = None
        self.ident = None

    def acquire(self):
        fh = open(self.path, "a+b")
        try:
            if sys.platform == "win32":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            raise LockBusy("其他人正在編輯，目前只能查詢。")
        self.fh = fh
        st = os.fstat(fh.fileno())
        self.ident = (st.st_dev, st.st_ino)

    def valid(self) -> bool:
        """鎖有效性：控制代碼仍開啟、鎖檔仍是同一物件、共用槽可存取。不明即視為無效。"""
        if self.fh is None or self.fh.closed:
            return False
        try:
            st = os.fstat(self.fh.fileno())
            st2 = os.stat(self.path)
            if (st.st_ino and st2.st_ino) and (st.st_dev, st.st_ino) != (st2.st_dev, st2.st_ino):
                return False
            return True
        except OSError:
            return False

    def release(self):
        if self.fh and not self.fh.closed:
            try:
                if sys.platform == "win32":
                    import msvcrt
                    self.fh.seek(0)
                    msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            self.fh.close()
        self.fh = None


class SharedStore:
    def __init__(self, root):
        self.root = Path(root)
        self.control = self.root / "control"
        self.releases = self.root / "releases"
        self.attachments = self.root / "attachments"
        self.staging = self.root / "staging"
        self.backups = self.root / "backups"

    # ---------- 初始化 ----------
    def exists(self) -> bool:
        return (self.control / "edit.lock").exists()

    def environment_ok(self) -> bool:
        r = _read_json(self.control / "environment.json")
        return bool(r and r.get("通過"))

    def verify_environment(self, *, ctx: Ctx) -> dict:
        """執行並記錄環境驗證；未通過時正式編輯模式停用。限管理者。"""
        ctx.require_role(ROLE_ADMIN)
        return self._record_environment()

    def _record_environment(self) -> dict:
        res = environment_check(self.root)
        res["檢查時間"] = utc_now()
        res["主機"] = socket.gethostname()
        _write_json_atomic(self.control / "environment.json", res)
        return res

    def init(self, admin_account: str, display_name: str | None = None) -> str:
        for d in DIRS:
            (self.root / d).mkdir(parents=True, exist_ok=True)
        (self.control / "edit.lock").touch(exist_ok=True)
        if self.current():
            raise StoreError("共用槽已初始化。")
        env = self._record_environment()  # 初始化時尚無帳號資料；初始化者即成為管理者
        if not env.get("通過"):
            raise StoreError("共用槽不支援可靠鎖定或不可分割替換，不能初始化正式共用版：" + json.dumps(env, ensure_ascii=False))
        lock = self.acquire_lock(admin_account)
        try:
            tmp = self.staging / f"init-{new_id()}"
            tmp.mkdir()
            db_path = tmp / "seed.sqlite"
            con = open_db(db_path)
            from .auth import bootstrap_admin
            bootstrap_admin(con, admin_account, display_name)
            con.close()
            rid = self.publish(lock, db_path, base_release_id=None, op_id=f"init-{new_id()}", operator=admin_account)
            shutil.rmtree(tmp, ignore_errors=True)
            return rid
        finally:
            lock.release()

    # ---------- 指標與鎖 ----------
    def current(self) -> dict | None:
        return _read_json(self.control / "current.json")

    def editor_info(self) -> dict | None:
        return _read_json(self.control / "editor.json")

    def acquire_lock(self, account: str) -> EditLock:
        lock = EditLock(self.control / "edit.lock")
        lock.acquire()
        try:
            _write_json_atomic(self.control / "editor.json", {
                "account": account, "host": socket.gethostname(), "pid": os.getpid(), "since": utc_now(),
                "note": "僅供顯示；編輯權以檔案伺服端獨占鎖為準"})
        except OSError:
            pass
        return lock

    def release_lock(self, lock: EditLock):
        try:
            info = self.editor_info()
            if info and info.get("pid") == os.getpid() and info.get("host") == socket.gethostname():
                _write_json_atomic(self.control / "editor.json", {"account": None, "since": utc_now()})
        except OSError:
            pass
        lock.release()

    # ---------- 發布 ----------
    def _manifest(self, rid) -> dict | None:
        return _read_json(self.releases / rid / "manifest.json")

    def find_release_by_op(self, op_id: str) -> dict | None:
        if not self.releases.exists():
            return None
        for d in self.releases.iterdir():
            m = _read_json(d / "manifest.json")
            if m and m.get("op_id") == op_id:
                return m
        return None

    def publish(self, lock: EditLock, work_db: Path, *, base_release_id, op_id, operator,
                pending_attach_dir: Path | None = None) -> str:
        if not lock.valid():
            raise LockLost("編輯權有效性不明（可能斷線），已禁止發布；本機內容保留為待復原草稿。")
        prev = self.find_release_by_op(op_id)
        cur = self.current()
        cur_id = cur["release_id"] if cur else None
        if prev:
            if cur_id == prev["release_id"]:
                return prev["release_id"]
            if cur_id == prev["parent"]:
                self._switch(lock, prev)
                return prev["release_id"]
            raise PublishConflict("此操作已形成發布版本但目前版本已變更，請重新載入核對。")
        if cur_id != base_release_id:
            raise PublishConflict("共用槽目前版本已不是開始編輯時的基準版本；不得整份覆蓋，請核對後重套變更。")
        rid = f"{utc_now()[:19].replace(':', '').replace('-', '')}-{new_id()[:8]}"
        stage = self.staging / f"{rid}.partial"
        stage.mkdir(parents=True)
        try:
            data = stage / "data.sqlite"
            src = sqlite3.connect(str(work_db))
            dst = sqlite3.connect(str(data))
            src.backup(dst)
            src.close()
            dst.execute("INSERT INTO meta(key, value) VALUES ('release_id', ?) ON CONFLICT(key) DO UPDATE SET"
                        " value=excluded.value", (rid,))
            dst.commit()
            ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
            keys = [(r[0], r[1]) for r in dst.execute("SELECT storage_key, sha256 FROM attachment")]
            dst.execute("PRAGMA journal_mode=DELETE")
            dst.close()
            if ok != "ok":
                raise StoreError(f"資料完整性檢查失敗：{ok}")
            for key, sha in keys:
                self._ensure_attachment(key, sha, pending_attach_dir)
            manifest = {
                "release_id": rid, "parent": base_release_id, "op_id": op_id, "operator": operator,
                "host": socket.gethostname(), "at": utc_now(), "schema_version": SCHEMA_VERSION,
                "app_version": __version__, "files": {"data.sqlite": sha256_file(data)},
                "attachments": len(keys),
            }
            with open(stage / "manifest.json", "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=1)
                f.flush()
                os.fsync(f.fileno())
            if sha256_file(data) != manifest["files"]["data.sqlite"]:
                raise StoreError("發布檔雜湊驗證失敗。")
            final = self.releases / rid
            os.rename(stage, final)
        except Exception:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        self._switch(lock, manifest)
        return rid

    def _switch(self, lock, manifest):
        if not lock.valid():
            raise LockLost("切換版本前編輯權失效，未切換；請重新取得編輯權後以同一操作重試。")
        cur = self.current()
        if (cur["release_id"] if cur else None) != manifest["parent"]:
            raise PublishConflict("目前版本已變更，未切換。")
        _write_json_atomic(self.control / "current.json", {
            "release_id": manifest["release_id"], "parent": manifest["parent"], "at": utc_now(),
            "sha256": manifest["files"]["data.sqlite"], "schema_version": manifest["schema_version"]})

    def _ensure_attachment(self, key, sha, pending_dir):
        dst = storage_path(self.attachments, key)
        if dst.exists():
            if sha256_file(dst) != sha:
                raise StoreError(f"共用槽附件 {key} 雜湊不符。")
            return
        src = (pending_dir / key) if pending_dir else None
        if not src or not src.exists():
            raise StoreError(f"附件 {key} 不存在，阻止發布。")
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(f".{dst.name}.{new_id()}.tmp")
        shutil.copyfile(src, tmp)
        if sha256_file(tmp) != sha:
            tmp.unlink(missing_ok=True)
            raise StoreError(f"附件 {key} 上傳後雜湊不符，阻止發布。")
        os.replace(tmp, dst)

    # ---------- 讀取 ----------
    def verify_release(self, rid) -> dict:
        m = self._manifest(rid)
        if not m:
            raise StoreError(f"版本 {rid} 缺manifest。")
        if sha256_file(self.releases / rid / "data.sqlite") != m["files"]["data.sqlite"]:
            raise StoreError(f"版本 {rid} 資料雜湊不符。")
        return m

    def fetch_release(self, rid, dest: Path) -> Path:
        """下載不可變版本到本機並驗證雜湊；失敗不覆蓋既有副本。"""
        m = self._manifest(rid)
        if not m:
            raise StoreError("版本資料不完整。")
        dest.mkdir(parents=True, exist_ok=True)
        final = dest / f"{rid}.sqlite"
        if final.exists() and sha256_file(final) == m["files"]["data.sqlite"]:
            return final
        tmp = dest / f".{rid}.{new_id()}.tmp"
        shutil.copyfile(self.releases / rid / "data.sqlite", tmp)
        if sha256_file(tmp) != m["files"]["data.sqlite"]:
            tmp.unlink(missing_ok=True)
            raise StoreError("下載的版本雜湊不符，保留原有副本。")
        os.replace(tmp, final)
        return final

    def fetch_attachment(self, key, sha, dest: Path) -> Path:
        src = storage_path(self.attachments, key)
        if not src.exists():
            raise StoreError("附件不存在或共用槽無法存取。")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        if sha256_file(dest) != sha:
            dest.unlink(missing_ok=True)
            raise StoreError("附件雜湊不符。")
        return dest

    def list_releases(self) -> list[dict]:
        out = []
        if self.releases.exists():
            for d in self.releases.iterdir():
                m = _read_json(d / "manifest.json")
                if m:
                    out.append(m)
        return sorted(out, key=lambda m: m["at"])

    # ---------- 備份還原 ----------
    def backup(self, rid=None, dest: Path | None = None, *, ctx: Ctx) -> Path:
        """限管理者。"""
        ctx.require_role(ROLE_ADMIN)
        rid = rid or self.current()["release_id"]
        m = self.verify_release(rid)
        dest = dest or (self.backups / f"backup-{rid}-{new_id()[:6]}")
        dest.mkdir(parents=True)
        shutil.copyfile(self.releases / rid / "data.sqlite", dest / "data.sqlite")
        shutil.copyfile(self.releases / rid / "manifest.json", dest / "release_manifest.json")
        con = sqlite3.connect(f"file:{dest / 'data.sqlite'}?mode=ro", uri=True)
        keys = con.execute("SELECT storage_key, sha256 FROM attachment").fetchall()
        con.close()
        files = {"data.sqlite": m["files"]["data.sqlite"]}
        for key, sha in keys:
            src = storage_path(self.attachments, key)
            out = dest / "attachments" / key
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, out)
            files["attachments/" + key] = sha
        _write_json_atomic(dest / "backup_manifest.json", {"release_id": rid, "at": utc_now(), "files": files})
        problems = verify_backup(dest)
        if problems:
            raise StoreError("備份驗證失敗：" + "；".join(problems))
        return dest

    def restore(self, lock: EditLock, backup_dir: Path, *, ctx: Ctx, reason, op_id) -> str:
        """以新發布版本引用舊內容；不改寫歷史release。限取得編輯權之管理者。"""
        ctx.require(ROLE_ADMIN)
        operator = ctx.actor
        if not reason:
            raise StoreError("還原須填寫原因。")
        problems = verify_backup(backup_dir)
        if problems:
            raise StoreError("備份驗證失敗：" + "；".join(problems))
        cur = self.current()
        work = self.staging / f"restore-{new_id()}"
        work.mkdir(parents=True)
        try:
            db = work / "restore.sqlite"
            shutil.copyfile(backup_dir / "data.sqlite", db)
            con = open_db(db)
            rctx = Ctx(con, operator, set(ctx.roles), True, request_id=op_id)
            src = json.loads((backup_dir / "backup_manifest.json").read_text(encoding="utf-8"))
            audit(rctx, "release", src["release_id"], "還原", reason=f"{reason}（自備份 {backup_dir.name}）")
            con.close()
            return self.publish(lock, db, base_release_id=cur["release_id"] if cur else None, op_id=op_id,
                                operator=operator, pending_attach_dir=backup_dir / "attachments")
        finally:
            shutil.rmtree(work, ignore_errors=True)


def verify_backup(dest: Path) -> list[str]:
    m = _read_json(Path(dest) / "backup_manifest.json")
    if not m:
        return ["缺backup_manifest.json"]
    problems = []
    for rel, sha in m["files"].items():
        p = Path(dest) / rel
        if not p.exists():
            problems.append(f"缺檔 {rel}")
        elif sha256_file(p) != sha:
            problems.append(f"雜湊不符 {rel}")
    return problems


def probe_lock(lock_path, out_path) -> None:
    """供環境驗證以另一程序嘗試取得鎖；結果寫檔（免安裝視窗程式無標準輸出）。"""
    l = EditLock(Path(lock_path))
    try:
        l.acquire()
        r = "ACQUIRED"
        l.release()
    except LockBusy:
        r = "BUSY"
    Path(out_path).write_text(r, encoding="utf-8")


def environment_check(root) -> dict:
    """在實際共用槽驗證鎖定與不可分割替換（正式上線前的環境驗收條件）。

    另需人工測試：斷線、重新連線、快取、檔案占用及舊編輯者復活。
    """
    import subprocess
    root = Path(root)
    res = {}
    t = root / "control" / f"envcheck-{new_id()[:8]}"
    t.mkdir(parents=True, exist_ok=True)
    try:
        lockfile = t / "probe.lock"
        lockfile.touch()
        a = EditLock(lockfile)
        a.acquire()
        out_file = t / "probe.out"
        if getattr(sys, "frozen", False):
            cmd = [sys.executable, "--probe-lock", str(lockfile), str(out_file)]
        else:
            cmd = [sys.executable, "-c", "import sys;sys.path.insert(0,sys.argv[1]);from specdrug.store import probe_lock;"
                   "probe_lock(sys.argv[2],sys.argv[3])", str(Path(__file__).resolve().parent.parent), str(lockfile),
                   str(out_file)]
        subprocess.run(cmd, timeout=60)
        out = out_file.read_text(encoding="utf-8") if out_file.exists() else ""
        res["另一程序無法同時取得鎖"] = "BUSY" in out
        a.release()
        p = t / "pointer.json"
        _write_json_atomic(p, {"v": 1})
        _write_json_atomic(p, {"v": 2})
        res["os.replace不可分割替換"] = _read_json(p) == {"v": 2}
        d1 = t / "dir.partial"
        d1.mkdir()
        os.rename(d1, t / "dir.final")
        res["目錄改名"] = (t / "dir.final").exists()
    except Exception as e:  # noqa: BLE001
        res["錯誤"] = str(e)
    finally:
        shutil.rmtree(t, ignore_errors=True)
    res["通過"] = all(v is True for k, v in res.items() if k != "錯誤") and "錯誤" not in res
    return res
