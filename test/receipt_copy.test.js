// With no signing key, discovery and docs must not claim a signed receipt
// unless the same sentence says the signature exists only when signing is enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS = ['llms.txt', 'agents.md', 'README.md', 'public/pay.html'];
const SURFACES = ['/', '/llms.txt', '/agents.md', '/openapi.json', '/.well-known/x402', '/.well-known/agent.json', '/.well-known/agent-card.json', '/.well-known/mcp.json', '/mcp.json', '/pay.html', '/.well-known/gw8-receipt-key', '/api/proof/pubkey'];
const PHRASE = /signed receipts?/gi;

function bareSignedReceipt(text) {
  const hits = [];
  for (const match of String(text).matchAll(PHRASE)) {
    const window = String(text).slice(Math.max(0, match.index - 80), match.index + match[0].length + 180);
    if (!/when signing is enabled/i.test(window)) hits.push(String(text).slice(match.index, match.index + 90).replace(/\s+/g, ' '));
  }
  return hits;
}

test('docs do not claim a signed receipt unless signing is enabled', () => {
  for (const file of DOCS) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    assert.deepEqual(bareSignedReceipt(text), [], file);
  }
});

test('no signing key: discovery does not claim a signed receipt, and the receipt key is disabled', async (t) => {
  const port = 49300 + Math.floor(Math.random() * 700);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), BRIEF_PREWARM: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  srv.stderr.on('data', d => { err += d; });
  t.after(() => srv.kill());
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start ' + err.slice(0, 400))), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const surface of SURFACES) {
    const r = await fetch(base + surface);
    assert.equal(r.status, 200, surface + ' ' + r.status);
    assert.deepEqual(bareSignedReceipt(await r.text()), [], surface);
  }
  const key = await (await fetch(base + '/.well-known/gw8-receipt-key')).json();
  assert.equal(key.enabled, false);
  assert.match(key.terms, /when signing is enabled/);
  const pub = await (await fetch(base + '/api/proof/pubkey')).json();
  assert.equal(pub.enabled, false);

  const doc = await (await fetch(base + '/openapi.json')).json();
  const bodies = {
    '/api/seller/reputation': { address: '0x1111111111111111111111111111111111111111' },
    '/api/spend/check': { payment: { amount: '0.05', currency: 'USDC' }, policy: { currency: 'USDC' } },
    '/api/pay/should-i-pay': { payment: { amount: '0.05', currency: 'USDC' }, policy: { currency: 'USDC' }, seller: { address: '0x1111111111111111111111111111111111111111' } }
  };
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) {
    const openapi402 = op.responses && op.responses['402'] && op.responses['402'].description;
    if (typeof openapi402 === 'string') {
      assert.ok(openapi402.length <= 500, `${m} ${p} openapi 402 is ${openapi402.length}`);
      assert.deepEqual(bareSignedReceipt(openapi402), [], `openapi 402 ${p}`);
    }
    if (!op['x-payment-info']) continue;
    const method = m.toUpperCase();
    const url = p.replace('{symbol}', 'BTC').replace('{chain}', 'base').replace('{address}', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(bodies[p] || {}) : undefined });
    assert.equal(r.status, 402, method + ' ' + url);
    assert.deepEqual(bareSignedReceipt(await r.text()), [], '402 body ' + url);
    const hdr = r.headers.get('payment-required');
    assert.ok(hdr, url);
    const challenge = Buffer.from(hdr, 'base64').toString('utf8');
    assert.deepEqual(bareSignedReceipt(challenge), [], '402 challenge ' + url);
    const resource = JSON.parse(challenge).resource.description;
    assert.ok(resource.length <= 500 && !resource.endsWith('...'), `${url} resource ${resource.length}`);
  }
});
