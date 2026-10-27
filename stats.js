// stats.js — free per-endpoint request counters. No PII: no IPs or raw headers; a user-agent is reduced to a
// fixed bot name or "buyer" (buyers.js), and payer wallets are stored only as truncated SHA-256 ids.
// Persistence: Upstash Redis REST via alerts.js helper; in-memory fallback. All keys expire (~35d) or are capped.
// Traffic report (UTC route x status, surfaces, unmatched probes) lives at the bottom of this file and is
// recorded from record(). It does not change the Mountain Time audience/conversion counters above.
import crypto from 'crypto';
import { redis, hasRedis } from './alerts.js';
import { classifyUA, payerId, isOwnPayer, GRADER_ROUTES_PER_HOUR } from './buyers.js';

const TTL_SEC = 35 * 24 * 60 * 60; // ~35 days
const KEY_PREFIX = 'gw8:stats:';
const TZ = 'America/Denver';

/** Exact known paths (no params). Anything else that isn't a param pattern → "other". */
const EXACT = new Set([
    '/',
    '/llms.txt',
    '/openapi.json',
    '/favicon.ico',
    '/favicon.svg',
    '/track',
    '/pay.html',
    '/mcp',
    '/mcp.json',
    '/.well-known/x402',
    '/.well-known/x402.json',
    '/well-known/x402.json',
    '/.well-known/mcp.json',
    '/.well-known/mcp/server-card.json',
    '/api/agent',
    '/api/dots',
    '/api/history',
    '/api/regime',
    '/api/brief',
    '/api/rwa',
    '/api/govcontracts',
    '/api/govcontracts/status',
    '/api/kraken/listings',
    '/api/kraken/listings/status',
    '/api/rules',
    '/api/rules/status',
    '/api/rs',
    '/api/rails',
    '/api/value',
    '/api/value/status',
    '/api/growth',
    '/api/growth/status',
    '/api/growth/history',
    '/api/spend/check',
    '/api/seller/reputation',
    '/api/pay/should-i-pay',
    '/api/seller/reputation/status',
    '/api/pass/day',
    '/api/alerts/subscribe',
    '/api/sample',
    '/api/brief/teaser',
    '/api/track',
    '/api/proof/pubkey',
    '/.well-known/gw8-receipt-key',
    '/api/receipt/verify',
    '/api/brief/weekly/subscribe',
]);

const PARAM = [
    [/^\/api\/coin\/[^/]+$/i, '/api/coin/:symbol'],
    [/^\/api\/verdict\/[^/]+\/[^/]+$/i, '/api/verdict/:chain/:address'],
    [/^\/api\/flows\/[^/]+$/i, '/api/flows/:symbol'],
    [/^\/api\/value\/[^/]+\/history$/i, '/api/value/:symbol/history'],
    [/^\/api\/value\/[^/]+$/i, '/api/value/:symbol'],
    [/^\/api\/growth\/[^/]+$/i, '/api/growth/:chain'],
    [/^\/api\/alerts\/[^/]+$/i, '/api/alerts/:id'],
    [/^\/api\/brief\/weekly\/[^/]+$/i, '/api/brief/weekly/:id'],
    [/^\/mkt\/rapidapi\/.+$/i, '/mkt/rapidapi/*'],
    [/^\/mkt\/apify\/.+$/i, '/mkt/apify/*'],
];

/** Paid data routes (normalized path without method). 2xx here counts as "paid". */
const PAID_PATHS = new Set([
    '/api/agent',
    '/api/dots',
    '/api/history',
    '/api/regime',
    '/api/coin/:symbol',
    '/api/verdict/:chain/:address',
    '/api/flows/:symbol',
    '/api/brief',
    '/api/rwa',
    '/api/govcontracts',
    '/api/kraken/listings',
    '/api/rules',
    '/api/rs',
    '/api/rails',
    '/api/value',
    '/api/value/:symbol',
    '/api/value/:symbol/history',
    '/api/growth',
    '/api/growth/:chain',
    '/api/growth/history',
    '/api/spend/check',
    '/api/seller/reputation',
    '/api/pay/should-i-pay',
    '/api/pass/day',
    '/api/alerts/subscribe',
    '/api/brief/weekly/subscribe',
]);

/** Skip recording entirely (self + HTML views). The traffic report must not count itself. */
const SKIP = new Set(['/api/stats', '/stats.html', '/stats', '/api/traffic', '/traffic.html', '/traffic']);

/** Home keep-warm: counted under meta, not route totals. */
const HOME = '/';

// In-memory fallback: day -> field -> count
const mem = new Map();
const expireSet = new Set(); // day keys we've already sent EXPIRE for this process

