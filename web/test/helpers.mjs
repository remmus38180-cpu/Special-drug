import { MemStore, MemDraftStore, MemLocks } from '../src/adapters/memfs.js';
import { AppSession } from '../src/core/session.js';

export function fakeClock(start = Date.UTC(2026, 9, 18, 2, 0, 0)) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

// 一個共用槽、多台電腦；每台電腦可有自己的時鐘偏差、離線開關、唯讀權限
export function world({ serverSkewMs = 0 } = {}) {
  const clock = fakeClock();
  const store = new MemStore({ serverNow: () => clock.now() + serverSkewMs });
  const sleep = async (ms) => { clock.advance(ms); };
  function computer(name, { readonly = false, skewMs = 0, failWrite = null, draftStore, locks } = {}) {
    const net = { offline: false };
    const fs = store.client({ name, offline: () => net.offline, readonly, failWrite: (p, op) => (failWrite ? failWrite(p, op) : null) });
    const pcClock = { now: () => clock.now() + skewMs };
    const s = new AppSession({
      fs, clock: pcClock, sleep, profile: { user: name, pc: 'PC-' + name },
      draftStore: draftStore || new MemDraftStore(), locks: locks || new MemLocks(), keywordIterations: 1000,
    });
    s.net = net;
    return s;
  }
  return { clock, store, sleep, computer };
}

export async function initWith(w, name = 'A', keyword = 'open-sesame') {
  const a = w.computer(name);
  await a.create(keyword);
  return a;
}
