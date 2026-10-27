// value.js — value-capture score. Public DefiLlama + Kraken data and hand-curated rule classes.
// Data and rule scores only. Missing numbers stay null and are listed in unverified[]. No secrets.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PAIRS_MAP } from './Signal.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const load = name => JSON.parse(readFileSync(path.join(DIR, 'data', name), 'utf8'));
const RULES = load('rules_value.json');
const UNLOCKS = load('value_unlocks.json');
const UNLOCK_BY = Object.fromEntries((UNLOCKS.rows || []).map(r => [r.symbol, r]));

export const VALUE_DISCLAIMER = 'Rule-based tokenomics data and score. Not investment advice; no trade recommendation.';
export const VALUE_PRICES = { one: '0.015', batch: '0.03', history: '0.07', oneAtomic: '15000', batchAtomic: '30000', historyAtomic: '70000' };
export const VALUE_METHOD = {
  netSupply: '30 if both the trailing-90d and next-12m supply changes are <= 0 (flat or shrinking); 15 if only one window passes; 0 otherwise',
  holderYield: '25 if annualized holder revenue / market cap is >= 2%; linear from 0 points at 0.5% to 25 at 2%; 0 below 0.5%',
  usageBypass: 'required 20, partial 10, bypassable 0',
  burnVsHeld: 'burned 10, held 5, held_end_dated 3, none 0',
  unlockOverhang: 'sum of next-12m unlocks and unlocked-not-circulating, as % of circulating: <2 = 15, 2 to <5 = 10, 5 to 10 = 5, >10 = 0. A missing addend does not earn points unless the known addend is already above 10',
  grade: 'strong 75-100, medium 50-74, weak 25-49, fail below 25',
  partialNetSupplyPoints: 15
};
const SOURCES = [
  'https://api.llama.fi/overview/fees?dataType=dailyHoldersRevenue',
  'https://api.llama.fi/overview/fees?dataType=dailyFees',
  'https://api.llama.fi/protocols',
  'https://api.kraken.com/0/public/OHLC',
  'https://coins.llama.fi/chart/'
];
const CACHE_MS = 6 * 60 * 60 * 1000;
const DAY = 86400;
const UA = { accept: 'application/json', 'user-agent': 'GW8-Signal/1.0 (+https://micro-saas-agent.onrender.com)' };
const llama = p => `${(process.env.GW8_LLAMA_BASE || 'https://api.llama.fi').replace(/\/$/, '')}${p}`;
const coinsBase = () => (process.env.GW8_COINS_BASE || 'https://coins.llama.fi').replace(/\/$/, '');
const krakenBase = () => (process.env.GW8_KRAKEN_BASE || 'https://api.kraken.com').replace(/\/$/, '');
const r2 = v => (v == null || !Number.isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

let cache = null, inflight = null;
export function _resetValueCache() { cache = null; inflight = null; }

export function gradeOf(score) {
  if (score >= 75) return 'strong';
  if (score >= 50) return 'medium';
  if (score >= 25) return 'weak';
  return 'fail';
}

/** trailing90dPct / next12mPct: supply change, percent. <= 0 passes (flat or shrinking). */
export function scoreNetSupply(trailing90dPct, next12mPct) {
  const t = num(trailing90dPct), n = num(next12mPct);
  const tPass = t != null && t <= 0, nPass = n != null && n <= 0;
  let points = 0, pass = false;
  if (t != null && n != null) {
    if (tPass && nPass) { points = 30; pass = true; }
    else if (tPass || nPass) { points = VALUE_METHOD.partialNetSupplyPoints; pass = 'partial'; }
  } else if (t != null || n != null) {
    if (tPass || nPass) { points = VALUE_METHOD.partialNetSupplyPoints; pass = 'partial'; }
  }
  return { points, max: 30, pass, trailing90dPct: r2(t), next12mPct: r2(n) };
}

/** annualPct is holder revenue / market cap, in percent. */
export function scoreHolderYield(annualPct) {
  const y = num(annualPct);
  if (y == null) return { points: 0, max: 25, pass: false, annualPct: null };
  if (y >= 2) return { points: 25, max: 25, pass: true, annualPct: r2(y) };
  if (y >= 0.5) return { points: Math.round(25 * (y - 0.5) / 1.5), max: 25, pass: 'partial', annualPct: r2(y) };
  return { points: 0, max: 25, pass: false, annualPct: r2(y) };
}

export function scoreUsageBypass(cls) {
  const map = { required: [20, true], partial: [10, 'partial'], bypassable: [0, false] };
  const hit = map[cls];
  return { points: hit ? hit[0] : 0, max: 20, pass: hit ? hit[1] : false, class: hit ? cls : null };
}

export function scoreBurnVsHeld(cls) {
  const map = { burned: [10, true], held: [5, 'partial'], held_end_dated: [3, 'partial'], none: [0, false] };
  const hit = map[cls];
  return { points: hit ? hit[0] : 0, max: 10, pass: hit ? hit[1] : false, class: hit ? cls : null };
}

export function scoreUnlockOverhang(next12mPctOfCirc, lockedPct) {
  const n = num(next12mPctOfCirc), l = num(lockedPct);
  const base = { max: 15, next12mPctOfCirc: n, lockedOrUnlockedNotCirculatingPct: l, confidence: 'low' };
  if (n == null && l == null) return { ...base, points: 0, pass: false };
  const known = n == null ? l : l == null ? n : n + l;
  if ((n == null || l == null) && known <= 10) return { ...base, points: 0, pass: false, combinedPct: r2(known) };
  const sum = (n || 0) + (l || 0);
  let points, pass;
  if (sum < 2) { points = 15; pass = true; }
  else if (sum < 5) { points = 10; pass = 'partial'; }
  else if (sum <= 10) { points = 5; pass = 'partial'; }
  else { points = 0; pass = false; }
  return { ...base, points, pass, combinedPct: r2(sum) };
}

export function weekEndings(nowMs, weeks) {
  const d = new Date(nowMs);
  const sun = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay());
  const ends = [];
  for (let i = weeks - 1; i >= 0; i--) ends.push(Math.floor((sun - i * 7 * 86400000) / 1000));
  return ends;
}

