// Offline tests for paydecision.js + catalog.js (fetch stubbed; seller data from fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.fetch = async () => { throw new Error('offline test'); };
const { checkShouldIPay, validatePayDecision, combine, PAYDECISION_PLAN } = await import('../paydecision.js');
const { REPUTATION_PLAN } = await import('../reputation.js');
const { SPEND_PLAN } = await import('../spend.js');
const { categoryOf, withCategory, isFeatured } = await import('../catalog.js');

const NOW = new Date('2026-10-21T18:00:00.000Z'), nowS = NOW.getTime() / 1000, D = 86400;
const S = '0x' + '1'.repeat(40), P = i => '0x' + i.toString(16).padStart(40, '0');
const tx = (from, to, usdc, daysAgo, n) => ({ from, to, value: BigInt(Math.round(usdc * 1e6)), ts: nowS - daysAgo * D, hash: '0x' + n.toString(16).padStart(64, '0') });
const goodLoad = async () => { const t = []; for (let i = 1; i <= 30; i++) t.push(tx(P(i), S, 5, i % 25, i)); return { transfers: t, rawCount: t.length, firstActivityTs: nowS - 400 * D, source: 'fixture' }; };
const fewLoad = async () => ({ transfers: [tx(P(1), S, 3, 1, 1), tx(P(2), S, 3, 2, 2), tx(P(3), S, 3, 3, 3)], rawCount: 3, firstActivityTs: nowS - 10 * D, source: 'fixture' });
const washLoad = async () => ({ transfers: [tx(S, S, 50, 3, 1), tx(P(7), S, 40, 2, 2), tx(S, P(7), 39, 1, 3)], rawCount: 3, firstActivityTs: nowS - 200 * D, source: 'fixture' });
const emptyLoad = async () => ({ transfers: [], rawCount: 0, firstActivityTs: null, source: 'fixture' });
const payment = o => ({ amount: '0.05', currency: 'USDC', chain: 'base', recipientId: S, merchantCategory: 'data-api', timestamp: '2026-10-21T15:30:00Z', ...o });
const policy = o => ({ currency: 'USDC', perTxLimit: '1', allowedChains: ['base'], requireApprovalAbove: '0.50', ...o });
const body = o => ({ payment: payment(), policy: policy(), seller: { address: S }, ...o });

test('prices: should-i-pay $0.02, seller reputation $0.01, spend check $0.02', () => {
  assert.deepEqual(PAYDECISION_PLAN, { priceUsd: '0.02', amount: '20000' });
  assert.deepEqual(REPUTATION_PLAN, { priceUsd: '0.01', amount: '10000' });
  assert.deepEqual(SPEND_PLAN, { priceUsd: '0.02', amount: '20000' });
});

test('pay: policy allows + seller trusted', async () => {
  const r = await checkShouldIPay(body(), { now: NOW, load: goodLoad });
  assert.equal(r.verdict, 'pay'); assert.equal(r.spend.decision, 'allow'); assert.equal(r.seller.verdict, 'trusted');
  assert.equal(r.decisionReceipt.endpoint, 'POST /api/pay/should-i-pay'); assert.equal(r.decisionReceipt.accessType, 'PAY_DECISION');
  assert.equal(r.decisionReceipt.query.verdict, 'pay'); assert.equal(r.decisionReceipt.query.sellerVerdict, 'trusted'); assert.equal(r.decisionReceipt.query.dataSha256, r.seller.data.dataSha256);
  assert.equal(r.seller.reputationReceipt, undefined); assert.equal(r.spend.decisionReceipt, undefined); // one receipt only
});

test('dont_pay: policy deny (over per-tx limit) even with a trusted seller', async () => {
  const r = await checkShouldIPay(body({ payment: payment({ amount: '5' }) }), { now: NOW, load: goodLoad });
  assert.equal(r.verdict, 'dont_pay'); assert.equal(r.reasons[0].source, 'spend_policy');
});

test('dont_pay: seller avoid (wash) even when policy allows', async () => {
  const r = await checkShouldIPay(body(), { now: NOW, load: washLoad });
  assert.equal(r.spend.decision, 'allow'); assert.equal(r.seller.verdict, 'avoid'); assert.equal(r.verdict, 'dont_pay');
});

