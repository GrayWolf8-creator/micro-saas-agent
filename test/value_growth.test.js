// Value-capture and growth-lane: scoring math, filters, 402 quotes, free status, and the 503 path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BANNED = /\b(buy|sell|entry|target)\b/i;
function walk(v, where, bad) {
  if (v == null) return;
  if (typeof v === 'string') { if (BANNED.test(v)) bad.push(where + ': ' + v.slice(0, 80)); return; }
  if (Array.isArray(v)) return v.forEach((x, i) => walk(x, where + '[' + i + ']', bad));
  if (typeof v === 'object') for (const [k, val] of Object.entries(v)) {
    if (BANNED.test(k)) bad.push(where + ' key ' + k);
    walk(val, where + '.' + k, bad);
  }
}
function boot(t, port, env) {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start')), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(srv); } });
    srv.stderr.on('data', () => {});
  });
}
const amountOf = async (base, url) => {
  const r = await realFetch(base + url);
  const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
  return { status: r.status, amount: pr.accepts[0].amount, description: pr.resource.description };
};

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async () => { throw new Error('offline'); };
const value = await import('../value.js');
const growth = await import('../growth.js');

test('value scoring boundaries', () => {
  assert.deepEqual(value.scoreNetSupply(0, -1), { points: 30, max: 30, pass: true, trailing90dPct: 0, next12mPct: -1 });
  assert.equal(value.scoreNetSupply(-1, 4).points, 15);
  assert.equal(value.scoreNetSupply(-1, 4).pass, 'partial');
  assert.equal(value.scoreNetSupply(-2, null).points, 15);
  assert.equal(value.scoreNetSupply(3, 4).points, 0);
  assert.equal(value.scoreNetSupply(null, null).points, 0);
  assert.equal(value.scoreHolderYield(null).points, 0);
  assert.equal(value.scoreHolderYield(2).points, 25);
  assert.equal(value.scoreHolderYield(0.5).points, 0);
  assert.equal(value.scoreHolderYield(0.5).pass, 'partial');
  assert.equal(value.scoreHolderYield(1.25).points, 13);
  assert.equal(value.scoreHolderYield(0.49).pass, false);
  assert.equal(value.scoreUsageBypass('required').points, 20);
  assert.equal(value.scoreUsageBypass('partial').points, 10);
  assert.equal(value.scoreUsageBypass('bypassable').points, 0);
  assert.equal(value.scoreUsageBypass(null).pass, false);
  assert.equal(value.scoreBurnVsHeld('burned').points, 10);
  assert.equal(value.scoreBurnVsHeld('held').points, 5);
  assert.equal(value.scoreBurnVsHeld('held_end_dated').points, 3);
  assert.equal(value.scoreBurnVsHeld('none').points, 0);
  const u = value.scoreUnlockOverhang;
  assert.equal(u(null, null).points, 0);
  assert.equal(u(5, null).points, 0);
  assert.equal(u(11, null).points, 0);
  assert.equal(u(1.99, 0).points, 15);
  assert.equal(u(2, 0).points, 10);
  assert.equal(u(4.99, 0).points, 10);
  assert.equal(u(5, 0).points, 5);
  assert.equal(u(10, 0).points, 5);
  assert.equal(u(10.01, 0).points, 0);
  assert.equal(value.gradeOf(75), 'strong');
  assert.equal(value.gradeOf(50), 'medium');
  assert.equal(value.gradeOf(25), 'weak');
  assert.equal(value.gradeOf(24), 'fail');
});

test('value screen sort, minScore and rwa tiebreak', () => {
  const row = (symbol, score, rwa, annual, trail) => ({ symbol, score, rwaUsd: rwa, components: { holderYield: { annualPct: annual }, netSupply: { trailing90dPct: trail } } });
  const rows = [row('BBB', 40, 5, 1, 2), row('AAA', 40, 9, 3, -1), row('CCC', 10, null, null, 0)];
  const byScore = value.screenValue(rows, { sort: 'score', minScore: 0 });
  assert.deepEqual(byScore.map(r => r.symbol), ['AAA', 'BBB', 'CCC']);
  assert.deepEqual(value.screenValue(rows, { sort: 'score', minScore: 40 }).map(r => r.symbol), ['AAA', 'BBB']);
  assert.equal(value.screenValue(rows, { sort: 'yield' })[0].symbol, 'AAA');
  assert.equal(value.screenValue(rows, { sort: 'netSupply90d' })[0].symbol, 'AAA');
  assert.equal(value.parseValueQuery({ sort: 'nope' }).error.includes('sort'), true);
  assert.equal(value.parseValueQuery({ minScore: 101 }).error.includes('minScore'), true);
  assert.equal(value.parseValueQuery({ symbols: 'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z' }).error.includes('25'), true);
  assert.equal(value.parseWeeks('12').weeks, 12);
  assert.ok(value.parseWeeks('0').error);
  assert.equal(value.weekEndings(Date.UTC(2026, 9, 27), 3).length, 3);
});