export function buildValueCoin(input, now = Date.now()) {
  const unverified = [];
  const net = scoreNetSupply(input.trailing90dPct, input.next12mPct);
  net.burned90d = num(input.burned90d);
  net.issued90d = num(input.issued90d);
  net.confidence = 'low';
  if (input.trailing90dPct == null) unverified.push('netSupply.trailing90dPct');
  if (input.next12mPct == null) unverified.push('netSupply.next12mPct');

  const y = scoreHolderYield(input.annualPct);
  y.basis = input.yieldBasis || null;
  y.confidence = input.annualPct == null || input.yieldLow ? 'low' : (input.yieldConfidence || 'medium');
  if (input.annualPct == null) unverified.push('holderYield.annualPct');

  const u = scoreUsageBypass(input.usageClass);
  u.note = input.usageNote || null;
  u.confidence = 'low';
  if (!input.usageClass) unverified.push('usageBypass.class');

  const b = scoreBurnVsHeld(input.burnClass);
  b.programEndDate = input.programEndDate || null;
  b.confidence = 'low';
  if (!input.burnClass) unverified.push('burnVsHeld.class');

  const o = scoreUnlockOverhang(input.next12mPctOfCirc, input.lockedPct);
  if (input.next12mPctOfCirc == null) unverified.push('unlockOverhang.next12mPctOfCirc');
  if (input.lockedPct == null) unverified.push('unlockOverhang.lockedOrUnlockedNotCirculatingPct');
  for (const x of input.extraUnverified || []) if (!unverified.includes(x)) unverified.push(x);

  const score = net.points + y.points + u.points + b.points + o.points;
  return {
    symbol: input.symbol,
    name: input.name || input.symbol,
    asOf: input.asOf || new Date(now).toISOString(),
    score,
    grade: gradeOf(score),
    components: { netSupply: net, holderYield: y, usageBypass: u, burnVsHeld: b, unlockOverhang: o },
    rwaUsd: input.rwaUsd ?? null,
    unverified,
    ...(input.carriedForward ? { carriedForward: input.carriedForward } : {}),
    sources: input.sources || SOURCES,
    disclaimer: VALUE_DISCLAIMER
  };
}

