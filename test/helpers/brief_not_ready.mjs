// Test-only preload. The brief is not ready, and a facilitator verify/settle is counted if one is attempted.
globalThis.__gw8TestBrief = async () => ({
  error: 'brief is still warming up, retry shortly',
  http: 503,
  retryAfter: 5,
  notReady: true
});
globalThis.__gw8FacilitatorHits = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/x402/verify') || u.includes('/x402/settle')) {
    globalThis.__gw8FacilitatorHits.push(u);
    return new Response(JSON.stringify({ isValid: true, success: true, transaction: '0xshould-not-settle' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
