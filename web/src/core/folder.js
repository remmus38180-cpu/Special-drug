// 資料夾初始化、開啟與儲存協定（第4.4、4.5節）。
// fs 介面：read(path)→{text,lastModified,size}|null、readBytes(path)→{bytes,lastModified}|null、
//          write(path,text)、create(path,data)（已存在即失敗）、remove(path)、list(dir)→[{name,kind}]
import { SpecError } from './errors.js';
import { P, versionFileName, parseVersionFileName, assertPath } from './paths.js';
import { APP_VERSION, SCHEMA_VERSION } from './version.js';
import { emptyData } from './dataset.js';
import { sealEvents, verifyChain, auditHead, isPrefixOf } from './audit.js';
import { buildKeywordRecord } from './keyword.js';
import { isoUtc, newId, sha256Text, sha256Bytes, revLabel } from './util.js';

export const FOLDER_FORMAT = 'specdrug-folder';
export const DATA_FORMAT = 'specdrug-data';

function json(v) {
  return JSON.stringify(v, null, 2) + '\n';
}

function parseJson(text, code, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new SpecError(code, `${what}不是有效的JSON：${e.message}`);
  }
}

export function releasedToken(now, note) {
  return {
    format: 'specdrug-editing',
    state: 'released',
    holder: null,
    session_id: null,
    heartbeat_seq: 0,
    heartbeat_at: null,
    released_at: isoUtc(now),
    last_event: { type: note || 'released', at: isoUtc(now) },
  };
}

export async function inspectFolder(fs) {
  const entries = await fs.list('');
  if (!entries.length) return 'empty';
  if (entries.some((e) => e.name === P.META && e.kind === 'file')) return 'specdrug';
  return 'other';
}

function actor(session) {
  return { user: session.user, pc: session.pc, session_id: session.id };
}

// 寫入一個版本檔：一次寫入、不覆寫；寫完讀回比對雜湊（第4.5節步驟3）
async function writeVersionFile(fs, { folderId, revision, prev, now, session, saveId, data, audit, summary }) {
  const header = {
    format: DATA_FORMAT,
    folder_id: folderId,
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    revision,
    prev_revision: prev ? prev.revision : null,
    prev_sha256: prev ? prev.sha256 : null,
    saved_at: isoUtc(now),
    saved_by: actor(session),
    save_id: saveId,
    audit_head: auditHead(audit),
    summary: summary || '',
  };
  const text = JSON.stringify({ header, data, audit }) + '\n';
  const sha256 = await sha256Text(text);
  const name = versionFileName(revision, now, sha256);
  const path = `${P.VERSIONS}/${name}`;
  await fs.create(path, text);
  const back = await fs.read(path);
  if (!back || (await sha256Text(back.text)) !== sha256) {
    throw new SpecError('WRITE_VERIFY', `版本檔寫入後讀回雜湊不符：${name}`);
  }
  return { name, sha256, header };
}

function currentRecord({ revision, name, sha256, header }) {
  return {
    format: 'specdrug-current',
    revision,
    file: name,
    sha256,
    save_id: header.save_id,
    saved_at: header.saved_at,
    saved_by: header.saved_by,
    app_version: header.app_version,
    schema_version: header.schema_version,
    prev_revision: header.prev_revision,
    audit_head: header.audit_head,
    summary: header.summary,
  };
}

export async function initFolder(fs, { clock, session, keyword, keywordIterations }) {
  const kind = await inspectFolder(fs);
  if (kind === 'specdrug') throw new SpecError('ALREADY_INIT', '此資料夾已是本系統資料夾，請直接開啟');
  if (kind !== 'empty') throw new SpecError('NOT_EMPTY', '請選擇空資料夾作為新資料夾（此資料夾已有其他檔案）');
  const now = clock.now();
  const folderId = newId();
  const by = actor(session);
  const kwRec = await buildKeywordRecord(keyword, { now, by, iterations: keywordIterations });
  const meta = {
    format: FOLDER_FORMAT,
    folder_id: folderId,
    created_at: isoUtc(now),
    created_by: by,
    schema_version: SCHEMA_VERSION,
    app_version: APP_VERSION,
  };
  await fs.create(P.META, json(meta));
  await fs.create(P.KEYWORD, json(kwRec));
  await fs.create(P.TOKEN, json(releasedToken(now, 'init')));
  const audit = await sealEvents([], [{
    id: newId(), at: isoUtc(now), user: session.user, pc: session.pc, app_version: APP_VERSION,
    entity: 'folder', entity_id: folderId, action: '建立資料夾', diff: null, reason: null, op_id: null,
  }]);
  const v = await writeVersionFile(fs, {
    folderId, revision: 0, prev: null, now, session, saveId: newId(), data: emptyData(), audit, summary: '建立資料夾',
  });
  await fs.create(P.CURRENT, json(currentRecord({ revision: 0, ...v })));
  return meta;
}

