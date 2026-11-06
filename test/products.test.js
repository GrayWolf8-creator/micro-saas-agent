// Deep honeypot check, token brief, and crypto bottom watch. Network is mocked.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withCategory, MAX_RESOURCE_DESCRIPTION } from '../catalog.js';
import { scoreVerdict, verdictSourceUrls } from '../upgrades.js';
import { classifySale } from '../sales.js';
import {
  DEEP_BLURB, BRIEF_BLURB, BOTTOM_BLURB, DEEP_SERVICE_NAME, BRIEF_SERVICE_NAME, BOTTOM_SERVICE_NAME,
  buildDeepVerdict, getDeepVerdict, _resetDeepCache, buildTokenBrief, getTokenBrief, _resetBriefCache,
  evaluateCoin, evaluateBottoms, tierFor, getCryptoBottoms, _resetBottomsCache,
  parseKrakenOhlc, parseBinanceKlines, rsiSeries, SIGNAL_COINS
} from '../products.js';

const ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY = 86400000;

function evm(over = {}) {
  return {
    is_honeypot: '0', buy_tax: '0', sell_tax: '0', is_open_source: '1', is_proxy: '0', is_mintable: '0',
    is_blacklisted: '0', is_in_dex: '1', owner_address: '0x0000000000000000000000000000000000000000',
    holders: [{ percent: '0.04', is_locked: 0, is_contract: 0 }, { percent: '0.03', is_locked: 0, is_contract: 0 }],
    lp_holders: [{ address: '0x000000000000000000000000000000000000dead', percent: '0.8', is_locked: 0 }],
    token_name: 'USD Coin', token_symbol: 'USDC',
    ...over
  };
}
function pair(over = {}) {
  return {
    liquidity: { usd: 2_000_000 }, priceUsd: '1', volume: { h24: 1_000_000 },
    priceChange: { h24: 0.4 }, fdv: 5_000_000, pairCreatedAt: NOW - 400 * DAY,
    url: 'https://dexscreener.com/base/pair', baseToken: { symbol: 'USDC' }, ...over
  };
}
const okToken = token => ({ status: 'ok', detail: null, token });
const okPairs = pairs => ({ status: 'ok', detail: null, pairs });
const hpQuiet = { status: 'ok', detail: null, body: { honeypotResult: { isHoneypot: false }, simulationResult: { buyTax: 0, sellTax: 0 }, contractCode: { isProxy: false } } };

function built(goplus, dex, honeypot = hpQuiet, now = NOW) {
  return buildDeepVerdict('base', ADDR, {
    goplus, dex, honeypot, urls: verdictSourceUrls('base', ADDR), honeypotUrl: 'https://api.honeypot.is/v2/IsHoneypot?address=' + ADDR,
    fetchedAt: new Date(now).toISOString()
  }, now);
}

function days(n, price, vol, end = NOW - DAY) {
  const start = end - (n - 1) * DAY;
  return Array.from({ length: n }, (_, i) => ({ t: start + i * DAY, o: price, h: price, l: price, c: price, v: vol }));
}
function sweep(rows, vol) {
  const next = rows.map(c => ({ ...c }));
  const last = next[next.length - 1];
  last.l = last.l - 1;
  last.c = last.c + 1;
  last.v = vol;
  return next;
}

