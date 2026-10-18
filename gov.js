// gov.js — recent federal contract awards to AI / drone / nuclear / robotics / space / quantum / defense-tech companies.
// Source: USAspending.gov public API (no key). Curated recipient->ticker map; private companies keep ticker null.
// Nothing invented: amounts, dates, agencies and descriptions are USAspending fields as returned.
import { fetchDod, normCn, DOD_SOURCES } from './dod.js';
const DISCLAIMER = 'signal only, not financial advice';
const TTL = 30 * 60 * 1000, DAYS = 14;
const API = 'https://api.usaspending.gov/api/v2/search/spending_by_transaction/';
// [search text, ticker|null, sector, display name]
export const GOV_COMPANIES = [
  ['PALANTIR', 'PLTR', 'ai', 'Palantir'], ['BIGBEAR.AI', 'BBAI', 'ai', 'BigBear.ai'], ['C3.AI', 'AI', 'ai', 'C3.ai'], ['SOUNDHOUND', 'SOUN', 'ai', 'SoundHound'],
  ['BOOZ ALLEN', 'BAH', 'defense-tech', 'Booz Allen Hamilton'], ['LEIDOS', 'LDOS', 'defense-tech', 'Leidos'], ['SCIENCE APPLICATIONS INTERNATIONAL', 'SAIC', 'defense-tech', 'SAIC'], ['CACI', 'CACI', 'defense-tech', 'CACI'], ['PARSONS', 'PSN', 'defense-tech', 'Parsons'], ['MERCURY SYSTEMS', 'MRCY', 'defense-tech', 'Mercury Systems'],
  ['KRATOS', 'KTOS', 'drones', 'Kratos'], ['AEROVIRONMENT', 'AVAV', 'drones', 'AeroVironment'], ['TEAL DRONES', 'RCAT', 'drones', 'Red Cat (Teal Drones)'], ['RED CAT', 'RCAT', 'drones', 'Red Cat'], ['ONDAS', 'ONDS', 'drones', 'Ondas'], ['AMERICAN ROBOTICS', 'ONDS', 'drones', 'Ondas (American Robotics)'],
  ['BWX', 'BWXT', 'nuclear', 'BWX Technologies'], ['CENTRUS', 'LEU', 'nuclear', 'Centrus Energy'], ['OKLO', 'OKLO', 'nuclear', 'Oklo'], ['NUSCALE', 'SMR', 'nuclear', 'NuScale'],
  ['ROCKET LAB', 'RKLB', 'space', 'Rocket Lab'], ['AST & SCIENCE', 'ASTS', 'space', 'AST SpaceMobile'], ['INTUITIVE MACHINES', 'LUNR', 'space', 'Intuitive Machines'], ['REDWIRE', 'RDW', 'space', 'Redwire'], ['PLANET LABS', 'PL', 'space', 'Planet Labs'], ['BLACKSKY', 'BKSY', 'space', 'BlackSky'],
  ['IONQ', 'IONQ', 'quantum', 'IonQ'], ['RIGETTI', 'RGTI', 'quantum', 'Rigetti'], ['D-WAVE', 'QBTS', 'quantum', 'D-Wave'],
  ['SARCOS', null, 'robotics', 'Sarcos (private/delisted)'], ['BOSTON DYNAMICS', null, 'robotics', 'Boston Dynamics (private)'], ['GHOST ROBOTICS', null, 'robotics', 'Ghost Robotics (private)'],
  ['LOCKHEED MARTIN', 'LMT', 'defense-prime', 'Lockheed Martin'], ['NORTHROP GRUMMAN', 'NOC', 'defense-prime', 'Northrop Grumman'], ['RAYTHEON', 'RTX', 'defense-prime', 'RTX (Raytheon)'], ['GENERAL DYNAMICS', 'GD', 'defense-prime', 'General Dynamics'], ['ELECTRIC BOAT', 'GD', 'defense-prime', 'General Dynamics (Electric Boat)'], ['L3HARRIS', 'LHX', 'defense-prime', 'L3Harris'], ['HUNTINGTON INGALLS', 'HII', 'defense-prime', 'HII'], ['HII', 'HII', 'defense-prime', 'HII'], ['BOEING', 'BA', 'defense-prime', 'Boeing'],
  ['ANDURIL', null, 'defense-tech', 'Anduril (private)'], ['SHIELD AI', null, 'drones', 'Shield AI (private)'], ['SPACE EXPLORATION TECHNOLOGIES', null, 'space', 'SpaceX (private)'], ['SCALE AI', null, 'ai', 'Scale AI (private)']
];
export const GOV_SECTORS = [...new Set(GOV_COMPANIES.map(c => c[2]))];
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RX = GOV_COMPANIES.map(c => [new RegExp(`(^|[^A-Z0-9])${esc(c[0])}([^A-Z0-9]|$)`), c]);
const match = name => { const n = String(name || '').toUpperCase(); return RX.find(([r]) => r.test(n))?.[1] || null; };
let cache = null, inflight = null;

