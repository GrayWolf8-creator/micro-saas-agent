// sales.js — which paid routes actually sold, by route template, surface, and UTC day.
// Aggregates only. No IPs, wallet addresses, headers, query strings, or request bodies.
//
// A "paid" count is a new sale:
//   x402    — facilitator settlement on HTTP (not a safe-retry replay) or an MCP in-band settlement
//   rapidapi / apify — the marketplace proxy returned 2xx (the marketplace billed the caller)
// "pass" is a later call served by a day pass (the sale was POST /api/pass/day).
// "quotes" is every HTTP 402 (unpaid challenge, or a settle that failed and returned nothing).
// "sample" is a free sample. "free" is any other public 2xx.
//
// Persistence (no new service, no new secret):
//   data/sales-counts.json on the instance disk, rewritten atomically, reloaded on boot.
//   One stdout line per sale: [gw8-sale] {"v":1,"day","route","surface","event":"paid"}
//   On SIGTERM/SIGINT (Render sends SIGTERM on deploy): the file is flushed and one
//   [gw8-sales-snapshot] line carries the aggregate counts.
// Render free disk is wiped on redeploy and can be wiped when the instance sleeps, so the
// file is not a database. This process does not read Render logs back. After a wipe,
// GET /api/sales shows whatever the file still holds plus calls since boot. Older sales
// remain as [gw8-sale] lines in the Render logs for as long as Render keeps those logs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeTrafficRoute, surfaceOf, utcDate } from './stats.js';

export const SALES_FILE_LABEL = 'data/sales-counts.json';
export const SALES_RETENTION_DAYS = 35;
export const SALES_MAX_ROUTES = 500;
const EVENTS = ['paid', 'pass', 'sample', 'free', 'quotes'];
const SURFACES = ['x402', 'rapidapi', 'apify', 'public'];
const SAVE_DELAY_MS = 5000;

const defaultFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'sales-counts.json');
let filePath = defaultFile;
let days = new Map(); // UTC day -> Map(route + "\n" + surface -> counts)
let dropped = 0;
let dirty = false;
let loaded = false;
let saveTimer = null;
let flushInstalled = false;

function emptyCounts() {
    return { paid: 0, pass: 0, sample: 0, free: 0, quotes: 0 };
}

function clampCount(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return 0;
    return Math.min(1e12, Math.floor(x));
}

function recentDays(n) {
    const out = [];
    const start = Date.parse(utcDate() + 'T00:00:00Z');
    for (let i = 0; i < n; i++) out.push(utcDate(new Date(start - i * 86400000)));
    return out;
}

/** Route template only. Rejects anything that still looks like an address, email, or query. */
export function safeRoute(route) {
    const r = String(route || '');
    if (r.length > 160 || r.includes('@') || r.includes('?') || r.includes('\\') || r.includes('\n') || r.includes('|')) return null;
    if (/0x[a-fA-F0-9]{8,}/.test(r)) return null;
    if (/^MCP [A-Za-z0-9_]{1,40}$/.test(r)) return r;
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|OTHER) (\/[A-Za-z0-9/_:.*-]*|other)$/.test(r)) return r;
    return null;
}

function surfaceFor(pathOnly, channel) {
    if (channel === 'MARKETPLACE_RAPIDAPI' || pathOnly === '/mkt/rapidapi' || pathOnly.startsWith('/mkt/rapidapi/')) return 'rapidapi';
    if (channel === 'MARKETPLACE_APIFY' || pathOnly === '/mkt/apify' || pathOnly.startsWith('/mkt/apify/')) return 'apify';
    const s = surfaceOf(pathOnly);
    if (s === 'x402' || s === 'rapidapi') return s;
    if (s === 'unmatched') return 'unmatched';
    return 'public';
}

function pathOf(route) {
    const sp = route.indexOf(' ');
    return sp === -1 ? route : route.slice(sp + 1);
}

