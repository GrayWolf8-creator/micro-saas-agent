// weekly.js — paid weekly brief by HMAC-signed webhook. Signal only, no trading.
// One x402 payment buys N weekly issues. Delivered Mondays ~07:00 America/Denver.
// Reuses the alerts webhook machinery (SSRF checks, HMAC signing, Upstash persistence).
import crypto from 'crypto';
import { checkWebhookUrl, sign, redis, hasRedis } from './alerts.js';
import { getBrief } from './upgrades.js';
import { getTrack } from './track.js';
import { getRwa } from './rwa.js';
import { getGovContracts } from './gov.js';

export const SEND_HOUR_MT = 7;
// Separate URL per plan so each x402 challenge / Bazaar listing has one fixed price.
export const WEEKLY_PLANS = {
    '4w': { id: '4w', path: '/api/brief/weekly/subscribe', priceUsd: '0.25', amount: '250000', weeks: 4 },
    // Disabled for launch. Uncomment to add a 12-week plan (routes, PAID list and day-pass excludes pick it up automatically):
    // '12w': { id: '12w', path: '/api/brief/weekly/subscribe-12w', priceUsd: '0.60', amount: '600000', weeks: 12 }
};
const KEY = 'gw8:weekly_subs', LOCK = 'gw8:weekly_lock:';
const MAX_SUBS = 1000, MAX_FAILS_PER_WEEK = 6;
let subs = null;

async function load() {
    if (subs) return subs;
    subs = {};
    if (hasRedis()) { try { const raw = await redis(['GET', KEY]); if (raw) subs = JSON.parse(raw); } catch (e) { console.error('[weekly] load failed', e.message); } }
    return subs;
}
async function save() { if (hasRedis()) { try { await redis(['SET', KEY, JSON.stringify(subs)]); } catch (e) { console.error('[weekly] save failed', e.message); } } }

