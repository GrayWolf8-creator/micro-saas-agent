// Day pass first, free samples, bot-vs-buyer conversion, and input schemas on every paid route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async () => { throw new Error('offline'); };
const trust = await import('../trust.js');
const stats = await import('../stats.js');
const sample = await import('../sample.js');

test('day-pass break-even is computed from current prices', () => {
  assert.equal(trust.breakEvenCalls('0.002'), 500);
  assert.equal(trust.breakEvenCalls('0.01'), 100);
  assert.equal(trust.breakEvenCalls('0.02'), 50);
  assert.equal(trust.breakEvenCalls('0.05'), 20);
  assert.equal(trust.breakEvenCalls('0.015'), 66);
  assert.equal(trust.breakEvenCalls('0.03'), 33);
  assert.equal(trust.breakEvenCalls('0.07'), 14);
  const coin = trust.funnel('https://micro-saas-agent.onrender.com/api/coin/BTC', { callUsd: 0.002 });
  assert.equal(Object.keys(coin.body)[0], 'dayPass');
  assert.match(coin.body.dayPass.note, /best value if you call more than 500 times/i);
  assert.ok(coin.body.bestValue);
  const pass = trust.funnel('https://micro-saas-agent.onrender.com/api/pass/day', { callUsd: 1 });
  assert.match(pass.body.dayPass.note, /this is the day pass/i);
  assert.doesNotMatch(pass.body.dayPass.note, /more than \d+ times/i);
});

test('top quoted routes fall back to verdict, coin and rails', () => {
  assert.deepEqual(sample.topQuotedPaid([]).map(r => r.kind), ['verdict', 'coin', 'rails']);
  assert.deepEqual(sample.topQuotedPaid([{ route: 'GET /api/coin/:symbol', quotes: 1 }]).map(r => r.kind), ['verdict', 'coin', 'rails']);
  const top = sample.topQuotedPaid([
    { route: 'GET /api/regime', quotes: 9 },
    { route: 'GET /api/dots', quotes: 8 },
    { route: 'GET /api/brief', quotes: 7 },
    { route: 'GET /api/coin/:symbol', quotes: 3 }
  ]);
  assert.deepEqual(top.map(r => r.route), ['GET /api/regime', 'GET /api/dots', 'GET /api/brief']);
});

test('sample truncators stay labeled and omit the paid detail', () => {
  const v = sample.truncateVerdict({ chain: 'base', address: '0xabc', score: 80, verdict: 'safe', reasons: ['should not copy'], disclaimer: 'signal only, not financial advice', sources: ['https://example.test/src'] });
  assert.equal(v.sample, true);
  assert.equal(v.truncated, true);
  assert.equal(v.paidRoute, '/api/verdict/base/0xabc');
  assert.equal(v.paidPriceUsd, '0.01');
  assert.equal(Object.hasOwn(v, 'reasons'), false);
  assert.ok(v.disclaimer && v.sources.length);
  const rails = sample.truncateRails({ amountUsd: 100, recommended: { rail: 'base-usdc' }, rails: [{ rail: 'base-usdc', source: 'https://example.test/gas' }, { rail: 'card', source: 'card' }], disclaimer: 'signal only, not financial advice' });
  assert.equal(rails.truncated, true);
  assert.equal(Object.hasOwn(rails, 'rails'), false);
  assert.equal(rails.recommended.rail, 'base-usdc');
  const coin = sample.coinSampleFromRows('BTC', [[1700000000, 1, 2, 3, 4.5]]);
  assert.equal(coin.delayed, true);
  assert.equal(coin.close, 4.5);
  assert.equal(Object.hasOwn(coin, 'wt1'), false);
  assert.match(coin.label, /WaveTrend/);
  assert.equal(sample.precheckSample('GET /api/coin/:symbol', { params: { symbol: 'NOTACOIN' } }).http, 404);
});

test('sample cap is per hash per UTC day and refunds one slot', () => {
  process.env.GW8_SAMPLE_DAILY_CAP = '2';
  sample._resetSamples();
  const h = sample.hashIp('203.0.113.50');
  assert.equal(sample.takeSample(h).ok, true);
  assert.equal(sample.takeSample(h).ok, true);
  assert.equal(sample.takeSample(h).status, 429);
  sample.refundSample(h);
  assert.equal(sample.takeSample(h).ok, true);
  assert.equal(sample.hashIp('203.0.113.50'), h);
  assert.notEqual(h, '203.0.113.50');
});

