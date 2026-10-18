// 階段1：自檢、資料夾存取、儲存協定、復原草稿、編輯牌（H03–H08、H10–H12、H17–H24、H26–H28）
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, initWith } from './helpers.mjs';
import { selfCheck } from '../src/core/selfcheck.js';
import { openFolder, readCurrent, inspectFolder } from '../src/core/folder.js';
import { MemStore, MemDraftStore, MemLocks } from '../src/adapters/memfs.js';
import { sha256Text } from '../src/core/util.js';
import { SpecError } from '../src/core/errors.js';

const MIN = 60000;

async function edit(s) {
  const r = await s.startEdit();
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

async function bump(s, sec) {
  await s.updateSettings({ heartbeat_sec: sec });
}

function versionFiles(w) {
  return w.store.names('data/versions/');
}

test('初始化：建立第4.4節結構，revision 0，只能用空資料夾', async () => {
  const w = world();
  const a = await initWith(w);
  assert.deepEqual(w.store.names('').filter((n) => !n.startsWith('data/versions/')).sort(),
    ['control/editing.json', 'control/keyword.json', 'data/current.json', 'specdrug.json']);
  assert.equal(versionFiles(w).length, 1);
  assert.equal(a.current.revision, 0);
  assert.equal(a.mode, 'query');
  assert.equal(a.committed.audit.length, 1);
  const b = w.computer('B');
  await assert.rejects(() => b.create('xxxx'), (e) => e.code === 'ALREADY_INIT');
  const other = new MemStore();
  other.rawSet('logs/export-log.jsonl', 'x');
  assert.equal(await inspectFolder(other.client()), 'other');
});

test('儲存：新版本檔一次寫入不覆寫、current.json revision+1、雜湊與稽核鏈', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 40);
  assert.equal(a.unsavedCount, 1);
  const r = await a.save();
  assert.equal(r.status, 'saved');
  assert.equal(a.current.revision, 1);
  assert.equal(versionFiles(w).length, 2);
  const cur = JSON.parse(w.store.rawGet('data/current.json'));
  const text = w.store.rawGet('data/versions/' + cur.file);
  assert.equal(await sha256Text(text), cur.sha256);
  assert.match(cur.file, /^r000001-\d{8}T\d{6}Z-[0-9a-f]{8}\.json$/);
  const o = await openFolder(w.store.client());
  assert.equal(o.ok, true);
  assert.equal(o.data.settings.heartbeat_sec, 40);
  assert.equal(o.audit.at(-1).action, '修改設定');
  assert.equal(o.header.prev_revision, 0);
});

test('H03 儲存步驟3或4途中失敗：current.json 不變，重開為上一完整版本，草稿可取回', async () => {
  for (const failAt of ['create', 'current']) {
    const w = world();
    let armed = false;
    const a0 = await initWith(w);
    const a = w.computer('A', {
      draftStore: a0.draftStore,
      failWrite: (p, op) => {
        if (!armed) return null;
        if (failAt === 'create' && op === 'create' && p.startsWith('data/versions/')) return new Error('磁碟寫入失敗');
        if (failAt === 'current' && p === 'data/current.json') return new Error('分頁已關閉');
        return null;
      },
    });
    await a.open();
    await edit(a);
    await bump(a, 45);
    const before = w.store.rawGet('data/current.json');
    armed = true;
    await assert.rejects(() => a.save());
    assert.equal(w.store.rawGet('data/current.json'), before, failAt);
    const c = w.computer('C');
    await c.open();
    assert.equal(c.current.revision, 0);
    // 重開（同瀏覽器同草稿庫）：草稿基準相同可取回
    const a2 = w.computer('A', { draftStore: a.draftStore });
    await a2.open();
    const rc = await a2.recoveryCheck();
    assert.equal(rc.kind, 'same_base');
    assert.equal(rc.draft.data.settings.heartbeat_sec, 45);
  }
});

