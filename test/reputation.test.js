// Offline tests for reputation.js (no network: fetch is stubbed before import; data comes from fixtures).
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.fetch = async () => { throw new Error('offline test'); };
delete process.env.ALCHEMY_API_KEY;                    // these tests cover the keyless Blockscout path (keyed: test/keyed-source.test.js)
const R = await import('../reputation.js');
const { scoreReputation, validateReputation, normalizeTransfers, payToFromChallenge, checkEndpointSyntax, checkSellerReputation, USDC_BASE, LIMITS } = R;

const NOW = '2026-10-21T18:00:00.000Z', nowS = Date.parse(NOW) / 1000, D = 86400;
const S = '0x' + 'a'.repeat(40);                       // seller
const P = i => '0x' + i.toString(16).padStart(40, '0'); // payer i
const tx = (from, to, usdc, daysAgo, n = 0) => ({ from, to, value: BigInt(Math.round(usdc * 1e6)), ts: nowS - Math.round(daysAgo * D), hash: '0x' + (n || Math.random()).toString(16).replace('.', '').padEnd(64, '0').slice(0, 64) });
const base = { address: S, now: NOW };

test('healthy seller: many buyers, spread volume, old wallet -> trusted 100', () => {
  const t = []; for (let i = 1; i <= 30; i++) t.push(tx(P(i), S, 5, i % 25, i));
  const r = scoreReputation({ ...base, transfers: t, firstActivityTs: nowS - 400 * D });
  assert.equal(r.verdict, 'trusted');
  assert.equal(r.components.distinctBuyers.points, 30);
  assert.equal(r.components.washShare.value, 0);
  assert.equal(r.components.washShare.points, 25);
  assert.equal(r.components.walletAge.points, 15);
  assert.equal(r.components.concentration.points, 20); // top share 1/30 <= 0.2
  assert.equal(r.components.volume30d.organicUsd, 150);
  assert.equal(r.components.volume30d.points, 10);
  assert.equal(r.score, 100);
});

test('wash seller: self-transfers + round-trip payer -> avoid with flags', () => {
  const X = P(7);
  const t = [tx(S, S, 50, 3, 1), tx(X, S, 40, 2, 2), tx(S, X, 39, 1, 3), tx(P(8), S, 1, 5, 4)];
  const r = scoreReputation({ ...base, transfers: t, firstActivityTs: nowS - 200 * D });
  assert.equal(r.verdict, 'avoid');
  assert.deepEqual(r.flags.sort(), ['round_trips', 'self_transfers', 'wash_majority']);
  assert.equal(r.components.washShare.value, Number(((90n * 10000n) / 91n)) / 10000); // 0.989
  assert.equal(r.components.distinctBuyers.value, 1);
  assert.equal(r.components.concentration.topPayer, P(8));
});

test('single payer repeating: concentration ~0, flag, caution at 53', () => {
  const t = []; for (let i = 0; i < 20; i++) t.push(tx(P(1), S, 0.02, i, i + 1));
  t.push(tx(P(2), S, 0.02, 3, 99));
  const r = scoreReputation({ ...base, transfers: t, firstActivityTs: nowS - 100 * D });
  assert.ok(r.flags.includes('single_payer_repeating'));
  assert.equal(r.components.concentration.points, Math.round(20 * (1 - (r.components.concentration.topPayerShare - 0.2) / 0.8)));
  assert.equal(r.components.distinctBuyers.points, 12);
  // buyers 2 -> 12, wash 0 -> 25, age 100d -> 12, top share 0.4/0.42 -> round(20*(1-(0.9523-0.2)/0.8)) = 1, vol $0.42 -> 3
  assert.equal(r.components.concentration.points, 1);
  assert.equal(r.score, 53);
  assert.equal(r.verdict, 'caution');
});

test('no payments in window -> unknown, dust and lookalike tokens ignored', () => {
  const rows = [
    { contractAddress: '0x6c9458b7e1c1742c68d2662ea6a41ac5de43d28c', from: P(1), to: S, value: '50000', timeStamp: String(nowS - D), hash: '0x1' }, // lookalike "UṢDC"
    { contractAddress: USDC_BASE, from: P(2), to: S, value: '0', timeStamp: String(nowS - D), hash: '0x2' },                                     // zero-value poisoning
    { contractAddress: USDC_BASE, from: P(3), to: S, value: '999', timeStamp: String(nowS - D), hash: '0x3' },                                   // dust < $0.001
    { contractAddress: USDC_BASE, from: P(4), to: S, value: '20000', timeStamp: String(nowS - 200 * D), hash: '0x4' },                           // outside 90d
  ];
  const t = normalizeTransfers(rows);
  assert.equal(t.length, 3);
  const r = scoreReputation({ ...base, transfers: t, firstActivityTs: nowS - 200 * D });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.window.ignoredDust, 2);
  assert.equal(r.window.incomingPayments, 0);
  assert.match(r.reasons[0], /no USDC payments/);
});

