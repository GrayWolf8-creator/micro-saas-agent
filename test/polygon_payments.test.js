// Polygon USDC is a second x402 accept on five paid routes. Base stays first and unchanged.
// No facilitator keys and no network: these tests only read the unpaid 402.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RAILS_ROUTE_PRICE_USD, VERDICT_PRICE_USD, usdAtomic } from '../prices.js';
import { PAYDECISION_PLAN } from '../paydecision.js';
import { polygonPaymentsEnabled, pathAcceptsPolygon, selectPaymentRequirements, USDC_POLYGON, POLYGON_NETWORK } from '../polygon_pay.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADDR = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RAILS_ROUTE_AMOUNT = usdAtomic(RAILS_ROUTE_PRICE_USD);

// OpenAPI path + method. GET /api/pay/should-i-pay is the unpaid quote of the same POST route.
const CHOSEN = {
  'GET /api/rails': '2000',
  'GET /api/rails/route': RAILS_ROUTE_AMOUNT,
  'GET /api/regime': '10000',
  'POST /api/pay/should-i-pay': PAYDECISION_PLAN.amount,
  'GET /api/pay/should-i-pay': PAYDECISION_PLAN.amount,
  'GET /api/coin/{symbol}': '2000'
};

function baseAccept(amount) {
  return {
    scheme: 'exact', network: 'eip155:8453', amount, asset: USDC_BASE, payTo: ADDR,
    maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }
  };
}
function polygonAccept(amount) {
  return {
    scheme: 'exact', network: POLYGON_NETWORK, amount, asset: USDC_POLYGON, payTo: ADDR,
    maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }
  };
}

function boot(t, port, env) {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), SOLANA_PAYMENTS: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  srv.stderr.on('data', d => { err += d; });
  t.after(() => srv.kill());
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start ' + err.slice(0, 400))), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(`http://127.0.0.1:${port}`); } });
  });
}

async function challenge(base, method, url) {
  const r = await fetch(base + url, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? '{}' : undefined
  });
  assert.equal(r.status, 402, `${method} ${url} -> ${r.status}`);
  const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
  return { headers: r.headers, pr };
}

const concrete = p => p.replace('{symbol}', 'BTC').replace('{chain}', 'base').replace('{address}', USDC_BASE);

test('flag defaults on and the route matcher stays narrow', () => {
  assert.equal(polygonPaymentsEnabled({}), true);
  assert.equal(polygonPaymentsEnabled({ POLYGON_PAYMENTS: 'on' }), true);
  assert.equal(polygonPaymentsEnabled({ POLYGON_PAYMENTS: 'off' }), false);
  assert.equal(polygonPaymentsEnabled({ POLYGON_PAYMENTS: '0' }), false);
  assert.equal(polygonPaymentsEnabled({ POLYGON_PAYMENTS: 'false' }), false);
  assert.equal(pathAcceptsPolygon('/api/rails'), true);
  assert.equal(pathAcceptsPolygon('/api/rails/route'), true);
  assert.equal(pathAcceptsPolygon('/api/regime'), true);
  assert.equal(pathAcceptsPolygon('/api/pay/should-i-pay'), true);
  assert.equal(pathAcceptsPolygon('/api/coin/BTC'), true);
  assert.equal(pathAcceptsPolygon('/api/coin/{symbol}'), true);
  for (const p of ['/api/verdict/base/' + USDC_BASE, '/api/honeypot/base/' + USDC_BASE, '/api/verdict-deep/base/' + USDC_BASE, '/api/dots', '/api/truck/fuel-surcharge', '/api/pass/day', '/api/agent']) {
    assert.equal(pathAcceptsPolygon(p), false, p);
  }
});

test('polygon payments use the polygon accept; everything else stays on the first accept', () => {
  const base = baseAccept('10000');
  const poly = polygonAccept('10000');
  const both = [base, poly];
  assert.deepEqual(selectPaymentRequirements(both, { accepted: { network: 'eip155:8453' } }), { requirements: base, facilitator: 'cdp' });
  assert.deepEqual(selectPaymentRequirements(both, { x402Version: 1, network: 'base' }), { requirements: base, facilitator: 'cdp' });
  assert.deepEqual(selectPaymentRequirements(both, { accepted: { network: 'eip155:137' } }), { requirements: poly, facilitator: 'polygon' });
  assert.deepEqual(selectPaymentRequirements(both, { network: 'polygon' }), { requirements: poly, facilitator: 'polygon' });
  assert.deepEqual(selectPaymentRequirements([base], { accepted: { network: 'eip155:137' } }), { requirements: base, facilitator: 'cdp' });
  assert.deepEqual(selectPaymentRequirements(both, null), { requirements: base, facilitator: 'cdp' });
});

