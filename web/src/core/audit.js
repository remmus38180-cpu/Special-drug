// 稽核紀錄：只追加；每筆含前一筆雜湊（第11.4節第5點）。
import { sha256Text, stableStringify } from './util.js';

export const GENESIS_HASH = '0'.repeat(64);

export async function hashEvent(ev) {
  const rest = { ...ev };
  delete rest.hash;
  return sha256Text(stableStringify(rest));
}

// drafts：尚未封存的事件；接在 prev 之後計算 seq、prev_hash、hash
export async function sealEvents(prev, drafts) {
  const out = prev.slice();
  let last = prev.length ? prev[prev.length - 1].hash : GENESIS_HASH;
  for (const d of drafts) {
    const ev = { ...d, seq: out.length + 1, prev_hash: last };
    delete ev.hash;
    ev.hash = await hashEvent(ev);
    last = ev.hash;
    out.push(ev);
  }
  return out;
}

export async function verifyChain(events) {
  if (!Array.isArray(events)) return { ok: false, index: -1, reason: '稽核紀錄格式錯誤' };
  let last = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || ev.seq !== i + 1) {
      return { ok: false, index: i, seq: ev && ev.seq, reason: `第 ${i + 1} 筆序號不連續（記載 ${ev && ev.seq}）` };
    }
    if (ev.prev_hash !== last) {
      return { ok: false, index: i, seq: ev.seq, reason: `第 ${ev.seq} 筆前一筆雜湊不符（中間紀錄可能被刪除或修改）` };
    }
    const h = await hashEvent(ev);
    if (h !== ev.hash) {
      return { ok: false, index: i, seq: ev.seq, reason: `第 ${ev.seq} 筆內容雜湊不符（紀錄可能被修改）` };
    }
    last = ev.hash;
  }
  return { ok: true, count: events.length, head: last };
}

export function auditHead(events) {
  return { count: events.length, hash: events.length ? events[events.length - 1].hash : GENESIS_HASH };
}

// 新版本之稽核必須完整包含前一版本之稽核（只追加）
export function isPrefixOf(oldEvents, newEvents) {
  if (newEvents.length < oldEvents.length) return false;
  for (let i = 0; i < oldEvents.length; i++) {
    if (oldEvents[i].hash !== newEvents[i].hash) return false;
  }
  return true;
}
