// pass.js — $1 day pass: one payment, 24h of paid calls (fair-use capped). Signal only.
// Tokens are random (crypto.randomBytes); only a SHA-256 hash of the token is stored, and logs show the last 4 chars only.
import crypto from 'crypto';
import { redis, hasRedis } from './alerts.js';

export const PASS_PLAN = { priceUsd: '1.00', amount: '1000000', hours: 24, dailyCap: 2000, perMinute: 60 };
const TTL = PASS_PLAN.hours * 3600;
const mem = new Map(); // hash -> { exp, used, min: {m, n} }
const h = t => crypto.createHash('sha256').update(String(t)).digest('hex');
export const tail = t => '…' + String(t || '').slice(-4);
const TOKEN_RX = /^gw8p_[A-Za-z0-9_-]{32}$/;

export async function mintPass() {
  const token = 'gw8p_' + crypto.randomBytes(24).toString('base64url');
  const exp = Date.now() + TTL * 1000, k = h(token);
  let store = 'memory';
  if (hasRedis()) {
    try { await redis(['SET', `gw8:pass:${k}`, JSON.stringify({ exp }), 'EX', TTL]); store = 'upstash-redis'; }
    catch (e) { console.error('[pass] redis mint failed, using memory', e.message); }
  }
  if (store === 'memory') mem.set(k, { exp, used: 0, min: { m: 0, n: 0 } });
  console.log('[pass] minted', tail(token), store);
  return { pass: token, expiresAt: new Date(exp).toISOString(), header: 'X-GW8-Pass', mcpArg: 'pass',
    terms: { hours: PASS_PLAN.hours, dailyCap: PASS_PLAN.dailyCap, perMinute: PASS_PLAN.perMinute, excludes: ['/api/alerts/subscribe', '/api/pass/day'] },
    note: 'Store this token now; it is shown once and cannot be recovered. Anyone holding it can use it until it expires.' + (store === 'memory' ? ' Stored in memory only: a server restart ends the pass early.' : '') };
}

// Returns { ok:true, remaining, expiresAt } or { ok:false, status, reason }. Counts one call when ok.
export async function usePass(token) {
  if (!TOKEN_RX.test(String(token || ''))) return { ok: false, status: 401, reason: 'invalid pass' };
  const k = h(token), minute = Math.floor(Date.now() / 60000);
  const m = mem.get(k);
  if (m) {
    if (Date.now() >= m.exp) { mem.delete(k); return { ok: false, status: 401, reason: 'pass expired' }; }
    if (m.min.m !== minute) m.min = { m: minute, n: 0 };
    if (m.min.n >= PASS_PLAN.perMinute) return { ok: false, status: 429, reason: `rate limit ${PASS_PLAN.perMinute}/min` };
    if (m.used >= PASS_PLAN.dailyCap) return { ok: false, status: 429, reason: `fair-use cap ${PASS_PLAN.dailyCap} calls reached` };
    m.min.n++; m.used++;
    return { ok: true, remaining: PASS_PLAN.dailyCap - m.used, expiresAt: new Date(m.exp).toISOString(), _k: k };
  }
  if (!hasRedis()) return { ok: false, status: 401, reason: 'invalid or expired pass' };
  try {
    const raw = await redis(['GET', `gw8:pass:${k}`]); if (!raw) return { ok: false, status: 401, reason: 'invalid or expired pass' };
    const { exp } = JSON.parse(raw); if (Date.now() >= exp) return { ok: false, status: 401, reason: 'pass expired' };
    const mk = `gw8:passmin:${k}:${minute}`, n = await redis(['INCR', mk]); if (n === 1) await redis(['EXPIRE', mk, 70]);
    if (n > PASS_PLAN.perMinute) return { ok: false, status: 429, reason: `rate limit ${PASS_PLAN.perMinute}/min` };
    const uk = `gw8:passuse:${k}`, used = await redis(['INCR', uk]); if (used === 1) await redis(['EXPIRE', uk, TTL + 60]);
    if (used > PASS_PLAN.dailyCap) return { ok: false, status: 429, reason: `fair-use cap ${PASS_PLAN.dailyCap} calls reached` };
    return { ok: true, remaining: PASS_PLAN.dailyCap - used, expiresAt: new Date(exp).toISOString(), _k: k };
  } catch (e) { console.error('[pass] check failed', tail(token), e.message); return { ok: false, status: 503, reason: 'pass check unavailable, retry shortly' }; }
}
// Give the call back when the data source failed (so a failed call never uses up the cap).
export async function refundPass(r) {
  if (!r || !r.ok || !r._k) return;
  const m = mem.get(r._k); if (m) { m.used = Math.max(0, m.used - 1); return; }
  if (hasRedis()) { try { await redis(['DECR', `gw8:passuse:${r._k}`]); } catch (e) {} }
}
// Used when x402 settlement fails after minting (the buyer was not charged, so the pass must not work).
export async function revokePass(token) {
  if (!token) return;
  const k = h(token); mem.delete(k);
  if (hasRedis()) { try { await redis(['DEL', `gw8:pass:${k}`]); } catch (e) { console.error('[pass] revoke failed', tail(token), e.message); } }
  console.log('[pass] revoked', tail(token));
}
// Test hook only (never exposed over HTTP).
export function _expireForTest(token) { const m = mem.get(h(token)); if (m) m.exp = Date.now() - 1; }