test('H04 同一瀏覽器兩分頁：只有一個分頁可編輯', async () => {
  const w = world();
  const a0 = await initWith(w);
  const locks = new MemLocks();
  const tab1 = w.computer('A', { locks });
  const tab2 = w.computer('A', { locks });
  await tab1.open();
  await tab2.open();
  await edit(tab1);
  const r = await tab2.startEdit();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'tab_locked');
  assert.equal(tab2.mode, 'query');
  await tab1.endEdit();
  await edit(tab2);
  void a0;
});

test('H05 開啟後資料夾被其他程式儲存新版本：本分頁儲存被拒、變更保留', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 50);
  // 外部程式改 current.json（revision 變動）
  const cur = JSON.parse(w.store.rawGet('data/current.json'));
  cur.revision = 7;
  w.store.rawSet('data/current.json', JSON.stringify(cur));
  await assert.rejects(() => a.save(), (e) => e.code === 'CONFLICT');
  assert.equal(a.unsavedCount, 1);
  assert.equal(a.work.settings.heartbeat_sec, 50);
  assert.equal(a.newerAvailable, true);
  assert.equal((await a.recoveryCheck()).kind, 'diff_base');
});

test('H06 current.json 已寫入但畫面未得結果，再按儲存：依save_id判為已完成，不產生第二版', async () => {
  const w = world();
  const a = await initWith(w);
  let drop = false;
  // 包一層：寫入current.json後丟出（模擬回應遺失）
  const fs = a.fs;
  const origWrite = fs.write.bind(fs);
  fs.write = async (p, d) => { await origWrite(p, d); if (drop && p === 'data/current.json') { drop = false; throw new Error('連線逾時'); } };
  await edit(a);
  await bump(a, 55);
  drop = true;
  await assert.rejects(() => a.save());
  assert.equal(versionFiles(w).length, 2);
  const r = await a.save();
  assert.equal(r.status, 'already');
  assert.equal(versionFiles(w).length, 2);
  assert.equal(a.unsavedCount, 0);
  assert.equal(a.current.revision, 1);
  // 結果不明期間又改了東西：再存時只補後續變更
  await bump(a, 60);
  drop = true;
  await assert.rejects(() => a.save());
  await bump(a, 65);
  const r2 = await a.save();
  assert.equal(r2.status, 'already');
  assert.equal(a.unsavedCount, 1);
  const r3 = await a.save();
  assert.equal(r3.status, 'saved');
  assert.equal(a.current.revision, 3);
  const o = await openFolder(w.store.client());
  assert.equal(o.data.settings.heartbeat_sec, 65);
  assert.deepEqual(o.audit.filter((e) => e.action === '修改設定').map((e) => e.diff.heartbeat_sec.to), [55, 60, 65]);
});

test('H07 當機重開：提示復原草稿；基準revision不同時不自動套用', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 70);
  // 當機：未儲存、未還牌。另一人逾時後取牌並存新版
  w.clock.advance(6 * MIN);
  const b = w.computer('B');
  await b.open();
  const rb = await b.startEdit();
  assert.equal(rb.status, 'took_stale');
  await bump(b, 80);
  await b.save();
  await b.endEdit();
  const a2 = w.computer('A', { draftStore: a.draftStore });
  await a2.open();
  const rc = await a2.recoveryCheck();
  assert.equal(rc.kind, 'diff_base');
  await edit(a2);
  await assert.rejects(() => a2.applyDraft(), (e) => e.code === 'DRAFT_BASE');
  assert.equal(a2.work.settings.heartbeat_sec, 80);
});

test('H07 基準相同時可復原草稿', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 75);
  w.clock.advance(6 * MIN);
  const a2 = w.computer('A', { draftStore: a.draftStore });
  await a2.open();
  assert.equal((await a2.recoveryCheck()).kind, 'same_base');
  await edit(a2);
  await a2.applyDraft();
  assert.equal(a2.work.settings.heartbeat_sec, 75);
  await a2.save();
  assert.equal(a2.current.revision, 1);
});

