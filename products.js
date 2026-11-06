// products.js — three paid x402 products on top of the existing token screen and public market data.
// Deep check and token brief reuse scoreVerdict (GoPlus + DexScreener). They do not change that screen.
// The bottom-watch feed reads public OHLC (Kraken, then Binance) and public funding. No API keys.
// A field that cannot be read is UNKNOWN. A failed lookup (nothing factual to return) is an error and is not settled.
import { scoreVerdict, verdictSourceUrls, validVerdictInput, VERDICT_CHAINS, VERDICT_LABELS, VERDICT_TTL_SEC, VERDICT_RULES } from './upgrades.js';

const r2 = v => Math.round(v * 100) / 100;
const FETCH_MS = 8000;
const TTL = VERDICT_TTL_SEC * 1000;
const BURNS = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
const AVOID_CODES = new Set(['honeypot', 'cannot_sell_all', 'non_transferable', 'balance_mutable', 'airdrop_scam', 'fake_token']);
const BLOCKS_CLEAR = new Set(['freeze_authority', 'mint_authority', 'mintable', 'pausable', 'hidden_owner', 'ownership_reclaim', 'owner_change_balance', 'unverified', 'lp_unlocked']);
const flag = v => v === '1' || v === 1 || v === true;

export const DEEP_PRICE_USD = '0.05';
export const BRIEF_PRICE_USD = '0.02';
export const BOTTOM_PRICE_USD = '0.01';
export const DEEP_BLURB = 'Deep honeypot check for rug pull, token safety, holder concentration, liquidity lock, and scam token. Returns the $0.01 screen plus top-10 holder %, liquidity amount, whether LP is locked or burned, owner/mint/proxy/blacklist privileges, buy/sell tax, and contract age. CLEAR, CAUTION, AVOID, or UNKNOWN. GoPlus, honeypot.is, DexScreener. ?fresh=1 skips the 10-minute cache. $0.05 USDC.';
export const BRIEF_BLURB = 'Token safety plus price in one token brief and trade check. Returns the $0.01 safety verdict (CLEAR, CAUTION, AVOID, or UNKNOWN) plus a market snapshot: price, 24h change, 24h volume, liquidity, and FDV. GoPlus and DexScreener. ?fresh=1 skips the 10-minute cache. $0.02 USDC.';
export const BOTTOM_BLURB = 'Crypto bottom-watch research feed for BTC, ETH, SOL, XRP, AAVE, HYPE, MON, CC, and the same public candle set. Tells: sweep-and-reclaim of the 30-day low, 2x volume, RSI turning up from oversold, 4h higher low, funding or liquidation flush. tells_count and tier NONE, EARLY_TELL at 2 or more, CONFIRMED only when BTC itself has reclaimed. Research data, not financial advice. Cached about 10 minutes. $0.01 USDC.';
export const DEEP_TAGS = ['deep-honeypot', 'rug-pull', 'token-safety', 'liquidity-lock', 'scam-token'];
export const BRIEF_TAGS = ['token-brief', 'token-safety', 'trade-check', 'dexscreener', 'goplus'];
export const BOTTOM_TAGS = ['crypto-bottom', 'research', 'rsi', 'sweep-reclaim', 'x402'];
export const DEEP_SERVICE_NAME = 'GW8 Deep Honeypot';
export const BRIEF_SERVICE_NAME = 'GW8 Token Brief';
export const BOTTOM_SERVICE_NAME = 'GW8 Crypto Bottom';
export const BOTTOM_DISCLAIMER = 'Research data, not financial advice. Not a trade recommendation, not a prediction, and not a solicitation.';
export const BOTTOM_TIER_RULE = 'NONE when tells_count is under 2. EARLY_TELL when tells_count is 2 or more. CONFIRMED only when that coin has 2 or more tells and BTC itself has reclaimed its prior 30-day low.';

