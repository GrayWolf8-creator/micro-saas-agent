// Which facilitator and which rail. Offline: no live /supported calls except the probe test, which stubs fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCategory, capDescription } from '../catalog.js';
import { RAILS_ROUTE_PRICE_USD, usdAtomic } from '../prices.js';
import {
  buildRoute, validRouteQuery, parseSupported, chainIdFromNetwork, probeFacilitators, _resetProbeCache,
  ROUTE_BLURB, ROUTE_TAGS, ROUTE_SERVICE_NAME, ROUTE_EXAMPLE, ROUTE_OUTPUT_SCHEMA, MICRO_AMOUNT_USD, BASE_FEE_GAP_SHARE
} from '../facilitators.js';

const payai = (fees, supports = Object.keys(fees)) => ({
  id: 'payai', name: 'PayAI', supportedUrl: 'https://facilitator.payai.network/supported',
  status: 'up', supports: new Set(supports), fees, publishedChains: new Set(supports), publishedFeeUsd: null, feeNote: null
});
const cdp = (status = 'unknown') => ({
  id: 'coinbase-cdp', name: 'Coinbase CDP', supportedUrl: 'https://api.cdp.coinbase.com/platform/v2/x402/supported',
  status, supports: new Set(status === 'up' ? ['base', 'solana'] : []), fees: {},
  publishedChains: new Set(['base', 'solana', 'polygon']), publishedFeeUsd: 0.001,
  feeNote: 'published marginal rate'
});

test('query defaults and validation', () => {
  assert.deepEqual(validRouteQuery({}), { chain: null, amount: 1 });
  assert.deepEqual(validRouteQuery({ chain: 'BASE', amount: '0.05' }), { chain: 'base', amount: 0.05 });
  assert.equal(validRouteQuery({ chain: 'eip155:8453' }).chain, 'base');
  assert.equal(validRouteQuery({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }).chain, 'solana');
  assert.ok(validRouteQuery({ chain: 'base-sepolia' }).error);
  assert.ok(validRouteQuery({ amount: '0' }).error);
  assert.ok(validRouteQuery({ amount: '-1' }).error);
  assert.ok(validRouteQuery({ amount: '1e9' }).error);
});