export async function readMeta(fs) {
  const r = await fs.read(P.META);
  if (!r) throw new SpecError('NOT_SPECDRUG', '此資料夾不是本系統資料夾（找不到 specdrug.json）');
  const meta = parseJson(r.text, 'META_BAD', 'specdrug.json');
  if (meta.format !== FOLDER_FORMAT || !meta.folder_id) throw new SpecError('META_BAD', 'specdrug.json 格式錯誤');
  return meta;
}

export async function readCurrent(fs) {
  const r = await fs.read(P.CURRENT);
  if (!r) throw new SpecError('CURRENT_MISSING', '找不到 data/current.json');
  const cur = parseJson(r.text, 'CURRENT_BAD', 'data/current.json');
  if (!cur || cur.format !== 'specdrug-current' || !Number.isInteger(cur.revision) || typeof cur.file !== 'string') {
    throw new SpecError('CURRENT_BAD', 'data/current.json 格式錯誤');
  }
  return cur;
}

// 讀取並驗證一個版本檔。expect：{sha256, revision, save_id}（由current.json提供時）
export async function loadVersion(fs, name, { meta, expect } = {}) {
  const errors = [];
  const readonly = [];
  const parsed = parseVersionFileName(name);
  if (!parsed) {
    errors.push({ code: 'VERSION_NAME', message: `版本檔名格式錯誤：${name}` });
    return { ok: false, errors, readonly };
  }
  const path = assertPath(`${P.VERSIONS}/${name}`);
  const r = await fs.read(path);
  if (!r) {
    errors.push({ code: 'VERSION_MISSING', message: `找不到版本檔：${name}` });
    return { ok: false, errors, readonly };
  }
  const sha256 = await sha256Text(r.text);
  if (expect && expect.sha256 && sha256 !== expect.sha256) {
    errors.push({ code: 'VERSION_HASH', message: `版本檔 ${name} 的SHA-256與 current.json 記載不符（檔案可能被修改）`, where: name });
  }
  if (sha256.slice(0, 8) !== parsed.sha8) {
    errors.push({ code: 'VERSION_HASH', message: `版本檔 ${name} 的SHA-256與檔名不符（檔案可能被修改）`, where: name });
  }
  let file;
  try {
    file = JSON.parse(r.text);
  } catch (e) {
    errors.push({ code: 'VERSION_JSON', message: `版本檔 ${name} 不是有效的JSON`, where: name });
    return { ok: false, errors, readonly, sha256 };
  }
  const h = file && file.header;
  if (!h || h.format !== DATA_FORMAT || !file.data || !Array.isArray(file.audit)) {
    errors.push({ code: 'VERSION_FORMAT', message: `版本檔 ${name} 格式錯誤`, where: name });
    return { ok: false, errors, readonly, sha256 };
  }
  if (h.revision !== parsed.revision) errors.push({ code: 'VERSION_REV', message: `版本檔 ${name} 內記載revision ${h.revision} 與檔名不符`, where: name });
  if (expect && expect.revision !== undefined && h.revision !== expect.revision) {
    errors.push({ code: 'VERSION_REV', message: `版本檔revision ${h.revision} 與 current.json 記載 ${expect.revision} 不符`, where: name });
  }
  if (expect && expect.save_id && h.save_id !== expect.save_id) {
    errors.push({ code: 'VERSION_SAVEID', message: '版本檔save_id與 current.json 記載不符', where: name });
  }
  if (meta && h.folder_id !== meta.folder_id) {
    errors.push({ code: 'VERSION_FOLDER', message: '版本檔不屬於此資料夾（folder_id不符）', where: name });
  }
  if (typeof h.schema_version !== 'number') {
    errors.push({ code: 'VERSION_FORMAT', message: '版本檔缺資料結構版本', where: name });
  } else if (h.schema_version > SCHEMA_VERSION) {
    readonly.push(`資料結構版本 ${h.schema_version} 新於本程式（${SCHEMA_VERSION}），只可唯讀，請更新程式`);
  } else if (h.schema_version < SCHEMA_VERSION) {
    errors.push({ code: 'SCHEMA_OLD', message: `資料結構版本 ${h.schema_version} 較舊，須先執行資料結構升級`, where: name });
  }
  const chain = await verifyChain(file.audit);
  if (!chain.ok) {
    errors.push({ code: 'AUDIT_CHAIN', message: `稽核雜湊鏈中斷：${chain.reason}`, where: `${name} 稽核第 ${chain.index + 1} 筆` });
  } else if (!h.audit_head || h.audit_head.count !== chain.count || h.audit_head.hash !== chain.head) {
    errors.push({ code: 'AUDIT_HEAD', message: `稽核筆數或末筆雜湊與檔頭記載不符（末端紀錄可能被刪除）：記載 ${h.audit_head && h.audit_head.count} 筆，實有 ${chain.count} 筆`, where: name });
  }
  return { ok: errors.length === 0, errors, readonly, sha256, header: h, data: file.data, audit: file.audit, name };
}