export const DEEP_EXAMPLE = {
  chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', verdict: 'CLEAR', score: 90,
  reasons: [{ code: 'proxy', points: -10, detail: 'upgradeable proxy' }],
  unknowns: [],
  deep: {
    holderConcentration: { top10Pct: 12.5, status: 'ok' },
    liquidity: { amountUsd: 2000000, lockedOrBurned: true, lockedOrBurnedPct: 80, status: 'ok' },
    privileges: { owner: 'renounced', mint: false, proxy: true, blacklist: false, status: 'ok' },
    tax: { buyPct: 0, sellPct: 0, source: 'goplus', status: 'ok' },
    contractAge: { days: 400, createdAt: '2025-09-01T00:00:00.000Z', source: 'dexscreener', basis: 'pair_creation', status: 'ok' }
  }
};
export const BRIEF_EXAMPLE = {
  chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', verdict: 'CLEAR', score: 100,
  reasons: [{ code: 'no_flags', points: 0, detail: 'No published rule fired on the records retrieved.' }],
  marketSnapshot: { priceUsd: 1, change24hPct: 0.1, volume24hUsd: 1000000, liquidityUsd: 2000000, fdvUsd: 5000000, status: 'ok' }
};
export const BOTTOM_EXAMPLE = {
  disclaimer: BOTTOM_DISCLAIMER,
  tierRule: BOTTOM_TIER_RULE,
  btcReclaimed: false,
  cacheTtlSec: VERDICT_TTL_SEC,
  coins: [{ symbol: 'BTC', status: 'ok', tells: { sweep_reclaim: false, volume_2x: false, rsi_turn: false, higher_low_4h: false, funding_flush: null }, tells_count: 0, tier: 'NONE' }]
};

const fieldSchema = { type: 'object', additionalProperties: true };
export const DEEP_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: true,
  description: 'Deep honeypot check. verdict is CLEAR, CAUTION, AVOID, or UNKNOWN. deep holds holder concentration, liquidity lock, privileges, buy/sell tax, and contract age. Missing reads are UNKNOWN.',
  properties: {
    verdict: { type: 'string', enum: VERDICT_LABELS },
    score: { type: 'number' },
    reasons: { type: 'array', items: { type: 'object' } },
    unknowns: { type: 'array' },
    deep: {
      type: 'object',
      properties: {
        holderConcentration: fieldSchema,
        liquidity: fieldSchema,
        privileges: fieldSchema,
        tax: fieldSchema,
        contractAge: fieldSchema
      }
    }
  },
  required: ['verdict', 'reasons', 'deep']
};
export const BRIEF_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: true,
  description: 'Token brief: token safety plus price. verdict is the $0.01 screen. marketSnapshot is price, 24h change, 24h volume, liquidity, and FDV.',
  properties: {
    verdict: { type: 'string', enum: VERDICT_LABELS },
    score: { type: 'number' },
    reasons: { type: 'array' },
    marketSnapshot: { type: 'object', properties: { priceUsd: { type: 'number' }, change24hPct: { type: 'number' }, volume24hUsd: { type: 'number' }, liquidityUsd: { type: 'number' }, fdvUsd: { type: 'number' }, status: { type: 'string', enum: ['ok', 'partial', 'UNKNOWN'] } } }
  },
  required: ['verdict', 'reasons', 'marketSnapshot']
};
export const BOTTOM_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: true,
  description: 'Crypto bottom-watch research data, not financial advice. Each coin has tells_count and tier NONE, EARLY_TELL, or CONFIRMED.',
  properties: {
    disclaimer: { type: 'string' },
    tierRule: { type: 'string' },
    btcReclaimed: { type: 'boolean' },
    coins: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, tells_count: { type: 'integer' }, tier: { type: 'string', enum: ['NONE', 'EARLY_TELL', 'CONFIRMED'] } }, required: ['symbol', 'tells_count', 'tier'] } }
  },
  required: ['disclaimer', 'btcReclaimed', 'coins']
};
export const DEEP_PATH_SCHEMA = {
  chain: { type: 'string', enum: Object.keys(VERDICT_CHAINS), description: 'Chain for a deep honeypot check: rug pull, token safety, holder concentration, liquidity lock, or scam token' },
  address: { type: 'string', description: 'Token contract (0x and 40 hex) or Solana mint (base58)' }
};
export const BRIEF_PATH_SCHEMA = {
  chain: { type: 'string', enum: Object.keys(VERDICT_CHAINS), description: 'Chain for a token brief: token safety plus price, a trade check' },
  address: { type: 'string', description: 'Token contract (0x and 40 hex) or Solana mint (base58)' }
};

export function honeypotIsUrl(chain, address) {
  const id = VERDICT_CHAINS[chain];
  if (!id || id === 'solana') return null;
  return `https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(address)}&chainID=${id}`;
}