// Mountain Time parts (DST-aware via Intl)
function mt(now = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
    return { weekday: p.weekday, hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
}
// Issue key = the MT Monday date of the current week
export function issueKey(now = new Date()) {
    const m = mt(now); const back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[m.weekday];
    return new Date(Date.parse(m.date + 'T12:00:00Z') - back * 86400e3).toISOString().slice(0, 10);
}
export const isSendWindow = (now = new Date()) => { const m = mt(now); return m.weekday === 'Mon' && m.hour >= SEND_HOUR_MT; };

export async function validateWeekly(body) {
    const chk = await checkWebhookUrl((body || {}).webhookUrl);
    if (!chk.ok) return { error: chk.reason };
    if (Object.keys(await load()).length >= MAX_SUBS) return { error: 'subscription capacity reached, try later' };
    return { ok: true, webhookUrl: chk.url.toString() };
}
export async function createWeekly(v, plan = WEEKLY_PLANS['4w']) {
    const all = await load();
    const id = 'wk_' + crypto.randomBytes(12).toString('hex'), secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    // Hard expiry = weeks + 1 week grace, so outages do not silently eat paid issues past the window.
    all[id] = { id, secret, webhookUrl: v.webhookUrl, createdAt: new Date(now).toISOString(), plan: plan.id, issuesLeft: plan.weeks,
        expiresAt: new Date(now + (plan.weeks + 1) * 7 * 86400e3).toISOString(), lastIssue: null, failsThisIssue: 0, missed: [] };
    await save();
    return { subscriptionId: id, secret, webhookUrl: v.webhookUrl, plan: plan.id, issuesLeft: plan.weeks, expiresAt: all[id].expiresAt,
        schedule: `Mondays ~${SEND_HOUR_MT}:00 America/Denver; first issue at the next Monday send window, same day if you subscribe on a Monday after 7:00 (an issue is only counted when your webhook returns 2xx)`,
        status: `/api/brief/weekly/${id}`,
        verify: 'Each POST carries X-GW8-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>. Store the secret; it is shown only once.',
        disclaimer: 'signal only, not financial advice' };
}
export async function cancelWeekly(id) { const all = await load(); if (!id || !all[id]) return false; delete all[id]; await save(); return true; }
export async function getWeeklyStatus(id) {
    const s = (await load())[id]; if (!s) return null;
    return { subscriptionId: s.id, plan: s.plan || '4w', issuesLeft: s.issuesLeft, expiresAt: s.expiresAt, lastIssue: s.lastIssue, missedIssues: s.missed, active: active(s) };
}
const active = s => s.issuesLeft > 0 && Date.parse(s.expiresAt) > Date.now();

const sect = async (f) => { try { const r = await f(); return r && r.error ? { status: 'unavailable', error: r.error } : { status: 'ok', ...r }; } catch { return { status: 'unavailable' }; } };
export async function buildIssue(now = new Date()) {
    const [brief, track, rwa, gov] = await Promise.all([sect(getBrief), sect(getTrack), sect(getRwa), sect(() => getGovContracts({}))]);
    const pick7d = sm => sm ? Object.fromEntries(['green_outer', 'green_all', 'red_outer', 'red_all'].map(k => [k, { signals: sm[k]?.signals ?? 0, '7d': sm[k]?.['7d'] ?? { n: 0 } }])) : null;
    const sections = { brief: brief.status, track: track.status, rwa: rwa.status, gov: gov.status };
    if (Object.values(sections).every(x => x !== 'ok')) return { error: 'all sources unavailable' };
    return {
        type: 'weekly_brief', issue: issueKey(now), asOf: now.toISOString(), sectionStatus: sections,
        regime: brief.status === 'ok' ? brief.regime : null,
        dots: brief.status === 'ok' ? { counts: brief.dots, top10ByDotStrength: brief.top10ByDotStrength } : null,
        hitRate7d: track.status === 'ok' ? {
            backtest: { label: track.backtest.label, summary: pick7d(track.backtest.summary) },
            live: { label: track.live.label, liveSince: track.live.liveSince, count: track.live.count, summary: pick7d(track.live.summary) },
            note: 'Backtest is simulated over a rolling ~90-day window; the live log is short until it accrues. Signals overlap and are not independent. Full table free at /track.'
        } : null,
        rwa: rwa.status === 'ok' ? { summary: rwa.summary, movers7d: rwa.movers7d, newLaunches30d: (rwa.newLaunches30d || []).slice(0, 5), topYields: (rwa.yields?.topPoolsByTvl || []).slice(0, 5) } : null,
        govContracts: gov.status === 'ok' ? { window: gov.window, count: gov.count, partial: gov.partial, topCompanies: (gov.byCompany || []).slice(0, 5), topAwards: (gov.awards || []).slice(0, 5).map(a => ({ date: a.date, company: a.company, ticker: a.ticker, amountUsd: a.amountUsd, agency: a.agency, link: a.link })), sourceStatus: gov.sourceStatus } : null,
        notes: [
            'Gov contracts come from USAspending.gov; DoD awards there lag ~90 days (DoD daily announcements are unavailable from our host), so recent defense awards are under-represented.',
            'RWA data is public DefiLlama + CoinGecko; flows are estimates from TVL change.',
            'Any section marked unavailable is omitted rather than filled with stale or guessed data.',
            'Past performance is not indicative of future results.'
        ],
        disclaimer: 'signal only, not financial advice'
    };
}

async function post(s, payload) {
    const chk = await checkWebhookUrl(s.webhookUrl); if (!chk.ok) return false;
    const body = JSON.stringify({ ...payload, subscriptionId: s.id, issuesLeftAfterThis: s.issuesLeft - 1 });
    try {
        const r = await fetch(s.webhookUrl, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'GW8-Weekly/1.0', 'X-GW8-Subscription': s.id, 'X-GW8-Signature': sign(s.secret, body) }, body });
        return r.status >= 200 && r.status < 300;
    } catch { return false; }
}
// Called every ~10 min. Sends this week's issue once per subscriber; retries failures within the week.
export async function weeklyTick(now = new Date()) {
    if (!isSendWindow(now)) return null;
    const key = issueKey(now);
    if (hasRedis()) { try { if (!(await redis(['SET', LOCK + key + ':' + Math.floor(now / 6e5), '1', 'NX', 'EX', '540']))) return { locked: true }; } catch { return null; } }
    const all = await load();
    const due = Object.values(all).filter(s => active(s) && s.lastIssue !== key && !s.missed.includes(key));
    if (!due.length) return { sent: 0 };
    const issue = await buildIssue(now);
    if (issue.error) return { error: issue.error }; // retry next tick; nobody is debited
    let sent = 0;
    for (const s of due) {
        if (await post(s, issue)) { s.issuesLeft -= 1; s.lastIssue = key; s.failsThisIssue = 0; sent++; }
        else if (++s.failsThisIssue >= MAX_FAILS_PER_WEEK) { s.missed.push(key); s.failsThisIssue = 0; } // missed issues are not debited
    }
    await save();
    return { issue: key, sent, due: due.length };
}
export function _resetWeeklyForTest() { subs = null; }
