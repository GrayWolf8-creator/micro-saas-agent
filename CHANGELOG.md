\# GW8 Micro-SaaS Agent — System Changelog \& Master Log



All notable changes, architectural updates, and deployment milestones for the Scout Telemetry Infrastructure \& x402 Gateway will be documented here.



\---



\## \[Unreleased]

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

\- \*\*x402 Micro-Payment Gatekeeper\*\*: Added HTTP 402 challenge response headers targeting USDC on Base (`0x8335...2913`) and VIP bearer token bypass (`SUB-GW8-CAPITAL-ALPHA-VIP`).

\- \*\*Automation Pipeline (`start\_pack.ps1`)\*\*: Background process script for starting, monitoring, and killing local scout processes.



\### Fixed

\- Resolved JSON decoding errors and "file not found" execution bugs by consolidating cluster execution scripts.

