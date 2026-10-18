"""條件AST：白名單驗證、三值判定、原文規則草稿解析。

禁止把使用者文字當SQL或程式執行；所有欄位、運算子、型別採白名單。
"""
from __future__ import annotations

import json
import re
from decimal import Decimal

from .util import sha256_text, to_decimal

TRUE, FALSE, UNKNOWN = "符合", "不符合", "待確認"

# 欄位白名單：key -> (中文, 型別, master_drug欄位)
FIELDS = {
    "group_code": ("分組代碼", "text", "group_code"),
    "atc_code": ("ATC碼", "text", "atc_code"),
    "dose_code": ("核價劑型", "text", "dose_code"),
    "multi_mark": ("單複方", "text", "multi_mark"),
    "drug_code": ("藥品代碼", "text", "drug_code"),
    "firm_code": ("藥商代碼", "text", "firm_code"),
    "firm": ("藥商名稱", "text", "firm"),
    "ingredient": ("成分", "text", "ingredient"),
    "spec": ("規格", "quantity", ("spec_qty", "spec_unit")),
}
TEXT_OPS = {"eq": "等於", "ne": "不等於", "in": "屬於", "not_in": "不屬於",
            "starts_with": "前綴為", "not_starts_with": "前綴非"}
QTY_OPS = {"eq": "=", "ne": "≠", "gt": ">", "ge": "≥", "lt": "<", "le": "≤"}
LOGIC_OPS = {"and": "全部符合", "or": "任一符合", "not": "排除"}


class RuleError(ValueError):
    pass


# ---------------- 驗證 ----------------

def validate(node, path="根") -> None:
    if not isinstance(node, dict):
        raise RuleError(f"{path}：條件格式錯誤")
    op = node.get("op")
    if op in ("and", "or"):
        ch = node.get("children")
        if not isinstance(ch, list) or not ch:
            raise RuleError(f"{path}：{LOGIC_OPS[op]}群組不可為空（空規則不得當作全選）")
        for i, c in enumerate(ch):
            validate(c, f"{path}/{i + 1}")
        _only(node, {"op", "children"}, path)
        return
    if op == "not":
        c = node.get("child")
        if c is None:
            raise RuleError(f"{path}：排除條件缺少內容")
        validate(c, f"{path}/排除")
        _only(node, {"op", "child"}, path)
        return
    if op == "manual":
        if not str(node.get("text", "")).strip():
            raise RuleError(f"{path}：人工條件須保留原文")
        _only(node, {"op", "text", "id"}, path)
        return
    field = node.get("field")
    if field not in FIELDS:
        raise RuleError(f"{path}：不支援的欄位 {field!r}")
    ftype = FIELDS[field][1]
    if ftype == "text":
        if op not in TEXT_OPS:
            raise RuleError(f"{path}：欄位 {field} 不支援運算子 {op!r}")
        if op in ("in", "not_in"):
            vals = node.get("values")
            if not isinstance(vals, list) or not vals or not all(isinstance(v, str) and v.strip() for v in vals):
                raise RuleError(f"{path}：清單條件須至少一個文字值")
            _only(node, {"op", "field", "values"}, path)
        else:
            v = node.get("value")
            if not isinstance(v, str) or not v.strip():
                raise RuleError(f"{path}：條件值須為非空文字")
            _only(node, {"op", "field", "value"}, path)
    else:
        if op not in QTY_OPS:
            raise RuleError(f"{path}：規格不支援運算子 {op!r}")
        if to_decimal(node.get("value")) is None:
            raise RuleError(f"{path}：規格數值無法解析")
        if not str(node.get("unit", "")).strip():
            raise RuleError(f"{path}：規格須指定單位")
        _only(node, {"op", "field", "value", "unit"}, path)


def _only(node, allowed, path):
    extra = set(node) - allowed
    if extra:
        raise RuleError(f"{path}：不允許的屬性 {', '.join(sorted(extra))}")


def fields_used(node) -> set:
    op = node.get("op")
    if op in ("and", "or"):
        s = set()
        for c in node["children"]:
            s |= fields_used(c)
        return s
    if op == "not":
        return fields_used(node["child"])
    if op == "manual":
        return set()
    return {node["field"]}


