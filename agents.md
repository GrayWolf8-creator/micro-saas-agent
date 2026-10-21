# GW8 Signal API: guide for AI agents

Base URL: `https://micro-saas-agent.onrender.com` · MCP: `https://micro-saas-agent.onrender.com/mcp` (Streamable HTTP, no sign-in)
Pay per call with x402 v2: USDC on Base (`eip155:8453`), asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
Signal only. No trading, no custody, not financial advice. Full route list: `/openapi.json`. Short menu: `/llms.txt`.

## How paying works (all paid calls)
1. Call the route with no payment. You get **402** and a `PAYMENT-REQUIRED` header (base64 JSON: `accepts[0].amount`, `payTo`, `network`).
2. Sign it with an x402 client (e.g. `wrapFetchWithPayment` from `@x402/fetch`) and retry with `PAYMENT-SIGNATURE`.
3. **Bad input never costs money.** Invalid bodies get `400 {error, note:"no payment was taken"}` before any 402.
4. **No charge on failure.** We verify the payment, build the answer, and settle only if the answer is ready. If an upstream source is down you get 503 and are not charged.
5. **Idempotency / safe retry:** resending the *same* `PAYMENT-SIGNATURE` to the same URL within 15 minutes returns the same response (`X-GW8-Replay: true`) with no second charge. If you time out, retry with the same signature. Do not sign a new payment just to retry.
6. Many calls? `POST /api/pass/day` ($1.00) gives 24h of every paid data call via the `X-GW8-Pass` header (fair use 2000/day, 60/min). Bad input or upstream failures do not use up pass calls.

## Verify a receipt
Every paid response carries a signed receipt (`receipt` in the body, plus `X-GW8-Receipt` + `X-GW8-Receipt-Signature` headers). The decision endpoints also return their own `decisionReceipt` / `reputationReceipt`.
- Free check: `POST /api/receipt/verify` with `{"payload": "<receipt.payload>", "signature": "<receipt.signature>", "data": <the result object without its receipt>}` → `{valid, dataMatches}`.
- Offline: Ed25519-verify `utf8(payload)` against `base64(signature)` with the key from `GET /api/proof/pubkey`. `response_sha256` = sha256 of `JSON.stringify(data)`.
- `query.requestSha256` = sha256 of the canonical JSON (sorted keys, no spaces) of what you sent. It proves which request the decision was for.

## Featured: agent payments (risk checks before paying)

### POST /api/pay/should-i-pay · $0.02 · MCP `should_i_pay`
**Use this when** your agent is about to pay an invoice, merchant or x402 seller and you want one answer: **pay / dont_pay / ask_human**.
It runs the spend-policy check and the seller reputation check together. You pay once and get one signed receipt.
```json
{"payment": {"amount": "0.05", "currency": "USDC", "chain": "base", "recipientId": "0x1111111111111111111111111111111111111111", "merchantCategory": "data-api", "timestamp": "2026-10-21T15:30:00Z"},
 "policy": {"currency": "USDC", "perTxLimit": "1", "rollingCap": {"limit": "10", "spentSoFar": "2.40"}, "allowedChains": ["base"], "requireApprovalAbove": "0.50"},
 "seller": {"address": "0x1111111111111111111111111111111111111111"},
 "sellerRules": {"onCaution": "ask_human", "onUnknown": "ask_human", "minScore": 50}}
```
Returns `{verdict, reasons:[{source, action, detail}], spend:{decision,...}, seller:{verdict, score, components,...}, decisionReceipt}`.
Rules (worst wins): spend deny or seller avoid → `dont_pay`. Spend needs_approval, seller caution/unknown (configurable), or recipientId ≠ the seller address scored → `ask_human`. Otherwise `pay`. Not charged if seller data is unavailable.

### POST /api/spend/check · $0.02 · MCP `check_spend_policy`
**Use this when** you only need to check a payment against the buyer's rules: per-tx limit, rolling cap (you send `spentSoFar`), categories, allow/deny lists, hours + timezone, assets/chains, and the human-approval threshold.
Body `{payment, policy}` (same shape as above). Returns `{decision: allow|deny|needs_approval, reasons, checks, remaining, decisionReceipt}`. Pure rules, no network, stateless.

### POST /api/seller/reputation · $0.01 · MCP `check_seller_reputation`
**Use this when** you want to know if an x402 seller is real before paying it.
Body `{"address": "0x…"}` (seller wallet on Base) and/or `{"endpoint": "https://…"}` (we read `payTo` from its unpaid 402), optional `lookbackDays` 1-90.
Returns `{score 0-100, verdict: trusted|caution|avoid|unknown, components:{distinctBuyers, washShare, walletAge, concentration, volume30d}, reasons, flags, reputationReceipt}`.
Data: public USDC transfers on Base (Alchemy Transfers API; keyless Blockscout fallback). Heuristic, not a guarantee. **Free first:** `GET /api/seller/reputation/status` → `{source, keyed, reachable, http_status}`. If `reachable` is false, paid calls return 503 and are not charged.

## Featured: verdicts and payment rails
- **GET /api/verdict/{chain}/{address} · $0.01 · MCP `get_token_verdict`.** Use this when you're about to buy, hold or accept a token and want a 0-100 safety verdict (safe / caution / danger) with reasons (GoPlus + DexScreener). Example: `/api/verdict/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- **GET /api/rails?amount=100 · $0.002 · MCP `get_payment_rails`.** Use this when choosing how to move a USD amount: live fee and speed for Base USDC, XRPL, Tempo and Arc vs card, plus a recommended rail.

## Featured: crypto market data
| Call | Price | Use this when |
| --- | --- | --- |
| GET /api/coin/{symbol} | $0.002 | you need one coin's WaveTrend 4h state (cheapest) |
| GET /api/regime | $0.01 | you need risk-on / risk-off (Stage 1 score 0-4: ETF flows, BTC support, alt breadth, Fear & Greed) |
| GET /api/dots | $0.01 | you want every oversold/overbought WaveTrend band dot on 66 Kraken 4h pairs |
| POST /api/agent | $0.02 | you want regime + all dots in one shot |
| GET /api/brief | $0.02 | you want the once-a-day digest (free teaser: /api/brief/teaser) |
| GET /api/rs | $0.02 | you want relative strength and sector scores |
| GET /api/flows/{symbol} | $0.02 | you want Kraken large-print buy/sell flow with WaveTrend state |
| GET /api/kraken/listings | $0.02 | you want new Kraken USD listings from the last 30 days |
| GET /api/history | $0.05 | you want a **simulated** 90-day hit-rate backtest |

Example output (`/api/coin/BTC`, inside `signal`): `{"asOf":"…","name":"BTC","wt1":-12.4,"wt2":-10.1,…,"disclaimer":"signal only, not financial advice"}`. Free try: `GET /api/sample`.

## Access
- POST /api/pass/day ($1.00): 24h pass (`X-GW8-Pass`).
- POST /api/alerts/subscribe ($0.50): green-dot webhooks (HMAC). Body `{"webhookUrl":"https://…"}`.
- POST /api/brief/weekly/subscribe ($0.25): 4 Monday briefs by webhook.

## Free
`/api/sample`, `/api/brief/teaser`, `/api/seller/reputation/status`, `/track`, `/api/stats`, `/api/proof/pubkey`, `/api/receipt/verify`, `/llms.txt`, `/openapi.json`, `/.well-known/x402`.
