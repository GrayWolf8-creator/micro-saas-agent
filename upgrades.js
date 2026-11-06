// upgrades.js — token safety verdict, large-flow summary, daily brief, response signing.
// Public data only (GoPlus, DexScreener, Kraken). No API keys, no trading, no execution.
import crypto from 'crypto';
import { getDots, getRegime, getCoin, COINS, PAIRS_MAP } from './Signal.js';
import { getTrack } from './track.js';

const DISCLAIMER = 'signal only, not financial advice';
const r2 = v => Math.round(v * 100) / 100;
const getJson = async (url, ms = 12000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

// ---------- 1. Token safety verdict ----------
// Chains both GoPlus token-security and DexScreener answer without an API key. Tron is omitted (different address form).
export const VERDICT_CHAINS = {
  ethereum: '1', bsc: '56', polygon: '137', avalanche: '43114', cronos: '25', gnosis: '100',
  optimism: '10', base: '8453', arbitrum: '42161', opbnb: '204', zksync: '324', linea: '59144',
  scroll: '534352', mantle: '5000', blast: '81457', unichain: '130', berachain: '80094', sonic: '146',
  worldchain: '480', abstract: '2741', soneium: '1868', story: '1514', solana: 'solana'
};
export const VERDICT_LABELS = ['CLEAR', 'CAUTION', 'AVOID', 'UNKNOWN'];
export const VERDICT_TTL_SEC = 600;
export const VERDICT_NOTE = 'Factual screen of public GoPlus and DexScreener records. CLEAR means the score is at least 75, no limiting unknown is open, and no control rule that blocks CLEAR fired. It is not a guarantee that a transfer will succeed.';
// Kept under the CDP 500-char resource.description cap after the catalog category prefix.
// Phrases match how paying agents search Bazaar (honeypot check, token safety, rug pull, scam token).
export const VERDICT_BLURB = 'A honeypot check and token safety screen for token security: honeypot, rug pull, rug check, scam token, and contract risk before a swap, transfer, or approval. Returns CLEAR, CAUTION, AVOID, or UNKNOWN with score, reasons, unknowns, sources, and freshness. GoPlus plus DexScreener. $0.01 USDC.';
// Bazaar resource metadata: serviceName is printable ASCII and at most 32 characters; tags are at most
// five entries, each printable ASCII and at most 32 characters. Facilitators drop tags past five.
// "token safety" is the plain phrase in place of the hyphenated token-safety tag. honeypot, rug-pull,
// scam-token, and contract-risk stay. This wording does not control or promise CDP search rank.
export const VERDICT_TAGS = ['honeypot', 'token safety', 'rug-pull', 'scam-token', 'contract-risk'];
export const VERDICT_SERVICE_NAME = 'GW8 Token Safety Verdict';
const VTTL = VERDICT_TTL_SEC * 1000;
const AVOID_CODES = new Set(['honeypot', 'cannot_sell_all', 'non_transferable', 'balance_mutable', 'airdrop_scam', 'fake_token']);
const BLOCKS_CLEAR = new Set(['freeze_authority', 'mint_authority', 'mintable', 'pausable', 'hidden_owner', 'ownership_reclaim', 'owner_change_balance', 'unverified', 'lp_unlocked']);
const BURNS = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
const flag = v => v === '1' || v === 1 || v === true;
export const VERDICT_RULES = [
  'Start at 100 and clamp to 0-100. UNKNOWN is not scored (score is null).',
  'EVM: honeypot -100; cannot sell all -40; buy or sell tax >10% -30 (>=5% -10); hidden owner -25; owner can take back ownership -25; owner can change balances -30; selfdestruct -25; mintable -15; trading pausable -15; blacklist -10; whitelist -10; transfer cooldown -10; tax modifiable -15; per-address tax -15; proxy -10; source not verified -25; external call -10; cannot buy -20; creator linked to a honeypot -25; fake token -40; airdrop-scam flag -40.',
  'EVM: top-10 holders excluding locked and contract-tagged rows >80% -20 (>50% -10); creator holds >20% -10; GoPlus says not in any DEX -15. LP lock is scored only when GoPlus returns lp_holders: locked or burned under 50% -20. A missing LP list is reported and does not change the score.',
  'Solana: mint authority -20; freeze authority -25; balances mutable by authority -40; non-transferable -40; transfer fee -15; metadata mutable -5; closable -10.',
  'Market (DexScreener): no pairs -20; top pair liquidity under $10k -20 (under $50k -10); pair younger than 24h -10.',
  'AVOID if honeypot, cannot sell all, non-transferable, mutable balances, airdrop-scam, fake token, or score < 40. UNKNOWN if both sources answered and there is no security record and no pair. CLEAR if score >= 75, every unknown has limitsVerdict false, and none of these fired: freeze authority, mint authority, mintable, pausable, hidden owner, ownership reclaim, owner can change balances, unverified source, LP unlocked. Otherwise CAUTION.',
  'limitsVerdict true means a source failed, the security record is missing, or no DEX pair was found. Those block CLEAR. A completed UNKNOWN is a finished lookup. A failed lookup (both sources down, or the only source that answered had nothing on file) returns an error and is not a verdict.'
];
export const VERDICT_EXAMPLE = {
  chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', verdict: 'CLEAR', score: 90,
  reasons: [{ code: 'proxy', points: -10, detail: 'upgradeable proxy: contract risk, not a honeypot, rug pull, or scam token' }],
  unknowns: [],
  sources: [
    { name: 'goplus', status: 'ok', url: 'https://api.gopluslabs.io/' },
    { name: 'dexscreener', status: 'ok', url: 'https://api.dexscreener.com/' }
  ],
  freshness: { checkedAt: '2026-11-05T00:00:00.000Z', cached: false, cacheTtlSec: VERDICT_TTL_SEC, ageSec: 0 }
};
export const VERDICT_OUTPUT_SCHEMA = {
  type: 'object',
  description: 'Honeypot check output: token safety and token security screen. verdict is CLEAR, CAUTION, AVOID, or UNKNOWN. AVOID covers a honeypot, rug pull, or scam token. reasons[].code honeypot means the honeypot check failed.',
  additionalProperties: true,
  properties: {
    chain: { type: 'string', description: 'Chain the honeypot check ran on.' },
    address: { type: 'string', description: 'Token contract screened for honeypot, rug pull, scam token, token security, and contract risk.' },
    verdict: { type: 'string', enum: VERDICT_LABELS, description: 'Token safety verdict: CLEAR, CAUTION, AVOID, or UNKNOWN. AVOID includes honeypot, rug pull, and scam token.' },
    score: { type: 'number', description: 'Token security score 0-100. Null when the honeypot check verdict is UNKNOWN.' },
    reasons: { type: 'array', description: 'Honeypot check, rug pull, scam token, and contract risk rules that fired.', items: { type: 'object', required: ['code', 'points', 'detail'], properties: { code: { type: 'string', description: 'Rule id. honeypot means a honeypot or sell-blocking scam token. Other codes cover rug pull and contract risk.' }, points: { type: 'number' }, detail: { type: 'string' } } } },
    unknowns: { type: 'array', items: { type: 'object', required: ['code', 'detail', 'limitsVerdict'], properties: { code: { type: 'string' }, detail: { type: 'string' }, limitsVerdict: { type: 'boolean' } } } },
    sources: { type: 'array' },
    freshness: { type: 'object', properties: { checkedAt: { type: 'string' }, cached: { type: 'boolean' }, cacheTtlSec: { type: 'number' }, ageSec: { type: 'number' } }, required: ['checkedAt', 'cached', 'cacheTtlSec', 'ageSec'] }
  },
  required: ['verdict', 'score', 'reasons', 'unknowns', 'sources', 'freshness']
};
export const VERDICT_PATH_SCHEMA = {
  chain: { type: 'string', enum: Object.keys(VERDICT_CHAINS), description: 'Chain for a honeypot check: token safety, token security, rug pull, scam token, or contract risk' },
  address: { type: 'string', description: 'Token contract (0x and 40 hex) or Solana mint (base58) to honeypot-check for rug pull, scam token, and contract risk' }
};
const vcache = new Map();
export function _resetVerdictCache() { vcache.clear(); }
export function validVerdictInput(chain, address) {
  if (!VERDICT_CHAINS[chain]) return 'unsupported chain';
  if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : !/^0x[0-9a-fA-F]{40}$/.test(address)) return 'invalid address';
  return null;
}
export function verdictSourceUrls(chain, address) {
  const id = VERDICT_CHAINS[chain];
  const evm = chain === 'solana' ? address : address.toLowerCase();
  const goplus = chain === 'solana'
    ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(address)}`
    : `https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${evm}`;
  return { goplus, dexscreener: `https://api.dexscreener.com/tokens/v1/${chain}/${encodeURIComponent(evm)}` };
}
const FETCH_MS = 8000;
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
function readGoPlus(chain, address, got) {
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
function readDex(got) {
  if (!got.ok) return { status: 'error', detail: got.detail, pairs: [] };
  if (!Array.isArray(got.body)) return { status: 'error', detail: 'bad_json', pairs: [] };
  return got.body.length ? { status: 'ok', detail: null, pairs: got.body } : { status: 'empty', detail: 'no_pairs', pairs: [] };
}
// Failed lookup: nothing factual to return. The paid route sees `error` and does not settle.
function failedLookup(goplus, dex) {
  const gpDead = goplus.status === 'error';
  const dexDead = dex.status === 'error';
  if (gpDead && dexDead) return true;
  if (gpDead && dex.status === 'empty') return true;
  if (dexDead && goplus.status === 'empty') return true;
  return false;
}
function sourceStatus(goplus, dex) {
  return {
    goplus: goplus.status === 'error' ? goplus.detail : goplus.status,
    dexscreener: dex.status === 'error' ? dex.detail : dex.status
  };
}
function lpCoveredPct(holders) {
  let covered = 0;
  for (const h of holders) {
    const pct = Number(h.percent) || 0;
    const addr = String(h.address || h.token_account || '').toLowerCase();
    const tag = String(h.tag || '').toLowerCase();
    if (flag(h.is_locked) || tag.includes('lock') || BURNS.has(addr) || tag.includes('burn')) covered += pct;
  }
  return covered * 100;
}
export function scoreVerdict(chain, address, input, now = Date.now()) {
  const goplus = input.goplus, dex = input.dex;
  const fetchedAt = input.fetchedAt || new Date(now).toISOString();
  const urls = input.urls || verdictSourceUrls(chain, address);
  const sources = [
    { name: 'goplus', url: urls.goplus, status: goplus.status, ...(goplus.detail ? { detail: goplus.detail } : {}), fetchedAt },
    { name: 'dexscreener', url: urls.dexscreener, status: dex.status, ...(dex.detail ? { detail: dex.detail } : {}), fetchedAt }
  ];
  const freshness = { checkedAt: fetchedAt, cached: false, cacheTtlSec: VERDICT_TTL_SEC, ageSec: 0 };
  const base = { engine: 'gw8-token-verdict/2', chain, address, sources, freshness, checkedAt: fetchedAt, cached: false, rules: VERDICT_RULES, note: VERDICT_NOTE, disclaimer: VERDICT_NOTE, coverage: { chains: Object.keys(VERDICT_CHAINS) } };
  if (goplus.status === 'empty' && dex.status === 'empty') {
    return { ...base, verdict: 'UNKNOWN', score: null, market: null, token: null,
      reasons: [{ code: 'no_record', points: 0, detail: 'GoPlus has no token security record and DexScreener has no pairs for this address.' }],
      unknowns: [
        { code: 'goplus_no_record', detail: 'GoPlus token security has no row for this address.', limitsVerdict: true },
        { code: 'dex_no_pairs', detail: 'DexScreener returned no pairs for this address.', limitsVerdict: true }
      ] };
  }
  let score = 100;
  const reasons = [], unknowns = [];
  const hit = (code, points, detail) => { score -= points; reasons.push({ code, points: -points, detail }); };
  const t = goplus.token;
  if (goplus.status === 'error') unknowns.push({ code: 'goplus_unavailable', detail: `GoPlus token security did not answer (${goplus.detail}).`, limitsVerdict: true });
  else if (goplus.status === 'empty') {
    hit('no_security_record', 15, 'no GoPlus token security record');
    unknowns.push({ code: 'goplus_no_record', detail: 'GoPlus token security has no row for this address.', limitsVerdict: true });
  }
  if (t && chain !== 'solana') {
    if (flag(t.is_honeypot)) hit('honeypot', 100, 'GoPlus is_honeypot=1');
    if (flag(t.cannot_sell_all)) hit('cannot_sell_all', 40, 'cannot sell the full balance');
    const tax = Math.max(Number(t.buy_tax) || 0, Number(t.sell_tax) || 0) * 100;
    if (tax > 10) hit('tax', 30, `buy or sell tax ${r2(tax)}%`);
    else if (tax >= 5) hit('tax', 10, `buy or sell tax ${r2(tax)}%`);
    if (flag(t.hidden_owner)) hit('hidden_owner', 25, 'hidden owner');
    if (flag(t.can_take_back_ownership)) hit('ownership_reclaim', 25, 'owner can take back ownership');
    if (flag(t.owner_change_balance)) hit('owner_change_balance', 30, 'owner can change balances');
    if (flag(t.selfdestruct)) hit('selfdestruct', 25, 'selfdestruct present');
    if (flag(t.is_mintable)) hit('mintable', 15, 'mint function present');
    if (flag(t.transfer_pausable)) hit('pausable', 15, 'transfers can be paused');
    if (flag(t.is_blacklisted)) hit('blacklist', 10, 'blacklist function present');
    if (flag(t.is_whitelisted)) hit('whitelist', 10, 'whitelist function present');
    if (flag(t.trading_cooldown)) hit('cooldown', 10, 'transfer cooldown present');
    if (flag(t.slippage_modifiable)) hit('tax_modifiable', 15, 'tax can be changed');
    if (flag(t.personal_slippage_modifiable)) hit('personal_tax', 15, 'per-address tax can be changed');
    if (flag(t.is_proxy)) hit('proxy', 10, 'upgradeable proxy');
    if (t.is_open_source === '0') hit('unverified', 25, 'source not verified');
    if (flag(t.external_call)) hit('external_call', 10, 'contract makes external calls');
    if (flag(t.cannot_buy)) hit('cannot_buy', 20, 'buys are blocked');
    if (flag(t.honeypot_with_same_creator)) hit('creator_honeypot', 25, 'same creator is linked to a honeypot');
    if (flag(t.is_airdrop_scam)) hit('airdrop_scam', 40, 'GoPlus airdrop-scam flag');
    const fake = t.fake_token;
    if ((fake && flag(fake.value)) || t.is_true_token === '0') hit('fake_token', 40, 'flagged as a fake of another token');
    if (Array.isArray(t.holders) && t.holders.length) {
      const top = t.holders.filter(h => !flag(h.is_locked) && !flag(h.is_contract)).slice(0, 10).reduce((a, h) => a + (Number(h.percent) || 0), 0) * 100;
      if (top > 80) hit('holder_concentration', 20, `top holders own ${r2(top)}%`);
      else if (top > 50) hit('holder_concentration', 10, `top holders own ${r2(top)}%`);
    }
    if (Number(t.creator_percent) * 100 > 20) hit('creator_balance', 10, `creator holds ${r2(Number(t.creator_percent) * 100)}%`);
    if (t.is_in_dex === '0') hit('not_in_dex', 15, 'GoPlus has not seen this token on a DEX');
    if (Array.isArray(t.lp_holders) && t.lp_holders.length) {
      const covered = lpCoveredPct(t.lp_holders);
      if (covered < 50) hit('lp_unlocked', 20, `LP locked or burned ${r2(covered)}%`);
    } else unknowns.push({ code: 'lp_lock', detail: 'GoPlus did not include LP lock or burn status.', limitsVerdict: false });
  } else if (t && chain === 'solana') {
    const on = f => f && f.status === '1';
    if (on(t.mintable)) hit('mint_authority', 20, 'mint authority active');
    if (on(t.freezable)) hit('freeze_authority', 25, 'freeze authority active');
    if (on(t.balance_mutable_authority)) hit('balance_mutable', 40, 'balances mutable by authority');
    if (t.non_transferable === '1') hit('non_transferable', 40, 'non-transferable');
    if (t.transfer_fee && Object.keys(t.transfer_fee).length) hit('transfer_fee', 15, 'transfer fee set');
    if (on(t.metadata_mutable)) hit('metadata_mutable', 5, 'metadata mutable');
    if (on(t.closable)) hit('closable', 10, 'token account closable');
  }
  let market = null;
  if (dex.status === 'error') unknowns.push({ code: 'dexscreener_unavailable', detail: `DexScreener did not answer (${dex.detail}).`, limitsVerdict: true });
  else if (dex.status === 'empty') {
    hit('no_pairs', 20, 'no DEX pairs found');
    unknowns.push({ code: 'dex_no_pairs', detail: 'DexScreener returned no pairs for this address.', limitsVerdict: true });
  } else {
    const pairs = [...dex.pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pairs[0], liq = Number(p.liquidity?.usd) || 0;
    const ageMs = p.pairCreatedAt ? now - Number(p.pairCreatedAt) : null;
    market = { symbol: p.baseToken?.symbol || null, priceUsd: Number(p.priceUsd) || null, liquidityUsd: liq, volume24hUsd: p.volume?.h24 ?? null, pairs: pairs.length, topPair: p.url || null, pairAgeHours: ageMs == null ? null : Math.round(ageMs / 36e5) };
    if (liq < 10000) hit('low_liquidity', 20, `top pair liquidity $${Math.round(liq)}`);
    else if (liq < 50000) hit('thin_liquidity', 10, `top pair liquidity $${Math.round(liq)}`);
    if (ageMs != null && ageMs >= 0 && ageMs < 86400000) hit('new_pair', 10, 'top pair younger than 24h');
  }
  score = Math.max(0, Math.min(100, score));
  const hard = reasons.some(r => AVOID_CODES.has(r.code));
  const blocksClear = reasons.some(r => BLOCKS_CLEAR.has(r.code));
  const limited = unknowns.some(u => u.limitsVerdict);
  const verdict = hard || score < 40 ? 'AVOID' : (limited || blocksClear || score < 75) ? 'CAUTION' : 'CLEAR';
  if (!reasons.length) reasons.push({ code: 'no_flags', points: 0, detail: 'No published rule fired on the records retrieved.' });
  const token = t ? { name: t.token_name || t.metadata?.name || null, symbol: t.token_symbol || t.metadata?.symbol || null, holders: t.holder_count ? Number(t.holder_count) : null, trustListed: flag(t.trust_list) } : null;
  return { ...base, verdict, score, reasons, unknowns, market, token };
}
export async function getVerdict(chain, address, opts = {}) {
  const bad = validVerdictInput(chain, address);
  if (bad) return { error: bad, http: 400 };
  const fresh = opts.fresh === true || opts.fresh === '1' || opts.fresh === 1;
  const key = `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
  if (!fresh) {
    const hit = vcache.get(key);
    if (hit && Date.now() - hit.t < VTTL) {
      const ageSec = Math.max(0, Math.round((Date.now() - hit.t) / 1000));
      return { ...hit.data, cached: true, freshness: { ...hit.data.freshness, cached: true, ageSec } };
    }
  }
  const urls = verdictSourceUrls(chain, address);
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const [gp, ds] = await Promise.all([readSource(() => fetchJson(urls.goplus)), readSource(() => fetchJson(urls.dexscreener))]);
  const goplus = readGoPlus(chain, address, gp);
  const dex = readDex(ds);
  if (failedLookup(goplus, dex)) return { error: 'upstream data unavailable, retry shortly', http: 503, sourceStatus: sourceStatus(goplus, dex) };
  const data = scoreVerdict(chain, address, { goplus, dex, urls, fetchedAt: new Date().toISOString() });
  vcache.set(key, { t: Date.now(), data });
  if (vcache.size > 2000) vcache.delete(vcache.keys().next().value);
  return data;
}

// ---------- 4. Large-flow summary (Kraken public trades) ----------
const fcache = new Map(); const FTTL = 5 * 60 * 1000;
export async function getFlows(sym) {
  const hit = fcache.get(sym); if (hit && Date.now() - hit.t < FTTL) return hit.data;
  const pair = PAIRS_MAP[sym];
  const url = `https://api.kraken.com/0/public/Trades?pair=${pair}&count=1000`;
  let flows;
  try {
    const j = await getJson(url); if (j.error?.length) throw new Error(j.error.join(','));
    const trades = Object.entries(j.result).find(([k]) => k !== 'last')[1].map(x => ({ p: +x[0], v: +x[1], t: x[2], side: x[3] === 'b' ? 'buy' : 'sell', usd: +x[0] * +x[1] }));
    const sorted = trades.map(x => x.usd).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const thr = Math.max(10000, p95);
    const big = trades.filter(x => x.usd >= thr);
    const sum = (arr, s) => r2(arr.filter(x => x.side === s).reduce((a, x) => a + x.usd, 0));
    const bb = sum(big, 'buy'), bs = sum(big, 'sell'), ab = sum(trades, 'buy'), as = sum(trades, 'sell');
    flows = { source: url, window: { trades: trades.length, from: new Date(trades[0].t * 1000).toISOString(), to: new Date(trades[trades.length - 1].t * 1000).toISOString() },
      largePrintThresholdUsd: r2(thr), largePrints: { count: big.length, buyUsd: bb, sellUsd: bs, netUsd: r2(bb - bs), top: big.sort((a, b) => b.usd - a.usd).slice(0, 5).map(x => ({ side: x.side, usd: r2(x.usd), price: x.p, at: new Date(x.t * 1000).toISOString() })) },
      allPrints: { buyUsd: ab, sellUsd: as, netUsd: r2(ab - as), buyRatio: ab + as ? r2(ab / (ab + as)) : null },
      bias: big.length < 3 ? 'insufficient large prints' : bb > bs * 1.5 ? 'large buyers dominant' : bs > bb * 1.5 ? 'large sellers dominant' : 'balanced' };
  } catch (e) { flows = { error: 'Kraken trades unavailable, retry shortly' }; }
  const c = await getCoin(sym).catch(() => null);
  const latestDot = c?.dots?.length ? c.dots[c.dots.length - 1] : null;
  const data = { symbol: sym, asOf: new Date().toISOString(), flows,
    wavetrend: c && !c.error ? { wt1: c.wt1, wt2: c.wt2, state: c.wt1 > c.wt2 ? 'wt1 above wt2 (rising)' : 'wt1 below wt2 (falling)', zone: c.wt1 <= -53 ? 'oversold' : c.wt1 >= 53 ? 'overbought' : 'neutral', latestDot } : null,
    limits: 'Large prints = Kraken spot taker trades (last 1000 public trades, threshold = max($10k, 95th percentile notional). Single venue only; not on-chain whale wallets, not other exchanges, no derivatives. Side = taker side.',
    disclaimer: DISCLAIMER };
  fcache.set(sym, { t: Date.now(), data });
  return data;
}

// ---------- 3. Daily brief (built once per America/Denver date) ----------
let brief = null, briefInflight = null;
const mtDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
async function buildBrief(date) {
  const [regime, dots] = await Promise.all([getRegime(), getDots()]);
  const strength = d => (d.kind === 'green' ? 1 : -1) * Math.abs(d.wt1) * (d.band === 'outer' ? 1.25 : 1) * (d.latest ? 1.1 : 1);
  const all = (dots.bandDots || []).map(d => ({ ...d, strength: r2(strength(d)) }));
  const top = [...all].sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength)).filter((d, i, a) => a.findIndex(x => x.name === d.name) === i).slice(0, 10);
  if (top.length < 10) { // fill with coins nearest the bands (no dot yet), clearly labeled
    const rest = [];
    for (const sym of COINS) { if (top.some(d => d.name === sym)) continue; const c = await getCoin(sym).catch(() => null); if (c && typeof c.wt1 === 'number') rest.push({ name: sym, kind: 'none', note: c.wt1 < 0 ? 'nearest oversold band, no dot' : 'nearest overbought band, no dot', wt1: c.wt1, wt2: c.wt2, strength: r2(Math.abs(c.wt1) * 0.5) }); }
    top.push(...rest.sort((a, b) => Math.abs(b.wt1) - Math.abs(a.wt1)).slice(0, 10 - top.length));
  }
  const flows = [];
  for (const sym of ['BTC', 'ETH', 'SOL']) { const f = await getFlows(sym); flows.push({ symbol: sym, bias: f.flows?.bias ?? null, largeNetUsd: f.flows?.largePrints?.netUsd ?? null, buyRatio: f.flows?.allPrints?.buyRatio ?? null }); }
  return { date, timezone: 'America/Denver', builtAt: new Date().toISOString(),
    regime: regime.error ? regime : { score: regime.score, outOf: 4, checks: Object.fromEntries(Object.entries(regime.checks || {}).map(([k, v]) => [k, v.status])) },
    dots: { asOf: dots.asOf, green: all.filter(d => d.kind === 'green').length, red: all.filter(d => d.kind === 'red').length },
    top10ByDotStrength: top, flowsSummary: flows,
    notes: ['Built once per Mountain Time day; intraday data may have changed since builtAt.', 'Coins without a recent band dot are filled in by |wt1| (closest to a band) and marked kind=none; strength for those is wt1-based and half-weighted.', 'Dot strength = |wt1| x 1.25 if outer band x 1.1 if on latest bar; sign = green(+)/red(-).', 'In our 90-day backtest green dots led (outer green ~64% higher after 3d); red dots were near coin-flip.', 'Flows are Kraken-only taker prints, not on-chain whale data.'],
    disclaimer: 'signal only, past performance is not indicative of future results, not financial advice' };
}
export async function getBrief() {
  const d = mtDate();
  if (brief && brief.date === d && !brief.regime?.error) return brief;
  if (!briefInflight) briefInflight = buildBrief(d).then(b => (brief = b)).finally(() => { briefInflight = null; });
  try { return await briefInflight; } catch (e) { return { error: 'upstream data unavailable, retry shortly' }; }
}