def has_manual(node) -> bool:
    op = node.get("op")
    if op in ("and", "or"):
        return any(has_manual(c) for c in node["children"])
    if op == "not":
        return has_manual(node["child"])
    return op == "manual"


def canonical(node) -> str:
    return json.dumps(node, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def rule_hash(node) -> str:
    return sha256_text(canonical(node))


# ---------------- 判定 ----------------

def _norm_unit(u) -> str | None:
    if u is None:
        return None
    u = str(u).strip().upper()
    if not u:
        return None
    u = re.sub(r"\s*\(.*\)\s*$", "", u)  # 'L (LITER)' -> 'L'
    return u


class Evaluator:
    def __init__(self, known_units=None, conversions=None):
        self.known_units = {_norm_unit(u) for u in (known_units or [])}
        # conversions: {"L": ["ML", 1000]} 表示 1 L = 1000 ML；僅經確認者
        self.conv = {}
        for src, (dst, factor) in (conversions or {}).items():
            self.conv[(_norm_unit(src), _norm_unit(dst))] = Decimal(str(factor))
            self.conv[(_norm_unit(dst), _norm_unit(src))] = Decimal(1) / Decimal(str(factor))

    def evaluate(self, node, drug: dict) -> tuple[str, str]:
        """回傳(三值結果, 路徑說明)。"""
        op = node["op"]
        if op == "and":
            results = [self.evaluate(c, drug) for c in node["children"]]
            if any(r == FALSE for r, _ in results):
                return FALSE, next(p for r, p in results if r == FALSE)
            if any(r == UNKNOWN for r, _ in results):
                return UNKNOWN, "；".join(p for r, p in results if r == UNKNOWN)
            return TRUE, " 且 ".join(p for _, p in results)
        if op == "or":
            results = [self.evaluate(c, drug) for c in node["children"]]
            for r, p in results:
                if r == TRUE:
                    return TRUE, p
            if any(r == UNKNOWN for r, _ in results):
                return UNKNOWN, "；".join(p for r, p in results if r == UNKNOWN)
            return FALSE, "皆不符合"
        if op == "not":
            r, p = self.evaluate(node["child"], drug)
            if r == UNKNOWN:
                return UNKNOWN, f"排除條件待確認（{p}）"
            return (FALSE, f"被排除：{p}") if r == TRUE else (TRUE, f"非（{p}）")
        if op == "manual":
            return UNKNOWN, f"人工條件待確認：{node['text']}"
        field = node["field"]
        label, ftype, col = FIELDS[field]
        if ftype == "quantity":
            return self._qty(node, drug)
        val = drug.get(col)
        val = None if val is None else str(val).strip()
        if not val:
            return UNKNOWN, f"{label}缺值"
        if op == "eq":
            ok = val == node["value"].strip()
        elif op == "ne":
            ok = val != node["value"].strip()
        elif op == "in":
            ok = val in {v.strip() for v in node["values"]}
        elif op == "not_in":
            ok = val not in {v.strip() for v in node["values"]}
        elif op == "starts_with":
            ok = val.startswith(node["value"].strip())
        else:  # not_starts_with
            ok = not val.startswith(node["value"].strip())
        desc = f"{label}={val} {TEXT_OPS[op]} {node.get('value') or ','.join(node.get('values', []))}"
        return (TRUE if ok else FALSE), desc

    def _qty(self, node, drug):
        qty = to_decimal(drug.get("spec_qty"))
        unit = _norm_unit(drug.get("spec_unit"))
        want = to_decimal(node["value"])
        want_unit = _norm_unit(node["unit"])
        if qty is None or unit is None:
            return UNKNOWN, "規格缺值"
        if unit != want_unit:
            factor = self.conv.get((unit, want_unit))
            if factor is None:
                if unit in self.known_units and want_unit in self.known_units:
                    # 兩者皆已知、無經確認換算：等於→不符合、不等於→符合，大小比較無從判斷→待確認
                    op = node["op"]
                    if op == "eq":
                        return FALSE, f"規格單位{unit}≠{want_unit}"
                    if op == "ne":
                        return TRUE, f"規格單位{unit}≠{want_unit}"
                    return UNKNOWN, f"規格單位{unit}與{want_unit}無確認換算，無法比較大小"
                return UNKNOWN, f"規格單位{unit}未知或無確認換算"
            qty = qty * factor
        op = node["op"]
        ok = {"eq": qty == want, "ne": qty != want, "gt": qty > want,
              "ge": qty >= want, "lt": qty < want, "le": qty <= want}[op]
        return (TRUE if ok else FALSE), f"規格{qty}{want_unit} {QTY_OPS[op]} {want}{want_unit}"


def describe(node, depth=0) -> str:
    """人看得懂的條件說明（不需看JSON）。"""
    pad = "  " * depth
    op = node.get("op")
    if op in ("and", "or"):
        inner = "\n".join(describe(c, depth + 1) for c in node["children"])
        return f"{pad}{LOGIC_OPS[op]}：\n{inner}"
    if op == "not":
        return f"{pad}排除：\n{describe(node['child'], depth + 1)}"
    if op == "manual":
        return f"{pad}【人工條件】{node['text']}"
    label = FIELDS[node["field"]][0]
    if FIELDS[node["field"]][1] == "quantity":
        return f"{pad}{label} {QTY_OPS[op]} {node['value']} {node['unit']}"
    v = node.get("value") if "value" in node else "、".join(node["values"])
    return f"{pad}{label} {TEXT_OPS[op]} {v}"


# ---------------- 原文規則草稿解析（Excel移轉用） ----------------

_FIELD_ALIASES = [
    (re.compile(r"^分組代碼前(\d+)碼$"), "group_code", "prefix"),
    (re.compile(r"^ATC前(\d+)碼$", re.I), "atc_code", "prefix"),
    (re.compile(r"^(分類)?分組代碼$"), "group_code", None),
    (re.compile(r"^規格量?$"), "spec", "qty"),
    (re.compile(r"^ATC7?碼$", re.I), "atc_code", None),
    (re.compile(r"^(核價劑型PDOSE|核價劑型|PDOSE)$", re.I), "dose_code", None),
    (re.compile(r"^複方藥品$"), "multi_mark", None),
    (re.compile(r"^(CODE_aggr|CODE|藥品代碼)$", re.I), "drug_code", None),
]
_ATC7 = re.compile(r"^[A-Z]\d\d[A-Z][A-Z]\d\d$")


def _prep(text: str) -> str:
    t = text
    for a, b in (("＝", "="), ("，", ","), ("、", ","), ("＆", "&"), ("（", "("), ("）", ")"),
                 ("﹛", "("), ("﹜", ")"), ("｛", "("), ("｝", ")"), ("　", " "), ("≠", "<>")):
        t = t.replace(a, b)
    return t.strip()


def parse_rule_text(text: str | None):
    """回傳(ast, issues)。無法完整解析時以人工條件保存原文，不猜測。"""
    issues = []
    if text is None or not str(text).strip():
        return None, ["篩選原則空白"]
    raw = str(text).strip()
    t = _prep(raw)
    if re.search(r"=\s*0\s*$", t) or re.search(r"\)\s*=\s*0", t):
        issues.append("條件末尾含「=0」，語意不清，不自動解讀（待業務確認）")
    if "同廠牌" in t or "且" in t and "同" in t:
        issues.append("含跨品項條件（如同廠牌），須人工確認")
        return {"op": "manual", "text": raw}, issues
    try:
        toks = _tokenize(t)
        node, pos = _parse_or(toks, 0)
        if pos != len(toks):
            raise RuleError("尚有無法解析的文字")
        validate(node)
    except RuleError as e:
        issues.append(f"原文無法完整解析（{e}），保留為人工條件")
        return {"op": "manual", "text": raw}, issues
    for v in _atc_values(node):
        if not _ATC7.match(v) and len(v) == 7:
            fixed = v.replace("O", "0")
            if _ATC7.match(fixed):
                issues.append(f"ATC碼 {v} 疑似字母O／數字0誤植，標示待確認，未修正")
            else:
                issues.append(f"ATC碼 {v} 格式異常，待確認")
    return node, issues


def _atc_values(node):
    op = node.get("op")
    if op in ("and", "or"):
        for c in node["children"]:
            yield from _atc_values(c)
    elif op == "not":
        yield from _atc_values(node["child"])
    elif node.get("field") == "atc_code" and node.get("op") in ("eq", "ne", "in", "not_in"):
        yield from ([node["value"]] if "value" in node else node["values"])


_TOKEN = re.compile(r"\s*(\(|\)|&|\bor\b|\bOR\b|\bIN\b|\bin\b|<>|!=|=|,|[^\s()&=,<>!]+)")


def _tokenize(t):
    toks = []
    pos = 0
    while pos < len(t):
        m = _TOKEN.match(t, pos)
        if not m or m.end() == pos:
            if t[pos:].strip() == "":
                break
            raise RuleError(f"無法辨識「{t[pos:pos + 10]}」")
        tok = m.group(1)
        toks.append(tok.lower() if tok.lower() in ("or", "in") else tok)
        pos = m.end()
    return toks


def _parse_or(toks, i):
    left, i = _parse_and(toks, i)
    kids = [left]
    while i < len(toks) and toks[i] == "or":
        nxt, i = _parse_and(toks, i + 1)
        kids.append(nxt)
    return (kids[0] if len(kids) == 1 else {"op": "or", "children": kids}), i


def _parse_and(toks, i):
    left, i = _parse_atom(toks, i)
    kids = [left]
    while i < len(toks) and toks[i] == "&":
        nxt, i = _parse_atom(toks, i + 1)
        kids.append(nxt)
    return (kids[0] if len(kids) == 1 else {"op": "and", "children": kids}), i


def _parse_atom(toks, i):
    if i >= len(toks):
        raise RuleError("條件不完整")
    if toks[i] == "(":
        node, i = _parse_or(toks, i + 1)
        if i >= len(toks) or toks[i] != ")":
            raise RuleError("括號不對稱")
        return node, i + 1
    name = toks[i]
    field = kind = digits = None
    for rx, f, k in _FIELD_ALIASES:
        m = rx.match(name)
        if m:
            field, kind = f, k
            digits = int(m.group(1)) if k == "prefix" else None
            break
    if field is None:
        raise RuleError(f"未知欄位「{name}」")
    i += 1
    if i >= len(toks):
        raise RuleError("缺少運算子")
    op = toks[i]
    if op not in ("=", "<>", "!=", "in", ","):
        raise RuleError(f"未知運算子「{op}」")
    i += 1
    vals = []
    paren = False
    if i < len(toks) and toks[i] == "(":
        paren = True
        i += 1
    while i < len(toks):
        tk = toks[i]
        if tk == ",":
            i += 1
            continue
        if tk in ("&", "or") or (tk == ")" and not paren):
            break
        if tk == ")":
            i += 1
            paren = False
            break
        if tk in ("(", "=", "<>", "!=", "in"):
            # 下一個欄位條件（如「ATC7碼=A, ATC7碼=B」）不在此處理
            break
        # 看是否為下個欄位名稱
        if any(rx.match(tk) for rx, _, _ in _FIELD_ALIASES) and i + 1 < len(toks) and toks[i + 1] in ("=", "<>", "!=", "in"):
            break
        vals.append(tk)
        i += 1
    if paren:
        raise RuleError("括號不對稱")
    if not vals:
        raise RuleError(f"欄位「{name}」缺少條件值")
    negate = op in ("<>", "!=")
    if kind == "qty":
        if len(vals) != 1:
            raise RuleError("規格條件僅支援單一值")
        m = re.fullmatch(r"([0-9.]+)\s*([A-Za-z]+)", vals[0])
        if not m:
            raise RuleError(f"規格值「{vals[0]}」無法分成數值與單位")
        return {"field": "spec", "op": "ne" if negate else "eq", "value": m.group(1), "unit": m.group(2).upper()}, i
    if kind == "prefix":
        bad = [v for v in vals if len(v) != digits]
        if bad:
            raise RuleError(f"前{digits}碼條件值長度不符：{','.join(bad)}")
        kids = [{"field": field, "op": "not_starts_with" if negate else "starts_with", "value": v} for v in vals]
        if len(kids) == 1:
            return kids[0], i
        return ({"op": "and", "children": kids} if negate else {"op": "or", "children": kids}), i
    if len(vals) == 1:
        return {"field": field, "op": "ne" if negate else "eq", "value": vals[0]}, i
    return {"field": field, "op": "not_in" if negate else "in", "values": vals}, i