export async function listVersions(fs) {
  const entries = await fs.list(P.VERSIONS);
  return entries
    .filter((e) => e.kind === 'file')
    .map((e) => parseVersionFileName(e.name))
    .filter(Boolean)
    .sort((a, b) => a.revision - b.revision || (a.stamp < b.stamp ? -1 : 1));
}

// 開啟：current.json→版本檔→驗SHA-256與資料結構版本→驗稽核雜湊鏈。不符不自動改用其他版本。
export async function openFolder(fs) {
  const meta = await readMeta(fs);
  const readonly = [];
  if (typeof meta.schema_version === 'number' && meta.schema_version > SCHEMA_VERSION) {
    readonly.push(`資料夾資料結構版本 ${meta.schema_version} 新於本程式（${SCHEMA_VERSION}），只可唯讀，請更新程式`);
  }
  let current;
  try {
    current = await readCurrent(fs);
  } catch (e) {
    return { ok: false, meta, errors: [{ code: e.code || 'CURRENT_BAD', message: e.message }], versions: await listVersions(fs) };
  }
  const v = await loadVersion(fs, current.file, { meta, expect: current });
  if (!v.ok) {
    return { ok: false, meta, current, errors: v.errors, versions: await listVersions(fs) };
  }
  return {
    ok: true, meta, current, header: v.header, data: v.data, audit: v.audit,
    readonly: readonly.concat(v.readonly),
  };
}

// 檢查各版本檔：檔名雜湊、與下一版之prev_sha256連續
export async function verifyHistory(fs) {
  const list = await listVersions(fs);
  const out = [];
  let current = null;
  try { current = await readCurrent(fs); } catch (e) { current = null; }
  const byRev = new Map();
  for (const item of list) {
    const r = await fs.read(`${P.VERSIONS}/${item.name}`);
    const row = { ...item, ok: false, notes: [] };
    if (!r) { row.notes.push('無法讀取'); out.push(row); continue; }
    row.sha256 = await sha256Text(r.text);
    row.size = r.size;
    if (row.sha256.slice(0, 8) !== item.sha8) row.notes.push('雜湊與檔名不符');
    try {
      const f = JSON.parse(r.text);
      row.header = f.header;
      const chain = await verifyChain(f.audit);
      if (!chain.ok) row.notes.push('稽核雜湊鏈中斷：' + chain.reason);
    } catch (e) {
      row.notes.push('JSON格式錯誤');
    }
    row.isCurrent = !!current && current.file === item.name;
    if (row.isCurrent && current.sha256 !== row.sha256) row.notes.push('與current.json記載雜湊不符');
    row.ok = row.notes.length === 0;
    if (!byRev.has(item.revision)) byRev.set(item.revision, []);
    byRev.get(item.revision).push(row);
    out.push(row);
  }
  // 前一版連結：本版 header.prev_sha256 須為某個 revision-1 版本檔之雜湊
  for (const row of out) {
    if (!row.header || row.header.prev_revision === null || row.header.prev_revision === undefined) continue;
    const prevs = byRev.get(row.header.prev_revision) || [];
    const linked = prevs.find((p) => p.sha256 === row.header.prev_sha256);
    if (!linked) { row.notes.push(`找不到前一版（${revLabel(row.header.prev_revision)}）或其雜湊不符`); row.ok = false; }
  }
  // 未被引用之版本檔（儲存中斷之殘留）
  const referenced = new Set();
  if (current) {
    referenced.add(current.file);
    let cur = out.find((r) => r.name === current.file);
    while (cur && cur.header && cur.header.prev_sha256) {
      const prev = out.find((r) => r.sha256 === cur.header.prev_sha256);
      if (!prev) break;
      referenced.add(prev.name);
      cur = prev;
    }
  }
  for (const row of out) row.inChain = referenced.has(row.name);
  return out;
}

