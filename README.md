# GW8 Signal API

Pay-per-call crypto signals, token verdicts, flows and briefs. x402 USDC on Base. Signal only, not financial advice.

**Multi-rail HTTP routes.** Base, Polygon, and Solana USDC, at that route's existing price, are accepted only on these five paid HTTP routes:

- `GET /api/rails`
- `GET /api/rails/route`
- `GET /api/regime`
- `POST /api/pay/should-i-pay`
- `GET /api/coin/{symbol}`

Base and Polygon `payTo` is `0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd`. Solana `payTo` is `3ZgRNAMaM39WQt7rvwMf7tZjQakZqA5ieULpoQuo4chD`. `POLYGON_PAYMENTS=off` or `SOLANA_PAYMENTS=off` removes that network from `accepts`. Every other paid HTTP route is Base USDC only. MCP tools (`POST /mcp`) stay USDC on Base and do not accept Polygon or Solana.

**Day pass ($1.00).** `POST /api/pass/day` is one x402 payment of $1.00 USDC for 24 hours of paid data calls. The token is returned once. Send it as the `X-GW8-Pass` header on paid HTTP data routes, or as the MCP `pass` argument. Fair use is 2000 calls per pass and 60 calls per minute. A failed data call is not counted against the cap. The pass does not cover `POST /api/alerts/subscribe`, `POST /api/brief/weekly/subscribe`, or another `POST /api/pass/day`.

<a href="https://mcprush.com/to/gw8-signal-api-mcp?ref=badge"><img width="380" height="200" src="https://mcprush.com/badge/gw8-signal-api-mcp/card.svg" alt="GW8 Signal API MCP server" /></a>

**MCP endpoint:** `https://micro-saas-agent.onrender.com/mcp` (Streamable HTTP, no sign-in)

```
claude mcp add --scope user --transport http gw8-signal-api-mcp https://micro-saas-agent.onrender.com/mcp
```

**Agent payment tools** (x402, also MCP tools). Built for agent spending limits and approved-seller allowlists. Agent guide: [`/agents.md`](https://micro-saas-agent.onrender.com/agents.md).
- `POST /api/pay/should-i-pay` (`should_i_pay`, $0.02): spend policy + seller reputation in one call -> pay / dont_pay / ask_human, one receipt (Ed25519-signed when signing is enabled; see /.well-known/gw8-receipt-key `enabled`).
- `POST /api/spend/check` (`check_spend_policy`, $0.02): allow / deny / needs_approval for a proposed payment against your policy.
- `POST /api/seller/reputation` (`check_seller_reputation`, $0.01): 0-100 score and trusted / caution / avoid / unknown for an x402 seller wallet or endpoint, from public Base USDC history (buyers, wash share, age, concentration, 30d volume). Free data-source check: `GET /api/seller/reputation/status`.
  Data source: Alchemy Transfers API when the server has `ALCHEMY_API_KEY` set (free plan is enough), else keyless Blockscout. `GET /api/seller/reputation/status` shows which source is active.

All three return a receipt (Ed25519-signed when signing is enabled; see /.well-known/gw8-receipt-key `enabled`) (free check: `POST /api/receipt/verify`). Value-capture and growth-lane screens are on `/api/value` and `/api/growth` (free `/status` on each). Day pass first for repeated calls: `POST /api/pass/day` ($1.00, 24h, header `X-GW8-Pass`). Full list: [`/llms.txt`](https://micro-saas-agent.onrender.com/llms.txt).

**Which routes sold:** [`GET /api/sales`](https://micro-saas-agent.onrender.com/api/sales) (add `?days=30` for a longer window). Free, no payment. Counts by route template, surface (`x402`, `rapidapi`, `apify`), and UTC day: `paid` (a new x402 settlement or a marketplace 2xx), `pass` (served with a day pass), `quotes` (HTTP 402), `sample`, and `free`. No buyer addresses or request data. The on-chain USDC transfer still shows only the amount; this is the route name that goes with it.
