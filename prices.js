// Single price knobs. Atomic USDC (6 decimals) is derived from the USD string.
// P2 revert: set VERDICT_PRICE_USD back to '0.01' and DEEP_PRICE_USD back to '0.05'.
// The honeypot alias charges VERDICT_PRICE_USD. The honeypot-deep alias charges DEEP_PRICE_USD.
// Do not edit the atomic amount on its own, and do not change payout addresses here.
export const VERDICT_PRICE_USD = '0.005';
export const DEEP_PRICE_USD = '0.03';
export const RAILS_ROUTE_PRICE_USD = '0.005';
export const FUEL_SURCHARGE_PRICE_USD = '0.005';
// Brief ($0.02) plus regime ($0.01) bought separately is $0.03. The bundle is cheaper.
export const DAILY_BUNDLE_PRICE_USD = '0.025';

export function usdAtomic(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) throw new Error('bad usd');
  return String(Math.round(n * 1e6));
}
