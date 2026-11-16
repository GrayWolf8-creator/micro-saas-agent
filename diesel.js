import { FUEL_SURCHARGE_PRICE_USD } from './prices.js';

// Weekly U.S. on-highway diesel from the public EIA page (no API key).
// Per-mile surcharge = max(0, current - base) / mpg. Week-over-week is this week minus last week.
// Cached until the page's next release, or the next Monday 17:30 America/New_York
// (Tuesday when that Monday is a US federal holiday). A failed refresh keeps the last snapshot.
export const DIESEL_URL = 'https://www.eia.gov/petroleum/gasdiesel/';
export const DIESEL_SOURCE = 'Source: U.S. EIA';
const FETCH_MS = 8000;
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const round3 = n => Math.round(n * 1000) / 1000;
const round6 = n => Math.round(n * 1e6) / 1e6;

export const PADD_LABELS = {
  us: 'U.S.',
  padd1: 'East Coast (PADD1)',
  padd1a: 'New England (PADD1A)',
  padd1b: 'Central Atlantic (PADD1B)',
  padd1c: 'Lower Atlantic (PADD1C)',
  padd2: 'Midwest (PADD2)',
  padd3: 'Gulf Coast (PADD3)',
  padd4: 'Rocky Mountain (PADD4)',
  padd5: 'West Coast (PADD5)'
};
const PADD_ERROR = 'padd must be us or a PADD: 1, 1A, 1B, 1C, 2, 3, 4 (Rocky Mountain, default), or 5';
const ALIAS = {
  us: 'us', 'u.s.': 'us', 'u.s': 'us', usa: 'us', 'united states': 'us', national: 'us', nus: 'us',
  '1': 'padd1', padd1: 'padd1', 'padd 1': 'padd1', 'padd-1': 'padd1', east: 'padd1', 'east coast': 'padd1', eastcoast: 'padd1',
  '1a': 'padd1a', padd1a: 'padd1a', 'padd 1a': 'padd1a', 'new england': 'padd1a',
  '1b': 'padd1b', padd1b: 'padd1b', 'padd 1b': 'padd1b', 'central atlantic': 'padd1b',
  '1c': 'padd1c', padd1c: 'padd1c', 'padd 1c': 'padd1c', 'lower atlantic': 'padd1c',
  '2': 'padd2', padd2: 'padd2', 'padd 2': 'padd2', midwest: 'padd2',
  '3': 'padd3', padd3: 'padd3', 'padd 3': 'padd3', gulf: 'padd3', 'gulf coast': 'padd3',
  '4': 'padd4', padd4: 'padd4', 'padd 4': 'padd4', rocky: 'padd4', 'rocky mountain': 'padd4', rockymountain: 'padd4',
  '5': 'padd5', padd5: 'padd5', 'padd 5': 'padd5', west: 'padd5', 'west coast': 'padd5', westcoast: 'padd5'
};

export function normalizePadd(raw) {
  if (raw == null || String(raw).trim() === '') return 'padd4';
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIAS[s] || null;
}

export function validFuelQuery(q = {}) {
  const padd = normalizePadd(q.padd);
  if (!padd) return { error: PADD_ERROR };
  if (q.base == null || q.base === '' || q.mpg == null || q.mpg === '') return { error: 'base (USD per gallon) and mpg are required' };
  const base = Number(q.base);
  const mpg = Number(q.mpg);
  if (!Number.isFinite(base) || base < 0 || base > 100) return { error: 'base must be a USD-per-gallon number from 0 to 100' };
  if (!Number.isFinite(mpg) || mpg <= 0 || mpg > 100) return { error: 'mpg must be a number > 0 and <= 100' };
  return { padd, base, mpg };
}

export function etClockToUtc(ymd, hour, minute) {
  const [y, mo, d] = ymd.split('-').map(Number);
  let utc = Date.UTC(y, mo - 1, d, hour + 5, minute);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).map(p => [p.type, p.value]));
    const got = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    const want = Date.UTC(y, mo - 1, d, hour, minute);
    if (want === got) break;
    utc += want - got;
  }
  return utc;
}

