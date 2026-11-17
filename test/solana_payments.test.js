// Solana USDC is a third x402 accept on the same routes as Polygon. Base stays first. Polygon stays second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { RAILS_ROUTE_PRICE_USD, usdAtomic } from '../prices.js';
import { PAYDECISION_PLAN } from '../paydecision.js';
import { acceptFor, offeredNetworks, solanaPaymentPayload, evmPaymentPayload, SOLANA_USDC, POLYGON_USDC, BASE_USDC } from '../public/pay-networks.js';
import {
  solanaPaymentsEnabled, pathAcceptsSolana, feePayerFromSupported, usdcAccountExists, solanaAccept,
  USDC_SOLANA, SOLANA_NETWORK, SOLANA_PAYTO, _resetSolanaCache
} from '../solana_pay.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_PAYTO = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FEE = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';

const CHOSEN = {
  'GET /api/rails': '2000',
  'GET /api/rails/route': usdAtomic(RAILS_ROUTE_PRICE_USD),
  'GET /api/regime': '10000',
  'POST /api/pay/should-i-pay': PAYDECISION_PLAN.amount,
  'GET /api/pay/should-i-pay': PAYDECISION_PLAN.amount,
  'GET /api/coin/{symbol}': '2000'
};

function baseAccept(amount) {
  return {
    scheme: 'exact', network: 'eip155:8453', amount, asset: USDC_BASE, payTo: BASE_PAYTO,
    maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }
  };
}
function polygonAccept(amount) {
  return {
    scheme: 'exact', network: 'eip155:137', amount, asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', payTo: BASE_PAYTO,
    maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' }
  };
}

function boot(t, port, env, preload) {
  const args = preload ? ['--import', path.join(ROOT, 'test', 'helpers', preload), 'server.js'] : ['server.js'];
  const srv = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
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
  return pr;
}
const concrete = p => p.replace('{symbol}', 'BTC').replace('{chain}', 'base').replace('{address}', USDC_BASE);

test('Solana flag, route set, fee payer, and missing USDC account', () => {
  assert.equal(solanaPaymentsEnabled({}), true);
  assert.equal(solanaPaymentsEnabled({ SOLANA_PAYMENTS: 'off' }), false);
  assert.equal(solanaPaymentsEnabled({ SOLANA_PAYMENTS: '0' }), false);
  assert.equal(pathAcceptsSolana('/api/rails'), true);
  assert.equal(pathAcceptsSolana('/api/rails/route'), true);
  assert.equal(pathAcceptsSolana('/api/regime'), true);
  assert.equal(pathAcceptsSolana('/api/pay/should-i-pay'), true);
  assert.equal(pathAcceptsSolana('/api/coin/BTC'), true);
  assert.equal(pathAcceptsSolana('/api/verdict/base/x'), false);
  assert.equal(pathAcceptsSolana('/api/dots'), false);
  const body = { kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453', extra: { feePayer: 'nope' } },
    { x402Version: 2, scheme: 'exact', network: SOLANA_NETWORK, extra: { feePayer: FEE } }
  ] };
  assert.equal(feePayerFromSupported(body), FEE);
  assert.equal(feePayerFromSupported({ kinds: [] }), null);
  assert.equal(usdcAccountExists({ result: { value: [] } }), false);
  assert.equal(usdcAccountExists({ result: { value: [{}] } }), true);
  assert.equal(usdcAccountExists({ error: { code: -1 } }), null);
  assert.equal(USDC_SOLANA, SOLANA_USDC);
  const acc = solanaAccept('10000', SOLANA_PAYTO, FEE);
  assert.equal(acc.network, SOLANA_NETWORK);
  assert.equal(acc.asset, USDC_SOLANA);
  assert.equal(acc.payTo, SOLANA_PAYTO);
  assert.equal(acc.amount, '10000');
  assert.equal(acc.extra.feePayer, FEE);
  assert.notEqual(acc.payTo, BASE_PAYTO);
});

