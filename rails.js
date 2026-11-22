// rails.js — which payment rail is cheapest/fastest right now for a USD amount (Base USDC, XRPL, Tempo, Arc, card).
// Public keyless reads only (Base/Tempo/Arc RPC gas price, XRPL fee, Kraken ticker). No wallets, no sending, no trading.
// A failed live fetch marks that rail unavailable; numbers are never filled in.
const DISCLAIMER = 'signal only, not financial advice';
const TTL = 60e3, ERC20_GAS = 65000, TIP20_GAS = 50000;
export const CARD = { pct: 2.9, fixedUsd: 0.30, source: 'static published reference rate (typical US online card pricing, e.g. Stripe standard 2.9% + $0.30); not live' };
const SRC = { base: 'https://mainnet.base.org', xrpl: 'https://xrplcluster.com', tempo: 'https://rpc.tempo.xyz', arc: 'https://rpc.mainnet.arc.io', kraken: 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD,XRPUSD' };
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const r6 = v => v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6;
const r4 = v => v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4;
let cache = null, inflight = null;
// Agent/payment protocols per rail, from public docs only. 'documented' = a primary source says so; 'unverified' = claimed or likely, not confirmed by us.
const P = (name, status, source) => ({ name, status, ...(source ? { source } : {}) });
export const PROTOCOLS = {
  'base-usdc': [P('x402', 'documented', 'https://docs.stripe.com/payments/machine (x402 on Base USDC); this API settles x402 on Base'), P('AP2 (x402 extension)', 'unverified')],
  'xrpl-rlusd-xrp': [P('x402', 'unverified')],
  'tempo': [P('MPP (Machine Payments Protocol)', 'documented', 'https://tempo.xyz/blog/mainnet/ ; https://docs.stripe.com/payments/machine (MPP on Tempo USDC.e)'), P('x402', 'unverified')],
  'arc-usdc': [P('x402', 'documented', 'https://agents.circle.com/services/SKILL.md (network eip155:5042 = Arc); https://developers.circle.com/x402-facilitators/x402'), P('Circle Gateway Nanopayments (x402)', 'documented', 'https://developers.circle.com/agent-stack/agent-nanopayments')],
  'card': [P('card networks (Visa, Mastercard)', 'documented', 'https://stripe.com/pricing'), P('MPP via Stripe Shared Payment Tokens', 'documented', 'https://docs.stripe.com/payments/machine'), P('Visa Trusted Agent Protocol (TAP)', 'unverified'), P('Mastercard Agent Pay', 'unverified'), P('AP2', 'unverified')]
};

export function validAmount(raw) {
  if (raw == null || raw === '') return { amount: 100 };
  const a = Number(raw);
  return isFinite(a) && a > 0 && a <= 1e7 ? { amount: a } : { error: 'amount must be a USD number > 0 and <= 10000000 (default 100)' };
}

async function live() {
  const at = () => new Date().toISOString();
  const gasPrice = url => post(url, { jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }).then(j => { const w = parseInt(j.result, 16); if (!(w > 0)) throw new Error('bad gas'); return { wei: w, at: at() }; });
  const [gas, fee, tick, tempo, arc] = await Promise.allSettled([
    gasPrice(SRC.base),
    post(SRC.xrpl, { method: 'fee', params: [{}] }).then(j => { const d = +(j.result && j.result.drops && j.result.drops.open_ledger_fee); if (!(d > 0)) throw new Error('bad fee'); return { drops: d, at: at() }; }),
    fetch(SRC.kraken, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).then(j => { if (j.error && j.error.length) throw new Error(j.error.join(','));
      const px = k => { const e = Object.entries(j.result || {}).find(([n]) => n.includes(k)); const v = e ? +e[1].c[0] : NaN; return v > 0 ? v : null; };
      return { eth: px('ETH'), xrp: px('XRP'), at: at() }; }),
    gasPrice(SRC.tempo), gasPrice(SRC.arc)
  ]);
  const v = s => s.status === 'fulfilled' ? s.value : null;
  return { gas: v(gas), fee: v(fee), tick: v(tick), tempo: v(tempo), arc: v(arc) };
}

// Pure: amount in USD + live inputs ({gas:{wei,at}, fee:{drops,at}, tick:{eth,xrp,at}, tempo:{wei,at}, arc:{wei,at}}, any may be null).
export function buildRails(amount, inp, now = Date.now()) {
  const { gas, fee, tick, tempo, arc } = inp || {}, pct = usd => usd == null ? null : r6(usd / amount * 100);
  const rails = [];
  if (gas && tick && tick.eth) { const usd = gas.wei * ERC20_GAS / 1e18 * tick.eth;
    rails.push({ rail: 'base-usdc', status: 'live', feeUsd: r6(usd), feePct: pct(usd), settlement: '~2s (Base L2 block; L1 finality later)', settlementSec: 2,
      inputs: { gasPriceGwei: r6(gas.wei / 1e9), gasUnits: ERC20_GAS, ethUsd: tick.eth }, dataAt: gas.at, source: `${SRC.base} eth_gasPrice x ~${ERC20_GAS} gas (USDC transfer) x Kraken ETH/USD`,
      note: 'L2 execution fee only; Base also adds a small L1 data fee not included here.' });
  } else rails.push({ rail: 'base-usdc', status: 'unavailable', reason: !gas ? 'Base RPC gas price fetch failed' : 'Kraken ETH/USD fetch failed', source: SRC.base });
  if (fee && tick && tick.xrp) { const usd = fee.drops / 1e6 * tick.xrp;
    rails.push({ rail: 'xrpl-rlusd-xrp', status: 'live', feeUsd: r6(usd), feePct: pct(usd), settlement: '~3-5s (XRPL ledger close)', settlementSec: 4,
      inputs: { openLedgerFeeDrops: fee.drops, xrpUsd: tick.xrp }, dataAt: fee.at, source: `${SRC.xrpl} fee (open_ledger_fee) x Kraken XRP/USD`,
      note: 'Network fee only; RLUSD needs a trust line and any issuer transfer fee or DEX spread is not included.' });
  } else rails.push({ rail: 'xrpl-rlusd-xrp', status: 'unavailable', reason: !fee ? 'XRPL fee fetch failed' : 'Kraken XRP/USD fetch failed', source: SRC.xrpl });
  // Tempo: gas price is in attodollars (1e-18 USD) per gas, fees paid in USD stablecoins, so no price feed is needed.
  if (tempo) { const usd = tempo.wei * TIP20_GAS / 1e18;
    rails.push({ rail: 'tempo', status: 'live', feeUsd: r6(usd), feePct: pct(usd), settlement: '~1s (sub-second blocks, deterministic finality)', settlementSec: 1,
      inputs: { gasPriceAttoUsd: tempo.wei, gasUnits: TIP20_GAS }, dataAt: tempo.at, source: `${SRC.tempo} eth_gasPrice (attodollars/gas) x ~${TIP20_GAS} gas (TIP-20 transfer, per tempo.xyz fee spec)`,
      note: 'Fee paid in a USD stablecoin (assumed $1). Transfer to a new recipient costs more gas (documented ~300k pre-T7).' });
  } else rails.push({ rail: 'tempo', status: 'unavailable', reason: 'Tempo RPC gas price fetch failed', source: SRC.tempo });
  // Arc: native gas token is USDC with 18 decimals, so wei x gas / 1e18 = USD.
  if (arc) { const usd = arc.wei * ERC20_GAS / 1e18;
    rails.push({ rail: 'arc-usdc', status: 'live', feeUsd: r6(usd), feePct: pct(usd), settlement: '~1s (sub-second deterministic finality)', settlementSec: 1,
      inputs: { gasPriceGwei: r6(arc.wei / 1e9), gasUnits: ERC20_GAS }, dataAt: arc.at, source: `${SRC.arc} eth_gasPrice (USDC, 18 decimals) x ~${ERC20_GAS} gas (ERC-20 USDC transfer)`,
      note: 'Gas paid in USDC (assumed $1). 65k gas is our assumption for an ERC-20 transfer; a native USDC send uses less.' });
  } else rails.push({ rail: 'arc-usdc', status: 'unavailable', reason: 'Arc RPC gas price fetch failed', source: SRC.arc });
  const cardUsd = amount * CARD.pct / 100 + CARD.fixedUsd;
  rails.push({ rail: 'card', status: 'static-estimate', feeUsd: r4(cardUsd), feePct: pct(cardUsd), settlement: '~1-3 business days (payout), chargebacks possible for months', settlementSec: 2 * 86400,
    inputs: { pct: CARD.pct, fixedUsd: CARD.fixedUsd }, dataAt: null, source: CARD.source });
  for (const r of rails) r.protocols = PROTOCOLS[r.rail] || [];
  const ok = rails.filter(r => r.feeUsd != null).sort((a, b) => a.feeUsd - b.feeUsd || a.settlementSec - b.settlementSec);
  const fastest = rails.filter(r => r.feeUsd != null).sort((a, b) => a.settlementSec - b.settlementSec)[0];
  const best = ok[0];
  return {
    asOf: new Date(now).toISOString(), amountUsd: amount, rails,
    recommended: { rail: best.rail, why: `lowest estimated fee ($${best.feeUsd}) for $${amount}` + (best.status === 'static-estimate' ? ' (only static card estimate available; live rails failed)' : ''), fastest: fastest.rail },
    sourceStatus: { baseRpc: gas ? 'ok' : 'unavailable', xrplFee: fee ? 'ok' : 'unavailable', krakenTicker: tick ? 'ok' : 'unavailable', tempoRpc: tempo ? 'ok' : 'unavailable', arcRpc: arc ? 'ok' : 'unavailable' },
    notes: ['Fee estimates for one transfer; excludes on/off-ramp, exchange withdrawal and FX costs.', 'protocols lists agent/payment protocols per rail from public docs; "unverified" means not confirmed by a primary source.', 'Card is a static reference rate, not a live quote; actual card pricing varies by processor and card type.', 'Live inputs cached ~60s. ' + DISCLAIMER + '.'],
    disclaimer: DISCLAIMER
  };
}

// JSON schema for the object buildRails returns. Descriptions only; buildRails is unchanged.
const railId = { type: 'string', enum: ['base-usdc', 'xrpl-rlusd-xrp', 'tempo', 'arc-usdc', 'card'], description: 'Rail id: base-usdc, xrpl-rlusd-xrp, tempo, arc-usdc, or card.' };
const sourceState = { type: 'string', enum: ['ok', 'unavailable'], description: 'ok when that live read succeeded, unavailable when it failed.' };
export const RAILS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'Payment-rail comparison for one USD amount: live fee and speed for Base USDC, XRPL, Tempo, and Arc, a static card estimate, the recommended rail, and which sources answered.',
  required: ['asOf', 'amountUsd', 'rails', 'recommended', 'sourceStatus', 'notes', 'disclaimer'],
  properties: {
    asOf: { type: 'string', description: 'ISO time this comparison was built.' },
    amountUsd: { type: 'number', description: 'USD amount the fees were estimated for.' },
    rails: {
      type: 'array',
      description: 'One entry per rail, always base-usdc, xrpl-rlusd-xrp, tempo, arc-usdc, and card, in that order.',
      items: {
        type: 'object',
        additionalProperties: true,
        description: 'One payment rail. status is live, unavailable, or static-estimate. An unavailable rail omits the fee fields and includes reason.',
        required: ['rail', 'status', 'source', 'protocols'],
        properties: {
          rail: railId,
          status: { type: 'string', enum: ['live', 'unavailable', 'static-estimate'], description: 'live when the fee was computed from a successful read, unavailable when that read failed, static-estimate for the card reference rate.' },
          feeUsd: { type: 'number', description: 'Estimated fee in USD for this amount. Omitted when status is unavailable.' },
          feePct: { type: 'number', description: 'Estimated fee as a percent of amountUsd. Omitted when status is unavailable.' },
          settlement: { type: 'string', description: 'Plain-language settlement time. Omitted when status is unavailable.' },
          settlementSec: { type: 'number', description: 'Settlement time in seconds, used to pick the fastest rail. Omitted when status is unavailable.' },
          inputs: {
            type: 'object',
            additionalProperties: true,
            description: 'Live or static inputs behind the fee. The fields depend on the rail. Omitted when status is unavailable.',
            properties: {
              gasPriceGwei: { type: 'number', description: 'Gas price in gwei for base-usdc or arc-usdc.' },
              gasUnits: { type: 'number', description: 'Gas units assumed for the transfer.' },
              ethUsd: { type: 'number', description: 'ETH/USD price used for the Base fee.' },
              openLedgerFeeDrops: { type: 'number', description: 'XRPL open ledger fee in drops.' },
              xrpUsd: { type: 'number', description: 'XRP/USD price used for the XRPL fee.' },
              gasPriceAttoUsd: { type: 'number', description: 'Tempo gas price in attodollars per gas.' },
              pct: { type: 'number', description: 'Card percent rate in the static estimate.' },
              fixedUsd: { type: 'number', description: 'Card fixed USD fee in the static estimate.' }
            }
          },
          dataAt: { type: ['string', 'null'], description: 'ISO time of the live inputs. Null for the static card estimate. Omitted when status is unavailable.' },
          source: { type: 'string', description: 'Where the fee inputs were read, or the citation for the static card rate.' },
          note: { type: 'string', description: 'What this fee leaves out. Present on live rails.' },
          reason: { type: 'string', description: 'Why this rail is unavailable. Present only when status is unavailable.' },
          protocols: {
            type: 'array',
            description: 'Agent and payment protocols documented or claimed for this rail.',
            items: {
              type: 'object',
              additionalProperties: true,
              description: 'One protocol name, whether a primary source documents it, and that source when status is documented.',
              required: ['name', 'status'],
              properties: {
                name: { type: 'string', description: 'Protocol name.' },
                status: { type: 'string', enum: ['documented', 'unverified'], description: 'documented when a primary source says so; unverified when it is claimed or likely and not confirmed here.' },
                source: { type: 'string', description: 'Primary-source URL. Present when status is documented.' }
              }
            }
          }
        }
      }
    },
    recommended: {
      type: 'object',
      additionalProperties: true,
      description: 'Lowest estimated fee for this amount, why that rail was picked, and which rail settles fastest.',
      required: ['rail', 'why', 'fastest'],
      properties: {
        rail: { type: 'string', description: 'Rail with the lowest estimated fee among rails that have a fee.' },
        why: { type: 'string', description: 'Why that rail was recommended, including when only the static card estimate was available.' },
        fastest: { type: 'string', description: 'Rail with the shortest settlement time among rails that have a fee.' }
      }
    },
    sourceStatus: {
      type: 'object',
      additionalProperties: true,
      description: 'Whether each live input read succeeded.',
      required: ['baseRpc', 'xrplFee', 'krakenTicker', 'tempoRpc', 'arcRpc'],
      properties: {
        baseRpc: { ...sourceState, description: 'Base gas-price read: ok or unavailable.' },
        xrplFee: { ...sourceState, description: 'XRPL fee read: ok or unavailable.' },
        krakenTicker: { ...sourceState, description: 'ETH/USD and XRP/USD ticker read: ok or unavailable.' },
        tempoRpc: { ...sourceState, description: 'Tempo gas-price read: ok or unavailable.' },
        arcRpc: { ...sourceState, description: 'Arc gas-price read: ok or unavailable.' }
      }
    },
    notes: {
      type: 'array',
      description: 'Caveats: costs left out, how protocol labels are sourced, the static card rate, and the cache window.',
      items: { type: 'string', description: 'One caveat about this fee comparison.' }
    },
    disclaimer: { type: 'string', description: 'Signal only, not financial advice.' }
  }
};

export async function getRails(amount = 100) {
  if (!(cache && Date.now() - cache.t < TTL)) {
    if (!inflight) inflight = live().then(d => { if (d.gas || d.fee || d.tempo || d.arc) cache = { t: Date.now(), d }; return d; }).finally(() => { inflight = null; });
    try { const d = await inflight; const out = buildRails(amount, d); return out.rails.some(r => r.status === 'live') ? out : { error: 'live rail data unavailable, retry shortly' }; }
    catch { return { error: 'upstream data unavailable, retry shortly' }; }
  }
  return { ...buildRails(amount, cache.d), cached: true };
}
