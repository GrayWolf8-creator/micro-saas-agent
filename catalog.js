// catalog.js — discovery categories + what is featured. Category keywords are prefixed onto openapi summaries, 402
// descriptions and MCP tool descriptions so agents and directories can match intent (risk check, spend policy, seller
// reputation, verdict, market data). Unfeatured routes keep working and stay in /openapi.json + /.well-known/x402.
export const CATEGORIES = [
    [/^\/api\/pay\/should-i-pay/, 'Payment decision: spend policy + seller reputation risk check, one verdict'],
    [/^\/api\/spend\/check/, 'Spend policy: agent payment risk check'],
    [/^\/api\/seller\/reputation/, 'Seller reputation: x402 seller risk check, verdict'],
    [/^\/api\/verdict\//, 'Token risk check: safety verdict'],
    [/^\/api\/rails/, 'Payment rails: fee + speed comparison'],
    [/^\/api\/(pass|alerts|brief\/weekly)/, 'Access'],
    [/^\/api\//, 'Market data: crypto'],
];
export function categoryOf(path) { const p = String(path || ''); for (const [re, c] of CATEGORIES) if (re.test(p)) return c; return null; }
export const withCategory = (path, text) => { const c = categoryOf(path); return c && !String(text).startsWith('[') ? `[${c}] ${text}` : text; };
// CDP facilitator /verify rejects a paymentPayload whose resource.description is over 500 chars (schema maxLength 500),
// with the misleading error "must match one of [x402V2PaymentPayload, x402V1PaymentPayload] ... requires 'scheme'".
// Clients echo the 402 challenge's resource into paymentPayload, so every challenge (HTTP and MCP) must stay <= 500.
export const MAX_RESOURCE_DESCRIPTION = 500;
export function capDescription(text, max = MAX_RESOURCE_DESCRIPTION) {
    const t = String(text == null ? '' : text);
    if (t.length <= max) return t;
    const cut = t.slice(0, max - 3), sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.(\[-]+$/, '') + '...';
}
// Still live (routes, openapi, /.well-known/x402, MCP tools) but no longer featured in /, llms.txt menus, agents.md or pay.html.
export const UNFEATURED = ['/api/rules', '/api/rwa', '/api/govcontracts'];
export const isFeatured = path => !UNFEATURED.some(u => path === u || path.startsWith(u + '/'));