test('H10 外部修改版本檔或刪除一筆稽核：開啟時檢出並顯示位置，不靜默採用', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 31);
  await a.save();
  await bump(a, 32);
  await a.save();
  const cur = JSON.parse(w.store.rawGet('data/current.json'));
  const path = 'data/versions/' + cur.file;
  const orig = w.store.rawGet(path);
  // 1. 修改內容
  w.store.rawSet(path, orig.replace('"heartbeat_sec":32', '"heartbeat_sec":99'));
  let o = await openFolder(w.store.client());
  assert.equal(o.ok, false);
  assert.ok(o.errors.some((e) => e.code === 'VERSION_HASH'));
  assert.ok(o.versions.length >= 3);
  // 2. 刪除中間一筆稽核並重算檔案雜湊（模擬有心修改）：雜湊鏈檢出
  const f = JSON.parse(orig);
  f.audit.splice(1, 1);
  const text = JSON.stringify(f) + '\n';
  w.store.rawSet(path, text);
  cur.sha256 = await sha256Text(text);
  w.store.rawSet('data/current.json', JSON.stringify(cur));
  o = await openFolder(w.store.client());
  assert.equal(o.ok, false);
  const chain = o.errors.find((e) => e.code === 'AUDIT_CHAIN');
  assert.ok(chain, JSON.stringify(o.errors));
  assert.match(chain.where, /稽核第 2 筆/);
  // 3. 刪除最末一筆：檔頭筆數檢出
  const g = JSON.parse(orig);
  g.audit.pop();
  const t3 = JSON.stringify(g) + '\n';
  w.store.rawSet(path, t3);
  cur.sha256 = await sha256Text(t3);
  w.store.rawSet('data/current.json', JSON.stringify(cur));
  o = await openFolder(w.store.client());
  assert.ok(o.errors.some((e) => e.code === 'AUDIT_HEAD'));
  // 工作階段：開啟失敗為 error 模式，不可編輯
  const b = w.computer('B');
  await b.open();
  assert.equal(b.mode, 'error');
  assert.equal((await b.startEdit()).ok, false);
});

test('H11 不支援檔案系統存取之瀏覽器：唯讀並說明原因', () => {
  const r = selfCheck({ isSecureContext: true, crypto: globalThis.crypto, navigator: {}, indexedDB: {} });
  assert.equal(r.canEdit, false);
  assert.equal(r.canFolder, false);
  assert.ok(r.readonlyReasons.some((x) => x.includes('檔案系統存取')));
  const full = selfCheck({ isSecureContext: true, crypto: globalThis.crypto, showDirectoryPicker() {}, navigator: { locks: { request() {} } }, indexedDB: {} });
  assert.equal(full.canEdit, true);
  const insecure = selfCheck({ isSecureContext: false, crypto: {}, showDirectoryPicker() {}, navigator: {} });
  assert.equal(insecure.canEdit, false);
});

test('H12 舊版程式開啟新資料結構版本：只可唯讀', async () => {
  const w = world();
  await initWith(w);
  const meta = JSON.parse(w.store.rawGet('specdrug.json'));
  meta.schema_version = 99;
  w.store.rawSet('specdrug.json', JSON.stringify(meta));
  const b = w.computer('B');
  await b.open();
  assert.equal(b.mode, 'query');
  assert.ok(b.readonly[0].includes('新於本程式'));
  const r = await b.startEdit();
  assert.equal(r.status, 'blocked');
});

test('H17 A持牌編輯中，B按開始編輯：不可取牌，提示A名稱、電腦、取牌時間、最後回應', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  w.clock.advance(MIN);
  await a.heartbeatTick();
  const b = w.computer('B');
  await b.open();
  const r = await b.startEdit();
  assert.equal(r.ok, false);
  assert.equal(r.status, 'held');
  assert.equal(r.token.holder.user, 'A');
  assert.equal(r.token.holder.pc, 'PC-A');
  assert.ok(r.token.acquired_at);
  assert.equal(r.lastSeen, w.clock.now());
  assert.equal(b.mode, 'query');
});

