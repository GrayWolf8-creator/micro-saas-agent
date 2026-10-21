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

// Proposal 25: x402scan probes each OpenAPI resource UNPAID with an empty body / literal path template
// (e.g. /api/coin/%7Bsymbol%7D) and only registers it if it answers 402 with a valid x402 challenge.
// Paywall runs first for unpaid calls; with a payment or pass header, bad input is still rejected before verify (never charged).
const PROBES = [
  ['GET', '/api/coin/%7Bsymbol%7D', '/api/coin/{symbol}'],
  ['GET', '/api/coin/NOTACOIN', '/api/coin/{symbol}'],
  ['GET', '/api/verdict/%7Bchain%7D/%7Baddress%7D', '/api/verdict/{chain}/{address}'],
  ['GET', '/api/verdict/base/not-an-address', '/api/verdict/{chain}/{address}'],
  ['GET', '/api/flows/%7Bsymbol%7D', '/api/flows/{symbol}'],
  ['POST', '/api/pay/should-i-pay', '/api/pay/should-i-pay'],
  ['POST', '/api/spend/check', '/api/spend/check'],
  ['POST', '/api/seller/reputation', '/api/seller/reputation'],
];
const P25_PORT = PORT + 1000, P25 = `http://127.0.0.1:${P25_PORT}`;
async function boot(t, port) {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('server did not start')), 20000); srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } }); });
}
function checkChallenge(r, label) {
  assert.equal(r.status, 402, `${label} -> ${r.status}`);
  const hdr = r.headers.get('PAYMENT-REQUIRED');
  assert.ok(hdr, `${label}: no PAYMENT-REQUIRED header`);
  const pr = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
  assert.equal(pr.x402Version, 2);
  assert.ok(pr.resource && pr.resource.url && pr.resource.description.length <= 500, `${label}: resource`);
  const a = pr.accepts[0];
  assert.equal(a.scheme, 'exact'); assert.equal(a.network, 'eip155:8453'); assert.equal(a.payTo, ADDR);
  assert.ok(Number(a.amount) > 0, `${label}: amount`);
  assert.ok(pr.extensions && pr.extensions.bazaar && pr.extensions.bazaar.info, `${label}: bazaar`);
  const z = PaymentPayloadV2Schema.safeParse({ x402Version: 2, payload: { authorization: {}, signature: '0x' }, extensions: pr.extensions, resource: pr.resource, accepted: a });
  assert.ok(z.success, `${label}: ${z.success ? '' : JSON.stringify(z.error.issues)}`);
  return pr;
}

test('proposal 25: unpaid empty-body / placeholder probes on the 6 x402scan routes all get a valid 402', async (t) => {
  await boot(t, P25_PORT);
  for (const [method, url, tpl] of PROBES) {
    for (const body of method === 'POST' ? [undefined, '{}', '{"junk":1}'] : [undefined]) {
      const r = await fetch(P25 + url, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body } : {}) });
      const pr = checkChallenge(r, `${method} ${url} body=${body}`);
      if (/%7B|NOTACOIN|not-an-address/.test(url)) assert.equal(pr.resource.url, 'https://micro-saas-agent.onrender.com' + tpl, `${url}: template url`);
    }
  }
  // Valid concrete input still quotes the concrete resource (unchanged).
  const ok = checkChallenge(await fetch(P25 + '/api/coin/btc'), 'GET /api/coin/btc');
  assert.equal(ok.resource.url, 'https://micro-saas-agent.onrender.com/api/coin/BTC');

  // With a payment header, bad input is rejected BEFORE verify (no facilitator keys in this env: if verify were reached it would be 500 KEYS_MISSING).
  const fake = { 'X-PAYMENT': 'bm90LWEtcmVhbC1wYXltZW50', 'Content-Type': 'application/json' };
  for (const [method, url, want] of [['GET', '/api/coin/%7Bsymbol%7D', 404], ['GET', '/api/flows/NOTACOIN', 404], ['GET', '/api/verdict/base/not-an-address', 400],
    ['POST', '/api/pay/should-i-pay', 400], ['POST', '/api/spend/check', 400], ['POST', '/api/seller/reputation', 400]]) {
    const r = await fetch(P25 + url, { method, headers: fake, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(r.status, want, `paid ${method} ${url} -> ${r.status}`);
    const j = await r.json();
    assert.match(j.note || '', /no payment was taken/);
  }
  // Same for a day-pass header: rejected before the pass is looked up / used.
  const r = await fetch(P25 + '/api/coin/%7Bsymbol%7D', { headers: { 'X-GW8-Pass': 'gw8p_fake' } });
  assert.equal(r.status, 404);
});

test('proposal 25: openapi has contact email, required params/bodies and request examples', async (t) => {
  await boot(t, P25_PORT + 1);
  const doc = await (await fetch(`http://127.0.0.1:${P25_PORT + 1}/openapi.json`)).json();
  assert.equal(doc.info.contact.email, 'mariostefano3@gmail.com');
  for (const p of ['/api/coin/{symbol}', '/api/flows/{symbol}', '/api/verdict/{chain}/{address}']) {
    const ps = doc.paths[p].get.parameters.filter(x => x.in === 'path');
    assert.ok(ps.length && ps.every(x => x.required === true && x.example !== undefined), `${p} path params required + example`);
  }
  for (const p of ['/api/pay/should-i-pay', '/api/spend/check', '/api/seller/reputation']) {
    const rb = doc.paths[p].post.requestBody;
    assert.equal(rb.required, true, `${p} requestBody.required`);
    const c = rb.content['application/json'];
    assert.ok(c.example && typeof c.example === 'object', `${p} example`);
    assert.ok((c.schema.required && c.schema.required.length) || c.schema.anyOf, `${p} required fields`);
  }
});
