// sample.js — free, truncated samples for the most-quoted paid routes.
// Per-IP daily cap stores a short hash only (sha256 of a prefix + the address). No raw IP is kept or logged.
import crypto from 'crypto';
import { fetchOHLC, PAIRS_MAP } from './Signal.js';
import { getVerdict, validVerdictInput } from './upgrades.js';
import { getRails, validAmount } from './rails.js';

export const SAMPLE_CAP_DEFAULT = 20;
export const SAMPLE_DISCLAIMER = 'Free truncated sample of public data. Not investment advice; no trade recommendation.';
const PRICE = {
  'GET /api/verdict/:chain/:address': '0.01',
  'GET /api/coin/:symbol': '0.002',
  'GET /api/rails': '0.002',
  'GET /api/regime': '0.01',
  'GET /api/dots': '0.01',
  'POST /api/agent': '0.02',
  'GET /api/brief': '0.02',
  'GET /api/history': '0.05',
  'GET /api/flows/:symbol': '0.02',
  'GET /api/rwa': '0.02',
  'GET /api/govcontracts': '0.01',
  'GET /api/kraken/listings': '0.02',
  'GET /api/rules': '0.02',
  'GET /api/rs': '0.02',
  'GET /api/value': '0.03',
  'GET /api/value/:symbol': '0.015',
  'GET /api/value/:symbol/history': '0.07',
  'GET /api/growth': '0.03',
  'GET /api/growth/:chain': '0.015',
  'GET /api/growth/history': '0.07'
};
const PAID = new Set(Object.keys(PRICE));
export const SAMPLE_FALLBACK = [
  { route: 'GET /api/verdict/:chain/:address', quotes: 0, kind: 'verdict', priceUsd: '0.01' },
  { route: 'GET /api/coin/:symbol', quotes: 0, kind: 'coin', priceUsd: '0.002' },
  { route: 'GET /api/rails', quotes: 0, kind: 'rails', priceUsd: '0.002' }
];

function kindOf(route) {
  if (route === 'GET /api/verdict/:chain/:address') return 'verdict';
  if (route === 'GET /api/coin/:symbol') return 'coin';
  if (route === 'GET /api/rails') return 'rails';
  return 'generic';
}

/** Rank paid routes by quote count. With no quotes, use verdict, coin and rails. */
export function topQuotedPaid(routes = []) {
  const ranked = (routes || [])
    .filter(r => r && PAID.has(r.route) && Number(r.quotes) > 0)
    .sort((a, b) => b.quotes - a.quotes || String(a.route).localeCompare(String(b.route)));
  if (ranked.length >= 3) {
    return ranked.slice(0, 3).map(r => ({ route: r.route, quotes: r.quotes, kind: kindOf(r.route), priceUsd: PRICE[r.route] }));
  }
  return SAMPLE_FALLBACK.map(r => ({ ...r }));
}

