// Offline tests for rs.js + rails.js (no network: fetch is stubbed before import).
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.fetch = async () => { throw new Error('offline test'); };
const { buildRs, pctRanks, SECTORS, SECTOR_OF } = await import('../rs.js');
const { PAIRS_MAP } = await import('../Signal.js');
const { buildRails, validAmount } = await import('../rails.js');

const rows = (closes) => closes.map((c, i) => [1700000000 + i * 86400, c, c, c, c, 0, 0, 0]);

test('every Kraken pair has exactly one sector', () => {
  assert.equal(Object.keys(SECTOR_OF).length, Object.values(SECTORS).flat().length);
  for (const sym of Object.keys(PAIRS_MAP)) assert.ok(SECTOR_OF[sym], `no sector for ${sym}`);
});

test('pctRanks: 0..100 with ties and nulls', () => {
  assert.deepEqual(pctRanks([1, 2, 3]), [0, 50, 100]);
  assert.deepEqual(pctRanks([5, null, 5, 1]), [75, null, 75, 0]);
});

test('buildRs: returns, strength, sectors, short history', () => {
  const flat = Array(40).fill(100);
  const up = flat.map((_, i) => 100 + i), down = flat.map((_, i) => 200 - i);
  const d = buildRs({ BTC: rows(up), ETH: rows(flat), DOGE: rows(down), MON: rows([1, 2, 3]) }, 0);
  const by = Object.fromEntries(d.coins.map(c => [c.symbol, c]));
  assert.equal(by.BTC.ret1mPct, +((139 / 109 - 1) * 100).toFixed(2));
  assert.equal(by.BTC.strength, 100);
  assert.equal(by.DOGE.strength, 0);
  assert.equal(by.MON.strength, null);
  assert.equal(d.scored, 3);
  const l1 = d.sectors.find(s => s.sector === 'l1');
  assert.equal(l1.coins, 3); assert.equal(l1.breadth1mPct, 50); assert.equal(l1.leader, 'BTC');
});

test('buildRails: live math, card static, recommended', () => {
  const at = '2026-10-20T23:00:00.000Z';
  const d = buildRails(100, { gas: { wei: 6e6, at }, fee: { drops: 10, at }, tick: { eth: 2500, xrp: 2.5, at } });
  const by = Object.fromEntries(d.rails.map(r => [r.rail, r]));
  assert.equal(by['base-usdc'].feeUsd, 0.000975);
  assert.equal(by['xrpl-rlusd-xrp'].feeUsd, 0.000025);
  assert.equal(by.card.feeUsd, 3.2); assert.equal(by.card.status, 'static-estimate');
  assert.equal(d.recommended.rail, 'xrpl-rlusd-xrp'); assert.equal(d.recommended.fastest, 'base-usdc');
});

test('buildRails: failed fetch -> unavailable, never invented', () => {
  const d = buildRails(100, { gas: null, fee: { drops: 10, at: 'x' }, tick: null });
  for (const r of d.rails.filter(r => r.rail !== 'card')) { assert.equal(r.status, 'unavailable'); assert.equal(r.feeUsd, undefined); }
  assert.equal(d.recommended.rail, 'card');
});

test('validAmount', () => {
  assert.deepEqual(validAmount(undefined), { amount: 100 });
  assert.deepEqual(validAmount('250'), { amount: 250 });
  assert.ok(validAmount('-1').error); assert.ok(validAmount('abc').error); assert.ok(validAmount('1e9').error);
});
