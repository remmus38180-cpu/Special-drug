// 備份與還原（第13節、H09、H11、T22、REVIEW M7、L1）。
// 備份：目前已儲存版本檔、current.json、specdrug.json、所有被引用之 masters/ 與附件，加 backup_manifest.json；產生後重讀逐檔驗證。
// 驗證：manifest 須列資料版本檔且恰一份；路徑須符合資料夾白名單（不得 ..、絕對路徑、磁碟代號）；manifest 外之檔案視為錯誤；
//       資料內每筆附件及主檔須在 manifest 列出且雜湊相符；版本檔雜湊、稽核雜湊鏈須正確。
// 還原：須填原因；只寫入新版本（revision＋1），既有版本檔不改不刪；檔案已存在且雜湊相符則沿用，不符即中止；稽核記錄來源備份資訊。
import { SpecError } from './errors.js';
import { APP_VERSION, SCHEMA_VERSION } from './version.js';
import { P, isValidPath, parseVersionFileName } from './paths.js';
import { readZip, writeZip } from './zip.js';
import { sha256Bytes, utf8, isoUtc, deepClone } from './util.js';
import { verifyChain } from './audit.js';
import { list } from './model.js';
import { validateData } from './model.js';
import { MemStore } from '../adapters/memfs.js';
import { releasedToken } from './folder.js';

export const MANIFEST = 'backup_manifest.json';
const BACKUP_FORMAT = 'specdrug-backup';

function refsOf(data) {
  const refs = [];
  for (const m of list(data, 'master_import')) if (m.rows_file) refs.push({ path: m.rows_file, sha256: m.rows_sha256, label: `主檔列資料 ${m.source_name}` });
  for (const a of list(data, 'attachment')) refs.push({ path: a.storage_key, sha256: a.sha256, label: `附件 ${a.orig_name}` });
  const seen = new Set();
  return refs.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}

// 產生備份 zip（只讀資料夾）；回傳 {bytes, manifest}
export async function buildBackup(fs, { exportedAt, actor } = {}) {
  const cur = await fs.read(P.CURRENT);
  if (!cur) throw new SpecError('CURRENT_MISSING', '找不到 data/current.json');
  const current = JSON.parse(cur.text);
  const vpath = `${P.VERSIONS}/${current.file}`;
  const vr = await fs.readBytes(vpath);
  if (!vr) throw new SpecError('VERSION_MISSING', `找不到版本檔：${current.file}`);
  if ((await sha256Bytes(vr.bytes)) !== current.sha256) throw new SpecError('VERSION_HASH', '目前版本檔雜湊與 current.json 記載不符，不產生備份');
  const vfile = JSON.parse(new TextDecoder().decode(vr.bytes));
  const meta = await fs.readBytes(P.META);
  const files = [{ path: P.META, bytes: meta.bytes }, { path: P.CURRENT, bytes: utf8(cur.text) }, { path: vpath, bytes: vr.bytes }];
  for (const ref of refsOf(vfile.data)) {
    const r = await fs.readBytes(ref.path);
    if (!r) throw new SpecError('REF_MISSING', `引用之檔案不存在：${ref.path}（${ref.label}）；不產生備份`);
    if ((await sha256Bytes(r.bytes)) !== ref.sha256) throw new SpecError('REF_HASH', `引用之檔案雜湊不符：${ref.path}（${ref.label}）；不產生備份`);
    files.push({ path: ref.path, bytes: r.bytes });
  }
  const entries = [];
  for (const f of files) entries.push({ path: f.path, size: f.bytes.length, sha256: await sha256Bytes(f.bytes) });
  const manifest = {
    format: BACKUP_FORMAT, folder_id: vfile.header.folder_id, source_revision: current.revision, source_version_file: current.file,
    source_sha256: current.sha256, created_at: exportedAt || isoUtc(Date.now()), created_by: actor || null,
    app_version: APP_VERSION, schema_version: SCHEMA_VERSION, data_schema_version: vfile.header.schema_version, files: entries,
  };
  const comment = `specdrug backup r${String(current.revision).padStart(6, '0')} ${manifest.created_at} v${APP_VERSION}`;
  const bytes = writeZip([...files.map((f) => ({ name: f.path, data: f.bytes })), { name: MANIFEST, data: JSON.stringify(manifest, null, 2) + '\n' }], { comment });
  // 產生後重讀逐檔驗證
  const v = await verifyBackup(bytes);
  if (!v.ok) throw new SpecError('BACKUP_VERIFY', '備份產生後驗證失敗：' + v.errors.join('；'));
  return { bytes, manifest };
}

