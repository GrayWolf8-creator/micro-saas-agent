// rwa.js — real-world asset (RWA) feed: tokenized treasuries, credit, stocks, commodities.
// Public no-key data only (DefiLlama protocols + yields, CoinGecko RWA category). Nothing invented:
// missing values stay null and every failed source is listed in sourceStatus.
const DISCLAIMER = 'signal only, not financial advice';
const TTL = 10 * 60 * 1000;
const SRC = {
  protocols: 'https://api.llama.fi/protocols',
  yields: 'https://yields.llama.fi/pools',
  tokens: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=real-world-assets-rwa&order=market_cap_desc&per_page=20&page=1&price_change_percentage=24h,7d'
};
const r2 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100;
const getJson = async (url, ms = 20000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
let cache = null, inflight = null;

export function buildRwa(protocolsRaw, poolsRaw, tokensRaw, now = Date.now()) {
  const sourceStatus = { defillamaProtocols: protocolsRaw ? 'ok' : 'unavailable', defillamaYields: poolsRaw ? 'ok' : 'unavailable', coingeckoRwa: tokensRaw ? 'ok' : 'unavailable' };
  const rwa = (protocolsRaw || []).filter(p => p && p.category === 'RWA');
  const slugs = new Set(rwa.map(p => p.slug));
  const withTvl = rwa.filter(p => typeof p.tvl === 'number' && p.tvl > 0);
  let total = 0, prev7 = 0, n7 = 0;
  for (const p of withTvl) { total += p.tvl; if (typeof p.change_7d === 'number' && p.change_7d > -100) { prev7 += p.tvl / (1 + p.change_7d / 100); n7++; } else prev7 += p.tvl; }
  const prot = p => ({ name: p.name, slug: p.slug, tvlUsd: Math.round(p.tvl), change1dPct: r2(p.change_1d), change7dPct: r2(p.change_7d),
    flow7dUsdEst: typeof p.change_7d === 'number' && p.change_7d > -100 ? Math.round(p.tvl - p.tvl / (1 + p.change_7d / 100)) : null,
    chains: (p.chains || []).slice(0, 6), listedAt: p.listedAt ? new Date(p.listedAt * 1000).toISOString().slice(0, 10) : null, url: p.url || null });
  const top = [...withTvl].sort((a, b) => b.tvl - a.tvl).slice(0, 15).map(prot);
  const moversUp = withTvl.filter(p => typeof p.change_7d === 'number' && p.tvl >= 5e6).sort((a, b) => b.change_7d - a.change_7d).slice(0, 5).map(prot);
  const moversDown = withTvl.filter(p => typeof p.change_7d === 'number' && p.tvl >= 5e6).sort((a, b) => a.change_7d - b.change_7d).slice(0, 5).map(prot);
  const cutoff = now / 1000 - 30 * 86400;
  const newLaunches = rwa.filter(p => p.listedAt && p.listedAt >= cutoff).sort((a, b) => b.listedAt - a.listedAt).slice(0, 10)
    .map(p => ({ name: p.name, slug: p.slug, listedOnDefiLlama: new Date(p.listedAt * 1000).toISOString().slice(0, 10), tvlUsd: typeof p.tvl === 'number' ? Math.round(p.tvl) : null, chains: (p.chains || []).slice(0, 6), url: p.url || null }));

  const pools = ((poolsRaw && poolsRaw.data) || []).filter(x => slugs.has(x.project) && typeof x.tvlUsd === 'number');
  const yields = [...pools].filter(x => typeof x.apy === 'number' && x.apy > 0 && x.tvlUsd >= 1e6).sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 15)
    .map(x => ({ project: x.project, symbol: x.symbol, chain: x.chain, apyPct: r2(x.apy), apy30dAvgPct: r2(x.apyMean30d), tvlUsd: Math.round(x.tvlUsd), pool: `https://defillama.com/yields/pool/${x.pool}` }));
  // Some big tokenized-treasury issuers (e.g. BUIDL, USDY, USYC) carry no protocol TVL on DefiLlama but do appear in its yields data.
  const byProj = {}; for (const x of pools) byProj[x.project] = (byProj[x.project] || 0) + x.tvlUsd;
  const largestByPoolValue = Object.entries(byProj).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([project, v]) => ({ project, poolTvlUsd: Math.round(v) }));

  const tokens = (Array.isArray(tokensRaw) ? tokensRaw : []).filter(t => t && t.market_cap > 0).slice(0, 15).map(t => ({ name: t.name, symbol: String(t.symbol || '').toUpperCase(), priceUsd: t.current_price, marketCapUsd: Math.round(t.market_cap),
    change24hPct: r2(t.price_change_percentage_24h_in_currency ?? t.price_change_percentage_24h), change7dPct: r2(t.price_change_percentage_7d_in_currency), volume24hUsd: t.total_volume != null ? Math.round(t.total_volume) : null, coingeckoId: t.id }));

  if (!withTvl.length && !yields.length && !tokens.length) return { error: 'upstream data unavailable, retry shortly' };
  return {
    asOf: new Date(now).toISOString(),
    summary: withTvl.length ? { rwaProtocolsTracked: rwa.length, protocolsWithTvl: withTvl.length, totalTvlUsd: Math.round(total), tvl7dAgoUsdEst: Math.round(prev7), netChange7dUsdEst: Math.round(total - prev7), netChange7dPct: r2(prev7 ? (total / prev7 - 1) * 100 : null) } : null,
    topProtocolsByTvl: top, movers7d: { up: moversUp, down: moversDown }, newLaunches30d: newLaunches,
    yields: { topPoolsByTvl: yields, largestIssuersByPoolTvl: largestByPoolValue },
    topTokensByMarketCap: tokens,
    sourceStatus,
    sources: [SRC.protocols + ' (category=RWA)', SRC.yields + ' (projects in RWA category)', SRC.tokens],
    notes: [
      '7d change is TVL change from DefiLlama change_7d; it mixes net inflows with price moves, so flow7dUsdEst is an estimate, not a confirmed net deposit.',
      'Some large tokenized-treasury issuers report no protocol TVL on DefiLlama; see yields.largestIssuersByPoolTvl for their tracked pool value.',
      'newLaunches30d = date first listed on DefiLlama, which can lag the real launch.',
      'topTokensByMarketCap is CoinGecko\'s real-world-assets category as-is: it mixes asset tokens (e.g. tokenized loans) with RWA infrastructure/chain tokens (e.g. LINK, XLM), and market caps can rely on issuer-reported supply.',
      'Cached 10 minutes. ' + DISCLAIMER + '.'
    ],
    disclaimer: DISCLAIMER
  };
}

export async function getRwa() {
  if (cache && Date.now() - cache.t < TTL) return { ...cache.data, cached: true };
  if (inflight) return inflight;
  inflight = (async () => {
    const [p, y, t] = await Promise.allSettled([getJson(SRC.protocols), getJson(SRC.yields, 30000), getJson(SRC.tokens)]);
    const v = s => s.status === 'fulfilled' ? s.value : null;
    const data = buildRwa(v(p), v(y), v(t));
    if (!data.error) cache = { t: Date.now(), data };
    else if (cache) return { ...cache.data, cached: true, stale: true };
    return data;
  })().finally(() => { inflight = null; });
  return inflight;
}
