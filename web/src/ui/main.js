// 介面：啟動、狀態列、編輯牌操作、儲存歷程、設定、關於。只呼叫業務模組函式改資料。
import { h, clear, table, dialog, alertBox } from './dom.js';
import { saveTextAs } from './files.js';
import { selfCheck } from '../core/selfcheck.js';
import { AppSession } from '../core/session.js';
import { inspectFolder, loadVersion } from '../core/folder.js';
import { browserFs, queryPermission, requestPermission } from '../adapters/browserfs.js';
import { idbStore, browserLocks, localSessions } from '../adapters/idb.js';
import { errText } from '../core/errors.js';
import { APP_VERSION, SCHEMA_VERSION, BUILD_DATE, BUILD_COMMIT } from '../core/version.js';
import { taipeiDisplay, taipeiHM, taipeiCompact, parseIso, revLabel } from '../core/util.js';
import { settingLabel, DEFAULT_SETTINGS } from '../core/dataset.js';
import { MIN_KEYWORD_LENGTH } from '../core/keyword.js';

const PROFILE_KEY = 'specdrug.profile';
// 設計建議（待使用者同意）：同瀏覽器前一分頁已關閉（navigator.locks 已釋放）時視同已還牌。預設關閉。
const LOCAL_CLOSED_RELEASE = false;
const LAST_FOLDER_KEY = 'folder:last';

const ui = {
  check: null,
  session: null,
  folderName: '',
  tab: 'home',
  timers: { heartbeat: null, poll: null },
  busy: false,
};

const $root = () => document.getElementById('app');

// ---------- 使用者名稱（存於本機瀏覽器設定；非身分驗證） ----------
function loadProfile() {
  let p = { user: '', pc: '' };
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    if (raw) p = { ...p, ...JSON.parse(raw) };
  } catch (e) { /* 無法讀取時須重新輸入 */ }
  const q = new URLSearchParams(window.location.search).get('user');
  if (q && !p.user) p.user = q; // Q14：捷徑帶入，僅預填
  return p;
}

function saveProfile(p) {
  try { window.localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) { /* 忽略 */ }
}

// ---------- 共用 ----------
function fmtIso(s) {
  const ms = parseIso(s);
  return ms === null ? '' : taipeiDisplay(ms);
}

function who(x) {
  if (!x) return '（不明）';
  return `${x.user || '（未填）'}（電腦：${x.pc || '未填'}）`;
}

async function guard(fn) {
  if (ui.busy) return;
  ui.busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    await alertBox('錯誤', errText(e), '下一步：請依訊息處理；未儲存變更已保留於本機復原草稿。');
  } finally {
    ui.busy = false;
    render();
  }
}

function btn(label, onClick, opts = {}) {
  return h('button', { type: 'button', class: opts.primary ? 'primary' : '', disabled: ui.busy || opts.disabled, title: opts.title, text: label, on: { click: onClick } });
}

// ---------- 計時器（函式形式，不用字串） ----------
function stopTimers() {
  if (ui.timers.heartbeat) clearInterval(ui.timers.heartbeat);
  if (ui.timers.poll) clearInterval(ui.timers.poll);
  ui.timers.heartbeat = null;
  ui.timers.poll = null;
}

function startTimers() {
  stopTimers();
  const s = ui.session;
  if (!s || (s.mode !== 'query' && s.mode !== 'edit')) return;
  const hbMs = s.settings.heartbeat_sec * 1000;
  ui.timers.heartbeat = setInterval(onHeartbeat, hbMs);
  ui.timers.poll = setInterval(onPoll, 60000);
}

async function onHeartbeat() {
  const s = ui.session;
  if (!s || s.mode !== 'edit') return;
  const r = await s.heartbeatTick();
  if (r.status === 'lost') {
    const ev = r.token && r.token.last_event;
    const lines = [];
    if (ev && ev.type === 'forced') {
      lines.push(`編輯牌已被 ${who(ev.by)} 於 ${fmtIso(ev.at)} 強制收回，原因：${ev.reason || '（未填）'}。`);
    } else {
      lines.push(`編輯牌已不在本分頁（目前持牌：${who(r.token && r.token.holder)}）。`);
    }
    lines.push('你未儲存的變更已保留為復原草稿。已改為查詢模式。');
    render();
    await alertBox('編輯牌已被收回', ...lines);
  }
  render();
}