async function fetchChunk(names, start, end) {
  const rows = []; let page = 1, hasNext = true;
  while (hasNext && page <= 3) {
    const body = { filters: { award_type_codes: ['A', 'B', 'C', 'D'], time_period: [{ start_date: start, end_date: end }], recipient_search_text: names },
      fields: ['Award ID', 'Recipient Name', 'Action Date', 'Transaction Amount', 'Awarding Agency', 'Awarding Sub Agency', 'Transaction Description', 'generated_internal_id', 'Mod'],
      sort: 'Transaction Amount', order: 'desc', limit: 100, page };
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json(); rows.push(...(j.results || [])); hasNext = !!j.page_metadata?.hasNext; page++;
  }
  return rows;
}
// USAspending 503s on long recipient lists, so query in chunks of 12 names, one at a time.
async function fetchRows(start, end) {
  const rows = [], failed = []; const names = [...new Set(GOV_COMPANIES.map(c => c[0]))];
  for (let i = 0; i < names.length; i += 12) {
    const chunk = names.slice(i, i + 12);
    try { rows.push(...await fetchChunk(chunk, start, end)); } catch (e) { failed.push(...chunk); }
  }
  if (failed.length === names.length) throw new Error('all chunks failed');
  return { rows, failed };
}

export function buildGov(rows, start, end, now = Date.now(), failed = []) {
  const awards = [];
  for (const x of rows || []) {
    const c = match(x['Recipient Name']); const amt = x['Transaction Amount'];
    if (!c || typeof amt !== 'number' || amt <= 0) continue; // skip $0 admin mods and de-obligations
    awards.push({ date: x['Action Date'], recipient: x['Recipient Name'], company: c[3], ticker: c[1], sector: c[2], amountUsd: Math.round(amt * 100) / 100,
      agency: x['Awarding Agency'] || null, subAgency: x['Awarding Sub Agency'] || null, awardId: x['Award ID'] || null, modification: x['Mod'] ?? null,
      description: x['Transaction Description'] ? String(x['Transaction Description']).slice(0, 300) : null,
      link: x.generated_internal_id ? `https://www.usaspending.gov/award/${x.generated_internal_id}` : null });
  }
  awards.sort((a, b) => b.amountUsd - a.amountUsd);
  const byTicker = {};
  for (const a of awards) { const k = a.ticker || a.company; const t = byTicker[k] ||= { ticker: a.ticker, company: a.company, sector: a.sector, actions: 0, totalUsd: 0 }; t.actions++; t.totalUsd = Math.round((t.totalUsd + a.amountUsd) * 100) / 100; }
  return { asOf: new Date(now).toISOString(), window: { start, end, days: DAYS, dateField: 'action_date' }, count: awards.length, partial: failed.length > 0, unqueriedNames: failed, byCompany: Object.values(byTicker).sort((a, b) => b.totalUsd - a.totalUsd), awards };
}