function pathProblem(p) {
  if (typeof p !== 'string' || !p) return '路徑空白';
  if (p.includes('..')) return `路徑含「..」：${p}`;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return `絕對路徑或磁碟代號：${p}`;
  if (p.startsWith('control/') || p.startsWith('logs/')) return `備份不應含此檔：${p}`;
  if (!isValidPath(p)) return `路徑不符資料夾格式：${p}`;
  return null;
}

// 驗證備份 zip（不寫入）；回傳 {ok, errors, manifest, current, version:{name, header, data, audit}, files: Map(path→bytes)}
export async function verifyBackup(bytes) {
  const errors = [];
  let z;
  try { z = readZip(bytes); } catch (e) { return { ok: false, errors: [`不是有效的 zip：${e.message}`] }; }
  const names = z.entries.map((e) => e.name);
  for (const n of names) { if (n !== MANIFEST) { const p = pathProblem(n); if (p) errors.push(`zip 內${p}`); } }
  if (!z.has(MANIFEST)) return { ok: false, errors: errors.concat(['缺 backup_manifest.json']) };
  let manifest;
  try { manifest = JSON.parse(z.text(MANIFEST)); } catch (e) { return { ok: false, errors: errors.concat(['backup_manifest.json 不是有效的JSON']) }; }
  if (!manifest || manifest.format !== BACKUP_FORMAT || !Array.isArray(manifest.files)) return { ok: false, errors: errors.concat(['backup_manifest.json 格式錯誤']) };
  const listed = new Map();
  for (const f of manifest.files) {
    const p = pathProblem(f && f.path);
    if (p) { errors.push(`manifest ${p}`); continue; }
    if (listed.has(f.path)) errors.push(`manifest 重複列出：${f.path}`);
    listed.set(f.path, f);
  }
  for (const n of names) if (n !== MANIFEST && !listed.has(n)) errors.push(`zip 內有 manifest 未列之檔案：${n}`);
  const files = new Map();
  for (const [p, f] of listed) {
    if (!z.has(p)) { errors.push(`manifest 列出但 zip 內缺：${p}`); continue; }
    let b;
    try { b = z.bytes(p); } catch (e) { errors.push(`讀取失敗（CRC 或格式）：${p}`); continue; }
    if (b.length !== f.size) errors.push(`大小不符：${p}`);
    if ((await sha256Bytes(b)) !== f.sha256) { errors.push(`雜湊不符：${p}`); continue; }
    files.set(p, b);
  }
  const versions = [...listed.keys()].filter((p) => p.startsWith(`${P.VERSIONS}/`));
  if (versions.length !== 1) errors.push(versions.length ? `資料版本檔應恰為一份，實有 ${versions.length} 份` : '缺資料版本檔');
  if (!listed.has(P.CURRENT)) errors.push('缺 data/current.json');
  if (!listed.has(P.META)) errors.push('缺 specdrug.json');
  if (errors.length) return { ok: false, errors, manifest };
  const vpath = versions[0];
  const vname = vpath.slice(P.VERSIONS.length + 1);
  const vbytes = files.get(vpath);
  const vsha = await sha256Bytes(vbytes);
  const parsed = parseVersionFileName(vname);
  if (!parsed || parsed.sha8 !== vsha.slice(0, 8)) errors.push('版本檔雜湊與檔名不符');
  let current;
  let vfile;
  try { current = JSON.parse(new TextDecoder().decode(files.get(P.CURRENT))); } catch (e) { errors.push('data/current.json 不是有效的JSON'); }
  try { vfile = JSON.parse(new TextDecoder().decode(vbytes)); } catch (e) { errors.push('版本檔不是有效的JSON'); }
  if (errors.length) return { ok: false, errors, manifest };
  if (current.file !== vname || current.sha256 !== vsha) errors.push('current.json 記載之版本檔或雜湊與備份內版本檔不符');
  if (manifest.source_sha256 !== vsha || manifest.source_version_file !== vname) errors.push('manifest 記載之來源版本與版本檔不符');
  const h = vfile.header;
  if (!h || !vfile.data || !Array.isArray(vfile.audit)) errors.push('版本檔格式錯誤');
  else {
    if (h.schema_version > SCHEMA_VERSION) errors.push(`備份資料結構版本 ${h.schema_version} 新於本程式（${SCHEMA_VERSION}），請更新程式`);
    if (h.schema_version < SCHEMA_VERSION) errors.push(`備份資料結構版本 ${h.schema_version} 較舊，須先升級`);
    const chain = await verifyChain(vfile.audit);
    if (!chain.ok) errors.push(`稽核雜湊鏈中斷：${chain.reason}（第 ${chain.index + 1} 筆）`);
    else if (!h.audit_head || h.audit_head.count !== chain.count || h.audit_head.hash !== chain.head) errors.push('稽核筆數或末筆雜湊與檔頭不符');
    for (const ref of refsOf(vfile.data)) {
      const f = listed.get(ref.path);
      if (!f) errors.push(`資料引用之檔案未列於 manifest：${ref.path}（${ref.label}）`);
      else if (f.sha256 !== ref.sha256) errors.push(`資料引用之檔案雜湊不符：${ref.path}（${ref.label}）`);
    }
    const problems = validateData(vfile.data);
    if (problems.length) errors.push('資料一致性檢查未通過：' + problems.slice(0, 5).join('；'));
  }
  return { ok: errors.length === 0, errors, manifest, current, version: { name: vname, header: h, data: vfile.data, audit: vfile.audit }, files };
}

