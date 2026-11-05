// Token safety screen: CLEAR / CAUTION / AVOID / UNKNOWN, failed lookups, and Bazaar discovery text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withCategory, MAX_RESOURCE_DESCRIPTION } from '../catalog.js';
import {
  VERDICT_BLURB, VERDICT_TAGS, VERDICT_SERVICE_NAME, VERDICT_LABELS, VERDICT_EXAMPLE, VERDICT_CHAINS,
  validVerdictInput, scoreVerdict, getVerdict, verdictSourceUrls
} from '../upgrades.js';

const ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = Date.parse('2026-11-05T00:00:00.000Z');
const OLD = NOW - 10 * 86400000;

function evm(over = {}) {
  return {
    is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_open_source: '1', is_proxy: '0', is_in_dex: '1',
    trust_list: '1', creator_percent: '0', token_name: 'USD Coin', token_symbol: 'USDC', holder_count: '10',
    holders: [{ percent: '0.01', is_locked: 0, is_contract: 0 }],
    ...over
  };
}
function pair(over = {}) {
  return { liquidity: { usd: 2_000_000 }, priceUsd: '1', volume: { h24: 1000 }, pairCreatedAt: OLD, url: 'https://dexscreener.com/base/pair', baseToken: { symbol: 'USDC' }, ...over };
}
function scored(chain, address, goplus, dex, now = NOW) {
  return scoreVerdict(chain, address, {
    goplus, dex,
    urls: verdictSourceUrls(chain, address),
    fetchedAt: new Date(now).toISOString()
  }, now);
}
const okToken = token => ({ status: 'ok', detail: null, token });
const okPairs = pairs => ({ status: 'ok', detail: null, pairs });

