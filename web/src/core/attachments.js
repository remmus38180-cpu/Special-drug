// 附件：以 SHA-256 為儲存鍵（attachments/<前2碼>/<sha256>），不以使用者檔名當路徑；讀取一律驗雜湊（第13節）。
import { SpecError } from './errors.js';
import { attachmentPath } from './paths.js';
import { sha256Bytes } from './util.js';
import { insert, list } from './model.js';

// 寫入檔案（已存在且雜湊相符則沿用；不符即中止）；回傳 {sha256, path, size}
export async function storeBlob(fs, bytes) {
  const sha256 = await sha256Bytes(bytes);
  const path = attachmentPath(sha256);
  const exist = await fs.readBytes(path);
  if (exist) {
    if ((await sha256Bytes(exist.bytes)) !== sha256) throw new SpecError('REF_HASH', `附件檔已存在但雜湊不符：${path}`);
    return { sha256, path, size: bytes.length, reused: true };
  }
  await fs.create(path, bytes);
  const back = await fs.readBytes(path);
  if (!back || (await sha256Bytes(back.bytes)) !== sha256) throw new SpecError('WRITE_VERIFY', '附件寫入後讀回雜湊不符');
  return { sha256, path, size: bytes.length, reused: false };
}

export async function readBlob(fs, sha256) {
  const r = await fs.readBytes(attachmentPath(sha256));
  if (!r) throw new SpecError('REF_MISSING', `附件檔不存在：${sha256}`);
  if ((await sha256Bytes(r.bytes)) !== sha256) throw new SpecError('REF_HASH', `附件檔雜湊不符：${sha256}`);
  return r.bytes;
}

export function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 200) || '未命名';
}

// 建立附件紀錄與關聯（同一檔名再上傳者版本＋1）
export function addAttachmentRecord(data, ctx, { orig_name, sha256, size, mime }, links = []) {
  const name = safeFileName(orig_name);
  const prev = list(data, 'attachment').filter((a) => a.orig_name === name && links.length &&
    list(data, 'attachment_link').some((l) => l.attachment_id === a.id && l.entity === links[0].entity && l.entity_id === links[0].entity_id));
  const att = insert(data, ctx, 'attachment', { orig_name: name, storage_key: attachmentPath(sha256), sha256, size, mime: mime || null, version: prev.length + 1 });
  for (const l of links) insert(data, ctx, 'attachment_link', { attachment_id: att.id, entity: l.entity, entity_id: l.entity_id });
  return att;
}