export function mtDate(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function normalizeRoute(method, rawPath) {
    let p = String(rawPath || '/').split('?')[0];
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    // collapse // 
    p = p.replace(/\/{2,}/g, '/');
    const m = String(method || 'GET').toUpperCase();
    if (SKIP.has(p)) return null;
    let routePath = null;
    if (EXACT.has(p)) routePath = p;
    else {
        for (const [re, canon] of PARAM) {
            if (re.test(p)) { routePath = canon; break; }
        }
    }
    if (!routePath) {
        // Allow a few weekly plan paths if they match /api/brief/weekly/... subscribe variants
        if (/^\/api\/brief\/weekly\/subscribe/i.test(p)) routePath = '/api/brief/weekly/subscribe';
        else routePath = 'other';
    }
    return `${m} ${routePath}`;
}

function statusClass(code) {
    const c = Number(code) || 0;
    if (c === 402) return '402';
    if (c >= 200 && c < 300) return '2xx';
    if (c === 404) return '404';
    if (c === 405) return '405';
    if (c >= 500 && c < 600) return '5xx';
    return 'other';
}

function memIncr(day, field) {
    let m = mem.get(day);
    if (!m) { m = new Map(); mem.set(day, m); }
    m.set(field, (m.get(field) || 0) + 1);
}

async function redisIncr(day, field) {
    const key = KEY_PREFIX + day;
    const n = await redis(['HINCRBY', key, field, 1]);
    if (!expireSet.has(day)) {
        expireSet.add(day);
        try { await redis(['EXPIRE', key, TTL_SEC]); } catch { /* ignore */ }
    }
    return n;
}

/** Fire-and-forget record. Never throws to caller. Returns the normalized route key (or null). */
export function record(method, path, statusCode, opts = {}) {
    try {
        const route = normalizeRoute(method, path);
        if (!route) return null;
        // UTC route x status report. Separate store; a failure here must not drop the legacy tally.
        try { recordTraffic(method, path, statusCode); }
        catch (e) { console.error('[stats] traffic record failed', e && e.message); }
        const day = mtDate();
        // A safe-retry replay of an already-settled payment is not a second sale: tallied as "other", not paid.
        const cls = opts.replay ? 'replay' : opts.sample ? 'sample' : statusClass(statusCode);
        const field = `${route}|${cls}`;
        // Always bump memory so local reads work even when Redis is configured
        memIncr(day, field);
        if (hasRedis()) redisIncr(day, field).catch(e => console.error('[stats] redis incr failed', e.message));
        return route;
    } catch (e) {
        console.error('[stats] record failed', e && e.message);
        return null;
    }
}

// ---------- Audience split: bot vs likely buyer (vs self = GW8's own seeding wallets) ----------
// Extra fields live in the same per-day hash, prefixed so the legacy route parser skips them:
//   a|<bot|buyer|self>|<req|402|paid>|<METHOD route>   per-route counts by audience
//   ua|<botName>                                       requests per named bot (fixed list, bounded)
// Payers (ids only): gw8:stats:payers:<day> {pid: paidCalls}, gw8:stats:payer_first {pid: firstDay} (capped),
// gw8:stats:graders {pid: dayFlagged}, gw8:stats:pr:<pid>:<hour> SET of routes (1h TTL) for the grader rule.
const PAYERS = 'gw8:stats:payers:', FIRST = 'gw8:stats:payer_first', GRADERS = 'gw8:stats:graders', PR = 'gw8:stats:pr:';
const MAX_PAYERS_TRACKED = 50000;
const memP = { days: new Map(), first: new Map(), graders: new Map(), hourly: new Map() };
const isAud = f => f.startsWith('a|') || f.startsWith('ua|') || f.startsWith('ih|');
// Repeat no-payment addresses: hashed only (sha256('gw8-ip:'+ip).slice(0,16)). Never store the raw IP.
export const REPEAT_NOPAY_QUOTES = 8;
const MAX_IP_HASHES = 4000;
const seenIp = new Map();
export function hashIp(ip) {
    return crypto.createHash('sha256').update('gw8-ip:' + String(ip || '')).digest('hex').slice(0, 16);
}
function allowIp(day, hash) {
    let s = seenIp.get(day);
    if (!s) { s = new Set(); seenIp.set(day, s); }
    if (s.has(hash)) return true;
    if (s.size >= MAX_IP_HASHES) return false;
    s.add(hash);
    return true;
}

async function bump(day, field) {
    memIncr(day, field);
    if (hasRedis()) await redisIncr(day, field);
}

/** Track a settled payer; returns 'self' | 'bot' (grader) | null (no override). */
async function trackPayer(day, pid, route) {
    const own = isOwnPayer(pid);
    const hour = Math.floor(Date.now() / 3600e3);
    if (!hasRedis()) {
        const pd = memP.days.get(day) || new Map(); memP.days.set(day, pd); pd.set(pid, (pd.get(pid) || 0) + 1);
        if (!memP.first.has(pid) && memP.first.size < MAX_PAYERS_TRACKED) memP.first.set(pid, day);
        const hk = pid + ':' + hour, hs = memP.hourly.get(hk) || new Set(); memP.hourly.set(hk, hs); hs.add(route);
        if (memP.hourly.size > 2000) for (const k of memP.hourly.keys()) { if (!k.endsWith(':' + hour)) memP.hourly.delete(k); }
        if (own) return 'self';
        if (hs.size >= GRADER_ROUTES_PER_HOUR && !memP.graders.has(pid)) memP.graders.set(pid, day);
        return memP.graders.has(pid) ? 'bot' : null;
    }
    const pk = PAYERS + day;
    await redis(['HINCRBY', pk, pid, 1]);
    await redis(['EXPIRE', pk, TTL_SEC]);
    if ((await redis(['HLEN', FIRST])) < MAX_PAYERS_TRACKED) await redis(['HSETNX', FIRST, pid, day]);
    if (own) return 'self';
    const hk = PR + pid + ':' + hour;
    await redis(['SADD', hk, route]);
    await redis(['EXPIRE', hk, 3600]);
    if ((await redis(['SCARD', hk])) >= GRADER_ROUTES_PER_HOUR) await redis(['HSETNX', GRADERS, pid, day]);
    return (await redis(['HEXISTS', GRADERS, pid])) ? 'bot' : null;
}

/** Record audience fields for one finished request. Never throws. */
export async function recordAudience({ route, statusCode, ua, payer, paidRoute, replay, ipHash, sample }) {
    try {
        if (!route) return;
        const day = mtDate();
        const c = classifyUA(ua);
        let aud = c.cls;
        const code = Number(statusCode) || 0;
        const isPaid = !sample && !replay && paidRoute && code >= 200 && code < 300;
        const pid = isPaid && payer ? payerId(payer) : null;
        if (pid) { const o = await trackPayer(day, pid, route); if (o) aud = o; }
        await bump(day, `a|${aud}|req|${route}`);
        if (code === 402) await bump(day, `a|${aud}|402|${route}`);
        if (isPaid) await bump(day, `a|${aud}|paid|${route}`);
        if (c.cls === 'bot') await bump(day, `ua|${c.name}`);
        if (ipHash && /^[a-f0-9]{16}$/.test(ipHash) && allowIp(day, ipHash)) {
            if (code === 402) await bump(day, `ih|${ipHash}|q`);
            if (isPaid) await bump(day, `ih|${ipHash}|p`);
            if (code === 402 && aud === 'bot') await bump(day, `ih|${ipHash}|bq`);
        }
    } catch (e) { console.error('[stats] audience record failed', e && e.message); }
}

/** MCP in-band settlements (no HTTP 2xx on a paid path): count the paid call and the payer. */
export function recordMcpPaid(toolName, payer) {
    const route = `MCP ${String(toolName).replace(/[^a-z0-9_]/gi, '').slice(0, 40)}`;
    recordAudience({ route, statusCode: 200, ua: 'mcp-inband', payer, paidRoute: true }).catch(() => {});
}

/** Express middleware: tally on response finish. Place before x402 handlers. */
export function clientIpHash(req) {
    const x = req.headers && req.headers['x-forwarded-for'];
    const raw = (typeof x === 'string' && x.split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || '';
    return hashIp(raw);
}
export function statsMiddleware(req, res, next) {
    const ua = req.headers['user-agent'];
    const ipHash = clientIpHash(req);
    res.on('finish', () => {
        const replay = !!res.locals.gw8Replay;
        const sample = !!res.locals.gw8Sample;
        const route = record(req.method, req.path || req.url, res.statusCode, { replay, sample });
        if (!route || route.endsWith(' /')) return; // home keep-warm stays out of the audience split too
        recordAudience({ route, statusCode: res.statusCode, ua, payer: res.locals.gw8Payer, paidRoute: PAID_PATHS.has(pathOf(route)), replay, ipHash, sample });
    });
    next();
}

function daysList(n) {
    const out = [];
    const now = Date.now();
    for (let i = 0; i < n; i++) {
        // step back ~i days in MT by using noon UTC offsets carefully
        const d = new Date(now - i * 86400000);
        out.push(mtDate(d));
    }
    // Deduplicate if DST edge; ensure unique newest-first
    return [...new Set(out)];
}

async function loadDay(day) {
    // Prefer Redis when configured (authoritative across instances). Memory is fallback
    // and the sole store when Redis is unset — never merge both (would double-count).
    if (hasRedis()) {
        try {
            const flat = await redis(['HGETALL', KEY_PREFIX + day]);
            const merged = new Map();
            if (flat && typeof flat === 'object' && !Array.isArray(flat)) {
                for (const [k, v] of Object.entries(flat)) merged.set(k, parseInt(v, 10) || 0);
            } else if (Array.isArray(flat)) {
                for (let i = 0; i + 1 < flat.length; i += 2) {
                    merged.set(flat[i], parseInt(flat[i + 1], 10) || 0);
                }
            }
            return merged;
        } catch (e) {
            console.error('[stats] redis read failed, using memory', e.message);
        }
    }
    const fromMem = mem.get(day);
    return new Map(fromMem ? [...fromMem] : []);
}

function pathOf(routeKey) {
    // "GET /api/coin/:symbol" -> "/api/coin/:symbol"
    const sp = routeKey.indexOf(' ');
    return sp === -1 ? routeKey : routeKey.slice(sp + 1);
}

function emptyBucket() {
    return { quotes: 0, paid: 0, served: 0, notFound: 0, methodNotAllowed: 0, errors: 0, other: 0, requests: 0 };
}

function applyField(bucket, routeKey, cls, n) {
    const path = pathOf(routeKey);
    bucket.requests += n;
    if (cls === '402') bucket.quotes += n;
    else if (cls === '2xx') {
        if (PAID_PATHS.has(path)) bucket.paid += n;
        else bucket.served += n;
    } else if (cls === '404') bucket.notFound += n;
    else if (cls === '405') bucket.methodNotAllowed += n;
    else if (cls === '5xx') bucket.errors += n;
    else bucket.other += n;
}

/**
 * Aggregate stats for the last `days` Mountain Time days (1..30).
 * Home (/) kept under meta.home; stats routes never recorded.
 */
export async function getStats(days = 1) {
    const n = Math.max(1, Math.min(30, parseInt(days, 10) || 1));
    const list = daysList(n);
    const byRoute = new Map();
    const totals = emptyBucket();
    const home = emptyBucket();
    const audFields = [];

    for (const day of list) {
        const fields = await loadDay(day);
        for (const [field, count] of fields) {
            if (isAud(field)) { audFields.push([field, count]); continue; }
            const pipe = field.lastIndexOf('|');
            if (pipe < 0) continue;
            const routeKey = field.slice(0, pipe);
            const cls = field.slice(pipe + 1);
            const path = pathOf(routeKey);
            if (path === HOME || routeKey === `GET ${HOME}` || routeKey.endsWith(' /')) {
                applyField(home, routeKey, cls, count);
                continue;
            }
            if (!byRoute.has(routeKey)) byRoute.set(routeKey, emptyBucket());
            const b = byRoute.get(routeKey);
            applyField(b, routeKey, cls, count);
            applyField(totals, routeKey, cls, count);
        }
    }

    const routes = [...byRoute.entries()]
        .map(([route, b]) => ({ route, ...b }))
        .sort((a, b) => b.requests - a.requests);

    const audience = await buildAudience(list, audFields);

    return {
        asOf: new Date().toISOString(),
        timezone: TZ,
        days: n,
        dates: list,
        store: hasRedis() ? 'upstash-redis' : 'memory',
        totals,
        routes,
        audience,
        meta: {
            homeKeepWarm: home,
            note: 'GET / (keep-warm) is under meta.homeKeepWarm, not route totals. /api/stats, /stats.html, /api/traffic and /traffic.html are not recorded. No IPs or raw headers stored; user-agents are reduced to a known-bot name, payer wallets to truncated SHA-256 ids. audience = bot vs likely-buyer split (started with this release, so earlier days show 0). Route x HTTP status (UTC) and unmatched probes: /api/traffic and /traffic.html.',
        },
    };
}

async function loadPayers(day) {
    if (hasRedis()) {
        try { return toMap(await redis(['HGETALL', PAYERS + day])); } catch (e) { console.error('[stats] payers read failed', e.message); return new Map(); }
    }
    return new Map(memP.days.get(day) || []);
}
function toMap(flat) {
    const m = new Map();
    if (Array.isArray(flat)) for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], parseInt(flat[i + 1], 10) || 0);
    else if (flat && typeof flat === 'object') for (const [k, v] of Object.entries(flat)) m.set(k, parseInt(v, 10) || 0);
    return m;
}

