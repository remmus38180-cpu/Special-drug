// 備份還原頁（第10、13節）：匯出備份（zip，產生後重讀驗證）、驗證備份、還原（須填原因，寫入新版本）。
import { h, table, dialog, alertBox } from './dom.js';
import { saveBlobAs } from './files.js';
import * as B from '../core/backup.js';
import * as X from '../core/exporter.js';
import { actorText } from '../core/model.js';
import { isoUtc, newId } from '../core/util.js';
import { exportNamer } from './exportUI.js';

export async function pickZip(label) {
  const fileIn = h('input', { type: 'file', accept: '.zip', 'aria-label': label });
  const ok = await dialog(label, [fileIn], [{ label: '取消', value: false }, { label: '確定', value: true, primary: true }]);
  if (!ok || !fileIn.files[0]) return null;
  const f = fileIn.files[0];
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
}

function manifestLines(m) {
  return [`來源資料夾：${m.folder_id}`, `來源 revision：r${String(m.source_revision).padStart(6, '0')}（${m.source_version_file}）`,
    `備份時間：${m.created_at}；程式版本：${m.app_version}；檔案數：${m.files.length}`];
}

export function backupTab(env) {
  const { s, btn, guard } = env;
  return h('section', { class: 'panel' }, h('h2', { text: '備份還原' }),
    h('p', { class: 'note', text: '備份內容：目前「已儲存」版本檔、current.json、specdrug.json、所有被引用之主檔列資料與附件、backup_manifest.json。不含編輯牌與關鍵詞。程式不在背景自動備份；保存期限與異地存放由單位決定（Q09）。' }),
    s.hasUnsaved ? h('p', { class: 'warn-text', text: `目前有 ${s.dirty} 項未儲存變更；備份只含已儲存版本 r${String(s.current.revision).padStart(6, '0')}。` }) : null,
    h('div', { class: 'toolbar' },
      btn('匯出備份', () => guard(() => doBackup(env)), { primary: true }),
      btn('驗證備份檔', () => guard(() => doVerify())),
      s.mode === 'edit' ? btn('從備份還原…', () => guard(() => doRestore(env))) : null),
    h('p', { class: 'note', text: '還原：須持有編輯牌、無未儲存變更並填原因；以新版本（revision＋1）成立，既有版本檔不改不刪；附件與主檔檔案已存在且雜湊相符則沿用，不符即中止。演練：先「建立新資料夾」，在新資料夾執行還原。' }));
}

async function doBackup(env) {
  const s = env.s;
  const ms = Date.now();
  const { bytes, manifest } = await B.buildBackup(s.fs, { exportedAt: isoUtc(ms), actor: actorText(s.session) });
  const name = exportNamer().name('備份', ms, manifest.source_revision, false, 'zip');
  const r = await saveBlobAs(name, new Blob([bytes], { type: 'application/zip' }));
  if (!r || !r.saved) return;
  try {
    await X.logExport(s.fs, { name, bytes }, { kind: '備份', ms, actor: actorText(s.session), revision: manifest.source_revision, unsaved: false, condition: `檔案 ${manifest.files.length} 個`, count: manifest.files.length });
  } catch (e) {
    await alertBox('匯出紀錄未寫入', '備份已匯出，但寫入資料夾匯出紀錄失敗；不影響已下載檔案。');
  }
  await alertBox('備份完成', `已匯出 ${name}（產生後已重讀逐檔驗證）。`, ...manifestLines(manifest));
}

async function doVerify() {
  const f = await pickZip('選擇備份檔（.zip）');
  if (!f) return;
  const v = await B.verifyBackup(f.bytes);
  if (v.ok) await alertBox('備份驗證通過', `「${f.name}」所有檔案雜湊、資料引用及稽核雜湊鏈皆一致。`, ...manifestLines(v.manifest));
  else await alertBox('備份驗證未通過', `「${f.name}」不可用於還原：`, table(['原因'], v.errors.map((e) => [e])));
}

async function doRestore(env) {
  const s = env.s;
  const f = await pickZip('選擇要還原的備份檔（.zip）');
  if (!f) return;
  const v = await B.verifyBackup(f.bytes);
  if (!v.ok) { await alertBox('備份驗證未通過，拒絕還原', '資料夾不變。原因：', table(['原因'], v.errors.map((e) => [e]))); return; }
  const reason = h('textarea', { rows: 3, cols: 48, 'aria-label': '還原原因' });
  const msg = h('p', { class: 'warn-text', role: 'alert' });
  const ok = await dialog('確認還原', [
    ...manifestLines(v.manifest).map((t) => h('p', { text: t })),
    v.manifest.folder_id !== s.meta.folder_id ? h('p', { class: 'warn-text', text: '此備份來自其他資料夾（folder_id 不同）。' }) : null,
    h('p', { text: `還原後成為本資料夾 r${String(s.current.revision + 1).padStart(6, '0')}；目前版本及歷史版本檔保留可唯讀開啟比對（Q12）。` }),
    h('label', null, '還原原因＊ ', reason), msg],
  [{ label: '取消', value: false }, { label: '還原', value: true, primary: true, validate: () => { if (!reason.value.trim()) { msg.textContent = '請填還原原因'; return false; } return true; } }]);
  if (!ok) return;
  const r = await B.restoreBackup(s, f.bytes, { reason: reason.value.trim(), opId: newId(), backupName: f.name });
  await alertBox('還原完成', `已還原為 r${String(s.current.revision).padStart(6, '0')}；寫入檔案 ${r.files_written} 個、沿用 ${r.files_reused} 個。稽核已記錄來源備份。`);
}
