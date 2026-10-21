// spend.js — spend-policy check for AI agents: "may this agent make this payment under this buyer's rules?"
// Pure, deterministic rule evaluation. Stateless: nothing about the payment or policy is stored or logged;
// the caller supplies spent-so-far for the rolling cap. No custody, no payment execution, no FX conversion.
// Decision receipt: built with trust.js buildReceipt (same Ed25519 key, /api/proof/pubkey, free /api/receipt/verify).
// The signed fields carry query.requestSha256 (hash of the exact {payment, policy}) and response_sha256 (hash of the evaluation).
import crypto from 'crypto';
import { buildReceipt } from './trust.js';

export const SPEND_PLAN = { priceUsd: '0.02', amount: '20000' };
export const SPEND_ENGINE = 'gw8-spend-policy/1';
const MAX_LIST = 500, MAX_STR = 200, SCALE = 18, SKEW_MS = 15 * 60e3;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CHAINS = { base: 'eip155:8453', 'base-mainnet': 'eip155:8453', ethereum: 'eip155:1', eth: 'eip155:1', mainnet: 'eip155:1', arbitrum: 'eip155:42161', optimism: 'eip155:10', polygon: 'eip155:137', 'base-sepolia': 'eip155:84532', solana: 'solana', xrpl: 'xrpl', 'xrp-ledger': 'xrpl', card: 'card', ach: 'ach', wire: 'wire' };
const DISCLAIMER = 'Deterministic rule check against the policy you sent. Not custody, not a payment, not a guarantee; the agent and the buyer stay responsible for the payment.';