async function buildAudience(list, audFields) {
    const seg = () => ({ requests: 0, quotes: 0, paid: 0 });
    const by = { bot: seg(), likelyBuyer: seg(), self: seg() };
    const ips = new Map();
    const key = a => a === 'buyer' ? 'likelyBuyer' : a;
    const perRoute = new Map(), bots = new Map();
    for (const [f, c] of audFields) {
        const p = f.split('|');
        if (p[0] === 'ua') { bots.set(p[1], (bots.get(p[1]) || 0) + c); continue; }
        if (p[0] === 'ih') {
            const hash = p[1], metric = p[2];
            if (!ips.has(hash)) ips.set(hash, { quotes: 0, paid: 0, botQuotes: 0 });
            const ip = ips.get(hash);
            if (metric === 'q') ip.quotes += c;
            else if (metric === 'p') ip.paid += c;
            else if (metric === 'bq') ip.botQuotes += c;
            continue;
        }
        const [, aud, metric, route] = p; const b = by[key(aud)]; if (!b) continue;
        const m = metric === 'req' ? 'requests' : metric === '402' ? 'quotes' : metric === 'paid' ? 'paid' : null; if (!m) continue;
        b[m] += c;
        if (!perRoute.has(route)) perRoute.set(route, { route, bot: seg(), likelyBuyer: seg(), self: seg() });
        perRoute.get(route)[key(aud)][m] += c;
    }
    // Payers in window
    const calls = new Map(), daysPaid = new Map();
    for (const day of list) for (const [pid, c] of await loadPayers(day)) {
        calls.set(pid, (calls.get(pid) || 0) + c);
        if (!daysPaid.has(pid)) daysPaid.set(pid, new Set()); daysPaid.get(pid).add(day);
    }
    const pids = [...calls.keys()];
    let first = new Map(), graders = new Map();
    if (pids.length) {
        if (hasRedis()) {
            try {
                const f = await redis(['HMGET', FIRST, ...pids]);
                pids.forEach((p, i) => f && f[i] && first.set(p, f[i]));
                const g = await redis(['HMGET', GRADERS, ...pids]);
                pids.forEach((p, i) => g && g[i] && graders.set(p, g[i]));
            } catch (e) { console.error('[stats] payer meta read failed', e.message); }
        } else { first = memP.first; graders = memP.graders; }
    }
    const conversion = quoteConversion({
        botQuotes: by.bot.quotes,
        buyerQuotes: by.likelyBuyer.quotes,
        settledBuyerPaid: null,
        ips: [...ips.values()]
    });
    const pay = { unique: 0, repeat: 0, returning: 0, graderBots: 0, self: 0, buyerCalls: 0, graderCalls: 0, selfCalls: 0 };
    for (const pid of pids) {
        if (isOwnPayer(pid)) { pay.self++; pay.selfCalls += calls.get(pid); continue; }
        if (graders.has(pid)) { pay.graderBots++; pay.graderCalls += calls.get(pid); continue; }
        pay.unique++; pay.buyerCalls += calls.get(pid);
        if (calls.get(pid) >= 2) pay.repeat++;
        const days = [...daysPaid.get(pid)].sort(), f = first.get(pid);
        if (days.length >= 2 || (f && f < days[days.length - 1])) pay.returning++;
    }
    return {
        bot: by.bot, likelyBuyer: by.likelyBuyer, self: by.self,
        payers: { likelyBuyers: pay.unique, repeat: pay.repeat, returning: pay.returning, graderBots: pay.graderBots, self: pay.self,
            settledPaidCalls: { likelyBuyer: pay.buyerCalls, grader: pay.graderCalls, self: pay.selfCalls },
            note: 'Settled x402 payers only (facilitator HTTP + MCP in-band), by anonymized id. Day-pass calls carry no payer. settledPaidCalls is re-classified at read time, so a grader\'s first calls (before it crossed the routes-per-hour rule) count as grader here even though the per-route paid split above recorded them as likelyBuyer. repeat = 2+ paid calls in window; returning = paid on 2+ different MT days (or first paid before the latest paid day).' },
        topBots: [...bots.entries()].map(([name, requests]) => ({ name, requests })).sort((a, b) => b.requests - a.requests).slice(0, 15),
        routes: [...perRoute.values()].sort((a, b) => (b.likelyBuyer.quotes + b.likelyBuyer.paid) - (a.likelyBuyer.quotes + a.likelyBuyer.paid) || (b.bot.requests - a.bot.requests)),
        method: `bot = known x402 monitor/indexer/grader user-agents (Tanod list + x402 scanners), generic crawlers/uptime/security scanners, raw HTTP libraries and empty UA; plus any wallet that paid ${GRADER_ROUTES_PER_HOUR}+ different routes within an hour (grader). self = wallets in GW8_OWN_WALLETS. likelyBuyer = everything else (heuristic; a bot with a browser-like UA counts here).`,
        conversion: {
            ...conversion,
            likelyRealBuyers: { ...conversion.likelyRealBuyers, paid: pay.buyerCalls, quoteToPaid: conversion.likelyRealBuyers.quotes > 0 ? pay.buyerCalls / conversion.likelyRealBuyers.quotes : null },
            graders: { wallets: pay.graderBots, settledCalls: pay.graderCalls, note: 'Unpaid quotes have no wallet, so grader quote counts are not estimated. Graders here are wallets that settled ' + GRADER_ROUTES_PER_HOUR + '+ different routes in an hour.' }
        },
    };
}

