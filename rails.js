// rails.js — which payment rail is cheapest/fastest right now for a USD amount (Base USDC vs XRPL vs card).
// Public keyless reads only (Base RPC gas price, XRPL fee, Kraken ticker). No wallets, no sending, no trading.
// A failed live fetch marks that rail unavailable; numbers are never filled in.
const DISCLAIMER = 'signal only, not financial advice';
const TTL = 60e3, ERC20_GAS = 65000;
export const CARD = { pct: 2.9, fixedUsd: 0.30, source: 'static published reference rate (typical US online card pricing, e.g. Stripe standard 2.9% + $0.30); not live' };
const SRC = { base: 'https://mainnet.base.org', xrpl: 'https://xrplcluster.com', kraken: 'https://api.kraken.com/0/public/Ticker?pair=ETHUSD,XRPUSD' };
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const r6 = v => v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6;
const r4 = v => v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4;
let cache = null, inflight = null;

export function validAmount(raw) {
  if (raw == null || raw === '') return { amount: 100 };
  const a = Number(raw);
  return isFinite(a) && a > 0 && a <= 1e7 ? { amount: a } : { error: 'amount must be a USD number > 0 and <= 10000000 (default 100)' };
}

async function live() {
  const at = () => new Date().toISOString();
  const [gas, fee, tick] = await Promise.allSettled([
    post(SRC.base, { jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }).then(j => { const w = parseInt(j.result, 16); if (!(w > 0)) throw new Error('bad gas'); return { wei: w, at: at() }; }),
    post(SRC.xrpl, { method: 'fee', params: [{}] }).then(j => { const d = +(j.result && j.result.drops && j.result.drops.open_ledger_fee); if (!(d > 0)) throw new Error('bad fee'); return { drops: d, at: at() }; }),
    fetch(SRC.kraken, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).then(j => { if (j.error && j.error.length) throw new Error(j.error.join(','));
      const px = k => { const e = Object.entries(j.result || {}).find(([n]) => n.includes(k)); const v = e ? +e[1].c[0] : NaN; return v > 0 ? v : null; };
      return { eth: px('ETH'), xrp: px('XRP'), at: at() }; })
  ]);
  const v = s => s.status === 'fulfilled' ? s.value : null;
  return { gas: v(gas), fee: v(fee), tick: v(tick) };
}

// Pure: amount in USD + live inputs ({gas:{wei,at}, fee:{drops,at}, tick:{eth,xrp,at}}, any may be null).
export function buildRails(amount, inp, now = Date.now()) {
  const { gas, fee, tick } = inp || {}, pct = usd => usd == null ? null : r6(usd / amount * 100);
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
  const cardUsd = amount * CARD.pct / 100 + CARD.fixedUsd;
  rails.push({ rail: 'card', status: 'static-estimate', feeUsd: r4(cardUsd), feePct: pct(cardUsd), settlement: '~1-3 business days (payout), chargebacks possible for months', settlementSec: 2 * 86400,
    inputs: { pct: CARD.pct, fixedUsd: CARD.fixedUsd }, dataAt: null, source: CARD.source });
  const ok = rails.filter(r => r.feeUsd != null).sort((a, b) => a.feeUsd - b.feeUsd || a.settlementSec - b.settlementSec);
  const fastest = rails.filter(r => r.feeUsd != null).sort((a, b) => a.settlementSec - b.settlementSec)[0];
  const best = ok[0];
  return {
    asOf: new Date(now).toISOString(), amountUsd: amount, rails,
    recommended: { rail: best.rail, why: `lowest estimated fee ($${best.feeUsd}) for $${amount}` + (best.status === 'static-estimate' ? ' (only static card estimate available; live rails failed)' : ''), fastest: fastest.rail },
    sourceStatus: { baseRpc: gas ? 'ok' : 'unavailable', xrplFee: fee ? 'ok' : 'unavailable', krakenTicker: tick ? 'ok' : 'unavailable' },
    notes: ['Fee estimates for one transfer; excludes on/off-ramp, exchange withdrawal and FX costs.', 'Card is a static reference rate, not a live quote; actual card pricing varies by processor and card type.', 'Live inputs cached ~60s. ' + DISCLAIMER + '.'],
    disclaimer: DISCLAIMER
  };
}

export async function getRails(amount = 100) {
  if (!(cache && Date.now() - cache.t < TTL)) {
    if (!inflight) inflight = live().then(d => { if (d.tick && (d.gas || d.fee)) cache = { t: Date.now(), d }; return d; }).finally(() => { inflight = null; });
    try { const d = await inflight; const out = buildRails(amount, d); return out.rails.some(r => r.status === 'live') ? out : { error: 'live rail data unavailable, retry shortly' }; }
    catch { return { error: 'upstream data unavailable, retry shortly' }; }
  }
  return { ...buildRails(amount, cache.d), cached: true };
}