test('curated value files and built rows avoid banned words and do not invent unlocks', () => {
  const bad = [];
  for (const name of ['rules_value.json', 'value_unlocks.json', 'growth_coverage.json']) walk(JSON.parse(readFileSync(path.join(ROOT, 'data', name), 'utf8')), name, bad);
  const coin = value.buildValueCoin({ symbol: 'BNB', name: 'BNB', usageClass: 'required', burnClass: 'burned' });
  walk(coin, 'coin', bad);
  assert.equal(coin.components.burnVsHeld.programEndDate, null);
  assert.equal(Object.hasOwn(coin.components.burnVsHeld, 'buybackEndDate'), false);
  assert.ok(coin.unverified.length > 0);
  assert.equal(coin.components.netSupply.confidence, 'low');
  assert.deepEqual(bad, []);
  assert.ok(value.findCoin('BNB'));
  assert.ok(value.coveredSymbols().includes('BTC'));
});

test('value and growth upstream failure returns sourceStatus and status stays shaped', async () => {
  const down = async () => { throw new Error('down'); };
  const v = await value.getValueSymbol('BNB', { fetchImpl: down });
  assert.match(v.error, /unavailable/);
  assert.ok(v.sourceStatus && v.sourceStatus.defillamaHolders);
  const hist = await value.getValueHistory('BTC', 4, { fetchImpl: down });
  assert.ok(hist.sourceStatus);
  const st = await value.getValueStatus({ fetchImpl: down });
  assert.equal(st.free, true);
  assert.ok(Array.isArray(st.sources) && st.disclaimer);
  assert.ok(st.coverage.some(c => c.symbol === 'BNB'));
  const g = await growth.getGrowthList(growth.parseGrowthQuery({}), { fetchImpl: down });
  assert.match(g.error, /unavailable/);
  assert.ok(g.sourceStatus);
  const gs = await growth.getGrowthStatus({ fetchImpl: down });
  assert.equal(gs.free, true);
  assert.ok(gs.coverage.some(c => c.chain === 'solana' || c.chain === 'ethereum'));
  assert.ok(gs.disclaimer && Array.isArray(gs.sources));
  const bad = [];
  walk(st, 'status', bad); walk(gs, 'gstatus', bad);
  assert.deepEqual(bad, []);
});

test('growth rule states, traps, filters and first flips', () => {
  const base = { chain: 'monad', symbol: 'MON', kind: 'chain', priceChange90dPct: 0, btcReturn90dPct: 10, stablesChange90dPct: 60, stablesAth: false, feesChange90dPct: 70, nativeFeesChange90dPct: 70, mcapToFeesTrend: 'falling', tvlChange90dPct: 60, tvlUsd: 80_000_000 };
  const early = growth.evalGrowth({ ...base, btcReturn90dPct: 10 });
  assert.equal(early.rules.vsBtc.pass, false);
  assert.equal(early.state, 'early');
  assert.ok(early.rulesPassed >= 2);
  const confirmed = growth.evalGrowth({ ...base, btcReturn90dPct: -1, priceChange90dPct: 5 });
  assert.equal(confirmed.rules.vsBtc.pass, true);
  assert.equal(confirmed.state, 'confirmed');
  const onlyLead = growth.evalGrowth({ ...base, tvlChange90dPct: 34, stablesChange90dPct: 10, feesChange90dPct: 10, mcapToFeesTrend: 'rising' });
  assert.equal(onlyLead.rules.tvl.pass, false);
  assert.match(onlyLead.rules.tvl.note, /50% threshold not met/);
  const trigger = growth.evalGrowth({ chain: 'x', symbol: 'X', kind: 'chain', priceChange90dPct: 5, btcReturn90dPct: 0, stablesChange90dPct: 1, feesChange90dPct: 1, mcapToFeesTrend: 'rising', tvlChange90dPct: 1, tvlUsd: 80_000_000 });
  assert.equal(trigger.state, 'trigger_only');
  const onePlus = growth.evalGrowth({ ...base, stablesChange90dPct: 10, tvlChange90dPct: 1, btcReturn90dPct: -1, priceChange90dPct: 5 });
  assert.equal(onePlus.rules.fees.pass, true);
  assert.equal(onePlus.rules.vsBtc.pass, true);
  assert.equal(onePlus.state, 'none');
  const app = growth.evalGrowth({ ...base, kind: 'app', chain: 'hyperliquid' });
  assert.equal(app.rules.stables.pass, null);
  assert.match(app.rules.stables.note, /not applicable/);
  const tiny = growth.evalGrowth({ ...base, tvlUsd: 40_000_000, pointsFarming: true, ownTokenShare: 0.5, feesChange90dPct: 80, nativeFeesChange90dPct: 10, priceChange90dPct: 20, btcReturn90dPct: 0 });
  assert.ok(tiny.traps.some(t => t.id === 'tinyBase'));
  assert.ok(tiny.traps.some(t => t.id === 'pointsFarming'));
  assert.ok(tiny.traps.some(t => t.id === 'tvlSelfToken'));
  assert.ok(tiny.traps.some(t => t.id === 'usdFeesDuringPriceRun'));
  const rows = [early, { ...early, kind: 'app', chain: 'aave', tvlUsd: 10_000_000 }, { ...early, chain: 'unknown', tvlUsd: null }];
  assert.equal(growth.applyGrowthFilters(rows, { kind: 'app', minRulesPassed: 0, triggerOnly: false, minTvlUsd: 0 }).length, 1);
  assert.equal(growth.applyGrowthFilters(rows, { kind: 'all', minRulesPassed: 0, triggerOnly: true, minTvlUsd: 0 }).length, 0);
  assert.equal(growth.applyGrowthFilters([{ ...early, tvlUsd: 10 }, { ...early, chain: 'n', tvlUsd: null }], { kind: 'all', minTvlUsd: 50 }).length, 1);
  const flips = growth.firstFlips([
    { weekEnding: '2026-10-04', rows: [{ chain: 'monad', symbol: 'MON', rules: { fees: { pass: false }, stables: { pass: false }, tvl: { pass: false }, vsBtc: { pass: false } } }] },
    { weekEnding: '2026-10-11', rows: [{ chain: 'monad', symbol: 'MON', rules: { fees: { pass: true }, stables: { pass: false }, tvl: { pass: false }, vsBtc: { pass: true } } }] }
  ]);
  assert.deepEqual(flips.map(f => f.rule), ['fees', 'vsBtc']);
  assert.equal(flips[0].firstWeek, '2026-10-11');
  const end = 200 * 86400;
  const series = { chain: 'solana', symbol: 'SOL', kind: 'chain', fees: [], stables: [], price: [{ t: end - 90 * 86400, v: 100 }, { t: end, v: 100 }], tvl: [{ t: end - 90 * 86400, v: 100 }, { t: end, v: 160 }], mcapNow: 1000, priceNow: 100, pointsFarming: false };
  const m = growth.metricsAt(series, [{ t: end - 90 * 86400, v: 100 }, { t: end, v: 110 }], end);
  assert.equal(m.priceChange90dPct, 0);
  assert.ok(m.tvlChange90dPct > 50);
  assert.equal(growth.parseGrowthQuery({ window: '30d' }).error.includes('90d'), true);
  const bad = [];
  walk(early, 'early', bad); walk(tiny, 'tiny', bad);
  assert.deepEqual(bad, []);
});