/**
 * Split recorded quotes into likely bots vs likely real buyers.
 * Repeat no-payment addresses (quotes >= 8 and paid = 0) move only their buyer-UA quotes into the bot side,
 * so known-UA bot quotes are not counted twice. Paid calls for the ratio are filled in by the caller from settled payers.
 */
export function quoteConversion({ botQuotes = 0, buyerQuotes = 0, ips = [] } = {}) {
    let reclass = 0, repeatIps = 0, repeatQuotes = 0;
    for (const ip of ips) {
        const q = ip.quotes || 0, paid = ip.paid || 0, bq = ip.botQuotes || 0;
        if (q >= REPEAT_NOPAY_QUOTES && paid === 0) {
            repeatIps++;
            repeatQuotes += q;
            reclass += Math.max(0, q - bq);
        }
    }
    const realQuotes = Math.max(0, buyerQuotes - reclass);
    return {
        likelyBots: { quotes: botQuotes + reclass, knownUaQuotes: botQuotes, repeatNoPayIps: repeatIps, repeatNoPayQuotes: repeatQuotes, reclassifiedFromBuyerQuotes: reclass },
        likelyRealBuyers: { quotes: realQuotes, paid: 0, quoteToPaid: null },
        note: `likelyBots adds known monitor/crawler user-agents to repeat no-payment addresses (>= ${REPEAT_NOPAY_QUOTES} quotes and zero paid calls). likelyRealBuyers.quoteToPaid uses settled payer calls reclassified off grader wallets, divided by the adjusted quote count.`
    };
}

export function renderStatsMd(s) {
    const t = s.totals;
    const lines = [
        `# GW8 Signal API — request stats`,
        ``,
        `Last **${s.days}** day(s) (${s.timezone}). Store: ${s.store}.`,
        ``,
        `## Totals (routes only; home keep-warm excluded)`,
        `- Requests: ${t.requests}`,
        `- Quotes (402): ${t.quotes}`,
        `- Paid (2xx on paid routes): ${t.paid}`,
        `- Served (2xx free): ${t.served}`,
        `- 404: ${t.notFound}`,
        `- 405: ${t.methodNotAllowed}`,
        `- 5xx: ${t.errors}`,
        `- Other: ${t.other}`,
        ``,
        `## Home keep-warm`,
        `- Requests: ${s.meta.homeKeepWarm.requests} (2xx: ${s.meta.homeKeepWarm.served})`,
        ``,
        `## Per route`,
        `| Route | Req | 402 | Paid | Served | 404 | 405 | 5xx |`,
        `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
    ];
    for (const r of s.routes) {
        lines.push(`| ${r.route} | ${r.requests} | ${r.quotes} | ${r.paid} | ${r.served} | ${r.notFound} | ${r.methodNotAllowed} | ${r.errors} |`);
    }
    if (!s.routes.length) lines.push(`| _(none yet)_ | 0 | 0 | 0 | 0 | 0 | 0 | 0 |`);
    const a = s.audience;
    if (a) {
        lines.push(``, `## Bots vs likely buyers`,
            `| Audience | Req | 402 quotes | Paid |`, `| --- | ---: | ---: | ---: |`,
            `| Likely buyer | ${a.likelyBuyer.requests} | ${a.likelyBuyer.quotes} | ${a.likelyBuyer.paid} |`,
            `| Bot / monitor | ${a.bot.requests} | ${a.bot.quotes} | ${a.bot.paid} |`,
            `| Self (own wallets) | ${a.self.requests} | ${a.self.quotes} | ${a.self.paid} |`,
            ``, `- Unique likely-buyer payers: ${a.payers.likelyBuyers} (repeat ${a.payers.repeat}, returning ${a.payers.returning}); grader wallets: ${a.payers.graderBots}; self: ${a.payers.self}`,
            `- Settled paid calls by payer (re-classified): buyer ${a.payers.settledPaidCalls.likelyBuyer}, grader ${a.payers.settledPaidCalls.grader}, self ${a.payers.settledPaidCalls.self}`,
            `- Top bots: ${a.topBots.map(b => `${b.name} ${b.requests}`).join(', ') || 'none'}`);
        const c = a.conversion;
        if (c) {
            const ratio = c.likelyRealBuyers.quoteToPaid == null ? 'n/a' : c.likelyRealBuyers.quoteToPaid.toFixed(4);
            lines.push(``, `## Quote to paid (real buyers)`,
                `- Likely-bot quotes (known user-agents + repeat no-payment): ${c.likelyBots.quotes}`,
                `- Repeat no-payment addresses: ${c.likelyBots.repeatNoPayIps} (${c.likelyBots.repeatNoPayQuotes} quotes)`,
                `- Likely real-buyer quotes: ${c.likelyRealBuyers.quotes}`,
                `- Likely real-buyer settled calls: ${c.likelyRealBuyers.paid}`,
                `- Quote-to-paid: ${ratio}`,
                `- Grader wallets: ${c.graders.wallets} (settled calls ${c.graders.settledCalls}). ${c.graders.note}`);
        }
    }
    lines.push(``, `_Generated ${s.asOf}_`);
    return lines.join('\n');
}

