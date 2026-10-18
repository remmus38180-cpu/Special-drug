// 編輯牌（第4.6節）：control/editing.json；不刪檔，只改寫內容。
// 注意：這是程式之間的約定，不是檔案伺服器仲裁的獨占鎖（第4.6節第15、16點）。
import { P } from './paths.js';
import { APP_VERSION } from './version.js';
import { isoUtc } from './util.js';

export const TOKEN_FORMAT = 'specdrug-editing';

export class EditToken {
  // settings: {heartbeatMs, staleMs, confirmMs, skewMs}
  constructor({ fs, clock, sleep, session, settings }) {
    this.fs = fs;
    this.clock = clock;
    this.sleep = sleep;
    this.session = session;
    this.settings = { heartbeatMs: 30000, staleMs: 300000, confirmMs: 3000, skewMs: 120000, ...(settings || {}) };
    this.serverOffset = null; // 檔案時間－本機時間，由自己寫入的檔案量得
    this.observe = null;
    this.seq = 0;
  }

  holderInfo() {
    return { user: this.session.user, pc: this.session.pc };
  }

  noteOwnWrite(localMs, fileMs) {
    if (typeof fileMs === 'number' && fileMs > 0) this.serverOffset = fileMs - localMs;
  }

  async read() {
    const r = await this.fs.read(P.TOKEN);
    if (!r) return { token: null, lastModified: null };
    let token = null;
    try { token = JSON.parse(r.text); } catch (e) { token = null; }
    if (token && token.format !== TOKEN_FORMAT) token = null;
    return { token, lastModified: r.lastModified };
  }

  async write(token) {
    const local = this.clock.now();
    await this.fs.write(P.TOKEN, JSON.stringify(token, null, 2) + '\n');
    const back = await this.fs.read(P.TOKEN);
    if (back) this.noteOwnWrite(local, back.lastModified);
  }

  // 判定牌的狀態：free（已歸還／無檔）、mine、held（他人持有且程式仍開著）、
  // stale（他人持有但逾時無心跳，視同已歸還）、checking（時間異常，以序號觀察中）
  assess({ token, lastModified }) {
    if (!token || token.state !== 'held') return { status: 'free', token };
    if (token.session_id === this.session.id) return { status: 'mine', token };
    const now = this.clock.now();
    const { staleMs, skewMs } = this.settings;
    const future = typeof lastModified === 'number' && lastModified - now > skewMs;
    const offsetBad = this.serverOffset !== null && Math.abs(this.serverOffset) > skewMs;
    if (typeof lastModified === 'number' && !future && !offsetBad) {
      this.observe = null;
      const age = now - lastModified;
      return { status: age > staleMs ? 'stale' : 'held', token, lastSeen: lastModified, age };
    }
    // 時間異常：以本機連續觀察心跳序號是否變動判定
    const key = token.session_id + ':' + token.heartbeat_seq;
    if (!this.observe || this.observe.key !== key) {
      this.observe = { key, since: now };
      return { status: 'checking', token, reason: 'clock' };
    }
    const quiet = now - this.observe.since;
    if (quiet > staleMs) return { status: 'stale', token, age: quiet, reason: 'clock' };
    return { status: 'checking', token, reason: 'clock', quietMs: quiet };
  }

  async status() {
    return this.assess(await this.read());
  }

  // 取牌：已歸還／逾時→寫入自己，等confirmMs後重讀；仍是自己才成功
  // closedLocal(session_id)：持牌者為本瀏覽器已關閉之分頁（由 navigator.locks 確認）時回傳 true
  async acquire({ baseRevision, closedLocal }) {
    let a = this.assess(await this.read());
    if (a.status === 'mine') return { ok: true, status: 'mine' };
    if ((a.status === 'held' || a.status === 'checking') && closedLocal && closedLocal(a.token.session_id)) {
      a = { ...a, status: 'stale', reason: 'local_closed' };
    }
    if (a.status === 'held' || a.status === 'checking') return { ok: false, ...a };
    const now = this.clock.now();
    const previous = a.status === 'stale' ? a.token : null;
    const token = {
      format: TOKEN_FORMAT,
      state: 'held',
      holder: this.holderInfo(),
      session_id: this.session.id,
      acquired_at: isoUtc(now),
      heartbeat_seq: 0,
      heartbeat_at: isoUtc(now),
      app_version: APP_VERSION,
      base_revision: baseRevision,
      last_event: previous
        ? { type: a.reason === 'local_closed' ? 'local_closed' : 'expired', at: isoUtc(now), by: this.holderInfo(), prev_holder: previous.holder, prev_session_id: previous.session_id, prev_heartbeat_at: previous.heartbeat_at }
        : ((a.token && a.token.last_event) || null),
    };
    await this.write(token);
    await this.sleep(this.settings.confirmMs);
    const again = await this.read();
    if (!again.token || again.token.state !== 'held' || again.token.session_id !== this.session.id) {
      return { ok: false, status: 'race', token: again.token };
    }
    this.seq = 0;
    return { ok: true, status: previous ? (a.reason === 'local_closed' ? 'took_local' : 'took_stale') : 'acquired', previous };
  }

  // 心跳：牌不是自己的→lost；寫入失敗擲錯（呼叫端應停止存檔，狀態不明）
  async heartbeat() {
    const r = await this.read();
    if (!r.token || r.token.state !== 'held' || r.token.session_id !== this.session.id) {
      return { status: 'lost', token: r.token };
    }
    this.seq = (r.token.heartbeat_seq || 0) + 1;
    await this.write({ ...r.token, heartbeat_seq: this.seq, heartbeat_at: isoUtc(this.clock.now()) });
    return { status: 'ok', seq: this.seq };
  }

  async release() {
    const r = await this.read();
    if (!r.token || r.token.state !== 'held' || r.token.session_id !== this.session.id) return false;
    const now = this.clock.now();
    await this.write({
      ...r.token,
      state: 'released',
      released_at: isoUtc(now),
      last_event: { type: 'released', at: isoUtc(now), by: this.holderInfo() },
    });
    return true;
  }

  // 強制收回：關鍵詞由呼叫端驗證後才呼叫
  async forceTakeover({ reason, baseRevision }) {
    const before = await this.read();
    const prev = before.token && before.token.state === 'held' ? before.token : null;
    const now = this.clock.now();
    const token = {
      format: TOKEN_FORMAT,
      state: 'held',
      holder: this.holderInfo(),
      session_id: this.session.id,
      acquired_at: isoUtc(now),
      heartbeat_seq: 0,
      heartbeat_at: isoUtc(now),
      app_version: APP_VERSION,
      base_revision: baseRevision,
      last_event: {
        type: 'forced', at: isoUtc(now), by: this.holderInfo(), reason,
        prev_holder: prev ? prev.holder : null, prev_session_id: prev ? prev.session_id : null,
        prev_acquired_at: prev ? prev.acquired_at : null,
      },
    };
    await this.write(token);
    await this.sleep(this.settings.confirmMs);
    const again = await this.read();
    if (!again.token || again.token.session_id !== this.session.id) {
      return { ok: false, status: 'race', token: again.token };
    }
    this.seq = 0;
    return { ok: true, status: 'forced', previous: prev, token };
  }
}