async function onPoll() {
  const s = ui.session;
  if (!s) return;
  try {
    await s.checkForUpdate();
  } catch (e) { /* 讀取失敗下次再試 */ }
  render();
}

// ---------- 資料夾 ----------
async function rememberFolder(handle) {
  if (!ui.check.caps.idb) return;
  try { await idbStore.put(LAST_FOLDER_KEY, handle); } catch (e) { /* 無法記住，下次重選 */ }
}

async function lastFolder() {
  if (!ui.check.caps.idb) return null;
  try { return await idbStore.get(LAST_FOLDER_KEY); } catch (e) { return null; }
}

function profileOk() {
  const p = loadProfile();
  return p.user.trim() && p.pc.trim();
}

async function pickFolder() {
  if (!profileOk()) { await alertBox('請先輸入使用者', '請先輸入「員編／姓名」及「電腦代號」並按儲存。'); return null; }
  try {
    return await window.showDirectoryPicker({ id: 'specdrug', mode: 'readwrite' });
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    throw e;
  }
}

async function openHandle(handle, { allowInit } = {}) {
  const perm = await queryPermission(handle);
  if (perm !== 'granted') {
    const p2 = await requestPermission(handle);
    if (p2 !== 'granted') {
      await alertBox('未授權', '未取得資料夾讀寫授權，無法開啟。可再按「重新授權上次資料夾」或重新選擇。');
      return;
    }
  }
  const fs = browserFs(handle);
  const kind = await inspectFolder(fs);
  if (kind === 'other') {
    await alertBox('不是本系統資料夾', `「${handle.name}」內已有其他檔案，且沒有 specdrug.json。`, '開啟既有資料請選含 specdrug.json 的資料夾；建立新資料請選空資料夾。');
    return;
  }
  const session = new AppSession({
    fs, profile: loadProfile(), draftStore: ui.check.caps.idb ? idbStore : null,
    locks: browserLocks(navigator), caps: ui.check, localSessions: LOCAL_CLOSED_RELEASE ? localSessions : null,
  });
  if (kind === 'empty') {
    if (!allowInit) {
      await alertBox('空資料夾', `「${handle.name}」是空資料夾。要建立新資料夾請按「建立新資料夾」。`);
      return;
    }
    const kw = await askNewKeyword();
    if (!kw) return;
    await session.create(kw);
  } else {
    await session.open();
  }
  await rememberFolder(handle);
  attach(session, handle.name);
  if (session.mode === 'error') return;
  await offerRecovery();
}

function attach(session, name) {
  if (ui.session) { ui.session.closing(); }
  ui.session = session;
  ui.folderName = name;
  ui.tab = 'home';
  session.onChange(() => render());
  startTimers();
  render();
}

async function askNewKeyword(title = '設定強制收回關鍵詞') {
  const k1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const k2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const msg = h('p', { class: 'warn-text', role: 'alert' });
  const v = await dialog(title, [
    h('p', { text: `關鍵詞用於「強制收回」編輯牌；至少 ${MIN_KEYWORD_LENGTH} 個字。只存加鹽雜湊，不存明文。請交由保管者保存（Q16）。` }),
    h('label', null, '關鍵詞 ', k1), h('br'), h('label', null, '再輸入一次 ', k2), msg,
  ], [
    { label: '取消', value: null },
    { label: '確定', value: 'ok', primary: true, validate: () => {
      if (k1.value.trim().length < MIN_KEYWORD_LENGTH) { msg.textContent = `至少 ${MIN_KEYWORD_LENGTH} 個字`; return false; }
      if (k1.value !== k2.value) { msg.textContent = '兩次輸入不同'; return false; }
      return true;
    } },
  ]);
  return v ? k1.value : null;
}