async function defaultFetchJson(url) {
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { accept: 'application/json' } }); }
  catch (e) {
    const err = new Error('fetch failed');
    err.detail = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'unavailable';
    throw err;
  }
  if (!r.ok) { const err = new Error('http'); err.detail = `http_${r.status}`; throw err; }
  try { return await r.json(); }
  catch { const err = new Error('bad_json'); err.detail = 'bad_json'; throw err; }
}
async function readSource(run) {
  try { return { ok: true, body: await run() }; }
  catch (e) { return { ok: false, detail: (e && e.detail) || 'unavailable' }; }
}
function parseGoPlus(chain, address, got) {
  if (!got.ok) return { status: 'error', detail: got.detail, token: null };
  const body = got.body;
  if (!body || typeof body !== 'object' || Number(body.code) !== 1 || !body.result || typeof body.result !== 'object')
    return { status: 'error', detail: 'api_code', token: null };
  const res = body.result;
  let token = res[address] || res[address.toLowerCase()] || null;
  if (!token) {
    const vals = Object.values(res).filter(v => v && typeof v === 'object');
    token = vals.length === 1 ? vals[0] : null;
  }
  return token ? { status: 'ok', detail: null, token } : { status: 'empty', detail: 'no_record', token: null };
}
function parseDex(got) {
  if (!got.ok) return { status: 'error', detail: got.detail, pairs: [] };
  if (!Array.isArray(got.body)) return { status: 'error', detail: 'bad_json', pairs: [] };
  return got.body.length ? { status: 'ok', detail: null, pairs: got.body } : { status: 'empty', detail: 'no_pairs', pairs: [] };
}
function failedLookup(goplus, dex) {
  const gpDead = goplus.status === 'error';
  const dexDead = dex.status === 'error';
  if (gpDead && dexDead) return true;
  if (gpDead && dex.status === 'empty') return true;
  if (dexDead && goplus.status === 'empty') return true;
  return false;
}
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pctFraction(v) {
  const n = num(v);
  if (n == null) return null;
  return r2(n * 100);
}
function cacheGet(map, key, fresh) {
  if (fresh) return null;
  const hit = map.get(key);
  if (!hit || Date.now() - hit.t >= TTL) return null;
  const ageSec = Math.max(0, Math.round((Date.now() - hit.t) / 1000));
  return { ...hit.data, cached: true, freshness: { ...(hit.data.freshness || {}), cached: true, ageSec } };
}
function cacheSet(map, key, data) {
  map.set(key, { t: Date.now(), data });
  if (map.size > 2000) map.delete(map.keys().next().value);
}
const freshOf = opts => opts.fresh === true || opts.fresh === '1' || opts.fresh === 1;

// ---------- Deep honeypot check ----------
const deepCache = new Map();
export function _resetDeepCache() { deepCache.clear(); }

