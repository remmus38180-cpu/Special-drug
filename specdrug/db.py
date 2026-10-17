"""本機工作資料庫（SQLite）結構與連線。

共用槽只放關閉且不可變的發布檔；查詢與修改都在本機副本進行。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_VERSION = 1

COMMON = """
    created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT,
    row_version INTEGER NOT NULL DEFAULT 1
"""

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS app_user (
    account TEXT PRIMARY KEY,
    display_name TEXT,
    roles TEXT NOT NULL DEFAULT '查詢者',
    active INTEGER NOT NULL DEFAULT 1,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS case_record (
    id TEXT PRIMARY KEY,
    case_no TEXT NOT NULL UNIQUE,
    recv_date TEXT, recv_doc_no TEXT, subject TEXT, applicant TEXT,
    request_item TEXT, unit TEXT, handler TEXT,
    status TEXT NOT NULL DEFAULT '辦理中'
        CHECK (status IN ('辦理中','待補件','待提會','待後續辦理','已結案','撤回')),
    result_summary TEXT NOT NULL DEFAULT '尚無結論'
        CHECK (result_summary IN ('尚無結論','全部同意','部分同意','全部不同意','撤回','其他')),
    result_summary_note TEXT,
    result_confirmed_by TEXT, result_confirmed_at TEXT,
    completeness TEXT NOT NULL DEFAULT '完整' CHECK (completeness IN ('完整','不完整','待確認')),
    pending_fields TEXT,
    close_reason TEXT, close_basis TEXT,
    prior_case_id TEXT REFERENCES case_record(id),
    source_ref TEXT, notes TEXT,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS case_summary_decision (
    case_id TEXT NOT NULL REFERENCES case_record(id),
    decision_id TEXT NOT NULL REFERENCES decision(id),
    PRIMARY KEY (case_id, decision_id)
);

CREATE TABLE IF NOT EXISTS case_drug (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES case_record(id),
    drug_code TEXT NOT NULL,
    drug_name_text TEXT,
    role TEXT NOT NULL DEFAULT '申請品項',
    note TEXT,
    {COMMON},
    UNIQUE (case_id, drug_code)
);

CREATE TABLE IF NOT EXISTS meeting (
    id TEXT PRIMARY KEY,
    meeting_type TEXT NOT NULL CHECK (meeting_type IN ('專家','藥事小組','共同擬訂','其他')),
    name TEXT NOT NULL,
    meeting_date TEXT,
    session_no TEXT,
    notes TEXT,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS meeting_agenda (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meeting(id),
    case_id TEXT NOT NULL REFERENCES case_record(id),
    agenda_no TEXT, subject TEXT, proposal TEXT, discussion TEXT, original_text TEXT,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS decision (
    id TEXT PRIMARY KEY,
    agenda_id TEXT NOT NULL REFERENCES meeting_agenda(id),
    nature TEXT NOT NULL CHECK (nature IN ('專家建議','會議決議')),
    result TEXT NOT NULL CHECK (result IN
        ('同意','不同意','附條件同意','補充資料後再議','暫緩','其他','待確認')),
    result_text TEXT,
    conditions TEXT,
    approval_doc_no TEXT, approval_date TEXT,
    supersedes_id TEXT REFERENCES decision(id),
    correction_reason TEXT,
    {COMMON},
    CHECK (result <> '其他' OR (result_text IS NOT NULL AND result_text <> ''))
);

CREATE TABLE IF NOT EXISTS decision_drug (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL REFERENCES decision(id),
    case_drug_id TEXT NOT NULL REFERENCES case_drug(id),
    result TEXT NOT NULL CHECK (result IN
        ('同意','不同意','附條件同意','補充資料後再議','暫緩','其他','待確認')),
    conditions TEXT, note TEXT,
    {COMMON},
    UNIQUE (decision_id, case_drug_id)
);

CREATE TABLE IF NOT EXISTS recognition (
    id TEXT PRIMARY KEY,
    recognition_no TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    unit TEXT, description TEXT,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS recognition_revision (
    id TEXT PRIMARY KEY,
    recognition_id TEXT NOT NULL REFERENCES recognition(id),
    revision_no INTEGER NOT NULL,
    category TEXT,
    original_category TEXT,
    scope_text TEXT,
    rule_json TEXT,
    conditions_text TEXT,
    effective_from TEXT, effective_to TEXT,
    decision_id TEXT REFERENCES decision(id),
    case_id TEXT REFERENCES case_record(id),
    confirm_status TEXT NOT NULL DEFAULT '草稿'
        CHECK (confirm_status IN ('草稿','待確認','已確認','撤銷')),
    supersedes_id TEXT REFERENCES recognition_revision(id),
    correction_reason TEXT,
    completeness TEXT NOT NULL DEFAULT '完整' CHECK (completeness IN ('完整','不完整','待確認')),
    confirmed_by TEXT, confirmed_at TEXT,
    {COMMON},
    UNIQUE (recognition_id, revision_no)
);

CREATE TABLE IF NOT EXISTS revision_decision (
    revision_id TEXT NOT NULL REFERENCES recognition_revision(id),
    decision_id TEXT NOT NULL REFERENCES decision(id),
    link_type TEXT NOT NULL DEFAULT '依據',
    PRIMARY KEY (revision_id, decision_id, link_type)
);

CREATE TABLE IF NOT EXISTS master_import (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'drug',
    source_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    base_date TEXT,
    sheet TEXT, header_row INTEGER,
    mapping_json TEXT NOT NULL,
    imported_by TEXT, imported_at TEXT,
    row_count INTEGER, check_json TEXT,
    status TEXT NOT NULL CHECK (status IN ('試匯入','已啟用','已停用','失敗')),
    activated_by TEXT, activated_at TEXT,
    note TEXT
);

CREATE TABLE IF NOT EXISTS master_drug (
    import_id TEXT NOT NULL REFERENCES master_import(id),
    drug_code TEXT NOT NULL,
    drug_code_raw TEXT,
    drug_name TEXT, firm TEXT, firm_code TEXT,
    group_code TEXT, group_name TEXT,
    atc_code TEXT, atc_name TEXT,
    dose_code TEXT, dose_name TEXT,
    ingredient TEXT, strength TEXT,
    multi_mark TEXT,
    spec_qty TEXT, spec_unit TEXT,
    price TEXT,
    annotation_raw TEXT,
    license_no TEXT,
    source_row INTEGER,
    extra_json TEXT,
    PRIMARY KEY (import_id, drug_code)
);
CREATE INDEX IF NOT EXISTS ix_master_group ON master_drug(import_id, group_code);
CREATE INDEX IF NOT EXISTS ix_master_atc ON master_drug(import_id, atc_code);

CREATE TABLE IF NOT EXISTS scope_snapshot (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES recognition_revision(id),
    import_id TEXT NOT NULL REFERENCES master_import(id),
    rule_hash TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    match_count INTEGER, pending_count INTEGER,
    status TEXT NOT NULL DEFAULT '預覽' CHECK (status IN ('預覽','已確認','撤銷')),
    confirmed_by TEXT, confirmed_at TEXT,
    note TEXT
);

CREATE TABLE IF NOT EXISTS scope_member (
    snapshot_id TEXT NOT NULL REFERENCES scope_snapshot(id),
    drug_code TEXT NOT NULL,
    eval_result TEXT NOT NULL CHECK (eval_result IN ('符合','待確認')),
    path TEXT,
    manual_result TEXT CHECK (manual_result IN ('納入','排除') OR manual_result IS NULL),
    manual_reason TEXT,
    group_code TEXT,
    source_row INTEGER,
    PRIMARY KEY (snapshot_id, drug_code)
);

CREATE TABLE IF NOT EXISTS group_treatment (
    id TEXT PRIMARY KEY,
    group_code TEXT NOT NULL,
    revision_id TEXT REFERENCES recognition_revision(id),
    method TEXT NOT NULL CHECK (method IN ('DET','第25條','待確認')),
    partial_cover INTEGER NOT NULL DEFAULT 0,
    effective_from TEXT, effective_to TEXT,
    basis TEXT,
    confirm_status TEXT NOT NULL DEFAULT '草稿'
        CHECK (confirm_status IN ('草稿','待確認','已確認','撤銷')),
    {COMMON}
);

CREATE TABLE IF NOT EXISTS contract (
    id TEXT PRIMARY KEY,
    contract_no TEXT NOT NULL,
    firm TEXT,
    signed_date TEXT, effective_from TEXT, expiry_date TEXT,
    doc_version TEXT,
    obligations TEXT,
    status TEXT NOT NULL DEFAULT '辦理中' CHECK (status IN ('辦理中','完成簽署','終止')),
    original_contract_id TEXT REFERENCES contract(id),
    {COMMON}
);

CREATE TABLE IF NOT EXISTS contract_drug (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL REFERENCES contract(id),
    drug_code TEXT NOT NULL,
    effective_from TEXT, effective_to TEXT,
    UNIQUE (contract_id, drug_code)
);

CREATE TABLE IF NOT EXISTS price_action (
    id TEXT PRIMARY KEY,
    case_id TEXT REFERENCES case_record(id),
    drug_code TEXT NOT NULL,
    revision_id TEXT NOT NULL REFERENCES recognition_revision(id),
    snapshot_id TEXT REFERENCES scope_snapshot(id),
    contract_requirement TEXT NOT NULL DEFAULT '待確認'
        CHECK (contract_requirement IN ('須簽約','當時無須簽約','待確認')),
    requirement_basis TEXT,
    contract_id TEXT REFERENCES contract(id),
    price_before TEXT, price_after TEXT,
    effective_date TEXT,
    announce_doc_no TEXT, announce_date TEXT,
    status TEXT NOT NULL DEFAULT '未辦' CHECK (status IN ('未辦','辦理中','已核定','撤回／取消')),
    confirm_status TEXT NOT NULL DEFAULT '草稿'
        CHECK (confirm_status IN ('草稿','待確認','已確認','撤銷')),
    completeness TEXT NOT NULL DEFAULT '完整' CHECK (completeness IN ('完整','不完整','待確認')),
    supersedes_id TEXT REFERENCES price_action(id),
    confirmed_by TEXT, confirmed_at TEXT,
    note TEXT,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS annotation_event (
    id TEXT PRIMARY KEY,
    drug_code TEXT NOT NULL,
    revision_id TEXT REFERENCES recognition_revision(id),
    price_action_id TEXT REFERENCES price_action(id),
    category TEXT,
    action TEXT NOT NULL CHECK (action IN ('新增','改類','取消','更正')),
    effective_date TEXT,
    basis TEXT,
    original_event_id TEXT REFERENCES annotation_event(id),
    confirm_status TEXT NOT NULL DEFAULT '草稿'
        CHECK (confirm_status IN ('草稿','待確認','已確認','撤銷')),
    confirmed_by TEXT, confirmed_at TEXT,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS attachment (
    id TEXT PRIMARY KEY,
    orig_name TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    uploaded_by TEXT, uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS attachment_link (
    attachment_id TEXT NOT NULL REFERENCES attachment(id),
    entity TEXT NOT NULL CHECK (entity IN ('case_record','meeting','meeting_agenda','decision','contract','recognition_revision','price_action')),
    entity_id TEXT NOT NULL,
    PRIMARY KEY (attachment_id, entity, entity_id)
);

CREATE TABLE IF NOT EXISTS audit_event (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    action TEXT NOT NULL,
    diff_json TEXT,
    reason TEXT,
    request_id TEXT
);

CREATE TABLE IF NOT EXISTS op_log (
    op_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    entity_id TEXT,
    at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_item (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    drug_code TEXT, group_code TEXT,
    revision_id TEXT, import_id TEXT,
    detail TEXT,
    status TEXT NOT NULL DEFAULT '待處理' CHECK (status IN ('待處理','已處理','不處理')),
    conclusion TEXT,
    {COMMON}
);

CREATE TABLE IF NOT EXISTS migration_batch (
    id TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    sheet TEXT NOT NULL,
    imported_by TEXT, imported_at TEXT,
    row_count INTEGER
);

CREATE TABLE IF NOT EXISTS migration_row (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES migration_batch(id),
    source_sha256 TEXT NOT NULL,
    sheet TEXT NOT NULL,
    row_no INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    parsed_json TEXT,
    issues_json TEXT,
    status TEXT NOT NULL DEFAULT '待核對' CHECK (status IN ('待核對','已寫入','略過')),
    committed_case_id TEXT, committed_recognition_id TEXT,
    decided_by TEXT, decided_at TEXT,
    UNIQUE (source_sha256, sheet, row_no)
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, '稽核紀錄只追加，不可修改'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, '稽核紀錄只追加，不可刪除'); END;
"""