// ---------- 復原草稿 ----------
async function offerRecovery() {
  const s = ui.session;
  const rc = await s.recoveryCheck();
  if (rc.kind === 'none' || rc.kind === 'error') return;
  const d = rc.draft;
  const info = `本機有復原草稿：${fmtIso(d.saved_at)}，${who(d)}，未儲存變更 ${d.dirty} 項，基準 ${revLabel(d.base_revision)}（目前 ${revLabel(s.current.revision)}）。`;
  if (rc.kind === 'same_base') {
    const v = await dialog('復原草稿', [h('p', { text: info }), h('p', { text: '復原須先取得編輯牌。' })], [
      { label: '稍後再說', value: null },
      { label: '放棄草稿', value: 'discard' },
      { label: '取得編輯牌並復原', value: 'apply', primary: true },
    ]);
    if (v === 'discard') await s.discardDraft();
    if (v === 'apply') {
      const r = await s.startEdit();
      if (!r.ok) { await explainStartFail(r); return; }
      ui.recovering = true;
      try { await afterAcquire(r); } finally { ui.recovering = false; }
      await s.applyDraft();
    }
  } else {
    const v = await dialog('復原草稿（基準不同）', [
      h('p', { text: info }),
      h('p', { class: 'warn-text', text: '資料夾已有較新版本，草稿不自動套用。請另存為復原檔，核對後手動重套。' }),
    ], [
      { label: '稍後再說', value: null },
      { label: '放棄草稿', value: 'discard' },
      { label: '另存為復原檔', value: 'export', primary: true },
    ]);
    if (v === 'export') {
      const name = `特藥_復原草稿_${taipeiCompact(Date.now())}_${revLabel(d.base_revision)}.json`;
      const r = await saveTextAs(name, JSON.stringify(d, null, 2));
      if (r.saved) {
        const v2 = await dialog('已另存', [h('p', { text: `已存為「${r.name}」。要刪除本機草稿嗎？` })], [
          { label: '保留', value: null }, { label: '刪除本機草稿', value: 'del', primary: true },
        ]);
        if (v2 === 'del') await s.discardDraft();
      }
    }
    if (v === 'discard') {
      const ok = await dialog('確認放棄', [h('p', { text: '放棄後無法取回此草稿。確定放棄？' })], [{ label: '取消', value: null }, { label: '放棄', value: true, primary: true }]);
      if (ok) await s.discardDraft();
    }
  }
}

// ---------- 編輯牌 ----------
async function explainStartFail(r) {
  const s = ui.session;
  if (r.status === 'held' || r.status === 'checking') {
    const t = r.token;
    const last = r.lastSeen ? taipeiHM(r.lastSeen) : '確認中';
    const v = await dialog('編輯牌在他人手上', [
      h('p', { text: `編輯牌目前在 ${(t.holder && t.holder.user) || '（不明）'}（電腦：${(t.holder && t.holder.pc) || '不明'}）手上，自 ${taipeiHM(parseIso(t.acquired_at))} 起，最後回應 ${last}。` }),
      r.status === 'checking' ? h('p', { class: 'warn-text', text: '檔案時間與本機時間差異異常，正以心跳序號觀察判定（確認中）。' }) : null,
      h('p', { text: '請待對方結束編輯，或使用「強制收回」。' }),
    ], [
      { label: '繼續查詢', value: null },
      { label: '重新檢查', value: 'retry' },
      { label: '強制收回', value: 'force', primary: true },
    ]);
    if (v === 'retry') { const r2 = await s.startEdit(); if (!r2.ok) await explainStartFail(r2); else await afterAcquire(r2); }
    if (v === 'force') await doForce();
    return;
  }
  const map = {
    blocked: ['只能查詢', ...(r.reasons || [])],
    tab_locked: ['只能查詢', '此資料夾已在同一瀏覽器的另一分頁編輯中。請回到該分頁，或先關閉該分頁。'],
    stale_view: ['資料夾有新版', '資料夾已有新版本，請先按「重新載入」再開始編輯。'],
    race: ['取牌未成功', `幾乎同時有人取牌，目前持牌：${who(r.token && r.token.holder)}。已退回查詢模式。`],
    error: ['取牌失敗', r.error || ''],
  };
  const m = map[r.status] || ['無法開始編輯', r.status];
  await alertBox(m[0], ...m.slice(1));
}