test('new wallet, few buyers -> caution; payTo mismatch -> avoid', () => {
  const t = [tx(P(1), S, 3, 1, 1), tx(P(2), S, 3, 2, 2), tx(P(3), S, 3, 3, 3)];
  const r = scoreReputation({ ...base, transfers: t, firstActivityTs: nowS - 10 * D });
  // buyers 12 + wash 25 + age 5 + conc 20 (top 1/3 -> round(20*(1-(0.3333-0.2)/0.8)) = 17) + vol 9 USD -> 5
  assert.equal(r.components.concentration.points, 17);
  assert.equal(r.score, 12 + 25 + 5 + 17 + 5);
  assert.equal(r.verdict, 'caution');
  const m = scoreReputation({ ...base, transfers: t, firstActivityTs: nowS - 10 * D, payToMismatch: true });
  assert.equal(m.verdict, 'avoid'); assert.ok(m.flags.includes('payto_mismatch'));
});

test('deterministic: same input -> identical output; order-independent', () => {
  const t = []; for (let i = 1; i <= 8; i++) t.push(tx(P(i), S, i, i, i));
  const a = scoreReputation({ ...base, transfers: t, firstActivityTs: nowS - 60 * D });
  const b = scoreReputation({ ...base, transfers: [...t].reverse(), firstActivityTs: nowS - 60 * D });
  assert.deepEqual(a, b);
});

test('validation: required fields, address format, endpoint SSRF syntax, lookbackDays', () => {
  assert.match(validateReputation(null).error, /body must be JSON/);
  assert.match(validateReputation({}).error, /address .* or endpoint .* is required/);
  assert.match(validateReputation({ address: '0x123' }).error, /40-hex/);
  assert.match(validateReputation({ endpoint: 'http://x.example/a' }).error, /https/);
  assert.match(validateReputation({ endpoint: 'https://127.0.0.1/a' }).error, /not an IP/);
  assert.match(validateReputation({ endpoint: 'https://localhost/a' }).error, /public hostname/);
  assert.match(validateReputation({ endpoint: 'https://u:p@x.example/a' }).error, /credentials/);
  assert.match(validateReputation({ endpoint: 'https://x.example:8443/a' }).error, /default https port/);
  assert.match(validateReputation({ endpoint: 'https://metadata.internal/a' }).error, /public hostname/);
  assert.match(validateReputation({ address: S, lookbackDays: 365 }).error, /lookbackDays/);
  const ok = validateReputation({ wallet: S.toUpperCase().replace('0X', '0x'), endpoint: 'https://seller.example/api#x' });
  assert.equal(ok.address, S); assert.equal(ok.endpoint, 'https://seller.example/api'); assert.equal(ok.lookbackDays, 90);
  assert.equal(checkEndpointSyntax('https://seller.example/x').host, 'seller.example');
});

test('payToFromChallenge: v2 header and v1 body, Base USDC only', () => {
  const v2 = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ network: 'eip155:1', payTo: P(9), asset: USDC_BASE }, { network: 'eip155:8453', payTo: S.toUpperCase().replace('0X', '0x'), asset: USDC_BASE, amount: '20000' }] })).toString('base64');
  assert.deepEqual(payToFromChallenge(v2, ''), [{ payTo: S, amount: '20000', network: 'eip155:8453' }]);
  const v1 = JSON.stringify({ x402Version: 1, accepts: [{ network: 'base', payTo: P(5), maxAmountRequired: '10000', asset: USDC_BASE }, { network: 'base', payTo: P(6), asset: '0xdeadbeef00000000000000000000000000000000' }] });
  assert.deepEqual(payToFromChallenge(null, v1).map(x => x.payTo), [P(5)]);
  assert.deepEqual(payToFromChallenge('not-base64-json', 'nope'), []);
});

