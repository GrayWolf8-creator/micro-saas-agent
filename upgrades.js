// upgrades.js — token safety verdict, large-flow summary, daily brief, response signing.
// Public data only (GoPlus, DexScreener, Kraken). No API keys, no trading, no execution.
import crypto from 'crypto';
import { getDots, getRegime, getCoin, COINS, PAIRS_MAP } from './Signal.js';

const DISCLAIMER = 'signal only, not financial advice';
const r2 = v => Math.round(v * 100) / 100;
const getJson = async (url, ms = 12000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

// ---------- 1. Token safety verdict ----------
export const VERDICT_CHAINS = { base: '8453', ethereum: '1', bsc: '56', arbitrum: '42161', solana: 'solana' };
export const VERDICT_RULES = [
  'Start at 100. Clamp to 0-100.',
  'EVM: honeypot -100; cannot sell all -40; buy or sell tax >10% -30 (>=5% -10); hidden owner -25; owner can take back ownership -25; owner can change balances -30; selfdestruct -25; mintable -15; trading pausable -15; blacklist function -10; transfer cooldown -10; tax modifiable -15; proxy contract -10; source not verified -25.',
  'EVM: top-10 holders (excluding locked/contract-tagged LP) >80% -20 (>50% -10); creator holds >20% -10; no DEX listing seen by GoPlus -15.',
  'Solana: mint authority active -20; freeze authority active -25; balance mutable by authority -40; non-transferable -40; transfer fee set -15; metadata mutable -5; closable -10.',
  'Market (DexScreener, all chains): top pair liquidity <$10k -20 (<$50k -10); no pairs found -20; pair younger than 24h -10.',
  'Verdict: score >=75 safe, 40-74 caution, <40 danger. Missing GoPlus data caps verdict at caution.'
];
const vcache = new Map(); const VTTL = 10 * 60 * 1000;
export function validVerdictInput(chain, address) {
  if (!VERDICT_CHAINS[chain]) return 'unsupported chain';
  if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : !/^0x[0-9a-fA-F]{40}$/.test(address)) return 'invalid address';
  return null;
}
export async function getVerdict(chain, address) {
  const key = `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
  const hit = vcache.get(key); if (hit && Date.now() - hit.t < VTTL) return { ...hit.data, cached: true };
  const id = VERDICT_CHAINS[chain];
  const gpUrl = chain === 'solana' ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}` : `https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${address}`;
  const dsUrl = `https://api.dexscreener.com/tokens/v1/${chain}/${address}`;
  const [gp, ds] = await Promise.allSettled([getJson(gpUrl), getJson(dsUrl)]);
  let score = 100; const reasons = []; const hit_ = (pts, why) => { score -= pts; reasons.push(`-${pts}: ${why}`); };
  let t = null;
  if (gp.status === 'fulfilled' && gp.value?.result) { const res = gp.value.result; t = res[address] || res[address.toLowerCase()] || Object.values(res)[0] || null; }
  const one = v => v === '1' || v === 1;
  if (t && chain !== 'solana') {
    if (one(t.is_honeypot)) hit_(100, 'honeypot detected');
    if (one(t.cannot_sell_all)) hit_(40, 'cannot sell all tokens');
    const tax = Math.max(+t.buy_tax || 0, +t.sell_tax || 0) * 100;
    if (tax > 10) hit_(30, `tax ${r2(tax)}%`); else if (tax >= 5) hit_(10, `tax ${r2(tax)}%`);
    if (one(t.hidden_owner)) hit_(25, 'hidden owner');
    if (one(t.can_take_back_ownership)) hit_(25, 'owner can take back ownership');
    if (one(t.owner_change_balance)) hit_(30, 'owner can change balances');
    if (one(t.selfdestruct)) hit_(25, 'selfdestruct');
    if (one(t.is_mintable)) hit_(15, 'mintable');
    if (one(t.transfer_pausable)) hit_(15, 'trading can be paused');
    if (one(t.is_blacklisted)) hit_(10, 'blacklist function');
    if (one(t.trading_cooldown)) hit_(10, 'transfer cooldown');
    if (one(t.slippage_modifiable)) hit_(15, 'tax modifiable');
    if (one(t.is_proxy)) hit_(10, 'upgradeable proxy');
    if (t.is_open_source === '0') hit_(25, 'source not verified');
    const top = (t.holders || []).filter(h => !h.is_locked && !h.is_contract).slice(0, 10).reduce((a, h) => a + (+h.percent || 0), 0) * 100;
    if (top > 80) hit_(20, `top holders own ${r2(top)}%`); else if (top > 50) hit_(10, `top holders own ${r2(top)}%`);
    if ((+t.creator_percent || 0) * 100 > 20) hit_(10, `creator holds ${r2(+t.creator_percent * 100)}%`);
    if (t.is_in_dex === '0') hit_(15, 'not seen on any DEX');
  } else if (t && chain === 'solana') {
    const on = f => f && f.status === '1';
    if (on(t.mintable)) hit_(20, 'mint authority active');
    if (on(t.freezable)) hit_(25, 'freeze authority active');
    if (on(t.balance_mutable_authority)) hit_(40, 'balances mutable by authority');
    if (t.non_transferable === '1') hit_(40, 'non-transferable');
    if (t.transfer_fee && Object.keys(t.transfer_fee).length) hit_(15, 'transfer fee set');
    if (on(t.metadata_mutable)) hit_(5, 'metadata mutable');
    if (on(t.closable)) hit_(10, 'closable');
  }
  let market = null;
  if (ds.status === 'fulfilled' && Array.isArray(ds.value)) {
    const pairs = ds.value.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    if (!pairs.length) hit_(20, 'no DEX pairs found');
    else {
      const p = pairs[0], liq = p.liquidity?.usd || 0;
      market = { symbol: p.baseToken?.symbol, priceUsd: +p.priceUsd || null, liquidityUsd: liq, volume24hUsd: p.volume?.h24 ?? null, pairs: pairs.length, topPair: p.url };
      if (liq < 10000) hit_(20, `low liquidity $${Math.round(liq)}`); else if (liq < 50000) hit_(10, `thin liquidity $${Math.round(liq)}`);
      if (p.pairCreatedAt && Date.now() - p.pairCreatedAt < 86400000) hit_(10, 'pair younger than 24h');
    }
  }
  score = Math.max(0, Math.min(100, score));
  let verdict = score >= 75 ? 'safe' : score >= 40 ? 'caution' : 'danger';
  if (!t) { reasons.push('GoPlus data unavailable for this token: verdict capped at caution'); if (verdict === 'safe') verdict = 'caution'; }
  const data = { chain, address, score, verdict, reasons: reasons.length ? reasons : ['no risk flags found by the rules'], market,
    token: t ? { name: t.token_name || t.metadata?.name || null, symbol: t.token_symbol || t.metadata?.symbol || null, holders: t.holder_count ? +t.holder_count : null } : null,
    sources: [gpUrl, dsUrl], rules: VERDICT_RULES, checkedAt: new Date().toISOString(),
    note: 'Automated rule-based screen of public data. A safe score is not a guarantee; new scam patterns may not be detected.', disclaimer: DISCLAIMER };
  vcache.set(key, { t: Date.now(), data }); if (vcache.size > 2000) vcache.delete(vcache.keys().next().value);
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