async function afterAcquire(r) {
  if (r.status === 'took_local' && r.previous) {
    await alertBox('已取得編輯牌', `前一位持牌者為本瀏覽器先前的分頁（${who(r.previous.holder)}，最後回應 ${fmtIso(r.previous.heartbeat_at)}），該分頁已關閉，視同已歸還。`);
  }
  if (r.status === 'took_stale' && r.previous) {
    await alertBox('已取得編輯牌', `前一位持牌者 ${who(r.previous.holder)} 最後回應 ${fmtIso(r.previous.heartbeat_at)}，已超過 ${ui.session.settings.stale_min} 分鐘無回應，視為已關閉。`);
  }
  if (await ui.session.keywordMissing()) {
    const kw = await askNewKeyword('關鍵詞檔不存在，請重新設定');
    if (kw) await ui.session.resetMissingKeyword(kw);
  }
  startTimers();
  if (!ui.session.hasUnsaved || (ui.session.dirty === 0)) {
    const rc = await ui.session.recoveryCheck();
    if (rc.kind === 'same_base' && !ui.recovering) {
      const v = await dialog('復原草稿', [h('p', { text: `本機有復原草稿（${fmtIso(rc.draft.saved_at)}，未儲存變更 ${rc.draft.dirty} 項），基準與目前版本相同。` })], [
        { label: '稍後再說', value: null }, { label: '放棄草稿', value: 'discard' }, { label: '復原', value: 'apply', primary: true },
      ]);
      if (v === 'apply') await ui.session.applyDraft();
      if (v === 'discard') await ui.session.discardDraft();
    }
  }
}

async function doStartEdit() {
  const r = await ui.session.startEdit();
  if (!r.ok) { await explainStartFail(r); return; }
  await afterAcquire(r);
}

async function doEndEdit() {
  const s = ui.session;
  let choice;
  if (s.dirty > 0) {
    choice = await dialog('結束編輯', [h('p', { text: `有 ${s.dirty} 項未儲存變更。` })], [
      { label: '取消', value: null },
      { label: '放棄變更', value: 'discard' },
      { label: '保留本機草稿', value: 'draft' },
      { label: '儲存', value: 'save', primary: true },
    ]);
    if (!choice) return;
  }
  const r = await s.endEdit(choice);
  if (r.releaseError) await alertBox('還牌未完成', `編輯牌改寫失敗：${r.releaseError}。他人須待 ${s.settings.stale_min} 分鐘無心跳後才能取牌。`);
}

async function doSave() {
  const s = ui.session;
  try {
    const r = await s.save();
    if (r.status === 'already') await alertBox('已儲存', '先前一次儲存已完成（依 save_id 判定），未重複建立版本。');
  } catch (e) {
    if (e.code === 'OVERWRITTEN') { await alertBox('目前版本已被其他人覆蓋', e.message, '本次變更仍保留於復原草稿。'); return; }
    if (e.code === 'CONFLICT') { await alertBox('儲存被拒', e.message, '你的變更已保留於本機復原草稿。請結束編輯（保留草稿）→重新載入→核對後重套。'); return; }
    if (e.code === 'TOKEN_LOST') { await alertBox('儲存被拒', e.message); return; }
    throw e;
  }
}