// ---------- helpers ----------
const low = s => String(s ?? '').trim().toLowerCase();
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
/** Decimal string/number -> BigInt scaled by 1e18, or null if not a plain non-negative decimal. */
export function dec(v) {
    if (typeof v === 'number') { if (!Number.isFinite(v) || v < 0) return null; v = v.toFixed(Math.min(SCALE, 12)).replace(/\.?0+$/, ''); }
    const m = /^(\d{1,24})(?:\.(\d{1,18}))?$/.exec(String(v ?? '').trim());
    return m ? BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt((m[2] || '').padEnd(SCALE, '0') || '0') : null;
}
const fmt = b => { const s = b.toString().padStart(SCALE + 1, '0'); const i = s.slice(0, -SCALE), f = s.slice(-SCALE).replace(/0+$/, ''); return f ? `${i}.${f}` : i; };
const chainId = c => { const k = low(c); return CHAINS[k] || k; };
const domainOf = d => low(d).replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0].replace(/^www\./, '').replace(/\.$/, '');
const domainHit = (d, list) => !!d && list.some(x => { const e = domainOf(x); return e && (d === e || d.endsWith('.' + e)); });
const hm = s => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : (s === '24:00' ? 1440 : null); };
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
function localParts(date, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(x => [x.type, x.value]));
    return { day: low(p.weekday).slice(0, 3), minutes: (+p.hour % 24) * 60 + +p.minute, label: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.weekday}` };
}
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : isObj(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// ---------- validation (runs before payment; a bad body is refused with no charge) ----------
const strList = (v, name, errs) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > MAX_LIST || v.some(x => typeof x !== 'string' || !x.trim() || x.length > MAX_STR)) { errs.push(`${name} must be an array of up to ${MAX_LIST} non-empty strings (max ${MAX_STR} chars)`); return []; }
    return v.map(x => x.trim());
};
/** Returns { error } or { payment, policy } normalized. Never throws. */
export function validateSpend(body) {
    const errs = [];
    if (!isObj(body)) return { error: 'body must be JSON {payment, policy}' };
    const { payment: p, policy: q } = body;
    if (!isObj(p)) errs.push('payment object is required');
    if (!isObj(q)) errs.push('policy object is required');
    if (errs.length) return { error: errs.join('; ') };
    const S = (v, name, req) => { if (v == null || v === '') { if (req) errs.push(`${name} is required`); return null; } if (typeof v !== 'string' || v.length > MAX_STR) { errs.push(`${name} must be a string (max ${MAX_STR} chars)`); return null; } return v.trim(); };
    const amt = (v, name, req) => { if (v == null) { if (req) errs.push(`${name} is required`); return null; } const b = dec(v); if (b == null) errs.push(`${name} must be a non-negative decimal (string preferred, e.g. "125.50")`); return b; };

    const payment = {
        amount: amt(p.amount, 'payment.amount', true),
        currency: S(p.currency, 'payment.currency', true),
        chain: S(p.chain, 'payment.chain'),
        recipientId: S(p.recipientId ?? p.merchantId, 'payment.recipientId'),
        recipientDomain: S(p.recipientDomain ?? p.merchantDomain, 'payment.recipientDomain'),
        merchantCategory: S(p.merchantCategory, 'payment.merchantCategory'),
        agentId: S(p.agentId, 'payment.agentId'),
        memo: p.memo == null ? null : (typeof p.memo === 'string' && p.memo.length <= 1000 ? p.memo : (errs.push('payment.memo must be a string (max 1000 chars)'), null)),
        timestamp: null,
    };
    if (!payment.recipientId && !payment.recipientDomain) errs.push('payment.recipientId or payment.recipientDomain is required');
    if (p.timestamp != null) { const t = new Date(p.timestamp); if (typeof p.timestamp !== 'string' || isNaN(t)) errs.push('payment.timestamp must be an ISO 8601 string'); else payment.timestamp = t; }

    const policy = {
        currency: S(q.currency, 'policy.currency'),
        perTxLimit: amt(q.perTxLimit, 'policy.perTxLimit'),
        requireApprovalAbove: amt(q.requireApprovalAbove, 'policy.requireApprovalAbove'),
        rollingCap: null,
        allowedCategories: strList(q.allowedCategories, 'policy.allowedCategories', errs).map(low),
        blockedCategories: strList(q.blockedCategories, 'policy.blockedCategories', errs).map(low),
        allowList: strList(q.allowList, 'policy.allowList', errs),
        denyList: strList(q.denyList, 'policy.denyList', errs),
        onUnlisted: q.onUnlisted == null ? 'deny' : (['deny', 'needs_approval'].includes(q.onUnlisted) ? q.onUnlisted : (errs.push('policy.onUnlisted must be "deny" or "needs_approval"'), 'deny')),
        allowedAssets: strList(q.allowedAssets, 'policy.allowedAssets', errs).map(low),
        allowedChains: strList(q.allowedChains, 'policy.allowedChains', errs).map(chainId),
        allowedHours: null,
    };
    const cap = q.rollingCap ?? q.dailyCap;
    if (cap != null) {
        if (!isObj(cap)) errs.push('policy.rollingCap must be {limit, spentSoFar, windowHours?}');
        else {
            const wh = cap.windowHours == null ? 24 : Number(cap.windowHours);
            if (!Number.isFinite(wh) || wh <= 0 || wh > 24 * 31) errs.push('policy.rollingCap.windowHours must be 0-744');
            policy.rollingCap = { limit: amt(cap.limit, 'policy.rollingCap.limit', true), spentSoFar: amt(cap.spentSoFar, 'policy.rollingCap.spentSoFar (we are stateless: send what this agent/buyer spent in the window)', true), windowHours: wh };
        }
    }
    if (q.allowedHours != null) {
        const h = q.allowedHours;
        if (!isObj(h)) errs.push('policy.allowedHours must be {start:"HH:MM", end:"HH:MM", timezone, days?}');
        else {
            const start = hm(h.start), end = hm(h.end), days = strList(h.days, 'policy.allowedHours.days', errs).map(d => low(d).slice(0, 3));
            if (start == null || end == null) errs.push('policy.allowedHours.start/end must be "HH:MM" (24h)');
            if (!h.timezone || !validTz(h.timezone)) errs.push('policy.allowedHours.timezone must be an IANA zone, e.g. "America/Denver"');
            if (days.some(d => !DAYS.includes(d))) errs.push('policy.allowedHours.days must be weekday names, e.g. ["mon","tue"]');
            policy.allowedHours = { start, end, timezone: h.timezone, days, raw: { start: h.start, end: h.end } };
        }
    }
    if (errs.length) return { error: errs.join('; ') };
    return { payment, policy, raw: { payment: p, policy: q } };
}

// ---------- evaluation ----------
/** Deterministic: same input (+ same now when timestamp is absent) -> same decision. deny > needs_approval > allow. */
export function evaluateSpend(v, now = new Date()) {
    const { payment: p, policy: q } = v, checks = [], warnings = [];
    const add = (rule, result, detail) => checks.push({ rule, result, detail });
    const amount = p.amount, cur = low(p.currency);
    const at = p.timestamp || now;
    if (!p.timestamp) warnings.push('payment.timestamp not sent; evaluated at server time');
    else if (Math.abs(at - now) > SKEW_MS) warnings.push(`payment.timestamp is ${Math.round((at - now) / 60000)} min from server time; hours rule used the timestamp you sent`);

    // 1. currency comparability (limits are in policy.currency; we never convert)
    const limitsSet = q.perTxLimit != null || q.requireApprovalAbove != null || q.rollingCap;
    if (q.currency && low(q.currency) !== cur) add('currency_match', 'deny', `payment is ${p.currency}, policy limits are in ${q.currency}; no FX conversion is done`);
    else if (q.currency) add('currency_match', 'pass', `payment currency ${p.currency} matches policy`);
    else if (limitsSet) { add('currency_match', 'pass', `policy.currency not set; limits assumed to be in ${p.currency}`); warnings.push('set policy.currency so a payment in another currency is refused'); }
    const comparable = !(q.currency && low(q.currency) !== cur);

    // 2. recipient deny / allow lists (id exact, case-insensitive; domain exact or subdomain)
    const rid = low(p.recipientId), rdom = p.recipientDomain ? domainOf(p.recipientDomain) : '';
    const who = [p.recipientId && `id ${p.recipientId}`, rdom && `domain ${rdom}`].filter(Boolean).join(' / ');
    const hit = list => (rid && list.some(x => low(x) === rid)) ? `id ${p.recipientId}` : domainHit(rdom, list) ? `domain ${rdom}` : null;
    let m;
    if (q.denyList.length) (m = hit(q.denyList)) ? add('deny_list', 'deny', `recipient ${m} is on the deny list`) : add('deny_list', 'pass', `recipient (${who}) not on deny list`);
    else add('deny_list', 'skip', 'no deny list');
    if (q.allowList.length) (m = hit(q.allowList)) ? add('allow_list', 'pass', `recipient ${m} is on the allow list`) : add('allow_list', q.onUnlisted, `recipient (${who}) is not on the allow list (onUnlisted=${q.onUnlisted})`);
    else add('allow_list', 'skip', 'no allow list');

    // 3. merchant category
    const cat = low(p.merchantCategory);
    if (q.blockedCategories.length) (cat && q.blockedCategories.includes(cat)) ? add('blocked_category', 'deny', `category "${p.merchantCategory}" is blocked`) : add('blocked_category', 'pass', cat ? `category "${p.merchantCategory}" not blocked` : 'no category sent');
    else add('blocked_category', 'skip', 'no blocked categories');
    if (q.allowedCategories.length) !cat ? add('allowed_category', 'deny', 'policy restricts categories but payment.merchantCategory was not sent')
        : q.allowedCategories.includes(cat) ? add('allowed_category', 'pass', `category "${p.merchantCategory}" is allowed`) : add('allowed_category', 'deny', `category "${p.merchantCategory}" is not in allowedCategories`);
    else add('allowed_category', 'skip', 'no category allow list');

    // 4. asset / chain
    if (q.allowedAssets.length) q.allowedAssets.includes(cur) ? add('allowed_asset', 'pass', `${p.currency} allowed`) : add('allowed_asset', 'deny', `${p.currency} is not in allowedAssets`);
    else add('allowed_asset', 'skip', 'no asset restriction');
    if (q.allowedChains.length) {
        const c = p.chain ? chainId(p.chain) : null;
        !c ? add('allowed_chain', 'deny', 'policy restricts chains but payment.chain was not sent')
            : q.allowedChains.includes(c) ? add('allowed_chain', 'pass', `chain ${p.chain} (${c}) allowed`) : add('allowed_chain', 'deny', `chain ${p.chain} (${c}) is not in allowedChains`);
    } else add('allowed_chain', 'skip', 'no chain restriction');

    // 5. hours
    if (q.allowedHours) {
        const h = q.allowedHours, lp = localParts(at, h.timezone);
        const inWindow = h.start === h.end ? true : h.start < h.end ? (lp.minutes >= h.start && lp.minutes < h.end) : (lp.minutes >= h.start || lp.minutes < h.end);
        const dayOk = !h.days.length || h.days.includes(lp.day);
        const win = `${h.raw.start}-${h.raw.end}${h.days.length ? ' ' + h.days.join(',') : ''} ${h.timezone}`;
        (inWindow && dayOk) ? add('allowed_hours', 'pass', `${lp.label} is inside ${win}`) : add('allowed_hours', 'deny', `${lp.label} is outside ${win}`);
    } else add('allowed_hours', 'skip', 'no hours restriction');

    // 6. amount limits (only when currencies are comparable)
    const remaining = {};
    if (q.perTxLimit != null) {
        if (!comparable) add('per_tx_limit', 'skip', 'currency mismatch');
        else { remaining.perTx = fmt(q.perTxLimit); amount > q.perTxLimit ? add('per_tx_limit', 'deny', `${fmt(amount)} > per-tx limit ${fmt(q.perTxLimit)}`) : add('per_tx_limit', 'pass', `${fmt(amount)} <= per-tx limit ${fmt(q.perTxLimit)}`); }
    } else add('per_tx_limit', 'skip', 'no per-tx limit');
    if (q.rollingCap) {
        const c = q.rollingCap, after = c.spentSoFar + amount, left = c.limit > c.spentSoFar ? c.limit - c.spentSoFar : 0n;
        if (!comparable) add('rolling_cap', 'skip', 'currency mismatch');
        else {
            remaining.rollingCapBefore = fmt(left); remaining.rollingCapAfter = after > c.limit ? '0' : fmt(c.limit - after);
            after > c.limit ? add('rolling_cap', 'deny', `spent ${fmt(c.spentSoFar)} + ${fmt(amount)} = ${fmt(after)} > ${c.windowHours}h cap ${fmt(c.limit)} (only ${fmt(left)} left)`)
                : add('rolling_cap', 'pass', `spent ${fmt(c.spentSoFar)} + ${fmt(amount)} = ${fmt(after)} <= ${c.windowHours}h cap ${fmt(c.limit)}`);
        }
    } else add('rolling_cap', 'skip', 'no rolling cap');
    if (q.requireApprovalAbove != null) {
        if (!comparable) add('approval_threshold', 'skip', 'currency mismatch');
        else amount > q.requireApprovalAbove ? add('approval_threshold', 'needs_approval', `${fmt(amount)} > human-approval threshold ${fmt(q.requireApprovalAbove)}`) : add('approval_threshold', 'pass', `${fmt(amount)} <= approval threshold ${fmt(q.requireApprovalAbove)}`);
    } else add('approval_threshold', 'skip', 'no approval threshold');

    const fired = checks.filter(c => c.result === 'deny' || c.result === 'needs_approval');
    const decision = fired.some(c => c.result === 'deny') ? 'deny' : fired.length ? 'needs_approval' : 'allow';
    if (!checks.some(c => c.result !== 'skip' && c.rule !== 'currency_match')) warnings.push('policy set no rules that applied; allow means "nothing forbade it", not "approved"');
    return {
        decision,
        reasons: fired.map(c => ({ rule: c.rule, result: c.result, detail: c.detail })),
        checks, remaining, warnings,
        evaluatedFor: at.toISOString(),
    };
}

/** Signed decision receipt via main's buildReceipt. Binds the decision to a hash of the exact {payment, policy} sent
 *  (query.requestSha256) and to the evaluation (response_sha256 = sha256 of JSON.stringify(evaluation)). Never throws. */
export function decisionReceipt(v, out) {
    const requestSha256 = sha(canon({ payment: v.raw.payment, policy: v.raw.policy }));
    const r = buildReceipt({ endpoint: 'POST /api/spend/check', amount: null, tx: null, accessType: 'SPEND_POLICY_DECISION',
        query: { type: 'gw8.spend-policy-decision', engine: SPEND_ENGINE, decision: out.decision, rulesFired: out.reasons.map(x => x.rule),
            amount: fmt(v.payment.amount), currency: v.payment.currency, chain: v.payment.chain || null,
            recipient: v.payment.recipientId || domainOf(v.payment.recipientDomain), agentId: v.payment.agentId || null,
            evaluatedFor: out.evaluatedFor, requestSha256 } }, out);
    return { ...r, verify: 'Free: POST /api/receipt/verify {payload, signature, data: <signal without decisionReceipt, stateless, disclaimer>} -> valid + dataMatches. Or Ed25519.verify(key from /api/proof/pubkey, utf8(payload), base64decode(signature)). query.requestSha256 = sha256 hex of canonical JSON (sorted keys, no spaces) of {payment, policy} as you sent them.' };
}

/** Full call: validate -> evaluate -> receipt. Returns {error} on bad input (caller refuses before payment). */
export function checkSpend(body, now = new Date()) {
    const v = validateSpend(body);
    if (v.error) return { error: v.error };
    const out = { engine: SPEND_ENGINE, ...evaluateSpend(v, now) };
    return { ...out, decisionReceipt: decisionReceipt(v, out), stateless: 'GW8 does not store the payment, policy or memo; send spentSoFar yourself.', disclaimer: DISCLAIMER };
}
