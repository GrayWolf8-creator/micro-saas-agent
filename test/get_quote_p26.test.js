// Proposal 26 (x402dash): its listing checker only sends GET. An unpaid GET to a POST-only paid route must return the
// same x402 402 challenge as an unpaid POST (method POST in the bazaar schema), and a GET carrying any payment / pass /
// tx must get 405 "use POST" without verifying, settling or using anything. Boots server.js with no facilitator keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 41000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'https://micro-saas-agent.onrender.com';
const POST_ONLY = ['/api/spend/check', '/api/seller/reputation', '/api/pay/should-i-pay', '/api/alerts/subscribe', '/api/brief/weekly/subscribe', '/api/pass/day'];
const decode = r => JSON.parse(Buffer.from(r.headers.get('PAYMENT-REQUIRED'), 'base64').toString('utf8'));

async function boot(t) {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('server did not start')), 20000); srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } }); });
}

test('proposal 26: unpaid GET on every POST-only paid route = same 402 as unpaid POST; paid GET = 405, nothing taken', async (t) => {
  await boot(t);
  for (const p of POST_ONLY) {
    const g = await fetch(BASE + p);
    assert.equal(g.status, 402, `GET ${p} -> ${g.status}`);
    assert.equal(g.headers.get('allow'), 'POST', `GET ${p} Allow header`);
    const gc = decode(g), gb = await g.json();
    const po = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(po.status, 402, `unpaid POST ${p} still 402`);
    const pc = decode(po), pb = await po.json();
    assert.deepEqual(gc, pc, `GET ${p}: PAYMENT-REQUIRED differs from POST`);
    assert.deepEqual(gb, pb, `GET ${p}: 402 body differs from POST`);
    for (const h of ['X-402-Pay-To', 'X-402-Amount-USDC', 'X-402-Chain']) assert.equal(g.headers.get(h), po.headers.get(h), `GET ${p} ${h}`);
    assert.equal(gc.x402Version, 2);
    assert.equal(gc.resource.url, ORIGIN + p);
    assert.ok(Number(gc.accepts[0].amount) > 0);
    assert.equal(gc.extensions.bazaar.info.input.method, 'POST', `GET ${p}: bazaar method`);
    assert.deepEqual(gc.extensions.bazaar.schema.properties.input.properties.method.enum, ['POST']);
    assert.equal(gc.extensions.bazaar.info.input.bodyType, 'json');

    // Any payment / pass / tx on a GET: 405 use POST, never verified (no keys here: reaching verify would be 500 KEYS_MISSING).
    for (const [hdrs, q] of [[{ 'X-PAYMENT': 'bm90LWEtcmVhbC1wYXltZW50' }, ''], [{ 'PAYMENT-SIGNATURE': 'bm90LWEtcmVhbC1wYXltZW50' }, ''], [{ 'X-GW8-Pass': 'gw8p_fake' }, ''], [{ 'X-Payment-Tx': '0xabc' }, ''], [{}, '?tx=0xabc']]) {
      const r = await fetch(BASE + p + q, { headers: hdrs });
      assert.equal(r.status, 405, `paid GET ${p}${q} ${JSON.stringify(hdrs)} -> ${r.status}`);
      assert.equal(r.headers.get('allow'), 'POST');
      assert.equal(r.headers.get('PAYMENT-RESPONSE'), null);
      const j = await r.json();
      assert.equal(j.method, 'POST');
      assert.match(j.note, /no payment was taken/);
    }
  }
  // POST with a payment header and a bad body is unchanged (400 before verify, proposal 25).
  for (const p of ['/api/spend/check', '/api/seller/reputation', '/api/pay/should-i-pay']) {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'X-PAYMENT': 'bm90LWEtcmVhbC1wYXltZW50', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 400, `paid POST ${p} bad body -> ${r.status}`);
  }
  // Read-only GET siblings are not shadowed.
  assert.equal((await fetch(BASE + '/api/alerts/nope')).status, 404);
  assert.equal((await fetch(BASE + '/api/brief/weekly/nope')).status, 404);
});
