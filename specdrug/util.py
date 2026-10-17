"""共用工具：UUID、時間、金額、代碼、日期解析。"""
from __future__ import annotations

import datetime as _dt
import hashlib
import re
import uuid
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

try:
    TAIPEI = ZoneInfo("Asia/Taipei")
except Exception:  # 無tzdata時以固定+8替代
    TAIPEI = _dt.timezone(_dt.timedelta(hours=8))


def new_id() -> str:
    return str(uuid.uuid4())


def utc_now() -> str:
    """UTC時間，ISO格式儲存。"""
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def to_taipei(utc_text: str | None) -> str:
    if not utc_text:
        return ""
    t = _dt.datetime.strptime(utc_text.rstrip("Z"), "%Y-%m-%dT%H:%M:%S.%f")
    t = t.replace(tzinfo=_dt.timezone.utc).astimezone(TAIPEI)
    return t.strftime("%Y-%m-%d %H:%M:%S")


def today() -> str:
    return _dt.datetime.now(TAIPEI).date().isoformat()


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------- 金額 ----------

def to_decimal(value) -> Decimal | None:
    """轉十進位；float先轉字串避免二進位誤差。無法解析回傳None。"""
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        value = repr(value)
    try:
        return Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, ValueError):
        return None


def dec_text(value) -> str | None:
    """正規化金額文字（12.0→12），避免同值不同寫法被判為異動。"""
    d = to_decimal(value)
    if d is None:
        return None
    if d == d.to_integral_value():
        return format(d.quantize(Decimal(1)), "f")
    return format(d.normalize(), "f")


# ---------- 代碼 ----------

class CodeError(ValueError):
    pass


def normalize_code(raw) -> tuple[str | None, str | None]:
    """回傳(正規化代碼, 錯誤訊息)。僅去前後空白；不改O/0、不補前導零。

    數值型（int/float）來源可能已遺失前導零或變科學記號，列為錯誤。
    """
    if raw is None:
        return None, "代碼空白"
    if isinstance(raw, bool):
        return None, "代碼型別錯誤"
    if isinstance(raw, (int, float, Decimal)):
        return None, f"代碼為數值型（{raw!r}），可能遺失前導零，不自行補碼"
    text = str(raw).strip()
    if not text:
        return None, "代碼空白"
    if re.fullmatch(r"[0-9.]+[Ee][+-]?[0-9]+", text):
        return None, f"代碼疑似科學記號（{text}）"
    return text, None


# ---------- 日期 ----------

_ROC = re.compile(r"^\s*(\d{2,3})[./-](\d{1,2})[./-](\d{1,2})\s*$")
_ISO = re.compile(r"^\s*(\d{4})[./-](\d{1,2})[./-](\d{1,2})")
_YMD8 = re.compile(r"^\s*(\d{4})(\d{2})(\d{2})\s*$")
_ROC7 = re.compile(r"^\s*(\d{3})(\d{2})(\d{2})\s*$")


def parse_date(value) -> str | None:
    """解析西元或民國日期，回傳ISO字串；無法解析回傳None（不猜測）。"""
    if value is None or value == "":
        return None
    if isinstance(value, _dt.datetime):
        return value.date().isoformat()
    if isinstance(value, _dt.date):
        return value.isoformat()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(int(value))
    text = str(value).strip()
    for rx, roc in ((_ISO, False), (_YMD8, False), (_ROC, True), (_ROC7, True)):
        m = rx.match(text)
        if m:
            y, mo, d = (int(x) for x in m.groups())
            if roc:
                y += 1911
            try:
                return _dt.date(y, mo, d).isoformat()
            except ValueError:
                return None
    return None


def roc_display(iso: str | None) -> str:
    if not iso:
        return ""
    y, m, d = iso.split("-")
    return f"{int(y) - 1911}/{m}/{d}"


def in_period(day: str, start: str | None, end: str | None) -> bool:
    """起日含、迄日不含；起日空白視為未知→不成立。"""
    if not start:
        return False
    if day < start:
        return False
    if end and day >= end:
        return False
    return True
