// Every paid 402 must carry a complete Bazaar record: a category-led description, tags, and
// input plus output schemas whose fields are described. /api/rails copy stays the listing that ranks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 47000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY = { amount: '0.05', currency: 'USDC', chain: 'base', recipientId: ADDR, merchantCategory: 'data-api', timestamp: '2026-10-21T21:00:00Z', agentId: 'test' };
const POL = { currency: 'USDC', perTxLimit: '1', allowedChains: ['base'], allowedAssets: ['USDC'], requireApprovalAbove: '0.50' };
const BODIES = {
  '/api/seller/reputation': { address: ADDR },
  '/api/spend/check': { payment: PAY, policy: POL },
  '/api/pay/should-i-pay': { payment: PAY, policy: POL, seller: { address: ADDR } }
};
const concrete = p => p.replace('{symbol}', 'BTC').replace('{chain}', 'base').replace('{address}', ADDR);
const PRINTABLE = /^[\x20-\x7E]+$/;
const RAILS_DESCRIPTION = '[Payment rails: fee + speed comparison] Cheapest and fastest payment rail right now for a USD amount (?amount=100): Base USDC (live gas x ETH/USD, ~2s), XRPL RLUSD/XRP (live fee x XRP/USD, ~3-5s), Tempo and Circle Arc (live gas, USD fees, ~1s), card (static 2.9% + $0.30, days). Fee USD/%, settlement time, sources, agent protocols per rail, recommended pick. Dead sources marked unavailable. 60s cache. $0.002 USDC. Signal only.';
const RAILS_TAGS = ['payments', 'rails', 'base', 'xrpl', 'x402'];
const ALIASES = [
  ['/api/verdict/{chain}/{address}', '/api/honeypot/{chain}/{address}'],
  ['/api/verdict-deep/{chain}/{address}', '/api/honeypot-deep/{chain}/{address}']
];

function blankFields(node, where = '') {
  const bad = [];
  if (!node || typeof node !== 'object') return bad;
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) {
      const at = where ? `${where}.${k}` : k;
      if (!v || typeof v.description !== 'string' || !v.description.trim()) bad.push(at);
      bad.push(...blankFields(v, at));
      if (v && v.items) bad.push(...blankFields(v.items, at + '[]'));
    }
  }
  return bad;
}

test('every paid 402 has a complete Bazaar description, tags, and input/output schema', async (t) => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start')), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
  });
  const doc = await (await fetch(BASE + '/openapi.json')).json();
  assert.equal(doc.info.title, 'GW8 Daily Crypto Brief, Payment Rails, and Token Safety API');
  assert.match(doc.info.description, /daily crypto brief/i);
  assert.match(doc.info.description, /payment rails/i);
  assert.match(doc.info.description, /token safety/i);

  const categories = new Map();
  let n = 0;
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) {
    if (!op['x-payment-info']) continue;
    const method = m.toUpperCase();
    const url = concrete(p);
    const body = method === 'POST' ? JSON.stringify(BODIES[p] || { webhookUrl: 'https://example.com/hook' }) : undefined;
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 402, `${method} ${url}`);
    const pr = JSON.parse(Buffer.from(r.headers.get('PAYMENT-REQUIRED'), 'base64').toString('utf8'));
    const d = pr.resource.description;
    assert.ok(d && d.length <= 500 && !d.endsWith('...'), `${p} description ${d && d.length}`);
    assert.match(d, /^\[[^\]]+\] /, `${p} category prefix`);
    const category = d.slice(1, d.indexOf(']'));
    categories.set(p, category);
    const tags = pr.resource.tags;
    assert.ok(Array.isArray(tags) && tags.length >= 1 && tags.length <= 5, `${p} tags`);
    for (const tag of tags) {
      assert.ok(tag.length >= 1 && tag.length <= 32 && PRINTABLE.test(tag), `${p} tag ${tag}`);
    }
    assert.equal(new Set(tags.map(t => t.toLowerCase())).size, tags.length, `${p} duplicate tags`);

    const bazaar = pr.extensions.bazaar;
    const input = bazaar.schema.properties.input;
    const holder = method === 'POST' ? input.properties.body : input.properties.queryParams;
    assert.ok(holder && holder.type === 'object' && typeof holder.description === 'string' && holder.description.trim(), `${p} input object`);
    assert.deepEqual(blankFields(holder), [], `${p} input fields`);
    if (input.properties.pathParams) assert.deepEqual(blankFields(input.properties.pathParams), [], `${p} path fields`);

    const example = bazaar.info.output.example;
    assert.ok(example && typeof example === 'object' && !Array.isArray(example) && Object.keys(example).length > 0, `${p} output example`);
    const outSchema = bazaar.schema.properties.output.properties.example;
    assert.equal(outSchema.type, 'object', p);
    assert.ok(typeof outSchema.description === 'string' && outSchema.description.trim(), `${p} output description`);
    assert.ok(outSchema.properties && Object.keys(outSchema.properties).length > 0, `${p} output properties`);
    assert.deepEqual(blankFields(outSchema), [], `${p} output fields`);
    n++;
  }
  assert.ok(n >= 27, `paid routes ${n}`);

  const seen = new Map();
  for (const [p, category] of categories) {
    const alias = ALIASES.find(pair => pair.includes(p));
    const key = alias ? alias[0] : p;
    if (!seen.has(key)) seen.set(key, category);
    else assert.equal(category, seen.get(key), p);
  }
  const used = [...seen.values()];
  assert.equal(new Set(used).size, used.length, 'categories collide: ' + used.join(' | '));

  assert.equal(categories.get('/api/govcontracts'), 'Government contracts data');
  assert.doesNotMatch(categories.get('/api/govcontracts'), /crypto/i);
  assert.match(categories.get('/api/brief'), /Daily crypto brief/);
  assert.match(categories.get('/api/regime'), /Crypto market regime/);
  assert.match(categories.get('/api/verdict/{chain}/{address}'), /token safety/i);
  assert.match(categories.get('/api/verdict/{chain}/{address}'), /rug check/i);
  assert.match(categories.get('/api/verdict/{chain}/{address}'), /token security/i);
  assert.match(categories.get('/api/honeypot/{chain}/{address}'), /honeypot/i);

  const rails = await fetch(BASE + '/api/rails?amount=100');
  const railsBody = JSON.parse(Buffer.from(rails.headers.get('PAYMENT-REQUIRED'), 'base64').toString('utf8'));
  assert.equal(railsBody.resource.description, RAILS_DESCRIPTION);
  assert.deepEqual(railsBody.resource.tags, RAILS_TAGS);
  assert.equal(railsBody.accepts[0].amount, '2000');
});
