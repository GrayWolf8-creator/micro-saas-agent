// kraken.js — Kraken new USD listings feed. Kraken PUBLIC REST only (no keys, no private endpoints, no trading).
// first-seen = when OUR snapshot first saw the pair (append-only, Upstash HSETNX), starting at deploy (liveSince).
// Pairs that already existed at deploy are "baseline"; a one-time throttled backfill reads each baseline pair's first
// daily candle so pairs that started trading in the last 30 days still show (labeled source: "kraken-first-candle").
import { redis, hasRedis } from './alerts.js';
import { fetchOHLC, compute } from './Signal.js';

const API = 'https://api.kraken.com/0/public';
const RSS = 'https://blog.kraken.com/category/product/asset-listings/feed';
const SEEN = 'gw8:kraken_firstseen', CANDLE = 'gw8:kraken_firstcandle', SINCE = 'gw8:kraken_since';
const WINDOW_DAYS = 30, CACHE_MS = 10 * 60e3, MAX_ROWS = 40;
const DISCLAIMER = 'signal only, not financial advice';
const mem = { seen: {}, candle: {}, since: null };
const st = { lastSnapshot: null, lastSnapshotError: null, pairsTracked: 0, backfill: { state: 'idle', done: 0, total: 0, errors: 0 }, rss: 'not checked' };
let cache = null, inflight = null, backfillRunning = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const j = async (path) => { const r = await fetch(API + path, { signal: AbortSignal.timeout(20000) }); const x = await r.json(); if (x.error && x.error.length) throw new Error(x.error.join(',')); return x.result; };

// ---- store (append-only) ----
async function hgetall(k) { if (!hasRedis()) return { ...(k === SEEN ? mem.seen : mem.candle) }; const a = await redis(['HGETALL', k]) || []; const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; }
async function hsetnx(k, f, v) { if (!hasRedis()) { const m = k === SEEN ? mem.seen : mem.candle; if (m[f] == null) m[f] = v; return; } await redis(['HSETNX', k, f, v]); }
async function getSince() { return hasRedis() ? redis(['GET', SINCE]) : mem.since; }
async function setSince(v) { if (hasRedis()) await redis(['SET', SINCE, v, 'NX']); else mem.since ||= v; }

// ---- snapshot ----
export async function snapshot(opts = {}) {
    try {
        const pairs = Object.entries(await j('/AssetPairs')).filter(([, p]) => (p.quote === 'ZUSD' || p.quote === 'USD') && p.status === 'online' && !/\.d$/.test(p.altname || ''));
        const now = new Date().toISOString();
        let since = await getSince(); const baseline = !since;
        if (baseline) { await setSince(now); since = await getSince(); }
        const seen = await hgetall(SEEN); let added = 0;
        for (const [key, p] of pairs) if (!seen[key]) { await hsetnx(SEEN, key, JSON.stringify({ wsname: p.wsname, base: p.base, firstSeen: now, source: baseline ? 'baseline' : 'snapshot' })); added++; }
        Object.assign(st, { lastSnapshot: now, lastSnapshotError: null, pairsTracked: pairs.length });
        if (!backfillRunning) backfill(opts.throttleMs).catch(() => {});
        return { since, baseline, added, pairs: pairs.length };
    } catch (e) { st.lastSnapshotError = String(e.message || e); return { error: st.lastSnapshotError }; }
}
// One-time, resumable: first daily candle per pair (0 = older than Kraken's 720-day daily window).
async function backfill(throttleMs = 2000) {
    backfillRunning = true;
    try {
        const seen = await hgetall(SEEN), done = await hgetall(CANDLE);
        const todo = Object.keys(seen).filter(k => done[k] == null);
        st.backfill = { state: todo.length ? 'running' : 'complete', done: Object.keys(done).length, total: Object.keys(seen).length, errors: 0 };
        for (const k of todo) {
            try { const rows = await fetchOHLC(k, 1440); const first = rows.length ? +rows[0][0] : 0; await hsetnx(CANDLE, k, String(rows.length >= 720 ? 0 : first)); st.backfill.done++; }
            catch { st.backfill.errors++; } // retried on a later snapshot
            await sleep(throttleMs);
        }
        st.backfill.state = st.backfill.errors ? 'partial (will retry)' : 'complete';
    } finally { backfillRunning = false; }
}