test('H18 A結束編輯後，B立即取牌', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await a.endEdit();
  assert.equal(JSON.parse(w.store.rawGet('control/editing.json')).state, 'released');
  const b = w.computer('B');
  await b.open();
  const r = await b.startEdit();
  assert.equal(r.status, 'acquired');
});

test('H18 結束編輯有未儲存變更：須選擇；選放棄即還原、選保留留草稿', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 41);
  assert.equal((await a.endEdit()).status, 'need_choice');
  const r = await a.endEdit('draft');
  assert.equal(r.keptDraft, true);
  assert.equal((await a.recoveryCheck()).kind, 'same_base');
  await edit(a);
  await bump(a, 42);
  await a.endEdit('discard');
  assert.equal(a.work.settings.heartbeat_sec, 30);
  assert.equal((await a.recoveryCheck()).kind, 'none');
});

test('H19 A關閉時來得及還牌→B立即可取；來不及→5分鐘內被擋，逾時可取並提示前一位', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await a.closing();
  const b = w.computer('B');
  await b.open();
  assert.equal((await b.startEdit()).status, 'acquired');
  // 來不及還牌（當機）
  w.clock.advance(MIN);
  await b.heartbeatTick(); // 最後心跳
  const c = w.computer('C');
  await c.open();
  w.clock.advance(3 * MIN);
  let r = await c.startEdit();
  assert.equal(r.status, 'held');
  w.clock.advance(2 * MIN + 1000);
  r = await c.startEdit();
  assert.equal(r.status, 'took_stale');
  assert.equal(r.previous.holder.user, 'B');
  assert.equal(c.pending[0].action, '逾時取得編輯牌');
});

test('H20 A斷線超過5分鐘，B取牌並存檔；A恢復後存檔被拒、轉查詢、變更保留為草稿', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 33);
  a.net.offline = true;
  w.clock.advance(30000);
  assert.equal((await a.heartbeatTick()).status, 'uncertain');
  await assert.rejects(() => a.save(), (e) => e.code === 'TOKEN_UNCERTAIN');
  w.clock.advance(6 * MIN);
  const b = w.computer('B');
  await b.open();
  assert.equal((await b.startEdit()).status, 'took_stale');
  await bump(b, 90);
  await b.save();
  const bFile = JSON.parse(w.store.rawGet('data/current.json')).file;
  a.net.offline = false;
  const hb = await a.heartbeatTick();
  assert.equal(hb.status, 'lost');
  assert.equal(a.mode, 'query');
  const rc = await a.recoveryCheck();
  assert.equal(rc.kind, 'diff_base');
  assert.equal(rc.draft.data.settings.heartbeat_sec, 33);
  assert.equal(JSON.parse(w.store.rawGet('data/current.json')).file, bFile);
});

test('H20 A未經心跳直接存檔：步驟1編輯牌檢查拒絕', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 34);
  w.clock.advance(6 * MIN);
  const b = w.computer('B');
  await b.open();
  await edit(b);
  await assert.rejects(() => a.save(), (e) => e.code === 'TOKEN_LOST');
  assert.equal(a.mode, 'query');
  assert.equal(JSON.parse(w.store.rawGet('data/current.json')).revision, 0);
});

test('H21 A、B幾乎同時取牌：至多一人取得', async () => {
  const w = world();
  const a = await initWith(w);
  const b = w.computer('B');
  await b.open();
  const [ra, rb] = await Promise.all([a.startEdit(), b.startEdit()]);
  const winners = [ra, rb].filter((r) => r.ok);
  assert.equal(winners.length, 1, JSON.stringify([ra.status, rb.status]));
  assert.ok([ra, rb].some((r) => r.status === 'race'));
});

