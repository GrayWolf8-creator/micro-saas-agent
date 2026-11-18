// Test-only preload (node --import). Settles the CDP facilitator without a network call,
// and serves a fixed daily bundle and brief teaser so the paid path does not fan out to Kraken.
const realFetch = globalThis.fetch;
globalThis.__gw8TestDailyBundle = () => ({
  bundle: true,
  priceUsd: '0.025',
  includes: { brief: 'GET /api/brief', regime: 'GET /api/regime' },
  separateUsd: '0.03',
  brief: {
    date: '2026-11-18',
    regime: { score: 3, outOf: 4 },
    top10ByDotStrength: [{ name: 'LINK', kind: 'green', strength: 68.5 }],
    flowsSummary: [{ symbol: 'BTC', bias: 'balanced', largeNetUsd: 240000 }]
  },
  regime: {
    score: 3,
    outOf: 4,
    checks: { etfInflows: { status: 'pass', detail: { totalMusd: 12 }, rule: '3-day ETF flow is positive' } }
  },
  disclaimer: 'signal only, not financial advice'
});
globalThis.__gw8TestTeaserInput = {
  regime: {
    score: 3,
    checks: {
      etfInflows: { status: 'pass' },
      btcQuietSupport: { status: 'pass' },
      altsNotFreefall: { status: 'fail' },
      noGreedChase: { status: 'pass' }
    }
  },
  dots: {
    asOf: '2026-11-18T12:00:00.000Z',
    bandDots: [
      { name: 'LINK', kind: 'green', band: 'outer', wt1: -70, latest: true },
      { name: 'AAVE', kind: 'red', band: 'outer', wt1: 62, latest: true },
      { name: 'SOL', kind: 'green', band: 'inner', wt1: -55, latest: false },
      { name: 'DOGE', kind: 'red', band: 'inner', wt1: 54, latest: false }
    ]
  },
  track: { backtest: { summary: { green_all: { '7d': { hitRatePct: 61, n: 40 } } } } },
  now: new Date('2026-11-18T18:00:00.000Z')
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith('/platform/v2/x402/verify')) {
    return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/platform/v2/x402/settle')) {
    return new Response(JSON.stringify({ success: true, transaction: '0xstubsettlement' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
