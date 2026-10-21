// stats.js — free per-endpoint request counters. No PII: no IPs or raw headers; a user-agent is reduced to a
// fixed bot name or "buyer" (buyers.js), and payer wallets are stored only as truncated SHA-256 ids.
// Persistence: Upstash Redis REST via alerts.js helper; in-memory fallback. All keys expire (~35d) or are capped.
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
    '/api/spend/check',
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
    [/^\/api\/alerts\/[^/]+$/i, '/api/alerts/:id'],
    [/^\/api\/brief\/weekly\/[^/]+$/i, '/api/brief/weekly/:id'],
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
    '/api/spend/check',
    '/api/pass/day',
    '/api/alerts/subscribe',
    '/api/brief/weekly/subscribe',
]);

/** Skip recording entirely (self + HTML view). */
const SKIP = new Set(['/api/stats', '/stats.html', '/stats']);

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
        const day = mtDate();
        // A safe-retry replay of an already-settled payment is not a second sale: tallied as "other", not paid.
        const cls = opts.replay ? 'replay' : statusClass(statusCode);
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
const isAud = f => f.startsWith('a|') || f.startsWith('ua|');

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
export async function recordAudience({ route, statusCode, ua, payer, paidRoute, replay }) {
    try {
        if (!route) return;
        const day = mtDate();
        const c = classifyUA(ua);
        let aud = c.cls;
        const code = Number(statusCode) || 0;
        const isPaid = !replay && paidRoute && code >= 200 && code < 300;
        const pid = isPaid && payer ? payerId(payer) : null;
        if (pid) { const o = await trackPayer(day, pid, route); if (o) aud = o; }
        await bump(day, `a|${aud}|req|${route}`);
        if (code === 402) await bump(day, `a|${aud}|402|${route}`);
        if (isPaid) await bump(day, `a|${aud}|paid|${route}`);
        if (c.cls === 'bot') await bump(day, `ua|${c.name}`);
    } catch (e) { console.error('[stats] audience record failed', e && e.message); }
}

/** MCP in-band settlements (no HTTP 2xx on a paid path): count the paid call and the payer. */
export function recordMcpPaid(toolName, payer) {
    const route = `MCP ${String(toolName).replace(/[^a-z0-9_]/gi, '').slice(0, 40)}`;
    recordAudience({ route, statusCode: 200, ua: 'mcp-inband', payer, paidRoute: true }).catch(() => {});
}

/** Express middleware: tally on response finish. Place before x402 handlers. */
export function statsMiddleware(req, res, next) {
    const ua = req.headers['user-agent'];
    res.on('finish', () => {
        const replay = !!res.locals.gw8Replay;
        const route = record(req.method, req.path || req.url, res.statusCode, { replay });
        if (!route || route.endsWith(' /')) return; // home keep-warm stays out of the audience split too
        recordAudience({ route, statusCode: res.statusCode, ua, payer: res.locals.gw8Payer, paidRoute: PAID_PATHS.has(pathOf(route)), replay });
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
            note: 'GET / (keep-warm) is under meta.homeKeepWarm, not route totals. /api/stats and /stats.html are not recorded. No IPs or raw headers stored; user-agents are reduced to a known-bot name, payer wallets to truncated SHA-256 ids. audience = bot vs likely-buyer split (started with this release, so earlier days show 0).',
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
    const key = a => a === 'buyer' ? 'likelyBuyer' : a;
    const perRoute = new Map(), bots = new Map();
    for (const [f, c] of audFields) {
        const p = f.split('|');
        if (p[0] === 'ua') { bots.set(p[1], (bots.get(p[1]) || 0) + c); continue; }
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
<p class="note">${esc(s.meta.note)} · JSON: <a href="/api/stats">/api/stats</a> · md: <a href="/api/stats?format=md">?format=md</a></p>
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
<div class="card" style="overflow-x:auto"><table><thead><tr><th>Route</th><th>Buyer 402</th><th>Buyer paid</th><th>Bot 402</th><th>Bot paid</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="note">${esc(a.method)}</p>`;
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
