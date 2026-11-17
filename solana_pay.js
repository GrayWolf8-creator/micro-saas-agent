// Third x402 accept: Solana mainnet USDC, after Base and Polygon.
// Public facilitator, no API key. The shared lane accepts POST /verify and POST /settle
// with no Authorization header.
// https://docs.payai.network/x402/solana-mainnet-express
// https://solana.com/docs/payments/agentic-payments/x402
// Client payload: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
//
// Circle's Solana USDC mint (not a lookalike):
// https://developers.circle.com/stablecoins/usdc-contract-addresses
import { pathAcceptsPolygon } from './polygon_pay.js';

export const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_PAYTO = 'HtffQ9mFdLcyCoNnh5nbDnTyaFLEcLQhS8NnWZp3axFg';
export const SOLANA_FACILITATOR_URL = 'https://facilitator.payai.network';
export const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const FEE_TTL_MS = 60 * 1000;
const ACCOUNT_TTL_MS = 60 * 1000;

/** Same five routes as Polygon. */
export function pathAcceptsSolana(pathname) {
  return pathAcceptsPolygon(pathname);
}

/** Default on. SOLANA_PAYMENTS=off (also 0, false, no) drops Solana from accepts. */
export function solanaPaymentsEnabled(env = process.env) {
  const v = env && env.SOLANA_PAYMENTS;
  if (v == null || String(v).trim() === '') return true;
  return !['0', 'off', 'false', 'no'].includes(String(v).trim().toLowerCase());
}

export function feePayerFromSupported(body) {
  const kinds = body && Array.isArray(body.kinds) ? body.kinds : [];
  const kind = kinds.find(k => k && k.x402Version === 2 && k.scheme === 'exact' && k.network === SOLANA_NETWORK && k.extra && typeof k.extra.feePayer === 'string' && k.extra.feePayer);
  return kind ? kind.extra.feePayer : null;
}

export function solanaAccept(amount, payTo, feePayer) {
  return {
    scheme: 'exact',
    network: SOLANA_NETWORK,
    amount,
    asset: USDC_SOLANA,
    payTo,
    maxTimeoutSeconds: 300,
    extra: { feePayer, decimals: 6 }
  };
}

/** null = the RPC body was not a usable answer. */
export function usdcAccountExists(body) {
  if (!body || body.error) return null;
  const value = body.result && body.result.value;
  if (!Array.isArray(value)) return null;
  return value.length > 0;
}

let feeCache = { at: 0, feePayer: null };
let accountCache = { at: 0, exists: null };

export function cachedSolanaFeePayer() {
  return feeCache.feePayer;
}

export function _resetSolanaCache() {
  feeCache = { at: 0, feePayer: null };
  accountCache = { at: 0, exists: null };
}

export async function refreshSolanaFeePayer(deps = {}) {
  const now = deps.now ?? Date.now();
  if (feeCache.feePayer && now - feeCache.at < FEE_TTL_MS) return feeCache.feePayer;
  const fetchImpl = deps.fetch || fetch;
  try {
    const r = await fetchImpl(SOLANA_FACILITATOR_URL + '/supported', { signal: AbortSignal.timeout(2500), headers: { accept: 'application/json' } });
    if (!r.ok) return feeCache.feePayer;
    const feePayer = feePayerFromSupported(await r.json());
    if (!feePayer) return feeCache.feePayer;
    feeCache = { at: now, feePayer };
    return feePayer;
  } catch {
    return feeCache.feePayer;
  }
}

/**
 * PayAI does not create the merchant USDC account, and the SVM fee payer must not
 * appear in an ATA-create instruction. exists true/false, or null when the public
 * RPC could not be read (caller must not settle).
 */
export async function payeeUsdcAccountExists(owner = SOLANA_PAYTO, deps = {}) {
  const now = deps.now ?? Date.now();
  if (accountCache.exists != null && now - accountCache.at < ACCOUNT_TTL_MS && !deps.fresh) return accountCache.exists;
  const fetchImpl = deps.fetch || fetch;
  const body = { jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [owner, { mint: USDC_SOLANA }, { encoding: 'jsonParsed' }] };
  try {
    const r = await fetchImpl(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return null;
    const exists = usdcAccountExists(await r.json());
    if (exists == null) return null;
    accountCache = { at: now, exists };
    return exists;
  } catch {
    return null;
  }
}