/**
 * Decide the one counter a finished response increments.
 * Returns { route, surface, event } or null when the response is not tallied.
 */
export function classifySale(input = {}) {
    if (input.replay) return null;
    const route = safeRoute(normalizeTrafficRoute(input.method, input.path));
    if (!route) return null;
    const pathOnly = pathOf(route);
    if (pathOnly === '/' || pathOnly === '/favicon.ico' || pathOnly === '/favicon.svg') return null;
    // MCP's HTTP transport is not a sale. In-band settlements are counted by recordMcpSale.
    if (pathOnly === '/mcp' || pathOnly === '/mcp.json' || pathOnly === '/.well-known/mcp.json' || pathOnly === '/.well-known/mcp/server-card.json') return null;
    const code = Number(input.statusCode) || 0;
    const ok = code >= 200 && code < 300;
    let surface = surfaceFor(pathOnly, input.channel);
    if (input.access === 'x402' || input.access === 'daypass') surface = 'x402';
    const sample = !!input.sample || pathOnly === '/api/sample';
    let event = null;
    if (sample && ok) event = 'sample';
    else if (input.access === 'x402' && ok) event = 'paid';
    else if (input.access === 'daypass' && ok) event = 'pass';
    else if ((surface === 'rapidapi' || surface === 'apify') && ok) event = 'paid';
    else if (code === 402) {
        event = 'quotes';
        if (surface !== 'rapidapi' && surface !== 'apify') surface = 'x402';
    } else if (ok && surface === 'public') event = 'free';
    else return null;
    if (!SURFACES.includes(surface)) return null;
    return { route, surface, event };
}

function prune() {
    const keep = new Set(recentDays(SALES_RETENTION_DAYS));
    for (const day of [...days.keys()]) if (!keep.has(day)) days.delete(day);
}

function mapKey(route, surface) { return route + '\n' + surface; }

function bump(day, route, surface, event) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    let byRoute = days.get(day);
    if (!byRoute) {
        byRoute = new Map();
        days.set(day, byRoute);
        prune();
        byRoute = days.get(day);
        if (!byRoute) return null;
    }
    const key = mapKey(route, surface);
    let c = byRoute.get(key);
    if (!c) {
        if (byRoute.size >= SALES_MAX_ROUTES) { dropped += 1; dirty = true; return null; }
        c = emptyCounts();
        byRoute.set(key, c);
    }
    c[event] += 1;
    dirty = true;
    if (event === 'paid') {
        // Logged before the file write so a failed disk write still leaves the sale in Render logs.
        console.log('[gw8-sale] ' + JSON.stringify({ v: 1, day, route, surface, event: 'paid' }));
        safeSave();
    } else scheduleSave();
    return { day, route, surface, event };
}

function serialize() {
    const outDays = {};
    for (const [day, routes] of days) {
        const o = {};
        for (const [key, c] of routes) {
            const nl = key.indexOf('\n');
            if (nl < 1) continue;
            const route = key.slice(0, nl);
            const surface = key.slice(nl + 1);
            const counts = emptyCounts();
            for (const ev of EVENTS) counts[ev] = clampCount(c[ev]);
            if (EVENTS.some(ev => counts[ev] > 0)) o[route + '|' + surface] = counts;
        }
        if (Object.keys(o).length) outDays[day] = o;
    }
    return { v: 1, dropped: clampCount(dropped), days: outDays };
}

function saveSync() {
    const body = JSON.stringify(serialize());
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, filePath);
}

function safeSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
        saveSync();
        dirty = false;
    } catch (e) {
        console.error('[sales] save failed', e && e.message);
    }
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (dirty) safeSave();
    }, SAVE_DELAY_MS);
    if (saveTimer.unref) saveTimer.unref();
}

