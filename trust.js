// trust.js — conversion + trust helpers for paid x402 routes (signal only, no trading):
//  1. funnel(): extras added to every 402 (body field "gw8" + X-GW8-* / Link headers). The x402 v2 fields and the
//     PAYMENT-REQUIRED header are untouched (v2 clients read the header; the body is only parsed for v1).
//  2. Signed receipts: X-GW8-Receipt (base64url JSON) + X-GW8-Receipt-Signature (Ed25519 over the exact header
//     string, key from SIGNING_KEY via upgrades.js). Unsigned receipt still sent when SIGNING_KEY is unset.
//  3. Safe retry: the same PAYMENT-SIGNATURE replayed to the same route within 15 min returns the stored response
//     (no second verify/settle, no second charge). Concurrent duplicates share one in-flight settlement.
import crypto from 'crypto';
import { signDetached, publicKeyInfo } from './upgrades.js';

export const ORIGIN = 'https://micro-saas-agent.onrender.com';
export const TEASER_PATH = '/api/brief/teaser';
export const PASS_PATH = '/api/pass/day';
export const RECEIPT_KEY_PATH = '/.well-known/gw8-receipt-key';
export const PUBKEY_PATH = '/api/proof/pubkey';
export const VERIFY_PATH = '/api/receipt/verify';
export const TRUST_LINE = 'No charge on failure: payment settles only after your data is ready. Every paid call returns a signed receipt your agent can keep as an audit trail.';

