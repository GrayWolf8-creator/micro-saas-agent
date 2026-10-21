// Offline tests for the keyed data source (proposal 23). No network: every fetch is a mock. The "key" below is a fake
// placeholder string, never a real credential; the tests check it is only ever sent in the Authorization header.
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.fetch = async () => { throw new Error('offline test'); };
delete process.env.ALCHEMY_API_KEY;
const R = await import('../reputation.js');
const { activeSource, scrub, fetchSellerTransfers, normalizeAlchemyTransfers, evaluateSellerReputation, checkSellerReputation, validateReputation,
  getSourceStatus, _resetSourceStatusCache, ALCHEMY_URL, KEY_ENV, USDC_BASE, LIMITS } = R;
const { checkShouldIPay } = await import('../paydecision.js');

const FAKE = 'fake-placeholder-key-for-tests-0000';
const ENV = { [KEY_ENV]: FAKE };
const NOW = new Date(), nowS = Math.floor(NOW.getTime() / 1000), D = 86400, LATEST = 40_000_000;
const S = '0x' + 'a'.repeat(40), LOOK = '0x' + 'b'.repeat(40);
const P = i => '0x' + i.toString(16).padStart(40, '0');
const hx = n => '0x' + BigInt(n).toString(16);
let seq = 0;
// one logical transfer in both shapes (Alchemy row + Blockscout row) so parity can be checked
const T = (from, to, atomic, daysAgo, contract = USDC_BASE) => {
  const n = ++seq, ts = nowS - Math.round(daysAgo * D), hash = '0x' + n.toString(16).padStart(64, '0'), block = LATEST - Math.round(daysAgo * 43200);
  return { from, to, atomic, ts, hash, block, contract };
};
const alc = t => ({ blockNum: hx(t.block), uniqueId: `${t.hash}:log:0`, hash: t.hash, from: t.from, to: t.to, value: t.atomic / 1e6, asset: 'USDC', category: 'erc20',
  rawContract: { value: hx(t.atomic), address: t.contract, decimal: '0x6' }, metadata: { blockTimestamp: new Date(t.ts * 1000).toISOString() } });
const bs = t => ({ contractAddress: t.contract, from: t.from, to: t.to, value: String(t.atomic), timeStamp: String(t.ts), hash: t.hash });
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// healthy seller: 12 organic buyers, a self-transfer, an outgoing refund (round trip), a dust ping, a lookalike token
function fixture() {
  const xs = [];
  for (let i = 1; i <= 12; i++) xs.push(T(P(i), S, 2_000_000 + i, i * 2));
  xs.push(T(S, S, 1_000_000, 3));          // self-transfer (shows up in both in + out queries)
  xs.push(T(S, P(3), 500_000, 4));         // refund to payer 3 -> round trip
  xs.push(T(P(50), S, 500, 1));            // dust < $0.001
  xs.push(T(P(51), S, 9_000_000, 1, LOOK)); // lookalike token, must be dropped
  xs.push(T(P(52), S, 1_000_000, 200));    // outside the 90d window
  return xs;
}
const FIRST_TS = nowS - 400 * D;

/** Mock Alchemy: asserts the request shape on every call and records it. */
function mockAlchemy(xs, { onCall, pageKey = '' } = {}) {
  const calls = [];
  const f = async (url, o = {}) => {
    calls.push({ url: String(url), auth: o.headers && o.headers.authorization, body: o.body });
    if (onCall) { const r = await onCall(url, o, calls.length); if (r) return r; }
    assert.equal(url, ALCHEMY_URL);
    assert.equal(o.method, 'POST');
    const rq = JSON.parse(o.body);
    if (rq.method === 'eth_blockNumber') return json(200, { jsonrpc: '2.0', id: 1, result: hx(LATEST) });
    assert.equal(rq.method, 'alchemy_getAssetTransfers');
    const q = rq.params[0];
    assert.deepEqual(q.category, ['erc20']); assert.deepEqual(q.contractAddresses, [USDC_BASE]); assert.equal(q.excludeZeroValue, false);
    const lookalikeToo = xs; // real Alchemy filters by contract; we include the lookalike anyway to prove we drop it ourselves
    let rows = lookalikeToo.filter(t => (q.toAddress ? t.to === q.toAddress : t.from === q.fromAddress) && t.block >= parseInt(q.fromBlock, 16));
    rows.sort((a, b) => q.order === 'asc' ? a.block - b.block : b.block - a.block);
    if (q.order === 'asc') {               // first-ever transfer query
      assert.equal(q.fromBlock, '0x0'); assert.equal(q.maxCount, '0x1');
      return json(200, { jsonrpc: '2.0', id: 1, result: { transfers: q.toAddress ? [alc({ ...T(P(1), S, 1_000_000, 0), ts: FIRST_TS, block: 1 })] : [], pageKey: '' } });
    }
    assert.equal(q.maxCount, '0x3e8'); assert.equal(q.order, 'desc'); assert.equal(q.toBlock, 'latest');
    assert.equal(q.fromBlock, hx(LATEST - (LIMITS.maxLookbackDays + 1) * 43200));
    return json(200, { jsonrpc: '2.0', id: 1, result: { transfers: rows.map(alc), pageKey } });
  };
  return { f, calls };
}
/** Mock Blockscout with the same logical data (newest 1000 regardless of window, like the real API). */
function mockBlockscout(xs) {
  return async (url) => {
    const q = new URL(url).searchParams, a = q.get('address');
    if (q.get('sort') === 'asc') return json(200, { status: '1', result: [bs({ ...T(P(1), S, 1_000_000, 0), ts: FIRST_TS })] });
    const rows = xs.filter(t => t.to === a || t.from === a).sort((x, y) => y.ts - x.ts).map(bs);
    return json(200, { status: '1', result: rows });
  };
}
const leaks = s => String(s).includes(FAKE);