function load() {
    loaded = true;
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (e) {
        if (e && e.code !== 'ENOENT') console.error('[sales] file unreadable, starting empty', e.message);
        return;
    }
    let obj;
    try { obj = JSON.parse(raw); }
    catch (e) {
        console.error('[sales] file unreadable, starting empty', e && e.message);
        return;
    }
    if (!obj || obj.v !== 1 || !obj.days || typeof obj.days !== 'object') return;
    dropped = clampCount(obj.dropped);
    for (const [day, routes] of Object.entries(obj.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !routes || typeof routes !== 'object') continue;
        const m = new Map();
        for (const [stored, counts] of Object.entries(routes)) {
            const pipe = stored.lastIndexOf('|');
            if (pipe < 1 || !counts || typeof counts !== 'object') continue;
            const route = safeRoute(stored.slice(0, pipe));
            const surface = stored.slice(pipe + 1);
            if (!route || !SURFACES.includes(surface)) continue;
            const c = emptyCounts();
            for (const ev of EVENTS) c[ev] = clampCount(counts[ev]);
            if (EVENTS.some(ev => c[ev] > 0)) m.set(mapKey(route, surface), c);
        }
        if (m.size) days.set(day, m);
    }
    prune();
}

function ensureLoaded() {
    if (!loaded) load();
}

/** Write the file now. Pass { snapshot: true } to also print the aggregate log line. */
export function flushSalesNow(opts = {}) {
    ensureLoaded();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (dirty) safeSave();
    if (opts.snapshot) logSnapshot();
    return { dirty: false };
}

function logSnapshot() {
    const body = serialize();
    console.log('[gw8-sales-snapshot] ' + JSON.stringify({ v: 1, asOf: new Date().toISOString(), timezone: 'UTC', dropped: body.dropped, days: body.days }));
}

