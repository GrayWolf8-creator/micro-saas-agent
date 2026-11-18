// Daily bundle ($0.025), brief-first discovery, teaser split, and a paid call with a stubbed facilitator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DAILY_BUNDLE_PRICE_USD, usdAtomic, VERDICT_PRICE_USD } from '../prices.js';
import { shapeBriefTeaser, regimeLabel } from '../upgrades.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAYTO = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function keys() {
  return { PATH: process.env.PATH };
}

test('bundle price is $0.025 and cheaper than brief plus regime', () => {
  assert.equal(DAILY_BUNDLE_PRICE_USD, '0.025');
  assert.equal(usdAtomic(DAILY_BUNDLE_PRICE_USD), '25000');
  assert.equal(VERDICT_PRICE_USD, '0.005');
  assert.ok(Number(DAILY_BUNDLE_PRICE_USD) < 0.02 + 0.01);
});

test('teaser shows today\'s regime and the top 3 names, and gates the paid detail', () => {
  assert.equal(regimeLabel(4), 'risk-on');
  assert.equal(regimeLabel(3), 'risk-on');
  assert.equal(regimeLabel(2), 'mixed');
  assert.equal(regimeLabel(1), 'risk-off');
  assert.equal(regimeLabel(0), 'risk-off');
  const dots = {
    asOf: '2026-11-18T12:00:00.000Z',
    bandDots: [
      { name: 'LINK', kind: 'green', band: 'outer', wt1: -70, latest: true, close: 11 },
      { name: 'AAVE', kind: 'red', band: 'outer', wt1: 62, latest: true, close: 90 },
      { name: 'SOL', kind: 'green', band: 'inner', wt1: -55, latest: false, close: 140 },
      { name: 'DOGE', kind: 'red', band: 'inner', wt1: 54, latest: false, close: 0.1 },
      { name: 'LINK', kind: 'green', band: 'inner', wt1: -40, latest: false, close: 10 }
    ]
  };
  const regime = {
    score: 3,
    checks: {
      etfInflows: { status: 'pass', detail: { secret: 1 } },
      btcQuietSupport: { status: 'pass' },
      altsNotFreefall: { status: 'fail' },
      noGreedChase: { status: 'pass' }
    }
  };
  const evening = shapeBriefTeaser({
    regime, dots, track: null, now: new Date('2026-11-18T06:00:00.000Z')
  });
  assert.equal(evening.date, '2026-11-17');
  const t = shapeBriefTeaser({
    regime,
    dots,
    track: { backtest: { summary: { green_all: { '7d': { hitRatePct: 61, n: 40 } } } } },
    now: new Date('2026-11-18T18:00:00.000Z')
  });
  assert.equal(t.free, true);
  assert.equal(t.date, '2026-11-18');
  assert.equal(t.timezone, 'America/Denver');
  assert.equal(t.regime.score, 3);
  assert.equal(t.regime.outOf, 4);
  assert.equal(t.regime.label, 'risk-on');
  assert.equal(t.regime.checks.etfInflows, 'pass');
  assert.equal(t.regime.checks.altsNotFreefall, 'fail');
  assert.equal(Object.hasOwn(t.regime.checks, 'detail'), false);
  assert.deepEqual(t.top3, ['LINK', 'AAVE', 'SOL']);
  assert.equal(t.top3.every(name => typeof name === 'string'), true);
  assert.deepEqual(Object.keys(t.top3Dots[0]).sort(), ['band', 'kind', 'symbol']);
  assert.equal(t.gated.moreCoins, 1);
  assert.ok(t.gated.withheld.includes('dot strength'));
  assert.ok(t.gated.withheld.includes('BTC/ETH/SOL flow bias and net USD'));
  assert.match(t.gated.bundle, /\/api\/daily/);
  assert.match(t.gated.bundle, /0\.025/);
  assert.match(t.upsell.dailyBundle, /\$0\.025/);
  assert.equal(t.backtest7dHeadline.hitRatePct, 61);
  assert.equal(t.dots.green, 3);
  assert.equal(t.dots.red, 2);
  const keys = new Set();
  (function walk(v) {
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) { keys.add(k); walk(child); }
  })(t);
  for (const hidden of ['wt1', 'wt2', 'close', 'strength', 'flowsSummary', 'top10ByDotStrength', 'largeNetUsd']) {
    assert.equal(keys.has(hidden), false, hidden);
  }
});

