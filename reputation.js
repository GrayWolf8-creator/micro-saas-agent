// reputation.js — x402 seller reputation check for AI agents: "is this seller real before my agent pays it?"
// Reads public USDC (Base) transfer history for a seller wallet from a keyless explorer API (Blockscout, no API key),
// optionally resolving the wallet from an x402 endpoint's unpaid 402 challenge (payTo). Scores it 0-100 with a fixed,
// documented formula (scoreReputation is pure: same transfers + same `now` => same result). Stateless: the queried
// address/endpoint is not stored or logged. Not custody, never pays anyone, no keys. Signed receipt via trust.js buildReceipt.
import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
import { buildReceipt } from './trust.js';

export const REPUTATION_PLAN = { priceUsd: '0.01', amount: '10000' };
export const REPUTATION_ENGINE = 'gw8-seller-reputation/1';
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// Keyless Blockscout explorer for Base (Etherscan-compatible tokentx). Overridable for ops (public URL, not a secret).
export const EXPLORER_URL = (process.env.REPUTATION_EXPLORER_URL || 'https://base.blockscout.com').replace(/\/+$/, '');
export const LIMITS = {
    maxLookbackDays: 90, defaultLookbackDays: 90, maxTransfers: 1000,     // newest 1000 USDC transfers (in + out), at most 90 days back
    explorerTimeoutMs: 8000, endpointTimeoutMs: 5000, maxBodyBytes: 8 * 1024 * 1024, maxChallengeBytes: 64 * 1024,
    minPaymentAtomic: 1000n,                                              // < $0.001 USDC ignored (dust / zero-value address poisoning)
};
const DAY = 86400;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DISCLAIMER = 'Heuristic score from public on-chain USDC transfers on Base. Not a guarantee, not an audit, not financial advice; refunds can look like round-trips and new honest sellers score low. The agent and its owner stay responsible for the payment.';

// ---------- helpers ----------
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
const low = s => String(s ?? '').trim().toLowerCase();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : isObj(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
const usd = a => Number(a) / 1e6;                                  // atomic USDC (6 dp) -> USD number, display only
const share = (part, whole) => whole > 0n ? Number((part * 10000n) / whole) / 10000 : 0; // 4 dp, integer math (deterministic)
const iso = s => s == null ? null : new Date(s * 1000).toISOString();

// ---------- validation (runs before payment: bad bodies get 400, never charged) ----------
/** Returns { error } or { address, endpoint, lookbackDays, raw }. Never throws. Syntax only (no network). */
export function validateReputation(body) {
    if (!isObj(body)) return { error: 'body must be JSON {address} and/or {endpoint}' };
    const errs = [];
    const a = body.address ?? body.wallet ?? body.seller;
    const e = body.endpoint ?? body.url;
    let address = null, endpoint = null, lookbackDays = LIMITS.defaultLookbackDays;
    if (a != null && a !== '') {
        if (typeof a !== 'string' || !ADDR.test(a.trim())) errs.push('address must be a 0x-prefixed 40-hex-char Base (EVM) address');
        else address = a.trim().toLowerCase();
    }
    if (e != null && e !== '') {
        const v = checkEndpointSyntax(e);
        if (v.error) errs.push(v.error); else endpoint = v.url;
    }
    if (!errs.length && !address && !endpoint) errs.push('address (seller wallet on Base) or endpoint (x402 https URL) is required');
    if (body.lookbackDays != null) {
        const n = body.lookbackDays;
        if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxLookbackDays) errs.push(`lookbackDays must be an integer 1-${LIMITS.maxLookbackDays}`);
        else lookbackDays = n;
    }
    if (errs.length) return { error: errs.join('; ') };
    return { address, endpoint, lookbackDays, raw: { address: a ?? null, endpoint: e ?? null, lookbackDays: body.lookbackDays ?? null } };
}

