// On-origin discovery: one A2A card, and the same paid catalog on llms.txt, agents.md, x402, and OpenAPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PHRASES = ['honeypot check', 'honeypot', 'rug pull', 'token safety', 'token security', 'scam token', 'contract risk'];

test('agent card, docs, openapi, and x402 list every paid route, brief first', async (t) => {
  const port = 46000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  srv.stderr.on('data', d => { err += d; });
  t.after(() => srv.kill());
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start ' + err.slice(0, 500))), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const doc = await (await fetch(base + '/openapi.json')).json();
  const paid = [];
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) {
    if (!op['x-payment-info']) continue;
    paid.push({ path: p, method: m.toUpperCase(), price: op['x-payment-info'].price.amount, example: op['x-example-request'], description: op.description });
  }
  assert.ok(paid.length >= 28, 'paid ops ' + paid.length);
  assert.equal(paid[0].path, '/api/brief');
  assert.equal(paid[0].price, '0.02');
  assert.equal(paid[1].path, '/api/daily');
  assert.equal(paid[1].price, '0.025');
  const verdict = paid.find(p => p.path === '/api/verdict/{chain}/{address}');
  const honey = paid.find(p => p.path === '/api/honeypot/{chain}/{address}');
  assert.equal(verdict.price, '0.005');
  assert.equal(honey.price, '0.005');
  assert.equal(verdict.example, honey.example.replace('/api/honeypot/', '/api/verdict/'));
  assert.ok(paid.findIndex(p => p.path === '/api/brief') < paid.findIndex(p => p.path === '/api/verdict/{chain}/{address}'));

  const disc = await (await fetch(base + '/.well-known/x402')).json();
  assert.match(disc.resources[0], /\/api\/pass\/day$/);
  assert.equal(disc.endpoints.length, paid.length);
  assert.equal(disc.endpoints[0].path, '/api/brief');
  assert.equal(disc.endpoints[1].path, '/api/daily');
  assert.equal(disc.lead.path, '/api/brief');
  assert.match(disc.resources[1], /\/api\/brief$/);
  assert.match(disc.resources[2], /\/api\/daily$/);
  assert.ok(disc.resources.some(u => /\/api\/honeypot\/base\//.test(u)));

  const card = await (await fetch(base + '/.well-known/agent.json')).json();
  const alias = await (await fetch(base + '/.well-known/agent-card.json')).json();
  assert.deepEqual(alias, card);
  for (const key of ['name', 'description', 'version', 'supportedInterfaces', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(card[key], key);
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'HTTP+JSON');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.ok(card.url && card.preferredTransport);
  assert.equal(card.skills.length, paid.length);
  assert.equal(card.skills[0].name, 'Daily crypto brief');
  assert.equal(card.skills[1].name, 'Daily bundle');
  assert.equal(card.skills[0].examples[0], paid[0].example);
  const safety = card.skills.find(s => s.name === 'Token safety screen');
  assert.ok(safety.tags.includes('honeypot') && safety.tags.includes('honeypot check') && safety.tags.includes('scam token'));
  assert.equal(safety.examples[0], verdict.example);

  const llms = await (await fetch(base + '/llms.txt')).text();
  const agents = await (await fetch(base + '/agents.md')).text();
  assert.ok(!llms.includes('<!--PAID_CATALOG-->') && !agents.includes('<!--PAID_CATALOG-->'));
  assert.ok(llms.indexOf('/api/brief') < llms.indexOf('/api/verdict/{chain}/{address}'));
  assert.ok(llms.indexOf('/api/verdict/{chain}/{address}') < llms.indexOf('/api/coin/{symbol}'));
  assert.ok(agents.indexOf('/api/brief') < agents.indexOf('/api/verdict/{chain}/{address}'));
  assert.ok(agents.indexOf('/api/verdict/{chain}/{address}') < agents.indexOf('/api/coin/{symbol}'));
  for (const row of paid) {
    assert.equal(disc.endpoints.find(e => e.path === row.path && e.method === row.method).priceUsd, row.price, row.path);
    assert.ok(row.example && row.description.includes(row.example), row.path);
    for (const text of [llms, agents]) {
      assert.ok(text.includes(row.path), row.path);
      assert.ok(text.includes('$' + row.price + ' |'), row.path);
      assert.ok(text.includes(row.example), row.path);
    }
    const skill = card.skills.find(s => s.examples[0] === row.example);
    assert.ok(skill, 'skill ' + row.path);
    assert.ok(skill.description.includes('$' + row.price) || skill.description.includes(row.price), row.path);
  }
  for (const phrase of PHRASES) {
    assert.match(verdict.description, new RegExp(phrase));
    assert.match(llms, new RegExp(phrase));
    assert.match(agents, new RegExp(phrase));
    assert.match(safety.description, new RegExp(phrase));
  }
  assert.match(paid[0].description, /\$0\.02/);
  assert.match(paid[1].description, /\$0\.025/);
});