function top10Pct(holders) {
  if (!Array.isArray(holders) || !holders.length) return null;
  const pcts = holders.map(h => num(h && h.percent)).filter(n => n != null).sort((a, b) => b - a).slice(0, 10);
  if (!pcts.length) return null;
  return r2(pcts.reduce((a, b) => a + b, 0) * 100);
}
function lpState(holders) {
  if (!Array.isArray(holders) || !holders.length) return { lockedOrBurned: null, lockedOrBurnedPct: null };
  let covered = 0, any = false;
  for (const h of holders) {
    const addr = String(h.address || h.token_account || '').toLowerCase();
    const tag = String(h.tag || '').toLowerCase();
    const locked = flag(h.is_locked) || tag.includes('lock') || tag.includes('burn') || BURNS.has(addr);
    if (!locked) continue;
    any = true;
    const p = num(h.percent);
    if (p != null) covered += p;
  }
  return { lockedOrBurned: any, lockedOrBurnedPct: r2(covered * 100) };
}
function ownerOf(token, chain) {
  if (!token) return 'UNKNOWN';
  if (chain === 'solana') {
    const on = f => f && f.status === '1';
    if (token.mintable == null && token.freezable == null) return 'UNKNOWN';
    if (on(token.mintable) || on(token.freezable)) return 'active';
    return 'renounced';
  }
  if (flag(token.hidden_owner)) return 'hidden';
  const owner = String(token.owner_address || '').toLowerCase();
  if (!owner) return 'UNKNOWN';
  if (BURNS.has(owner)) return 'renounced';
  return 'active';
}
function boolField(v) {
  if (v == null || v === '') return null;
  if (flag(v)) return true;
  if (v === '0' || v === 0 || v === false) return false;
  return null;
}
function taxOf(token, hpBody, chain) {
  if (token && chain !== 'solana' && (token.buy_tax != null && token.buy_tax !== '' || token.sell_tax != null && token.sell_tax !== '')) {
    const buyPct = token.buy_tax == null || token.buy_tax === '' ? null : pctFraction(token.buy_tax);
    const sellPct = token.sell_tax == null || token.sell_tax === '' ? null : pctFraction(token.sell_tax);
    const status = buyPct != null && sellPct != null ? 'ok' : (buyPct != null || sellPct != null ? 'partial' : 'UNKNOWN');
    return { buyPct, sellPct, source: 'goplus', status };
  }
  const sim = hpBody && hpBody.simulationResult;
  if (sim && (sim.buyTax != null || sim.sellTax != null)) {
    const buyPct = num(sim.buyTax) == null ? null : r2(num(sim.buyTax));
    const sellPct = num(sim.sellTax) == null ? null : r2(num(sim.sellTax));
    return { buyPct, sellPct, source: 'honeypot.is', status: buyPct != null && sellPct != null ? 'ok' : 'partial' };
  }
  return { buyPct: null, sellPct: null, source: null, status: 'UNKNOWN' };
}
function contractAgeOf(pairs, hpBody, now) {
  let ms = null, source = null;
  const ts = hpBody && hpBody.pair && (hpBody.pair.createdAtTimestamp || hpBody.pair.creationTimestamp);
  if (ts != null && num(ts) != null) {
    const n = num(ts);
    ms = n < 1e12 ? n * 1000 : n;
    source = 'honeypot.is';
  }
  if (ms == null && Array.isArray(pairs) && pairs.length) {
    const p = [...pairs].sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
    if (p && p.pairCreatedAt != null && num(p.pairCreatedAt) != null) {
      const n = num(p.pairCreatedAt);
      ms = n < 1e12 ? n * 1000 : n;
      source = 'dexscreener';
    }
  }
  if (ms == null || ms > now || ms < Date.UTC(2013, 0, 1)) return { days: null, createdAt: null, source: null, basis: null, status: 'UNKNOWN' };
  // Public feeds publish pair creation, not the contract deploy transaction. days is that pair age.
  return { days: Math.floor((now - ms) / 86400000), createdAt: new Date(ms).toISOString(), source, basis: 'pair_creation', status: 'ok' };
}
function liquidityAmount(pairs, hpBody) {
  if (Array.isArray(pairs) && pairs.length) {
    const p = [...pairs].sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
    const n = num(p && p.liquidity && p.liquidity.usd);
    if (n != null) return { amountUsd: r2(n), source: 'dexscreener' };
  }
  const n = num(hpBody && hpBody.pair && hpBody.pair.liquidity);
  if (n != null) return { amountUsd: r2(n), source: 'honeypot.is' };
  return { amountUsd: null, source: null };
}
function privilegeStatus(p) {
  const known = [p.owner !== 'UNKNOWN', p.mint != null, p.proxy != null, p.blacklist != null].filter(Boolean).length;
  if (known === 4) return 'ok';
  if (known === 0) return 'UNKNOWN';
  return 'partial';
}
function labelOf(score, reasons, unknowns, baseVerdict) {
  if (reasons.some(r => r.code === 'honeypot')) return 'AVOID';
  if (score == null) return baseVerdict === 'UNKNOWN' ? 'UNKNOWN' : baseVerdict;
  const hard = reasons.some(r => AVOID_CODES.has(r.code));
  const blocks = reasons.some(r => BLOCKS_CLEAR.has(r.code));
  const limited = unknowns.some(u => u.limitsVerdict);
  return hard || score < 40 ? 'AVOID' : (limited || blocks || score < 75) ? 'CAUTION' : 'CLEAR';
}