// ---------- SSRF guard for the endpoint probe ----------
function privateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
}
/** https only, default port, no credentials, no IP literals, no localhost/internal names. Syntax only. */
export function checkEndpointSyntax(e) {
    if (typeof e !== 'string' || e.length > 500) return { error: 'endpoint must be an https URL string (max 500 chars)' };
    let u; try { u = new URL(e.trim()); } catch { return { error: 'endpoint must be a valid https URL' }; }
    if (u.protocol !== 'https:') return { error: 'endpoint must use https' };
    if (u.username || u.password) return { error: 'endpoint must not contain credentials' };
    if (u.port && u.port !== '443') return { error: 'endpoint must use the default https port' };
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(h)) return { error: 'endpoint must use a public hostname, not an IP address' };
    if (!h.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|onion)$/.test(h)) return { error: 'endpoint must use a public hostname' };
    u.hash = '';
    return { url: u.toString(), host: h };
}
async function assertPublicHost(host) {
    const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    if (!addrs.length || addrs.some(x => privateIp(x.address))) throw new Error('endpoint host resolves to a non-public address');
}
async function readCapped(r, cap) {
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (!reader) return '';
    let n = 0; const parts = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > cap) { try { await reader.cancel(); } catch {} throw new Error('response too large'); } parts.push(value); }
    return Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf8');
}

// ---------- x402 challenge -> payTo ----------
/** Pull Base-USDC payTo addresses out of an x402 402 response (v2 PAYMENT-REQUIRED header or v1 JSON body). Pure. */
export function payToFromChallenge(headerB64, bodyText) {
    const docs = [];
    if (headerB64) { try { docs.push(JSON.parse(Buffer.from(String(headerB64), 'base64').toString('utf8'))); } catch {} }
    if (bodyText) { try { docs.push(JSON.parse(bodyText)); } catch {} }
    const out = [];
    for (const d of docs) for (const a of (isObj(d) && Array.isArray(d.accepts) ? d.accepts : [])) {
        if (!isObj(a) || typeof a.payTo !== 'string' || !ADDR.test(a.payTo)) continue;
        const netOk = ['eip155:8453', 'base', 'base-mainnet'].includes(low(a.network));
        const assetOk = !a.asset || low(a.asset) === USDC_BASE;
        if (netOk && assetOk) out.push({ payTo: a.payTo.toLowerCase(), amount: a.amount ?? a.maxAmountRequired ?? null, network: a.network });
    }
    const seen = new Set();
    return out.filter(x => !seen.has(x.payTo) && seen.add(x.payTo));
}
/** Unpaid probe of an x402 endpoint (GET, then empty POST). Never sends a payment header. No redirects followed. */
export async function resolveEndpoint(url, f = fetch) {
    const { host } = checkEndpointSyntax(url);
    await assertPublicHost(host);
    for (const method of ['GET', 'POST']) {
        const r = await f(url, { method, redirect: 'manual', headers: { accept: 'application/json', 'user-agent': 'GW8-Seller-Reputation/1 (+https://micro-saas-agent.onrender.com)' }, signal: AbortSignal.timeout(LIMITS.endpointTimeoutMs) });
        if (r.status !== 402) { try { await r.body?.cancel(); } catch {} continue; }
        const body = await readCapped(r, LIMITS.maxChallengeBytes).catch(() => '');
        const list = payToFromChallenge(r.headers.get('payment-required'), body);
        if (list.length) return { host, method, payTo: list[0].payTo, price: list[0].amount, otherPayTo: list.slice(1).map(x => x.payTo) };
    }
    return { host, payTo: null };
}

