# GW8 Signal API (Apify Actor)

Signal-only market and public-sector data for agents and analysts, billed per result by card through Apify.
**Not financial advice. No trading, no execution, no wallets.**

Need a page as Markdown instead of a signal? Use [Agent Page Extract](https://apify.com/gw8cap/agent-page-extract).

## Feeds
Prices are the four live pay-per-event names. `value` and `growth` feeds use those same events.

| Feed | What you get | Price per result | Event |
|---|---|---|---|
| `coin` | WaveTrend 4h snapshot for one symbol | $0.01 | `lite-result` |
| `govcontracts` | Federal contract awards (last 14 days, USAspending) to AI, drone, nuclear, robotics, space, quantum and defense-tech companies: ticker, amount, agency, date, award link. Filters: ticker, sector, keyword. DoD awards appear ~90 days late on USAspending. | $0.015 | `standard-result` |
| `regime` | Stage 1 crypto regime score 0–4 with raw values (ETF flows, BTC support, alt breadth, Fear & Greed) | $0.015 | `standard-result` |
| `dots` | WaveTrend oversold/overbought band dots on 66 Kraken 4h USD pairs | $0.015 | `standard-result` |
| `verdict` | Token safety screen CLEAR / CAUTION / AVOID / UNKNOWN (GoPlus + DexScreener); base, ethereum, bsc, polygon, arbitrum, optimism, avalanche, solana, and the other supported slugs | $0.015 | `standard-result` |
| `value` | Value-capture score for one symbol (default BNB). DefiLlama holder revenue and curated rule classes. | $0.015 | `standard-result` |
| `growth-chain` | Growth-lane rules for one chain or app (`growthChain`, slug or ticker) | $0.015 | `standard-result` |
| `flows` | Kraken large-print buy vs sell summary (last 1,000 public trades, single venue) + WaveTrend 4h state, per symbol | $0.03 | `premium-result` |
| `brief` | Crypto brief refreshed on each closed Kraken 4h bar: regime score, band-dot counts, top 10 by dot strength, BTC/ETH/SOL flows | $0.03 | `premium-result` |
| `rwa` | Tokenized RWA protocols by TVL, 7d flows, movers, yields (DefiLlama + CoinGecko) | $0.03 | `premium-result` |
| `kraken-listings` | Kraken new USD listings (30 days) with % since listing and WaveTrend state | $0.03 | `premium-result` |
| `rules` | CFTC + SEC crypto rule-change feed (90 days) with comment deadlines | $0.03 | `premium-result` |
| `value-batch` | Value-capture screen, up to 25 symbols or the covered set (`sort`, `minScore`) | $0.03 | `premium-result` |
| `growth` | Growth-lane screen (`kind`, `minRulesPassed`, `triggerOnly`, `minTvlUsd`; window 90d) | $0.03 | `premium-result` |
| `history` | Simulated 90-day hit-rate backtest of WaveTrend dots (not a live trade log) | $0.07 | `history-result` |
| `value-history` | Weekly value-capture snapshots (`weeks` 1-52) | $0.07 | `history-result` |
| `growth-history` | Weekly growth-lane snapshots and first week each rule passed | $0.07 | `history-result` |

**No charge on failure:** a result is charged only when data comes back. Upstream errors are pushed as `ok: false` items and not charged.
Free preview (no account): https://micro-saas-agent.onrender.com/api/brief/teaser · Track record: https://micro-saas-agent.onrender.com/track

## Run
The Actor is a short HTTPS client. It does not open a browser.

- Memory defaults to **256 MB**, which is also the maximum. The minimum is 128 MB.
- `endpoint` is required. The Console prefill is `govcontracts`, which is also the schema default.
- One successful dataset row charges one of `lite-result` ($0.01), `standard-result` ($0.015), `premium-result` ($0.03), or `history-result` ($0.07). A failed call is stored and not charged.
- Apify bills platform compute separately from the result price. At 256 MB a single feed stays on that tier; the request aborts after 110 seconds.
- In Console, open the Actor, leave the prefilled endpoint or pick another feed, then Start. `flows` and `coin` take a `symbols` list (max 10). `verdict` needs `chain` and `address`.

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