async function doForce() {
  const s = ui.session;
  const st = s.guard.status();
  if (st.locked) { await alertBox('暫停嘗試', `連續輸錯，請 ${Math.ceil(st.remainMs / 1000)} 秒後再試。`); return; }
  const kw = h('input', { type: 'password', autocomplete: 'off' });
  const reason = h('input', { type: 'text', size: 30 });
  const msg = h('p', { class: 'warn-text', role: 'alert' });
  const holder = s.tokenStatus && s.tokenStatus.token && s.tokenStatus.token.holder;
  const v = await dialog('強制收回編輯牌', [
    h('p', { text: `目前持牌：${who(holder)}。收回後對方將於下次心跳（約${s.settings.heartbeat_sec}秒內）改為查詢模式，其未儲存變更保留於對方電腦的復原草稿。` }),
    h('label', null, '關鍵詞 ', kw), h('br'), h('label', null, '收回原因 ', reason), msg,
  ], [
    { label: '取消', value: null },
    { label: '強制收回', value: 'go', primary: true, validate: () => {
      if (!reason.value.trim()) { msg.textContent = '請填收回原因'; return false; }
      return true;
    } },
  ]);
  if (!v) return;
  const r = await s.forceTakeover(kw.value, reason.value);
  if (r.ok) { await alertBox('已收回', '已取得編輯牌。收回紀錄將於下次存檔（或結束編輯時）寫入稽核。'); await afterAcquire(r); return; }
  const map = {
    wrong: `關鍵詞不正確，未收回。再錯 ${r.remaining} 次將暫停30秒。`,
    locked: `連續輸錯，請 ${Math.ceil((r.remainMs || 0) / 1000)} 秒後再試。`,
    no_keyword: '尚未設定關鍵詞（control/keyword.json 不存在），無法強制收回。請待持牌者結束編輯或逾時；取牌後可重新設定。',
    need_reason: '請填收回原因。',
    blocked: '只能查詢：' + (r.reasons || []).join('；'),
    tab_locked: '此資料夾已在同一瀏覽器的另一分頁編輯中。',
    stale_view: '資料夾有新版，請先重新載入。',
    race: '收回時有人同時取牌，未成功。',
  };
  await alertBox('未收回', map[r.status] || r.status);
}

async function doReload() {
  const s = ui.session;
  if (s.mode === 'edit' && s.hasUnsaved) { await alertBox('有未儲存變更', '請先儲存或結束編輯（保留草稿）後再重新載入。'); return; }
  await s.reload();
  startTimers();
}

// ---------- 畫面 ----------
function renderStatusBar() {
  const s = ui.session;
  const bar = h('div', { class: 'statusbar', role: 'status' });
  if (!s || s.mode === 'closed') {
    bar.appendChild(h('span', { text: '尚未開啟資料夾' }));
    return bar;
  }
  const st = s.statusInfo();
  const modeText = st.mode === 'edit' ? '編輯中' : st.mode === 'query' ? '查詢' : '無法開啟';
  bar.appendChild(h('span', { class: 'chip' + (st.mode === 'edit' ? ' chip-edit' : ''), text: `模式：${modeText}` }));
  bar.appendChild(h('span', { text: `資料夾：${ui.folderName}` }));
  const t = st.token;
  let tokText = '編輯牌：狀態不明';
  if (t) {
    if (t.status === 'free') tokText = '編輯牌：無人持有';
    else if (t.status === 'mine') tokText = `編輯牌：本分頁持有（自 ${taipeiHM(parseIso(t.token.acquired_at))}）`;
    else if (t.status === 'held') tokText = `編輯牌：${who(t.token.holder)}持有（自 ${taipeiHM(parseIso(t.token.acquired_at))}，最後回應 ${taipeiHM(t.lastSeen)}）`;
    else if (t.status === 'checking') tokText = `編輯牌：${who(t.token.holder)}持有（確認中）`;
    else if (t.status === 'stale') tokText = `編輯牌：${who(t.token.holder)}已逾時無回應（可取牌）`;
  }
  if (st.tokenUncertain) tokText = '編輯牌狀態不明（心跳寫入失敗，暫停存檔）';
  bar.appendChild(h('span', { class: st.tokenUncertain ? 'warn-text' : '', text: tokText }));
  if (st.revision !== undefined && st.revision !== null) bar.appendChild(h('span', { text: `${revLabel(st.revision)}｜${fmtIso(st.savedAt)}` }));
  bar.appendChild(h('span', { class: st.unsaved ? 'warn-text' : '', text: `未儲存變更：${st.unsaved}${st.pendingAudit && !st.unsaved ? `（待寫入稽核 ${st.pendingAudit} 筆）` : ''}` }));
  bar.appendChild(h('span', { text: '主檔：尚未匯入' }));
  if (st.newerAvailable) bar.appendChild(h('span', { class: 'chip chip-warn', text: '資料夾有新版，請重新載入' }));
  return bar;
}