// ---------- data source: Blockscout (keyless, Etherscan-compatible) ----------
async function explorerJson(params, f) {
    const q = new URLSearchParams({ module: 'account', action: 'tokentx', contractaddress: USDC_BASE, ...params });
    const r = await f(`${EXPLORER_URL}/api?${q}`, { headers: { accept: 'application/json', 'user-agent': 'GW8-Seller-Reputation/1' }, signal: AbortSignal.timeout(LIMITS.explorerTimeoutMs) });
    if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
    const j = JSON.parse(await readCapped(r, LIMITS.maxBodyBytes));
    if (j && Array.isArray(j.result)) return j.result;                       // status "1" OK, or "0" "No token transfers found" with []
    throw new Error('explorer returned no result list');
}
/** Normalize explorer rows to {from, to, value (BigInt atomic), ts (unix s), hash}. Only canonical USDC (lookalike tokens dropped). Pure. */
export function normalizeTransfers(rows) {
    const out = [];
    for (const t of rows || []) {
        if (!t || low(t.contractAddress) !== USDC_BASE) continue;
        if (!ADDR.test(t.from || '') || !ADDR.test(t.to || '') || !/^\d{1,40}$/.test(String(t.value)) || !/^\d{1,12}$/.test(String(t.timeStamp))) continue;
        out.push({ from: low(t.from), to: low(t.to), value: BigInt(t.value), ts: Number(t.timeStamp), hash: low(t.hash) });
    }
    return out;
}
/** Newest LIMITS.maxTransfers USDC transfers (in+out) + the address's first-ever USDC transfer. Throws if the source is unavailable. */
export async function fetchSellerTransfers(address, f = fetch) {
    const [recent, first] = await Promise.all([
        explorerJson({ address, sort: 'desc', page: '1', offset: String(LIMITS.maxTransfers) }, f),
        explorerJson({ address, sort: 'asc', page: '1', offset: '1' }, f),
    ]);
    const firstRow = normalizeTransfers(first)[0];
    return { transfers: normalizeTransfers(recent), rawCount: recent.length, firstActivityTs: firstRow ? firstRow.ts : null, source: `${EXPLORER_URL} (Blockscout, keyless) tokentx USDC ${USDC_BASE}` };
}

// ---------- scoring (pure + deterministic) ----------
// Points (max 100):
//   distinctBuyers  max 30: organic distinct payers 0->0, 1->5, 2-4->12, 5-9->20, 10-24->25, >=25->30
//   washShare       max 25: round(25 * (1 - washShare)); washShare = share of incoming USDC volume from self-transfers or
//                           from payers the seller also paid in the window (round-trips). 0 if no incoming payments.
//   walletAge       max 15: days since first-ever USDC transfer 0-6->0, 7-29->5, 30-89->10, 90-179->12, >=180->15
//   concentration   max 20: round(20 * clamp(1 - (topPayerShare - 0.2) / 0.8, 0, 1)); top payer share of organic volume
//   volume30d       max 10: organic incoming USD in last 30d 0->0, >0->3, >=1->5, >=10->7, >=100->10
// Verdict: unknown if no qualifying payments in the window; avoid if score < 40, washShare >= 0.5 or payTo mismatch;
//          trusted if score >= 70 and >= 5 organic buyers and wallet age >= 30d; otherwise caution.
const tier = (v, steps) => { let p = 0; for (const [min, pts] of steps) if (v >= min) p = pts; return p; };
export const BUYER_STEPS = [[1, 5], [2, 12], [5, 20], [10, 25], [25, 30]];
export const AGE_STEPS = [[7, 5], [30, 10], [90, 12], [180, 15]];
export const VOL_STEPS = [[0.000001, 3], [1, 5], [10, 7], [100, 10]];