test('chosen routes list Base first and Polygon second; other paid routes do not', async (t) => {
  const port = 39200 + Math.floor(Math.random() * 500);
  const base = await boot(t, port, {});
  const seen = new Map();
  for (const [key, amount] of Object.entries(CHOSEN)) {
    const sp = key.indexOf(' ');
    const method = key.slice(0, sp);
    const url = concrete(key.slice(sp + 1));
    const { headers, pr } = await challenge(base, method, url);
    assert.equal(headers.get('x-402-chain'), 'eip155:8453', key);
    assert.equal(headers.get('x-402-pay-to'), ADDR, key);
    assert.equal(pr.accepts.length, 2, key);
    assert.deepEqual(pr.accepts[0], baseAccept(amount), key + ' base');
    assert.deepEqual(pr.accepts[1], polygonAccept(amount), key + ' polygon');
    assert.equal(pr.accepts[1].amount, pr.accepts[0].amount, key);
    assert.equal(pr.accepts[1].payTo, pr.accepts[0].payTo, key);
    seen.set(key, pr.accepts[0]);
  }
  assert.equal(seen.get('GET /api/rails/route').amount, usdAtomic(RAILS_ROUTE_PRICE_USD));

  const doc = await (await fetch(base + '/openapi.json')).json();
  let paid = 0;
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) {
    if (!op['x-payment-info']) continue;
    paid++;
    const method = m.toUpperCase();
    const key = `${method} ${p}`;
    const { pr } = await challenge(base, method, concrete(p));
    if (CHOSEN[key]) {
      assert.equal(pr.accepts.length, 2, key);
      assert.deepEqual(pr.accepts[0], baseAccept(CHOSEN[key]), key);
      assert.deepEqual(pr.accepts[1], polygonAccept(CHOSEN[key]), key);
    } else {
      assert.equal(pr.accepts.length, 1, key);
      assert.deepEqual(pr.accepts[0], baseAccept(pr.accepts[0].amount), key);
      assert.equal(pr.accepts.some(a => a.network === POLYGON_NETWORK), false, key);
    }
  }
  assert.ok(paid >= 27, 'paid ops ' + paid);
  assert.equal(doc.paths['/api/rails'].get['x-payment-info'].price.amount, '0.002');
  assert.equal(doc.paths['/api/rails/route'].get['x-payment-info'].price.amount, RAILS_ROUTE_PRICE_USD);
  assert.equal(doc.paths['/api/regime'].get['x-payment-info'].price.amount, '0.01');
  assert.equal(doc.paths['/api/coin/{symbol}'].get['x-payment-info'].price.amount, '0.002');
  assert.equal(doc.paths['/api/pay/should-i-pay'].post['x-payment-info'].price.amount, PAYDECISION_PLAN.priceUsd);
  assert.equal(doc.paths['/api/verdict/{chain}/{address}'].get['x-payment-info'].price.amount, VERDICT_PRICE_USD);

  const llms = await (await fetch(base + '/llms.txt')).text();
  const disc = await (await fetch(base + '/.well-known/x402')).json();
  for (const text of [llms, disc.instructions]) {
    assert.match(text, /eip155:137/);
    assert.match(text, new RegExp(USDC_POLYGON));
    for (const p of ['/api/rails', '/api/rails/route', '/api/regime', '/api/pay/should-i-pay', '/api/coin/{symbol}']) assert.ok(text.includes(p), p);
  }
});

test('POLYGON_PAYMENTS=off removes the Polygon accept and leaves Base', async (t) => {
  const port = 39750 + Math.floor(Math.random() * 500);
  const base = await boot(t, port, { POLYGON_PAYMENTS: 'off' });
  for (const [key, amount] of Object.entries(CHOSEN)) {
    const sp = key.indexOf(' ');
    const { pr } = await challenge(base, key.slice(0, sp), concrete(key.slice(sp + 1)));
    assert.equal(pr.accepts.length, 1, key);
    assert.deepEqual(pr.accepts[0], baseAccept(amount), key);
  }
  const verdict = await challenge(base, 'GET', '/api/verdict/base/' + USDC_BASE);
  assert.equal(verdict.pr.accepts.length, 1);
  assert.equal(verdict.pr.accepts[0].network, 'eip155:8453');
  assert.equal(verdict.pr.accepts[0].amount, usdAtomic(VERDICT_PRICE_USD));

  const payload = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:137' }, payload: { signature: '0x' } })).toString('base64');
  const paid = await fetch(base + '/api/regime', { headers: { 'PAYMENT-SIGNATURE': payload } });
  assert.equal(paid.status, 500);
  assert.equal((await paid.json()).code, 'KEYS_MISSING');
});