export function buildDeepVerdict(chain, address, input, now = Date.now()) {
  const goplus = input.goplus, dex = input.dex;
  const fetchedAt = input.fetchedAt || new Date(now).toISOString();
  const base = scoreVerdict(chain, address, { goplus, dex, urls: input.urls, fetchedAt }, now);
  const token = goplus.token;
  const hp = input.honeypot && input.honeypot.status === 'ok' ? input.honeypot.body : null;
  const holders = token && Array.isArray(token.holders) ? token.holders : null;
  const top = top10Pct(holders);
  const lp = lpState(token && Array.isArray(token.lp_holders) ? token.lp_holders : null);
  const liq = liquidityAmount(dex.pairs, hp);
  const owner = ownerOf(token, chain);
  let mint = token ? (chain === 'solana' ? (token.mintable ? token.mintable.status === '1' : null) : boolField(token.is_mintable)) : null;
  let proxy = token && chain !== 'solana' ? boolField(token.is_proxy) : null;
  if (proxy == null && hp && hp.contractCode && typeof hp.contractCode.isProxy === 'boolean') proxy = hp.contractCode.isProxy;
  const blacklist = token && chain !== 'solana' ? boolField(token.is_blacklisted) : null;
  const privileges = { owner, mint, proxy, blacklist, status: 'UNKNOWN' };
  privileges.status = privilegeStatus(privileges);
  const tax = taxOf(token, hp, chain);
  const contractAge = contractAgeOf(dex.pairs, hp, now);
  const liqStatus = liq.amountUsd != null && lp.lockedOrBurned != null ? 'ok' : (liq.amountUsd != null || lp.lockedOrBurned != null ? 'partial' : 'UNKNOWN');
  const deep = {
    holderConcentration: { top10Pct: top, status: top == null ? 'UNKNOWN' : 'ok' },
    liquidity: { amountUsd: liq.amountUsd, lockedOrBurned: lp.lockedOrBurned, lockedOrBurnedPct: lp.lockedOrBurnedPct, source: liq.source, status: liqStatus },
    privileges,
    tax,
    contractAge
  };
  const reasons = (base.reasons || []).map(r => ({ ...r }));
  const unknowns = (base.unknowns || []).map(u => ({ ...u }));
  let score = base.score;
  const penalize = (code, points, detail) => {
    if (reasons.some(r => r.code === code)) return;
    reasons.push({ code, points: score == null ? 0 : -points, detail });
    if (score != null) score = Math.max(0, Math.min(100, score - points));
  };
  if (hp && hp.honeypotResult && hp.honeypotResult.isHoneypot === true) penalize('honeypot', 100, 'honeypot.is says this token is a honeypot');
  if (top != null && score != null) {
    if (top > 80) penalize('holder_concentration', 20, `top 10 holders own ${top}%`);
    else if (top > 50) penalize('holder_concentration', 10, `top 10 holders own ${top}%`);
  }
  if (privileges.proxy === true) penalize('proxy', 10, 'upgradeable proxy');
  if (tax.source === 'honeypot.is' && score != null) {
    const taxPct = Math.max(tax.buyPct || 0, tax.sellPct || 0);
    if (taxPct > 10) penalize('tax', 30, `buy or sell tax ${r2(taxPct)}%`);
    else if (taxPct >= 5) penalize('tax', 10, `buy or sell tax ${r2(taxPct)}%`);
  }
  if (contractAge.status === 'ok' && contractAge.days < 7 && score != null && !reasons.some(r => r.code === 'new_pair')) {
    penalize('contract_age', 10, `contract or pair age ${contractAge.days}d`);
  }
  if (input.honeypot && input.honeypot.status === 'error') {
    unknowns.push({ code: 'honeypot_is_unavailable', detail: `honeypot.is did not answer (${input.honeypot.detail}). Fields that only it could fill are UNKNOWN.`, limitsVerdict: false });
  }
  const sources = [...(base.sources || [])];
  if (input.honeypot) {
    sources.push({ name: 'honeypot.is', url: input.honeypotUrl || null, status: input.honeypot.status, ...(input.honeypot.detail ? { detail: input.honeypot.detail } : {}), fetchedAt });
  }
  const verdict = labelOf(score, reasons, unknowns, base.verdict);
  return {
    ...base, engine: 'gw8-token-verdict-deep/1', verdict, score, reasons, unknowns, sources, deep,
    rules: [...VERDICT_RULES, 'Deep check adds holder concentration, liquidity lock, privileges, tax, and contract age. A missing read is UNKNOWN and does not by itself block CLEAR. honeypot.is isHoneypot forces AVOID. A honeypot.is timeout does not fail the lookup.'],
    note: base.note
  };
}

