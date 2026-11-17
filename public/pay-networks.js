// Which 402 accept the pay page signs. Base stays the default. A network is offered
// only when that route's accepts list contains it.
export const BASE_NETWORK = 'eip155:8453';
export const BASE_CHAIN_ID = '0x2105';
export const BASE_CHAIN_NUM = 8453;
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const POLYGON_NETWORK = 'eip155:137';
export const POLYGON_CHAIN_ID = '0x89';
export const POLYGON_CHAIN_NUM = 137;
export const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const LABELS = { base: 'Base USDC', polygon: 'Polygon USDC', solana: 'Solana USDC' };

export function networkId(accept) {
  if (!accept) return null;
  if (accept.network === BASE_NETWORK) return 'base';
  if (accept.network === POLYGON_NETWORK) return 'polygon';
  if (accept.network === SOLANA_NETWORK || accept.network === 'solana') return 'solana';
  return null;
}

/** Base first when it is listed, then the other networks in accepts order. */
export function offeredNetworks(accepts) {
  const ids = [];
  for (const a of accepts || []) {
    const id = networkId(a);
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.includes('base')) {
    ids.splice(ids.indexOf('base'), 1);
    ids.unshift('base');
  }
  return ids.map(id => ({ id, label: LABELS[id] }));
}

export function acceptFor(accepts, id) {
  return (accepts || []).find(a => networkId(a) === id) || null;
}

/** Documented x402 v2 Solana exact payload. transaction is the base64 partial transaction. */
export function solanaPaymentPayload(challenge, accept, transactionB64) {
  return {
    x402Version: 2,
    resource: challenge.resource,
    accepted: accept,
    payload: { transaction: transactionB64 },
    extensions: challenge.extensions
  };
}

/** Same EIP-3009 body the Base button already sends, for whichever EVM accept was chosen. */
export function evmPaymentPayload(challenge, accept, authorization, signature) {
  return {
    x402Version: 2,
    payload: { authorization, signature },
    extensions: challenge.extensions,
    resource: challenge.resource,
    accepted: accept
  };
}
