// signal.js — WaveTrend (LazyBear 10/21/4, Kraken 4h) + Stage 1 regime check.
// ESM, zero dependencies, Node 18+ (global fetch). Public data only: no keys, no trading.
const PAIRS = {"BTC": "XBTUSD", "ETH": "ETHUSD", "LINK": "LINKUSD", "BCH": "BCHUSD", "DOGE": "XDGUSD", "SHIB": "SHIBUSD", "ARB": "ARBUSD", "BONK": "BONKUSD", "AAVE": "AAVEUSD", "AVAX": "AVAXUSD", "BNB": "BNBUSD", "CRV": "CRVUSD", "DOT": "DOTUSD", "FIL": "FILUSD", "GRASS": "GRASSUSD", "ADA": "ADAUSD", "HBAR": "HBARUSD", "INJ": "INJUSD", "KAITO": "KAITOUSD", "LDO": "LDOUSD", "LTC": "LTCUSD", "MOODENG": "MOODENGUSD", "NEAR": "NEARUSD", "PNUT": "PNUTUSD", "SOL": "SOLUSD", "S": "SUSD", "TRUMP": "TRUMPUSD", "UNI": "UNIUSD", "WLD": "WLDUSD", "XRP": "XRPUSD", "ALGO": "ALGOUSD", "APT": "APTUSD", "ATOM": "ATOMUSD", "ETC": "ETCUSD", "JTO": "JTOUSD", "JUP": "JUPUSD", "ONDO": "ONDOUSD", "OP": "OPUSD", "POL": "POLUSD", "POPCAT": "POPCATUSD", "RENDER": "RENDERUSD", "STX": "STXUSD", "SUI": "SUIUSD", "TAO": "TAOUSD", "TIA": "TIAUSD", "TRX": "TRXUSD", "WIF": "WIFUSD", "AIXBT": "AIXBTUSD", "ASTER": "ASTERUSD", "FARTCOIN": "FARTCOINUSD", "FLOKI": "FLOKIUSD", "HYPE": "HYPEUSD", "PENGU": "PENGUUSD", "PUMP": "PUMPUSD", "VIRTUAL": "VIRTUALUSD", "XPL": "XPLUSD", "ZEC": "ZECUSD", "PEPE": "PEPEUSD", "ENA": "ENAUSD", "MON": "MONUSD", "ZRO": "ZROUSD", "XLM": "XLMUSD", "ETHFI": "ETHFIUSD", "ICP": "ICPUSD", "PENDLE": "PENDLEUSD", "LIGHTER": "LIGHTERUSD"};
const CORE = ['BTC', 'ETH', 'SOL', 'LINK', 'XRP'];
const CACHE_MS = 10 * 60 * 1000;
const THROTTLE_MS = 1100;
let cache = null, inflight = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ema(x, n) { const a = 2 / (n + 1), o = [x[0]]; for (let i = 1; i < x.length; i++) o.push(a * x[i] + (1 - a) * o[i - 1]); return o; }
async function fetchOHLC(pair, interval) {
  const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.error && j.error.length) throw new Error(j.error.join(','));
  const k = Object.keys(j.result).find(k => k !== 'last');
  const secs = interval * 60, now = Date.now() / 1000;
  return j.result[k].filter(x => +x[0] + secs <= now); // closed candles only
}
function compute(name, rows) {
  const ts = rows.map(x => +x[0]), h = rows.map(x => +x[2]), l = rows.map(x => +x[3]), c = rows.map(x => +x[4]);
  const ap = h.map((v, i) => (v + l[i] + c[i]) / 3);
  const esa = ema(ap, 10), d = ema(ap.map((v, i) => Math.abs(v - esa[i])), 10);
  const ci = ap.map((v, i) => d[i] ? (v - esa[i]) / (0.015 * d[i]) : 0);
  const wt1 = ema(ci, 21), wt2 = wt1.map((_, i) => i < 3 ? null : (wt1[i] + wt1[i-1] + wt1[i-2] + wt1[i-3]) / 4);
  const n = wt1.length, dots = [], r2 = v => Math.round(v * 100) / 100;
  for (let i = n - 6; i < n; i++) {
    const up = wt1[i-1] <= wt2[i-1] && wt1[i] > wt2[i], dn = wt1[i-1] >= wt2[i-1] && wt1[i] < wt2[i];
    const base = { name, bar: new Date(ts[i] * 1000).toISOString(), wt1: r2(wt1[i]), close: c[i], latest: i === n - 1 };
    if (up && wt1[i] <= -53) dots.push({ ...base, kind: 'green', band: wt1[i] <= -60 ? 'outer' : 'inner' });
    if (dn && wt1[i] >= 53) dots.push({ ...base, kind: 'red', band: wt1[i] >= 60 ? 'outer' : 'inner' });
  }
  const hist = [], cutoff = ts[n-1] - 90 * 86400, fw = k => (i, sgn) => i + k < n ? r2((c[i+k] / c[i] - 1) * 100) : null;
  const H = [[1, 'fwd4hPct'], [6, 'fwd24hPct'], [18, 'fwd3dPct']];
  for (let i = 4; i < n; i++) {
    if (ts[i] < cutoff) continue;
    const up = wt1[i-1] <= wt2[i-1] && wt1[i] > wt2[i], dn = wt1[i-1] >= wt2[i-1] && wt1[i] < wt2[i];
    let kind = null, band = null;
    if (up && wt1[i] <= -53) { kind = 'green'; band = wt1[i] <= -60 ? 'outer' : 'inner'; }
    if (dn && wt1[i] >= 53) { kind = 'red'; band = wt1[i] >= 60 ? 'outer' : 'inner'; }
    if (!kind) continue;
    const e = { pair: name + '/USD', kind, band, bar: new Date(ts[i] * 1000).toISOString(), wt1: r2(wt1[i]), wt2: r2(wt2[i]), close: c[i] };
    for (const [k, key] of H) e[key] = fw(k)(i);
    hist.push(e);
  }
  return { history: hist, name, barOpen: new Date(ts[n-1] * 1000).toISOString(), close: c[n-1], wt1: r2(wt1[n-1]), wt2: r2(wt2[n-1]), prevWt1: r2(wt1[n-2]), prevWt2: r2(wt2[n-2]), dots };
}
async function run() {
  const core = [], others = [], bandDots = [], history = [];
  for (const [name, pair] of Object.entries(PAIRS)) {
    let rec;
    try { rec = compute(name, await fetchOHLC(pair, 240)); bandDots.push(...rec.dots); history.push(...rec.history); delete rec.history; }
    catch (e) { rec = { name, error: String(e.message || e) }; }
    (CORE.includes(name) ? core : others).push(rec);
    await sleep(THROTTLE_MS);
  }
  return { asOf: new Date().toISOString(), core, others, bandDots, history };
}
async function getWaveTrend() {
  if (cache && Date.now() - cache.t < CACHE_MS) return cache.data;
  if (!inflight) inflight = run().then(d => { cache = { t: Date.now(), data: d }; return d; }).finally(() => { inflight = null; });
  return cache ? cache.data : inflight; // serve stale while refreshing
}

