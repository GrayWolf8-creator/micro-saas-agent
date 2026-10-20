// rs.js — relative strength ranks + sector scores for the 66-pair Kraken universe (Signal.js PAIRS).
// Our own math on Kraken PUBLIC daily OHLC only (no keys, no trading). Missing history stays null, never faked.
import { fetchOHLC, PAIRS_MAP } from './Signal.js';

const DISCLAIMER = 'signal only, not financial advice';
const CACHE_MS = 30 * 60e3, THROTTLE_MS = 1100, W1 = 7, M1 = 30, WEIGHT_1M = 0.6, WEIGHT_1W = 0.4;
// One sector per coin (our own judgement call; see notes in the response).
export const SECTORS = {
  'l1': ['BTC', 'ETH', 'SOL', 'ADA', 'AVAX', 'BNB', 'DOT', 'NEAR', 'S', 'ALGO', 'APT', 'ATOM', 'ETC', 'SUI', 'TRX', 'ICP', 'MON'],
  'l2': ['ARB', 'OP', 'POL', 'STX'],
  'defi': ['AAVE', 'CRV', 'UNI', 'LDO', 'JTO', 'JUP', 'ENA', 'PENDLE', 'ETHFI', 'INJ', 'HYPE', 'ASTER', 'LIGHTER'],
  'rwa': ['ONDO', 'LINK', 'HBAR'],
  'oracles-infra': ['FIL', 'ZRO', 'TIA'],
  'payments': ['XRP', 'XLM', 'LTC', 'BCH', 'XPL', 'ZEC'],
  'ai': ['TAO', 'RENDER', 'WLD', 'GRASS', 'KAITO', 'AIXBT', 'VIRTUAL'],
  'memes': ['DOGE', 'SHIB', 'BONK', 'MOODENG', 'PNUT', 'TRUMP', 'POPCAT', 'WIF', 'FARTCOIN', 'FLOKI', 'PENGU', 'PEPE', 'PUMP']
};
export const SECTOR_OF = Object.fromEntries(Object.entries(SECTORS).flatMap(([s, cs]) => cs.map(c => [c, s])));
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cache = null, inflight = null;

// Percentile rank 0-100 (lowest = 0, highest = 100, ties share the average rank).
export function pctRanks(vals) {
  const idx = vals.map((v, i) => [v, i]).filter(([v]) => v != null).sort((a, b) => a[0] - b[0]), out = vals.map(() => null), n = idx.length;
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const rk = n > 1 ? ((i + j) / 2) / (n - 1) * 100 : 50; for (let k = i; k <= j; k++) out[idx[k][1]] = r2(rk); i = j + 1; }
  return out;
}

// daily: { SYM: krakenDailyRows } (closed candles, oldest first). Pure, so it can be tested offline.
export function buildRs(daily, now = Date.now()) {
  const coins = Object.keys(daily), ret = (c, k) => c.length > k ? (c[c.length - 1] / c[c.length - 1 - k] - 1) * 100 : null;
  const base = coins.map(sym => { const rows = daily[sym] || [], c = rows.map(x => +x[4]);
    return { symbol: sym, sector: SECTOR_OF[sym] || 'other', close: c.length ? c[c.length - 1] : null, lastDailyBar: rows.length ? new Date(+rows[rows.length - 1][0] * 1000).toISOString().slice(0, 10) : null, ret1wPct: r2(ret(c, W1)), ret1mPct: r2(ret(c, M1)) }; });
  const rw = pctRanks(base.map(b => b.ret1wPct)), rm = pctRanks(base.map(b => b.ret1mPct));
  const coinsOut = base.map((b, i) => ({ ...b, rank1wPct: rw[i], rank1mPct: rm[i], strength: rw[i] != null && rm[i] != null ? Math.round(WEIGHT_1M * rm[i] + WEIGHT_1W * rw[i]) : null }))
    .sort((a, b) => (b.strength ?? -1) - (a.strength ?? -1));
  const sectors = Object.keys(SECTORS).concat(coinsOut.some(c => c.sector === 'other') ? ['other'] : []).map(s => {
    const all = coinsOut.filter(c => c.sector === s), sc = all.filter(c => c.strength != null), m = all.filter(c => c.ret1mPct != null);
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    return { sector: s, coins: all.length, scored: sc.length, avgStrength: sc.length ? Math.round(avg(sc.map(c => c.strength))) : null, avgRet1mPct: r2(avg(m.map(c => c.ret1mPct))), avgRet1wPct: r2(avg(all.filter(c => c.ret1wPct != null).map(c => c.ret1wPct))),
      breadth1mPct: m.length ? Math.round(m.filter(c => c.ret1mPct > 0).length / m.length * 100) : null, leader: sc[0] ? sc[0].symbol : null, members: all.map(c => c.symbol) };
  }).sort((a, b) => (b.avgStrength ?? -1) - (a.avgStrength ?? -1));
  const scored = coinsOut.filter(c => c.strength != null), m1 = coinsOut.filter(c => c.ret1mPct != null);
  return {
    asOf: new Date(now).toISOString(), universe: coins.length, scored: scored.length,
    method: { returns: `close-to-close on Kraken daily closed candles: 1w = ${W1} bars, 1m = ${M1} bars`, rank: 'percentile across coins with data (0 = weakest, 100 = strongest)', strength: `${WEIGHT_1M * 100}% 1m rank + ${WEIGHT_1W * 100}% 1w rank, 0-100` },
    breadth: { pctPositive1m: m1.length ? Math.round(m1.filter(c => c.ret1mPct > 0).length / m1.length * 100) : null, n: m1.length },
    leaders: scored.slice(0, 10).map(c => c.symbol), laggards: scored.slice(-10).reverse().map(c => c.symbol),
    sectors, coins: coinsOut,
    notes: ['Relative strength is momentum vs the rest of this 66-coin Kraken universe, not a buy/sell call; it is backward-looking.',
      'Sector map is GW8\'s own single-sector assignment; small sectors (e.g. rwa, oracles-infra) are noisy.',
      'Coins with under 31 daily candles get null 1m values and no strength score. Kraken USD pairs only (single venue).', 'Cached 30 minutes. ' + DISCLAIMER + '.'],
    disclaimer: DISCLAIMER
  };
}

async function run() {
  const daily = {}; let fails = 0;
  for (const [sym, pair] of Object.entries(PAIRS_MAP)) {
    try { daily[sym] = await fetchOHLC(pair, 1440); } catch { daily[sym] = []; fails++; }
    await sleep(THROTTLE_MS);
  }
  if (fails > Object.keys(PAIRS_MAP).length / 2) throw new Error('kraken ohlc unavailable');
  return { ...buildRs(daily), sourceStatus: { krakenOhlcDaily: fails ? `partial (${fails} pairs failed)` : 'ok' } };
}
export async function getRs() {
  if (cache && Date.now() - cache.t < CACHE_MS) return { ...cache.data, cached: true };
  if (!inflight) inflight = run().then(d => { cache = { t: Date.now(), data: d }; return d; }).finally(() => { inflight = null; });
  if (cache) { inflight.catch(() => {}); return { ...cache.data, cached: true, stale: true }; } // serve stale while refreshing
  try { return await inflight; } catch { return { error: 'upstream data unavailable, retry shortly' }; }
}