test('H21 若兩人皆進入編輯（網路快取延遲）：後存者被拒，已存版本不被靜默取代', async () => {
  const w = world();
  const a = await initWith(w);
  const b = w.computer('B');
  await b.open();
  await edit(a);
  // 模擬快取：B讀到舊牌而取牌成功（直接改寫牌為B）
  await edit(await (async () => { const raw = JSON.parse(w.store.rawGet('control/editing.json')); raw.state = 'released'; w.store.rawSet('control/editing.json', JSON.stringify(raw)); return b; })());
  await bump(a, 35);
  await bump(b, 36);
  await assert.rejects(() => a.save(), (e) => e.code === 'TOKEN_LOST');
  await b.save();
  const o = await openFolder(w.store.client());
  assert.equal(o.data.settings.heartbeat_sec, 36);
  // 反向：先存者成功、後存者因revision不同被拒
  const w2 = world();
  const x = await initWith(w2, 'X');
  await edit(x);
  await bump(x, 37);
  await x.save();
  const y = w2.computer('Y');
  await y.open();
  // Y以舊版本為基準硬取牌（快取）
  y.current = { ...y.current, revision: 0, sha256: 'old' };
  const raw = JSON.parse(w2.store.rawGet('control/editing.json')); raw.state = 'released'; w2.store.rawSet('control/editing.json', JSON.stringify(raw));
  y.mode = 'query';
  await y.token.acquire({ baseRevision: 0 });
  y.mode = 'edit';
  await bump(y, 38);
  await assert.rejects(() => y.save(), (e) => e.code === 'CONFLICT');
  assert.equal(JSON.parse(w2.store.rawGet('data/current.json')).revision, 1);
});

test('H22 A編輯中分頁置於背景30分鐘（心跳降頻至每分鐘）：B不會看到牌已歸還', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  const b = w.computer('B');
  await b.open();
  for (let i = 0; i < 30; i++) {
    w.clock.advance(MIN);
    await a.heartbeatTick();
    const st = await b.refreshTokenStatus();
    assert.equal(st.status, 'held', `第${i + 1}分鐘`);
  }
});

test('H23 A存檔時C以查詢模式操作：C之結果屬單一版本，提示有新版', async () => {
  const w = world();
  const a = await initWith(w);
  const c = w.computer('C');
  await c.open();
  const before = JSON.stringify(c.committed);
  await edit(a);
  await bump(a, 39);
  await a.save();
  assert.equal(JSON.stringify(c.committed), before);
  assert.equal(c.current.revision, 0);
  const u = await c.checkForUpdate();
  assert.equal(u.newer, true);
  assert.equal(c.newerAvailable, true);
  await c.reload();
  assert.equal(c.current.revision, 1);
  assert.equal(c.committed.data.settings.heartbeat_sec, 39);
});

test('H24 無寫入權之帳號：只能查詢、說明原因、不可取牌', async () => {
  const w = world();
  await initWith(w);
  const r = w.computer('R', { readonly: true });
  await r.open();
  assert.equal(r.canWrite, false);
  assert.equal(r.mode, 'query');
  const st = await r.startEdit();
  assert.equal(st.status, 'blocked');
  assert.ok(st.reasons.some((x) => x.includes('無寫入權')));
  assert.equal((await r.forceTakeover('open-sesame', '測試')).status, 'blocked');
});

test('H26 B輸入正確關鍵詞強制收回：B取得牌；A於下次心跳轉查詢並收到收回資訊；草稿保留；稽核有紀錄', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 43);
  const b = w.computer('B');
  await b.open();
  assert.equal((await b.forceTakeover('open-sesame', '')).status, 'need_reason');
  const r = await b.forceTakeover('open-sesame', 'A請假，急件須處理');
  assert.equal(r.ok, true);
  assert.equal(b.mode, 'edit');
  w.clock.advance(30000);
  const hb = await a.heartbeatTick();
  assert.equal(hb.status, 'lost');
  assert.equal(a.mode, 'query');
  assert.equal(a.lostInfo.token.last_event.type, 'forced');
  assert.equal(a.lostInfo.token.last_event.by.user, 'B');
  assert.equal(a.lostInfo.token.last_event.reason, 'A請假，急件須處理');
  assert.equal((await a.recoveryCheck()).draft.data.settings.heartbeat_sec, 43);
  // B未做其他變更即結束編輯：收回紀錄仍寫入稽核
  await b.endEdit();
  const o = await openFolder(w.store.client());
  const ev = o.audit.find((e) => e.action === '強制收回編輯牌');
  assert.ok(ev);
  assert.equal(ev.user, 'B');
  assert.equal(ev.diff.prev_holder.user, 'A');
  assert.equal(ev.reason, 'A請假，急件須處理');
});