function mergeDod(base, dod) {
  const out = [], other = [];
  for (const r of dod.rows) {
    const c = match(r.recipientText);
    const row = { source: 'dod-announcement', date: r.awardedDate, announcedOn: r.annDate, recipient: r.company, company: c ? c[3] : r.company, ticker: c ? c[1] : null, sector: c ? c[2] : null,
      amountUsd: r.amountUsd, amountType: r.amountType, agency: 'Department of War (DoD)', subAgency: r.branch, contractingActivity: r.contractingActivity, location: r.location,
      awardId: r.contractNumber, contractNumbers: r.contractNumbers, multipleAwardees: r.multipleAwardees, description: r.description, link: r.link };
    (c ? out : other).push(row);
  }
  // Dedupe: a USAspending row whose award ID matches a DoD contract number is folded into the DoD row.
  const seen = new Map(); for (const d of out) for (const n of d.contractNumbers) seen.set(normCn(n), d);
  const usa = base.awards.filter(a => { const d = seen.get(normCn(a.awardId)); if (d) { d.usaspendingLink = a.link; d.usaspendingAmountUsd = a.amountUsd; return false; } return true; });
  return { awards: [...out, ...usa].sort((a, b) => b.amountUsd - a.amountUsd), otherDod: other.sort((a, b) => b.amountUsd - a.amountUsd) };
}
function totals(awards) {
  const by = {};
  for (const a of awards) { const k = a.ticker || a.company; const t = by[k] ||= { ticker: a.ticker, company: a.company, sector: a.sector, actions: 0, totalUsd: 0 }; t.actions++; t.totalUsd = Math.round((t.totalUsd + a.amountUsd) * 100) / 100; }
  return Object.values(by).sort((a, b) => b.totalUsd - a.totalUsd);
}
async function getAll() {
  if (cache && Date.now() - cache.t < TTL) return { ...cache.data, cached: true };
  if (inflight) return inflight;
  inflight = (async () => {
    const end = new Date(), start = new Date(Date.now() - DAYS * 86400000), d = x => x.toISOString().slice(0, 10);
    const [u, k] = await Promise.allSettled([fetchRows(d(start), d(end)), fetchDod(DAYS)]);
    if (u.status === 'rejected' && k.status === 'rejected') { if (cache) return { ...cache.data, cached: true, stale: true }; return { error: 'upstream data unavailable, retry shortly' }; }
    const base = u.status === 'fulfilled' ? buildGov(u.value.rows, d(start), d(end), Date.now(), u.value.failed) : { asOf: new Date().toISOString(), window: { start: d(start), end: d(end), days: DAYS }, partial: true, unqueriedNames: [], awards: [] };
    for (const a of base.awards) a.source = 'usaspending';
    const dod = k.status === 'fulfilled' ? k.value : { rows: [], days: [], failed: [] };
    const m = mergeDod(base, dod);
    const data = { ...base, awards: m.awards, count: m.awards.length, byCompany: totals(m.awards), otherLargeDodAwards: m.otherDod.slice(0, 10),
      sourceStatus: { usaspending: u.status === 'fulfilled' ? (u.value.failed.length ? 'partial' : 'ok') : 'unavailable', dodAnnouncements: k.status === 'fulfilled' ? (dod.failed.length ? 'partial' : 'ok') : 'unavailable' },
      dodAnnouncementDays: dod.days, dodAwardsParsed: dod.rows.length };
    cache = { t: Date.now(), data }; return data;
  })().finally(() => { inflight = null; });
  return inflight;
}

export function validGovFilters(f = {}) {
  if (f.sector && !GOV_SECTORS.includes(String(f.sector).toLowerCase())) return 'unknown sector';
  if (f.ticker && !/^[A-Za-z.]{1,6}$/.test(String(f.ticker))) return 'invalid ticker';
  if (f.q && String(f.q).length > 60) return 'q too long';
  return null;
}
export async function getGovContracts(f = {}) {
  const all = await getAll(); if (all.error) return all;
  const tk = f.ticker ? String(f.ticker).toUpperCase() : null, sec = f.sector ? String(f.sector).toLowerCase() : null, q = f.q ? String(f.q).toUpperCase() : null;
  let awards = all.awards.filter(a => (!tk || a.ticker === tk) && (!sec || a.sector === sec) && (!q || `${a.recipient} ${a.description} ${a.agency} ${a.subAgency}`.toUpperCase().includes(q)));
  const total = awards.length;
  return { ...all, otherLargeDodAwards: (tk || sec) ? [] : all.otherLargeDodAwards.filter(a => !q || `${a.recipient} ${a.description}`.toUpperCase().includes(q)), filters: { ticker: tk, sector: sec, q: f.q || null }, count: total, awards: awards.slice(0, 50), truncated: total > 50,
    byCompany: totals(awards),
    coverage: { sectors: GOV_SECTORS, companies: GOV_COMPANIES.map(c => ({ match: c[0], ticker: c[1], sector: c[2] })) },
    sources: [API + ' (contract award types A-D, transactions by action_date)', 'https://www.usaspending.gov', ...DOD_SOURCES],
    notes: [
      'source=dod-announcement rows are parsed from the Department of War daily contract announcements (awards >= $7.5M, posted ~5pm ET on business days). amountUsd there is the announced value (amountType: ceiling / modification / announced value), often a contract ceiling, not money obligated today; read the description for obligated funds.',
      'DoD rows are matched to tickers by company name in the award paragraph; for multiple-awardee contracts the ceiling is shared, not per company. otherLargeDodAwards lists the biggest unmapped DoD awards (ticker null). A USAspending row with the same contract number is folded into the DoD row (usaspendingLink).',
      'Each USAspending row is one positive-obligation contract action (new award or modification) as published on USAspending; $0 admin mods and de-obligations are excluded.',
      'DoD contract data is published on USAspending with a ~90-day delay (the DoD announcements fill that gap for awards >= $7.5M); civilian agencies (NASA, DOE, DHS, etc.) are usually days to weeks behind.',
      'Ticker map is curated and matched by recipient-name substring; subsidiaries or name variants may be missed, and private companies have ticker null.',
      'Amounts are the obligation in that action, not total contract value. Cached 30 minutes. ' + DISCLAIMER + '.'
    ], disclaimer: DISCLAIMER };
}