test('activeSource: key set -> alchemy (keyed); unset/blank -> blockscout; never returns the key', () => {
  assert.deepEqual(activeSource({}), { name: 'blockscout', keyed: false });
  assert.deepEqual(activeSource({ [KEY_ENV]: '   ' }), { name: 'blockscout', keyed: false });
  assert.deepEqual(activeSource(ENV), { name: 'alchemy', keyed: true });
  assert.equal(KEY_ENV, 'ALCHEMY_API_KEY');
  assert.ok(!leaks(JSON.stringify(activeSource(ENV))));
  assert.ok(!ALCHEMY_URL.includes(FAKE) && ALCHEMY_URL === 'https://base-mainnet.g.alchemy.com/v2');
});

test('keyed loader: 5 calls to the fixed URL, key only in Authorization header, window + first-activity queries', async () => {
  const { f, calls } = mockAlchemy(fixture());
  const d = await fetchSellerTransfers(S, f, { env: ENV });
  assert.equal(calls.length, 5);
  for (const c of calls) { assert.equal(c.url, ALCHEMY_URL); assert.equal(c.auth, `Bearer ${FAKE}`); assert.ok(!leaks(c.url) && !leaks(c.body)); }
  assert.equal(d.provider, 'alchemy'); assert.ok(!leaks(d.source));
  assert.equal(d.firstActivityTs, FIRST_TS);
  assert.ok(d.transfers.every(t => Object.keys(t).sort().join() === 'from,hash,to,ts,value'));
  assert.equal(d.transfers.filter(t => t.from === S && t.to === S).length, 1, 'self-transfer de-duplicated');
  assert.ok(!d.transfers.some(t => t.from === P(51)), 'lookalike token dropped');
  assert.ok(!d.transfers.some(t => t.from === P(52)), 'outside fromBlock window not returned');
  for (let i = 1; i < d.transfers.length; i++) assert.ok(d.transfers[i - 1].ts >= d.transfers[i].ts, 'newest first');
});

test('parity: same transfers via Alchemy and Blockscout -> identical score, verdict, components, dataSha256', async () => {
  const xs = fixture(), v = validateReputation({ address: S });
  const a = await evaluateSellerReputation(v, { now: NOW, env: ENV, fetchImpl: mockAlchemy(xs).f });
  const b = await evaluateSellerReputation(v, { now: NOW, env: {}, fetchImpl: mockBlockscout(xs) });
  assert.ok(!a.error && !b.error, JSON.stringify(a.error || b.error));
  // Blockscout also returns the 200-day-old transfer (scored out by the window); Alchemy's fromBlock skips it, so only the scanned list differs
  assert.equal(a.out.data.provider, 'alchemy'); assert.equal(b.out.data.provider, 'blockscout');
  for (const k of ['verdict', 'score', 'components', 'reasons', 'flags']) assert.deepEqual(a.out[k], b.out[k], k);
  assert.equal(b.out.data.transfersScanned - a.out.data.transfersScanned, 1);
  const inWin = xs.filter(t => t.from !== P(52));     // same data inside the window -> same dataSha256 (receipt hash) too
  const a2 = await evaluateSellerReputation(v, { now: NOW, env: ENV, fetchImpl: mockAlchemy(inWin).f });
  const b2 = await evaluateSellerReputation(v, { now: NOW, env: {}, fetchImpl: mockBlockscout(inWin) });
  assert.equal(a2.dataSha256, b2.dataSha256); assert.equal(a2.out.score, a.out.score);
  assert.equal(a.out.window.ignoredDust, 1, 'dust floor ($0.001) applied');
  assert.ok(a.out.flags.includes('self_transfers') && a.out.flags.includes('round_trips'));
  assert.equal(a.out.window.lookbackDays, 90);
});