// ---------- Free brief teaser (partial live brief; 15-min cache) ----------
let teaserCache = null, teaserInflight = null;
const TEASER_TTL = 15 * 60 * 1000;
export async function getBriefTeaser() {
  if (teaserCache && Date.now() - teaserCache.t < TEASER_TTL) return { ...teaserCache.data, cached: true };
  if (!teaserInflight) teaserInflight = (async () => {
    const [regime, dots, track] = await Promise.all([
      getRegime().catch(() => ({ error: true })),
      getDots().catch(() => ({ error: true, bandDots: [] })),
      getTrack().catch(() => null)
    ]);
    if (regime.error && (!dots.bandDots || !dots.bandDots.length)) throw new Error('upstream unavailable');
    const all = dots.bandDots || [];
    const strength = d => (d.kind === 'green' ? 1 : -1) * Math.abs(d.wt1) * (d.band === 'outer' ? 1.25 : 1) * (d.latest ? 1.1 : 1);
    const ranked = [...all].sort((a, b) => Math.abs(strength(b)) - Math.abs(strength(a)))
      .filter((d, i, a) => a.findIndex(x => x.name === d.name) === i);
    const top3 = ranked.slice(0, 3).map(d => ({ symbol: d.name, kind: d.kind, band: d.band }));
    const checks = regime.error ? null : Object.fromEntries(Object.entries(regime.checks || {}).map(([k, v]) => [k, v.status]));
    const g7 = track?.backtest?.summary?.green_all?.['7d'] || null;
    const data = {
      free: true,
      asOf: new Date().toISOString(),
      timezone: 'America/Denver',
      regime: regime.error ? { error: 'unavailable' } : { score: regime.score, outOf: 4, checks },
      dots: { green: all.filter(d => d.kind === 'green').length, red: all.filter(d => d.kind === 'red').length, asOf: dots.asOf || null },
      top3Dots: top3, // symbol + band/kind only — no exact WaveTrend values
      backtest7dHeadline: g7 ? {
        label: 'simulated 90-day backtest (not a live trade log)',
        signal: 'green_all',
        horizon: '7d',
        hitRatePct: g7.hitRatePct,
        n: g7.n,
        note: 'Past performance is not indicative of future results.'
      } : { label: 'simulated backtest', note: 'hit-rate unavailable right now; see free GET /track' },
      upsell: {
        fullBrief: 'GET /api/brief — $0.02 USDC: full daily digest (top 10 dots with strength, BTC/ETH/SOL flows)',
        dots: 'GET /api/dots — $0.01 USDC: every green/red WaveTrend band dot with wt1/wt2 and closes',
        agent: 'POST /api/agent — $0.02 USDC: full Stage 1 regime + all band dots in one call'
      },
      disclaimer: 'signal only, not financial advice'
    };
    teaserCache = { t: Date.now(), data };
    return data;
  })().finally(() => { teaserInflight = null; });
  try { return await teaserInflight; }
  catch (e) { return { error: 'upstream data unavailable, retry shortly' }; }
}

