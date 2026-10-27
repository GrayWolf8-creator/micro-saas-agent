# GW8 Signal API

Pay-per-call crypto signals, token verdicts, flows and briefs. x402 USDC on Base. Signal only, not financial advice.

<a href="https://mcprush.com/to/gw8-signal-api-mcp?ref=badge"><img width="380" height="200" src="https://mcprush.com/badge/gw8-signal-api-mcp/card.svg" alt="GW8 Signal API MCP server" /></a>

**MCP endpoint:** `https://micro-saas-agent.onrender.com/mcp` (Streamable HTTP, no sign-in)

```
claude mcp add --scope user --transport http gw8-signal-api-mcp https://micro-saas-agent.onrender.com/mcp
```

**Agent payment tools** (x402, also MCP tools). Agent guide: [`/agents.md`](https://micro-saas-agent.onrender.com/agents.md).
- `POST /api/pay/should-i-pay` (`should_i_pay`, $0.02): spend policy + seller reputation in one call -> pay / dont_pay / ask_human, one signed receipt.
- `POST /api/spend/check` (`check_spend_policy`, $0.02): allow / deny / needs_approval for a proposed payment against your policy.
- `POST /api/seller/reputation` (`check_seller_reputation`, $0.01): 0-100 score and trusted / caution / avoid / unknown for an x402 seller wallet or endpoint, from public Base USDC history (buyers, wash share, age, concentration, 30d volume). Free data-source check: `GET /api/seller/reputation/status`.
  Data source: Alchemy Transfers API when the server has `ALCHEMY_API_KEY` set (free plan is enough), else keyless Blockscout. `GET /api/seller/reputation/status` shows which source is active.

All three return Ed25519-signed receipts (free check: `POST /api/receipt/verify`). Value-capture and growth-lane screens are on `/api/value` and `/api/growth` (free `/status` on each). Day pass first for repeated calls: `POST /api/pass/day`. Full list: [`/llms.txt`](https://micro-saas-agent.onrender.com/llms.txt).