// 驗證本次新增引用之附件／主檔檔案存在且雜湊相符（第4.5節步驟2）
export async function verifyRefs(fs, refs) {
  for (const ref of refs || []) {
    assertPath(ref.path);
    const r = await fs.readBytes(ref.path);
    if (!r) throw new SpecError('REF_MISSING', `引用之檔案不存在：${ref.path}${ref.label ? '（' + ref.label + '）' : ''}`);
    const sha = await sha256Bytes(r.bytes);
    if (sha !== ref.sha256) throw new SpecError('REF_HASH', `引用之檔案雜湊不符：${ref.path}${ref.label ? '（' + ref.label + '）' : ''}`);
  }
}

// 儲存協定（第4.5節）。任何步驟失敗即整體失敗，不改目前版本。
// 回傳 {status:'saved'|'already', current, header, name}；失敗擲 SpecError（code見下）。
//   TOKEN_LOST：編輯牌已不在本工作階段；CONFLICT：資料夾已被其他分頁或程式變更；
//   OVERWRITTEN：存後重讀current.json發現已被他人覆蓋（版本檔已建立，detail.name可找回）。
export async function saveVersion(fs, { clock, session, meta, base, data, auditBase, auditDrafts, saveId, refs, summary }) {
  if (!saveId) throw new SpecError('NO_SAVE_ID', '缺save_id');
  // 重試：若 current.json 的 save_id 已是本次，視為已完成
  const cur0 = await readCurrent(fs);
  if (cur0.save_id === saveId) {
    return { status: 'already', current: cur0, name: cur0.file };
  }
  // 步驟1：編輯牌仍為本工作階段持有；revision 與開啟時相同
  const tr = await fs.read(P.TOKEN);
  let tok = null;
  try { tok = tr ? JSON.parse(tr.text) : null; } catch (e) { tok = null; }
  if (!tok || tok.state !== 'held' || tok.session_id !== session.id) {
    throw new SpecError('TOKEN_LOST', '編輯牌已不在本工作階段（可能已被強制收回或逾時由他人取得），拒絕儲存；未儲存變更已保留為復原草稿', { token: tok });
  }
  if (cur0.revision !== base.revision || cur0.sha256 !== base.sha256) {
    throw new SpecError('CONFLICT', '資料夾已被其他分頁或程式變更，請重新載入核對', { current: cur0 });
  }
  // 步驟2：引用檔案；稽核雜湊鏈連續
  await verifyRefs(fs, refs);
  const now = clock.now();
  const audit = await sealEvents(auditBase, auditDrafts.map((d) => ({ ...d, app_version: APP_VERSION })));
  if (!isPrefixOf(auditBase, audit)) throw new SpecError('AUDIT_CHAIN', '稽核紀錄不連續，拒絕儲存');
  const chain = await verifyChain(audit);
  if (!chain.ok) throw new SpecError('AUDIT_CHAIN', '稽核雜湊鏈驗證失敗：' + chain.reason);
  // 步驟3：寫入新版本檔並讀回比對
  const revision = base.revision + 1;
  const v = await writeVersionFile(fs, {
    folderId: meta.folder_id, revision, prev: base, now, session, saveId, data, audit, summary,
  });
  // 步驟4：寫入新 current.json
  const rec = currentRecord({ revision, ...v });
  await fs.write(P.CURRENT, json(rec));
  // 步驟5：重讀 current.json，save_id 須為本次
  const cur1 = await readCurrent(fs);
  if (cur1.save_id !== saveId) {
    throw new SpecError('OVERWRITTEN', `目前版本已被其他人覆蓋。本次版本檔：${v.name}（可由儲存歷程找回）`, { name: v.name, current: cur1 });
  }
  return { status: 'saved', current: cur1, header: v.header, name: v.name, audit };
}

// 資料夾寫入測試（第4.3節）：建立並刪除暫存測試檔
export async function writeTest(fs, clock) {
  const path = `control/_writetest-${newId()}.tmp`;
  const text = 'specdrug write test ' + isoUtc(clock.now());
  const before = clock.now();
  try {
    await fs.create(path, text);
    const r = await fs.read(path);
    if (!r || r.text !== text) throw new SpecError('WRITE_TEST', '寫入後讀回內容不符');
    await fs.remove(path);
    return { ok: true, localAt: before, lastModified: r.lastModified };
  } catch (e) {
    try { await fs.remove(path); } catch (e2) { /* 忽略 */ }
    return { ok: false, error: e };
  }
}