test('discovery text names the searches agents use and stays inside the CDP description cap', () => {
  const d = withCategory('/api/verdict/base/' + ADDR, VERDICT_BLURB);
  assert.ok(d.length <= MAX_RESOURCE_DESCRIPTION, `description is ${d.length}`);
  assert.equal(d.endsWith('...'), false);
  for (const phrase of ['token safety', 'rug check', 'honeypot', 'contract risk', 'CLEAR', 'CAUTION', 'AVOID', 'UNKNOWN', '$0.01'])
    assert.match(d, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(VERDICT_TAGS.length, 5);
  assert.ok(VERDICT_TAGS.includes('honeypot') && VERDICT_TAGS.includes('rug-check') && VERDICT_TAGS.includes('contract-risk'));
  assert.ok(VERDICT_SERVICE_NAME.length <= 32);
  assert.equal(VERDICT_EXAMPLE.verdict, 'CLEAR');
  assert.ok(VERDICT_LABELS.includes('UNKNOWN'));
  assert.doesNotMatch(VERDICT_BLURB, /financial advice|investment advice|safe to buy/i);
});

test('valid chains are the GoPlus plus DexScreener overlap, and addresses are checked', () => {
  for (const c of ['base', 'ethereum', 'polygon', 'optimism', 'avalanche', 'solana', 'berachain', 'worldchain'])
    assert.equal(validVerdictInput(c, c === 'solana' ? MINT : ADDR), null, c);
  assert.equal(validVerdictInput('tron', ADDR), 'unsupported chain');
  assert.equal(validVerdictInput('base', 'not-an-address'), 'invalid address');
  assert.equal(validVerdictInput('solana', ADDR), 'invalid address');
  assert.match(verdictSourceUrls('base', ADDR).goplus, /token_security\/8453/);
  assert.match(verdictSourceUrls('solana', MINT).goplus, /solana\/token_security/);
});

test('a quiet record with deep liquidity is CLEAR, including a small proxy flag', () => {
  const clean = scored('base', ADDR, okToken(evm()), okPairs([pair()]));
  assert.equal(clean.verdict, 'CLEAR');
  assert.equal(clean.score, 100);
  assert.equal(clean.reasons[0].code, 'no_flags');
  assert.equal(clean.unknowns.some(u => u.limitsVerdict), false);
  assert.equal(clean.freshness.cacheTtlSec, 600);
  assert.equal(clean.sources[0].status, 'ok');
  assert.equal(clean.token.trustListed, true);
  const proxy = scored('base', ADDR, okToken(evm({ is_proxy: '1' })), okPairs([pair()]));
  assert.equal(proxy.verdict, 'CLEAR');
  assert.equal(proxy.score, 90);
  assert.equal(proxy.reasons[0].code, 'proxy');
  assert.equal(proxy.reasons[0].points, -10);
});

test('honeypot, fake token, and a sub-40 score are AVOID', () => {
  const honey = scored('base', ADDR, okToken(evm({ is_honeypot: '1' })), okPairs([pair()]));
  assert.equal(honey.verdict, 'AVOID');
  assert.equal(honey.score, 0);
  assert.equal(honey.reasons.find(r => r.code === 'honeypot').points, -100);
  const fake = scored('base', ADDR, okToken(evm({ fake_token: { value: 1 } })), okPairs([pair()]));
  assert.equal(fake.verdict, 'AVOID');
  assert.ok(fake.reasons.some(r => r.code === 'fake_token'));
  const thin = scored('base', ADDR, okToken(evm({ is_mintable: '1', is_proxy: '1', hidden_owner: '1' })), okPairs([pair({ liquidity: { usd: 100 } })]));
  assert.equal(thin.verdict, 'AVOID');
  assert.ok(thin.score < 40);
});

test('missing LP, freeze authority, and a young thin pair are CAUTION rather than CLEAR', () => {
  const unlocked = scored('base', ADDR, okToken(evm({ lp_holders: [{ address: '0x1111111111111111111111111111111111111111', percent: '0.9', is_locked: 0 }] })), okPairs([pair()]));
  assert.equal(unlocked.verdict, 'CAUTION');
  assert.ok(unlocked.reasons.some(r => r.code === 'lp_unlocked'));
  const locked = scored('base', ADDR, okToken(evm({ lp_holders: [{ address: '0x000000000000000000000000000000000000dead', percent: '0.8', is_locked: 0 }] })), okPairs([pair()]));
  assert.equal(locked.verdict, 'CLEAR');
  const sol = scored('solana', MINT, okToken({ freezable: { status: '1' }, metadata: { name: 'USDC', symbol: 'USDC' } }), okPairs([pair()]));
  assert.equal(sol.verdict, 'CAUTION');
  assert.ok(sol.reasons.some(r => r.code === 'freeze_authority'));
  const young = scored('base', ADDR, okToken(evm()), okPairs([pair({ liquidity: { usd: 500 }, pairCreatedAt: NOW - 3600000 })]));
  assert.equal(young.verdict, 'CAUTION');
  assert.ok(young.reasons.some(r => r.code === 'low_liquidity'));
  assert.ok(young.reasons.some(r => r.code === 'new_pair'));
  assert.equal(young.market.pairAgeHours, 1);
});

test('both sources empty is UNKNOWN with a null score; a source failure caps the result', () => {
  const unknown = scored('base', ADDR, { status: 'empty', detail: 'no_record', token: null }, { status: 'empty', detail: 'no_pairs', pairs: [] });
  assert.equal(unknown.verdict, 'UNKNOWN');
  assert.equal(unknown.score, null);
  assert.equal(unknown.unknowns.every(u => u.limitsVerdict), true);
  const partial = scored('base', ADDR, { status: 'error', detail: 'timeout', token: null }, okPairs([pair()]));
  assert.equal(partial.verdict, 'CAUTION');
  assert.equal(partial.unknowns.find(u => u.code === 'goplus_unavailable').limitsVerdict, true);
  assert.equal(partial.market.liquidityUsd, 2_000_000);
  const noBook = scored('polygon', ADDR, { status: 'empty', detail: 'no_record', token: null }, okPairs([pair()]));
  assert.equal(noBook.verdict, 'CAUTION');
  assert.ok(noBook.reasons.some(r => r.code === 'no_security_record'));
});

test('getVerdict: failed lookups are not cached, UNKNOWN is cached, fresh skips the cache', async () => {
  const dead = '0x00000000000000000000000000000000000000aa';
  const empty = '0x00000000000000000000000000000000000000bb';
  const halfAddr = '0x00000000000000000000000000000000000000cc';
  let deadCalls = 0;
  const deadFetch = async () => { deadCalls += 1; const e = new Error('down'); e.detail = 'timeout'; throw e; };
  const a = await getVerdict('base', dead, { fetchJson: deadFetch });
  const b = await getVerdict('base', dead, { fetchJson: deadFetch });
  assert.equal(a.verdict, undefined);
  assert.match(a.error, /upstream data unavailable/);
  assert.equal(a.http, 503);
  assert.equal(a.sourceStatus.goplus, 'timeout');
  assert.equal(a.sourceStatus.dexscreener, 'timeout');
  assert.equal(b.error, a.error);
  assert.equal(deadCalls, 4);

  let calls = 0;
  const fetchJson = async (url) => {
    calls += 1;
    if (String(url).includes('goplus')) return { code: 1, result: {} };
    return [];
  };
  const u = await getVerdict('base', empty, { fetchJson });
  assert.equal(u.verdict, 'UNKNOWN');
  assert.equal(u.score, null);
  assert.equal(u.cached, false);
  const again = await getVerdict('base', empty, { fetchJson });
  assert.equal(again.cached, true);
  assert.equal(calls, 2);
  await getVerdict('base', empty, { fetchJson, fresh: true });
  assert.equal(calls, 4);
  const half = await getVerdict('base', halfAddr, {
    fetchJson: async (url) => {
      if (String(url).includes('goplus')) { const e = new Error('down'); e.detail = 'http_503'; throw e; }
      return [];
    }
  });
  assert.equal(half.http, 503);
  assert.equal(half.verdict, undefined);
});

test('paid challenge, openapi, llms.txt, agents.md, and discovery advertise the screen', async (t) => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const srv = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => srv.kill());
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start')), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/api/verdict/base/' + ADDR);
  assert.equal(r.status, 402);
  const pr = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
  assert.equal(pr.accepts[0].amount, '10000');
  assert.equal(pr.extensions.bazaar.routeTemplate, '/api/verdict/:chain/:address');
  assert.equal(pr.extensions.bazaar.info.input.queryParams.fresh, '0');
  assert.deepEqual(pr.extensions.bazaar.schema.properties.input.properties.queryParams.properties.fresh.enum, ['0', '1']);
  assert.ok(pr.extensions.bazaar.schema.properties.input.properties.pathParams.properties.chain.enum.includes('polygon'));
  assert.equal(pr.extensions.bazaar.info.output.example.verdict, 'CLEAR');
  assert.ok(pr.extensions.bazaar.schema.properties.output.properties.example.properties.verdict.enum.includes('UNKNOWN'));
  assert.equal(pr.resource.serviceName, 'GW8 Token Safety');
  assert.deepEqual(pr.resource.tags, VERDICT_TAGS);
  for (const phrase of ['honeypot', 'rug check', 'contract risk', 'token safety']) assert.match(pr.resource.description, new RegExp(phrase));
  const doc = await (await fetch(base + '/openapi.json')).json();
  const op = doc.paths['/api/verdict/{chain}/{address}'].get;
  assert.equal(op['x-payment-info'].price.amount, '0.01');
  assert.ok(op.parameters.some(p => p.name === 'fresh'));
  assert.ok(op.parameters.find(p => p.name === 'chain').schema.enum.includes('solana'));
  assert.match(op.summary, /CLEAR/);
  assert.match(op.responses['200'].description, /UNKNOWN/);
  const llms = await (await fetch(base + '/llms.txt')).text();
  const agents = await (await fetch(base + '/agents.md')).text();
  const disc = await (await fetch(base + '/.well-known/x402')).json();
  for (const text of [llms, agents, disc.instructions]) {
    for (const phrase of ['token safety', 'rug check', 'honeypot', 'contract risk', 'CLEAR', 'UNKNOWN']) assert.match(text, new RegExp(phrase, 'i'));
  }
  assert.match(disc.resources[0], /\/api\/pass\/day$/);
  assert.deepEqual(disc.tokenSafety.verdicts, VERDICT_LABELS);
  assert.equal(disc.tokenSafety.priceUsd, '0.01');
});
