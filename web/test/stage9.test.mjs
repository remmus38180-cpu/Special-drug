// 階段9：備份還原（T22、H09、H11、REVIEW M7、L1）
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../src/core/backup.js';
import * as P from '../src/core/pricing.js';
import { readZip, writeZip, zipComment } from '../src/core/zip.js';
import { sha256Bytes, utf8 } from '../src/core/util.js';
import { openFolder, listVersions } from '../src/core/folder.js';
import { AppSession } from '../src/core/session.js';
import { MemDraftStore, MemLocks } from '../src/adapters/memfs.js';
import { world, initWith } from './helpers.mjs';

async function withData() {
  const w = world();
  const a = await initWith(w);
  await a.startEdit();
  await a.loadDemo();
  const kid = await a.run((d, k) => P.createContract(d, k, { contract_no: 'K-BK', status: '辦理中', drugs: ['A000001100'] }).id);
  await P.attachFiles(a, 'contract', kid, [{ name: '合約.pdf', bytes: utf8('PDF-原件') }]);
  await a.save();
  return { w, a, kid };
}

function rezip(bytes, mutate) {
  const z = readZip(bytes);
  let files = z.entries.map((e) => ({ name: e.name, data: z.bytes(e.name) }));
  const man = JSON.parse(z.text('backup_manifest.json'));
  const r = mutate({ files, man }) || {};
  files = (r.files || files).map((f) => (f.name === 'backup_manifest.json' ? { name: f.name, data: JSON.stringify(r.man || man) } : f));
  return writeZip(files);
}

test('T22 備份→還原：附件雜湊與資料關聯一致，歷史查詢正確，舊版本檔未被改寫；稽核記錄來源', async () => {
  const { w, a, kid } = await withData();
  const { bytes, manifest } = await B.buildBackup(a.fs, { actor: 'A' });
  assert.equal(manifest.source_revision, a.current.revision);
  assert.ok(manifest.files.some((f) => f.path.startsWith('attachments/')));
  assert.ok(manifest.files.some((f) => f.path.startsWith('masters/')));
  assert.equal(manifest.files.filter((f) => f.path.startsWith('data/versions/')).length, 1);
  assert.match(zipComment(bytes), /specdrug backup r/);
  const v = await B.verifyBackup(bytes);
  assert.ok(v.ok, v.errors && v.errors.join());
  // 備份後再變更、儲存
  await a.run((d, k) => { P.updateContract(d, k, kid, { firm: '備份後改' }); });
  await a.save();
  const before = new Map(w.store.names('data/versions/').map((n) => [n, w.store.rawGet(n)]));
  const revBefore = a.current.revision;
  const r = await B.restoreBackup(a, bytes, { reason: '演練還原', opId: 'op-restore', backupName: 'bk.zip' });
  assert.equal(r.save, 'saved');
  assert.equal(a.current.revision, revBefore + 1);
  for (const [n, t] of before) assert.equal(w.store.rawGet(n), t, `舊版本檔不變：${n}`);
  const o = await openFolder(w.store.client());
  assert.ok(o.ok);
  const c = o.data.collections.contract.find((x) => x.id === kid);
  assert.equal(c.firm, null);
  const att = P.attachmentsOf(o.data, 'contract', kid)[0];
  const ab = w.store.files.get(att.storage_key).bytes;
  assert.equal(await sha256Bytes(ab), att.sha256);
  const ev = o.audit.at(-1);
  assert.equal(ev.action, '還原');
  assert.equal(ev.reason, '演練還原');
  assert.equal(ev.diff.source_revision, manifest.source_revision);
  assert.ok(o.audit.some((e) => e.action === '修改' && e.entity === 'contract'), '還原後稽核仍保留備份後之歷程');
});

test('還原至新資料夾（演練）：附件與主檔寫入並驗雜湊；須填原因；有未儲存變更不可還原', async () => {
  const { a } = await withData();
  const { bytes } = await B.buildBackup(a.fs);
  const w2 = world();
  const b = await initWith(w2, 'B');
  await b.startEdit();
  await assert.rejects(() => B.restoreBackup(b, bytes, { reason: ' ' }), (e) => e.code === 'REQUIRED');
  await b.updateSettings({ heartbeat_sec: 45 });
  await assert.rejects(() => B.restoreBackup(b, bytes, { reason: 'x' }), (e) => e.code === 'UNSAVED');
  await b.save();
  const r = await B.restoreBackup(b, bytes, { reason: '演練' });
  assert.ok(r.files_written >= 2);
  const o = await openFolder(w2.store.client());
  assert.ok(o.ok);
  assert.ok(o.data.collections.contract.some((c) => c.contract_no === 'K-BK'));
  assert.ok(o.data.info && o.data.info.demo);
});