test('pay page offers only the networks in the 402 and builds the documented payloads', () => {
  const accepts = [baseAccept('2000'), polygonAccept('2000'), solanaAccept('2000', SOLANA_PAYTO, FEE)];
  assert.deepEqual(offeredNetworks(accepts).map(o => o.id), ['base', 'polygon', 'solana']);
  assert.deepEqual(offeredNetworks([accepts[2], accepts[0]]).map(o => o.id), ['base', 'solana']);
  assert.deepEqual(offeredNetworks([baseAccept('10000')]).map(o => o.id), ['base']);
  assert.equal(acceptFor(accepts, 'base'), accepts[0]);
  assert.equal(acceptFor(accepts, 'polygon').asset, POLYGON_USDC);
  assert.equal(acceptFor(accepts, 'solana').asset, SOLANA_USDC);
  assert.equal(acceptFor([baseAccept('10000')], 'solana'), null);
  const challenge = { resource: { url: 'https://example.test/api/regime' }, extensions: { bazaar: {} } };
  const sol = solanaPaymentPayload(challenge, accepts[2], 'AQID');
  assert.equal(sol.x402Version, 2);
  assert.equal(sol.payload.transaction, 'AQID');
  assert.equal(sol.accepted, accepts[2]);
  assert.equal(Object.hasOwn(sol.payload, 'authorization'), false);
  const evm = evmPaymentPayload(challenge, accepts[0], { from: '0x1' }, '0xsig');
  assert.deepEqual(evm.payload, { authorization: { from: '0x1' }, signature: '0xsig' });
  assert.equal(evm.accepted.network, 'eip155:8453');
  assert.equal(evm.accepted.asset, BASE_USDC);

  const html = readFileSync(path.join(ROOT, 'public/pay.html'), 'utf8');
  assert.match(html, /<select id="net"><option value="base" selected>Base USDC<\/option><\/select>/);
  assert.match(html, /chainId: 8453/);
  assert.match(html, /req\.network !== 'eip155:8453'/);
  assert.match(html, /eip155:137/);
  assert.match(html, /POLYGON_USDC/);
  const nets = readFileSync(path.join(ROOT, 'public/pay-networks.js'), 'utf8');
  assert.match(nets, new RegExp(POLYGON_USDC));
  assert.match(nets, new RegExp(SOLANA_USDC));
  assert.match(html, /chainId: POLYGON_CHAIN_NUM/);
  assert.match(html, /SOLANA_USDC/);
  assert.match(html, /solanaPaymentPayload/);
  assert.match(html, /window\.solana/);
  assert.match(html, /if \(net === 'polygon'\) return payPolygon\(\)/);
  assert.match(html, /if \(net === 'solana'\) return paySolana\(\)/);
  assert.match(html, /return payBase\(\)/);
  assert.match(html, /accepts\[0\]\.payTo/);
  assert.match(html, /\/api\/verdict token safety verdict — \$0\.005/);
});

test('chosen routes list Base, then Polygon, then Solana; the flag drops Solana; a missing USDC account is not settled', async (t) => {
  _resetSolanaCache();
  const port = 40100 + Math.floor(Math.random() * 400);
  // Stub only the payee-USDC-account RPC lookup so the result doesn't depend on the live wallet.
  const base = await boot(t, port, {}, 'solana_rpc_no_usdc_account.mjs');
  for (const [key, amount] of Object.entries(CHOSEN)) {
    const sp = key.indexOf(' ');
    const pr = await challenge(base, key.slice(0, sp), concrete(key.slice(sp + 1)));
    assert.equal(pr.accepts.length, 3, key);
    assert.deepEqual(pr.accepts[0], baseAccept(amount), key + ' base');
    assert.deepEqual(pr.accepts[1], polygonAccept(amount), key + ' polygon');
    const sol = pr.accepts[2];
    assert.equal(sol.scheme, 'exact', key);
    assert.equal(sol.network, SOLANA_NETWORK, key);
    assert.equal(sol.asset, USDC_SOLANA, key);
    assert.equal(sol.amount, amount, key);
    assert.equal(sol.payTo, SOLANA_PAYTO, key);
    assert.equal(sol.extra.decimals, 6, key);
    assert.match(sol.extra.feePayer, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, key);
    assert.notEqual(sol.extra.feePayer, SOLANA_PAYTO, key);
  }
  const dots = await challenge(base, 'GET', '/api/dots');
  assert.equal(dots.accepts.length, 1);
  assert.deepEqual(dots.accepts[0], baseAccept('10000'));
  const verdict = await challenge(base, 'GET', '/api/verdict/base/' + USDC_BASE);
  assert.equal(verdict.accepts.length, 1);
  assert.equal(verdict.accepts[0].network, 'eip155:8453');

  const payload = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: SOLANA_NETWORK, asset: USDC_SOLANA, payTo: SOLANA_PAYTO, amount: '10000', extra: { feePayer: 'fee' } },
    payload: { transaction: 'AQID' }
  })).toString('base64');
  const paid = await fetch(base + '/api/regime', { headers: { 'PAYMENT-SIGNATURE': payload } });
  const body = await paid.json();
  assert.notEqual(body.code, 'KEYS_MISSING');
  assert.equal(paid.status, 402);
  assert.equal(body.error, 'PAYEE_USDC_ACCOUNT_MISSING');
  assert.match(body.note, /no payment was taken/);

  const offPort = port + 1;
  const off = await boot(t, offPort, { SOLANA_PAYMENTS: 'off' });
  const rails = await challenge(off, 'GET', '/api/rails');
  assert.equal(rails.accepts.length, 2);
  assert.deepEqual(rails.accepts[0], baseAccept('2000'));
  assert.deepEqual(rails.accepts[1], polygonAccept('2000'));
  const offPaid = await fetch(off + '/api/rails', { headers: { 'PAYMENT-SIGNATURE': payload } });
  assert.equal(offPaid.status, 500);
  assert.equal((await offPaid.json()).code, 'KEYS_MISSING');
});