function renderToolbar() {
  const s = ui.session;
  const bar = h('div', { class: 'toolbar' });
  if (!s || (s.mode !== 'query' && s.mode !== 'edit')) return bar;
  if (s.mode === 'query') {
    const blockers = s.editBlockers();
    bar.appendChild(btn('開始編輯', () => guard(doStartEdit), { primary: true, disabled: blockers.length > 0, title: blockers.join('；') }));
    const t = s.tokenStatus;
    if (t && (t.status === 'held' || t.status === 'checking')) bar.appendChild(btn('強制收回', () => guard(doForce), { disabled: blockers.length > 0 }));
    bar.appendChild(btn('重新載入', () => guard(doReload)));
  } else {
    bar.appendChild(btn('儲存', () => guard(doSave), { primary: true, disabled: !s.hasUnsaved || s.tokenUncertain }));
    bar.appendChild(btn('結束編輯', () => guard(doEndEdit)));
  }
  bar.appendChild(btn('關閉資料夾', () => guard(closeFolder)));
  return bar;
}

async function closeFolder() {
  const s = ui.session;
  if (s && s.mode === 'edit') {
    await doEndEdit();
    if (s.mode === 'edit') return;
  }
  stopTimers();
  ui.session = null;
  ui.folderName = '';
}

function renderTabs() {
  const tabs = [['home', '首頁'], ['history', '儲存歷程'], ['settings', '設定'], ['about', '關於']];
  return h('nav', { class: 'tabs', 'aria-label': '功能' }, tabs.map(([k, label]) => h('button', {
    type: 'button', class: 'tab' + (ui.tab === k ? ' tab-on' : ''), 'aria-current': ui.tab === k ? 'page' : null, text: label,
    on: { click: () => { ui.tab = k; render(); } },
  })));
}

function renderSelfCheck() {
  const c = ui.check;
  const rows = c.items.map((it) => [it.label, it.ok ? '✔ 通過' : '✘ 未通過', it.ok ? '' : it.effect]);
  const s = ui.session;
  if (s && s.mode !== 'closed' && s.mode !== 'error') {
    rows.push(['資料夾寫入測試（建立並刪除暫存測試檔）', s.canWrite ? '✔ 通過' : '✘ 未通過', s.canWrite ? '' : `只提供查詢模式：${s.writeError}`]);
  }
  return table(['檢查', '結果', '未通過時'], rows);
}

function renderStart() {
  const p = loadProfile();
  const user = h('input', { type: 'text', value: p.user, size: 16, 'aria-label': '員編／姓名' });
  const pc = h('input', { type: 'text', value: p.pc, size: 12, 'aria-label': '電腦代號' });
  const c = ui.check;
  const box = h('section', { class: 'panel' },
    h('h2', { text: '開始使用' }),
    h('p', { class: 'note', text: '瀏覽器無法讀取Windows登入帳號，請輸入員編／姓名及電腦代號；此名稱供顯示與稽核記錄，非身分驗證。存於本機瀏覽器設定，換人登入同一台電腦須重新輸入。' }),
    h('label', null, '員編／姓名 ', user), ' ',
    h('label', null, '電腦代號 ', pc), ' ',
    btn('儲存使用者', () => { saveProfile({ user: user.value.trim(), pc: pc.value.trim() }); render(); }),
    h('div', { class: 'toolbar' },
      btn('開啟資料夾', () => guard(async () => { const d = await pickFolder(); if (d) await openHandle(d, { allowInit: false }); }), { primary: true, disabled: !c.canFolder }),
      btn('重新授權上次資料夾', () => guard(async () => {
        const d = await lastFolder();
        if (!d) { await alertBox('沒有上次資料夾', '本瀏覽器尚未記住資料夾，請按「開啟資料夾」。'); return; }
        if (!profileOk()) { await alertBox('請先輸入使用者', '請先輸入「員編／姓名」及「電腦代號」並按儲存。'); return; }
        await openHandle(d, { allowInit: false });
      }), { disabled: !c.canFolder || !c.caps.idb }),
      btn('建立新資料夾（選空資料夾）', () => guard(async () => { const d = await pickFolder(); if (d) await openHandle(d, { allowInit: true }); }), { disabled: !c.canFolder }),
    ),
    c.canFolder ? null : h('p', { class: 'warn-text', text: '只能唯讀：' + c.readonlyReasons.join('；') + '。開啟備份zip查詢及匯出將於備份還原階段提供。' }),
  );
  return [box, h('section', { class: 'panel' }, h('h2', { text: '啟動自檢' }), renderSelfCheck())];
}