test('H27 錯誤關鍵詞不收回；連續錯5次後30秒內不可再試', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  const b = w.computer('B');
  await b.open();
  for (let i = 1; i <= 4; i++) {
    const r = await b.forceTakeover('wrong', '測試');
    assert.equal(r.status, 'wrong');
    assert.equal(r.remaining, 5 - i);
  }
  assert.equal((await b.forceTakeover('wrong', '測試')).status, 'locked');
  assert.equal((await b.forceTakeover('open-sesame', '測試')).status, 'locked');
  w.clock.advance(29000);
  assert.equal((await b.forceTakeover('open-sesame', '測試')).status, 'locked');
  w.clock.advance(2000);
  await a.heartbeatTick();
  const r = await b.forceTakeover('open-sesame', '測試');
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(w.store.rawGet('control/editing.json')).holder.user, 'B');
});

test('H28 修改關鍵詞須輸入原關鍵詞；keyword.json 只有雜湊無明文', async () => {
  const w = world();
  const a = await initWith(w, 'A', 'first-key');
  await edit(a);
  await assert.rejects(() => a.changeKeyword('nope', 'second-key'), (e) => e.code === 'KEYWORD_WRONG');
  await a.changeKeyword('first-key', 'second-key');
  const raw = w.store.rawGet('control/keyword.json');
  assert.ok(!raw.includes('first-key') && !raw.includes('second-key'));
  assert.match(JSON.parse(raw).hash, /^[0-9a-f]{64}$/);
  await a.endEdit();
  const b = w.computer('B');
  await b.open();
  await edit(a);
  assert.equal((await b.forceTakeover('first-key', '測試')).status, 'wrong');
  assert.equal((await b.forceTakeover('second-key', '測試')).ok, true);
  const o = await openFolder(w.store.client());
  assert.ok(o.audit.some((e) => e.action === '修改關鍵詞'));
});

test('Q16 關鍵詞檔被刪除：持牌者重新設定並記錄稽核', async () => {
  const w = world();
  const a = await initWith(w);
  w.store.files.delete('control/keyword.json');
  const b = w.computer('B');
  await b.open();
  await edit(a);
  assert.equal((await b.forceTakeover('x', '測試')).status, 'no_keyword');
  assert.equal(await a.keywordMissing(), true);
  await a.resetMissingKeyword('new-key-1');
  await a.endEdit();
  const o = await openFolder(w.store.client());
  assert.ok(o.audit.some((e) => e.action.startsWith('重新設定關鍵詞')));
});

test('§4.6第8點 檔案時間在未來2分鐘以上：改以心跳序號觀察，期間顯示確認中', async () => {
  const w = world({ serverSkewMs: 10 * MIN });
  const a = await initWith(w);
  await edit(a);
  const b = w.computer('B');
  await b.open();
  let st = await b.refreshTokenStatus();
  assert.equal(st.status, 'checking');
  w.clock.advance(MIN);
  await a.heartbeatTick();
  st = await b.refreshTokenStatus();
  assert.equal(st.status, 'checking');
  // A當機：序號不再變動超過5分鐘→視為已關閉
  w.clock.advance(5 * MIN + 1000);
  st = await b.refreshTokenStatus();
  assert.equal(st.status, 'stale');
});