test('ask_human: needs_approval, seller caution, seller unknown, and sellerRules overrides', async () => {
  assert.equal((await checkShouldIPay(body({ payment: payment({ amount: '0.75' }) }), { now: NOW, load: goodLoad })).verdict, 'ask_human');
  const c = await checkShouldIPay(body(), { now: NOW, load: fewLoad });
  assert.equal(c.seller.verdict, 'caution'); assert.equal(c.verdict, 'ask_human');
  assert.equal((await checkShouldIPay(body({ sellerRules: { onCaution: 'pay' } }), { now: NOW, load: fewLoad })).verdict, 'pay');
  assert.equal((await checkShouldIPay(body({ sellerRules: { onCaution: 'dont_pay' } }), { now: NOW, load: fewLoad })).verdict, 'dont_pay');
  const u = await checkShouldIPay(body(), { now: NOW, load: emptyLoad });
  assert.equal(u.seller.verdict, 'unknown'); assert.equal(u.verdict, 'ask_human');
  assert.equal((await checkShouldIPay(body({ sellerRules: { minScore: 99 } }), { now: NOW, load: fewLoad })).verdict, 'dont_pay');
});

test('ask_human: payment.recipientId is a different 0x address than the seller scored', async () => {
  const r = await checkShouldIPay(body({ payment: payment({ recipientId: P(99) }) }), { now: NOW, load: goodLoad });
  assert.equal(r.verdict, 'ask_human'); assert.ok(r.reasons.some(x => x.source === 'consistency'));
});

test('seller data unavailable -> {error} (caller does not charge)', async () => {
  const r = await checkShouldIPay(body(), { now: NOW, load: async () => { throw new Error('explorer HTTP 403'); } });
  assert.match(r.error, /verdict unknown: public transfer data unavailable \(explorer HTTP 403\)/);
});

test('validation (runs before payment)', () => {
  assert.match(validatePayDecision(null).error, /body must be JSON/);
  const e = validatePayDecision({}).error;
  assert.match(e, /payment object is required/); assert.match(e, /seller object is required/);
  assert.match(validatePayDecision(body({ seller: { address: '0x12' } })).error, /seller: address must be/);
  assert.match(validatePayDecision(body({ seller: { endpoint: 'http://x.example' } })).error, /seller: endpoint must use https/);
  assert.match(validatePayDecision(body({ sellerRules: { onCaution: 'maybe' } })).error, /sellerRules.onCaution/);
  assert.match(validatePayDecision(body({ sellerRules: { minScore: 101 } })).error, /minScore/);
  assert.equal(validatePayDecision(body()).error, undefined);
});

test('combine: worst action wins, deterministic', () => {
  const sp = d => ({ decision: d, reasons: d === 'allow' ? [] : [{ rule: 'r' }] });
  const se = (v, score = 80) => ({ verdict: v, score, flags: [], seller: { address: S } });
  const R = { onCaution: 'ask_human', onUnknown: 'ask_human', minScore: null };
  assert.equal(combine(sp('allow'), se('trusted'), R, {}).verdict, 'pay');
  assert.equal(combine(sp('needs_approval'), se('avoid'), R, {}).verdict, 'dont_pay');
  assert.equal(combine(sp('deny'), se('trusted'), R, {}).verdict, 'dont_pay');
  assert.equal(combine(sp('allow'), se('unknown', 0), R, {}).verdict, 'ask_human');
  assert.deepEqual(combine(sp('allow'), se('caution', 50), R, {}), combine(sp('allow'), se('caution', 50), R, {}));
});

test('catalog: category keywords + unfeatured routes', () => {
  assert.match(categoryOf('/api/pay/should-i-pay'), /Payment decision/);
  assert.match(categoryOf('/api/spend/check'), /Spend policy/);
  assert.match(categoryOf('/api/seller/reputation'), /Seller reputation/);
  assert.match(categoryOf('/api/verdict/{chain}/{address}'), /verdict/);
  assert.match(categoryOf('/api/coin/{symbol}'), /Market data/);
  assert.equal(withCategory('/api/rails', 'x'), '[Payment rails: fee + speed comparison] x');
  assert.equal(withCategory('/api/rails', '[already] x'), '[already] x');
  for (const p of ['/api/rules', '/api/rwa', '/api/govcontracts', '/api/govcontracts/status']) assert.equal(isFeatured(p), false);
  for (const p of ['/api/rs', '/api/rails', '/api/spend/check']) assert.equal(isFeatured(p), true);
});