function renderError() {
  const s = ui.session;
  const errs = s.openErrors || [];
  const versions = (s.lastOpen && s.lastOpen.versions) || [];
  return h('section', { class: 'panel' },
    h('h2', { text: '資料夾無法開啟' }),
    h('p', { class: 'warn-text', text: '程式不自動改用其他版本、不靜默修正。請依下列原因處理，或唯讀開啟某一版本核對。' }),
    table(['原因', '位置'], errs.map((e) => [e.message, e.where || ''])),
    h('h3', { text: 'data/versions/ 版本檔' }),
    table(['revision', '檔名', ''], versions.map((v) => [revLabel(v.revision), v.name, btn('唯讀檢視', () => guard(() => viewVersion(v.name)))])),
  );
}

async function viewVersion(name) {
  const s = ui.session;
  const v = await loadVersion(s.fs, name, { meta: s.meta });
  const hd = v.header || {};
  await alertBox(`版本 ${name}`,
    `驗證：${v.ok ? '通過' : '未通過'}${v.errors.length ? '：' + v.errors.map((e) => e.message).join('；') : ''}`,
    `revision：${hd.revision}，儲存時間：${fmtIso(hd.saved_at)}，操作者：${who(hd.saved_by)}`,
    `程式版本：${hd.app_version}，資料結構版本：${hd.schema_version}，摘要：${hd.summary || ''}`,
    `稽核：${v.audit ? v.audit.length : 0} 筆`);
}

function renderHome() {
  const s = ui.session;
  const c = s.committed.data.collections;
  return h('section', { class: 'panel' },
    h('h2', { text: '首頁' }),
    h('p', { text: `目前版本 ${revLabel(s.current.revision)}，儲存於 ${fmtIso(s.current.saved_at)}，操作者 ${who(s.current.saved_by)}。` }),
    h('p', { class: 'note', text: '業務功能（收案、會議、主檔匯入、認定、公告、合約、查詢、匯出、備份還原、移轉）將於後續階段加入。' }),
    table(['集合', '筆數'], Object.keys(c).map((k) => [k, c[k].length])),
  );
}

let historyCache = null;

function renderHistory() {
  const s = ui.session;
  const box = h('section', { class: 'panel' }, h('h2', { text: '儲存歷程' }),
    btn('檢查全部版本檔', () => guard(async () => { historyCache = await s.history(); })));
  if (historyCache) {
    box.appendChild(table(['revision', '儲存時間', '操作者', '摘要', '雜湊檢查', '狀態', ''], historyCache.slice().reverse().map((r) => [
      revLabel(r.revision),
      fmtIso(r.header && r.header.saved_at),
      who(r.header && r.header.saved_by),
      (r.header && r.header.summary) || '',
      r.ok ? '✔ 一致' : '✘ ' + r.notes.join('；'),
      r.isCurrent ? '目前版本' : r.inChain ? '歷史版本' : '未被引用（儲存中斷殘留或分支）',
      btn('唯讀檢視', () => guard(() => viewVersion(r.name))),
    ])));
  }
  const audit = s.committed.audit.slice(-50).reverse();
  box.appendChild(h('h3', { text: '稽核紀錄（最近50筆）' }));
  box.appendChild(table(['序號', '時間', '操作者', '動作', '原因'], audit.map((e) => [e.seq, fmtIso(e.at), who(e), e.action, e.reason || ''])));
  return box;
}

