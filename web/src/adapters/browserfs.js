// 瀏覽器檔案系統存取（FileSystemDirectoryHandle）介面卡。介面同 memfs。
import { SpecError } from '../core/errors.js';
import { assertPath, assertDir } from '../core/paths.js';

async function walk(root, parts, create) {
  let d = root;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return d;
}

function notFound(e) {
  return e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');
}

export function browserFs(root) {
  async function fileHandle(path, create) {
    const parts = assertPath(path).split('/');
    const name = parts.pop();
    const dir = await walk(root, parts, create);
    return dir.getFileHandle(name, { create });
  }

  async function writeAll(fh, data) {
    const w = await fh.createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (e2) { /* 忽略 */ }
      throw e;
    }
  }

  return {
    name: root.name,
    handle: root,
    async read(path) {
      try {
        const f = await (await fileHandle(path, false)).getFile();
        return { text: await f.text(), lastModified: f.lastModified, size: f.size };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async readBytes(path) {
      try {
        const f = await (await fileHandle(path, false)).getFile();
        return { bytes: new Uint8Array(await f.arrayBuffer()), lastModified: f.lastModified, size: f.size };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async write(path, data) {
      await writeAll(await fileHandle(path, true), data);
    },
    async create(path, data) {
      let exists = true;
      try { await fileHandle(path, false); } catch (e) { if (notFound(e)) exists = false; else throw e; }
      if (exists) throw new SpecError('EXISTS', `檔案已存在，不覆寫：${path}`);
      await writeAll(await fileHandle(path, true), data);
    },
    async remove(path) {
      const parts = assertPath(path).split('/');
      const name = parts.pop();
      const dir = await walk(root, parts, false);
      await dir.removeEntry(name);
    },
    async list(dirPath) {
      assertDir(dirPath);
      let dir;
      try {
        dir = dirPath ? await walk(root, dirPath.split('/'), false) : root;
      } catch (e) {
        if (notFound(e)) return [];
        throw e;
      }
      const out = [];
      for await (const [name, h] of dir.entries()) out.push({ name, kind: h.kind });
      return out;
    },
  };
}

export async function queryPermission(handle) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'granted';
  return handle.queryPermission({ mode: 'readwrite' });
}

export async function requestPermission(handle) {
  if (!handle || typeof handle.requestPermission !== 'function') return 'granted';
  return handle.requestPermission({ mode: 'readwrite' });
}