test('402 quotes, free status routes, and marketplace 503 with sourceStatus', async (t) => {
  const port = 43000 + Math.floor(Math.random() * 1000);
  await boot(t, port, {});
  const base = `http://127.0.0.1:${port}`;
  const one = await amountOf(base, '/api/value/BNB');
  const batch = await amountOf(base, '/api/value');
  const hist = await amountOf(base, '/api/value/BNB/history');
  const g1 = await amountOf(base, '/api/growth/solana');
  const glist = await amountOf(base, '/api/growth');
  const ghist = await amountOf(base, '/api/growth/history');
  assert.equal(one.status, 402);
  assert.equal(one.amount, '15000');
  assert.equal(batch.amount, '30000');
  assert.equal(hist.amount, '70000');
  assert.equal(g1.amount, '15000');
  assert.equal(glist.amount, '30000');
  assert.equal(ghist.amount, '70000');
  for (const d of [one, batch, hist, g1, glist, ghist]) {
    assert.ok(d.description.length <= 500, d.description);
    assert.ok(!d.description.endsWith('...'), d.description);
    assert.ok(!BANNED.test(d.description), d.description);
  }
  const st = await (await realFetch(base + '/api/value/status')).json();
  const gs = await (await realFetch(base + '/api/growth/status')).json();
  assert.equal(st.free, true);
  assert.ok(st.coverage.some(c => c.symbol === 'BNB'));
  assert.ok(Array.isArray(st.sources) && st.disclaimer);
  assert.equal(gs.free, true);
  assert.ok(gs.coverage.some(c => c.chain === 'ethereum' || c.chain === 'solana'));
  assert.ok(Array.isArray(gs.sources) && gs.disclaimer);

  const port2 = port + 1;
  await boot(t, port2, {
    APIFY_PARTNER_KEY: 'test-partner',
    GW8_LLAMA_BASE: 'http://127.0.0.1:9',
    GW8_STABLES_BASE: 'http://127.0.0.1:9',
    GW8_COINS_BASE: 'http://127.0.0.1:9',
    GW8_KRAKEN_BASE: 'http://127.0.0.1:9'
  });
  const base2 = `http://127.0.0.1:${port2}`;
  const headers = { 'x-gw8-partner-key': 'test-partner' };
  const a = await realFetch(base2 + '/mkt/apify/value/BNB', { headers });
  const aj = await a.json();
  assert.equal(a.status, 503);
  assert.ok(aj.sourceStatus, JSON.stringify(aj));
  const b = await realFetch(base2 + '/mkt/apify/growth/solana', { headers });
  const bj = await b.json();
  assert.equal(b.status, 503);
  assert.ok(bj.sourceStatus, JSON.stringify(bj));
});
