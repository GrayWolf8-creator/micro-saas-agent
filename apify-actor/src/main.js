// GW8 Signal API Actor: fetches signal-only data from the GW8 API's card-paid channel and pushes one dataset item
// per successful call. Pay-per-event: each success is charged as one event (see EVENTS); failures are pushed as
// uncharged error items (no charge on failure). Signal only, not financial advice. No trading, no wallets.
// The partner key comes from the GW8_PARTNER_KEY secret environment variable (set by the owner in Apify Console).
import { Actor, log } from 'apify';

const BASE = process.env.GW8_API_BASE || 'https://micro-saas-agent.onrender.com/mkt/apify';
const EVENTS = {
  coin: 'lite-result', regime: 'standard-result', dots: 'standard-result', verdict: 'standard-result', govcontracts: 'standard-result',
  brief: 'premium-result', flows: 'premium-result', rwa: 'premium-result', 'kraken-listings': 'premium-result', rules: 'premium-result',
  history: 'history-result',
  value: 'value-standard', 'value-batch': 'value-premium', 'value-history': 'value-history',
  'growth-chain': 'growth-standard', growth: 'growth-premium', 'growth-history': 'growth-history'
};
const MAX_SYMBOLS = 10;

function paths(input) {
  const e = input.endpoint;
  const qs = o => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v)); const s = p.toString(); return s ? `?${s}` : ''; };
  const syms = (input.symbols && input.symbols.length ? input.symbols : ['BTC']).slice(0, MAX_SYMBOLS).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  switch (e) {
    case 'flows': case 'coin': return syms.map(s => ({ symbol: s, path: `/${e}/${encodeURIComponent(s)}` }));
    case 'govcontracts': return [{ path: `/govcontracts${qs({ ticker: input.ticker, sector: input.sector, q: input.q })}` }];
    case 'verdict':
      if (!input.address) throw new Error('verdict needs a token address');
      return [{ path: `/verdict/${encodeURIComponent(input.chain || 'base')}/${encodeURIComponent(input.address)}` }];
    case 'history': return [{ path: `/history${qs({ pair: input.pair })}` }];
    case 'kraken-listings': return [{ path: '/kraken/listings' }];
    case 'brief': case 'regime': case 'dots': case 'rwa': case 'rules': return [{ path: `/${e}` }];
    case 'value': {
      const vs = (input.symbols && input.symbols.length ? input.symbols : ['BNB']).slice(0, 25).map(s => String(s).trim().toUpperCase()).filter(Boolean);
      return vs.map(s => ({ symbol: s, path: `/value/${encodeURIComponent(s)}` }));
    }
    case 'value-batch': return [{ path: `/value${qs({ symbols: (input.symbols || []).join(','), sort: input.sort, minScore: input.minScore })}` }];
    case 'value-history': {
      const s = String((input.symbols && input.symbols[0]) || 'BNB').trim().toUpperCase();
      return [{ symbol: s, path: `/value/${encodeURIComponent(s)}/history${qs({ weeks: input.weeks })}` }];
    }
    case 'growth-chain': return [{ path: `/growth/${encodeURIComponent(input.growthChain || 'solana')}` }];
    case 'growth': return [{ path: `/growth${qs({ kind: input.kind, minRulesPassed: input.minRulesPassed, triggerOnly: input.triggerOnly, minTvlUsd: input.minTvlUsd, window: input.window })}` }];
    case 'growth-history': return [{ path: `/growth/history${qs({ weeks: input.weeks, kind: input.kind, minRulesPassed: input.minRulesPassed, triggerOnly: input.triggerOnly, minTvlUsd: input.minTvlUsd, window: input.window })}` }];
    default: throw new Error(`unknown endpoint: ${e}`);
  }
}

async function fetchOne(path, key) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 110000); // cold-start brief can take ~40s+
  try {
    const r = await fetch(BASE + path, { headers: { 'X-GW8-Partner-Key': key, 'User-Agent': 'gw8-apify-actor/0.1' }, signal: ctl.signal });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: { error: e.name === 'AbortError' ? 'timeout' : 'network error' } }; }
  finally { clearTimeout(t); }
}

await Actor.init();
const input = (await Actor.getInput()) || {};
const key = process.env.GW8_PARTNER_KEY;
if (!key) { await Actor.fail('Actor is not configured (owner must set GW8_PARTNER_KEY). You were not charged.'); }
let jobs;
try { jobs = paths(input); } catch (e) { await Actor.fail(`${e.message}. You were not charged.`); }
const eventName = EVENTS[input.endpoint];
for (const j of jobs) {
  let r = await fetchOne(j.path, key);
  if (r.status === 503 || r.status === 0) { await new Promise(s => setTimeout(s, 5000)); r = await fetchOne(j.path, key); } // one retry
  const base = { endpoint: input.endpoint, symbol: j.symbol || null, fetchedAt: new Date().toISOString() };
  if (r.status === 200 && r.body && r.body.status === 'success') {
    const res = await Actor.pushData({ ...base, ok: true, data: r.body.signal, disclaimer: r.body.disclaimer }, eventName);
    if (res && res.eventChargeLimitReached) { log.info('Spending limit reached, stopping.'); break; }
  } else {
    await Actor.pushData({ ...base, ok: false, error: (r.body && r.body.error) || `HTTP ${r.status}`, note: 'not charged' });
  }
}
await Actor.exit();