export function isSampleQuery(q) {
  const s = q && q.sample;
  return s === '1' || s === 'true' || s === 1 || s === true;
}
export function sampleCap() {
  const n = Number(process.env.GW8_SAMPLE_DAILY_CAP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : SAMPLE_CAP_DEFAULT;
}
export function hashIp(ip) {
  return crypto.createHash('sha256').update('gw8-ip:' + String(ip || '')).digest('hex').slice(0, 16);
}
export function requestIp(req) {
  const x = req && req.headers && req.headers['x-forwarded-for'];
  const raw = (typeof x === 'string' && x.split(',')[0].trim()) || (req && req.socket && req.socket.remoteAddress) || (req && req.ip) || '';
  return hashIp(raw);
}
export function utcDay(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

const hits = new Map();
function keyOf(hash, now) { return `${hash}|${utcDay(now)}`; }
export function takeSample(hash, now = Date.now()) {
  const key = keyOf(hash, now);
  const today = utcDay(now);
  if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith('|' + today)) hits.delete(k);
  const cap = sampleCap();
  const n = (hits.get(key) || 0) + 1;
  if (n > cap) return { ok: false, status: 429, remaining: 0, cap };
  hits.set(key, n);
  return { ok: true, remaining: cap - n, cap };
}
export function refundSample(hash, now = Date.now()) {
  const key = keyOf(hash, now);
  const n = hits.get(key) || 0;
  if (n > 0) hits.set(key, n - 1);
}
export function _resetSamples() { hits.clear(); }

export function truncateVerdict(v) {
  return {
    sample: true, truncated: true,
    label: 'Free sample (truncated). Score and verdict only; the paid route adds the reason list and market detail.',
    chain: v.chain, address: v.address, score: v.score, verdict: v.verdict,
    paidRoute: `/api/verdict/${v.chain}/${v.address}`, paidPriceUsd: '0.01',
    disclaimer: v.disclaimer || SAMPLE_DISCLAIMER, sources: v.sources || []
  };
}
export function truncateRails(r) {
  const sources = [...new Set((r.rails || []).map(x => x && x.source).filter(Boolean))].slice(0, 4);
  return {
    sample: true, truncated: true,
    label: 'Free sample (truncated). Recommended rail only; the full fee table is on the paid route.',
    amountUsd: r.amountUsd, recommended: r.recommended,
    paidRoute: '/api/rails', paidPriceUsd: '0.002',
    disclaimer: r.disclaimer || SAMPLE_DISCLAIMER,
    sources: sources.length ? sources : ['https://api.kraken.com/0/public/Ticker']
  };
}
export function coinSampleFromRows(symbol, rows) {
  if (!rows || !rows.length) return { error: 'upstream data unavailable, retry shortly', sourceStatus: { kraken: 'empty series' }, http: 503, sample: true, disclaimer: SAMPLE_DISCLAIMER, sources: ['https://api.kraken.com/0/public/OHLC'] };
  const last = rows[rows.length - 1];
  return {
    sample: true, truncated: true, delayed: true,
    label: 'Free sample (truncated and delayed). Daily close only; the paid route adds WaveTrend 4h values and band dots.',
    symbol, close: Number(last[4]), bar: new Date(Number(last[0]) * 1000).toISOString(),
    paidRoute: `/api/coin/${symbol}`, paidPriceUsd: '0.002',
    disclaimer: SAMPLE_DISCLAIMER, sources: ['https://api.kraken.com/0/public/OHLC']
  };
}
export async function coinSample(symbol) {
  const pair = PAIRS_MAP[String(symbol || '').toUpperCase()];
  if (!pair) return { error: 'unknown symbol', http: 404 };
  try { return coinSampleFromRows(symbol, await fetchOHLC(pair, 1440)); }
  catch (e) { return { error: 'upstream data unavailable, retry shortly', sourceStatus: { kraken: 'unavailable' }, http: 503, sample: true, disclaimer: SAMPLE_DISCLAIMER, sources: ['https://api.kraken.com/0/public/OHLC'] }; }
}

function genericSample(route) {
  const path = route.replace(/^GET /, '').replace(/^POST /, '');
  return {
    sample: true, truncated: true, delayed: true,
    label: 'Free sample (delayed pointer). This preview does not include the paid payload.',
    paidRoute: path, paidPriceUsd: PRICE[route] || null,
    disclaimer: SAMPLE_DISCLAIMER, sources: ['https://micro-saas-agent.onrender.com/llms.txt']
  };
}

/** Route params are empty in middleware that runs before the matched route, so read the path too. */
function pathBits(req) {
  const p = String((req && (req.path || req.url)) || '').split('?')[0];
  const coin = p.match(/^\/api\/coin\/([^/]+)/i);
  const verdict = p.match(/^\/api\/verdict\/([^/]+)\/([^/]+)/i);
  const params = (req && req.params) || {};
  return {
    symbol: String(params.symbol || (coin && decodeURIComponent(coin[1])) || '').toUpperCase(),
    chain: String(params.chain || (verdict && decodeURIComponent(verdict[1])) || '').toLowerCase(),
    address: String(params.address || (verdict && decodeURIComponent(verdict[2])) || '')
  };
}

/** Validate before the daily cap is consumed. */
export function precheckSample(route, req) {
  const bits = pathBits(req);
  if (route === 'GET /api/coin/:symbol') {
    if (!PAIRS_MAP[bits.symbol]) return { error: 'unknown symbol', http: 404 };
  } else if (route === 'GET /api/verdict/:chain/:address') {
    const bad = validVerdictInput(bits.chain, bits.address);
    if (bad) return { error: bad, http: 400 };
  } else if (route === 'GET /api/rails') {
    const v = validAmount(req.query && req.query.amount);
    if (v.error) return { error: v.error, http: 400 };
  }
  return null;
}

export async function buildRouteSample(route, req) {
  const bits = pathBits(req);
  if (route === 'GET /api/coin/:symbol') return coinSample(bits.symbol);
  if (route === 'GET /api/verdict/:chain/:address') {
    const chain = bits.chain, address = bits.address;
    try {
      const v = await getVerdict(chain, address);
      if (!v || v.error) return { error: (v && v.error) || 'upstream data unavailable, retry shortly', sourceStatus: (v && v.sourceStatus) || { verdict: 'unavailable' }, http: 503, sample: true, disclaimer: SAMPLE_DISCLAIMER, sources: [] };
      return truncateVerdict(v);
    } catch { return { error: 'upstream data unavailable, retry shortly', sourceStatus: { verdict: 'unavailable' }, http: 503, sample: true, disclaimer: SAMPLE_DISCLAIMER, sources: [] }; }
  }
  if (route === 'GET /api/rails') {
    const v = validAmount(req.query && req.query.amount);
    try {
      const r = await getRails(v.amount);
      if (!r || r.error) return { error: (r && r.error) || 'upstream data unavailable, retry shortly', sourceStatus: (r && r.sourceStatus) || { rails: 'unavailable' }, http: 503, sample: true, disclaimer: SAMPLE_DISCLAIMER, sources: ['https://api.kraken.com/0/public/Ticker'] };
      return truncateRails(r);
    } catch { return { error: 'upstream data unavailable, retry shortly', sourceStatus: { rails: 'unavailable' }, http: 503, sample: true, disclaimer: SAMPLE_DISCLAIMER, sources: ['https://api.kraken.com/0/public/Ticker'] }; }
  }
  return genericSample(route);
}