export function scoreReputation({ address, transfers, firstActivityTs = null, now, lookbackDays = LIMITS.defaultLookbackDays, truncated = false, payToMismatch = false }) {
    const nowS = Math.floor(new Date(now).getTime() / 1000);
    const since = nowS - Math.min(lookbackDays, LIMITS.maxLookbackDays) * DAY, since30 = nowS - 30 * DAY;
    const seller = low(address);
    const win = transfers.filter(t => t.ts >= since && t.ts <= nowS);
    const incoming = win.filter(t => t.to === seller && t.value >= LIMITS.minPaymentAtomic);
    const ignoredDust = win.filter(t => t.to === seller && t.value < LIMITS.minPaymentAtomic).length;
    const paidOutTo = new Set(win.filter(t => t.from === seller && t.to !== seller).map(t => t.to));

    const byPayer = new Map();
    for (const t of incoming) {
        const p = byPayer.get(t.from) || { payer: t.from, count: 0, volume: 0n, v30: 0n, self: t.from === seller, roundTrip: paidOutTo.has(t.from) };
        p.count++; p.volume += t.value; if (t.ts >= since30) p.v30 += t.value; byPayer.set(t.from, p);
    }
    const payers = [...byPayer.values()];
    const wash = payers.filter(p => p.self || p.roundTrip), organic = payers.filter(p => !p.self && !p.roundTrip);
    const sum = (xs, k) => xs.reduce((s, x) => s + x[k], 0n);
    const totalVol = sum(payers, 'volume'), washVol = sum(wash, 'volume'), orgVol = sum(organic, 'volume'), org30 = sum(organic, 'v30');
    const washShare = share(washVol, totalVol);
    organic.sort((a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : a.payer < b.payer ? -1 : 1));
    const top = organic[0] || null, topShare = top ? share(top.volume, orgVol) : null;
    const orgCount = organic.reduce((s, p) => s + p.count, 0);
    const topCountShare = top && orgCount ? Math.round((top.count / orgCount) * 10000) / 10000 : null;
    const ageDays = firstActivityTs != null ? Math.max(0, Math.floor((nowS - firstActivityTs) / DAY)) : null;

    const pts = {
        distinctBuyers: tier(organic.length, BUYER_STEPS),
        washShare: incoming.length ? Math.round(25 * (1 - washShare)) : 0,
        walletAge: ageDays == null ? 0 : tier(ageDays, AGE_STEPS),
        concentration: topShare == null ? 0 : Math.round(20 * Math.min(1, Math.max(0, 1 - (topShare - 0.2) / 0.8))),
        volume30d: tier(usd(org30), VOL_STEPS),
    };
    const score = Object.values(pts).reduce((a, b) => a + b, 0);

    const reasons = [], flags = [];
    if (!incoming.length) reasons.push(`no USDC payments (>= $0.001) to this address in the last ${lookbackDays}d`);
    if (organic.length < 5 && incoming.length) reasons.push(`only ${organic.length} distinct organic paying buyer(s)`);
    if (wash.some(p => p.self)) { flags.push('self_transfers'); reasons.push('incoming USDC from the seller itself (self-transfer) counted as wash'); }
    if (wash.some(p => p.roundTrip)) { flags.push('round_trips'); reasons.push(`${wash.filter(p => p.roundTrip).length} payer(s) also received USDC from the seller in the window (round-trip / possible wash or refunds)`); }
    if (washShare >= 0.5) { flags.push('wash_majority'); reasons.push(`wash share ${(washShare * 100).toFixed(1)}% of incoming volume (>= 50%)`); }
    if (topShare != null && topShare >= 0.5) reasons.push(`top payer is ${(topShare * 100).toFixed(1)}% of organic volume`);
    if (top && orgCount >= 5 && topCountShare >= 0.8) { flags.push('single_payer_repeating'); reasons.push(`one payer made ${(topCountShare * 100).toFixed(0)}% of organic payments`); }
    if (ageDays == null) reasons.push('first activity unknown');
    else if (ageDays < 30) reasons.push(`wallet first used USDC ${ageDays}d ago (< 30d)`);
    if (incoming.length && org30 === 0n) reasons.push('no organic USDC income in the last 30d');
    if (truncated) reasons.push(`only the newest ${LIMITS.maxTransfers} USDC transfers were scanned; the window may be shorter than ${lookbackDays}d`);
    if (payToMismatch) { flags.push('payto_mismatch'); reasons.push('the endpoint\'s x402 payTo does not match the address you sent'); }

    let verdict;
    if (payToMismatch || (incoming.length && (score < 40 || washShare >= 0.5))) verdict = 'avoid';
    else if (!incoming.length) verdict = 'unknown';
    else if (score >= 70 && organic.length >= 5 && ageDays != null && ageDays >= 30) verdict = 'trusted';
    else verdict = 'caution';
    if (verdict === 'trusted') reasons.unshift(`${organic.length} organic buyers, low wash, spread volume, wallet ${ageDays}d old`);

    return {
        verdict, score, maxScore: 100,
        components: {
            distinctBuyers: { value: organic.length, allPayers: payers.length, points: pts.distinctBuyers, max: 30 },
            washShare: { value: washShare, washPayers: wash.length, washVolumeUsd: usd(washVol), points: pts.washShare, max: 25 },
            walletAge: { days: ageDays, firstActivity: iso(firstActivityTs), points: pts.walletAge, max: 15 },
            concentration: { topPayerShare: topShare, topPayerPaymentShare: topCountShare, topPayer: top ? top.payer : null, points: pts.concentration, max: 20 },
            volume30d: { organicUsd: usd(org30), points: pts.volume30d, max: 10 },
        },
        reasons, flags,
        window: { lookbackDays, from: iso(since), to: iso(nowS), transfersInWindow: win.length, incomingPayments: incoming.length, totalIncomingUsd: usd(totalVol), organicIncomingUsd: usd(orgVol), ignoredDust, truncated },
    };
}