test('normalizeAlchemyTransfers drops lookalikes, bad hex, missing timestamps; keeps big values exact', () => {
  const good = alc(T(P(1), S, 123456789, 1));
  const rows = [good, { ...good, rawContract: { ...good.rawContract, address: LOOK } }, { ...good, rawContract: { ...good.rawContract, value: '12' } },
    { ...good, metadata: {} }, { ...good, from: 'nope' }, { ...good, rawContract: { ...good.rawContract, value: '0x' + 'f'.repeat(30) } }];
  const n = normalizeAlchemyTransfers(rows);
  assert.equal(n.length, 2); assert.equal(n[0].value, 123456789n); assert.equal(n[1].value, BigInt('0x' + 'f'.repeat(30)));
});

test('pageKey present -> treated as truncated (newest 1000 cap reason shown)', async () => {
  const r = await evaluateSellerReputation(validateReputation({ address: S }), { now: NOW, env: ENV, fetchImpl: mockAlchemy(fixture(), { pageKey: 'abc' }).f });
  assert.equal(r.out.window.truncated, true);
  assert.ok(r.out.reasons.some(x => /newest 1000/.test(x)));
});

test('keyed source unavailable -> {error} (caller does not charge), and the error never contains the key', async () => {
  const cases = [
    ['401', async () => json(401, { error: { code: -32600, message: `Must be authenticated! key=${FAKE}` } }), /rejected the request \(HTTP 401\)/],
    ['403', async () => json(403, 'forbidden'), /HTTP 403/],
    ['429', async () => json(429, 'slow down'), /rate limited/],
    ['500', async () => json(500, 'oops'), /HTTP 500/],
    ['rpc error', async () => json(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: `bad params for ${FAKE}` } }), /RPC error -32602/],
    ['bad json', async () => json(200, '<html>'), /invalid JSON/],
    ['no list', async (u, o) => JSON.parse(o.body).method === 'eth_blockNumber' ? json(200, { result: hx(LATEST) }) : json(200, { result: { nope: 1 } }), /no transfer list/],
    ['timeout', async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }, /aborted due to timeout/],
    ['throw with key in URL', async () => { throw new Error(`request to https://base-mainnet.g.alchemy.com/v2/${FAKE} failed, Authorization: Bearer ${FAKE}`); }, /\[redacted\]/],
  ];
  for (const [name, f, re] of cases) {
    const r = await checkSellerReputation({ address: S }, { now: NOW, env: ENV, fetchImpl: f });
    assert.ok(r.error, name); assert.match(r.error, /public transfer data unavailable/, name); assert.match(r.error, re, name);
    assert.ok(!leaks(r.error), `${name}: key leaked: ${r.error}`);
  }
});

test('key never appears in any output, receipt, status body, error or log line', async () => {
  const logged = [], orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
  try {
    const xs = fixture();
    const ok = await checkSellerReputation({ address: S }, { now: NOW, env: ENV, fetchImpl: mockAlchemy(xs).f });
    assert.ok(!ok.error); assert.ok(ok.reputationReceipt && ok.reputationReceipt.payload);   // unsigned in tests (no signing key set), same shape
    assert.ok(!leaks(JSON.stringify(ok, (k, v) => typeof v === 'bigint' ? String(v) : v)));
    const bad = await checkSellerReputation({ address: S }, { now: NOW, env: ENV, fetchImpl: async () => { throw new Error(`boom ${FAKE}`); } });
    assert.ok(!leaks(JSON.stringify(bad)));
    _resetSourceStatusCache();
    const st = await getSourceStatus({ env: ENV, fetchImpl: async () => { throw new Error(`net down ${FAKE}`); } });
    assert.ok(!leaks(JSON.stringify(st)));
    _resetSourceStatusCache();
    const st2 = await getSourceStatus({ env: ENV, fetchImpl: async () => json(200, { error: { code: -32600, message: `bad key ${FAKE}` } }) });
    assert.ok(!leaks(JSON.stringify(st2))); assert.equal(st2.error, 'RPC error -32600');
    const sp = await checkShouldIPay(spBody(), { now: NOW, env: ENV, fetchImpl: mockAlchemy(xs).f });
    assert.ok(!leaks(JSON.stringify(sp)));
  } finally { Object.assign(console, orig); }
  assert.ok(!logged.some(leaks), 'a log line contained the key');
  assert.equal(scrub(`x https://base-mainnet.g.alchemy.com/v2/${FAKE}?a=1 Bearer ${FAKE}`, ENV), 'x https://base-mainnet.g.alchemy.com/v2/[redacted]?a=1 Bearer [redacted]');
  assert.equal(scrub('https://base-mainnet.g.alchemy.com/v2/someOtherKey123', {}), 'https://base-mainnet.g.alchemy.com/v2/[redacted]');
});

