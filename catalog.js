// catalog.js — discovery categories + what is featured. The category is prefixed onto OpenAPI summaries, 402
// resource descriptions, and MCP tool descriptions. CDP Bazaar search matches that leading text, so each paid route
// gets its own phrase (the words agents type) instead of one shared "Market data: crypto" label. Government contracts
// are not a crypto feed. /api/rails keeps the payment-rails label that already ranks for that query.
// Unfeatured routes keep working and stay in /openapi.json + /.well-known/x402.
export const CATEGORIES = [
    [/^\/api\/pay\/should-i-pay/, 'Payment decision: spend policy + seller reputation risk check, one verdict'],
    [/^\/api\/spend\/check/, 'Spend policy: agent payment risk check'],
    [/^\/api\/seller\/reputation/, 'Seller reputation: x402 seller risk check, verdict'],
    [/^\/api\/(verdict-deep|honeypot-deep)\//, 'Deep honeypot: token safety, rug check, token security'],
    [/^\/api\/token-brief\//, 'Token brief: token safety plus price, trade check'],
    [/^\/api\/signals\//, 'Crypto bottom watch: research data, not financial advice'],
    [/^\/api\/(verdict|honeypot)\//, 'Token safety verdict: rug check, token security, honeypot'],
    [/^\/api\/rails\/route/, 'Which rail: x402 facilitator pick'],
    [/^\/api\/truck\//, 'Truck fuel: EIA diesel surcharge'],
    [/^\/api\/rails/, 'Payment rails: fee + speed comparison'],
    [/^\/api\/pass\//, 'Day pass: 24h paid API access'],
    [/^\/api\/alerts/, 'WaveTrend green-dot alerts'],
    [/^\/api\/brief\/weekly/, 'Weekly crypto brief'],
    [/^\/api\/daily\/?$/, 'Daily bundle: brief plus crypto market regime'],
    [/^\/api\/brief/, 'Daily crypto brief'],
    [/^\/api\/regime/, 'Crypto market regime'],
    [/^\/api\/dots/, 'WaveTrend band dots'],
    [/^\/api\/coin\//, 'WaveTrend coin snapshot'],
    [/^\/api\/agent/, 'Crypto market regime and WaveTrend'],
    [/^\/api\/history/, 'WaveTrend hit-rate backtest'],
    [/^\/api\/flows\//, 'Kraken large-print flows'],
    [/^\/api\/rwa/, 'Tokenized RWA data'],
    [/^\/api\/govcontracts/, 'Government contracts data'],
    [/^\/api\/kraken\//, 'Kraken new USD listings'],
    [/^\/api\/rules/, 'Crypto regulation feed'],
    [/^\/api\/rs/, 'Crypto relative strength'],
    [/^\/api\/value\/[^/]+\/history/, 'Value-capture history'],
    [/^\/api\/value\/[^/]+/, 'Value-capture score'],
    [/^\/api\/value\/?$/, 'Value-capture screen'],
    [/^\/api\/growth\/history/, 'Growth-lane history'],
    [/^\/api\/growth\/?$/, 'Growth-lane screen'],
    [/^\/api\/growth\//, 'Growth-lane setup'],
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