// ---------- 2. Response signing (Ed25519 over SHA-256 of the exact JSON body) ----------
let signKey = null, pubPem = null;
try {
  const raw = process.env.SIGNING_KEY;
  if (raw) {
    const s = raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64');
    signKey = typeof s === 'string' ? crypto.createPrivateKey(s) : crypto.createPrivateKey({ key: s, format: 'der', type: 'pkcs8' });
    if (signKey.asymmetricKeyType !== 'ed25519') signKey = null;
    else pubPem = crypto.createPublicKey(signKey).export({ type: 'spki', format: 'pem' });
  }
} catch { signKey = null; console.warn('[signing] SIGNING_KEY present but unusable; responses will be unsigned'); }
export const signingEnabled = () => !!signKey;
// Detached Ed25519 signature (base64) over bytes, or null when SIGNING_KEY is unset/unusable. Never throws.
export function signDetached(bytes) {
  if (!signKey) return null;
  try { return crypto.sign(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes)), signKey).toString('base64'); }
  catch { return null; }
}
export function publicKeyInfo() {
  return signKey ? { enabled: true, algorithm: 'Ed25519', publicKeyPem: pubPem,
    publicKeySpkiBase64: crypto.createPublicKey(signKey).export({ type: 'spki', format: 'der' }).toString('base64'),
    scheme: 'signature = Ed25519(sign, utf8(`${X-GW8-Signed-At}.${sha256_hex(raw_response_body)}`)); header X-GW8-Signature is base64; X-GW8-Body-SHA256 is the hex digest.' }
    : { enabled: false, note: 'Signing key not configured yet; responses are currently unsigned.' };
}
// Middleware: sign successful JSON bodies on paid routes.
export function signResponses(req, res, next) {
  if (!signKey) return next();
  const orig = res.json.bind(res);
  res.json = body => {
    if (res.statusCode !== 200) return orig(body);
    const str = JSON.stringify(body);
    const at = new Date().toISOString();
    const digest = crypto.createHash('sha256').update(str).digest('hex');
    const sig = crypto.sign(null, Buffer.from(`${at}.${digest}`), signKey).toString('base64');
    res.set({ 'X-GW8-Signature': sig, 'X-GW8-Signed-At': at, 'X-GW8-Body-SHA256': digest, 'Content-Type': 'application/json; charset=utf-8' });
    return res.send(str);
  };
  next();
}