// ---------- Stage 1 regime check: 4 checks, public data only. Unknown is never faked. ----------
let s1cache = null;
const pct = (a, b) => (a / b - 1) * 100;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };

// (a) BTC spot ETF flows: sum of last 3 daily "Total" values on Farside must be > 0.
async function etfFlows() {
  try {
    const r = await fetch('https://farside.co.uk/btc/', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text(), rows = [];
    for (const tr of html.split(/<tr/i).slice(1)) {
      const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      if (cells.length > 3 && /^\d{1,2} \w{3} \d{4}$/.test(cells[0])) {
        const t = cells[cells.length - 1].replace(/,/g, ''), neg = /^\(.*\)$/.test(t), v = parseFloat(t.replace(/[()]/g, ''));
        if (!isNaN(v)) rows.push({ date: cells[0], totalMusd: neg ? -v : v });
      }
    }
    if (rows.length < 3) throw new Error('table not parsed');
    const last3 = rows.slice(-3), sum = last3.reduce((s, x) => s + x.totalMusd, 0);
    return { status: sum > 0 ? 'pass' : 'fail', detail: { last3, sum3Musd: Math.round(sum * 10) / 10 }, rule: '3-day net BTC ETF flow > 0 (Farside)' };
  } catch (e) { return { status: 'unknown', detail: String(e.message || e), rule: '3-day net BTC ETF flow > 0 (Farside)' }; }
}

// (b) BTC quiet support: last close within 5% above 20-day low, and last 3 daily ranges avg < 4%.
function btcQuiet(d) {
  const c = d.map(x => +x[4]), h = d.map(x => +x[2]), l = d.map(x => +x[3]), n = c.length;
  const low20 = Math.min(...l.slice(-20)), above = pct(c[n-1], low20);
  const rng = [1, 2, 3].map(k => (h[n-k] - l[n-k]) / c[n-k] * 100), avg = rng.reduce((a, b) => a + b) / 3;
  const ok = above <= 5 && avg < 4 && c[n-1] >= low20;
  return { status: ok ? 'pass' : 'fail', detail: { close: c[n-1], low20d: low20, pctAboveLow: +above.toFixed(2), avgRange3dPct: +avg.toFixed(2) },
    rule: 'BTC daily close within 5% of 20-day low (holding it) and 3-day avg range < 4%' };
}

// (c) Alts not in freefall: median 1d change of ETH/SOL/LINK/XRP > -4% and median 3d > -8%.
function altsOk(map) {
  const d1 = [], d3 = [];
  for (const rows of Object.values(map)) { const c = rows.map(x => +x[4]), n = c.length; d1.push(pct(c[n-1], c[n-2])); d3.push(pct(c[n-1], c[n-4])); }
  const m1 = median(d1), m3 = median(d3);
  return { status: m1 > -4 && m3 > -8 ? 'pass' : 'fail', detail: { median1dPct: +m1.toFixed(2), median3dPct: +m3.toFixed(2) },
    rule: 'median daily change of ETH/SOL/LINK/XRP > -4% (1d) and > -8% (3d)' };
}

// (d) No greed chase: Fear & Greed < 60, and not a weekend pump (Sat/Sun UTC with BTC 1d > +3%).
async function noGreed(btcDaily) {
  const rule = 'Fear & Greed < 60 and not a weekend pump (Sat/Sun UTC with BTC +3% on the day)';
  try {
    const j = await (await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(15000) })).json();
    const v = +j.data[0].value, c = btcDaily.map(x => +x[4]), n = c.length, ch = pct(c[n-1], c[n-2]);
    const wkd = [0, 6].includes(new Date().getUTCDay()), pump = wkd && ch > 3;
    return { status: v < 60 && !pump ? 'pass' : 'fail', detail: { fearGreed: v, label: j.data[0].value_classification, weekend: wkd, btc1dPct: +ch.toFixed(2) }, rule };
  } catch (e) { return { status: 'unknown', detail: String(e.message || e), rule }; }
}