test('daily bundle 402, stubbed paid path, and sales counter', async (t) => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const port = 49000 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, ['--import', path.join(ROOT, 'test', 'helpers', 'facilitator_ok.mjs'), 'server.js'], {
    cwd: ROOT,
    env: {
      ...keys(),
      PORT: String(port),
      GW8_TEST_HOOKS: '1',
      GW8_SALES_FILE: path.join(mkdtempSync(path.join(tmpdir(), 'gw8-daily-')), 'sales-counts.json'),
      CDP_API_KEY_ID: 'organizations/test/apiKeys/test',
      CDP_API_KEY_SECRET: pem
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  srv.stderr.on('data', d => { err += d; });
  t.after(() => srv.kill());
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start ' + err.slice(0, 500))), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const quote = await fetch(base + '/api/daily');
  assert.equal(quote.status, 402);
  const pr = JSON.parse(Buffer.from(quote.headers.get('payment-required'), 'base64').toString('utf8'));
  assert.equal(pr.accepts.length, 1);
  assert.equal(pr.accepts[0].scheme, 'exact');
  assert.equal(pr.accepts[0].network, 'eip155:8453');
  assert.equal(pr.accepts[0].asset, USDC);
  assert.equal(pr.accepts[0].payTo, PAYTO);
  assert.equal(pr.accepts[0].amount, '25000');
  assert.equal(pr.accepts[0].maxTimeoutSeconds, 300);
  assert.equal(quote.headers.get('x-402-amount-usdc'), '0.025');
  assert.equal(quote.headers.get('x-402-pay-to'), PAYTO);
  assert.match(pr.resource.description, /brief/i);
  assert.match(pr.resource.description, /regime/i);
  assert.match(pr.resource.description, /\$0\.025/);
  assert.ok(pr.resource.description.length <= 500);
  assert.equal(pr.resource.serviceName, 'GW8 Daily Bundle');
  assert.equal(pr.extensions.bazaar.info.output.example.bundle, true);
  const brief = await fetch(base + '/api/brief');
  const briefPr = JSON.parse(Buffer.from(brief.headers.get('payment-required'), 'base64').toString('utf8'));
  assert.equal(brief.status, 402);
  assert.equal(briefPr.accepts[0].payTo, pr.accepts[0].payTo);
  assert.equal(briefPr.accepts[0].network, pr.accepts[0].network);
  assert.equal(briefPr.accepts[0].asset, pr.accepts[0].asset);
  assert.equal(briefPr.accepts[0].amount, '20000');
  assert.equal(brief.headers.get('x-402-amount-usdc'), '0.02');

  const before = await (await fetch(base + '/api/sales?days=1')).json();
  const row = (report, event) => {
    const hit = report.routes.find(r => r.route === 'GET /api/daily' && r.surface === 'x402');
    return hit ? hit[event] : 0;
  };
  assert.equal(row(before, 'quotes'), 1);
  assert.equal(row(before, 'paid'), 0);

  const payload = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:8453', asset: USDC, payTo: PAYTO, amount: '25000' },
    payload: { signature: '0xstub' }
  })).toString('base64');
  const paid = await fetch(base + '/api/daily', { headers: { 'PAYMENT-SIGNATURE': payload } });
  const body = await paid.json();
  assert.equal(paid.status, 200, JSON.stringify(body).slice(0, 400));
  assert.equal(body.accessType, 'X402_FACILITATOR_SETTLED');
  assert.equal(body.signal.bundle, true);
  assert.equal(body.signal.brief.top10ByDotStrength[0].name, 'LINK');
  assert.equal(body.signal.brief.flowsSummary[0].symbol, 'BTC');
  assert.equal(body.signal.regime.checks.etfInflows.status, 'pass');
  assert.equal(body.signal.regime.checks.etfInflows.detail.totalMusd, 12);
  assert.equal(body.signal.priceUsd, '0.025');

  const after = await (await fetch(base + '/api/sales?days=1')).json();
  assert.equal(row(after, 'quotes'), 1);
  assert.equal(row(after, 'paid'), 1);
  assert.equal(after.routes.find(r => r.route === 'GET /api/daily' && r.surface === 'x402').paid, 1);

  const teaser = await (await fetch(base + '/api/brief/teaser')).json();
  assert.equal(teaser.free, true);
  assert.equal(teaser.regime.label, 'risk-on');
  assert.deepEqual(teaser.top3, ['LINK', 'AAVE', 'SOL']);
  assert.equal(Object.hasOwn(teaser.top3Dots[0], 'wt1'), false);
  assert.match(teaser.gated.bundle, /\/api\/daily/);

  const home = await (await fetch(base + '/')).json();
  assert.equal(home.lead.path, '/api/brief');
  assert.equal(home.lead.priceUsd, '0.02');
  assert.equal(home.bundle.path, '/api/daily');
  assert.equal(home.bundle.priceUsd, '0.025');

  const doc = await (await fetch(base + '/openapi.json')).json();
  const paidPaths = [];
  for (const [p, ops] of Object.entries(doc.paths)) for (const op of Object.values(ops)) {
    if (op['x-payment-info']) paidPaths.push(p);
  }
  assert.equal(paidPaths[0], '/api/brief');
  assert.equal(paidPaths[1], '/api/daily');
  assert.equal(doc.paths['/api/daily'].get['x-payment-info'].price.amount, '0.025');
  assert.equal(doc.paths['/api/verdict/{chain}/{address}'].get['x-payment-info'].price.amount, '0.005');
  assert.equal(doc.paths['/api/regime'].get['x-payment-info'].price.amount, '0.01');
  assert.match(doc.info['x-guidance'], /^Day pass first/);
  assert.match(doc.info.description, /GET \/api\/brief/);
  const llms = await (await fetch(base + '/llms.txt')).text();
  assert.match(llms, /GET \/api\/daily/);
  assert.match(llms, /\$0\.025 \|/);
  assert.ok(llms.indexOf('/api/brief') < llms.indexOf('/api/daily'));
});