/** Signed receipt via main's buildReceipt (same Ed25519 key, /api/proof/pubkey, free /api/receipt/verify). Never throws. */
export function reputationReceipt(v, out, dataSha256) {
    const requestSha256 = sha(canon(v.raw));
    const r = buildReceipt({ endpoint: 'POST /api/seller/reputation', amount: null, tx: null, accessType: 'SELLER_REPUTATION',
        query: { type: 'gw8.seller-reputation', engine: REPUTATION_ENGINE, address: out.seller.address, endpointHost: out.seller.endpointHost, verdict: out.verdict, score: out.score,
            evaluatedFor: out.evaluatedFor, dataSha256, requestSha256 } }, out);
    return { ...r, verify: 'Free: POST /api/receipt/verify {payload, signature, data: <signal without reputationReceipt, stateless, disclaimer>} -> valid + dataMatches. Or Ed25519.verify(key from /api/proof/pubkey, utf8(payload), base64decode(signature)). query.requestSha256 = sha256 hex of canonical JSON (sorted keys, no spaces) of {address, endpoint, lookbackDays} as you sent them (null when omitted); query.dataSha256 = sha256 of the transfer list scored.' };
}

/** Evaluate an already-validated request (from validateReputation). Returns {error} when it cannot evaluate (caller does not
 *  charge), else {out, dataSha256} without a receipt. Shared by /api/seller/reputation and /api/pay/should-i-pay. */
export async function evaluateSellerReputation(v, { now = new Date(), fetchImpl = fetch, resolve = resolveEndpoint, load = fetchSellerTransfers } = {}) {
    const seller = { address: v.address, endpoint: v.endpoint, endpointHost: v.endpoint ? new URL(v.endpoint).hostname : null, payTo: null, payToSource: v.address ? 'request' : null };
    let payToMismatch = false;
    if (v.endpoint) {
        let ep;
        try { ep = await resolve(v.endpoint, fetchImpl); } catch (e) { ep = { payTo: null, err: e && e.message }; }
        if (!ep.payTo && !v.address) return { error: `verdict unknown: could not read an x402 Base-USDC payTo from the endpoint (${ep.err || 'no 402 challenge on GET or POST'}); send the seller address instead` };
        if (ep.payTo) {
            seller.payTo = ep.payTo; seller.endpointPrice = ep.price ?? null;
            if (v.address && ep.payTo !== v.address) payToMismatch = true;
            if (!v.address) { seller.address = ep.payTo; seller.payToSource = 'endpoint 402 challenge'; }
        } else seller.endpointNote = `endpoint did not return a readable x402 challenge (${ep.err || 'no 402'}); scored the address you sent`;
    }
    let data;
    try { data = await load(seller.address, fetchImpl); }
    catch (e) { return { error: `verdict unknown: public transfer data unavailable (${(e && e.message) || 'error'}), retry shortly` }; }
    const truncated = data.rawCount >= LIMITS.maxTransfers;
    const scored = scoreReputation({ address: seller.address, transfers: data.transfers, firstActivityTs: data.firstActivityTs, now, lookbackDays: v.lookbackDays, truncated, payToMismatch });
    const dataSha256 = sha(data.transfers.map(t => `${t.hash}|${t.from}|${t.to}|${t.value}|${t.ts}`).join('\n'));
    const out = { engine: REPUTATION_ENGINE, seller, ...scored, data: { source: data.source, chain: 'base', asset: 'USDC', transfersScanned: data.transfers.length, dataSha256 }, evaluatedFor: new Date(now).toISOString() };
    return { out, dataSha256 };
}