async function runStage1() {
  const btc = await fetchOHLC('XBTUSD', 1440), alts = {};
  for (const [n, p] of [['ETH','ETHUSD'],['SOL','SOLUSD'],['LINK','LINKUSD'],['XRP','XRPUSD']]) { await new Promise(r => setTimeout(r, 1100)); alts[n] = await fetchOHLC(p, 1440); }
  const checks = { etfInflows: await etfFlows(), btcQuietSupport: btcQuiet(btc), altsNotFreefall: altsOk(alts), noGreedChase: await noGreed(btc) };
  const score = Object.values(checks).filter(c => c.status === 'pass').length;
  return { asOf: new Date().toISOString(), score, outOf: 4, checks };
}
async function getStage1() {
  if (s1cache && Date.now() - s1cache.t < CACHE_MS) return s1cache.data;
  const data = await runStage1(); s1cache = { t: Date.now(), data }; return data;
}

// ---------- Public API ----------
export const COINS = Object.keys(PAIRS);
export const PAIRS_MAP = PAIRS;
function hitRates(h) {
  const out = {};
  for (const kind of ['green', 'red']) for (const band of ['inner', 'outer', 'all']) {
    const s = h.filter(x => x.kind === kind && (band === 'all' || x.band === band)), r = {};
    for (const key of ['fwd4hPct', 'fwd24hPct', 'fwd3dPct']) {
      const v = s.map(x => x[key]).filter(x => x !== null);
      const hits = v.filter(x => kind === 'green' ? x > 0 : x < 0).length;
      r[key] = v.length ? { n: v.length, hitRatePct: Math.round(hits / v.length * 1000) / 10, avgMovePct: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100 } : { n: 0 };
    }
    out[`${kind}_${band}`] = r;
  }
  return out;
}
export async function getHistory(pair) {
  try {
    const wt = await getWaveTrend();
    let h = wt.history || [];
    if (pair) h = h.filter(x => x.pair === pair.toUpperCase() + '/USD' || x.pair === pair.toUpperCase());
    h = [...h].sort((a, b) => b.bar.localeCompare(a.bar));
    return { asOf: wt.asOf, window: '90 days, Kraken 4h closed candles', hitDefinition: 'green = price higher after N, red = price lower after N', summary: hitRates(h), count: h.length, dots: h, disclaimer: 'signal only, past performance is not indicative of future results, not financial advice' };
  } catch (e) { return { error: 'upstream data unavailable, retry shortly' }; }
}
export async function getRegime() {
  try { const s = await getStage1(); return { ...s, disclaimer: 'signal only, not financial advice' }; }
  catch (e) { return { error: 'upstream data unavailable, retry shortly' }; }
}
export async function getDots() {
  try { const wt = await getWaveTrend(); return { asOf: wt.asOf, bandDots: wt.bandDots, disclaimer: 'signal only, not financial advice' }; }
  catch (e) { return { error: 'upstream data unavailable, retry shortly' }; }
}
export async function getCoin(sym) {
  try { const wt = await getWaveTrend(); const r = [...wt.core, ...wt.others].find(x => x.name === sym); return { asOf: wt.asOf, ...r, disclaimer: 'signal only, not financial advice' }; }
  catch (e) { return { error: 'upstream data unavailable, retry shortly' }; }
}
const DISCLAIMER = 'signal only, not financial advice';

