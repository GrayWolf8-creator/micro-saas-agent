import { RAILS_ROUTE_PRICE_USD } from './prices.js';

// Which x402 facilitator and chain to use for one payment.
// Live up/down comes only from each facilitator's public GET /supported (short timeout, cached a few minutes).
// A failed, timed-out, or non-2xx probe is 'unknown', never a guessed 'down'.
// Fees are filled in only from that body's pricing, or from a cited published rate. Numbers are never invented.
// One recommendation leads. Fee, settle time, status, and alternatives are supporting fields.
const PROBE_MS = 2500;
const CACHE_MS = 3 * 60 * 1000;
// Under this payment size the lowest live exact fee wins, even off Base.
export const MICRO_AMOUNT_USD = 1;
// At or above MICRO_AMOUNT_USD, stay on Base unless another up chain is cheaper by more than this share of the payment.
export const BASE_FEE_GAP_SHARE = 0.01;
const money = n => Math.round(Number(n) * 1e6) / 1e6;
const pct = (part, whole) => whole > 0 ? Math.round((part / whole) * 10000) / 100 : null;

export const CHAINS = {
  base: { id: 'base', caip2: 'eip155:8453', v1: ['base'], settleTime: '~2s', settleSec: 2, settleNote: 'Base L2 block (same reference as GET /api/rails)' },
  solana: { id: 'solana', caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', v1: ['solana'], settleTime: '~1s', settleSec: 1, settleNote: 'Solana slot time, published reference, not a measured facilitator SLA' },
  polygon: { id: 'polygon', caip2: 'eip155:137', v1: ['polygon'], settleTime: '~2s', settleSec: 2, settleNote: 'Polygon block time, published reference' },
  arbitrum: { id: 'arbitrum', caip2: 'eip155:42161', v1: ['arbitrum'], settleTime: '~1s', settleSec: 1, settleNote: 'Arbitrum block time, published reference' },
  avalanche: { id: 'avalanche', caip2: 'eip155:43114', v1: ['avalanche'], settleTime: '~2s', settleSec: 2, settleNote: 'Avalanche block time, published reference' },
  optimism: { id: 'optimism', caip2: 'eip155:10', v1: ['optimism'], settleTime: '~2s', settleSec: 2, settleNote: 'Optimism block time, published reference' },
  ethereum: { id: 'ethereum', caip2: 'eip155:1', v1: ['ethereum', 'eth'], settleTime: '~12s', settleSec: 12, settleNote: 'Ethereum block time, published reference' },
  bsc: { id: 'bsc', caip2: 'eip155:56', v1: ['bsc', 'bnb'], settleTime: '~3s', settleSec: 3, settleNote: 'BNB Chain block time, published reference' },
  sei: { id: 'sei', caip2: 'eip155:1329', v1: ['sei'], settleTime: '~1s', settleSec: 1, settleNote: 'Sei block time, published reference' },
  worldchain: { id: 'worldchain', caip2: 'eip155:480', v1: ['worldchain', 'world'], settleTime: '~2s', settleSec: 2, settleNote: 'World Chain block time, published reference' }
};
const CHAIN_LIST = Object.values(CHAINS);
const TEST_CAIP = new Set(['eip155:84532', 'eip155:80002', 'eip155:43113', 'eip155:421614', 'eip155:97', 'eip155:713715', 'eip155:1952', 'eip155:324705682', 'eip155:4801', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1']);
const TESTNET_NAME = /sepolia|devnet|testnet|fuji|amoy|holesky/i;
const ALIAS = {};
for (const c of CHAIN_LIST) {
  ALIAS[c.id] = c.id;
  ALIAS[c.caip2.toLowerCase()] = c.id;
  for (const v of c.v1) ALIAS[v] = c.id;
}
ALIAS.matic = 'polygon';
ALIAS.arb = 'arbitrum';
ALIAS.avax = 'avalanche';
ALIAS.op = 'optimism';

export const FACILITATORS = [
  {
    id: 'coinbase-cdp',
    name: 'Coinbase CDP',
    supportedUrl: 'https://api.cdp.coinbase.com/platform/v2/x402/supported',
    publishedChains: ['base', 'polygon', 'arbitrum', 'worldchain', 'solana'],
    publishedFeeUsd: 0.001,
    feeNote: 'Coinbase CDP published marginal rate: $0.001 per settlement after 1,000 free settlements each month (the first 1,000 are $0). Source: docs.cdp.coinbase.com x402 facilitator pricing. The unauthenticated /supported probe usually returns 401, so the live flag stays unknown unless that probe answers.'
  },
  {
    id: 'payai',
    name: 'PayAI',
    supportedUrl: 'https://facilitator.payai.network/supported',
    publishedChains: ['base', 'solana', 'polygon', 'arbitrum', 'avalanche', 'sei', 'bsc'],
    publishedFeeUsd: null,
    feeNote: null
  },
  {
    id: 'dexter',
    name: 'Dexter',
    supportedUrl: 'https://x402.dexter.cash/supported',
    publishedChains: ['base', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'bsc', 'worldchain'],
    publishedFeeUsd: null,
    feeNote: null
  },
  {
    id: 'daydreams',
    name: 'Daydreams',
    supportedUrl: 'https://facilitator.daydreams.systems/supported',
    publishedChains: ['base', 'ethereum', 'solana'],
    publishedFeeUsd: null,
    feeNote: null
  },
  {
    id: 'x402rs',
    name: 'x402.rs',
    supportedUrl: 'https://facilitator.x402.rs/supported',
    publishedChains: [],
    publishedFeeUsd: null,
    feeNote: null
  }
];

export const ROUTE_PRICE_USD = RAILS_ROUTE_PRICE_USD;
export const ROUTE_SERVICE_NAME = 'GW8 Which Rail';
export const ROUTE_TAGS = ['facilitator', 'which rail', 'x402', 'payment', 'base'];
export const ROUTE_BLURB = `Choose which rail and which x402 facilitator for one payment of this size. One recommendation: facilitator, chain, and why, chosen by amount and chain. Fee, settle time, and a live up/down/unknown flag are supporting fields from each facilitator public /supported endpoint (short timeout, cached a few minutes, fail-soft as unknown). ?chain=base&amount=1. $${ROUTE_PRICE_USD} USDC.`;
export const ROUTE_OUTPUT_SCHEMA = {
  type: 'object',
  description: 'One x402 facilitator and which rail to use. recommended is the pick (facilitator, chain, why). alternatives, fee, settle_time, and status are supporting fields, not a facilitator stats dump.',
  additionalProperties: true,
  required: ['recommended', 'alternatives', 'fee', 'settle_time', 'status'],
  properties: {
    recommended: {
      type: 'object',
      required: ['facilitator', 'chain', 'why'],
      properties: {
        facilitator: { type: ['string', 'null'], description: 'Facilitator to use. Null when none lists this chain.' },
        chain: { type: ['string', 'null'], description: 'Chain for that facilitator. The which-rail pick.' },
        why: { type: 'string', description: 'Short reason. Chosen by the payment amount and the chain.' }
      }
    },
    alternatives: { type: 'array', description: 'Other facilitator and chain options. Supporting stats only.', items: { type: 'object' } },
    fee: { type: ['number', 'null'], description: 'USD settlement fee for the recommendation. Flat per settlement, not a percent of the payment. Null when the public source has no fee.' },
    settle_time: { type: ['string', 'null'], description: 'Published chain block time for the recommendation, not a measured facilitator SLA.' },
    status: { type: 'string', enum: ['up', 'down', 'unknown'], description: 'Live flag. up: /supported listed exact on this chain. down: it answered and did not, or nobody lists the chain. unknown: the probe failed.' }
  }
};

export function normalizeChain(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  return ALIAS[s] || null;
}

export function validRouteQuery(q = {}) {
  let chain = null;
  if (q.chain != null && String(q.chain).trim() !== '') {
    chain = normalizeChain(q.chain);
    if (!chain) return { error: 'chain must be a mainnet name or CAIP-2 id: base, solana, polygon, arbitrum, avalanche, optimism, ethereum, bsc, sei, or worldchain (default: choose for me)' };
  }
  let amount = 1;
  if (q.amount != null && q.amount !== '') {
    const a = Number(q.amount);
    if (!Number.isFinite(a) || a <= 0 || a > 1e7) return { error: 'amount must be a USD number > 0 and <= 10000000 (default 1)' };
    amount = a;
  }
  return { chain, amount };
}

export function chainIdFromNetwork(network) {
  const n = String(network || '');
  if (!n || TESTNET_NAME.test(n) || TEST_CAIP.has(n) || TEST_CAIP.has(n.toLowerCase())) return null;
  return ALIAS[n.toLowerCase()] || null;
}

// Pull exact-scheme mainnet support and, when present, the live exact fee for that chain.
export function parseSupported(body) {
  const kinds = body && Array.isArray(body.kinds) ? body.kinds : null;
  if (!kinds) return null;
  const supports = new Set();
  for (const k of kinds) {
    if (!k || k.scheme !== 'exact') continue;
    const id = chainIdFromNetwork(k.network);
    if (id) supports.add(id);
  }
  const fees = {};
  const rates = body.pricing && Array.isArray(body.pricing.rates) ? body.pricing.rates : [];
  for (const id of supports) {
    const chain = CHAINS[id];
    const matches = rates.filter(r => r && r.scheme === 'exact' && r.published !== false && chainIdFromNetwork(r.network) === id && Number.isFinite(Number(r.usd)));
    const preferred = matches.filter(r => r.transferMethod === 'eip3009' || r.transferMethod === 'svm_transfer');
    const pool = preferred.length ? preferred : matches;
    if (!pool.length) continue;
    fees[id] = money(Math.min(...pool.map(r => Number(r.usd))));
  }
  return { supports, fees };
}

function option(probe, chainId) {
  const chain = CHAINS[chainId];
  const published = probe.publishedChains && probe.publishedChains.has(chainId);
  const liveListed = probe.status === 'up' && probe.supports && probe.supports.has(chainId);
  let status = 'down';
  if (probe.status === 'up') status = liveListed ? 'up' : 'down';
  else if (published) status = 'unknown';
  let fee = null;
  let feeSource = 'unavailable';
  if (status !== 'down') {
    if (probe.fees && probe.fees[chainId] != null) { fee = money(probe.fees[chainId]); feeSource = 'live'; }
    else if (probe.publishedFeeUsd != null && published) { fee = money(probe.publishedFeeUsd); feeSource = 'published'; }
  }
  return {
    facilitator: probe.name, id: probe.id, chain: chainId, caip2: chain.caip2,
    fee, feeSource, feeNote: feeSource === 'published' ? (probe.feeNote || null) : null,
    settle_time: chain.settleTime, settleSec: chain.settleSec, settleNote: chain.settleNote, status
  };
}

function better(a, b) {
  const rank = { up: 0, unknown: 1, down: 2 };
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
  if ((a.fee == null) !== (b.fee == null)) return a.fee == null ? 1 : -1;
  if (a.fee != null && b.fee != null && a.fee !== b.fee) return a.fee - b.fee;
  if (a.settleSec !== b.settleSec) return a.settleSec - b.settleSec;
  return String(a.facilitator).localeCompare(String(b.facilitator));
}

function whyFor(best, { amount, requestedChain, choice, other }) {
  const live = best.status === 'up' ? 'is up' : 'was not confirmed by the live /supported probe (unknown)';
  const feeLabel = best.feeSource === 'live' ? 'Live' : 'Published';
  const feeTxt = best.fee == null ? 'No fee was in the public source' : `${feeLabel} fee $${best.fee}`;
  const share = best.fee == null ? '' : ` (${pct(best.fee, amount)}% of this $${amount} payment)`;
  let rule = `Requested chain ${requestedChain} is not overridden.`;
  if (!requestedChain && choice === 'micro') rule = `Under $${MICRO_AMOUNT_USD} the lowest live exact fee wins${best.chain === 'base' ? ', and Base is that fee' : ', including a chain other than Base'}.`;
  else if (!requestedChain && choice === 'base') {
    if (other && other.chain !== best.chain && other.fee != null && best.fee != null) {
      const gap = money(Math.abs(best.fee - other.fee));
      rule = `${other.facilitator} on ${other.chain} is cheaper by $${gap}, ${pct(gap, amount)}% of this $${amount} payment, within ${BASE_FEE_GAP_SHARE * 100}%, so the pick stays on Base (the x402 USDC default).`;
    } else rule = `At $${amount} Base is the cheapest up option, or the gap versus other chains is within ${BASE_FEE_GAP_SHARE * 100}%, so the pick stays on Base (the x402 USDC default).`;
  } else if (!requestedChain && choice === 'gap' && other && other.fee != null && best.fee != null) {
    const gap = money(Math.abs(other.fee - best.fee));
    rule = `Base would cost $${gap} more (${pct(gap, amount)}% of this $${amount} payment), over the ${BASE_FEE_GAP_SHARE * 100}% line, so the cheaper chain wins.`;
  } else if (!requestedChain) rule = 'No up priced Base option, so the best available facilitator is the pick.';
  return `${best.facilitator} on ${best.chain} ${live}. ${feeTxt}${share}. Settle time ${best.settle_time} is a published chain block time, not a measured facilitator SLA. ${rule}`;
}

function slim(o) {
  return { facilitator: o.facilitator, chain: o.chain, fee: o.fee, settle_time: o.settle_time, status: o.status, feeSource: o.feeSource };
}

// Pure. probes are the objects probeOne returns. chain null means "choose the chain".
export function buildRoute(probes, { chain = null, amount = 1, probedAt = null, cached = false } = {}) {
  const ids = chain ? [chain] : CHAIN_LIST.map(c => c.id);
  const ranked = [];
  for (const id of ids) for (const p of probes || []) ranked.push(option(p, id));
  const open = ranked.filter(o => o.status !== 'down').sort(better);
  let best = open[0] || null;
  let choice = chain ? 'chain' : (amount >= MICRO_AMOUNT_USD ? 'fallback' : 'micro');
  let other = null;
  if (!chain && amount >= MICRO_AMOUNT_USD) {
    const bestBase = open.find(o => o.chain === 'base' && o.status === 'up' && o.fee != null);
    const bestAny = open.find(o => o.status === 'up' && o.fee != null);
    if (bestBase && bestAny) {
      const gap = money(bestBase.fee - bestAny.fee);
      if (gap <= money(amount * BASE_FEE_GAP_SHARE)) { best = bestBase; choice = 'base'; other = bestAny; }
      else { best = bestAny; choice = 'gap'; other = bestBase; }
    }
  }
  const none = {
    facilitator: null, chain: chain || null,
    why: chain
      ? `No facilitator lists exact payments on ${chain}. Nothing was invented.`
      : 'No facilitator lists an exact mainnet payment. Nothing was invented.'
  };
  const recommended = best ? { facilitator: best.facilitator, chain: best.chain, why: whyFor(best, { amount, requestedChain: chain, choice, other }) } : none;
  return {
    recommended,
    alternatives: open.filter(o => o !== best).slice(0, 4).map(slim),
    fee: best ? best.fee : null,
    settle_time: best ? best.settle_time : null,
    status: best ? best.status : 'down',
    amountUsd: amount,
    requestedChain: chain,
    feeSource: best ? best.feeSource : 'unavailable',
    ...(best && best.feeNote ? { feeNote: best.feeNote } : {}),
    caip2: best ? best.caip2 : null,
    probedAt,
    cached: !!cached,
    rules: `Under $${MICRO_AMOUNT_USD}, the lowest live exact fee wins across chains. At $${MICRO_AMOUNT_USD} and above, stay on Base unless another up chain is cheaper by more than ${BASE_FEE_GAP_SHARE * 100}% of the payment. A requested chain is never overridden. up beats unknown. A failed /supported probe is unknown, not down. Fees are flat per settlement.`,
    sources: (probes || []).map(p => p.supportedUrl).filter(Boolean),
    notes: [
      'One recommendation. alternatives, fee, settle_time, and status are supporting fields, not a stats dump.',
      'status up means GET /supported returned 2xx and listed scheme exact on that chain. down means it answered and did not list the chain, or nobody lists it. unknown means the probe timed out or was not 2xx.',
      'PayAI fees are the live exact rate in /supported pricing (eip3009 or svm_transfer when present). Coinbase CDP uses its published $0.001 marginal rate when the probe has no price. Other facilitators stay unpriced until their /supported body includes one.',
      'settle_time is a published chain block time, not a measured facilitator SLA. Signal only, not financial advice.'
    ],
    disclaimer: 'signal only, not financial advice'
  };
}

const EXAMPLE_PROBES = [
  { id: 'payai', name: 'PayAI', supportedUrl: 'https://facilitator.payai.network/supported', status: 'up', supports: new Set(['base', 'solana', 'polygon']), fees: { base: 0.00156, solana: 0.00093, polygon: 0.00303 }, publishedChains: new Set(['base', 'solana', 'polygon']), publishedFeeUsd: null, feeNote: null },
  { id: 'coinbase-cdp', name: 'Coinbase CDP', supportedUrl: 'https://api.cdp.coinbase.com/platform/v2/x402/supported', status: 'unknown', supports: new Set(), fees: {}, publishedChains: new Set(['base', 'solana', 'polygon']), publishedFeeUsd: 0.001, feeNote: FACILITATORS[0].feeNote }
];
export const ROUTE_EXAMPLE = buildRoute(EXAMPLE_PROBES, { chain: 'base', amount: 1, probedAt: '2026-11-16T17:00:00.000Z', cached: true });

async function probeOne(f, fetchImpl) {
  const base = {
    id: f.id, name: f.name, supportedUrl: f.supportedUrl,
    publishedChains: new Set(f.publishedChains || []),
    publishedFeeUsd: f.publishedFeeUsd ?? null,
    feeNote: f.feeNote || null,
    status: 'unknown', supports: new Set(), fees: {}
  };
  try {
    const r = await fetchImpl(f.supportedUrl, { signal: AbortSignal.timeout(PROBE_MS), headers: { accept: 'application/json' } });
    if (!r.ok) return base;
    const body = await r.json();
    const parsed = parseSupported(body);
    if (!parsed) return base;
    return { ...base, status: 'up', supports: parsed.supports, fees: parsed.fees };
  } catch {
    return base;
  }
}

let probeCache = null;
let probeInflight = null;
export function _resetProbeCache() { probeCache = null; probeInflight = null; }

export async function probeFacilitators(deps = {}) {
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetch || fetch;
  if (probeCache && now >= probeCache.at && now - probeCache.at < CACHE_MS) {
    return { probes: probeCache.probes, cached: true, probedAt: new Date(probeCache.at).toISOString() };
  }
  if (!probeInflight) {
    const started = now;
    probeInflight = Promise.all(FACILITATORS.map(f => probeOne(f, fetchImpl))).then(probes => {
      probeCache = { at: started, probes };
      return probes;
    }).finally(() => { probeInflight = null; });
  }
  const probes = await probeInflight;
  return { probes, cached: false, probedAt: new Date((probeCache && probeCache.at) || now).toISOString() };
}

export async function getFacilitatorRoute(query = {}, deps = {}) {
  const v = validRouteQuery(query);
  if (v.error) return { error: v.error, http: 400 };
  try {
    const probed = await probeFacilitators(deps);
    return buildRoute(probed.probes, { chain: v.chain, amount: v.amount, probedAt: probed.probedAt, cached: probed.cached });
  } catch {
    return { error: 'upstream data unavailable, retry shortly', http: 503 };
  }
}