test('parseSupported keeps exact mainnet fees and drops testnets', () => {
  assert.equal(chainIdFromNetwork('base-sepolia'), null);
  assert.equal(chainIdFromNetwork('eip155:84532'), null);
  const parsed = parseSupported({
    kinds: [
      { scheme: 'exact', network: 'eip155:8453' },
      { scheme: 'exact', network: 'base-sepolia' },
      { scheme: 'batch-settlement', network: 'eip155:8453' },
      { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }
    ],
    pricing: { rates: [
      { network: 'eip155:8453', scheme: 'exact', transferMethod: 'eip3009', usd: '0.00156', published: true },
      { network: 'eip155:8453', scheme: 'exact', transferMethod: 'permit2', usd: '0.00010', published: true },
      { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', scheme: 'exact', transferMethod: 'svm_transfer', usd: '0.00093', published: true }
    ] }
  });
  assert.deepEqual([...parsed.supports].sort(), ['base', 'solana']);
  assert.equal(parsed.fees.base, 0.00156);
  assert.equal(parsed.fees.solana, 0.00093);
  assert.equal(parseSupported({}), null);
});

test('one recommendation: requested chain, amount switches the chain, unknown loses to up', () => {
  const probes = [payai({ base: 0.00156, solana: 0.00093 }), cdp('unknown')];
  const onBase = buildRoute(probes, { chain: 'base', amount: 0.05 });
  assert.equal(onBase.recommended.facilitator, 'PayAI');
  assert.equal(onBase.recommended.chain, 'base');
  assert.equal(onBase.fee, 0.00156);
  assert.equal(onBase.settle_time, '~2s');
  assert.equal(onBase.status, 'up');
  assert.match(onBase.recommended.why, /0\.05/);
  assert.match(onBase.recommended.why, /not overridden/);
  assert.ok(onBase.alternatives.every(a => a.facilitator !== onBase.recommended.facilitator || a.chain !== 'base'));
  assert.equal(onBase.alternatives.find(a => a.facilitator === 'Coinbase CDP').status, 'unknown');

  const micro = buildRoute(probes, { chain: null, amount: 0.05 });
  assert.ok(0.05 < MICRO_AMOUNT_USD);
  assert.equal(micro.recommended.facilitator, 'PayAI');
  assert.equal(micro.recommended.chain, 'solana');
  assert.equal(micro.fee, 0.00093);
  assert.match(micro.recommended.why, /Under \$1/);

  const large = buildRoute(probes, { chain: null, amount: 10 });
  const gap = 0.00156 - 0.00093;
  assert.ok(gap <= 10 * BASE_FEE_GAP_SHARE);
  assert.equal(large.recommended.chain, 'base');
  assert.equal(large.recommended.facilitator, 'PayAI');
  assert.match(large.recommended.why, /stays on Base/);
  assert.equal(large.alternatives[0].chain === 'solana' || large.alternatives.some(a => a.chain === 'solana'), true);

  const priceyBase = buildRoute([payai({ base: 0.05, solana: 0.00093 })], { chain: null, amount: 1 });
  assert.ok(0.05 - 0.00093 > 1 * BASE_FEE_GAP_SHARE);
  assert.equal(priceyBase.recommended.chain, 'solana');
  assert.match(priceyBase.recommended.why, /cheaper chain wins/);
});

test('a failed probe is unknown, and a published fee is used only then', () => {
  const onlyUnknown = buildRoute([cdp('unknown')], { chain: 'base', amount: 1 });
  assert.equal(onlyUnknown.recommended.facilitator, 'Coinbase CDP');
  assert.equal(onlyUnknown.status, 'unknown');
  assert.equal(onlyUnknown.fee, 0.001);
  assert.equal(onlyUnknown.feeSource, 'published');
  assert.match(onlyUnknown.recommended.why, /unknown/);

  const upCdp = buildRoute([cdp('up'), payai({ base: 0.00156 })], { chain: 'base', amount: 5 });
  assert.equal(upCdp.recommended.facilitator, 'Coinbase CDP');
  assert.equal(upCdp.fee, 0.001);
  assert.equal(upCdp.status, 'up');

  const none = buildRoute([payai({ base: 0.001 })], { chain: 'ethereum', amount: 1 });
  assert.equal(none.recommended.facilitator, null);
  assert.equal(none.status, 'down');
  assert.equal(none.fee, null);
  assert.match(none.recommended.why, /Nothing was invented/);
});

test('probe fail-soft is unknown and a 2xx kinds list is up, cached for a few minutes', async () => {
  _resetProbeCache();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('payai')) return { ok: true, json: async () => ({ kinds: [{ scheme: 'exact', network: 'eip155:8453' }], pricing: { rates: [{ network: 'eip155:8453', scheme: 'exact', transferMethod: 'eip3009', usd: '0.00156', published: true }] } }) };
    if (String(url).includes('cdp')) return { ok: false, status: 401, json: async () => ({}) };
    throw new Error('timeout');
  };
  const first = await probeFacilitators({ fetch: fetchImpl, now: 1_000 });
  assert.equal(first.cached, false);
  const by = Object.fromEntries(first.probes.map(p => [p.id, p]));
  assert.equal(by.payai.status, 'up');
  assert.equal(by.payai.fees.base, 0.00156);
  assert.equal(by['coinbase-cdp'].status, 'unknown');
  assert.equal(by.dexter.status, 'unknown');
  const again = await probeFacilitators({ fetch: async () => { throw new Error('should be cached'); }, now: 1_000 + 60_000 });
  assert.equal(again.cached, true);
  assert.equal(again.probes, first.probes);
  const later = await probeFacilitators({ fetch: fetchImpl, now: 1_000 + 3 * 60 * 1000 });
  assert.equal(later.cached, false);
  assert.ok(calls.length > first.probes.length);
  _resetProbeCache();
});

test('bazaar copy names facilitator and which rail and stays inside the CDP cap', () => {
  assert.equal(RAILS_ROUTE_PRICE_USD, '0.005');
  assert.equal(usdAtomic(RAILS_ROUTE_PRICE_USD), '5000');
  assert.equal(ROUTE_SERVICE_NAME.length <= 32, true);
  assert.equal(ROUTE_TAGS.length, 5);
  assert.ok(ROUTE_TAGS.includes('facilitator') && ROUTE_TAGS.includes('which rail'));
  const d = withCategory('/api/rails/route', ROUTE_BLURB);
  assert.ok(d.length <= 500, String(d.length));
  assert.equal(d.endsWith('...'), false);
  assert.equal(capDescription(d), d);
  assert.match(d, /facilitator/);
  assert.match(d, /which rail/);
  assert.match(d, /\$0\.005/);
  assert.equal(ROUTE_EXAMPLE.recommended.facilitator, 'PayAI');
  assert.equal(ROUTE_EXAMPLE.recommended.chain, 'base');
  assert.equal(ROUTE_EXAMPLE.status, 'up');
  assert.ok(ROUTE_EXAMPLE.recommended.why.length > 20);
  assert.deepEqual(ROUTE_OUTPUT_SCHEMA.required, ['recommended', 'alternatives', 'fee', 'settle_time', 'status']);
  assert.deepEqual(ROUTE_OUTPUT_SCHEMA.properties.recommended.required, ['facilitator', 'chain', 'why']);
});