export async function buildSignal() {
  const [stage1, wt] = await Promise.all([getStage1(), getWaveTrend()]);
  return { timestamp: new Date().toISOString(), stage1: { score: stage1.score, outOf: 4, checks: stage1.checks },
    wavetrend: { settings: 'LazyBear 10/21/4, Kraken 4h, green<=-53 (outer<=-60), red>=+53 (outer>=+60)', asOf: wt.asOf, core: wt.core, bandDots: wt.bandDots, universe: wt.core.length + wt.others.length },
    disclaimer: DISCLAIMER };
}

// Free teaser: Stage 1 statuses, core WaveTrend values, band-dot count (no names).
export async function buildSample() {
  const s = await buildSignal();
  return { timestamp: s.timestamp, sample: true,
    stage1: { score: s.stage1.score, outOf: 4, checks: Object.fromEntries(Object.entries(s.stage1.checks).map(([k, v]) => [k, v.status])) },
    wavetrend: { core: s.wavetrend.core.map(c => ({ name: c.name, wt1: c.wt1, wt2: c.wt2 })), bandDotCount: s.wavetrend.bandDots.length, bandDots: 'paid: POST /api/agent ($0.02 USDC on Base via x402)' },
    disclaimer: DISCLAIMER };
}

// Never throws (used after a payment has settled).
export async function safeSignal() {
  try { return await buildSignal(); }
  catch (e) { return { error: 'upstream data unavailable, retry shortly', timestamp: new Date().toISOString() }; }
}

// Warm the cache at startup so the first buyer doesn't wait ~80s.
buildSignal().catch(() => {});
