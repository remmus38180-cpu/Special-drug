// 工作階段：查詢／編輯模式、編輯牌、儲存、復原草稿（第4.5、4.6節）。不碰DOM。
import { SpecError, errText } from './errors.js';
import { openFolder, initFolder, readCurrent, saveVersion, writeTest, verifyHistory, loadVersion } from './folder.js';
import { EditToken } from './token.js';
import { KeywordGuard, verifyKeyword, changeKeyword, writeKeyword, readKeywordRecord } from './keyword.js';
import { effectiveSettings, validateSettingsPatch } from './dataset.js';
import { deepClone, newId, isoUtc } from './util.js';
import { APP_VERSION } from './version.js';

const CONTROL_ENTITIES = new Set(['editing_token', 'keyword']);

export function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export class AppSession {
  // profile：{user, pc}；caps：selfCheck()結果；draftStore：{get,put,delete}；locks：{tryHold(name)}
  // localSessions：本瀏覽器曾持牌之工作階段id紀錄 {has(id), add(id)}（與 locks 併用）
  constructor({ fs, clock, sleep, profile, sessionId, draftStore, locks, caps, keywordIterations, tokenOverrides, localSessions }) {
    this.fs = fs;
    this.clock = clock || { now: () => Date.now() };
    this.sleep = sleep || defaultSleep;
    this.session = { id: sessionId || newId(), user: (profile && profile.user) || '', pc: (profile && profile.pc) || '' };
    this.draftStore = draftStore || null;
    this.locks = locks || null;
    this.caps = caps || { canEdit: true, readonlyReasons: [] };
    this.keywordIterations = keywordIterations;
    this.tokenOverrides = tokenOverrides || {};
    this.localSessions = localSessions || null;
    this.mode = 'closed';
    this.listeners = new Set();
    this._resetWork();
  }

  _resetWork() {
    this.dirty = 0;
    this.pending = [];
    this.refs = [];
    this.saveAttempt = null;
    this.tokenUncertain = false;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try { fn(this); } catch (e) { /* 介面錯誤不影響資料 */ }
    }
  }

  async create(keyword) {
    await initFolder(this.fs, { clock: this.clock, session: this.session, keyword, keywordIterations: this.keywordIterations });
    return this.open();
  }

  async open() {
    const res = await openFolder(this.fs);
    this.lastOpen = res;
    if (!res.ok) {
      this.mode = 'error';
      this.meta = res.meta;
      this.openErrors = res.errors;
      this.emit();
      return res;
    }
    this._load(res);
    const wt = await writeTest(this.fs, this.clock);
    this.canWrite = wt.ok;
    this.writeError = wt.ok ? null : errText(wt.error);
    this.token = new EditToken({ fs: this.fs, clock: this.clock, sleep: this.sleep, session: this.session, settings: this._tokenSettings() });
    if (wt.ok) this.token.noteOwnWrite(wt.localAt, wt.lastModified);
    const s = effectiveSettings(this.committed.data);
    this.guard = new KeywordGuard({ clock: this.clock, maxFail: s.keyword_max_fail, lockMs: s.keyword_lock_sec * 1000 });
    this.mode = 'query';
    this.newerAvailable = false;
    this.lostInfo = null;
    await this.refreshTokenStatus();
    this.emit();
    return res;
  }

  _load(res) {
    this.meta = res.meta;
    this.current = res.current;
    this.header = res.header;
    this.readonly = res.readonly || [];
    this.committed = { data: res.data, audit: res.audit };
    this.work = deepClone(res.data);
    this._resetWork();
  }

  _tokenSettings() {
    const s = effectiveSettings(this.committed.data);
    return { heartbeatMs: s.heartbeat_sec * 1000, staleMs: s.stale_min * 60000, ...this.tokenOverrides };
  }

  get settings() {
    return effectiveSettings(this.work || (this.committed && this.committed.data));
  }

  get unsavedCount() {
    return this.dirty;
  }

  get hasUnsaved() {
    return this.dirty > 0 || this.pending.length > 0;
  }

  editBlockers() {
    const r = [];
    if (this.caps && this.caps.canEdit === false) r.push(...(this.caps.readonlyReasons || ['瀏覽器能力不足']));
    if (this.readonly && this.readonly.length) r.push(...this.readonly);
    if (!this.canWrite) r.push(`資料夾無寫入權（${this.writeError || '寫入測試失敗'}），只提供查詢模式`);
    return r;
  }

  async refreshTokenStatus() {
    if (!this.token) return null;
    try {
      this.tokenStatus = await this.token.status();
    } catch (e) {
      this.tokenStatus = { status: 'unknown', error: errText(e) };
    }
    return this.tokenStatus;
  }

  _event(entity, action, diff, reason, entityId, opId) {
    return {
      id: newId(), at: isoUtc(this.clock.now()), user: this.session.user, pc: this.session.pc,
      app_version: APP_VERSION, entity, entity_id: entityId || null, action, diff: diff === undefined ? null : diff,
      reason: reason || null, op_id: opId || null,
    };
  }

  async _tabLock() {
    if (this._tabRelease) return true;
    if (!this.locks) return true;
    const rel = await this.locks.tryHold('specdrug-edit-' + this.meta.folder_id);
    if (!rel) return false;
    this._tabRelease = rel;
    return true;
  }

  _rememberLocal() {
    if (this.localSessions) {
      try { this.localSessions.add(this.session.id); } catch (e) { /* 忽略 */ }
    }
  }

  _tabUnlock() {
    if (this._tabRelease) {
      try { this._tabRelease(); } catch (e) { /* 忽略 */ }
      this._tabRelease = null;
    }
  }

  _toQuery() {
    this.mode = 'query';
    this._tabUnlock();
  }

  async _viewIsCurrent() {
    const cur = await readCurrent(this.fs);
    return { same: cur.revision === this.current.revision && cur.sha256 === this.current.sha256, current: cur };
  }

  async startEdit() {
    if (this.mode === 'edit') return { ok: true, status: 'mine' };
    if (this.mode !== 'query') return { ok: false, status: 'closed' };
    const blockers = this.editBlockers();
    if (blockers.length) return { ok: false, status: 'blocked', reasons: blockers };
    const v = await this._viewIsCurrent();
    if (!v.same) {
      this.newerAvailable = true;
      this.emit();
      return { ok: false, status: 'stale_view', current: v.current };
    }
    if (!(await this._tabLock())) return { ok: false, status: 'tab_locked' };
    // 已取得本瀏覽器之分頁鎖：若牌記載為本瀏覽器其他分頁，該分頁必已關閉（不在編輯中）
    const closedLocal = this.locks && this.localSessions
      ? (id) => id !== this.session.id && this.localSessions.has(id)
      : null;
    let r;
    try {
      r = await this.token.acquire({ baseRevision: this.current.revision, closedLocal });
    } catch (e) {
      this._tabUnlock();
      return { ok: false, status: 'error', error: errText(e) };
    }
    if (!r.ok) {
      this._tabUnlock();
      this.tokenStatus = r;
      this.emit();
      return r;
    }
    this.mode = 'edit';
    this.tokenUncertain = false;
    this.lostInfo = null;
    this._rememberLocal();
    if (r.previous) {
      this.pending.push(this._event('editing_token', r.status === 'took_local' ? '取得編輯牌（本瀏覽器前一分頁已關閉）' : '逾時取得編輯牌',
        { prev_holder: r.previous.holder, prev_session_id: r.previous.session_id, prev_heartbeat_at: r.previous.heartbeat_at }));
    }
    await this.refreshTokenStatus();
    this.emit();
    return r;
  }

  async heartbeatTick() {
    if (this.mode !== 'edit') return { status: 'idle' };
    let r;
    try {
      r = await this.token.heartbeat();
    } catch (e) {
      this.tokenUncertain = true;
      this.emit();
      return { status: 'uncertain', error: errText(e) };
    }
    if (r.status === 'lost') {
      await this._persistDraft(true);
      this._toQuery();
      this.lostInfo = { token: r.token };
      this.tokenStatus = this.token.assess({ token: r.token, lastModified: this.clock.now() });
      this.emit();
      return { status: 'lost', token: r.token };
    }
    this.tokenUncertain = false;
    this.emit();
    return { status: 'ok' };
  }

  // 修改工作副本：mutator(副本) 直接修改副本；event：{entity, action, diff, reason, entity_id, op_id}
  async change(mutator, event) {
    if (this.mode !== 'edit') throw new SpecError('NOT_EDITING', '目前為查詢模式，請先取得編輯牌');
    const next = deepClone(this.work);
    mutator(next);
    this.work = next;
    if (event) this.pending.push(this._event(event.entity, event.action, event.diff, event.reason, event.entity_id, event.op_id));
    this.dirty += 1;
    await this._persistDraft();
    this.emit();
  }

  async updateSettings(patch, reason) {
    const { next, diff } = validateSettingsPatch(this.work.settings, patch);
    if (!Object.keys(diff).length) return { changed: false };
    await this.change((d) => { d.settings = next; }, { entity: 'settings', action: '修改設定', diff, reason });
    return { changed: true, diff };
  }

  async save() {
    if (this.mode !== 'edit') throw new SpecError('NOT_EDITING', '目前為查詢模式，無法儲存');
    if (this.tokenUncertain) throw new SpecError('TOKEN_UNCERTAIN', '編輯牌狀態不明（心跳寫入失敗），暫停存檔；恢復連線後將自動重新確認');
    if (!this.hasUnsaved) return { status: 'nothing' };
    // 同一 save_id 保留到確定成功；上次送出內容（結果不明）記於 prevSent
    if (!this.saveAttempt) this.saveAttempt = { saveId: newId(), sent: null };
    const attempt = this.saveAttempt;
    const prevSent = attempt.sent;
    attempt.sent = { pendingCount: this.pending.length, dirty: this.dirty };
    const summary = summarize(this.pending, this.dirty);
    let res;
    try {
      res = await saveVersion(this.fs, {
        clock: this.clock, session: this.session, meta: this.meta, base: this.current,
        data: this.work, auditBase: this.committed.audit, auditDrafts: this.pending,
        saveId: attempt.saveId, refs: this.refs, summary,
      });
    } catch (e) {
      await this._persistDraft(true);
      if (e && e.code === 'TOKEN_LOST') {
        this._toQuery();
        this.lostInfo = { token: e.detail && e.detail.token };
      }
      if (e && e.code === 'CONFLICT') this.newerAvailable = true;
      this.emit();
      throw e;
    }
    if (res.status === 'already') {
      // 先前一次儲存已完成（畫面未得結果）：以資料夾目前版本為基準，保留其後之變更
      const v = await loadVersion(this.fs, res.current.file, { meta: this.meta, expect: res.current });
      if (!v.ok) throw new SpecError('VERSION_BAD', '已完成之版本檔驗證失敗：' + v.errors.map((x) => x.message).join('；'));
      this.current = res.current;
      this.header = v.header;
      this.committed = { data: v.data, audit: v.audit };
      const done = prevSent || attempt.sent;
      this.pending = this.pending.slice(done.pendingCount);
      this.dirty = Math.max(0, this.dirty - done.dirty);
      this.saveAttempt = null;
      if (!this.hasUnsaved) {
        this.work = deepClone(v.data);
        await this._deleteDraft();
      } else {
        await this._persistDraft(true);
      }
      this.emit();
      return { status: 'already', current: res.current, name: res.name };
    }
    this.current = res.current;
    this.header = res.header;
    this.committed = { data: deepClone(this.work), audit: res.audit };
    this.dirty = 0;
    this.pending = [];
    this.refs = [];
    this.saveAttempt = null;
    await this._deleteDraft();
    this.emit();
    return res;
  }

  // choice：'save'｜'draft'｜'discard'
  async endEdit(choice) {
    if (this.mode !== 'edit') return { ok: true, status: 'not_editing' };
    const dataDirty = this.dirty > 0;
    if (dataDirty) {
      if (!choice) return { ok: false, status: 'need_choice' };
      if (choice === 'save') {
        await this.save();
      } else if (choice === 'draft') {
        await this._persistDraft(true);
      } else if (choice === 'discard') {
        this.work = deepClone(this.committed.data);
        this.dirty = 0;
        this.refs = [];
        this.pending = this.pending.filter((e) => CONTROL_ENTITIES.has(e.entity));
        this.saveAttempt = null;
        await this._deleteDraft();
      } else {
        throw new SpecError('BAD_CHOICE', '未知的選項');
      }
    }
    // 只剩編輯牌／關鍵詞稽核時，自動寫入（第4.6節第9點：收回紀錄寫入稽核）
    if (!this.dirty && this.pending.length) {
      await this.save();
    }
    let releaseError = null;
    try {
      await this.token.release();
    } catch (e) {
      releaseError = errText(e);
    }
    this._toQuery();
    await this.refreshTokenStatus();
    this.emit();
    return { ok: true, status: 'released', releaseError, keptDraft: choice === 'draft' };
  }

  async forceTakeover(keyword, reason) {
    if (this.mode === 'edit') return { ok: true, status: 'mine' };
    if (this.mode !== 'query') return { ok: false, status: 'closed' };
    const blockers = this.editBlockers();
    if (blockers.length) return { ok: false, status: 'blocked', reasons: blockers };
    const st = this.guard.status();
    if (st.locked) return { ok: false, status: 'locked', remainMs: st.remainMs };
    if (!reason || !String(reason).trim()) return { ok: false, status: 'need_reason' };
    let ok;
    try {
      ok = await verifyKeyword(this.fs, keyword);
    } catch (e) {
      if (e.code === 'KEYWORD_MISSING') return { ok: false, status: 'no_keyword', message: e.message };
      throw e;
    }
    const after = this.guard.record(ok);
    if (!ok) return { ok: false, status: after.locked ? 'locked' : 'wrong', ...after };
    const v = await this._viewIsCurrent();
    if (!v.same) {
      this.newerAvailable = true;
      this.emit();
      return { ok: false, status: 'stale_view', current: v.current };
    }
    if (!(await this._tabLock())) return { ok: false, status: 'tab_locked' };
    const r = await this.token.forceTakeover({ reason: String(reason).trim(), baseRevision: this.current.revision });
    if (!r.ok) {
      this._tabUnlock();
      this.emit();
      return r;
    }
    this.mode = 'edit';
    this.tokenUncertain = false;
    this.lostInfo = null;
    this._rememberLocal();
    const p = r.previous;
    this.pending.push(this._event('editing_token', '強制收回編輯牌', {
      prev_holder: p ? p.holder : null, prev_session_id: p ? p.session_id : null, prev_acquired_at: p ? p.acquired_at : null,
    }, String(reason).trim()));
    await this.refreshTokenStatus();
    this.emit();
    return r;
  }

  async changeKeyword(oldKeyword, newKeyword) {
    if (this.mode !== 'edit') throw new SpecError('NOT_EDITING', '修改關鍵詞須先取得編輯牌');
    await changeKeyword(this.fs, oldKeyword, newKeyword, { now: this.clock.now(), by: { user: this.session.user, pc: this.session.pc }, iterations: this.keywordIterations });
    this.pending.push(this._event('keyword', '修改關鍵詞', null, null));
    await this._persistDraft(true);
    this.emit();
  }

  async keywordMissing() {
    return !(await readKeywordRecord(this.fs));
  }

  // Q16（暫採）：keyword.json 被刪除後，持牌者重新設定，記錄稽核
  async resetMissingKeyword(newKeyword) {
    if (this.mode !== 'edit') throw new SpecError('NOT_EDITING', '設定關鍵詞須先取得編輯牌');
    if (!(await this.keywordMissing())) throw new SpecError('KEYWORD_EXISTS', '關鍵詞已存在；修改須輸入原關鍵詞');
    await writeKeyword(this.fs, newKeyword, { now: this.clock.now(), by: { user: this.session.user, pc: this.session.pc }, iterations: this.keywordIterations });
    this.pending.push(this._event('keyword', '重新設定關鍵詞（原關鍵詞檔不存在）', null, null));
    await this._persistDraft(true);
    this.emit();
  }

  async checkForUpdate() {
    if (this.mode !== 'query' && this.mode !== 'edit') return { newer: false };
    const v = await this._viewIsCurrent();
    this.newerAvailable = !v.same;
    await this.refreshTokenStatus();
    this.emit();
    return { newer: !v.same, current: v.current };
  }

  async reload() {
    if (this.mode === 'edit' && this.hasUnsaved) {
      throw new SpecError('UNSAVED', '有未儲存變更，請先儲存或結束編輯');
    }
    const wasEdit = this.mode === 'edit';
    const res = await openFolder(this.fs);
    if (!res.ok) {
      this.mode = wasEdit ? this.mode : 'error';
      this.openErrors = res.errors;
      this.emit();
      return res;
    }
    this._load(res);
    this.newerAvailable = false;
    if (wasEdit) this.token.settings = { ...this.token.settings, ...this._tokenSettings() };
    await this.refreshTokenStatus();
    this.emit();
    return res;
  }

  async history() {
    return verifyHistory(this.fs);
  }

  // ---------- 復原草稿（IndexedDB）----------
  draftKey() {
    return 'draft:' + this.meta.folder_id;
  }

  async _persistDraft(force) {
    if (!this.draftStore || !this.meta) return;
    if (!force && !this.hasUnsaved) return;
    if (!this.hasUnsaved) return;
    try {
      await this.draftStore.put(this.draftKey(), {
        format: 'specdrug-draft', folder_id: this.meta.folder_id,
        base_revision: this.current.revision, base_sha256: this.current.sha256,
        saved_at: isoUtc(this.clock.now()), user: this.session.user, pc: this.session.pc,
        session_id: this.session.id, app_version: APP_VERSION,
        dirty: this.dirty, pending: this.pending, refs: this.refs, data: this.work,
      });
      this.draftError = null;
    } catch (e) {
      this.draftError = errText(e);
    }
  }

  async _deleteDraft() {
    if (!this.draftStore || !this.meta) return;
    try { await this.draftStore.delete(this.draftKey()); } catch (e) { this.draftError = errText(e); }
  }

  async recoveryCheck() {
    if (!this.draftStore || !this.meta) return { kind: 'none' };
    let d = null;
    try { d = await this.draftStore.get(this.draftKey()); } catch (e) { return { kind: 'error', error: errText(e) }; }
    if (!d) return { kind: 'none' };
    // 以資料夾目前版本比對（非本分頁開啟時之版本）
    let cur = this.current;
    try { cur = await readCurrent(this.fs); } catch (e) { /* 讀不到時以開啟時版本比對 */ }
    const same = d.base_revision === cur.revision && d.base_sha256 === cur.sha256 &&
      cur.revision === this.current.revision && cur.sha256 === this.current.sha256;
    return { kind: same ? 'same_base' : 'diff_base', draft: d };
  }

  // 只在基準revision相同時套用；須先取得編輯牌
  async applyDraft() {
    if (this.mode !== 'edit') throw new SpecError('NOT_EDITING', '復原草稿須先取得編輯牌');
    const rc = await this.recoveryCheck();
    if (rc.kind !== 'same_base') throw new SpecError('DRAFT_BASE', '復原草稿之基準版本與目前版本不同，不自動套用；請另存為復原檔核對');
    const d = rc.draft;
    this.work = d.data;
    this.pending = (d.pending || []).concat(this.pending.filter((e) => CONTROL_ENTITIES.has(e.entity)));
    this.dirty = d.dirty || 1;
    this.refs = d.refs || [];
    await this._persistDraft(true);
    this.emit();
    return { applied: true };
  }

  async discardDraft() {
    await this._deleteDraft();
  }

  // 關閉分頁：盡力還牌（瀏覽器不保證完成，另以心跳逾時判定）
  async closing() {
    if (this.mode !== 'edit') return;
    await this._persistDraft();
    try { await this.token.release(); } catch (e) { /* 不保證 */ }
    this._tabUnlock();
  }

  statusInfo() {
    return {
      mode: this.mode,
      folderId: this.meta && this.meta.folder_id,
      revision: this.current && this.current.revision,
      savedAt: this.current && this.current.saved_at,
      savedBy: this.current && this.current.saved_by,
      unsaved: this.dirty,
      pendingAudit: this.pending.length,
      newerAvailable: !!this.newerAvailable,
      token: this.tokenStatus,
      tokenUncertain: this.tokenUncertain,
      lostInfo: this.lostInfo,
    };
  }
}

function summarize(pending, dirty) {
  const names = [...new Set(pending.map((e) => e.action))];
  const s = names.slice(0, 5).join('、') + (names.length > 5 ? `等${names.length}類` : '');
  return s || (dirty ? `${dirty}項變更` : '');
}