test('H09 還原之zip含 ../、缺版本檔、多一份版本檔或雜湊不符：拒絕並指出原因，資料夾不變', async () => {
  const { w, a } = await withData();
  const { bytes } = await B.buildBackup(a.fs);
  const snap = () => JSON.stringify([...w.store.files.keys()].sort()) + w.store.rawGet('data/current.json');
  const s0 = snap();
  const cases = {
    '../ 路徑': rezip(bytes, ({ files, man }) => { files.push({ name: '../evil.json', data: utf8('x') }); man.files.push({ path: '../evil.json', size: 1, sha256: '0' }); }),
    缺版本檔: rezip(bytes, ({ files, man }) => ({ files: files.filter((f) => !f.name.startsWith('data/versions/')), man: { ...man, files: man.files.filter((f) => !f.path.startsWith('data/versions/')) } })),
    多一份版本檔: rezip(bytes, ({ files, man }) => { const v = files.find((f) => f.name.startsWith('data/versions/')); const n = v.name.replace(/^data\/versions\/r(\d{6})/, (m, x) => `data/versions/r${String(Number(x) + 5).padStart(6, '0')}`); files.push({ name: n, data: v.data }); const e = man.files.find((f) => f.path === v.name); man.files.push({ ...e, path: n }); }),
    雜湊不符: rezip(bytes, ({ files }) => { const f = files.find((x) => x.name.startsWith('attachments/')); f.data = utf8('被竄改'); }),
    manifest外檔案: rezip(bytes, ({ files }) => { files.push({ name: 'masters/00000000-0000-0000-0000-000000000000.json', data: utf8('{}') }); }),
  };
  const expect = { '../ 路徑': /\.\./, 缺版本檔: /缺資料版本檔/, 多一份版本檔: /恰為一份/, 雜湊不符: /雜湊不符|大小不符/, manifest外檔案: /未列之檔案/ };
  for (const [k, zb] of Object.entries(cases)) {
    const v = await B.verifyBackup(zb);
    assert.equal(v.ok, false, k);
    assert.ok(v.errors.some((e) => expect[k].test(e)), `${k}：${v.errors.join('；')}`);
    await assert.rejects(() => B.restoreBackup(a, zb, { reason: '測' }), (e) => e.code === 'BACKUP_INVALID', k);
    assert.equal(snap(), s0, `資料夾不變：${k}`);
  }
});

test('M7／L1 manifest 漏列資料版本檔或附件、路徑不在白名單：拒絕', async () => {
  const { a } = await withData();
  const { bytes } = await B.buildBackup(a.fs);
  // manifest 漏列版本檔（zip 內仍有）→ manifest 外檔案＋缺版本檔
  const z1 = rezip(bytes, ({ man }) => ({ man: { ...man, files: man.files.filter((f) => !f.path.startsWith('data/versions/')) } }));
  const v1 = await B.verifyBackup(z1);
  assert.ok(!v1.ok && v1.errors.some((e) => /缺資料版本檔/.test(e)));
  // 資料引用之附件未列於 manifest（zip 內亦移除）
  const z2 = rezip(bytes, ({ files, man }) => ({ files: files.filter((f) => !f.name.startsWith('attachments/')), man: { ...man, files: man.files.filter((f) => !f.path.startsWith('attachments/')) } }));
  const v2 = await B.verifyBackup(z2);
  assert.ok(!v2.ok && v2.errors.some((e) => /未列於 manifest/.test(e)), v2.errors.join());
  for (const bad of ['/etc/passwd', 'C:/x.json', 'attachments\\aa\\bb', 'control/keyword.json', 'other/x.json']) {
    const z3 = rezip(bytes, ({ files, man }) => { files.push({ name: 'x', data: utf8('') }); man.files.push({ path: bad, size: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }); });
    const v3 = await B.verifyBackup(z3);
    assert.ok(!v3.ok && v3.errors.some((e) => e.includes(bad)), `${bad}：${v3.errors.join()}`);
  }
  // 既有檔案雜湊不符 → 中止（不寫入）
  const w2 = world();
  const b = await initWith(w2, 'B');
  await b.startEdit();
  const v = await B.verifyBackup(bytes);
  const attPath = [...v.files.keys()].find((p) => p.startsWith('attachments/'));
  w2.store.rawSet(attPath, '不同內容');
  const n0 = w2.store.names('');
  await assert.rejects(() => B.restoreBackup(b, bytes, { reason: 'x' }), (e) => e.code === 'REF_HASH');
  assert.deepEqual(w2.store.names(''), n0);
  assert.equal((await listVersions(b.fs)).length, 1);
});

test('H11 以備份zip唯讀開啟：可查詢；不可取牌編輯', async () => {
  const { a } = await withData();
  const { bytes } = await B.buildBackup(a.fs);
  const { fs } = await B.backupReadonlyFs(bytes);
  const s = new AppSession({ fs, clock: { now: () => Date.now() }, sleep: async () => {}, profile: { user: 'Q', pc: 'PC-Q' }, draftStore: new MemDraftStore(), locks: new MemLocks() });
  await s.open();
  assert.equal(s.mode, 'query');
  assert.ok(s.committed.data.collections.contract.some((c) => c.contract_no === 'K-BK'));
  assert.ok(s.editBlockers().some((x) => x.includes('寫入')));
  const r = await s.startEdit();
  assert.equal(r.ok, false);
  await assert.rejects(() => B.backupReadonlyFs(rezip(bytes, ({ files }) => { files.find((x) => x.name.startsWith('attachments/')).data = utf8('x'); })), (e) => e.code === 'BACKUP_INVALID');
});