const SORTERS = {
  score: (a, b) => b.score - a.score || (b.rwaUsd ?? -1) - (a.rwaUsd ?? -1) || a.symbol.localeCompare(b.symbol),
  yield: (a, b) => (b.components.holderYield.annualPct ?? -Infinity) - (a.components.holderYield.annualPct ?? -Infinity) || b.score - a.score || a.symbol.localeCompare(b.symbol),
  netSupply90d: (a, b) => (a.components.netSupply.trailing90dPct ?? Infinity) - (b.components.netSupply.trailing90dPct ?? Infinity) || b.score - a.score || a.symbol.localeCompare(b.symbol)
};
export function screenValue(rows, { sort = 'score', minScore = 0 } = {}) {
  return rows.filter(r => r.score >= minScore).sort(SORTERS[sort] || SORTERS.score);
}

export function parseValueQuery(q = {}) {
  const sort = q.sort == null || q.sort === '' ? 'score' : String(q.sort);
  if (!Object.prototype.hasOwnProperty.call(SORTERS, sort)) return { error: 'sort must be score, yield or netSupply90d' };
  let minScore = 0;
  if (q.minScore != null && q.minScore !== '') {
    minScore = Number(q.minScore);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) return { error: 'minScore must be a number from 0 to 100' };
  }
  let symbols = null;
  if (q.symbols != null && String(q.symbols).trim() !== '') {
    symbols = String(q.symbols).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) return { error: 'symbols is empty' };
    if (symbols.length > 25) return { error: 'symbols max is 25' };
    if (symbols.some(s => !/^[A-Z0-9]{1,12}$/.test(s))) return { error: 'symbols must be comma-separated tickers' };
  }
  return { sort, minScore, symbols };
}

export function parseWeeks(value) {
  if (value == null || value === '') return { weeks: 12 };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 52) return { error: 'weeks must be an integer from 1 to 52' };
  return { weeks: n };
}

function curatedList() {
  return RULES.coins.map(c => ({
    ...c,
    krakenPair: c.krakenPair || PAIRS_MAP[c.symbol] || null,
    curated: true
  }));
}
export function coverageCoins() {
  const by = new Map(curatedList().map(c => [c.symbol, c]));
  for (const sym of Object.keys(PAIRS_MAP)) {
    if (!by.has(sym)) by.set(sym, { symbol: sym, name: sym, geckoId: null, krakenPair: PAIRS_MAP[sym], fees: [], usageBypass: null, burnVsHeld: null, curated: false });
  }
  return [...by.values()];
}
export function coveredSymbols() { return coverageCoins().map(c => c.symbol); }
export function findCoin(symbol) { return coverageCoins().find(c => c.symbol === String(symbol || '').toUpperCase()) || null; }

function coinSources(meta, unlock) {
  const s = new Set(SOURCES);
  for (const block of [meta.usageBypass, meta.burnVsHeld, unlock]) if (block && block.source) s.add(block.source);
  return [...s];
}

function indexProtocols(overview) {
  const m = new Map();
  for (const p of (overview && overview.protocols) || []) if (p && p.slug) m.set(p.slug, p);
  return m;
}
function sumSlug(map, fees, field) {
  if (!fees || !fees.length || !map) return { value: null, missing: true };
  let s = 0, seen = false;
  for (const f of fees) {
    const p = map.get(f.slug);
    if (!p || p[field] == null || !Number.isFinite(Number(p[field]))) continue;
    seen = true; s += Number(p[field]);
  }
  return { value: seen ? s : null, missing: !seen };
}
function mcapFor(protocols, geckoId) {
  if (!Array.isArray(protocols) || !geckoId) return null;
  let best = null;
  for (const p of protocols) {
    if (p && p.gecko_id === geckoId && typeof p.mcap === 'number' && p.mcap > 0 && (best == null || p.mcap > best)) best = p.mcap;
  }
  return best;
}