export async function getDeepVerdict(chain, address, opts = {}) {
  const bad = validVerdictInput(chain, address);
  if (bad) return { error: bad, http: 400 };
  const fresh = freshOf(opts);
  const key = `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
  const hit = cacheGet(deepCache, key, fresh);
  if (hit) return hit;
  const urls = verdictSourceUrls(chain, address);
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const honeypotUrl = honeypotIsUrl(chain, address);
  const jobs = [readSource(() => fetchJson(urls.goplus)), readSource(() => fetchJson(urls.dexscreener))];
  if (honeypotUrl) jobs.push(readSource(() => fetchJson(honeypotUrl)));
  const [gp, ds, hpRaw] = await Promise.all(jobs);
  const goplus = parseGoPlus(chain, address, gp);
  const dex = parseDex(ds);
  const honeypot = !honeypotUrl
    ? { status: 'unsupported', detail: 'no_evm_endpoint', body: null }
    : (hpRaw.ok ? { status: 'ok', detail: null, body: hpRaw.body } : { status: 'error', detail: hpRaw.detail, body: null });
  if (failedLookup(goplus, dex)) return { error: 'upstream data unavailable, retry shortly', http: 503, sourceStatus: { goplus: goplus.status === 'error' ? goplus.detail : goplus.status, dexscreener: dex.status === 'error' ? dex.detail : dex.status, honeypotIs: honeypot.status === 'error' ? honeypot.detail : honeypot.status } };
  const now = opts.now || Date.now();
  const data = buildDeepVerdict(chain, address, { goplus, dex, honeypot, urls, honeypotUrl, fetchedAt: new Date(now).toISOString() }, now);
  cacheSet(deepCache, key, data);
  return data;
}

// ---------- Token brief ($0.01 screen + market snapshot) ----------
const briefCache = new Map();
export function _resetBriefCache() { briefCache.clear(); }

export function marketSnapshotFromPairs(pairs) {
  const empty = { priceUsd: null, change24hPct: null, volume24hUsd: null, liquidityUsd: null, fdvUsd: null, status: 'UNKNOWN' };
  if (!Array.isArray(pairs) || !pairs.length) return empty;
  const p = [...pairs].sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))[0];
  const pick = v => { const n = num(v); return n == null ? null : r2(n); };
  const snap = {
    priceUsd: pick(p.priceUsd),
    change24hPct: pick(p.priceChange && p.priceChange.h24),
    volume24hUsd: pick(p.volume && p.volume.h24),
    liquidityUsd: pick(p.liquidity && p.liquidity.usd),
    fdvUsd: pick(p.fdv)
  };
  const known = Object.values(snap).filter(v => v != null).length;
  snap.status = known === 5 ? 'ok' : known === 0 ? 'UNKNOWN' : 'partial';
  return snap;
}

export function buildTokenBrief(chain, address, input, now = Date.now()) {
  const fetchedAt = input.fetchedAt || new Date(now).toISOString();
  const screen = scoreVerdict(chain, address, { goplus: input.goplus, dex: input.dex, urls: input.urls, fetchedAt }, now);
  return { ...screen, engine: 'gw8-token-brief/1', marketSnapshot: marketSnapshotFromPairs(input.dex.pairs) };
}

export async function getTokenBrief(chain, address, opts = {}) {
  const bad = validVerdictInput(chain, address);
  if (bad) return { error: bad, http: 400 };
  const fresh = freshOf(opts);
  const key = `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
  const hit = cacheGet(briefCache, key, fresh);
  if (hit) return hit;
  const urls = verdictSourceUrls(chain, address);
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const [gp, ds] = await Promise.all([readSource(() => fetchJson(urls.goplus)), readSource(() => fetchJson(urls.dexscreener))]);
  const goplus = parseGoPlus(chain, address, gp);
  const dex = parseDex(ds);
  if (failedLookup(goplus, dex)) return { error: 'upstream data unavailable, retry shortly', http: 503, sourceStatus: { goplus: goplus.status === 'error' ? goplus.detail : goplus.status, dexscreener: dex.status === 'error' ? dex.detail : dex.status } };
  const now = opts.now || Date.now();
  const data = buildTokenBrief(chain, address, { goplus, dex, urls, fetchedAt: new Date(now).toISOString() }, now);
  cacheSet(briefCache, key, data);
  return data;
}

// ---------- Crypto bottom-watch ----------
export const SIGNAL_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'AAVE', 'HYPE', 'MON', 'CC'];
export const SIGNAL_PAIRS = {
  BTC: { kraken: 'XBTUSD', binance: 'BTCUSDT' },
  ETH: { kraken: 'ETHUSD', binance: 'ETHUSDT' },
  SOL: { kraken: 'SOLUSD', binance: 'SOLUSDT' },
  XRP: { kraken: 'XRPUSD', binance: 'XRPUSDT' },
  AAVE: { kraken: 'AAVEUSD', binance: 'AAVEUSDT' },
  HYPE: { kraken: 'HYPEUSD', binance: 'HYPEUSDT' },
  MON: { kraken: 'MONUSD', binance: 'MONUSDT' },
  CC: { kraken: 'CCUSD', binance: 'CCUSDT' }
};
const INTERVAL_SEC = { 1440: 86400, 240: 14400 };

