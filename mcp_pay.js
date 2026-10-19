// Pay-inside-MCP: in-band x402 v2 payments for MCP tool calls via the official @x402/mcp package.
// Same prices, same payout wallet, same CDP facilitator as the HTTP endpoints. No secrets are logged.
// Client flow: call tool -> isError result with PaymentRequired (structuredContent) -> client signs
// EIP-3009 -> retries with _meta["x402/payment"] -> we verify, run the tool, settle, and return the
// result with _meta["x402/payment-response"]. If the tool errors, settlement is skipped (no charge).
import { createPaymentWrapper, x402ResourceServer } from '@x402/mcp';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const NETWORK = 'eip155:8453';
let state = { mode: 'pointer', reason: 'not initialized' };
const wrappers = new Map();

let onPaidHook = null;
export async function initMcpPayments({ facilitatorUrl, payTo, asset, makeJwt, onPaid }) {
    onPaidHook = typeof onPaid === 'function' ? onPaid : null;
    if (process.env.MCP_PAYMENTS === 'off') { state = { mode: 'pointer', reason: 'MCP_PAYMENTS=off' }; return state; }
    if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) { state = { mode: 'pointer', reason: 'facilitator keys not set' }; return state; }
    try {
        const facilitator = new HTTPFacilitatorClient({
            url: facilitatorUrl,
            createAuthHeaders: async () => {
                const h = p => ({ Authorization: `Bearer ${makeJwt(p === 'supported' ? 'GET' : 'POST', `/platform/v2/x402/${p}`)}` });
                return { verify: h('verify'), settle: h('settle'), supported: h('supported') };
            }
        });
        const rs = new x402ResourceServer(facilitator);
        rs.register(NETWORK, new ExactEvmScheme());
        await rs.initialize();
        state = { mode: 'inband', rs, payTo, asset };
    } catch (e) {
        state = { mode: 'pointer', reason: 'facilitator init failed: ' + (e && e.message ? e.message.slice(0, 120) : 'unknown') };
    }
    return state;
}

export function mcpPayMode() { return { mode: state.mode, ...(state.reason ? { reason: state.reason } : {}) }; }

// Returns a handler wrapper for a tool at a fixed atomic USDC amount, or null when in-band is unavailable.
export async function paidWrapper(toolName, amountAtomic, description) {
    if (state.mode !== 'inband') return null;
    const key = toolName + ':' + amountAtomic;
    if (wrappers.has(key)) return wrappers.get(key);
    const accepts = await state.rs.buildPaymentRequirements({
        scheme: 'exact', network: NETWORK, payTo: state.payTo, maxTimeoutSeconds: 300,
        price: { amount: String(amountAtomic), asset: state.asset, extra: { name: 'USD Coin', version: '2' } }
    });
    const w = createPaymentWrapper(state.rs, {
        accepts,
        resource: { url: `mcp://tool/${toolName}`, description, mimeType: 'application/json' },
        hooks: { onAfterSettlement: async ({ settlement, paymentPayload }) => {
            console.log('[mcp-pay] settled', toolName, settlement && settlement.transaction);
            // Stats only (anonymized payer id); never blocks or fails the paid result.
            try { if (onPaidHook) onPaidHook(toolName, (settlement && settlement.payer) || (paymentPayload && paymentPayload.payload && paymentPayload.payload.authorization && paymentPayload.payload.authorization.from)); } catch { /* ignore */ }
        } }
    });
    wrappers.set(key, w);
    return w;
}