export function renderStatsHtml(s) {
    const t = s.totals;
    const h = s.meta.homeKeepWarm;
    const rows = s.routes.map(r => `<tr>
      <td>${esc(r.route)}</td><td>${r.requests}</td><td>${r.quotes}</td><td>${r.paid}</td>
      <td>${r.served}</td><td>${r.notFound}</td><td>${r.methodNotAllowed}</td><td>${r.errors}</td>
    </tr>`).join('') || `<tr><td colspan="8"><em>none yet</em></td></tr>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GW8 API stats</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:16px;line-height:1.4}
  h1{font-size:1.25rem;margin:0 0 8px} h2{font-size:1rem;margin:20px 0 8px;color:#94a3b8}
  .card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:12px;margin:8px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
  .n{font-size:1.4rem;font-weight:700;color:#22c55e} .l{font-size:.75rem;color:#94a3b8}
  table{width:100%;border-collapse:collapse;font-size:.85rem} th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #1f2937}
  th{color:#94a3b8;font-weight:600} td:not(:first-child),th:not(:first-child){text-align:right}
  a{color:#38bdf8} .note{font-size:.8rem;color:#64748b;margin-top:12px}
</style></head><body>
<h1>GW8 Signal API — stats</h1>
<p class="note">Last ${s.days} day(s) · ${esc(s.timezone)} · ${esc(s.store)} · ${esc(s.asOf)}</p>
<div class="card grid">
  <div><div class="n">${t.requests}</div><div class="l">Requests</div></div>
  <div><div class="n">${t.quotes}</div><div class="l">402 quotes</div></div>
  <div><div class="n">${t.paid}</div><div class="l">Paid 2xx</div></div>
  <div><div class="n">${t.served}</div><div class="l">Free 2xx</div></div>
  <div><div class="n">${t.notFound}</div><div class="l">404</div></div>
  <div><div class="n">${t.errors}</div><div class="l">5xx</div></div>
</div>
${audienceHtml(s.audience)}
<h2>Home keep-warm (excluded from totals)</h2>
<div class="card">${h.requests} hits · ${h.served} served 2xx</div>
<h2>Per route</h2>
<div class="card" style="overflow-x:auto">
<table><thead><tr>
  <th>Route</th><th>Req</th><th>402</th><th>Paid</th><th>Served</th><th>404</th><th>405</th><th>5xx</th>
</tr></thead><tbody>${rows}</tbody></table>
</div>
<p class="note">${esc(s.meta.note)} · JSON: <a href="/api/stats">/api/stats</a> · md: <a href="/api/stats?format=md">?format=md</a> · Route x status (UTC): <a href="/traffic.html">/traffic.html</a></p>
</body></html>`;
}

function audienceHtml(a) {
    if (!a) return '';
    const b = a.likelyBuyer, o = a.bot, me = a.self, p = a.payers;
    const rows = a.routes.filter(r => r.likelyBuyer.requests || r.bot.quotes || r.likelyBuyer.paid).slice(0, 25).map(r => `<tr><td>${esc(r.route)}</td><td>${r.likelyBuyer.quotes}</td><td>${r.likelyBuyer.paid}</td><td>${r.bot.quotes}</td><td>${r.bot.paid}</td></tr>`).join('') || `<tr><td colspan="5"><em>none yet</em></td></tr>`;
    return `<h2>Likely buyers vs bots</h2>
<div class="card grid">
  <div><div class="n">${b.quotes}</div><div class="l">Buyer 402 quotes</div></div>
  <div><div class="n">${b.paid}</div><div class="l">Buyer paid calls</div></div>
  <div><div class="n">${p.likelyBuyers}</div><div class="l">Unique buyer payers</div></div>
  <div><div class="n">${p.returning}</div><div class="l">Returning payers</div></div>
  <div><div class="n" style="color:#94a3b8">${o.quotes}</div><div class="l">Bot 402 quotes</div></div>
  <div><div class="n" style="color:#94a3b8">${o.paid}</div><div class="l">Bot / grader paid</div></div>
  <div><div class="n" style="color:#94a3b8">${me.paid}</div><div class="l">Self paid (seeding)</div></div>
</div>
<div class="card" style="font-size:.8rem">Repeat payers: ${p.repeat} · grader wallets: ${p.graderBots} · self wallets: ${p.self}<br>Settled paid calls by payer: buyer ${p.settledPaidCalls.likelyBuyer} · grader ${p.settledPaidCalls.grader} · self ${p.settledPaidCalls.self}<br>Top bots: ${esc(a.topBots.map(x => `${x.name} ${x.requests}`).join(', ') || 'none')}</div>
${conversionHtml(a)}
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Route</th><th>Buyer 402</th><th>Buyer paid</th><th>Bot 402</th><th>Bot paid</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">${esc(a.method)}</p>`;
}