/** Full call: validate -> (resolve endpoint) -> fetch -> score -> receipt. Returns {error} when it cannot evaluate (caller does not charge). */
export async function checkSellerReputation(body, opts = {}) {
    const v = validateReputation(body);
    if (v.error) return { error: v.error };
    const r = await evaluateSellerReputation(v, opts);
    if (r.error) return { error: r.error };
    return { ...r.out, reputationReceipt: reputationReceipt(v, r.out, r.dataSha256), stateless: 'GW8 does not store the address or endpoint you check.', disclaimer: DISCLAIMER };
}

// ---------- free data-source status (GET /api/seller/reputation/status) ----------
// One tiny fixed request (newest 1 USDC transfer of the USDC contract itself, never user input), 4s timeout, 64 KB cap.
// Result cached ~60s and concurrent callers share one in-flight probe, so it can't hammer Blockscout or act as a proxy.
// Returns only {source, reachable, http_status, latency_ms, checked_at, cached, cache_ttl_s, error?}: no URL, env, or keys.
export const STATUS_TTL_MS = 60_000, STATUS_TIMEOUT_MS = 4000;
let statusCache = null, statusInflight = null;
export function _resetSourceStatusCache() { statusCache = null; statusInflight = null; }
async function probeSource(f, clock) {
    const t0 = clock();
    const q = new URLSearchParams({ module: 'account', action: 'tokentx', contractaddress: USDC_BASE, address: USDC_BASE, sort: 'desc', page: '1', offset: '1' });
    try {
        const r = await f(`${EXPLORER_URL}/api?${q}`, { headers: { accept: 'application/json', 'user-agent': 'GW8-Seller-Reputation/1 (status)' }, redirect: 'manual', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        let ok = false;
        if (r.status === 200) { try { const j = JSON.parse(await readCapped(r, LIMITS.maxChallengeBytes)); ok = !!j && Array.isArray(j.result); } catch { ok = false; } }
        else { try { await r.body?.cancel(); } catch {} }
        return { reachable: ok, http_status: r.status, latency_ms: Math.max(0, Math.round(clock() - t0)), ...(ok ? {} : { error: r.status === 200 ? 'unexpected response (not explorer JSON)' : `HTTP ${r.status}` }) };
    } catch (e) {
        const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return { reachable: false, http_status: null, latency_ms: Math.max(0, Math.round(clock() - t0)), error: timeout ? `timeout after ${STATUS_TIMEOUT_MS}ms` : 'network error' };
    }
}
/** Free status check. Never throws. Options are for tests only (not reachable from HTTP). */
export async function getSourceStatus({ fetchImpl = fetch, clock = Date.now } = {}) {
    const now = clock();
    if (statusCache && now - statusCache.at < STATUS_TTL_MS) return { ...statusCache.body, cached: true, cache_ttl_s: Math.ceil((STATUS_TTL_MS - (now - statusCache.at)) / 1000) };
    if (!statusInflight) statusInflight = (async () => {
        const p = await probeSource(fetchImpl, clock);
        const body = { source: 'blockscout', ...p, checked_at: new Date(clock()).toISOString() };
        statusCache = { at: clock(), body }; statusInflight = null;
        return body;
    })();
    const body = await statusInflight;
    return { ...body, cached: false, cache_ttl_s: Math.round(STATUS_TTL_MS / 1000) };
}