test('status with key: source alchemy, keyed true, reachable; 401 -> reachable:false; switching source drops the cache', async () => {
  _resetSourceStatusCache();
  let seen = null, t = 0;
  const st = await getSourceStatus({ env: ENV, clock: () => t, fetchImpl: async (u, o) => { seen = { u, o }; t += 7; return json(200, { jsonrpc: '2.0', id: 1, result: { transfers: [{}] } }); } });
  assert.equal(st.source, 'alchemy'); assert.equal(st.keyed, true); assert.equal(st.reachable, true); assert.equal(st.http_status, 200); assert.equal(st.latency_ms, 7);
  assert.deepEqual(Object.keys(st).sort(), ['cache_ttl_s', 'cached', 'checked_at', 'http_status', 'keyed', 'latency_ms', 'reachable', 'source']);
  assert.equal(seen.u, ALCHEMY_URL); assert.equal(seen.o.headers.authorization, `Bearer ${FAKE}`); assert.ok(!leaks(seen.o.body));
  const q = JSON.parse(seen.o.body).params[0];
  assert.equal(q.toAddress, USDC_BASE); assert.equal(q.maxCount, '0x1');   // fixed probe, no user input
  const hit = await getSourceStatus({ env: ENV, clock: () => t, fetchImpl: async () => { throw new Error('should be cached'); } });
  assert.equal(hit.cached, true); assert.equal(hit.source, 'alchemy');
  const sw = await getSourceStatus({ env: {}, clock: () => t, fetchImpl: async () => json(403, '<title>Just a moment...</title>') });
  assert.equal(sw.cached, false); assert.equal(sw.source, 'blockscout'); assert.equal(sw.keyed, false); assert.equal(sw.http_status, 403);
  _resetSourceStatusCache();
  const den = await getSourceStatus({ env: ENV, fetchImpl: async () => json(401, { error: 'unauthorized' }) });
  assert.equal(den.reachable, false); assert.equal(den.http_status, 401); assert.equal(den.error, 'HTTP 401');
});

const spBody = (o = {}) => ({ payment: { amount: '0.05', currency: 'USDC', chain: 'base', recipientId: S, merchantCategory: 'data-api', timestamp: NOW.toISOString(), agentId: 'a1' },
  policy: { currency: 'USDC', perTxLimit: '1', allowedChains: ['base'], allowedAssets: ['USDC'] }, seller: { address: S }, ...o });

test('should-i-pay uses the keyed source too (and is free when it is down)', async () => {
  const { f, calls } = mockAlchemy(fixture());
  const r = await checkShouldIPay(spBody(), { now: NOW, env: ENV, fetchImpl: f });
  assert.ok(!r.error, r.error);
  assert.equal(r.seller.data.provider, 'alchemy'); assert.equal(calls.length, 5);
  assert.ok(['pay', 'ask_human', 'dont_pay'].includes(r.verdict)); assert.ok(r.decisionReceipt && r.decisionReceipt.payload);
  const down = await checkShouldIPay(spBody(), { now: NOW, env: ENV, fetchImpl: async () => json(401, 'no') });
  assert.match(down.error, /unavailable/); assert.ok(!leaks(down.error));
});

test('process.env is read at call time (key added after import switches the source)', async () => {
  assert.equal(activeSource().name, 'blockscout');
  process.env[KEY_ENV] = FAKE;
  try { assert.equal(activeSource().name, 'alchemy'); const { f } = mockAlchemy(fixture()); assert.equal((await fetchSellerTransfers(S, f)).provider, 'alchemy'); }
  finally { delete process.env[KEY_ENV]; }
  assert.equal(activeSource().name, 'blockscout');
});