// 還原至目前資料夾（編輯模式、無未儲存變更）；寫入引用檔案後以新版本成立，並立即儲存
export async function restoreBackup(session, bytes, { reason, opId, backupName } = {}) {
  if (session.mode !== 'edit') throw new SpecError('NOT_EDITING', '還原須先取得編輯牌');
  if (!reason || !String(reason).trim()) throw new SpecError('REQUIRED', '還原須填原因');
  if (session.hasUnsaved) throw new SpecError('UNSAVED', '目前有未儲存變更；請先儲存或捨棄後再還原');
  const v = await verifyBackup(bytes);
  if (!v.ok) throw new SpecError('BACKUP_INVALID', '備份驗證未通過，拒絕還原，資料夾不變：' + v.errors.join('；'), { errors: v.errors });
  // 先比對既有檔案，任一不符即中止（尚未寫入任何檔）
  const toWrite = [];
  for (const [p, b] of v.files) {
    if (p === P.META || p === P.CURRENT || p.startsWith(`${P.VERSIONS}/`)) continue;
    const ex = await session.fs.readBytes(p);
    if (ex) {
      if ((await sha256Bytes(ex.bytes)) !== (await sha256Bytes(b))) throw new SpecError('REF_HASH', `資料夾內既有檔案與備份雜湊不符，中止還原：${p}`);
    } else toWrite.push([p, b]);
  }
  for (const [p, b] of toWrite) {
    await session.fs.create(p, b);
    const back = await session.fs.readBytes(p);
    if (!back || (await sha256Bytes(back.bytes)) !== (await sha256Bytes(b))) throw new SpecError('WRITE_VERIFY', `還原寫入後讀回雜湊不符：${p}`);
  }
  const refs = refsOf(v.version.data);
  const src = { backup_name: backupName || null, source_folder_id: v.manifest.folder_id, source_revision: v.manifest.source_revision,
    source_version_file: v.manifest.source_version_file, source_sha256: v.manifest.source_sha256, backup_created_at: v.manifest.created_at,
    backup_app_version: v.manifest.app_version, files_written: toWrite.length, files_reused: v.files.size - 3 - toWrite.length };
  await session.run((d, ctx) => {
    const restored = deepClone(v.version.data);
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, restored);
    ctx.events.push({ entity: 'folder', entity_id: session.meta.folder_id, action: '還原', diff: src, reason: String(reason).trim(), op_id: ctx.opId });
    return src;
  }, { opId, kind: '還原', refs });
  const r = await session.save();
  return { ...src, save: r.status };
}

// H11：以備份 zip 唯讀開啟（不支援檔案系統存取之瀏覽器亦可查詢、匯出）；回傳唯讀 fs 及驗證結果
export async function backupReadonlyFs(bytes) {
  const v = await verifyBackup(bytes);
  if (!v.ok) throw new SpecError('BACKUP_INVALID', '備份驗證未通過，不開啟：' + v.errors.join('；'), { errors: v.errors });
  const store = new MemStore();
  for (const [p, b] of v.files) store.files.set(p, { bytes: b, mtime: Date.now() });
  store.files.set(P.TOKEN, { bytes: utf8(JSON.stringify(releasedToken(Date.now(), 'backup-view'))), mtime: Date.now() });
  return { fs: store.client({ name: 'backup', readonly: true }), verify: v };
}
