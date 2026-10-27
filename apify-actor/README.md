# GW8 Signal API (Apify Actor)

Signal-only market and public-sector data for agents and analysts, billed per result by card through Apify.
**Not financial advice. No trading, no execution, no wallets.**

## Feeds
| Feed | What you get | Price per result |
|---|---|---|
| `govcontracts` | Federal contract awards (last 14 days, USAspending) to AI, drone, nuclear, robotics, space, quantum and defense-tech companies: ticker, amount, agency, date, award link. Filters: ticker, sector, keyword. DoD awards appear ~90 days late on USAspending. | $0.02 |
| `flows` | Kraken large-print buy vs sell summary (last 1,000 public trades, single venue) + WaveTrend 4h state, per symbol | $0.03 |
| `brief` | Daily crypto brief: regime score, band-dot counts, top 10 by dot strength, BTC/ETH/SOL flows | $0.03 |
| `regime` | Stage 1 crypto regime score 0–4 with raw values (ETF flows, BTC support, alt breadth, Fear & Greed) | $0.02 |
| `dots` | WaveTrend oversold/overbought band dots on 66 Kraken 4h USD pairs | $0.02 |
| `coin` | WaveTrend 4h snapshot for one symbol | $0.01 |
| `verdict` | Token safety score 0–100 (GoPlus + DexScreener, fixed rules); base/ethereum/bsc/arbitrum/solana | $0.02 |
| `rwa` | Tokenized RWA protocols by TVL, 7d flows, movers, yields (DefiLlama + CoinGecko) | $0.03 |
| `kraken-listings` | Kraken new USD listings (30 days) with % since listing and WaveTrend state | $0.03 |
| `rules` | CFTC + SEC crypto rule-change feed (90 days) with comment deadlines | $0.03 |
| `history` | Simulated 90-day hit-rate backtest of WaveTrend dots (not a live trade log) | $0.075 |
| `value` | Value-capture score for one symbol (default BNB). DefiLlama holder revenue and curated rule classes. | $0.015 |
| `value-batch` | Value-capture screen, up to 25 symbols or the covered set (`sort`, `minScore`) | $0.03 |
| `value-history` | Weekly value-capture snapshots (`weeks` 1-52) | $0.07 |
| `growth-chain` | Growth-lane rules for one chain or app (`growthChain`, slug or ticker) | $0.015 |
| `growth` | Growth-lane screen (`kind`, `minRulesPassed`, `triggerOnly`, `minTvlUsd`; window 90d) | $0.03 |
| `growth-history` | Weekly growth-lane snapshots and first week each rule passed | $0.07 |

**No charge on failure:** a result is charged only when data comes back. Upstream errors are pushed as `ok: false` items and not charged.
Free preview (no account): https://micro-saas-agent.onrender.com/api/brief/teaser · Track record: https://micro-saas-agent.onrender.com/track

## Example input
```json
{ "endpoint": "govcontracts", "sector": "ai" }
```
```json
{ "endpoint": "flows", "symbols": ["BTC", "ETH", "SOL"] }
```

## Output
One dataset item per call: `{ endpoint, symbol, ok, fetchedAt, data, disclaimer }`.

Past performance is not indicative of future results. Data is derived from public sources and may be delayed or incomplete.