export function krakenOhlcUrl(pair, interval) {
  return `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`;
}
export function binanceKlineUrl(symbol, interval) {
  const iv = interval === 1440 ? '1d' : '4h';
  const limit = interval === 1440 ? 40 : 30;
  return `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${iv}&limit=${limit}`;
}
export function binanceFundingUrl(symbol) {
  return `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=10`;
}

function closedRows(rows, intervalSec, now) {
  return rows.filter(c => c.t + intervalSec * 1000 <= now);
}
export function parseKrakenOhlc(body, interval, now = Date.now()) {
  if (!body || typeof body !== 'object') throw new Error('bad_json');
  if (Array.isArray(body.error) && body.error.length) throw new Error(body.error.join(','));
  const key = body.result && Object.keys(body.result).find(k => k !== 'last');
  const raw = key ? body.result[key] : null;
  if (!Array.isArray(raw)) throw new Error('bad_json');
  const rows = raw.map(x => ({ t: Number(x[0]) * 1000, o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6] }));
  return closedRows(rows, INTERVAL_SEC[interval] || 86400, now);
}
export function parseBinanceKlines(body, interval, now = Date.now()) {
  if (!Array.isArray(body)) throw new Error('bad_json');
  const rows = body.map(x => ({ t: Number(x[0]), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
  return closedRows(rows, INTERVAL_SEC[interval] || 86400, now);
}
export function parseFundingRates(body) {
  if (!Array.isArray(body)) return [];
  return body.map(x => num(x && (x.fundingRate != null ? x.fundingRate : x.rate))).filter(n => n != null);
}

export function rsiSeries(closes, period = 14) {
  if (!closes || closes.length < period + 1) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  const out = new Array(period).fill(null);
  const value = () => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out.push(value());
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(value());
  }
  return out;
}

function blankTells() {
  return { sweep_reclaim: null, volume_2x: null, rsi_turn: null, higher_low_4h: null, funding_flush: null };
}
function countTells(tells) {
  return Object.values(tells).filter(v => v === true).length;
}
export function tierFor(tellsCount, btcReclaimed) {
  if (tellsCount >= 2 && btcReclaimed) return 'CONFIRMED';
  if (tellsCount >= 2) return 'EARLY_TELL';
  return 'NONE';
}

export function evaluateCoin(symbol, input = {}) {
  const daily = Array.isArray(input.daily) ? input.daily : [];
  const h4 = Array.isArray(input.h4) ? input.h4 : [];
  const funding = Array.isArray(input.funding) ? input.funding.filter(n => Number.isFinite(n)) : null;
  if (!daily.length) {
    return { symbol, status: 'unavailable', source: input.source || null, tells: blankTells(), tells_count: 0, tier: 'NONE', detail: { error: 'candle data unavailable' } };
  }
  const tells = blankTells();
  const detail = {};
  const last = daily[daily.length - 1];
  if (daily.length >= 31) {
    const prior = daily.slice(-31, -1);
    const low30 = Math.min(...prior.map(c => c.l));
    tells.sweep_reclaim = last.l < low30 && last.c > low30;
    detail.priorLow30 = r2(low30);
    detail.lastLow = r2(last.l);
    detail.lastClose = r2(last.c);
  }
  if (daily.length >= 11) {
    const base = daily.slice(-21, -1).map(c => c.v).filter(v => Number.isFinite(v));
    const avg = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;
    tells.volume_2x = avg > 0 && last.v >= avg * 2;
    detail.volume = r2(last.v);
    detail.volumeBaseline = r2(avg);
  }
  const rsi = rsiSeries(daily.map(c => c.c));
  if (rsi.length >= 2 && rsi[rsi.length - 1] != null && rsi[rsi.length - 2] != null) {
    const cur = rsi[rsi.length - 1], prev = rsi[rsi.length - 2];
    tells.rsi_turn = prev <= 30 && cur > prev;
    detail.rsi = r2(cur);
    detail.rsiPrev = r2(prev);
  }
  if (h4.length >= 12) {
    const window = h4.slice(-12);
    const priorLow = Math.min(...window.slice(0, 6).map(c => c.l));
    const recentLow = Math.min(...window.slice(6).map(c => c.l));
    tells.higher_low_4h = recentLow > priorLow;
    detail.higherLowPrior = r2(priorLow);
    detail.higherLowRecent = r2(recentLow);
  }
  if (funding && funding.length >= 3) {
    const prev = funding.slice(0, -1);
    const minPrev = Math.min(...prev);
    const latest = funding[funding.length - 1];
    tells.funding_flush = minPrev <= -0.0003 && latest > minPrev && latest >= minPrev * 0.5;
    detail.fundingMin = minPrev;
    detail.fundingLatest = latest;
  }
  const tells_count = countTells(tells);
  return { symbol, status: 'ok', source: input.source || null, tells, tells_count, tier: 'NONE', detail };
}

export function evaluateBottoms(input = {}) {
  const bySymbol = input.coins || {};
  const preliminary = SIGNAL_COINS.map(symbol => evaluateCoin(symbol, bySymbol[symbol] || {}));
  const btc = preliminary.find(c => c.symbol === 'BTC');
  const btcReclaimed = !!(btc && btc.tells && btc.tells.sweep_reclaim === true);
  const coins = preliminary.map(c => ({ ...c, tier: c.status === 'unavailable' ? 'NONE' : tierFor(c.tells_count, btcReclaimed) }));
  const ready = coins.some(c => c.status === 'ok');
  return {
    engine: 'gw8-crypto-bottom/1',
    asOf: new Date(input.now || Date.now()).toISOString(),
    cached: false,
    cacheTtlSec: VERDICT_TTL_SEC,
    disclaimer: BOTTOM_DISCLAIMER,
    label: 'Research data, not financial advice.',
    tierRule: BOTTOM_TIER_RULE,
    btcReclaimed,
    coins,
    ready
  };
}

const bottomCache = { t: 0, data: null, inflight: null };
export function _resetBottomsCache() { bottomCache.t = 0; bottomCache.data = null; bottomCache.inflight = null; }

async function loadSeries(url, parse, fetchJson) {
  const body = await fetchJson(url);
  return parse(body);
}
async function loadCandles(spec, interval, fetchJson, now) {
  try {
    const rows = await loadSeries(krakenOhlcUrl(spec.kraken, interval), body => parseKrakenOhlc(body, interval, now), fetchJson);
    if (rows.length) return { rows, source: 'kraken' };
  } catch { /* public fallback below */ }
  try {
    const rows = await loadSeries(binanceKlineUrl(spec.binance, interval), body => parseBinanceKlines(body, interval, now), fetchJson);
    if (rows.length) return { rows, source: 'binance' };
  } catch { /* coin stays unavailable */ }
  return { rows: [], source: null };
}
async function loadFunding(spec, fetchJson) {
  try {
    const rates = parseFundingRates(await fetchJson(binanceFundingUrl(spec.binance)));
    return rates.length ? rates : null;
  } catch { return null; }
}

export async function getCryptoBottoms(opts = {}) {
  const fresh = freshOf(opts);
  if (!fresh && bottomCache.data && Date.now() - bottomCache.t < TTL) {
    const ageSec = Math.max(0, Math.round((Date.now() - bottomCache.t) / 1000));
    return { ...bottomCache.data, cached: true, freshness: { cached: true, ageSec, cacheTtlSec: VERDICT_TTL_SEC } };
  }
  if (!fresh && bottomCache.inflight) return bottomCache.inflight;
  const run = (async () => {
    const fetchJson = opts.fetchJson || defaultFetchJson;
    const now = opts.now || Date.now();
    const coins = {};
    await Promise.all(SIGNAL_COINS.map(async symbol => {
      const spec = SIGNAL_PAIRS[symbol];
      const [daily, h4, funding] = await Promise.all([
        loadCandles(spec, 1440, fetchJson, now),
        loadCandles(spec, 240, fetchJson, now),
        loadFunding(spec, fetchJson)
      ]);
      const source = daily.source || h4.source || null;
      coins[symbol] = { daily: daily.rows, h4: h4.rows, funding, source };
    }));
    const data = evaluateBottoms({ coins, now });
    if (!data.ready) return { error: 'upstream data unavailable, retry shortly', http: 503, sourceStatus: { candles: 'unavailable' } };
    const { ready, ...out } = data;
    bottomCache.t = Date.now();
    bottomCache.data = out;
    return out;
  })();
  bottomCache.inflight = run;
  try { return await run; }
  finally { bottomCache.inflight = null; }
}