test('checkSellerReputation: injected data -> signed-shape receipt; source down -> {error} (no charge)', async () => {
  const t = []; for (let i = 1; i <= 6; i++) t.push(tx(P(i), S, 2, i, i));
  const load = async () => ({ transfers: t, rawCount: t.length, firstActivityTs: nowS - 120 * D, source: 'fixture' });
  const r = await checkSellerReputation({ address: S }, { now: new Date(NOW), load });
  assert.equal(r.engine, 'gw8-seller-reputation/1');
  assert.equal(r.seller.address, S);
  assert.ok(['trusted', 'caution'].includes(r.verdict));
  assert.equal(r.reputationReceipt.endpoint, 'POST /api/seller/reputation');
  assert.equal(r.reputationReceipt.query.verdict, r.verdict);
  assert.equal(r.reputationReceipt.query.dataSha256, r.data.dataSha256);
  const down = await checkSellerReputation({ address: S }, { now: new Date(NOW), load: async () => { throw new Error('explorer HTTP 503'); } });
  assert.match(down.error, /verdict unknown: public transfer data unavailable/);
  // endpoint-only: payTo resolved from the challenge; mismatch with sent address -> avoid
  const resolve = async () => ({ host: 'seller.example', payTo: P(42), price: '20000' });
  const e1 = await checkSellerReputation({ endpoint: 'https://seller.example/api' }, { now: new Date(NOW), load, resolve });
  assert.equal(e1.seller.address, P(42)); assert.equal(e1.seller.payToSource, 'endpoint 402 challenge');
  const e2 = await checkSellerReputation({ endpoint: 'https://seller.example/api', address: S }, { now: new Date(NOW), load, resolve });
  assert.equal(e2.verdict, 'avoid'); assert.ok(e2.flags.includes('payto_mismatch'));
  const e3 = await checkSellerReputation({ endpoint: 'https://seller.example/api' }, { now: new Date(NOW), load, resolve: async () => ({ payTo: null }) });
  assert.match(e3.error, /could not read an x402 Base-USDC payTo/);
  assert.match((await checkSellerReputation({})).error, /required/);
});

test('limits are capped', () => {
  assert.equal(LIMITS.maxLookbackDays, 90);
  assert.equal(LIMITS.maxTransfers, 1000);
  assert.ok(LIMITS.explorerTimeoutMs <= 10000 && LIMITS.endpointTimeoutMs <= 10000);
});

// ---------- free data-source status (mocked fetch + clock; offline) ----------
const { getSourceStatus, _resetSourceStatusCache, STATUS_TTL_MS, STATUS_TIMEOUT_MS } = R;
const resp = (status, body) => new Response(body, { status, headers: { 'content-type': status === 200 ? 'application/json' : 'text/html' } });

test('status: reachable -> reachable:true, http 200, latency, fixed probe (no user input)', async () => {
  _resetSourceStatusCache();
  let t = 1000, url = null;
  const st = await getSourceStatus({ clock: () => t, fetchImpl: async (u) => { url = u; t += 42; return resp(200, JSON.stringify({ status: '1', message: 'OK', result: [{}] })); } });
  assert.equal(st.source, 'blockscout'); assert.equal(st.reachable, true); assert.equal(st.http_status, 200);
  assert.equal(st.latency_ms, 42); assert.equal(st.cached, false); assert.equal(st.checked_at, new Date(1042).toISOString());
  assert.match(url, /module=account&action=tokentx&contractaddress=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&sort=desc&page=1&offset=1$/);
  assert.deepEqual(Object.keys(st).sort(), ['cache_ttl_s', 'cached', 'checked_at', 'http_status', 'keyed', 'latency_ms', 'reachable', 'source']);
  assert.equal(st.keyed, false);
});

test('status: Cloudflare 403 -> reachable:false, http_status 403', async () => {
  _resetSourceStatusCache();
  const st = await getSourceStatus({ fetchImpl: async () => resp(403, '<!DOCTYPE html><title>Just a moment...</title>') });
  assert.equal(st.reachable, false); assert.equal(st.http_status, 403); assert.equal(st.error, 'HTTP 403');
  _resetSourceStatusCache();
  const html200 = await getSourceStatus({ fetchImpl: async () => resp(200, '<html>challenge</html>') });
  assert.equal(html200.reachable, false); assert.equal(html200.http_status, 200);
});

test('status: timeout -> reachable:false, http_status null, timeout error', async () => {
  _resetSourceStatusCache();
  const st = await getSourceStatus({ fetchImpl: async (u, o) => { assert.ok(o.signal); const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } });
  assert.equal(st.reachable, false); assert.equal(st.http_status, null); assert.equal(st.error, `timeout after ${STATUS_TIMEOUT_MS}ms`);
  assert.ok(STATUS_TIMEOUT_MS <= 5000);
});

test('status: cache hit within 60s (one upstream call, concurrent callers share it), refresh after TTL', async () => {
  _resetSourceStatusCache();
  let t = 0, calls = 0;
  const f = async () => { calls++; return resp(200, JSON.stringify({ status: '1', result: [] })); };
  const [a, b] = await Promise.all([getSourceStatus({ clock: () => t, fetchImpl: f }), getSourceStatus({ clock: () => t, fetchImpl: f })]);
  assert.equal(calls, 1); assert.equal(a.reachable, true); assert.equal(b.reachable, true);
  t = 30_000;
  const c = await getSourceStatus({ clock: () => t, fetchImpl: f });
  assert.equal(calls, 1); assert.equal(c.cached, true); assert.equal(c.cache_ttl_s, 30); assert.equal(c.checked_at, a.checked_at);
  t = STATUS_TTL_MS + 1;
  const d = await getSourceStatus({ clock: () => t, fetchImpl: f });
  assert.equal(calls, 2); assert.equal(d.cached, false);
  _resetSourceStatusCache();
});