test('quote conversion reclassifies repeat no-payment addresses without double counting bots', async () => {
  const pure = stats.quoteConversion({
    botQuotes: 5,
    buyerQuotes: 10,
    ips: [
      { quotes: 8, paid: 0, botQuotes: 3 },
      { quotes: 8, paid: 1, botQuotes: 0 },
      { quotes: 7, paid: 0, botQuotes: 0 }
    ]
  });
  assert.equal(pure.likelyBots.quotes, 10);
  assert.equal(pure.likelyBots.reclassifiedFromBuyerQuotes, 5);
  assert.equal(pure.likelyRealBuyers.quotes, 5);
  assert.equal(pure.likelyBots.repeatNoPayIps, 1);
  assert.equal(stats.REPEAT_NOPAY_QUOTES, 8);

  const repeat = stats.hashIp('203.0.113.9');
  const botIp = stats.hashIp('203.0.113.8');
  for (let i = 0; i < 8; i++) await stats.recordAudience({ route: 'GET /api/coin/:symbol', statusCode: 402, ua: 'Mozilla/5.0', paidRoute: true, ipHash: repeat });
  await stats.recordAudience({ route: 'GET /api/regime', statusCode: 402, ua: 'x402scan/1.0', paidRoute: true, ipHash: botIp });
  const payer = '0x' + 'ab'.repeat(20);
  await stats.recordAudience({ route: 'GET /api/rails', statusCode: 200, ua: 'Mozilla/5.0 GW8Test', payer, paidRoute: true, ipHash: stats.hashIp('203.0.113.7') });
  const s = await stats.getStats(1);
  assert.ok(s.totals && s.routes && s.audience.bot && s.audience.likelyBuyer && s.audience.self);
  assert.equal(s.audience.likelyBuyer.quotes, 8);
  assert.equal(s.audience.conversion.likelyRealBuyers.quotes, 0);
  assert.equal(s.audience.conversion.likelyRealBuyers.paid, 1);
  assert.equal(s.audience.conversion.likelyRealBuyers.quoteToPaid, null);
  assert.ok(s.audience.conversion.likelyBots.quotes >= 9);
  assert.equal(s.audience.conversion.graders.wallets, 0);
  assert.match(s.audience.conversion.graders.note, /no wallet/);
  const blob = JSON.stringify(s);
  assert.equal(blob.includes('203.0.113'), false);
  assert.match(stats.renderStatsMd(s), /Quote to paid/);
  assert.match(stats.renderStatsHtml(s), /Real-buyer quotes/);
});

test('402 body, discovery, openapi, llms.txt and input schemas lead with the day pass', async (t) => {
  const port = 44000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), GW8_SAMPLE_DAILY_CAP: '2' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => srv.kill());
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start')), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const coin = await realFetch(base + '/api/coin/BTC');
  const body = await coin.json();
  assert.equal(coin.status, 402);
  assert.equal(Object.keys(body)[0], 'dayPass');
  assert.match(body.dayPass.note, /best value if you call more than 500 times/i);
  assert.equal(body.gw8.dayPass.note, body.dayPass.note);
  const llms = await (await realFetch(base + '/llms.txt')).text();
  assert.match(llms, /Day pass first/);
  assert.match(llms, /more than 500/);
  assert.match(llms, /more than 66/);
  const disc = await (await realFetch(base + '/.well-known/x402')).json();
  assert.match(disc.resources[0], /\/api\/pass\/day$/);
  assert.match(disc.instructions, /more than 500/);
  const doc = await (await realFetch(base + '/openapi.json')).json();
  assert.match(doc.info['x-guidance'], /^Day pass first/);
  let n = 0;
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) {
    if (!op['x-payment-info']) continue;
    const url = p.replace('{symbol}', 'BTC').replace('{chain}', 'base').replace('{address}', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    const method = m.toUpperCase();
    const r = await realFetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 402, method + ' ' + url);
    const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
    const input = pr.extensions.bazaar.info.input;
    const schema = pr.extensions.bazaar.schema.properties.input;
    const challengeMethod = input.method;
    if (challengeMethod === 'GET') {
      assert.ok(input.queryParams && typeof input.queryParams === 'object', url);
      assert.ok(schema.properties.queryParams, url);
      assert.ok(schema.required.includes('queryParams'), url);
    } else {
      assert.ok(schema.properties.body, url);
      assert.ok(input.body && typeof input.body === 'object', url);
    }
    if (pr.extensions.bazaar.info.input.pathParams) assert.ok(schema.properties.pathParams.required.length > 0, url);
    assert.match(op.responses['402'].description, /Day pass first/);
    assert.match(op.responses['402'].description, /best value if you call more than|this is the day pass/i);
    n++;
  }
  assert.ok(n >= 15, 'paid routes ' + n);

  const missing = await realFetch(base + '/api/coin/NOTACOIN?sample=1');
  assert.equal(missing.status, 404);
  const s1 = await realFetch(base + '/api/coin/BTC?sample=1');
  const j1 = await s1.json();
  assert.notEqual(s1.status, 402);
  assert.equal(j1.sample, true);
  if (s1.status === 200) {
    assert.equal(j1.truncated, true);
    assert.equal(Object.hasOwn(j1, 'wt1'), false);
    assert.ok(j1.paidRoute && j1.disclaimer && j1.sources);
  } else {
    assert.equal(s1.status, 503);
    assert.ok(j1.sourceStatus);
  }
  const s2 = await realFetch(base + '/api/coin/BTC?sample=1');
  assert.notEqual(s2.status, 402);
  const s3 = await realFetch(base + '/api/coin/BTC?sample=1');
  assert.equal(s3.status, 429);
  const other = await realFetch(base + '/api/regime?sample=1');
  assert.equal(other.status, 402);
});