function ymd(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}
function nthMonday(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const delta = (1 - first.getUTCDay() + 7) % 7;
  return 1 + delta + (n - 1) * 7;
}
function lastMonday(year, month) {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - 1 + 7) % 7);
}
function observedFixed(year, month, day) {
  return ymd(year, month, day + (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0 ? 1 : new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 6 ? -1 : 0));
}
export function federalHolidays(year) {
  return new Set([
    observedFixed(year, 1, 1),
    ymd(year, 1, nthMonday(year, 1, 3)),
    ymd(year, 2, nthMonday(year, 2, 3)),
    ymd(year, 5, lastMonday(year, 5)),
    observedFixed(year, 6, 19),
    observedFixed(year, 7, 4),
    ymd(year, 9, nthMonday(year, 9, 1)),
    ymd(year, 10, nthMonday(year, 10, 2)),
    observedFixed(year, 11, 11),
    observedFixed(year, 12, 25)
  ]);
}
export function isFederalHoliday(ymdStr) {
  const year = Number(String(ymdStr).slice(0, 4));
  return federalHolidays(year).has(ymdStr) || federalHolidays(year - 1).has(ymdStr);
}
function etYmd(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Next EIA-style release instant after `now`: Monday 17:30 ET, or Tuesday when Monday is a federal holiday.
export function nextMondayTuesdayRelease(now) {
  const start = etYmd(now);
  for (let i = 0; i < 21; i++) {
    const day = addDays(start, i);
    const at = etClockToUtc(day, 17, 30);
    if (at <= now) continue;
    const wd = weekday(day);
    if (wd === 1 && !isFederalHoliday(day)) return at;
    if (wd === 2 && isFederalHoliday(addDays(day, -1))) return at;
  }
  return now + 8 * 86400000;
}

export function refreshAtFrom(nextReleaseDate, now) {
  if (nextReleaseDate) {
    const at = etClockToUtc(nextReleaseDate, 17, 30);
    if (at > now) return at;
    return now + 30 * 60 * 1000;
  }
  return nextMondayTuesdayRelease(now);
}

function isoDateLong(text) {
  const m = String(text).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return ymd(Number(m[3]), month, Number(m[2]));
}
function isoDateShort(text) {
  const m = String(text).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  return ymd(2000 + Number(m[3]), Number(m[1]), Number(m[2]));
}
function cellsOf(row) {
  return [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}
function regionId(label) {
  const padd = label.match(/PADD\s*([1-5][A-C]?)/i);
  if (padd) return 'padd' + padd[1].toLowerCase();
  if (/^u\.s\.?$/i.test(label)) return 'us';
  return null;
}

export function parseDieselHtml(html, now = Date.now()) {
  const text = String(html || '');
  const dieselAt = text.search(/Diesel Fuel Release Date/i);
  if (dieselAt < 0) return null;
  const releaseDate = isoDateLong(text.slice(dieselAt, dieselAt + 180));
  const nextMatch = text.slice(dieselAt, dieselAt + 400).match(/Next Release Date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  const nextReleaseDate = nextMatch ? isoDateLong(nextMatch[1]) : null;
  const tableAt = text.toLowerCase().indexOf('on-highway diesel fuel prices');
  if (tableAt < 0 || !releaseDate) return null;
  const slice = text.slice(tableAt, tableAt + 20000);
  const rows = [...slice.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m => cellsOf(m[0]));
  const header = rows.find(r => r.filter(c => isoDateShort(c)).length >= 2);
  if (!header) return null;
  const dateIdx = header.map((c, i) => isoDateShort(c) ? i : -1).filter(i => i >= 0);
  const curIdx = dateIdx[dateIdx.length - 1];
  const prevIdx = dateIdx[dateIdx.length - 2];
  const regions = {};
  for (const r of rows) {
    const id = regionId(r[0] || '');
    if (!id || regions[id]) continue;
    const price = Number(r[curIdx]);
    const previous = Number(r[prevIdx]);
    if (!Number.isFinite(price) || !Number.isFinite(previous)) continue;
    regions[id] = { label: r[0], pricePerGallon: round3(price), previousPricePerGallon: round3(previous), weekOverWeek: round3(price - previous) };
  }
  if (!regions.us || !regions.padd4) return null;
  return {
    releaseDate,
    nextReleaseDate,
    weekEnding: isoDateShort(header[curIdx]),
    previousWeekEnding: isoDateShort(header[prevIdx]),
    regions,
    refreshAt: refreshAtFrom(nextReleaseDate, now),
    source: DIESEL_SOURCE,
    sourceUrl: DIESEL_URL
  };
}

export function buildFuelQuote(snapshot, input) {
  const row = snapshot && snapshot.regions && snapshot.regions[input.padd];
  if (!row || row.pricePerGallon == null || row.previousPricePerGallon == null) return { error: 'EIA table has no diesel price for this PADD', http: 503 };
  return {
    padd: input.padd,
    region: row.label,
    pricePerGallon: row.pricePerGallon,
    previousPricePerGallon: row.previousPricePerGallon,
    weekOverWeek: row.weekOverWeek,
    weekEnding: snapshot.weekEnding,
    releaseDate: snapshot.releaseDate,
    basePerGallon: input.base,
    mpg: input.mpg,
    surchargePerMile: round6(Math.max(0, row.pricePerGallon - input.base) / input.mpg),
    source: DIESEL_SOURCE,
    sourceUrl: DIESEL_URL,
    cached: !!snapshot.cached,
    ...(snapshot.stale ? { stale: true } : {}),
    disclaimer: 'Weekly retail on-highway diesel from the public U.S. EIA page. Not a carrier fuel quote and not financial advice.'
  };
}

export const FUEL_SERVICE_NAME = 'GW8 Fuel Surcharge';
export const FUEL_TAGS = ['eia', 'diesel', 'fuel-surcharge', 'truck', 'x402'];
export const FUEL_PRICE_USD = FUEL_SURCHARGE_PRICE_USD;
export const FUEL_BLURB = `U.S. EIA weekly on-highway diesel for the U.S. or a PADD (default Rocky Mountain, PADD 4): price per gallon, week-over-week change, and per-mile surcharge max(0, current - base) / mpg, plus the EIA release date. Public weekly page, no API key. Cached until the next Monday/Tuesday release. Source: U.S. EIA. ?padd=4&base=5.5&mpg=6. $${FUEL_SURCHARGE_PRICE_USD} USDC.`;
export const FUEL_EXAMPLE = {
  padd: 'padd4', region: 'Rocky Mountain (PADD4)', pricePerGallon: 6.206, previousPricePerGallon: 6.445, weekOverWeek: -0.239,
  weekEnding: '2026-11-09', releaseDate: '2026-11-10', basePerGallon: 5.5, mpg: 6, surchargePerMile: 0.117667,
  source: DIESEL_SOURCE, sourceUrl: DIESEL_URL, cached: false
};
export const FUEL_OUTPUT_SCHEMA = {
  type: 'object',
  description: 'EIA weekly on-highway diesel and a per-mile fuel surcharge. surchargePerMile = max(0, pricePerGallon - basePerGallon) / mpg. Source: U.S. EIA.',
  additionalProperties: true,
  required: ['padd', 'region', 'pricePerGallon', 'weekOverWeek', 'surchargePerMile', 'releaseDate', 'source'],
  properties: {
    padd: { type: 'string', description: 'us or padd1, padd1a, padd1b, padd1c, padd2, padd3, padd4, padd5. Default padd4.' },
    region: { type: 'string' },
    pricePerGallon: { type: 'number', description: 'Current weekly U.S. on-highway diesel, dollars per gallon.' },
    previousPricePerGallon: { type: 'number' },
    weekOverWeek: { type: 'number', description: 'Current week minus the previous week, dollars per gallon.' },
    weekEnding: { type: 'string' },
    releaseDate: { type: 'string', description: 'EIA diesel release date (YYYY-MM-DD).' },
    basePerGallon: { type: 'number', description: 'Caller base diesel price, dollars per gallon.' },
    mpg: { type: 'number' },
    surchargePerMile: { type: 'number', description: 'max(0, current - base) / mpg, dollars per mile.' },
    source: { type: 'string', const: DIESEL_SOURCE }
  }
};

let cache = null;
let inflight = null;
export function _resetDieselCache() { cache = null; inflight = null; }

export async function loadDiesel(deps = {}) {
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetch || fetch;
  if (cache && now < cache.refreshAt) return { ...cache.data, cached: true };
  if (!inflight) {
    inflight = (async () => {
      const r = await fetchImpl(DIESEL_URL, { signal: AbortSignal.timeout(FETCH_MS), headers: { accept: 'text/html' } });
      if (!r.ok) throw new Error('http ' + r.status);
      const parsed = parseDieselHtml(await r.text(), now);
      if (!parsed) throw new Error('unparsed');
      cache = { refreshAt: parsed.refreshAt, data: parsed };
      return parsed;
    })().finally(() => { inflight = null; });
  }
  try { return { ...(await inflight), cached: false }; }
  catch { return cache ? { ...cache.data, cached: true, stale: true } : null; }
}

export async function getFuelSurcharge(query = {}, deps = {}) {
  const v = validFuelQuery(query);
  if (v.error) return { error: v.error, http: 400 };
  const snap = await loadDiesel(deps);
  if (!snap) return { error: 'upstream data unavailable, retry shortly', http: 503 };
  return buildFuelQuote(snap, v);
}
