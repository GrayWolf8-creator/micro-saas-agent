// Proposal 24: every 402 challenge must produce a paymentPayload that CDP /verify accepts.
// CDP's x402V2PaymentPayload schema caps resource.description at 500 chars; over that it answers
// "'paymentPayload' is invalid: must match one of [x402V2PaymentPayload, x402V1PaymentPayload]. x402V1PaymentPayload requires 'scheme'".
// Boots server.js on a local port with a minimal env (no facilitator keys, no secrets) and checks every paid route in /openapi.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { capDescription, MAX_RESOURCE_DESCRIPTION } from '../catalog.js';
const require = createRequire(import.meta.url);
const { PaymentPayloadV2Schema } = require('@x402/core/schemas');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 38000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ADDR = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const PAY = { amount: '0.05', currency: 'USDC', chain: 'base', recipientId: ADDR, merchantCategory: 'data-api', timestamp: '2026-10-21T21:00:00Z', agentId: 'test' };
const POL = { currency: 'USDC', perTxLimit: '1', allowedChains: ['base'], allowedAssets: ['USDC'], requireApprovalAbove: '0.50' };
const BODIES = { '/api/seller/reputation': { address: ADDR }, '/api/spend/check': { payment: PAY, policy: POL }, '/api/pay/should-i-pay': { payment: PAY, policy: POL, seller: { address: ADDR } } };
const concrete = p => p.replace('{symbol}', 'BTC').replace('{chain}', 'base').replace('{address}', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');

test('capDescription: <= 500, untouched when short, ends cleanly', () => {
  assert.equal(MAX_RESOURCE_DESCRIPTION, 500);
  assert.equal(capDescription('short text'), 'short text');
  const long = 'word '.repeat(200);
  const c = capDescription(long);
  assert.ok(c.length <= 500 && c.endsWith('...') && !c.endsWith(' ...'));
  assert.ok(capDescription('x'.repeat(900)).length <= 500);
  assert.equal(capDescription('y'.repeat(500)), 'y'.repeat(500));
});

test('every paid route: 402 challenge echoes into a CDP-valid paymentPayload (description <= 500, bazaar kept)', async (t) => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('server did not start')), 20000); srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } }); });
  const doc = await (await fetch(BASE + '/openapi.json')).json();
  let n = 0;
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) {
    if (!op['x-payment-info']) continue;
    const url = concrete(p), method = m.toUpperCase();
    const body = method === 'POST' ? JSON.stringify(BODIES[p] || { webhookUrl: 'https://example.com/hook' }) : undefined;
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 402, `${method} ${url} -> ${r.status}`);
    const pr = JSON.parse(Buffer.from(r.headers.get('PAYMENT-REQUIRED'), 'base64').toString('utf8'));
    const d = pr.resource.description;
    assert.ok(d.length <= 500, `${method} ${url} resource.description is ${d.length} chars (CDP max 500)`);
    assert.ok(!d.endsWith('...'), `${method} ${url} description was cut by the safety cap; shorten the source text`);
    assert.ok(pr.extensions && pr.extensions.bazaar && pr.extensions.bazaar.info && pr.extensions.bazaar.schema, `${method} ${url} lost bazaar extension`);
    const pp = { x402Version: 2, payload: { authorization: {}, signature: '0x' }, extensions: pr.extensions, resource: pr.resource, accepted: pr.accepts[0] };
    const z = PaymentPayloadV2Schema.safeParse(pp);
    assert.ok(z.success, `${method} ${url}: ${z.success ? '' : JSON.stringify(z.error.issues)}`);
    n++;
  }
  assert.ok(n >= 15, `only ${n} paid routes checked`);
});
