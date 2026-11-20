// Every PPE event name charged by the Signal Actor must be one of the four events configured on the live Store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ALLOWED = new Set(['lite-result', 'standard-result', 'premium-result', 'history-result']);
const EXPECTED = {
  coin: 'lite-result',
  regime: 'standard-result',
  dots: 'standard-result',
  verdict: 'standard-result',
  govcontracts: 'standard-result',
  value: 'standard-result',
  'growth-chain': 'standard-result',
  brief: 'premium-result',
  flows: 'premium-result',
  rwa: 'premium-result',
  'kraken-listings': 'premium-result',
  rules: 'premium-result',
  'value-batch': 'premium-result',
  growth: 'premium-result',
  history: 'history-result',
  'value-history': 'history-result',
  'growth-history': 'history-result',
};

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function eventMap(source) {
  const block = source.match(/const EVENTS = \{([\s\S]*?)\};/);
  assert.ok(block, 'EVENTS map missing from apify-actor/src/main.js');
  const pairs = [...block[1].matchAll(/(?:['"]([a-z0-9-]+)['"]|([a-z0-9-]+))\s*:\s*['"]([a-z0-9-]+)['"]/g)];
  assert.ok(pairs.length, 'EVENTS map has no entries');
  return Object.fromEntries(pairs.map((match) => [match[1] || match[2], match[3]]));
}

test('signal actor charges only the four live PPE event names', () => {
  const source = read('apify-actor/src/main.js');
  const events = eventMap(source);
  assert.deepEqual(events, EXPECTED);
  for (const name of Object.values(events)) assert.ok(ALLOWED.has(name), name);

  const referenced = [...source.matchAll(/['"]([a-z0-9-]*result[a-z0-9-]*)['"]/g)].map((match) => match[1]);
  assert.ok(referenced.length >= 4);
  for (const name of referenced) assert.ok(ALLOWED.has(name), name);

  for (const retired of ['value-standard', 'value-premium', 'growth-standard', 'growth-premium']) {
    assert.equal(source.includes(retired), false, retired);
  }
});

test('signal actor manifest prefills govcontracts and defaults to 256 MB', () => {
  const actor = JSON.parse(read('apify-actor/.actor/actor.json'));
  const input = JSON.parse(read('apify-actor/.actor/input_schema.json'));
  assert.equal(actor.actorSpecification, 1);
  assert.equal(actor.title, 'GW8 Signal API');
  assert.equal(actor.minMemoryMbytes, 128);
  assert.equal(actor.defaultMemoryMbytes, 256);
  assert.equal(actor.maxMemoryMbytes, 256);
  assert.ok(actor.defaultMemoryMbytes >= actor.minMemoryMbytes);
  assert.ok(actor.defaultMemoryMbytes <= actor.maxMemoryMbytes);
  assert.equal(input.properties.endpoint.prefill, 'govcontracts');
  assert.equal(input.properties.endpoint.default, 'govcontracts');
  assert.deepEqual(input.required, ['endpoint']);
  for (const endpoint of input.properties.endpoint.enum) {
    assert.equal(EXPECTED[endpoint], eventMap(read('apify-actor/src/main.js'))[endpoint]);
  }
});