test('§4.6第8點 檔案伺服器時間落後（以自己寫入量得偏差）：不提早判為逾時', async () => {
  const w = world({ serverSkewMs: -10 * MIN });
  const a = await initWith(w);
  await edit(a);
  const b = w.computer('B');
  await b.open();
  const st = await b.refreshTokenStatus();
  assert.notEqual(st.status, 'stale');
  assert.equal((await b.startEdit()).ok, false);
});

test('H13（設定部分）修改函式欄位白名單與值域', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await assert.rejects(() => a.updateSettings({ confirm_status: '已確認' }), (e) => e.code === 'FIELD_NOT_ALLOWED');
  await assert.rejects(() => a.updateSettings({ heartbeat_sec: 1 }), (e) => e.code === 'BAD_VALUE');
  await assert.rejects(() => a.updateSettings({ stale_min: 1, heartbeat_sec: 60 }), (e) => e.code === 'BAD_VALUE');
  assert.equal(a.unsavedCount, 0);
});

test('查詢模式不可修改、不可儲存', async () => {
  const w = world();
  const a = await initWith(w);
  await assert.rejects(() => a.updateSettings({ heartbeat_sec: 40 }), (e) => e instanceof SpecError && e.code === 'NOT_EDITING');
  await assert.rejects(() => a.save(), (e) => e.code === 'NOT_EDITING');
});

test('檢視落後時不可取牌（須先重新載入）', async () => {
  const w = world();
  const a = await initWith(w);
  const c = w.computer('C');
  await c.open();
  await edit(a);
  await bump(a, 44);
  await a.save();
  await a.endEdit();
  const r = await c.startEdit();
  assert.equal(r.status, 'stale_view');
  await c.reload();
  await edit(c);
});

test('儲存歷程：各版本雜湊、前一版連結、殘留檔標示', async () => {
  const w = world();
  const a = await initWith(w);
  await edit(a);
  await bump(a, 46);
  await a.save();
  // 殘留：寫了版本檔但沒切current
  w.store.rawSet('data/versions/r000002-20261018T020000Z-deadbeef.json', '{}');
  const h = await a.history();
  assert.equal(h.length, 3);
  assert.equal(h.filter((r) => r.isCurrent).length, 1);
  assert.equal(h.filter((r) => r.inChain).length, 2);
  const bad = h.find((r) => r.name.includes('deadbeef'));
  assert.equal(bad.ok, false);
  void readCurrent;
});

test('路徑白名單：拒絕穿越與非程式產生之檔名', async () => {
  const s = new MemStore().client();
  await assert.rejects(() => s.read('../x.json'), (e) => e.code === 'BAD_PATH');
  await assert.rejects(() => s.write('data/versions/evil.json', 'x'), (e) => e.code === 'BAD_PATH');
  await assert.rejects(() => s.read('attachments/ab/../../specdrug.json'), (e) => e.code === 'BAD_PATH');
  void MemDraftStore;
});

test('H19 同瀏覽器：前一分頁關閉未還牌，重開時以分頁鎖確認已關閉→視同歸還；他台電腦仍須等逾時', async () => {
  const { MemLocalSessions } = await import('../src/adapters/memfs.js');
  const w = world();
  await initWith(w);
  const locks = new MemLocks();
  const local = new MemLocalSessions();
  const mk = (name) => {
    const s = w.computer(name, { locks });
    s.localSessions = local;
    return s;
  };
  const tab1 = mk('A');
  await tab1.open();
  await edit(tab1);
  // 分頁當掉：鎖由瀏覽器釋放，牌未改寫
  tab1._tabUnlock();
  const other = w.computer('B');
  await other.open();
  assert.equal((await other.startEdit()).status, 'held');
  const tab2 = mk('A');
  await tab2.open();
  const r = await tab2.startEdit();
  assert.equal(r.status, 'took_local');
  assert.equal(tab2.pending[0].action, '取得編輯牌（本瀏覽器前一分頁已關閉）');
  // 分頁仍開著（持鎖）時不適用
  const tab3 = mk('A');
  await tab3.open();
  assert.equal((await tab3.startEdit()).status, 'tab_locked');
});
