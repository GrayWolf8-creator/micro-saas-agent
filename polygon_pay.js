// Second x402 accept: Polygon native USDC, listed after the unchanged Base accept.
// Public facilitator, no API key. Mainnet URL and eip155:137 come from
// https://docs.polygon.technology/payment-services/agentic-payments/x402/intro
// and https://docs.polygon.technology/payment-services/agentic-payments/x402/guides/quickstart-sellers
//
// Routes: /api/rails and /api/rails/route, plus the three other paid routes with the most
// 2xx calls on the paid method in GET /api/stats (30 Mountain Time days; OPTIONS excluded).
// GET /api/sales could not rank three others (disk wipe: two settlements total).
// Stats rank, excluding the two rails routes: GET /api/regime (9), POST /api/pay/should-i-pay (6),
// then a three-way tie at 3 (coin, verdict, govcontracts). likelyBuyer.paid breaks that tie: coin 2, verdict 1, govcontracts 1.

export const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const POLYGON_NETWORK = 'eip155:137';
export const POLYGON_FACILITATOR_URL = 'https://x402.polygon.technology';

const EXACT = new Set(['/api/rails', '/api/rails/route', '/api/regime', '/api/pay/should-i-pay']);

/** Default on. POLYGON_PAYMENTS=off (also 0, false, no) drops Polygon from accepts. */
export function polygonPaymentsEnabled(env = process.env) {
  const v = env && env.POLYGON_PAYMENTS;
  if (v == null || String(v).trim() === '') return true;
  return !['0', 'off', 'false', 'no'].includes(String(v).trim().toLowerCase());
}

/** Pathname of the resource URL, not the raw request, so template quotes match too. */
export function pathAcceptsPolygon(pathname) {
  const p = String(pathname || '').split('?')[0];
  if (EXACT.has(p)) return true;
  return p === '/api/coin' || p.startsWith('/api/coin/');
}

export function paymentNetwork(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const accepted = payload.accepted;
  const raw = (accepted && typeof accepted === 'object' && accepted.network)
    || payload.network
    || (payload.payload && typeof payload.payload === 'object' && payload.payload.network)
    || '';
  return String(raw).trim().toLowerCase();
}

/**
 * Base payments stay on accepts[0] and the CDP facilitator.
 * A Polygon payment uses the Polygon accept only when that route listed one.
 */
export function selectPaymentRequirements(accepts, payload) {
  const list = Array.isArray(accepts) ? accepts : [];
  const base = list[0] || null;
  const net = paymentNetwork(payload);
  if (net === POLYGON_NETWORK || net === 'polygon') {
    const poly = list.find(a => a && String(a.network).toLowerCase() === POLYGON_NETWORK);
    if (poly) return { requirements: poly, facilitator: 'polygon' };
  }
  return { requirements: base, facilitator: 'cdp' };
}