// One line per route: what the paid call adds over the free teaser.
const ADDS = [
    [/^\/api\/agent/, 'Full regime checks + every WaveTrend band dot across 66 Kraken pairs (teaser: score, counts, top 3 symbols).'],
    [/^\/api\/brief\/weekly/, 'Pushed every Monday to your webhook: regime, top dots, 7d hit rates, RWA, federal contracts.'],
    [/^\/api\/brief/, 'Top 10 coins by dot strength with values + BTC/ETH/SOL large-print flows (teaser: top 3 symbols only).'],
    [/^\/api\/dots/, 'Every current band dot with wt1, bar time and close (teaser: top 3 symbols only).'],
    [/^\/api\/regime/, 'Raw values and the rule behind each of the 4 regime checks (teaser: score only).'],
    [/^\/api\/coin\//, 'wt1/wt2, previous values and recent band dots for this coin (cheapest paid call).'],
    [/^\/api\/history/, 'Every dot of the 90-day simulated backtest with forward moves + hit-rate tables (teaser: one headline rate).'],
    [/^\/api\/flows\//, 'Kraken large-print buy/sell totals joined with the coin\'s WaveTrend 4h state (not in the teaser).'],
    [/^\/api\/rwa/, 'Tokenized RWA TVL, 7d flows, movers, yields and top tokens (not in the teaser).'],
    [/^\/api\/govcontracts/, 'Recent federal contract awards with ticker, amount, agency and award link (not in the teaser).'],
    [/^\/api\/kraken\/listings/, 'New Kraken USD listings with volume, % since listing and WaveTrend state (not in the teaser).'],
    [/^\/api\/rules/, 'CFTC + SEC crypto rule-change rows with RIN and comment deadlines (not in the teaser).'],
    [/^\/api\/rs/, 'Strength scores and ranks for all 66 Kraken pairs plus sector scores and breadth (not in the teaser).'],
    [/^\/api\/rails/, 'Live fee and settlement comparison of Base USDC, XRPL, Tempo, Arc and card, with agent protocols and a recommended rail (not in the teaser).'],
    [/^\/api\/spend\/check/, 'allow / deny / needs_approval for your proposed payment, which rule fired, and a signed decision receipt (no free teaser; pure rule check).'],
    [/^\/api\/verdict\//, 'Token safety score 0-100 with reasons and sources (not in the teaser).'],
    [/^\/api\/pass\/day/, 'One payment, 24h of every paid data endpoint and MCP tool (fair use 2000 calls).'],
    [/^\/api\/alerts\/subscribe/, 'New green dots pushed to your webhook for 30 days (the teaser is pull-only).'],
];
export function paidAdds(url) {
    const p = (() => { try { return new URL(url, ORIGIN).pathname; } catch { return String(url || ''); } })();
    for (const [re, t] of ADDS) if (re.test(p)) return t;
    return 'Full paid data (the free teaser shows a partial live brief).';
}

/** Extras for a 402. Returns { body, headers }. */
export function funnel(url, { passUsd = '1.00', passHours = 24, passCap = 2000, noPass = false } = {}) {
    const isPass = /\/api\/pass\/day/.test(String(url));
    const bestValue = isPass
        ? { url: ORIGIN + PASS_PATH, method: 'POST', priceUsd: passUsd, note: 'This is the best-value option: one payment covers 24h of paid calls.' }
        : { url: ORIGIN + PASS_PATH, method: 'POST', priceUsd: passUsd, note: `Best value: $${passUsd} day pass = ${passHours}h of every paid data endpoint (fair use ${passCap} calls), send X-GW8-Pass instead of paying per call.${noPass ? ' Not valid for this subscription route.' : ''}` };
    const body = {
        freeTeaser: ORIGIN + TEASER_PATH,
        paidAdds: paidAdds(url),
        bestValue,
        trust: { noChargeOnFailure: 'Payment is verified, then the data is built, then settled. If the data fails or settlement fails, nothing is charged and no data is returned.', safeRetry: 'Resend the same PAYMENT-SIGNATURE to the same URL within 15 minutes to get the same response again; it is not charged twice.', receipts: `Every paid call returns a signed receipt your agent can keep as an audit trail: body field "receipt" plus X-GW8-Receipt + X-GW8-Receipt-Signature headers (Ed25519). Public key: ${ORIGIN}${PUBKEY_PATH}. Free check: ${ORIGIN}${VERIFY_PATH}` },
    };
    const headers = {
        'X-GW8-Free-Teaser': ORIGIN + TEASER_PATH,
        'X-GW8-Best-Value': `${ORIGIN}${PASS_PATH} (POST, $${passUsd}, ${passHours}h)`,
        'X-GW8-Paid-Adds': body.paidAdds.replace(/[^\x20-\x7e]/g, ''),
        'Link': `<${ORIGIN}${TEASER_PATH}>; rel="preview"; title="free teaser", <${ORIGIN}${PASS_PATH}>; rel="alternate"; title="day pass", <${ORIGIN}${RECEIPT_KEY_PATH}>; rel="describedby"; title="receipt key"`,
    };
    return { body, headers };
}

// ---------- Receipts ----------
const b64u = s => Buffer.from(s).toString('base64url');
export const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
/** Build receipt headers for a paid response body. Never throws. */
export function receiptHeaders(r, body) {
    try {
        const rec = {
            v: 1, service: 'GW8 Signal API', route: r.route, resource: r.resource,
            amount: String(r.amount), amountUsd: (Number(r.amount) / 1e6).toString(), asset: 'USDC', network: 'eip155:8453', payTo: r.payTo,
            tx: r.tx || null, payer: r.payer || null, accessType: r.accessType, issuedAt: new Date().toISOString(),
            bodySha256: sha256hex(JSON.stringify(body)),
        };
        rec.id = 'rcpt_' + sha256hex(`${rec.tx}|${rec.route}|${rec.resource}`).slice(0, 20);
        const enc = b64u(JSON.stringify(rec));
        const sig = signDetached(Buffer.from(enc, 'utf8'));
        const h = { 'X-GW8-Receipt': enc, 'X-GW8-Receipt-Key': ORIGIN + RECEIPT_KEY_PATH };
        if (sig) { h['X-GW8-Receipt-Signature'] = sig; h['X-GW8-Receipt-Alg'] = 'Ed25519'; } else h['X-GW8-Receipt-Alg'] = 'none (signing key not configured)';
        return h;
    } catch (e) { console.error('[receipt] build failed', e && e.message); return {}; }
}
/**
 * Body receipt for a paid response (kept by the buyer as an audit trail). Never throws.
 * payload = base64url(JSON of the signed fields); signature = Ed25519 over utf8(payload), same key as /api/proof/pubkey.
 * response_sha256 = sha256 hex of JSON.stringify(data), i.e. of the "signal" field the buyer received.
 * When no signing key is configured: signed=false, signature=null (never a fake signature).
 */
export function buildReceipt(r, data) {
    try {
        const f = { v: 1, service: 'GW8 Signal API', endpoint: r.endpoint, query: r.query && Object.keys(r.query).length ? r.query : null,
            timestamp: new Date().toISOString(), response_sha256: sha256hex(JSON.stringify(data)), amountUsd: r.amount != null ? (Number(r.amount) / 1e6).toString() : null,
            network: 'eip155:8453', tx: r.tx || null, payer: r.payer || null, accessType: r.accessType };
        f.id = 'rcpt_' + sha256hex(`${f.tx}|${f.endpoint}|${f.timestamp}|${f.response_sha256}`).slice(0, 20);
        const payload = b64u(JSON.stringify(f)), signature = signDetached(Buffer.from(payload, 'utf8'));
        return { ...f, payload, signed: !!signature, alg: signature ? 'Ed25519' : 'none', signature: signature || null,
            ...(signature ? {} : { unsigned: 'signing key not configured on the server; this receipt is unsigned' }),
            pubkey_url: ORIGIN + PUBKEY_PATH, verify_url: ORIGIN + VERIFY_PATH };
    } catch (e) { console.error('[receipt] body receipt failed', e && e.message); return { signed: false, alg: 'none', signature: null, unsigned: 'receipt build failed' }; }
}
/** Check a receipt (body receipt {payload, signature} or X-GW8-Receipt header + signature). Public key only. Never throws. */
export function verifyReceipt({ payload, signature, data } = {}) {
    try {
        if (typeof payload !== 'string' || !/^[A-Za-z0-9_-]{10,20000}$/.test(payload)) return { valid: false, reason: 'payload must be the receipt payload (base64url) exactly as received' };
        let fields; try { fields = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { valid: false, reason: 'payload is not base64url JSON' }; }
        const k = publicKeyInfo();
        if (!k.enabled) return { valid: false, signingEnabled: false, reason: 'server signing key not configured; receipts are unsigned and cannot be verified', fields };
        if (!signature) return { valid: false, reason: 'missing signature (receipt is unsigned)', fields };
        const pub = crypto.createPublicKey({ key: Buffer.from(k.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
        const valid = crypto.verify(null, Buffer.from(payload, 'utf8'), pub, Buffer.from(String(signature), 'base64'));
        const out = { valid, alg: 'Ed25519', pubkey_url: ORIGIN + PUBKEY_PATH, fields };
        if (data !== undefined && fields.response_sha256) out.dataMatches = sha256hex(JSON.stringify(data)) === fields.response_sha256;
        if (data !== undefined && fields.bodySha256) out.dataMatches = sha256hex(JSON.stringify(data)) === fields.bodySha256;
        if (!valid) out.reason = 'signature does not match this payload and key';
        return out;
    } catch (e) { return { valid: false, reason: 'could not verify (bad signature encoding?)' }; }
}
export function receiptKeyInfo() {
    const k = publicKeyInfo();
    return {
        ...k,
        purpose: 'Verify GW8 Signal API paid-call receipts (and X-GW8-Signature response signatures; same key as /api/proof/pubkey).',
        receipt: {
            header: 'X-GW8-Receipt', signatureHeader: 'X-GW8-Receipt-Signature',
            format: 'base64url(JSON) with fields v, id, service, route, resource, amount (USDC atomic, 6 decimals), amountUsd, asset, network, payTo, tx, payer, accessType, issuedAt, bodySha256 (sha256 hex of the exact response body).',
            verify: 'Ed25519.verify(publicKey, utf8(X-GW8-Receipt header value exactly as received), base64decode(X-GW8-Receipt-Signature)). Then check tx on Base (basescan) and bodySha256 against the body you received.',
            unsigned: 'If signing is not configured the receipt is still sent with X-GW8-Receipt-Alg: none.',
            bodyReceipt: 'Paid JSON responses also carry a "receipt" field: {endpoint, query, timestamp, response_sha256 (sha256 hex of JSON.stringify(signal)), tx, payer, payload, signature, alg, signed, pubkey_url}. Verify: Ed25519.verify(publicKey, utf8(receipt.payload), base64decode(receipt.signature)); payload decodes (base64url) to the signed fields.',
            verifyEndpoint: `Free: POST ${ORIGIN}${VERIFY_PATH} {payload, signature, data?} or GET ?payload=&signature= (URL-encode the signature).`,
        },
        terms: TRUST_LINE,
    };
}

// ---------- Safe retry (idempotent replay of the same payment payload) ----------
const DONE_TTL_MS = 15 * 60 * 1000, MAX_DONE = 200, MAX_BODY = 256 * 1024;
const done = new Map(), inflight = new Map();
export function replayKey(url, paymentPayload) {
    try { return sha256hex(String(url) + '|' + JSON.stringify((paymentPayload && paymentPayload.payload) || paymentPayload || null)); } catch { return null; }
}
/** Runs fn() once per key; concurrent/replayed calls get the same stored result (only 200s are stored). */
export async function once(key, fn) {
    if (!key) return { ...(await fn()), replay: false };
    const now = Date.now();
    for (const [k, v] of done) { if (now - v.t > DONE_TTL_MS) done.delete(k); else break; }
    const hit = done.get(key);
    if (hit) return { ...hit.r, replay: true };
    if (inflight.has(key)) return { ...(await inflight.get(key)), replay: true };
    const p = (async () => fn())();
    inflight.set(key, p);
    try {
        const r = await p;
        if (r && r.status === 200 && JSON.stringify(r.body).length <= MAX_BODY) {
            done.set(key, { t: Date.now(), r });
            while (done.size > MAX_DONE) done.delete(done.keys().next().value);
        }
        return { ...r, replay: false };
    } finally { inflight.delete(key); }
}
