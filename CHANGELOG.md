\# GW8 Micro-SaaS Agent — System Changelog \& Master Log



All notable changes, architectural updates, and deployment milestones for the Scout Telemetry Infrastructure \& x402 Gateway will be documented here.



\---



\## \[Unreleased]

### x402 seller reputation check (2026-10-21)
- New paid POST /api/seller/reputation ($0.02, x402; day pass accepted) + MCP tool check_seller_reputation. Agent sends a seller wallet on Base and/or an x402 endpoint URL (payTo read from its unpaid 402 challenge; https only, public hosts only, no redirects, 5s timeout). Returns score 0-100, verdict trusted / caution / avoid / unknown, components, reasons, flags and a signed receipt built with trust.js buildReceipt (query carries requestSha256 and dataSha256 of the scored transfers).
- Data: public USDC Transfer history from Blockscout's keyless Etherscan-compatible API (newest 1000 transfers + first-ever transfer, 8s timeouts, 8 MB cap, max 90-day window; REPUTATION_EXPLORER_URL can point at another Blockscout). Canonical USDC only; dust < $0.001 and lookalike tokens ignored.
- Scoring (new reputation.js, pure + deterministic): buyers /30, wash share (self-transfers + round-trip payers) /25, wallet age /15, top-payer concentration /20, 30d organic volume /10. avoid if score < 40, wash >= 50% or payTo mismatch; trusted needs >= 70, >= 5 organic buyers and >= 30d age; unknown when no payments in the window.
- Validate-first: malformed bodies get 400 {error, note:'no payment was taken'} before the x402 challenge or pass check. Data source down -> 503, not settled / pass call refunded. Stateless: the checked address/endpoint is not stored. Listed in /, openapi, /.well-known/x402, llms.txt, MCP server card, stats, 402 paid-adds. 10 offline tests.
- Free GET /api/seller/reputation/status: {source:'blockscout', reachable, http_status, latency_ms, checked_at, cached, cache_ttl_s}. One fixed probe (newest 1 USDC transfer of the USDC contract; no user input), 4s timeout, 64 KB cap, cached 60s with a shared in-flight probe, no receipt, no URL/env in the output. 4 offline tests (reachable, 403, timeout, cache hit).

### Spend-policy check for AI agents (2026-10-21)
- New paid POST /api/spend/check ($0.02, x402; day pass accepted) + MCP tool check_spend_policy. Agent sends {payment, policy}; returns allow / deny / needs_approval, the rules that fired, every check, remaining limits and a signed decision receipt built with trust.js buildReceipt (same Ed25519 key, /api/proof/pubkey; checkable at free /api/receipt/verify; signed:false when no key). The receipt's signed fields carry query.requestSha256 (hash of the exact request) and response_sha256 (hash of the evaluation).
- Rules: currency match (no FX), deny list, allow list (onUnlisted deny|needs_approval), blocked/allowed merchant categories, allowed assets, allowed chains, allowed hours + IANA timezone (+days, overnight windows), per-tx limit, rolling cap (caller supplies spentSoFar), human-approval threshold. Exact decimal math (BigInt), deterministic.
- Stateless: nothing about the payment/policy/memo is stored or logged. Invalid bodies get 400 before payment (no charge). New spend.js; listed in /, openapi, /.well-known/x402, llms.txt, MCP server card, stats, 402 paid-adds. Not custody, no payment execution.

### Retire manual tx-hash redemption (2026-10-19)
- `/api/agent` with X-Payment-Tx or ?tx= now returns 410 MANUAL_TX_RETIRED plus the x402 challenge; no data. Anyone could redeem a public transfer to the payout wallet. Stats showed 0 uses. ethers import dropped from server.js (dependency left in package.json). x402 flows unchanged.

### Buyer-vs-bot stats + trust/funnel (2026-10-19)
- Stats: audience split (known x402 monitors/indexers/graders, crawlers, empty UA = bot; else likely buyer; GW8_OWN_WALLETS = self). Per-route buyer/bot quotes and paid calls, unique/repeat/returning payers by anonymized id, top bot names. Legacy totals unchanged except safe-retry replays are tallied as "other", not paid.
- 402s: extra `gw8` body field + X-GW8-Free-Teaser / X-GW8-Best-Value / X-GW8-Paid-Adds / Link headers (free teaser, what the paid call adds, day pass). x402 v2 fields and PAYMENT-REQUIRED header unchanged.
- Payments: verify now also rejects HTTP-200 `isValid:false`; settle network errors handled; day-pass and legacy-tx paths no longer consume a pass/tx when data fails; legacy tx replay guard persisted in Redis. Safe retry: same PAYMENT-SIGNATURE + same URL within 15 min returns the stored response (no second verify/settle).
- Signed receipts: X-GW8-Receipt + X-GW8-Receipt-Signature (Ed25519 via SIGNING_KEY; unsigned when unset). Key at /.well-known/gw8-receipt-key.
- Docs: pay.html, openapi, /.well-known/x402, llms.txt carry the "no charge on failure, signed receipts" line.



\### Planned / Upcoming

\- \[ ] Connect x402 payment facilitator verification logic to live Base Mainnet contract.

\- \[ ] Implement automated telemetry health alerts for cluster drops.



\---



\## \[1.1.0] - 2026-08-02



\### Added

\- \*\*Visual Telemetry Dashboard\*\*: Integrated `index.html` frontend into the Express gateway.

\- \*\*Static Asset Serving\*\*: Enabled `express.static` middleware in `server.js` to serve root dashboard assets.

\- \*\*ES Module Support\*\*: Added `fileURLToPath` and `path` resolution to `server.js` for clean ESM path handling.

\- \*\*Master Changelog\*\*: Created `CHANGELOG.md` to track architectural state and versioning.



\### Changed

\- \*\*Gateway Root Route (`/`)\*\*: Refactored `server.js` from plain text status response (`GW8 Capital Telemetry Gateway Online`) to dynamically serving `index.html`.



\---



\## \[1.0.0] - 2026-08-01



\### Added

\- \*\*Multi-Cluster Local Scout Agents\*\*:

&#x20; - `scout\_cluster\_1.py`: Asset class \& liquidity telemetry node.

&#x20; - `scout\_cluster\_2.py`: Market sentiment \& volume node.

&#x20; - `scout\_cluster\_3.py`: Cross-chain flow \& wallet tracker node.

\- \*\*Express / Node.js Gateway (`server.js`)\*\*: Render-hosted ingestion point for incoming cluster streams.

\- \*\*x402 Micro-Payment Gatekeeper\*\*: Added HTTP 402 challenge response headers targeting USDC on Base (`0x8335...2913`) and VIP bearer token bypass (`[redacted — retired]`).

\- \*\*Automation Pipeline (`start\_pack.ps1`)\*\*: Background process script for starting, monitoring, and killing local scout processes.



\### Fixed

\- Resolved JSON decoding errors and "file not found" execution bugs by consolidating cluster execution scripts.