function renderSettings() {
  const s = ui.session;
  const cur = s.settings;
  const editable = s.mode === 'edit';
  const inputs = {};
  const rows = Object.keys(DEFAULT_SETTINGS).map((k) => {
    const v = cur[k];
    const inp = typeof v === 'boolean'
      ? h('input', { type: 'checkbox', checked: v, disabled: !editable })
      : h('input', { type: 'number', value: String(v), disabled: !editable, style: 'width:6em' });
    inputs[k] = inp;
    return [settingLabel(k), inp, String(DEFAULT_SETTINGS[k])];
  });
  const box = h('section', { class: 'panel' }, h('h2', { text: '設定' }),
    editable ? null : h('p', { class: 'note', text: '查詢模式僅可檢視；修改須先取得編輯牌。' }),
    table(['項目', '值', '預設'], rows));
  if (editable) {
    box.appendChild(btn('套用設定（成為未儲存變更）', () => guard(async () => {
      const patch = {};
      for (const [k, inp] of Object.entries(inputs)) patch[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
      const r = await s.updateSettings(patch);
      if (!r.changed) await alertBox('未變更', '設定值與目前相同。');
    }), { primary: true }));
    box.appendChild(h('h3', { text: '強制收回關鍵詞' }));
    box.appendChild(btn('修改關鍵詞', () => guard(async () => {
      const old = h('input', { type: 'password', autocomplete: 'current-password' });
      const ok = await dialog('修改關鍵詞', [h('label', null, '原關鍵詞 ', old)], [{ label: '取消', value: null }, { label: '下一步', value: true, primary: true }]);
      if (!ok) return;
      const nk = await askNewKeyword('輸入新關鍵詞');
      if (!nk) return;
      await s.changeKeyword(old.value, nk);
      await alertBox('已修改', '關鍵詞已更新；稽核紀錄將於下次存檔寫入。');
    })));
  }
  return box;
}

function renderAbout() {
  const s = ui.session;
  return [
    h('section', { class: 'panel' }, h('h2', { text: '關於' }),
      table(['項目', '內容'], [
        ['程式版本', APP_VERSION], ['資料結構版本', String(SCHEMA_VERSION)], ['建置日期', BUILD_DATE], ['原始碼commit', BUILD_COMMIT],
        ['資料夾id', s.meta ? s.meta.folder_id : ''], ['本分頁工作階段id', s.session.id],
        ['使用者', who(s.session)], ['開啟位置', window.location.protocol + '//' + window.location.host + window.location.pathname],
        ['瀏覽器', navigator.userAgent],
      ]),
      h('p', { class: 'note', text: '編輯牌是程式之間的約定，不是檔案伺服器仲裁的獨占鎖；關鍵詞用來防止誤按與隨意搶牌，不是資安控管（第4.6節第15、16點）。' })),
    h('section', { class: 'panel' }, h('h2', { text: '啟動自檢' }), renderSelfCheck()),
  ];
}

function render() {
  const root = $root();
  clear(root);
  root.appendChild(h('header', { class: 'top' },
    h('h1', { text: '特殊藥品認定、調高及供貨合約管理系統' }),
    h('span', { class: 'ver', text: `v${APP_VERSION}｜資料結構 ${SCHEMA_VERSION}` })));
  root.appendChild(renderStatusBar());
  const s = ui.session;
  if (!s) {
    root.appendChild(h('main', null, renderStart()));
    return;
  }
  root.appendChild(renderToolbar());
  if (s.mode === 'error') {
    root.appendChild(h('main', null, renderError(), h('div', { class: 'toolbar' }, btn('關閉資料夾', () => guard(closeFolder)))));
    return;
  }
  root.appendChild(renderTabs());
  const views = { home: renderHome, history: renderHistory, settings: renderSettings, about: renderAbout };
  root.appendChild(h('main', null, (views[ui.tab] || renderHome)()));
}

function boot() {
  ui.check = selfCheck(window);
  window.addEventListener('beforeunload', (e) => {
    if (ui.session && ui.session.hasUnsaved) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    if (ui.session) ui.session.closing();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ui.session) onPoll();
  });
  render();
}

boot();
