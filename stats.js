// stats.js — free per-endpoint request counters. No PII (no IPs, headers, wallets).
// Persistence: Upstash Redis REST via alerts.js helper; in-memory fallback.
import { redis, hasRedis } from './alerts.js';

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
    '/api/telemetry',
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
    '/api/pass/day',
    '/api/alerts/subscribe',
    '/api/sample',
    '/api/track',
    '/api/proof/pubkey',
    '/api/ingest',
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
    '/api/telemetry',
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

/** Fire-and-forget record. Never throws to caller. */
export function record(method, path, statusCode) {
    try {
        const route = normalizeRoute(method, path);
        if (!route) return;
        const day = mtDate();
        const cls = statusClass(statusCode);
        const field = `${route}|${cls}`;
        // Always bump memory so local reads work even when Redis is configured
        memIncr(day, field);
        if (!hasRedis()) return;
        redisIncr(day, field).catch(e => console.error('[stats] redis incr failed', e.message));
    } catch (e) {
        console.error('[stats] record failed', e && e.message);
    }
}

/** Express middleware: tally on response finish. Place before x402 handlers. */
export function statsMiddleware(req, res, next) {
    res.on('finish', () => {
        record(req.method, req.path || req.url, res.statusCode);
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

    for (const day of list) {
        const fields = await loadDay(day);
        for (const [field, count] of fields) {
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

    return {
        asOf: new Date().toISOString(),
        timezone: TZ,
        days: n,
        dates: list,
        store: hasRedis() ? 'upstash-redis' : 'memory',
        totals,
        routes,
        meta: {
            homeKeepWarm: home,
            note: 'GET / (keep-warm) is under meta.homeKeepWarm, not route totals. /api/stats and /stats.html are not recorded. No IPs, headers, or wallet addresses stored.',
        },
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

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