function conversionHtml(a) {
    const c = a && a.conversion;
    if (!c) return '';
    const ratio = c.likelyRealBuyers.quoteToPaid == null ? 'n/a' : c.likelyRealBuyers.quoteToPaid.toFixed(4);
    return `<h2>Quote to paid (likely real buyers)</h2>
<div class="card grid">
  <div><div class="n">${c.likelyBots.quotes}</div><div class="l">Likely-bot quotes</div></div>
  <div><div class="n">${c.likelyRealBuyers.quotes}</div><div class="l">Real-buyer quotes</div></div>
  <div><div class="n">${c.likelyRealBuyers.paid}</div><div class="l">Real-buyer paid</div></div>
  <div><div class="n">${esc(ratio)}</div><div class="l">Quote-to-paid</div></div>
</div>
<p class="note">Repeat no-payment addresses: ${c.likelyBots.repeatNoPayIps}. Grader wallets: ${c.graders.wallets} (settled calls ${c.graders.settledCalls}). ${esc(c.graders.note)}</p>`;
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- Traffic report: route template x HTTP status x UTC day ----------
// Separate from the Mountain Time audience counters above. Answers "which paths did the 62k requests hit?"
// without storing IPs, headers, bodies, or payment payloads. Daily rollups use the same Upstash Redis when
// configured (key gw8:traffic:v1:<YYYY-MM-DD>, 35-day TTL). sinceBoot is this process only.
export const TRAFFIC_TOKEN_ENV = 'TRAFFIC_REPORT_TOKEN';
export const TRAFFIC_LIMITS = { maxRoutes: 400, maxProbes: 50, maxDays: 35, probeLength: 80, maxRedisFields: 4000, top: 20 };
const TRAFFIC_PREFIX = 'gw8:traffic:v1:';
const TRAFFIC_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const SURFACES = ['x402', 'rapidapi', 'public', 'unmatched'];
const trafficExpire = new Set();
const redisTarget = new Map(); // utc day -> Map of hash field -> field actually incremented (overflow remap)
const trafficDays = new Map();

function emptyTraffic() {
    return { routes: new Map(), surfaces: new Map(), probes: new Map(), probeOverflow: 0, routeOverflow: 0 };
}
const bootStore = emptyTraffic();
let bootStartedAt = new Date().toISOString();

export function utcDate(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

function trafficMethod(method) {
    const m = String(method || 'GET').toUpperCase();
    return TRAFFIC_METHODS.has(m) ? m : 'OTHER';
}

function cleanPath(rawPath) {
    let p = String(rawPath || '/').split('?')[0].split('#')[0];
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    p = p.replace(/\/{2,}/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    return p;
}

/** Route template for the traffic report. null = do not record (the report's own URLs). */
export function normalizeTrafficRoute(method, rawPath) {
    const legacy = normalizeRoute(method, rawPath);
    if (!legacy) return null;
    const m = trafficMethod(method);
    const cleaned = cleanPath(rawPath);
    const bare = cleaned.match(/^\/mkt\/(rapidapi|apify)$/i);
    if (bare) return `${m} /mkt/${bare[1].toLowerCase()}`;
    const legacyPath = pathOf(legacy);
    const star = legacyPath.match(/^\/mkt\/(rapidapi|apify)\/\*$/);
    if (!star) return `${m} ${legacyPath}`;
    const channel = star[1];
    const rest = cleaned.replace(new RegExp(`^/mkt/${channel}`, 'i'), '') || '/';
    const asApi = '/api' + (rest.startsWith('/') ? rest : '/' + rest);
    const api = normalizeRoute(method, asApi);
    const apiPath = api ? pathOf(api) : 'other';
    if (!api || apiPath === 'other') return `${m} /mkt/${channel}/*`;
    const suffix = apiPath.replace(/^\/api/, '') || '/';
    return `${m} /mkt/${channel}${suffix}`;
}

/** x402 paid /api routes, the RapidAPI gateway, free/public pages, or unmatched (no template). */
export function surfaceOf(routePath) {
    const p = String(routePath || '');
    if (p === 'other') return 'unmatched';
    if (p === '/mkt/rapidapi' || p === '/mkt/rapidapi/*' || p.startsWith('/mkt/rapidapi/')) return 'rapidapi';
    if (PAID_PATHS.has(p)) return 'x402';
    return 'public';
}

function statusKey(code) {
    const c = Number(code);
    if (!Number.isInteger(c) || c < 100 || c > 599) return 'other';
    return String(c);
}

/**
 * Raw unmatched path for the probe list. Query/hash stripped, truncated, secrets/ids/emails/IPs redacted.
 * Not used as a lookup key for anything except this capped display list.
 */
export function sanitizeProbe(rawPath) {
    let p = String(rawPath || '/').split('?')[0].split('#')[0];
    try { p = decodeURIComponent(p); } catch { /* keep the raw slice */ }
    p = p.replace(/[\u0000-\u001f\u007f]/g, '');
    p = p.replace(/\\/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    p = p.replace(/\/{2,}/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}/g, ':redacted');
    p = p.replace(/(api[_-]?key|secret|token|bearer|password|passwd|authorization)[=:][^/?#\s]*/gi, '$1=:redacted');
    p = p.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ':email');
    p = p.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ':ip');
    p = p.replace(/\b(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\b/gi, ':ip');
    p = p.replace(/0x[a-fA-F0-9]{8,}/g, ':hex');
    // Per path segment only. A slash must stay so /wp-admin/... remains visible.
    p = p.replace(/[A-Za-z0-9+=_-]{20,}/g, ':redacted');
    p = p.replace(/\|/g, '/');
    if (p.length > TRAFFIC_LIMITS.probeLength) p = p.slice(0, TRAFFIC_LIMITS.probeLength);
    return p || '/';
}

function addCount(map, key, status, n) {
    let m = map.get(key);
    if (!m) { m = new Map(); map.set(key, m); }
    m.set(status, (m.get(status) || 0) + n);
}

function bumpRoute(store, route, status) {
    if (store.routes.has(route)) { addCount(store.routes, route, status, 1); return true; }
    if (store.routes.size >= TRAFFIC_LIMITS.maxRoutes) { store.routeOverflow += 1; return false; }
    addCount(store.routes, route, status, 1);
    return true;
}

function bumpSurface(store, surface, status) {
    addCount(store.surfaces, surface, status, 1);
}

function bumpProbe(store, probe) {
    if (store.probes.has(probe)) { store.probes.set(probe, store.probes.get(probe) + 1); return true; }
    if (store.probes.size >= TRAFFIC_LIMITS.maxProbes) { store.probeOverflow += 1; return false; }
    store.probes.set(probe, 1);
    return true;
}

function dayStore(day) {
    let s = trafficDays.get(day);
    if (!s) {
        s = emptyTraffic();
        trafficDays.set(day, s);
        while (trafficDays.size > TRAFFIC_LIMITS.maxDays) {
            const oldest = [...trafficDays.keys()].sort()[0];
            trafficDays.delete(oldest);
            redisTarget.delete(oldest);
        }
    }
    return s;
}

/** Count one finished request. Never throws. Returns the traffic route key, or null when skipped. */
export function recordTraffic(method, rawPath, statusCode) {
    const route = normalizeTrafficRoute(method, rawPath);
    if (!route) return null;
    const status = statusKey(statusCode);
    const surface = surfaceOf(pathOf(route));
    const probe = surface === 'unmatched' ? sanitizeProbe(rawPath) : null;
    const day = utcDate();
    bumpRoute(bootStore, route, status);
    bumpSurface(bootStore, surface, status);
    if (probe) bumpProbe(bootStore, probe);
    const dayHit = dayStore(day);
    const routeStored = bumpRoute(dayHit, route, status);
    bumpSurface(dayHit, surface, status);
    const probeStored = probe ? bumpProbe(dayHit, probe) : false;
    if (hasRedis()) {
        persistTraffic(day, route, status, surface, probe, routeStored, probeStored)
            .catch(e => console.error('[stats] traffic redis failed', e && e.message));
    }
    return route;
}

async function hincr(key, day, field) {
    let mapped = redisTarget.get(day);
    if (!mapped) { mapped = new Map(); redisTarget.set(day, mapped); }
    let target = mapped.get(field);
    if (!target) {
        target = field;
        let exists = 0;
        try { exists = await redis(['HEXISTS', key, field]); } catch { exists = 0; }
        if (!exists) {
            let len = 0;
            try { len = Number(await redis(['HLEN', key])) || 0; } catch { len = 0; }
            if (len >= TRAFFIC_LIMITS.maxRedisFields && !field.startsWith('s|') && !field.startsWith('o|')) {
                target = field.startsWith('p|') ? 'o|probes' : 'o|routes';
            }
        }
        mapped.set(field, target);
    }
    await redis(['HINCRBY', key, target, 1]);
}

async function persistTraffic(day, route, status, surface, probe, routeStored, probeStored) {
    const key = TRAFFIC_PREFIX + day;
    await hincr(key, day, routeStored ? `r|${route}|${status}` : 'o|routes');
    await hincr(key, day, `s|${surface}|${status}`);
    if (probe) await hincr(key, day, probeStored ? `p|${encodeURIComponent(probe)}` : 'o|probes');
    if (!trafficExpire.has(day)) {
        trafficExpire.add(day);
        try { await redis(['EXPIRE', key, TTL_SEC]); } catch { /* ignore */ }
    }
}

function countMap(m) {
    const byStatus = {};
    let requests = 0;
    for (const [st, n] of m) {
        const c = Number(n) || 0;
        if (c <= 0) continue;
        byStatus[st] = c;
        requests += c;
    }
    return { requests, byStatus };
}

function capMap(map, max, overflowName, store) {
    if (map.size <= max) return;
    const ranked = [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const keep = ranked.slice(0, max);
    const drop = ranked.slice(max);
    map.clear();
    for (const [k, n] of keep) map.set(k, n);
    const extra = drop.reduce((s, [, n]) => s + (Number(n) || 0), 0);
    store[overflowName] += extra;
}

function summarize(store) {
    const view = { probes: new Map(store.probes), probeOverflow: store.probeOverflow, routeOverflow: store.routeOverflow };
    capMap(view.probes, TRAFFIC_LIMITS.maxProbes, 'probeOverflow', view);
    const surfaces = {};
    let requests = 0;
    const byStatus = {};
    for (const name of SURFACES) {
        const c = countMap(store.surfaces.get(name) || new Map());
        surfaces[name] = c;
        requests += c.requests;
        for (const [st, n] of Object.entries(c.byStatus)) byStatus[st] = (byStatus[st] || 0) + n;
    }
    const routes = [...store.routes.entries()].map(([route, m]) => ({ route, ...countMap(m) }))
        .sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route));
    const top = (code) => routes
        .map(r => ({ route: r.route, count: r.byStatus[code] || 0 }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route))
        .slice(0, TRAFFIC_LIMITS.top);
    const unmatchedProbes = [...view.probes.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
        .slice(0, TRAFFIC_LIMITS.top);
    return {
        requests,
        byStatus,
        surfaces,
        routes,
        topRoutes: { '200': top('200'), '402': top('402'), '404': top('404') },
        unmatchedProbes,
        probesTracked: view.probes.size,
        probeOverflow: view.probeOverflow,
        routeOverflow: view.routeOverflow,
    };
}

function utcDays(n) {
    const out = [];
    const start = Date.parse(utcDate() + 'T00:00:00Z');
    for (let i = 0; i < n; i++) out.push(utcDate(new Date(start - i * 86400000)));
    return out;
}

function clampDays(days, fallback) {
    const n = parseInt(days, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(30, n));
}

function acceptableStatus(st) {
    return st === 'other' || /^[1-5][0-9]{2}$/.test(st);
}

function parseTrafficHash(flat) {
    const store = emptyTraffic();
    for (const [field, n] of toMap(flat)) {
        if (!(n > 0) || typeof field !== 'string') continue;
        const i = field.indexOf('|');
        if (i < 1) continue;
        const kind = field.slice(0, i);
        const rest = field.slice(i + 1);
        if (kind === 'o') {
            if (rest === 'probes') store.probeOverflow += n;
            else if (rest === 'routes' || rest === 'dropped') store.routeOverflow += n;
            continue;
        }
        if (kind === 's') {
            const j = rest.lastIndexOf('|');
            if (j < 1) continue;
            const surface = rest.slice(0, j);
            const status = rest.slice(j + 1);
            if (!SURFACES.includes(surface) || !acceptableStatus(status)) continue;
            addCount(store.surfaces, surface, status, n);
            continue;
        }
        if (kind === 'r') {
            const j = rest.lastIndexOf('|');
            if (j < 1) continue;
            const route = rest.slice(0, j);
            const status = rest.slice(j + 1);
            if (!acceptableStatus(status) || route.length > 160 || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|OTHER) \//.test(route)) continue;
            if (store.routes.size >= TRAFFIC_LIMITS.maxRoutes && !store.routes.has(route)) { store.routeOverflow += n; continue; }
            addCount(store.routes, route, status, n);
            continue;
        }
        if (kind === 'p') {
            let path = rest;
            try { path = decodeURIComponent(rest); } catch { /* keep */ }
            const clean = sanitizeProbe(path);
            if (store.probes.size >= TRAFFIC_LIMITS.maxProbes && !store.probes.has(clean)) { store.probeOverflow += n; continue; }
            store.probes.set(clean, (store.probes.get(clean) || 0) + n);
        }
    }
    return store;
}

async function loadTrafficDay(day) {
    if (hasRedis()) {
        try {
            const flat = await redis(['HGETALL', TRAFFIC_PREFIX + day]);
            return parseTrafficHash(flat);
        } catch (e) {
            console.error('[stats] traffic redis read failed, using memory', e && e.message);
        }
    }
    return trafficDays.get(day) || emptyTraffic();
}

export function trafficGateEnabled() {
    return String(process.env[TRAFFIC_TOKEN_ENV] || '').trim().length > 0;
}

/** Public when TRAFFIC_REPORT_TOKEN is unset. Otherwise Authorization: Bearer must match. Query tokens are ignored. */
export function trafficAuthorized(req) {
    const expected = String(process.env[TRAFFIC_TOKEN_ENV] || '').trim();
    if (!expected) return true;
    const header = String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    const given = m ? m[1].slice(0, 512) : '';
    if (expected.length > 512) return false;
    const a = crypto.createHash('sha256').update(expected).digest();
    const b = crypto.createHash('sha256').update(given).digest();
    return crypto.timingSafeEqual(a, b);
}

export async function getTrafficReport(days = 7) {
    const n = clampDays(days, 7);
    const dates = utcDays(n);
    const daily = [];
    for (const date of dates) daily.push({ date, ...summarize(await loadTrafficDay(date)) });
    const redisOn = hasRedis();
    return {
        asOf: new Date().toISOString(),
        timezone: 'UTC',
        startedAt: bootStartedAt,
        store: redisOn ? 'upstash-redis' : 'memory',
        access: {
            mode: trafficGateEnabled() ? 'token' : 'public',
            env: TRAFFIC_TOKEN_ENV,
            note: trafficGateEnabled()
                ? 'Authorization: Bearer must match TRAFFIC_REPORT_TOKEN. The token is not included in this report. Query strings are not accepted.'
                : 'Public, same sensitivity as /api/stats. Set TRAFFIC_REPORT_TOKEN in the Render environment to require Authorization: Bearer. Do not commit the value and do not pass it as a query parameter.',
        },
        days: n,
        dates,
        sinceBoot: summarize(bootStore),
        daily,
        limits: { maxRoutes: TRAFFIC_LIMITS.maxRoutes, maxProbes: TRAFFIC_LIMITS.maxProbes, probeLength: TRAFFIC_LIMITS.probeLength },
        reset: {
            sinceBoot: 'In-memory for this process only. Clears when the Render service restarts, redeploys, or sleeps (free instances spin down).',
            daily: redisOn
                ? 'Per-UTC-day rollups are in Upstash Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), key prefix gw8:traffic:v1:, kept about 35 days. They survive a restart. sinceBoot does not, so a day total can be higher than sinceBoot after a restart.'
                : 'Upstash Redis is not configured, so daily rollups are in-memory and clear on restart, same as sinceBoot.',
        },
        note: 'Counts are normalized route templates (ids collapsed, query strings dropped) by HTTP status and UTC day. Surfaces: x402 = paid /api routes, rapidapi = /mkt/rapidapi, public = free pages, free /api routes, MCP, and /mkt/apify, unmatched = no template (scanner probes). GET / is included and picks up platform keep-warm pings (the audience report still parks those under meta.homeKeepWarm). Unmatched paths are truncated and sanitized; once 50 distinct paths are stored, further new paths increment probeOverflow without the raw path. /api/traffic, /traffic.html, /api/stats and /stats.html are not counted. No IPs, headers, bodies, or payment payloads are stored.',
    };
}

function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

function statusCells(by) {
    const b = by || {};
    return `<td>${fmt(b['200'])}</td><td>${fmt(b['402'])}</td><td>${fmt(b['404'])}</td>`;
}

function topTable(rows, empty) {
    if (!rows || !rows.length) return `<p class="note">${empty}</p>`;
    return `<table><thead><tr><th>Route</th><th>Count</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.route)}</td><td>${fmt(r.count)}</td></tr>`).join('')}</tbody></table>`;
}

export function renderTrafficHtml(report) {
    const s = report.sinceBoot;
    const surfRows = SURFACES.map(name => {
        const c = s.surfaces[name] || { requests: 0, byStatus: {} };
        const label = name === 'x402' ? 'x402 /api' : name === 'rapidapi' ? 'RapidAPI /mkt/rapidapi' : name === 'public' ? 'free / public' : 'unmatched';
        return `<tr><td>${label}</td><td>${fmt(c.requests)}</td>${statusCells(c.byStatus)}</tr>`;
    }).join('');
    const routeRows = s.routes.slice(0, 40).map(r => `<tr><td>${esc(r.route)}</td><td>${fmt(r.requests)}</td>${statusCells(r.byStatus)}</tr>`).join('')
        || `<tr><td colspan="5"><em>none yet</em></td></tr>`;
    const probes = s.unmatchedProbes.map(p => `<tr><td><code>${esc(p.path)}</code></td><td>${fmt(p.count)}</td></tr>`).join('')
        || `<tr><td colspan="2"><em>none yet</em></td></tr>`;
    const dayRows = report.daily.map(d => `<tr><td>${esc(d.date)}</td><td>${fmt(d.requests)}</td>${statusCells(d.byStatus)}<td>${fmt(d.surfaces.x402.requests)}</td><td>${fmt(d.surfaces.rapidapi.requests)}</td><td>${fmt(d.surfaces.public.requests)}</td><td>${fmt(d.surfaces.unmatched.requests)}</td><td>${fmt(d.unmatchedProbes.length)}</td></tr>`).join('');
    const dayDetail = report.daily.map(d => `<h2>${esc(d.date)} UTC</h2>
<div class="card"><p>${fmt(d.requests)} requests · showing ${d.unmatchedProbes.length} of ${fmt(d.probesTracked)} tracked probe paths${d.probeOverflow ? ` · ${fmt(d.probeOverflow)} unmatched requests not stored as paths` : ''}</p>
<div class="cols">
  <div><h3>Top 200</h3>${topTable(d.topRoutes['200'], 'No 200s.')}</div>
  <div><h3>Top 402</h3>${topTable(d.topRoutes['402'], 'No 402s.')}</div>
  <div><h3>Top 404</h3>${topTable(d.topRoutes['404'], 'No 404s.')}</div>
</div>
${d.unmatchedProbes.length ? `<h3>Unmatched probes</h3><table><thead><tr><th>Path</th><th>Count</th></tr></thead><tbody>${d.unmatchedProbes.map(p => `<tr><td><code>${esc(p.path)}</code></td><td>${fmt(p.count)}</td></tr>`).join('')}</tbody></table>` : ''}
</div>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>GW8 traffic</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e2e8f0;margin:0;padding:16px;line-height:1.45}
  h1{font-size:1.25rem;margin:0 0 8px} h2{font-size:1rem;margin:22px 0 8px;color:#94a3b8} h3{font-size:.85rem;margin:12px 0 6px;color:#cbd5e1}
  .card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:12px;margin:8px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
  .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
  .n{font-size:1.4rem;font-weight:700;color:#22c55e} .l{font-size:.75rem;color:#94a3b8}
  table{width:100%;border-collapse:collapse;font-size:.85rem} th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #1f2937;vertical-align:top}
  th{color:#94a3b8;font-weight:600} td:not(:first-child),th:not(:first-child){text-align:right}
  a{color:#38bdf8} code{font-size:.8rem;word-break:break-all} .note{font-size:.8rem;color:#94a3b8}
</style></head><body>
<h1>GW8 request traffic</h1>
<p class="note">UTC · ${esc(report.store)} · process started ${esc(report.startedAt)} · ${esc(report.asOf)}</p>
<p><a href="?days=1">1 day</a> · <a href="?days=7">7 days</a> · <a href="?days=30">30 days</a> · <a href="/api/traffic?days=${report.days}">JSON</a> · <a href="/stats.html">audience stats</a></p>
<div class="card"><p class="note"><strong>Reset.</strong> ${esc(report.reset.sinceBoot)} ${esc(report.reset.daily)}</p>
<p class="note">${esc(report.access.note)}</p></div>
<h2>Since boot</h2>
<div class="card grid">
  <div><div class="n">${fmt(s.requests)}</div><div class="l">Requests</div></div>
  <div><div class="n">${fmt(s.byStatus['200'])}</div><div class="l">200</div></div>
  <div><div class="n">${fmt(s.byStatus['402'])}</div><div class="l">402</div></div>
  <div><div class="n">${fmt(s.byStatus['404'])}</div><div class="l">404</div></div>
  <div><div class="n">${fmt(s.surfaces.unmatched.requests)}</div><div class="l">Unmatched</div></div>
</div>
<h2>Surfaces since boot</h2>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Surface</th><th>Requests</th><th>200</th><th>402</th><th>404</th></tr></thead><tbody>${surfRows}</tbody></table></div>
<h2>Top routes since boot</h2>
<div class="card cols">
  <div><h3>200</h3>${topTable(s.topRoutes['200'], 'No 200s yet.')}</div>
  <div><h3>402</h3>${topTable(s.topRoutes['402'], 'No 402s yet.')}</div>
  <div><h3>404</h3>${topTable(s.topRoutes['404'], 'No 404s yet.')}</div>
</div>
<h2>Unmatched probes since boot</h2>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Path</th><th>Count</th></tr></thead><tbody>${probes}</tbody></table>
<p class="note">${s.probeOverflow ? fmt(s.probeOverflow) + ' more unmatched requests were counted without storing the path (cap ' + TRAFFIC_LIMITS.maxProbes + '). ' : ''}Paths are truncated to ${TRAFFIC_LIMITS.probeLength} characters. Query strings, tokens, emails and IP-shaped segments are removed.</p></div>
<h2>All routes since boot</h2>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Route</th><th>Requests</th><th>200</th><th>402</th><th>404</th></tr></thead><tbody>${routeRows}</tbody></table>
<p class="note">${s.routes.length > 40 ? 'Showing 40 of ' + s.routes.length + '. Full list is in the JSON.' : ''} ${s.routeOverflow ? fmt(s.routeOverflow) + ' requests landed on routes past the ' + TRAFFIC_LIMITS.maxRoutes + ' key cap and are not listed.' : ''}</p></div>
<h2>Per day</h2>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>UTC day</th><th>Requests</th><th>200</th><th>402</th><th>404</th><th>x402</th><th>RapidAPI</th><th>public</th><th>unmatched</th><th>probe paths</th></tr></thead><tbody>${dayRows}</tbody></table></div>
${dayDetail}
<p class="note">${esc(report.note)}</p>
</body></html>`;
}

/** JSON + HTML. Not an x402 route. The middleware skips these paths. */
export function mountTrafficReport(app) {
    const send = async (req, res, html) => {
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Robots-Tag', 'noindex');
        if (!trafficAuthorized(req)) {
            res.set('WWW-Authenticate', 'Bearer');
            return html
                ? res.status(401).type('text').send('unauthorized')
                : res.status(401).json({ error: 'unauthorized' });
        }
        try {
            const report = await getTrafficReport(req.query && req.query.days);
            if (html) return res.type('html').send(renderTrafficHtml(report));
            return res.json(report);
        } catch (e) {
            console.error('[stats] traffic report failed', e && e.message);
            return html
                ? res.status(503).type('text').send('Traffic report temporarily unavailable, retry shortly.')
                : res.status(503).json({ error: 'traffic report unavailable, retry shortly' });
        }
    };
    app.get('/api/traffic', (req, res, next) => { send(req, res, false).catch(next); });
    app.get('/traffic.html', (req, res, next) => { send(req, res, true).catch(next); });
}

export function _resetTrafficForTests() {
    bootStartedAt = new Date().toISOString();
    bootStore.routes.clear();
    bootStore.surfaces.clear();
    bootStore.probes.clear();
    bootStore.probeOverflow = 0;
    bootStore.routeOverflow = 0;
    trafficDays.clear();
    trafficExpire.clear();
    redisTarget.clear();
}