// ---- announcements (Kraken blog RSS, public) ----
async function announcements() {
    try {
        const r = await fetch(RSS, { headers: { 'User-Agent': 'GW8-Signal/1.0' }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) { st.rss = `unavailable from our host (HTTP ${r.status})`; return null; }
        const s = await r.text(), tag = (i, t) => (i.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1] || null;
        const items = [...s.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({ title: tag(m[1], 'title'), published: new Date(tag(m[1], 'pubDate')).toISOString(), link: tag(m[1], 'link') }))
            .filter(x => Date.now() - Date.parse(x.published) < WINDOW_DAYS * 86400e3);
        st.rss = 'ok'; return items;
    } catch (e) { st.rss = 'unavailable from our host (' + (e.name === 'TimeoutError' ? 'timeout' : 'fetch failed') + ')'; return null; }
}

// ---- feed ----
function dotState(rec) {
    const latest = rec.dots.filter(d => d.latest), recent = rec.dots.slice(-1)[0] || null;
    const zone = rec.wt1 <= -53 ? 'oversold' : rec.wt1 >= 53 ? 'overbought' : 'neutral';
    return { wt1: rec.wt1, wt2: rec.wt2, zone, dotOnLatestBar: latest[0] ? `${latest[0].kind} ${latest[0].band}` : null, lastDotInLast6Bars: recent ? { kind: recent.kind, band: recent.band, bar: recent.bar } : null };
}
async function build() {
    const snap = await snapshot();
    const since = await getSince(), seen = await hgetall(SEEN), candle = await hgetall(CANDLE), now = Date.now(), cut = now - WINDOW_DAYS * 86400e3;
    const cands = [];
    for (const [key, raw] of Object.entries(seen)) {
        const s = JSON.parse(raw), fc = +candle[key] || 0;
        if (s.source === 'snapshot' && Date.parse(s.firstSeen) >= cut) cands.push({ key, ...s, firstTradeDay: fc ? new Date(fc * 1000).toISOString().slice(0, 10) : null, dateSource: 'gw8-first-seen' });
        else if (fc && fc * 1000 >= cut) cands.push({ key, ...s, firstTradeDay: new Date(fc * 1000).toISOString().slice(0, 10), dateSource: 'kraken-first-candle' });
    }
    const dateOf = c => c.dateSource === 'gw8-first-seen' ? c.firstSeen : c.firstTradeDay;
    cands.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    const list = cands.slice(0, MAX_ROWS);
    let tick = {}; try { if (list.length) tick = await j('/Ticker?pair=' + list.map(c => c.key).join(',')); } catch { }
    const rows = [];
    for (const c of list) {
        const t = tick[c.key] || null, last = t ? +t.c[0] : null, row = { pair: c.wsname, firstSeenByGw8: c.dateSource === 'gw8-first-seen' ? c.firstSeen : null, firstTradeDayOnKraken: c.firstTradeDay, dateSource: c.dateSource,
            priceUsd: last, volume24hUsd: t ? Math.round(+t.v[1] * +t.p[1]) : null, changeSinceListingPct: null, listingRefPrice: null, wavetrend4h: null };
        try {
            const ohlc = await fetchOHLC(c.key, 240);
            if (ohlc.length) { row.listingRefPrice = +ohlc[0][1]; row.changeSinceListingPct = last ? r2((last / +ohlc[0][1] - 1) * 100) : null; }
            row.wavetrend4h = ohlc.length >= 40 ? dotState(compute(c.wsname, ohlc)) : { status: `not computable yet (${ohlc.length} closed 4h candles, need 40)` };
        } catch { row.wavetrend4h = { status: 'unavailable (Kraken OHLC error)' }; }
        rows.push(row); await sleep(1100);
    }
    const ann = await announcements();
    return {
        asOf: new Date().toISOString(), windowDays: WINDOW_DAYS, liveSince: since, count: rows.length, truncated: cands.length > MAX_ROWS, newUsdPairs: rows,
        announcements: ann ? { source: RSS, items: ann } : { status: st.rss },
        sourceStatus: { krakenAssetPairs: snap.error ? 'unavailable' : 'ok', backfill: st.backfill.state, krakenBlogRss: st.rss },
        notes: [
            `firstSeenByGw8 = when our snapshot first saw the pair, not Kraken's official listing time. Our snapshots started ${since}; pairs that existed then are a baseline, not "new".`,
            'firstTradeDayOnKraken = UTC date of the pair\'s first daily candle in Kraken public OHLC (used for pairs that predate our snapshots; date only).',
            'changeSinceListingPct compares the last price with the open of the first 4h candle Kraken returns (up to ~120 days back), i.e. roughly the first traded price.',
            'volume24hUsd = Kraken rolling 24h base volume x VWAP; single venue. New listings are thin and volatile; WaveTrend needs 40+ closed 4h candles.',
            'Announcements are Kraken blog posts (may include non-USD assets and lag or lead actual trading).'
        ],
        disclaimer: DISCLAIMER
    };
}
export async function getKrakenListings() {
    if (cache && Date.now() - cache.t < CACHE_MS) return { ...cache.data, cached: true };
    if (!inflight) inflight = build().then(d => { if (d.sourceStatus.krakenAssetPairs === 'ok') cache = { t: Date.now(), data: d }; return d; }).finally(() => { inflight = null; });
    try { const d = await inflight; return d.sourceStatus.krakenAssetPairs === 'ok' ? d : { error: 'upstream data unavailable, retry shortly' }; } catch { return { error: 'upstream data unavailable, retry shortly' }; }
}
export async function getKrakenStatus() {
    return { free: true, liveSince: await getSince().catch(() => null), store: hasRedis() ? 'upstash-redis' : 'memory (resets on restart)', ...st, rss: undefined,
        sources: { krakenAssetPairs: st.lastSnapshotError ? 'error: ' + st.lastSnapshotError : (st.lastSnapshot ? 'ok' : 'not run yet'), krakenBlogRss: st.rss },
        note: 'Free health check only (no listing rows). Paid feed: GET /api/kraken/listings ($0.02).' };
}