/** Flush on a timer and on SIGTERM/SIGINT. Does not exit the process (the stats flush owns that). */
export function installSalesFlush() {
    ensureLoaded();
    if (flushInstalled) return;
    flushInstalled = true;
    const timer = setInterval(() => { if (dirty) safeSave(); }, 60000);
    if (timer.unref) timer.unref();
    const onSignal = () => {
        try { flushSalesNow({ snapshot: true }); }
        catch (e) { console.error('[sales] shutdown flush failed', e && e.message); }
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    console.log('[sales] counts in', SALES_FILE_LABEL, '+ one [gw8-sale] log line per paid call');
}

export function recordFromResponse(input = {}) {
    try {
        ensureLoaded();
        const hit = classifySale(input);
        if (!hit) return null;
        return bump(utcDate(), hit.route, hit.surface, hit.event);
    } catch (e) {
        console.error('[sales] record failed', e && e.message);
        return null;
    }
}

/** MCP in-band settlement. The tool name is sanitized. Any extra arguments (payer) are ignored. */
export function recordMcpSale(toolName) {
    try {
        ensureLoaded();
        const name = String(toolName || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40);
        const route = safeRoute('MCP ' + name);
        if (!route) return null;
        return bump(utcDate(), route, 'x402', 'paid');
    } catch (e) {
        console.error('[sales] mcp record failed', e && e.message);
        return null;
    }
}

export function salesMiddleware(req, res, next) {
    res.on('finish', () => {
        const locals = res.locals || {};
        recordFromResponse({
            method: req.method,
            path: req.path || req.url || '/',
            statusCode: res.statusCode,
            sample: !!locals.gw8Sample,
            replay: !!locals.gw8Replay,
            channel: locals.gw8Channel || null,
            access: locals.gw8Access || null
        });
    });
    next();
}

function sumInto(dst, src) {
    for (const ev of EVENTS) dst[ev] += src[ev] || 0;
}

function row(route, surface, counts) {
    return { route, surface, ...counts };
}

function sortRows(rows) {
    rows.sort((a, b) => (b.paid - a.paid) || (b.quotes - a.quotes) || (b.pass - a.pass) || a.route.localeCompare(b.route) || a.surface.localeCompare(b.surface));
    return rows;
}

/**
 * Aggregate sales for the last `days` UTC days (1..35, default 7).
 * Only route templates, surfaces, counts, and dates.
 */
export function getSales(daysRequested = 7) {
    ensureLoaded();
    const n = Math.max(1, Math.min(SALES_RETENTION_DAYS, parseInt(daysRequested, 10) || 7));
    const dates = recentDays(n);
    const totals = emptyCounts();
    const bySurface = {};
    for (const s of SURFACES) bySurface[s] = emptyCounts();
    const summed = new Map();
    const daily = [];
    for (const date of dates) {
        const dayTotals = emptyCounts();
        const daySurface = {};
        for (const s of SURFACES) daySurface[s] = emptyCounts();
        const routes = [];
        const stored = days.get(date);
        if (stored) {
            for (const [key, c] of stored) {
                const nl = key.indexOf('\n');
                const route = key.slice(0, nl);
                const surface = key.slice(nl + 1);
                const counts = emptyCounts();
                for (const ev of EVENTS) counts[ev] = clampCount(c[ev]);
                routes.push(row(route, surface, counts));
                sumInto(dayTotals, counts);
                if (daySurface[surface]) sumInto(daySurface[surface], counts);
                const sk = key;
                if (!summed.has(sk)) summed.set(sk, emptyCounts());
                sumInto(summed.get(sk), counts);
            }
        }
        daily.push({ date, totals: dayTotals, bySurface: daySurface, routes: sortRows(routes) });
        sumInto(totals, dayTotals);
        for (const s of SURFACES) sumInto(bySurface[s], daySurface[s]);
    }
    const routes = [];
    for (const [key, counts] of summed) {
        const nl = key.indexOf('\n');
        routes.push(row(key.slice(0, nl), key.slice(nl + 1), { ...counts }));
    }
    return {
        asOf: new Date().toISOString(),
        timezone: 'UTC',
        days: n,
        dates,
        totals,
        bySurface,
        routes: sortRows(routes),
        daily,
        dropped: clampCount(dropped),
        retentionDays: SALES_RETENTION_DAYS,
        persistence: {
            file: SALES_FILE_LABEL + ' on the instance disk (about ' + SALES_RETENTION_DAYS + ' UTC days). Reloaded on boot. Render free disk is wiped on redeploy and can be wiped when the instance sleeps.',
            log: 'Each sale prints one line: [gw8-sale] {"v":1,"day","route","surface","event":"paid"}. On SIGTERM/SIGINT a [gw8-sales-snapshot] line prints the aggregate counts. Search the Render logs for [gw8-sale]. This endpoint does not read those logs back.',
            privacy: 'Route templates, surfaces, counts, and UTC dates only. No IPs, wallet addresses, headers, query strings, or request bodies.'
        },
        note: 'paid = a new sale of that route: x402 facilitator settlement (HTTP, not a safe-retry replay) or MCP in-band settlement, or a RapidAPI/Apify proxy 2xx. pass = served with a day pass (the USDC sale was POST /api/pass/day). quotes = HTTP 402 (unpaid challenge, or a settlement that failed and returned no data). sample = free sample. free = other public 2xx. GET / keep-warm, favicon, /api/sales, /api/stats, and /api/traffic are not counted. Prices are unchanged; match a day\'s x402 paid counts to USDC transfers by route name.'
    };
}

/** JSON only. Not an x402 route. The counter skips this path. */
export function mountSalesReport(app) {
    app.get('/api/sales', (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            return res.json(getSales(req.query && req.query.days));
        } catch (e) {
            console.error('[sales] report failed', e && e.message);
            return res.status(503).json({ error: 'sales report unavailable, retry shortly' });
        }
    });
}

export function _resetSalesForTests(opts = {}) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    days = new Map();
    dropped = 0;
    dirty = false;
    loaded = !!opts.load;
    if (opts.file) filePath = opts.file;
    if (opts.load) load();
}