export function assembleCoin(meta, ctx, now = Date.now()) {
  const unlock = UNLOCK_BY[meta.symbol] || null;
  const holders = sumSlug(ctx.holders, meta.fees, 'total30d');
  const feeUsd = sumSlug(ctx.fees, meta.fees, 'total30d');
  const mcap = mcapFor(ctx.protocols, meta.geckoId);
  const annual = holders.value == null ? null : holders.value * (365 / 30);
  const annualPct = annual != null && mcap ? (annual / mcap) * 100 : null;
  const yieldLow = annualPct == null || (holders.value === 0 && feeUsd.value > 0);
  let basis = null;
  if (annualPct != null) basis = 'trailing 30-day holder revenue annualized, divided by market cap';
  if (holders.value === 0 && feeUsd.value > 0) basis = 'holder revenue is zero while fees are positive; the yield tracker may be incomplete';
  const input = {
    symbol: meta.symbol, name: meta.name, now,
    trailing90dPct: null, next12mPct: null, burned90d: null, issued90d: null,
    annualPct, yieldBasis: basis, yieldLow, yieldConfidence: yieldLow ? 'low' : 'medium',
    usageClass: meta.usageBypass && meta.usageBypass.class, usageNote: meta.usageBypass && meta.usageBypass.note,
    burnClass: meta.burnVsHeld && meta.burnVsHeld.class, programEndDate: meta.burnVsHeld && meta.burnVsHeld.programEndDate,
    next12mPctOfCirc: unlock ? unlock.next12mPctOfCirc : null,
    lockedPct: unlock ? unlock.lockedOrUnlockedNotCirculatingPct : null,
    rwaUsd: null,
    sources: coinSources(meta, unlock)
  };
  const row = buildValueCoin(input, now);
  row.marketCapUsd = mcap == null ? null : Math.round(mcap);
  row.holderRevenue30dUsd = holders.value == null ? null : Math.round(holders.value);
  row.fees30dUsd = feeUsd.value == null ? null : Math.round(feeUsd.value);
  return row;
}