DEFAULT_SETTINGS = {
    # 【設計建議】主檔「必要藥品」(DRUG_NECESSARY)代碼與認定類別對照；依DWM_DRUG_RCODE type L名稱預設，可修改。
    "annotation_code_map": '{"不可替代特殊藥品": "3", "特殊藥品": "4"}',
    # 只做經確認的單位換算；預設僅同名單位（大小寫、括號說明去除後比較）。
    "unit_conversions": "{}",
    # 已知規格單位；不在清單內視為未知單位→待確認。
    "known_units": '["ML","L","GM","MG","MCG","KG","IU","KIU","MIU","U","KU","MU","DOSE","MCL"]',
    "large_scope_threshold": "500",
    "attachment_max_mb": "50",
    "attachment_allowed_ext": '[".pdf",".doc",".docx",".xls",".xlsx",".csv",".txt",".png",".jpg",".jpeg",".tif",".tiff",".odt",".msg",".eml",".zip"]',
}


def connect(path: str | Path, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        uri = Path(path).resolve().as_uri() + "?mode=ro"
        con = sqlite3.connect(uri, uri=True, isolation_level=None)
    else:
        con = sqlite3.connect(str(path), isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    if not readonly:
        con.execute("PRAGMA journal_mode = DELETE")
    return con


def init_db(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
    for k, v in DEFAULT_SETTINGS.items():
        con.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))


def schema_version(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    return int(row[0]) if row else 0


def open_db(path: str | Path, readonly: bool = False) -> sqlite3.Connection:
    con = connect(path, readonly=readonly)
    if not readonly:
        init_db(con)
    ver = schema_version(con)
    if ver > SCHEMA_VERSION:
        con.close()
        raise RuntimeError(f"資料結構版本 {ver} 新於本程式支援的 {SCHEMA_VERSION}，請更新程式後再編輯。")
    return con


class Tx:
    """BEGIN IMMEDIATE交易；失敗整體回復。可巢狀（內層不另開交易）。"""

    def __init__(self, con: sqlite3.Connection):
        self.con = con
        self.outer = False

    def __enter__(self):
        if not self.con.in_transaction:
            self.con.execute("BEGIN IMMEDIATE")
            self.outer = True
        return self.con

    def __exit__(self, exc_type, exc, tb):
        if self.outer:
            if exc_type is None:
                self.con.execute("COMMIT")
            else:
                self.con.execute("ROLLBACK")
        return False


def get_setting(con, key, default=None):
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default
