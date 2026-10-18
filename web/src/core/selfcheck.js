// 啟動自檢（第4.3節）。env 為瀏覽器全域物件（測試時可傳假物件）。
export function selfCheck(env) {
  const items = [];
  const add = (key, label, ok, effect, detail) => items.push({ key, label, ok: !!ok, effect, detail: detail || '' });
  const secure = !!env.isSecureContext;
  const crypto = env.crypto;
  const subtle = !!(crypto && crypto.subtle && typeof crypto.subtle.digest === 'function');
  const uuid = !!(crypto && typeof crypto.randomUUID === 'function');
  const fsAccess = typeof env.showDirectoryPicker === 'function';
  const saveAs = typeof env.showSaveFilePicker === 'function';
  const idb = !!env.indexedDB;
  const locks = !!(env.navigator && env.navigator.locks && typeof env.navigator.locks.request === 'function');
  const worker = typeof env.Worker === 'function';
  add('secure', '安全環境（isSecureContext）', secure, '停用編輯');
  add('subtle', 'crypto.subtle（SHA-256）', subtle, '停用編輯');
  add('uuid', 'crypto.randomUUID（主鍵）', uuid, '停用編輯');
  add('fsAccess', '檔案系統存取（showDirectoryPicker）', fsAccess, '唯讀模式：僅能開啟備份zip查詢及匯出');
  add('idb', 'IndexedDB（記住資料夾授權、當機復原草稿）', idb, '可編輯，但無當機復原');
  add('locks', 'navigator.locks（防止同瀏覽器兩分頁同時編輯）', locks, '可編輯，但請勿開兩分頁');
  add('saveAs', '另存對話框（showSaveFilePicker）', saveAs, '匯出改用瀏覽器下載，檔名可能無法帶入');
  add('worker', 'Web Worker', worker, '大量匯入時畫面可能停頓');
  const reasons = [];
  if (!secure) reasons.push('非安全環境');
  if (!subtle) reasons.push('無法計算SHA-256');
  if (!uuid) reasons.push('無法產生UUID');
  const canFolder = secure && subtle && uuid && fsAccess;
  if (!fsAccess) reasons.push('瀏覽器不支援檔案系統存取');
  return {
    items,
    caps: { secure, subtle, uuid, fsAccess, saveAs, idb, locks, worker },
    canEdit: canFolder,
    canFolder,
    readonlyReasons: reasons,
  };
}