describe('paid x402 products', { concurrency: false }, () => {
  test('descriptions name the searches and stay inside the CDP cap', () => {
    const deep = withCategory('/api/verdict-deep/base/' + ADDR, DEEP_BLURB);
    const brief = withCategory('/api/token-brief/base/' + ADDR, BRIEF_BLURB);
    const bottom = withCategory('/api/signals/crypto-bottom', BOTTOM_BLURB);
    for (const d of [deep, brief, bottom]) {
      assert.ok(d.length <= MAX_RESOURCE_DESCRIPTION, String(d.length));
      assert.equal(d.endsWith('...'), false);
    }
    const re = phrase => new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const phrase of ['deep honeypot check', 'rug pull', 'token safety', 'holder concentration', 'liquidity lock', 'scam token', '$0.05'])
      assert.match(deep, re(phrase));
    for (const phrase of ['token safety plus price', 'token brief', 'trade check', '$0.02'])
      assert.match(brief, re(phrase));
    assert.match(bottom, /research data, not financial advice/i);
    assert.match(bottom, /\$0\.01/);
    assert.ok(DEEP_SERVICE_NAME.length <= 32 && BRIEF_SERVICE_NAME.length <= 32 && BOTTOM_SERVICE_NAME.length <= 32);
  });

  test('deep check adds holder, liquidity lock, privileges, tax, and contract age', () => {
    const screen = scoreVerdict('base', ADDR, { goplus: okToken(evm()), dex: okPairs([pair()]), fetchedAt: new Date(NOW).toISOString() }, NOW);
    const deep = built(okToken(evm()), okPairs([pair()]));
    assert.equal(deep.verdict, screen.verdict);
    assert.equal(deep.verdict, 'CLEAR');
    assert.equal(deep.score, screen.score);
    assert.equal(deep.deep.holderConcentration.top10Pct, 7);
    assert.equal(deep.deep.holderConcentration.status, 'ok');
    assert.equal(deep.deep.liquidity.amountUsd, 2_000_000);
    assert.equal(deep.deep.liquidity.lockedOrBurned, true);
    assert.equal(deep.deep.liquidity.status, 'ok');
    assert.equal(deep.deep.privileges.owner, 'renounced');
    assert.equal(deep.deep.privileges.mint, false);
    assert.equal(deep.deep.privileges.proxy, false);
    assert.equal(deep.deep.privileges.blacklist, false);
    assert.equal(deep.deep.privileges.status, 'ok');
    assert.equal(deep.deep.tax.buyPct, 0);
    assert.equal(deep.deep.tax.sellPct, 0);
    assert.equal(deep.deep.tax.status, 'ok');
    assert.equal(deep.deep.contractAge.status, 'ok');
    assert.ok(deep.deep.contractAge.days > 30);
    assert.ok(deep.reasons.length);
    assert.equal(deep.market.liquidityUsd, 2_000_000);
  });

  test('missing reads are UNKNOWN and do not turn a clear screen into a failure', () => {
    const deep = built(okToken(evm({ holders: undefined, lp_holders: undefined, buy_tax: undefined, sell_tax: undefined, owner_address: undefined, is_mintable: undefined, is_proxy: undefined, is_blacklisted: undefined })), okPairs([pair({ pairCreatedAt: undefined })]), { status: 'error', detail: 'timeout', body: null });
    assert.equal(deep.verdict, 'CLEAR');
    assert.equal(deep.deep.holderConcentration.status, 'UNKNOWN');
    assert.equal(deep.deep.holderConcentration.top10Pct, null);
    assert.equal(deep.deep.liquidity.lockedOrBurned, null);
    assert.equal(deep.deep.liquidity.amountUsd, 2_000_000);
    assert.equal(deep.deep.liquidity.status, 'partial');
    assert.equal(deep.deep.privileges.status, 'UNKNOWN');
    assert.equal(deep.deep.tax.status, 'UNKNOWN');
    assert.equal(deep.deep.contractAge.status, 'UNKNOWN');
    assert.equal(deep.unknowns.find(u => u.code === 'honeypot_is_unavailable').limitsVerdict, false);
    assert.equal(deep.sources.find(s => s.name === 'honeypot.is').status, 'error');
  });

  test('honeypot.is isHoneypot forces AVOID, and a young pair records contract age', () => {
    const honey = built(okToken(evm()), okPairs([pair()]), { status: 'ok', detail: null, body: { honeypotResult: { isHoneypot: true } } });
    assert.equal(honey.verdict, 'AVOID');
    assert.ok(honey.reasons.some(r => r.code === 'honeypot'));
    const young = built(okToken(evm()), okPairs([pair({ pairCreatedAt: NOW - 3 * DAY })]));
    assert.equal(young.deep.contractAge.days, 3);
    assert.ok(young.reasons.some(r => r.code === 'contract_age'));
    assert.equal(young.verdict, 'CLEAR');
    assert.equal(young.score, 90);
  });

  test('getDeepVerdict and getTokenBrief mock the network, cache, and fail closed', async () => {
    _resetDeepCache();
    _resetBriefCache();
    let calls = 0;
    const fetchJson = async (url) => {
      calls += 1;
      const u = String(url);
      if (u.includes('honeypot.is')) { const e = new Error('down'); e.detail = 'timeout'; throw e; }
      if (u.includes('goplus')) return { code: 1, result: { [ADDR]: evm() } };
      if (u.includes('dexscreener')) return [pair({ priceChange: { h24: -2.5 }, fdv: 9_000_000, volume: { h24: 2500 } })];
      throw new Error('unexpected ' + u);
    };
    const deep = await getDeepVerdict('base', ADDR, { fetchJson, now: NOW });
    assert.equal(deep.verdict, 'CLEAR');
    assert.equal(deep.deep.liquidity.lockedOrBurned, true);
    assert.equal(deep.cached, false);
    const again = await getDeepVerdict('base', ADDR, { fetchJson, now: NOW });
    assert.equal(again.cached, true);
    const beforeFresh = calls;
    await getDeepVerdict('base', ADDR, { fetchJson, now: NOW, fresh: true });
    assert.ok(calls > beforeFresh);

    const brief = await getTokenBrief('base', ADDR, { fetchJson, now: NOW, fresh: true });
    assert.equal(brief.verdict, 'CLEAR');
    assert.equal(brief.marketSnapshot.priceUsd, 1);
    assert.equal(brief.marketSnapshot.change24hPct, -2.5);
    assert.equal(brief.marketSnapshot.volume24hUsd, 2500);
    assert.equal(brief.marketSnapshot.liquidityUsd, 2_000_000);
    assert.equal(brief.marketSnapshot.fdvUsd, 9_000_000);
    assert.equal(brief.marketSnapshot.status, 'ok');
    assert.ok(brief.reasons.length);

    const partial = buildTokenBrief('base', ADDR, { goplus: okToken(evm()), dex: okPairs([pair({ priceChange: undefined, fdv: undefined })]), fetchedAt: new Date(NOW).toISOString() }, NOW);
    assert.equal(partial.marketSnapshot.change24hPct, null);
    assert.equal(partial.marketSnapshot.fdvUsd, null);
    assert.equal(partial.marketSnapshot.status, 'partial');
    const none = buildTokenBrief('base', ADDR, { goplus: okToken(evm()), dex: { status: 'empty', detail: 'no_pairs', pairs: [] }, fetchedAt: new Date(NOW).toISOString() }, NOW);
    assert.equal(none.marketSnapshot.status, 'UNKNOWN');
    assert.notEqual(none.verdict, undefined);

    let deadCalls = 0;
    const dead = async () => { deadCalls += 1; const e = new Error('down'); e.detail = 'timeout'; throw e; };
    const fail = await getDeepVerdict('base', '0x00000000000000000000000000000000000000aa', { fetchJson: dead });
    const fail2 = await getDeepVerdict('base', '0x00000000000000000000000000000000000000aa', { fetchJson: dead });
    assert.equal(fail.http, 503);
    assert.equal(fail.verdict, undefined);
    assert.equal(fail2.http, 503);
    assert.equal(deadCalls, 6);
    const briefFail = await getTokenBrief('base', '0x00000000000000000000000000000000000000bb', { fetchJson: dead });
    assert.equal(briefFail.http, 503);
  });

  test('bottom-watch tiers: EARLY_TELL at 2 tells, CONFIRMED only after BTC reclaims', () => {
    assert.equal(tierFor(1, true), 'NONE');
    assert.equal(tierFor(2, false), 'EARLY_TELL');
    assert.equal(tierFor(2, true), 'CONFIRMED');
    const flat = days(40, 100, 10);
    const reclaimed = sweep(flat, 40);
    const btc = evaluateCoin('BTC', { daily: reclaimed, h4: [], funding: null, source: 'kraken' });
    assert.equal(btc.tells.sweep_reclaim, true);
    assert.equal(btc.tells.volume_2x, true);
    assert.equal(btc.tells.rsi_turn, false);
    assert.equal(btc.tells_count, 2);
    const quiet = evaluateCoin('ETH', { daily: flat, source: 'kraken' });
    assert.equal(quiet.tells.sweep_reclaim, false);
    assert.equal(quiet.tells_count, 0);

    const early = evaluateBottoms({ coins: { BTC: { daily: flat }, ETH: { daily: reclaimed } }, now: NOW });
    assert.equal(early.btcReclaimed, false);
    assert.equal(early.coins.find(c => c.symbol === 'ETH').tier, 'EARLY_TELL');
    assert.equal(early.coins.find(c => c.symbol === 'BTC').tier, 'NONE');
    assert.match(early.disclaimer, /Research data, not financial advice/);

    const confirmed = evaluateBottoms({ coins: { BTC: { daily: reclaimed }, ETH: { daily: reclaimed }, SOL: { daily: flat } }, now: NOW });
    assert.equal(confirmed.btcReclaimed, true);
    assert.equal(confirmed.coins.find(c => c.symbol === 'ETH').tier, 'CONFIRMED');
    assert.equal(confirmed.coins.find(c => c.symbol === 'BTC').tier, 'CONFIRMED');
    assert.equal(confirmed.coins.find(c => c.symbol === 'SOL').tier, 'NONE');
    assert.equal(confirmed.coins.find(c => c.symbol === 'CC').status, 'unavailable');
    assert.equal(confirmed.coins.find(c => c.symbol === 'CC').tier, 'NONE');
    assert.deepEqual(confirmed.coins.map(c => c.symbol), SIGNAL_COINS);
  });

  test('RSI turn, 4h higher low, and funding flush are separate tells', () => {
    const closes = [];
    let price = 100;
    for (let i = 0; i < 20; i++) { price *= 0.95; closes.push(price); }
    const prev = price;
    price *= 1.02;
    closes.push(price);
    const rsi = rsiSeries(closes);
    assert.ok(rsi[rsi.length - 2] <= 30, 'prev rsi ' + rsi[rsi.length - 2]);
    assert.ok(rsi[rsi.length - 1] > rsi[rsi.length - 2]);
    const daily = closes.map((c, i) => ({ t: NOW - (closes.length - i) * DAY, o: c, h: c, l: c, c, v: 10 }));
    const turned = evaluateCoin('ETH', { daily });
    assert.equal(turned.tells.rsi_turn, true);

    const h4 = [];
    for (let i = 0; i < 6; i++) h4.push({ t: i, o: 10, h: 11, l: 8, c: 10, v: 1 });
    for (let i = 0; i < 6; i++) h4.push({ t: 6 + i, o: 12, h: 13, l: 11, c: 12, v: 1 });
    const higher = evaluateCoin('SOL', { daily: days(40, 100, 10), h4 });
    assert.equal(higher.tells.higher_low_4h, true);
    assert.equal(higher.detail.higherLowPrior, 8);
    assert.equal(higher.detail.higherLowRecent, 11);

    const flushed = evaluateCoin('BTC', { daily: days(40, 100, 10), funding: [-0.0002, -0.001, -0.0002] });
    assert.equal(flushed.tells.funding_flush, true);
    const calm = evaluateCoin('BTC', { daily: days(40, 100, 10), funding: [-0.0001, -0.0001, -0.0001] });
    assert.equal(calm.tells.funding_flush, false);
    const missing = evaluateCoin('BTC', { daily: days(40, 100, 10) });
    assert.equal(missing.tells.funding_flush, null);
    assert.equal(missing.tells_count, 0);
  });

  test('getCryptoBottoms reads Kraken candles, falls back, caches, and does not invent a feed', async () => {
    _resetBottomsCache();
    const end = NOW - DAY;
    const daily = days(40, 100, 10, end);
    const h4 = Array.from({ length: 20 }, (_, i) => ({ t: NOW - (20 - i) * 4 * 3600 * 1000, o: 1, h: 1, l: 1, c: 1, v: 1 }));
    const kraken = rows => ({ error: [], result: { PAIR: rows.map(c => [c.t / 1000, c.o, c.h, c.l, c.c, c.c, c.v, 1]), last: 1 } });
    let calls = 0;
    const fetchJson = async (url) => {
      calls += 1;
      const u = String(url);
      if (u.includes('pair=CCUSD')) throw new Error('no pair');
      if (u.includes('api.kraken.com') && u.includes('interval=1440')) return kraken(daily);
      if (u.includes('api.kraken.com') && u.includes('interval=240')) return kraken(h4);
      if (u.includes('fapi.binance.com')) return [{ fundingRate: '-0.0001' }, { fundingRate: '-0.0001' }, { fundingRate: '-0.00005' }];
      if (u.includes('api.binance.com') && u.includes('CCUSDT') && u.includes('interval=1d')) {
        return daily.map(c => [c.t, c.o, c.h, c.l, c.c, c.v, c.t + DAY]);
      }
      throw new Error('unexpected ' + u);
    };
    const feed = await getCryptoBottoms({ fetchJson, now: NOW });
    assert.equal(feed.cached, false);
    assert.equal(feed.coins.find(c => c.symbol === 'BTC').status, 'ok');
    assert.equal(feed.coins.find(c => c.symbol === 'BTC').source, 'kraken');
    assert.equal(feed.coins.find(c => c.symbol === 'CC').source, 'binance');
    assert.match(feed.disclaimer, /not financial advice/);
    const used = calls;
    const cached = await getCryptoBottoms({ fetchJson, now: NOW });
    assert.equal(cached.cached, true);
    assert.equal(calls, used);
    await getCryptoBottoms({ fetchJson, now: NOW, fresh: '1' });
    assert.ok(calls > used);

    _resetBottomsCache();
    let dead = 0;
    const down = await getCryptoBottoms({ fetchJson: async () => { dead += 1; throw new Error('down'); }, now: NOW });
    assert.equal(down.http, 503);
    const deadOnce = dead;
    await getCryptoBottoms({ fetchJson: async () => { dead += 1; throw new Error('down'); }, now: NOW });
    assert.ok(dead > deadOnce);

    const parsed = parseKrakenOhlc(kraken([...daily, { t: NOW, o: 1, h: 1, l: 1, c: 1, v: 1 }]), 1440, NOW);
    assert.equal(parsed.length, daily.length);
    const binance = parseBinanceKlines(daily.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]), 1440, NOW);
    assert.equal(binance.length, daily.length);
  });

  test('sales counter uses a template for each new route and leaves the $0.01 route alone', () => {
    for (const [path, route] of [
      ['/api/verdict-deep/base/' + ADDR, 'GET /api/verdict-deep/:chain/:address'],
      ['/api/honeypot-deep/base/' + ADDR, 'GET /api/honeypot-deep/:chain/:address'],
      ['/api/token-brief/base/' + ADDR, 'GET /api/token-brief/:chain/:address'],
      ['/api/signals/crypto-bottom', 'GET /api/signals/crypto-bottom']
    ]) {
      const paid = classifySale({ method: 'GET', path, statusCode: 200, access: 'x402' });
      const quote = classifySale({ method: 'GET', path, statusCode: 402 });
      assert.equal(paid.route, route);
      assert.equal(paid.surface, 'x402');
      assert.equal(paid.event, 'paid');
      assert.equal(quote.route, route);
      assert.equal(quote.event, 'quotes');
    }
    const old = classifySale({ method: 'GET', path: '/api/verdict/base/' + ADDR, statusCode: 402 });
    assert.equal(old.route, 'GET /api/verdict/:chain/:address');
    const alias = classifySale({ method: 'GET', path: '/api/honeypot/base/' + ADDR, statusCode: 402 });
    assert.equal(alias.route, 'GET /api/honeypot/:chain/:address');
  });

  test('402 challenges, catalog order, pay page, and discovery list the three products', async (t) => {
    const port = 48000 + Math.floor(Math.random() * 1000);
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const srv = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    srv.stderr.on('data', d => { err += d; });
    t.after(() => srv.kill());
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('server did not start ' + err.slice(0, 400))), 20000);
      srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
    });
    const base = `http://127.0.0.1:${port}`;
    const challenge = async (urlPath) => {
      const r = await fetch(base + urlPath);
      assert.equal(r.status, 402, urlPath);
      return JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString('utf8'));
    };
    const old = await challenge('/api/verdict/base/' + ADDR);
    assert.equal(old.accepts[0].amount, '10000');
    const deep = await challenge('/api/verdict-deep/base/' + ADDR);
    const alias = await challenge('/api/honeypot-deep/base/' + ADDR);
    const brief = await challenge('/api/token-brief/base/' + ADDR);
    const bottom = await challenge('/api/signals/crypto-bottom');
    assert.equal(deep.accepts[0].amount, '50000');
    assert.equal(alias.accepts[0].amount, '50000');
    assert.equal(brief.accepts[0].amount, '20000');
    assert.equal(bottom.accepts[0].amount, '10000');
    assert.equal(deep.resource.serviceName, DEEP_SERVICE_NAME);
    assert.equal(alias.resource.url, 'https://micro-saas-agent.onrender.com/api/honeypot-deep/base/' + ADDR);
    assert.equal(alias.extensions.bazaar.routeTemplate, '/api/honeypot-deep/:chain/:address');
    assert.equal(deep.extensions.bazaar.info.input.queryParams.fresh, '0');
    assert.equal(deep.extensions.bazaar.info.output.example.verdict, 'CLEAR');
    assert.equal(deep.extensions.bazaar.info.output.example.deep.holderConcentration.top10Pct, 12.5);
    assert.ok(deep.extensions.bazaar.schema.properties.output.properties.example.properties.verdict.enum.includes('UNKNOWN'));
    assert.equal(brief.extensions.bazaar.info.output.example.marketSnapshot.priceUsd, 1);
    assert.equal(bottom.extensions.bazaar.info.output.example.coins[0].tier, 'NONE');
    for (const phrase of ['deep honeypot check', 'rug pull', 'token safety', 'holder concentration', 'liquidity lock', 'scam token'])
      assert.match(deep.resource.description, new RegExp(phrase, 'i'));
    for (const phrase of ['token safety plus price', 'token brief', 'trade check'])
      assert.match(brief.resource.description, new RegExp(phrase, 'i'));
    assert.match(bottom.resource.description, /research data, not financial advice/i);
    assert.ok(deep.resource.description.length <= MAX_RESOURCE_DESCRIPTION);

    const doc = await (await fetch(base + '/openapi.json')).json();
    const paid = [];
    for (const [p, ops] of Object.entries(doc.paths)) for (const op of Object.values(ops)) {
      if (op['x-payment-info']) paid.push({ path: p, price: op['x-payment-info'].price.amount });
    }
    assert.equal(paid[0].path, '/api/verdict/{chain}/{address}');
    assert.equal(paid[1].path, '/api/honeypot/{chain}/{address}');
    assert.equal(paid[2].path, '/api/verdict-deep/{chain}/{address}');
    assert.equal(paid[3].path, '/api/honeypot-deep/{chain}/{address}');
    assert.equal(paid[4].path, '/api/token-brief/{chain}/{address}');
    assert.equal(paid[5].path, '/api/signals/crypto-bottom');
    assert.equal(paid[0].price, '0.01');
    assert.equal(paid[2].price, '0.05');
    assert.equal(paid[4].price, '0.02');
    assert.equal(paid[5].price, '0.01');
    assert.equal(doc.paths['/api/verdict/{chain}/{address}'].get['x-payment-info'].price.amount, '0.01');

    const disc = await (await fetch(base + '/.well-known/x402')).json();
    assert.equal(disc.endpoints[0].path, '/api/verdict/{chain}/{address}');
    assert.equal(disc.endpoints[2].priceUsd, '0.05');
    assert.equal(disc.deepToken.priceUsd, '0.05');
    assert.equal(disc.tokenBrief.priceUsd, '0.02');
    assert.equal(disc.cryptoBottom.priceUsd, '0.01');
    assert.deepEqual(disc.cryptoBottom.tiers, ['NONE', 'EARLY_TELL', 'CONFIRMED']);
    const card = await (await fetch(base + '/.well-known/agent.json')).json();
    assert.equal(card.skills[0].name, 'Token safety screen');
    assert.equal(card.skills[2].name, 'Deep honeypot check');
    assert.equal(card.skills[4].name, 'Token brief');
    assert.equal(card.skills[5].name, 'Crypto bottom watch');
    const llms = await (await fetch(base + '/llms.txt')).text();
    const agents = await (await fetch(base + '/agents.md')).text();
    const pay = await (await fetch(base + '/pay.html')).text();
    for (const text of [llms, agents, pay]) {
      assert.match(text, /\/api\/verdict-deep\/\{chain\}\/\{address\}|\/api\/verdict-deep\/base\//);
      assert.match(text, /\/api\/honeypot-deep\/\{chain\}\/\{address\}|\/api\/honeypot-deep\/base\//);
      assert.match(text, /\/api\/token-brief\/\{chain\}\/\{address\}|\/api\/token-brief\/base\//);
      assert.match(text, /\/api\/signals\/crypto-bottom/);
    }
    assert.match(llms, /\$0\.05 \|/);
    assert.match(agents, /\$0\.02 \|/);
    assert.match(pay, /verdict-deep deep honeypot check — \$0\.05/);
    assert.ok(llms.indexOf('/api/verdict/{chain}/{address}') < llms.indexOf('/api/verdict-deep/{chain}/{address}'));
  });
});
