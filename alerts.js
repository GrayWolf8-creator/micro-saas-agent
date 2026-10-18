// alerts.js — paid green-dot webhook alerts. Signal only, no trading.
// Persistence: Upstash Redis REST if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set; else in-memory
// (subscriptions are lost on Render restart/redeploy).
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';

export const ALERT_PLAN = { priceUsd: '0.50', amount: '500000', days: 30, maxAlerts: 300 };
const KEY = 'gw8:alert_subs';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TEST_ALLOW_LOCAL = process.env.NODE_ENV !== 'production' && process.env.ALERTS_TEST_ALLOW_LOCAL === '1';
const MAX_SUBS = 1000;
let subs = null; // id -> sub

async function redis(cmd) {
    const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('redis ' + r.status);
    return (await r.json()).result;
}
async function load() {
    if (subs) return subs;
    subs = {};
    if (REDIS_URL && REDIS_TOKEN) {
        try { const raw = await redis(['GET', KEY]); if (raw) subs = JSON.parse(raw); } catch (e) { console.error('[alerts] load failed', e.message); }
    }
    return subs;
}
async function save() {
    if (!(REDIS_URL && REDIS_TOKEN)) return;
    try { await redis(['SET', KEY, JSON.stringify(subs)]); } catch (e) { console.error('[alerts] save failed', e.message); }
}
export const persistenceMode = () => (REDIS_URL && REDIS_TOKEN ? 'upstash-redis' : 'memory (lost on restart)');

// ---------- SSRF protection ----------
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivateIp(x.slice(7));
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}
export async function checkWebhookUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return { ok: false, reason: 'webhookUrl is not a valid URL' }; }
    if (String(raw).length > 500) return { ok: false, reason: 'webhookUrl too long' };
    if (u.username || u.password) return { ok: false, reason: 'credentials in URL not allowed' };
    const local = TEST_ALLOW_LOCAL && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
    if (local) return { ok: true, url: u, ips: ['127.0.0.1'] };
    if (u.protocol !== 'https:') return { ok: false, reason: 'webhookUrl must be https' };
    if (u.port && u.port !== '443') return { ok: false, reason: 'only port 443 allowed' };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (/^localhost$|\.local$|\.internal$/i.test(host)) return { ok: false, reason: 'private host not allowed' };
    let ips;
    try { ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true })).map(a => a.address); }
    catch { return { ok: false, reason: 'webhookUrl host does not resolve' }; }
    if (!ips.length || ips.some(isPrivateIp)) return { ok: false, reason: 'webhookUrl resolves to a private/reserved address' };
    return { ok: true, url: u, ips };
}

// ---------- subscribe ----------
const FILTERS = ['outer', 'inner', 'all'];
export async function validateSubscribe(body, coins) {
    const b = body || {};
    const filter = b.filter ?? 'outer';
    if (!FILTERS.includes(filter)) return { error: 'filter must be outer | inner | all' };
    let pairs = null;
    if (b.pairs != null) {
        if (!Array.isArray(b.pairs) || b.pairs.length > 66) return { error: 'pairs must be an array of coin symbols' };
        pairs = [...new Set(b.pairs.map(p => String(p).toUpperCase().replace(/\/USD$/, '')))];
        const bad = pairs.filter(p => !coins.includes(p));
        if (bad.length) return { error: `unknown pairs: ${bad.join(',')}` };
    }
    const chk = await checkWebhookUrl(b.webhookUrl);
    if (!chk.ok) return { error: chk.reason };
    const all = await load();
    if (Object.keys(all).length >= MAX_SUBS) return { error: 'subscription capacity reached, try later' };
    return { ok: true, webhookUrl: chk.url.toString(), filter, pairs };
}
export async function createSubscription(v, payer) {
    const all = await load();
    const id = 'sub_' + crypto.randomBytes(12).toString('hex');
    const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    all[id] = { id, secret, webhookUrl: v.webhookUrl, filter: v.filter, pairs: v.pairs, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ALERT_PLAN.days * 86400e3).toISOString(), alertsLeft: ALERT_PLAN.maxAlerts, payer: payer || null, failures: 0 };
    await save();
    return { subscriptionId: id, secret, webhookUrl: v.webhookUrl, filter: v.filter, pairs: v.pairs || 'all 66',
        expiresAt: all[id].expiresAt, alertsLeft: ALERT_PLAN.maxAlerts,
        verify: 'Each POST carries X-GW8-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>. Store the secret; it is shown only once.',
        disclaimer: 'signal only, not financial advice' };
}
export async function getStatus(id) {
    const s = (await load())[id];
    if (!s) return null;
    return { subscriptionId: s.id, filter: s.filter, pairs: s.pairs || 'all 66', expiresAt: s.expiresAt, alertsLeft: s.alertsLeft, active: isActive(s) };
}
const isActive = s => s.alertsLeft > 0 && Date.parse(s.expiresAt) > Date.now() && s.failures < 20;

// ---------- dispatch ----------
const seen = new Set(); let seeded = false;
const dotKey = d => `${d.name}|${d.bar}|${d.kind}`;
export function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
    return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
async function post(s, payload) {
    const chk = await checkWebhookUrl(s.webhookUrl); // re-check at send time (DNS rebinding)
    if (!chk.ok) return false;
    const body = JSON.stringify(payload);
    try {
        const r = await fetch(s.webhookUrl, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'GW8-Alerts/1.0', 'X-GW8-Subscription': s.id, 'X-GW8-Signature': sign(s.secret, body) }, body });
        return r.status >= 200 && r.status < 300;
    } catch { return false; }
}
// Called with the fresh WaveTrend snapshot after each refresh.
export async function onRefresh(wt) {
    const greens = (wt.bandDots || []).filter(d => d.kind === 'green');
    const fresh = greens.filter(d => !seen.has(dotKey(d)));
    fresh.forEach(d => seen.add(dotKey(d)));
    if (!seeded) { seeded = true; return { seeded: true, count: fresh.length }; } // don't alert history on boot
    if (!fresh.length) return { sent: 0 };
    const all = await load(); let sent = 0, changed = false;
    for (const s of Object.values(all)) {
        if (!isActive(s)) continue;
        const dots = fresh.filter(d => (s.filter === 'all' || d.band === s.filter) && (!s.pairs || s.pairs.includes(d.name)));
        if (!dots.length) continue;
        const ok = await post(s, { type: 'green_band_dot', subscriptionId: s.id, asOf: wt.asOf,
            dots: dots.map(d => ({ pair: d.name + '/USD', band: d.band, bar: d.bar, wt1: d.wt1, close: d.close })),
            settings: 'LazyBear WaveTrend 10/21/4, Kraken 4h', disclaimer: 'signal only, not financial advice' });
        if (ok) { s.alertsLeft -= 1; s.failures = 0; sent++; } else s.failures += 1;
        changed = true;
    }
    if (changed) await save();
    return { sent, newDots: fresh.length };
}
export function _resetForTest() { seen.clear(); seeded = false; }
