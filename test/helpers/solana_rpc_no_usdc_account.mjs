// Test-only preload (node --import). Makes the Solana RPC lookup for the payee's USDC
// account answer "no account", so the PAYEE_USDC_ACCOUNT_MISSING path is tested offline
// instead of depending on the live wallet's on-chain state. All other fetches pass through.
const RPC = 'https://api.mainnet-beta.solana.com';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url) === RPC) {
    let method = null;
    try { method = JSON.parse(opts.body || '{}').method; } catch {}
    if (method === 'getTokenAccountsByOwner') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  return realFetch(url, opts);
};
