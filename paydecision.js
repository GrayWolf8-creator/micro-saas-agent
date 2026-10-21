// paydecision.js — "should my agent pay this?" in one call: spend-policy check (spend.js) + x402 seller reputation
// (reputation.js) -> one verdict pay / dont_pay / ask_human, the reasons, and ONE signed receipt (trust.js buildReceipt).
// Deterministic combine rules (below). Stateless; never pays anyone; not custody. If the seller data source is unavailable
// the call returns {error} so the caller does not charge (same as /api/seller/reputation).
import crypto from 'crypto';
import { buildReceipt } from './trust.js';
import { validateSpend, evaluateSpend, SPEND_ENGINE } from './spend.js';
import { validateReputation, evaluateSellerReputation } from './reputation.js';

export const PAYDECISION_PLAN = { priceUsd: '0.02', amount: '20000' };
export const PAYDECISION_ENGINE = 'gw8-should-i-pay/1';
const ACTIONS = ['pay', 'ask_human', 'dont_pay'];
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : isObj(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
const DISCLAIMER = 'Deterministic combination of your spend policy and a heuristic public-data seller score. Not custody, not a payment, not a guarantee; the agent and its owner stay responsible for the payment.';

/** Body {payment, policy, seller:{address?, endpoint?, lookbackDays?}, sellerRules?:{onCaution, onUnknown, minScore}}.
 *  Returns {error} or a normalized object. No network. Runs before payment (bad bodies are never charged). */
export function validatePayDecision(body) {
    if (!isObj(body)) return { error: 'body must be JSON {payment, policy, seller}' };
    const errs = [];
    const s = validateSpend({ payment: body.payment, policy: body.policy });
    if (s.error) errs.push(s.error);
    let r = null;
    if (!isObj(body.seller)) errs.push('seller object is required: {address} (Base wallet) and/or {endpoint} (x402 https URL)');
    else { r = validateReputation(body.seller); if (r.error) errs.push('seller: ' + r.error); }
    const rules = { onCaution: 'ask_human', onUnknown: 'ask_human', minScore: null };
    if (body.sellerRules != null) {
        const q = body.sellerRules;
        if (!isObj(q)) errs.push('sellerRules must be an object');
        else {
            for (const k of ['onCaution', 'onUnknown']) if (q[k] != null) { if (!ACTIONS.includes(q[k])) errs.push(`sellerRules.${k} must be one of ${ACTIONS.join(', ')}`); else rules[k] = q[k]; }
            if (q.minScore != null) { if (!Number.isInteger(q.minScore) || q.minScore < 0 || q.minScore > 100) errs.push('sellerRules.minScore must be an integer 0-100'); else rules.minScore = q.minScore; }
        }
    }
    if (errs.length) return { error: errs.join('; ') };
    return { spend: s, seller: r, rules, raw: { payment: body.payment, policy: body.policy, seller: body.seller, sellerRules: body.sellerRules ?? null } };
}

// Combine (worst wins: dont_pay > ask_human > pay):
//   spend deny -> dont_pay; spend needs_approval -> ask_human
//   seller avoid -> dont_pay; seller caution -> sellerRules.onCaution (default ask_human); seller unknown -> sellerRules.onUnknown (default ask_human)
//   seller score < sellerRules.minScore -> dont_pay
//   payment.recipientId is a 0x address that differs from the seller address scored -> ask_human
//   otherwise (spend allow + seller trusted) -> pay
export function combine(spendOut, sellerOut, rules, payment) {
    const steps = [];
    const add = (action, source, detail) => steps.push({ action, source, detail });
    if (spendOut.decision === 'deny') add('dont_pay', 'spend_policy', `policy denies: ${spendOut.reasons.map(x => x.rule).join(', ')}`);
    else if (spendOut.decision === 'needs_approval') add('ask_human', 'spend_policy', `policy needs approval: ${spendOut.reasons.map(x => x.rule).join(', ')}`);
    else add('pay', 'spend_policy', 'policy allows');
    const sv = sellerOut.verdict;
    if (sv === 'avoid') add('dont_pay', 'seller_reputation', `seller verdict avoid (score ${sellerOut.score}${sellerOut.flags.length ? '; ' + sellerOut.flags.join(', ') : ''})`);
    else if (sv === 'caution') add(rules.onCaution, 'seller_reputation', `seller verdict caution (score ${sellerOut.score}) -> ${rules.onCaution}`);
    else if (sv === 'unknown') add(rules.onUnknown, 'seller_reputation', `seller verdict unknown (no payment history) -> ${rules.onUnknown}`);
    else add('pay', 'seller_reputation', `seller verdict trusted (score ${sellerOut.score})`);
    if (rules.minScore != null && sellerOut.score < rules.minScore) add('dont_pay', 'seller_reputation', `seller score ${sellerOut.score} < your minScore ${rules.minScore}`);
    const rid = typeof payment.recipientId === 'string' ? payment.recipientId.trim().toLowerCase() : '';
    if (/^0x[0-9a-f]{40}$/.test(rid) && rid !== sellerOut.seller.address) add('ask_human', 'consistency', `payment.recipientId ${rid} is not the seller address scored (${sellerOut.seller.address})`);
    const verdict = steps.reduce((w, s) => ACTIONS.indexOf(s.action) > ACTIONS.indexOf(w) ? s.action : w, 'pay');
    return { verdict, reasons: steps.filter(s => s.action !== 'pay' || verdict === 'pay').map(s => ({ source: s.source, action: s.action, detail: s.detail })), steps };
}

export async function checkShouldIPay(body, { now = new Date(), ...opts } = {}) {
    const v = validatePayDecision(body);
    if (v.error) return { error: v.error };
    const rep = await evaluateSellerReputation(v.seller, { now, ...opts });
    if (rep.error) return { error: rep.error };
    const spendOut = { engine: SPEND_ENGINE, ...evaluateSpend(v.spend, now) };
    const c = combine(spendOut, rep.out, v.rules, v.spend.payment);
    const out = { engine: PAYDECISION_ENGINE, verdict: c.verdict, reasons: c.reasons, steps: c.steps, sellerRules: v.rules, spend: spendOut, seller: rep.out, evaluatedFor: new Date(now).toISOString() };
    const requestSha256 = sha(canon(v.raw));
    const receipt = buildReceipt({ endpoint: 'POST /api/pay/should-i-pay', amount: null, tx: null, accessType: 'PAY_DECISION',
        query: { type: 'gw8.should-i-pay', engine: PAYDECISION_ENGINE, verdict: c.verdict, spendDecision: spendOut.decision, sellerVerdict: rep.out.verdict, sellerScore: rep.out.score,
            seller: rep.out.seller.address, evaluatedFor: out.evaluatedFor, dataSha256: rep.dataSha256, requestSha256 } }, out);
    return { ...out, decisionReceipt: { ...receipt, verify: 'Free: POST /api/receipt/verify {payload, signature, data: <signal without decisionReceipt, stateless, disclaimer>} -> valid + dataMatches. query.requestSha256 = sha256 hex of canonical JSON (sorted keys, no spaces) of {payment, policy, seller, sellerRules} as sent (sellerRules null when omitted).' },
        stateless: 'GW8 does not store the payment, policy, memo or seller you check.', disclaimer: DISCLAIMER };
}