async function getJson(url, fetchImpl, ms = 20000) {
  const f = fetchImpl || globalThis.fetch;
  const r = await f(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const fail = e => `unavailable (${e && e.name === 'TimeoutError' ? 'timeout' : String((e && e.message) || 'fetch failed').slice(0, 80)})`;

async function loadBundle(opts = {}) {
  if (!opts.fetchImpl && cache && Date.now() - cache.t < CACHE_MS) return { ...cache.data, cached: true };
  const run = (async () => {
    const sourceStatus = { defillamaHolders: 'ok', defillamaFees: 'ok', defillamaProtocols: 'ok', curatedRules: 'ok', curatedUnlocks: 'ok' };
    let holdersRaw, feesRaw, protocols;
    try { holdersRaw = await getJson(llama('/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyHoldersRevenue'), opts.fetchImpl, 25000); }
    catch (e) { sourceStatus.defillamaHolders = fail(e); }
    if (!holdersRaw) return { error: 'upstream data unavailable, retry shortly', sourceStatus };
    try { feesRaw = await getJson(llama('/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees'), opts.fetchImpl, 25000); }
    catch (e) { sourceStatus.defillamaFees = fail(e); feesRaw = null; }
    try { protocols = await getJson(llama('/protocols'), opts.fetchImpl, 25000); }
    catch (e) { sourceStatus.defillamaProtocols = fail(e); protocols = null; }
    const data = { sourceStatus, holders: indexProtocols(holdersRaw), fees: indexProtocols(feesRaw), protocols, asOf: new Date().toISOString() };
    if (!opts.fetchImpl) cache = { t: Date.now(), data };
    return data;
  })();
  if (!opts.fetchImpl) { inflight = run.finally(() => { inflight = null; }); return inflight; }
  return run;
}

function envelope(rows, extra) {
  return {
    ...extra,
    count: rows.length,
    rows,
    method: VALUE_METHOD,
    sources: SOURCES,
    disclaimer: VALUE_DISCLAIMER
  };
}

export async function getValueSymbol(symbol, opts = {}) {
  const meta = findCoin(symbol);
  if (!meta) return { error: 'unknown symbol', http: 404, supported: coveredSymbols() };
  const bundle = opts.bundle || await loadBundle(opts);
  if (bundle.error) return bundle;
  const row = assembleCoin(meta, bundle);
  return { ...row, sourceStatus: bundle.sourceStatus, cached: !!bundle.cached };
}

export async function getValueBatch(query, opts = {}) {
  const bundle = opts.bundle || await loadBundle(opts);
  if (bundle.error) return bundle;
  const all = coverageCoins();
  let metas = all, unknown = [];
  if (query.symbols) {
    const want = new Set(query.symbols);
    metas = all.filter(c => want.has(c.symbol));
    unknown = query.symbols.filter(s => !all.some(c => c.symbol === s));
    if (!metas.length) return { error: 'unknown symbol', http: 404, unknown };
  }
  const rows = screenValue(metas.map(m => assembleCoin(m, bundle)), query);
  return envelope(rows, { asOf: bundle.asOf, sort: query.sort, minScore: query.minScore, unknown, sourceStatus: bundle.sourceStatus, cached: !!bundle.cached });
}

export function valueAt(points, t) {
  if (!points || !points.length) return null;
  let lo = 0, hi = points.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) { ans = points[mid].v; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
export function sumWindow(points, start, end) {
  if (!points || !points.length) return null;
  let s = 0, n = 0;
  for (const p of points) if (p.t > start && p.t <= end && Number.isFinite(p.v)) { s += p.v; n++; }
  return n ? s : null;
}
function asPoints(chart) {
  const rows = Array.isArray(chart) ? chart : [];
  return rows.map(p => Array.isArray(p) ? { t: Number(p[0]), v: Number(p[1]) } : { t: Number(p.timestamp || p.date || p.t), v: Number(p.price ?? p.v ?? p.value) })
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
}
function sumCharts(charts) {
  const m = new Map();
  for (const c of charts) for (const p of c) m.set(p.t, (m.get(p.t) || 0) + p.v);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

export function buildValueHistory(meta, series, { weeks, now = Date.now(), mcapNow = null, priceNow = null, sourceStatus } = {}) {
  const unlock = UNLOCK_BY[meta.symbol] || null;
  const ends = weekEndings(now, weeks);
  const snapshots = ends.map(end => {
    const rev = sumWindow(series.revenue, end - 30 * DAY, end);
    const annual = rev == null ? null : rev * (365 / 30);
    const px = valueAt(series.price, end);
    const mcap = (px != null && mcapNow && priceNow) ? mcapNow * (px / priceNow) : null;
    const annualPct = annual != null && mcap ? (annual / mcap) * 100 : null;
    const row = buildValueCoin({
      symbol: meta.symbol, name: meta.name, asOf: new Date(end * 1000).toISOString(),
      trailing90dPct: null, next12mPct: null,
      annualPct, yieldBasis: annualPct == null ? null : 'trailing 30-day holder revenue before this week, annualized, divided by market cap scaled with price',
      yieldLow: annualPct == null, yieldConfidence: 'low',
      usageClass: meta.usageBypass && meta.usageBypass.class, usageNote: meta.usageBypass && meta.usageBypass.note,
      burnClass: meta.burnVsHeld && meta.burnVsHeld.class, programEndDate: meta.burnVsHeld && meta.burnVsHeld.programEndDate,
      next12mPctOfCirc: unlock ? unlock.next12mPctOfCirc : null, lockedPct: unlock ? unlock.lockedOrUnlockedNotCirculatingPct : null,
      rwaUsd: null, sources: coinSources(meta, unlock),
      carriedForward: ['usageBypass', 'burnVsHeld', 'unlockOverhang', 'netSupply']
    }, now);
    return { weekEnding: new Date(end * 1000).toISOString().slice(0, 10), score: row.score, grade: row.grade, components: row.components, unverified: row.unverified };
  });
  return {
    symbol: meta.symbol, name: meta.name, asOf: new Date(now).toISOString(), weeks: snapshots.length, snapshots,
    note: 'Rule classes and supply windows are the current curated print on every week. Yield is recomputed from the holder-revenue series.',
    sourceStatus: sourceStatus || { defillamaFees: series.revenue.length ? 'ok' : 'unavailable', price: series.price.length ? 'ok' : 'unavailable' },
    method: VALUE_METHOD, sources: coinSources(meta, unlock), disclaimer: VALUE_DISCLAIMER
  };
}

async function feeChart(fee, fetchImpl) {
  const path = fee.kind === 'chain'
    ? `/overview/fees/${encodeURIComponent(fee.slug)}?excludeTotalDataChartBreakdown=true&dataType=dailyHoldersRevenue`
    : `/summary/fees/${encodeURIComponent(fee.slug)}?dataType=dailyHoldersRevenue`;
  const d = await getJson(llama(path), fetchImpl, 25000);
  return asPoints(d.totalDataChart);
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

export async function getValueHistory(symbol, weeks, opts = {}) {
  const meta = findCoin(symbol);
  if (!meta) return { error: 'unknown symbol', http: 404 };
  if (!meta.fees || !meta.fees.length) {
    return { error: 'upstream data unavailable, retry shortly', sourceStatus: { defillamaFees: 'no holder-revenue series for this symbol', price: 'not requested' } };
  }
  const sourceStatus = { defillamaFees: 'ok', price: 'ok', defillamaProtocols: 'ok' };
  let charts = [], price = [], protocols = null;
  try { charts = await Promise.all(meta.fees.map(f => feeChart(f, opts.fetchImpl))); }
  catch (e) { return { error: 'upstream data unavailable, retry shortly', sourceStatus: { ...sourceStatus, defillamaFees: fail(e) } }; }
  const revenue = sumCharts(charts);
  if (!revenue.length) return { error: 'upstream data unavailable, retry shortly', sourceStatus: { ...sourceStatus, defillamaFees: 'empty series' } };
  try { price = await priceSeries(meta, opts.fetchImpl); }
  catch (e) { sourceStatus.price = fail(e); price = []; }
  try { protocols = await getJson(llama('/protocols'), opts.fetchImpl, 25000); }
  catch (e) { sourceStatus.defillamaProtocols = fail(e); }
  const mcapNow = mcapFor(protocols, meta.geckoId);
  const priceNow = price.length ? price[price.length - 1].v : null;
  if (!price.length) sourceStatus.price = sourceStatus.price === 'ok' ? 'unavailable' : sourceStatus.price;
  return buildValueHistory(meta, { revenue, price }, { weeks, now: opts.now || Date.now(), mcapNow, priceNow, sourceStatus });
}

async function probe(url, fetchImpl) {
  try {
    const f = fetchImpl || globalThis.fetch;
    const r = await f(url, { headers: UA, signal: AbortSignal.timeout(4000) });
    return r.ok ? 'ok' : `unavailable (HTTP ${r.status})`;
  } catch (e) { return fail(e); }
}

export async function getValueStatus(opts = {}) {
  const coins = coverageCoins();
  const [holders, kraken] = await Promise.all([
    probe(llama('/tvl/ethereum'), opts.fetchImpl),
    probe(`${krakenBase()}/0/public/Ticker?pair=XBTUSD`, opts.fetchImpl)
  ]);
  return {
    free: true,
    product: 'value-capture',
    coverage: coins.map(c => ({ symbol: c.symbol, name: c.name, curated: !!c.curated, fees: (c.fees || []).map(f => f.slug) })),
    count: coins.length,
    curatedCount: coins.filter(c => c.curated).length,
    lastRefresh: cache ? new Date(cache.t).toISOString() : null,
    cacheHours: 6,
    grades: VALUE_METHOD.grade,
    sourceStatus: { defillama: holders, krakenTicker: kraken, curatedRules: 'ok', curatedUnlocks: 'ok' },
    sources: SOURCES,
    disclaimer: VALUE_DISCLAIMER,
    note: 'Free health check only (no scores). Single coin $0.015, screen $0.03, history $0.07.'
  };
}
