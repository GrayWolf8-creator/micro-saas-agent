// growth.js — growth-lane screen. Public DefiLlama + Kraken series and hand-curated coverage.
// Data and rule flags only. Missing numbers stay null (confidence low). No secrets.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { weekEndings, valueAt, sumWindow } from './value.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const COV = JSON.parse(readFileSync(path.join(DIR, 'data', 'growth_coverage.json'), 'utf8'));

export const GROWTH_DISCLAIMER = 'On-chain growth data and rule flags. Not investment advice; no trade recommendation.';
export const GROWTH_METHOD = 'Growth Lane Screen rules 1-4; thresholds from ETH 2017/2020 and SOL 2021 backtest (3 cases; a filter, not a forecast).';
export const WINDOW_DAYS = 90;
export const MIN_TVL_DEFAULT = 50_000_000;
export const GROWTH_PRICES = { one: '0.015', list: '0.03', history: '0.07', oneAtomic: '15000', listAtomic: '30000', historyAtomic: '70000' };
export const GROWTH_SOURCES = [
  'https://stablecoins.llama.fi/stablecoincharts/{chain}',
  'https://api.llama.fi/v2/historicalChainTvl/{chain}',
  'https://api.llama.fi/overview/fees/{chain}',
  'https://api.llama.fi/summary/fees/{slug}',
  'https://api.kraken.com/0/public/OHLC',
  'https://coins.llama.fi/chart/'
];
const CACHE_MS = 6 * 60 * 60 * 1000;
const DAY = 86400;
const UA = { accept: 'application/json', 'user-agent': 'GW8-Signal/1.0 (+https://micro-saas-agent.onrender.com)' };
const baseOf = (env, dflt) => (process.env[env] || dflt).replace(/\/$/, '');
const llama = p => `${baseOf('GW8_LLAMA_BASE', 'https://api.llama.fi')}${p}`;
const stablesBase = p => `${baseOf('GW8_STABLES_BASE', 'https://stablecoins.llama.fi')}${p}`;
const coinsBase = () => baseOf('GW8_COINS_BASE', 'https://coins.llama.fi');
const krakenBase = () => baseOf('GW8_KRAKEN_BASE', 'https://api.kraken.com');
const r2 = v => (v == null || !Number.isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

let cache = null, inflight = null;
export function _resetGrowthCache() { cache = null; inflight = null; }

export function coverageRows() { return COV.rows.map(r => ({ ...r })); }
export function findGrowth(id) {
  const s = String(id || '').trim();
  if (!s) return null;
  const slug = s.toLowerCase(), sym = s.toUpperCase();
  return coverageRows().find(r => r.chain === slug || (r.symbol && r.symbol === sym)) || null;
}

export function pctChange(points, end, days) {
  const prev = valueAt(points, end - days * DAY), now = valueAt(points, end);
  if (prev == null || now == null || prev === 0) return null;
  return ((now - prev) / Math.abs(prev)) * 100;
}

function atAth(points, end) {
  const now = valueAt(points, end);
  if (now == null || !points || !points.length) return null;
  let max = -Infinity;
  for (const p of points) if (p.t <= end && p.v > max) max = p.v;
  if (!Number.isFinite(max)) return null;
  return now >= max * 0.999;
}

function nativeSum(fees, price, start, end) {
  if (!fees || !fees.length || !price || !price.length) return null;
  let s = 0, n = 0;
  for (const p of fees) {
    if (p.t <= start || p.t > end) continue;
    const px = valueAt(price, p.t);
    if (px == null || px === 0) continue;
    s += p.v / px; n++;
  }
  return n ? s : null;
}

function mcapFeesTrend(mcapNow, priceNow, price, fees, end) {
  const pxEnd = valueAt(price, end), pxPrev = valueAt(price, end - WINDOW_DAYS * DAY);
  if (!mcapNow || !priceNow || !pxEnd || !pxPrev) return null;
  const supply = mcapNow / priceNow;
  const fEnd = sumWindow(fees, end - WINDOW_DAYS * DAY, end);
  const fPrev = sumWindow(fees, end - 2 * WINDOW_DAYS * DAY, end - WINDOW_DAYS * DAY);
  if (!fEnd || !fPrev) return null;
  const rEnd = (supply * pxEnd) / fEnd, rPrev = (supply * pxPrev) / fPrev;
  if (rEnd < rPrev) return 'falling';
  if (rEnd > rPrev) return 'rising';
  return 'flat';
}

/** Pure rule evaluation. `m` carries already-computed percents; missing inputs stay null. */
export function evalGrowth(m) {
  const kind = m.kind === 'app' ? 'app' : 'chain';
  const price = num(m.priceChange90dPct), btc = num(m.btcReturn90dPct);
  const stablesCh = num(m.stablesChange90dPct), feesCh = num(m.feesChange90dPct);
  const nativeCh = num(m.nativeFeesChange90dPct), tvlCh = num(m.tvlChange90dPct);
  const trend = m.mcapToFeesTrend === 'falling' || m.mcapToFeesTrend === 'rising' || m.mcapToFeesTrend === 'flat' ? m.mcapToFeesTrend : null;

  let stables;
  if (kind === 'app') stables = { pass: null, note: 'not applicable (app)', changePct: null, atAllTimeHigh: null };
  else {
    const up = stablesCh != null && stablesCh >= 50;
    const flat = price != null && price >= -15 && price <= 15;
    stables = { pass: stablesCh != null && price != null ? up && flat : false, changePct: r2(stablesCh), priceChangePct: r2(price), atAllTimeHigh: m.stablesAth == null ? null : !!m.stablesAth, nowUsd: m.stablesNowUsd ?? null };
    if (stablesCh == null || price == null) stables.note = 'missing series';
    else if (up && !flat) stables.note = 'stablecoin change passes; price is outside the flat band';
    else if (!up && flat) stables.note = 'price is flat; stablecoin change is under 50%';
  }

  const fees = { pass: feesCh != null && trend != null ? feesCh >= 50 && trend === 'falling' : false, changePct: r2(feesCh), last90dUsd: m.feesLast90dUsd ?? null, prior90dUsd: m.feesPrior90dUsd ?? null, nativeChangePct: r2(nativeCh), mcapToFeesTrend: trend };
  if (feesCh == null || trend == null) fees.note = 'missing series';

  const lead = (tvlCh != null && price != null) ? r2(tvlCh - price) : null;
  const tvlUp = tvlCh != null && tvlCh >= 50, leadOk = lead != null && lead >= 30;
  const tvl = { pass: !!(tvlUp && leadOk), changePct: r2(tvlCh), priceChangePct: r2(price), leadPts: lead, tvlUsd: m.tvlUsd ?? null };
  if (tvlCh == null || price == null) tvl.note = m.tvlNote || 'missing series';
  else if (!tvlUp && leadOk) tvl.note = 'lead passes, 50% threshold not met';

  const rel = (price != null && btc != null) ? r2(price - btc) : null;
  const vsBtc = { pass: rel != null && rel > 0, relativePct: rel, priceChangePct: r2(price), btcReturn90dPct: r2(btc) };
  if (price == null || btc == null) vsBtc.note = 'missing series';

  const traps = [];
  if (m.tvlUsd != null && m.tvlUsd < MIN_TVL_DEFAULT) traps.push({ id: 'tinyBase', note: 'TVL under $50M' });
  if (feesCh != null && feesCh >= 50 && nativeCh != null && nativeCh < 50 && price != null && price > 15) traps.push({ id: 'usdFeesDuringPriceRun', note: 'USD fees rose at least 50% while native-token fees did not, and price rose more than 15%' });
  if (m.tvlSelfToken || (m.ownTokenShare != null && m.ownTokenShare >= 0.5)) traps.push({ id: 'tvlSelfToken', note: 'TVL share in the chain token is high or flagged' });
  if (m.pointsFarming) traps.push({ id: 'pointsFarming', note: 'flagged as points farming' });

  const core = [stables, fees, tvl].filter(r => r.pass === true).length;
  const rulesPassed = [stables, fees, tvl, vsBtc].filter(r => r.pass === true).length;
  let state = 'none';
  if (core >= 2 && vsBtc.pass === true) state = 'confirmed';
  else if (core >= 2 && vsBtc.pass !== true) state = 'early';
  else if (core === 0 && vsBtc.pass === true) state = 'trigger_only';

  const low = (kind !== 'app' && (stablesCh == null || price == null)) || feesCh == null || trend == null || tvlCh == null || price == null || btc == null;
  return {
    chain: m.chain, symbol: m.symbol ?? null, kind, state, rulesPassed,
    rules: { stables, fees, tvl, vsBtc }, traps, tvlUsd: m.tvlUsd ?? null,
    confidence: low ? 'low' : 'medium', sources: GROWTH_SOURCES, disclaimer: GROWTH_DISCLAIMER
  };
}

export function metricsAt(stored, btcPoints, endSec) {
  const end = endSec;
  const lastFees = sumWindow(stored.fees, end - WINDOW_DAYS * DAY, end);
  const priorFees = sumWindow(stored.fees, end - 2 * WINDOW_DAYS * DAY, end - WINDOW_DAYS * DAY);
  const feesCh = (lastFees != null && priorFees != null && priorFees !== 0) ? ((lastFees - priorFees) / Math.abs(priorFees)) * 100 : null;
  const nLast = nativeSum(stored.fees, stored.price, end - WINDOW_DAYS * DAY, end);
  const nPrior = nativeSum(stored.fees, stored.price, end - 2 * WINDOW_DAYS * DAY, end - WINDOW_DAYS * DAY);
  const nativeCh = (nLast != null && nPrior != null && nPrior !== 0) ? ((nLast - nPrior) / Math.abs(nPrior)) * 100 : null;
  const tvlSeries = stored.tvl && stored.tvl.length ? stored.tvl : null;
  return {
    chain: stored.chain, symbol: stored.symbol ?? null, kind: stored.kind, pointsFarming: !!stored.pointsFarming,
    ownTokenShare: stored.ownTokenShare ?? null, tvlSelfToken: !!stored.tvlSelfToken,
    priceChange90dPct: pctChange(stored.price, end, WINDOW_DAYS),
    btcReturn90dPct: pctChange(btcPoints, end, WINDOW_DAYS),
    stablesChange90dPct: stored.kind === 'chain' ? pctChange(stored.stables, end, WINDOW_DAYS) : null,
    stablesAth: stored.kind === 'chain' ? atAth(stored.stables, end) : null,
    stablesNowUsd: stored.kind === 'chain' ? valueAt(stored.stables, end) : null,
    feesChange90dPct: feesCh, feesLast90dUsd: lastFees, feesPrior90dUsd: priorFees, nativeFeesChange90dPct: nativeCh,
    mcapToFeesTrend: mcapFeesTrend(stored.mcapNow, stored.priceNow, stored.price, stored.fees, end),
    tvlChange90dPct: tvlSeries ? pctChange(tvlSeries, end, WINDOW_DAYS) : null,
    tvlUsd: tvlSeries ? valueAt(tvlSeries, end) : (stored.tvlUsd ?? null),
    tvlNote: tvlSeries ? null : (stored.tvlNote || '90-day TVL series unavailable')
  };
}

export function applyGrowthFilters(rows, q = {}) {
  const kind = q.kind || 'all', minRules = q.minRulesPassed || 0, minTvl = q.minTvlUsd == null ? MIN_TVL_DEFAULT : q.minTvlUsd;
  return rows.filter(r => {
    if (kind !== 'all' && r.kind !== kind) return false;
    if (q.triggerOnly && !(r.rules && r.rules.vsBtc && r.rules.vsBtc.pass === true)) return false;
    if ((r.rulesPassed || 0) < minRules) return false;
    const tvl = r.tvlUsd != null ? r.tvlUsd : (r.rules && r.rules.tvl && r.rules.tvl.tvlUsd);
    if (tvl != null && tvl < minTvl) return false;
    return true;
  });
}

export function parseGrowthQuery(q = {}) {
  const kind = q.kind == null || q.kind === '' ? 'all' : String(q.kind);
  if (!['chain', 'app', 'all'].includes(kind)) return { error: 'kind must be chain, app or all' };
  let minRulesPassed = 0;
  if (q.minRulesPassed != null && q.minRulesPassed !== '') {
    minRulesPassed = Number(q.minRulesPassed);
    if (!Number.isInteger(minRulesPassed) || minRulesPassed < 0 || minRulesPassed > 4) return { error: 'minRulesPassed must be an integer from 0 to 4' };
  }
  const triggerOnly = q.triggerOnly === true || q.triggerOnly === 'true' || q.triggerOnly === '1';
  let minTvlUsd = MIN_TVL_DEFAULT;
  if (q.minTvlUsd != null && q.minTvlUsd !== '') {
    minTvlUsd = Number(q.minTvlUsd);
    if (!Number.isFinite(minTvlUsd) || minTvlUsd < 0) return { error: 'minTvlUsd must be a number >= 0' };
  }
  const window = q.window == null || q.window === '' ? '90d' : String(q.window);
  if (window !== '90d') return { error: 'window must be 90d', http: 400 };
  return { kind, minRulesPassed, triggerOnly, minTvlUsd, window };
}

export function firstFlips(weeks) {
  const seen = new Set(), out = [];
  for (const w of weeks || []) {
    for (const row of w.rows || []) {
      for (const rule of ['stables', 'fees', 'tvl', 'vsBtc']) {
        if (row.rules && row.rules[rule] && row.rules[rule].pass === true) {
          const k = `${row.chain}|${rule}`;
          if (!seen.has(k)) { seen.add(k); out.push({ chain: row.chain, symbol: row.symbol ?? null, rule, firstWeek: w.weekEnding }); }
        }
      }
    }
  }
  return out;
}

function countsOf(rows) {
  const counts = { early: 0, confirmed: 0, trigger_only: 0, none: 0 };
  for (const r of rows) if (counts[r.state] != null) counts[r.state]++;
  return counts;
}

async function getJson(url, fetchImpl, ms = 20000) {
  const f = fetchImpl || globalThis.fetch;
  const r = await f(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const fail = e => `unavailable (${e && e.name === 'TimeoutError' ? 'timeout' : String((e && e.message) || 'fetch failed').slice(0, 80)})`;

function asPoints(chart, valueKey) {
  const rows = Array.isArray(chart) ? chart : [];
  return rows.map(p => {
    if (Array.isArray(p)) return { t: Number(p[0]), v: Number(p[1]) };
    const t = Number(p.timestamp || p.date || p.t);
    let v = valueKey ? p[valueKey] : (p.price ?? p.v ?? p.tvl ?? p.value);
    if (v && typeof v === 'object') v = Object.values(v).reduce((s, n) => s + (Number(n) || 0), 0);
    return { t, v: Number(v) };
  }).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
}
function trim(points, nowSec) {
  const cut = nowSec - 400 * DAY;
  return (points || []).filter(p => p.t >= cut);
}
function sumCharts(charts) {
  const m = new Map();
  for (const c of charts) for (const p of c || []) m.set(p.t, (m.get(p.t) || 0) + p.v);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}
async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}
function mcapFor(protocols, geckoId) {
  if (!Array.isArray(protocols) || !geckoId) return null;
  let best = null;
  for (const p of protocols) if (p && p.gecko_id === geckoId && typeof p.mcap === 'number' && p.mcap > 0 && (best == null || p.mcap > best)) best = p.mcap;
  return best;
}
async function priceSeries(meta, fetchImpl) {
  if (meta.krakenPair) {
    const d = await getJson(`${krakenBase()}/0/public/OHLC?pair=${encodeURIComponent(meta.krakenPair)}&interval=1440`, fetchImpl, 20000);
    if (d.error && d.error.length) throw new Error(d.error.join(','));
    const k = Object.keys(d.result || {}).find(x => x !== 'last');
    return asPoints((d.result && d.result[k] || []).map(r => [Number(r[0]), Number(r[4])]));
  }
  if (!meta.geckoId) return [];
  const start = Math.floor(Date.now() / 1000) - 420 * DAY;
  const d = await getJson(`${coinsBase()}/chart/coingecko:${encodeURIComponent(meta.geckoId)}?start=${start}&span=420&period=1d`, fetchImpl, 20000);
  const coin = d.coins && d.coins[`coingecko:${meta.geckoId}`];
  return asPoints(coin && coin.prices);
}

async function loadScan(opts = {}) {
  if (!opts.fetchImpl && cache && Date.now() - cache.t < CACHE_MS) return { ...cache.data, cached: true };
  const run = (async () => {
    const nowSec = Math.floor((opts.now || Date.now()) / 1000);
    const sourceStatus = { defillamaTvl: 'ok', defillamaFees: 'ok', stables: 'ok', price: 'ok', defillamaProtocols: 'ok', krakenBtc: 'ok' };
    let protocols = null, btc = [];
    try { protocols = await getJson(llama('/protocols'), opts.fetchImpl, 25000); }
    catch (e) { sourceStatus.defillamaProtocols = fail(e); protocols = null; }
    try { btc = trim(await priceSeries({ krakenPair: 'XBTUSD' }, opts.fetchImpl), nowSec); }
    catch (e) { sourceStatus.krakenBtc = fail(e); btc = []; }
    if (!btc.length && sourceStatus.krakenBtc === 'ok') sourceStatus.krakenBtc = 'unavailable';
    const metas = coverageRows();
    let tvlFail = 0, feeFail = 0, priceFail = 0, stableFail = 0;
    const stored = await mapPool(metas, 4, async meta => {
      const row = { chain: meta.chain, symbol: meta.symbol ?? null, kind: meta.kind, pointsFarming: !!meta.pointsFarming, ownTokenShare: null, tvl: [], fees: [], stables: [], price: [], tvlUsd: null, tvlNote: null, mcapNow: mcapFor(protocols, meta.geckoId), priceNow: null, tvlFailed: false, feesFailed: false };
      const tvlSlug = meta.kind === 'chain' ? meta.chain : meta.tvlChain;
      if (tvlSlug) {
        try { row.tvl = trim(asPoints(await getJson(llama(`/v2/historicalChainTvl/${encodeURIComponent(tvlSlug)}`), opts.fetchImpl), 'tvl'), nowSec); }
        catch { row.tvlFailed = true; tvlFail++; }
      } else {
        const hit = Array.isArray(protocols) ? protocols.find(p => p && (p.slug === meta.protocolTvl || p.slug === meta.chain)) : null;
        if (hit && typeof hit.tvl === 'number') row.tvlUsd = hit.tvl;
        else row.tvlFailed = true;
        row.tvlNote = '90-day TVL series unavailable';
        if (row.tvlFailed) tvlFail++;
      }
      try {
        if (meta.feesChain || meta.kind === 'chain') {
          const slug = meta.feesChain || meta.chain;
          const d = await getJson(llama(`/overview/fees/${encodeURIComponent(slug)}?excludeTotalDataChartBreakdown=true&dataType=dailyFees`), opts.fetchImpl, 25000);
          row.fees = trim(asPoints(d.totalDataChart), nowSec);
        } else {
          const charts = [];
          for (const slug of meta.feesSlugs || []) {
            const d = await getJson(llama(`/summary/fees/${encodeURIComponent(slug)}?dataType=dailyFees`), opts.fetchImpl, 25000);
            charts.push(asPoints(d.totalDataChart));
          }
          row.fees = trim(sumCharts(charts), nowSec);
        }
      } catch { row.feesFailed = true; feeFail++; }
      if (meta.kind === 'chain') {
        try { row.stables = trim(asPoints(await getJson(stablesBase(`/stablecoincharts/${encodeURIComponent(meta.chain)}`), opts.fetchImpl, 25000)), nowSec); }
        catch { stableFail++; }
      }
      try { row.price = trim(await priceSeries(meta, opts.fetchImpl), nowSec); row.priceNow = row.price.length ? row.price[row.price.length - 1].v : null; }
      catch { priceFail++; }
      return row;
    });
    if (tvlFail) sourceStatus.defillamaTvl = tvlFail === metas.length ? 'unavailable' : `partial (${tvlFail} failed)`;
    if (feeFail) sourceStatus.defillamaFees = feeFail === metas.length ? 'unavailable' : `partial (${feeFail} failed)`;
    if (stableFail) sourceStatus.stables = stableFail === metas.filter(m => m.kind === 'chain').length ? 'unavailable' : `partial (${stableFail} failed)`;
    if (priceFail) sourceStatus.price = `partial (${priceFail} failed)`;
    if (stored.length && stored.every(r => r.tvlFailed && r.feesFailed)) {
      return { error: 'upstream data unavailable, retry shortly', sourceStatus };
    }
    const btcReturn90dPct = r2(pctChange(btc, nowSec, WINDOW_DAYS));
    const rows = stored.map(s => evalGrowth(metricsAt(s, btc, nowSec)));
    const data = { asOf: new Date((opts.now || Date.now())).toISOString(), nowSec, btcReturn90dPct, sourceStatus, stored, btc, rows };
    if (!opts.fetchImpl) cache = { t: Date.now(), data };
    return data;
  })();
  if (!opts.fetchImpl) { inflight = run.finally(() => { inflight = null; }); return inflight; }
  return run;
}

function envelope(rows, scan, extra = {}) {
  return {
    asOf: scan.asOf, window: '90d', btcReturn90dPct: scan.btcReturn90dPct, count: rows.length, rows,
    method: GROWTH_METHOD, sources: GROWTH_SOURCES, disclaimer: GROWTH_DISCLAIMER,
    sourceStatus: scan.sourceStatus, cached: !!scan.cached, ...extra
  };
}

export async function getGrowthOne(id, opts = {}) {
  const meta = findGrowth(id);
  if (!meta) return { error: 'unknown chain', http: 404 };
  const scan = await loadScan(opts);
  if (scan.error) return scan;
  const row = scan.rows.find(r => r.chain === meta.chain);
  if (!row) return { error: 'unknown chain', http: 404 };
  return { ...row, asOf: scan.asOf, window: '90d', btcReturn90dPct: scan.btcReturn90dPct, method: GROWTH_METHOD, sourceStatus: scan.sourceStatus, cached: !!scan.cached };
}

export async function getGrowthList(query, opts = {}) {
  const scan = await loadScan(opts);
  if (scan.error) return scan;
  const rows = applyGrowthFilters(scan.rows, query);
  return envelope(rows, scan, { kind: query.kind, minRulesPassed: query.minRulesPassed, triggerOnly: !!query.triggerOnly, minTvlUsd: query.minTvlUsd });
}

export async function getGrowthHistory(query, weeks, opts = {}) {
  const scan = await loadScan(opts);
  if (scan.error) return scan;
  const nowMs = opts.now || Date.now();
  const ends = weekEndings(nowMs, weeks);
  const snapshots = ends.map(end => {
    const btcReturn90dPct = r2(pctChange(scan.btc, end, WINDOW_DAYS));
    const rows = applyGrowthFilters(scan.stored.map(s => evalGrowth(metricsAt(s, scan.btc, end))), query);
    return { weekEnding: new Date(end * 1000).toISOString().slice(0, 10), btcReturn90dPct, counts: countsOf(rows), rows };
  });
  return {
    asOf: scan.asOf, window: '90d', weeks: snapshots.length, snapshots, firstFlip: firstFlips(snapshots),
    method: GROWTH_METHOD, sources: GROWTH_SOURCES, disclaimer: GROWTH_DISCLAIMER,
    sourceStatus: scan.sourceStatus, cached: !!scan.cached,
    note: 'Weekly prints are recomputed from public daily charts, not a pre-deploy archive.'
  };
}

async function probe(url, fetchImpl) {
  try {
    const f = fetchImpl || globalThis.fetch;
    const r = await f(url, { headers: UA, signal: AbortSignal.timeout(4000) });
    return r.ok ? 'ok' : `unavailable (HTTP ${r.status})`;
  } catch (e) { return fail(e); }
}

export async function getGrowthStatus(opts = {}) {
  const rows = coverageRows();
  const [tvl, stables, kraken] = await Promise.all([
    probe(llama('/tvl/ethereum'), opts.fetchImpl),
    probe(stablesBase('/stablecoincharts/ethereum'), opts.fetchImpl),
    probe(`${krakenBase()}/0/public/Ticker?pair=XBTUSD`, opts.fetchImpl)
  ]);
  let teaser = null;
  if (cache && cache.data && Array.isArray(cache.data.rows)) {
    const c = countsOf(cache.data.rows);
    teaser = { early: c.early, confirmed: c.confirmed, note: 'counts only; names are on the paid list' };
  }
  return {
    free: true, product: 'growth-lane',
    coverage: rows.map(r => ({ chain: r.chain, symbol: r.symbol ?? null, kind: r.kind })),
    count: rows.length,
    lastScan: cache ? new Date(cache.t).toISOString() : null,
    thresholds: { window: '90d', stablesPct: 50, priceFlatBandPct: [-15, 15], feesPct: 50, tvlPct: 50, tvlLeadPts: 30, tinyBaseUsd: MIN_TVL_DEFAULT, minTvlUsdDefault: MIN_TVL_DEFAULT },
    teaser, cacheHours: 6,
    sourceStatus: { defillamaTvl: tvl, stables, krakenTicker: kraken },
    sources: GROWTH_SOURCES, disclaimer: GROWTH_DISCLAIMER,
    note: 'Free health check only (no named rows). One chain $0.015, list $0.03, history $0.07.'
  };
}
