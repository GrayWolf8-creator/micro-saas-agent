
import express from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ALERT_PLAN, validateSubscribe, createSubscription, getStatus, onRefresh, persistenceMode, cancelSubscription } from './alerts.js';
import { onWaveTrendRefresh, getWaveTrend } from './Signal.js';
import { safeSignal, buildSample, getCoin, getDots, getHistory, getRegime, COINS } from './Signal.js';
import { initMcpPayments, paidWrapper, mcpPayMode } from './mcp_pay.js';
import { getVerdict, validVerdictInput, VERDICT_CHAINS, VERDICT_BLURB, VERDICT_TAGS, VERDICT_EXAMPLE, VERDICT_OUTPUT_SCHEMA, VERDICT_PATH_SCHEMA, VERDICT_SERVICE_NAME, verdictExampleBody, getFlows, getBrief, getBriefTeaser, getDailyBundle, signResponses, publicKeyInfo, BRIEF_QUOTE, startBriefPrewarm, briefReadyStatus, TEASER_COLD_WAIT_MS } from './upgrades.js';
import { getDeepVerdict, getTokenBrief, getCryptoBottoms, DEEP_BLURB, BRIEF_BLURB, BOTTOM_BLURB, DEEP_TAGS, BRIEF_TAGS, BOTTOM_TAGS, DEEP_SERVICE_NAME, BRIEF_SERVICE_NAME, BOTTOM_SERVICE_NAME, DEEP_EXAMPLE, BRIEF_EXAMPLE, BOTTOM_EXAMPLE, DEEP_OUTPUT_SCHEMA, BRIEF_OUTPUT_SCHEMA, BOTTOM_OUTPUT_SCHEMA, DEEP_PATH_SCHEMA, BRIEF_PATH_SCHEMA, BOTTOM_DISCLAIMER } from './products.js';
import { getRwa } from './rwa.js';
import { mintPass, usePass, refundPass, revokePass, PASS_PLAN, tail } from './pass.js';
import { getTrack, renderTrack, logDots } from './track.js';
import { getKrakenListings, getKrakenStatus, snapshot as krakenSnapshot } from './kraken.js';
import { getRules, getRulesStatus } from './rules.js';
import { getRs } from './rs.js';
import { getRails, validAmount, RAILS_OUTPUT_SCHEMA } from './rails.js';
import { getFacilitatorRoute, validRouteQuery, ROUTE_BLURB, ROUTE_TAGS, ROUTE_SERVICE_NAME, ROUTE_EXAMPLE, ROUTE_OUTPUT_SCHEMA } from './facilitators.js';
import { getFuelSurcharge, validFuelQuery, FUEL_BLURB, FUEL_TAGS, FUEL_SERVICE_NAME, FUEL_EXAMPLE, FUEL_OUTPUT_SCHEMA } from './diesel.js';
import { VERDICT_PRICE_USD, DEEP_PRICE_USD, RAILS_ROUTE_PRICE_USD, FUEL_SURCHARGE_PRICE_USD, DAILY_BUNDLE_PRICE_USD, usdAtomic } from './prices.js';
import { polygonPaymentsEnabled, pathAcceptsPolygon, selectPaymentRequirements, paymentNetwork, USDC_POLYGON, POLYGON_FACILITATOR_URL } from './polygon_pay.js';
import { solanaPaymentsEnabled, pathAcceptsSolana, refreshSolanaFeePayer, cachedSolanaFeePayer, solanaAccept, payeeUsdcAccountExists, SOLANA_PAYTO, SOLANA_NETWORK, SOLANA_FACILITATOR_URL, USDC_SOLANA } from './solana_pay.js';
import { getGovContracts, validGovFilters, GOV_SECTORS, getGovStatus } from './gov.js';
import { WEEKLY_PLANS, validateWeekly, createWeekly, cancelWeekly, getWeeklyStatus, weeklyTick } from './weekly.js';
import { statsMiddleware, getStats, renderStatsHtml, renderStatsMd, recordMcpPaid, normalizeRoute, mountTrafficReport, installStatsFlush } from './stats.js';
import { salesMiddleware, mountSalesReport, installSalesFlush, recordMcpSale } from './sales.js';
import { funnel, dayPassNote, receiptHeaders, receiptKeyInfo, replayKey, once, TRUST_LINE, RECEIPT_KEY_PATH, buildReceipt, verifyReceipt, VERIFY_PATH } from './trust.js';
import { getValueSymbol, getValueBatch, getValueHistory, getValueStatus, parseValueQuery, parseWeeks, findCoin, VALUE_PRICES } from './value.js';
import { getGrowthOne, getGrowthList, getGrowthHistory, getGrowthStatus, parseGrowthQuery, findGrowth, GROWTH_PRICES } from './growth.js';
import { isSampleQuery, topQuotedPaid, precheckSample, buildRouteSample, takeSample, requestIp } from './sample.js';
import { payerFrom } from './buyers.js';
import { checkSpend, validateSpend, SPEND_PLAN } from './spend.js';
import { checkSellerReputation, validateReputation, REPUTATION_PLAN, getSourceStatus } from './reputation.js';
import { checkShouldIPay, validatePayDecision, PAYDECISION_PLAN } from './paydecision.js';
import { withCategory, capDescription, categoryOf, isFeatured } from './catalog.js';
import { schemaFromExample, cloneSchema, ensureDescribed, applyFieldDocs, outputDocsFor } from './bazaar.js';
import { mountMarketplace } from './marketplace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Version B packaging: signing is on (Ed25519). Exact lede for OpenAPI, MCP, and docs.
// The x402 resource.description cap is 500 characters, so the 402 challenge uses the same copy trimmed to fit.
const SHOULD_I_PAY_COPY = '[Payment decision: may this agent pay, plus a signed audit record] May this agent pay this seller, under the buyer\'s rules? One call runs the spend-policy check and the x402 seller reputation check and returns one verdict (pay / dont_pay / ask_human), the reasons, both sub-results, and a signed audit record (Ed25519 decisionReceipt plus X-GW8-Receipt / X-GW8-Receipt-Signature). Verify free at POST /api/receipt/verify; public key at GET /.well-known/gw8-receipt-key (`enabled` should be true). Deterministic; stateless; never pays anyone. Free when the seller data source is down. $0.02.';
const SPEND_CHECK_COPY = '[Spend policy: agent payment rules check, plus a signed audit record] Check one proposed payment against the buyer\'s rules (per-tx limit, rolling cap with spent-so-far, categories, allow/deny lists, hours+timezone, assets/chains, human-approval threshold). Returns allow / deny / needs_approval, which rules fired, and a signed audit record (decisionReceipt). Verify free at POST /api/receipt/verify; public key at GET /.well-known/gw8-receipt-key (`enabled` should be true). Stateless, deterministic; not custody; does not move money. $0.02.';
const SELLER_REPUTATION_COPY = '[Seller reputation: x402 seller risk check, plus a signed audit record] Before paying an x402 seller, POST its Base wallet and/or its endpoint URL. Returns a 0-100 score, verdict trusted / caution / avoid / unknown, components, reasons, and a signed audit record (reputationReceipt). Verify free at POST /api/receipt/verify; public key at GET /.well-known/gw8-receipt-key (`enabled` should be true). Heuristic, not a guarantee. $0.01. Free first: GET /api/seller/reputation/status.';
const RECEIPT_VERIFY_COPY = 'Free: verify a paid-call receipt. It verifies the Ed25519 signature. Public key at GET /.well-known/gw8-receipt-key. Body {payload, signature, data?} or {receipt, data?}.';
const SHOULD_I_PAY_CHALLENGE = '[Payment decision: may this agent pay, plus a signed audit record] May this agent pay this seller, under the buyer\'s rules? One call runs the spend-policy check and the x402 seller reputation check and returns one verdict (pay / dont_pay / ask_human), reasons, sub-results, and a signed audit record (Ed25519 decisionReceipt plus X-GW8-Receipt / X-GW8-Receipt-Signature). Verify free at POST /api/receipt/verify; public key at GET /.well-known/gw8-receipt-key. Free when seller data is down. $0.02.';
const SPEND_CHECK_CHALLENGE = '[Spend policy: agent payment rules check, plus a signed audit record] Check one proposed payment against the buyer\'s rules (per-tx limit, rolling cap with spent-so-far, categories, allow/deny lists, hours+timezone, assets/chains, human-approval threshold). Returns allow / deny / needs_approval, which rules fired, and a signed audit record (decisionReceipt). Verify free at POST /api/receipt/verify; public key at GET /.well-known/gw8-receipt-key. Stateless, deterministic; moves no money. $0.02.';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Per-endpoint request tallies (402 quotes vs paid 2xx etc). Free, no PII. Before x402 handlers.
app.use(statsMiddleware);
// Which routes sold (x402 vs RapidAPI). Counts only. Register the shutdown flush before stats so it runs first.
app.use(salesMiddleware);
installSalesFlush();
installStatsFlush();
let sampleRouteCache = { t: 0, routes: null };
async function currentSampleRoutes() {
    if (sampleRouteCache.routes && Date.now() - sampleRouteCache.t < 60000) return sampleRouteCache.routes;
    try {
        const s = await getStats(1);
        sampleRouteCache = { t: Date.now(), routes: topQuotedPaid(s.routes) };
    } catch { sampleRouteCache = { t: Date.now(), routes: topQuotedPaid([]) }; }
    return sampleRouteCache.routes;
}
// Free ?sample=1 on the most-quoted paid routes (verdict, coin, rails when no quote counters exist).
app.use(async (req, res, next) => {
    try {
        if (req.method !== 'GET' || !isSampleQuery(req.query)) return next();
        const route = normalizeRoute('GET', req.path || req.url);
        if (!route) return next();
        const top = await currentSampleRoutes();
        if (!top.some(t => t.route === route)) return next();
        const bad = precheckSample(route, req);
        if (bad && bad.error) return res.status(bad.http || 400).json({ error: bad.error, sample: true, note: 'sample not counted' });
        const slot = takeSample(requestIp(req));
        if (!slot.ok) return res.status(429).set('Retry-After', '86400').json({ error: 'free sample cap reached for this address today', sample: true, cap: slot.cap, disclaimer: 'Free truncated sample of public data. Not investment advice; no trade recommendation.', sources: [] });
        const body = await buildRouteSample(route, req);
        if (body && body.error) return res.status(body.http || 503).json({ error: body.error, sample: true, ...(body.sourceStatus ? { sourceStatus: body.sourceStatus } : {}), ...(body.disclaimer ? { disclaimer: body.disclaimer } : {}), ...(body.sources ? { sources: body.sources } : {}) });
        res.locals.gw8Sample = true;
        return res.json(body);
    } catch { return next(); }
});
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const VAULT_ADDRESS = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
// Public Solana payout. Same kind of config as VAULT_ADDRESS, not a secret. The owner created this key.
const SOLANA_VAULT_ADDRESS = SOLANA_PAYTO;
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Product version on HTTP and MCP discovery. The npm package version in package.json is separate.
const API_VERSION = '1.2.1';
const PUBLIC_ORIGIN = 'https://micro-saas-agent.onrender.com';
// Same five paid HTTP routes as polygon_pay.js / solana_pay.js. MCP stays Base-only.
const MULTI_RAIL_HTTP_ROUTES = ['GET /api/rails', 'GET /api/rails/route', 'GET /api/regime', 'POST /api/pay/should-i-pay', 'GET /api/coin/{symbol}'];
const MULTI_RAIL_HTTP_PATHS = new Set(MULTI_RAIL_HTTP_ROUTES.map(r => r.slice(r.indexOf(' ') + 1)));
const MULTI_RAIL_HTTP = MULTI_RAIL_HTTP_ROUTES.slice(0, -1).join(', ') + ', and ' + MULTI_RAIL_HTTP_ROUTES[MULTI_RAIL_HTTP_ROUTES.length - 1];
const MULTI_RAIL_COPY = `Multi-rail on HTTP only: ${MULTI_RAIL_HTTP} accept Base USDC (eip155:8453, payTo ${VAULT_ADDRESS}), Polygon USDC (eip155:137, asset ${USDC_POLYGON}, same payTo), and Solana USDC (${SOLANA_NETWORK}, mint ${USDC_SOLANA}, payTo ${SOLANA_VAULT_ADDRESS}) at that route's existing price. POLYGON_PAYMENTS=off or SOLANA_PAYMENTS=off removes that network. Every other paid HTTP route stays Base USDC only. MCP tools stay USDC on Base and do not accept Polygon or Solana.`;
const SITEMAP_PATHS = ['/', '/llms.txt', '/agents.md', '/openapi.json', '/.well-known/x402', '/.well-known/agent.json', '/pay', '/pay.html', '/track', '/health'];
const RESOURCE_URL = 'https://micro-saas-agent.onrender.com/api/agent';
const CDP_FACILITATOR_URL = process.env.CDP_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402';
// Generate CDP Facilitator JWT Token
function generateCdpJwt(method, uriPath) {
    const keyName = process.env.CDP_API_KEY_ID;
    let privateKey = process.env.CDP_API_KEY_SECRET;
    if (!keyName || !privateKey) return null;

    if (privateKey.includes('\\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
    }

    const uri = `${method} api.cdp.coinbase.com${uriPath}`;
    const payload = {
        iss: 'cdp',
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        sub: keyName,
        uri
    };

    const header = {
        alg: 'ES256',
        kid: keyName,
        nonce: crypto.randomBytes(16).toString('hex')
    };

    return jwt.sign(payload, privateKey, { algorithm: 'ES256', header });
}

// Official x402 Version 2 + Bazaar Discovery Spec
// Bazaar catalogs a resource only after CDP Facilitator *settles* a payment that echoes extensions.bazaar.
function getX402ChallengeV2(o = {}) {
    const method = String(o.method || (o.url ? 'GET' : 'POST')).toUpperCase();
    const isBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    // CDP validate rejects an empty queryParams object. A GET with no query string still accepts
    // ?sample= (the free-sample switch). example "0" is the paid call, so the object is never {}.
    let inProps = {};
    for (const [k, v] of Object.entries(o.inputProps || {})) inProps[k] = (v && typeof v === 'object') ? cloneSchema(v) : v;
    if (!isBody && Object.keys(inProps).length === 0) {
        inProps = { sample: { type: 'string', enum: ['0', '1'], description: '1 asks for the free truncated sample when this route is in today\'s sample set. 0 is the paid call.', example: '0' } };
    }
    ensureDescribed({ properties: inProps }, 'input');
    const exampleFromProps = (props) => Object.fromEntries(Object.entries(props).flatMap(([k, v]) => {
        if (v && Object.prototype.hasOwnProperty.call(v, 'example')) return [[k, v.example]];
        if (v && Array.isArray(v.enum) && v.enum.length) return [[k, v.enum[0]]];
        return [];
    }));
    const queryExample = exampleFromProps(inProps);
    const bodyExample = (o.body !== undefined) ? o.body : exampleFromProps(inProps);

    // Capped at 500: CDP /verify rejects longer resource.description (see catalog.js capDescription).
    const description = capDescription(withCategory(o.url ? new URL(o.url).pathname : '/api/agent', o.description || (
        'Crypto market regime (Stage 1 score 0-4: ETF flows, BTC support, alt breadth, Fear & Greed) plus WaveTrend oversold/overbought band dots on 66 Kraken 4h USD pairs. ' +
        'Use when an agent needs a compact risk-on/risk-off + oversold scan. $0.02 USDC on Base. Free sample: GET /api/sample. Signal only, not financial advice.'
    )));
    const url = o.url || RESOURCE_URL;
    const amount = o.amount || '20000';
    const tags = (o.tags || ['crypto market regime', 'wavetrend', 'risk-on', 'band dots', 'kraken']).slice(0, 5);
    const example = o.example || {
        status: 'success',
        signal: {
            stage1: { score: 3, outOf: 4, checks: { etfInflows: { status: 'pass' }, btcQuietSupport: { status: 'pass' }, altsNotFreefall: { status: 'pass' }, noGreedChase: { status: 'fail' } } },
            wavetrend: { settings: 'LazyBear 10/21/4, Kraken 4h', core: [{ name: 'BTC', wt1: -12.4, wt2: -10.1 }], bandDots: [{ name: 'LINK', kind: 'green', band: 'inner', wt1: -54.8, bar: '2026-10-17T16:00:00.000Z', close: 11.2 }], universe: 66 },
            disclaimer: 'signal only, not financial advice'
        }
    };

    const input = { type: 'http', method };
    if (isBody) {
        input.bodyType = 'json';
        input.body = bodyExample && typeof bodyExample === 'object' ? bodyExample : {};
    } else {
        input.queryParams = queryExample;
    }
    if (o.pathParams) input.pathParams = o.pathParams;

    const inputSchemaProps = {
        type: { type: 'string', const: 'http' },
        method: { type: 'string', enum: [method] }
    };
    const inputRequired = ['type', 'method'];
    if (isBody) {
        inputSchemaProps.bodyType = { type: 'string', enum: ['json'] };
        inputSchemaProps.body = { type: 'object', properties: inProps, additionalProperties: false };
        if (o.bodyRequired && o.bodyRequired.length) inputSchemaProps.body.required = o.bodyRequired;
        inputRequired.push('bodyType', 'body');
    } else {
        inputSchemaProps.queryParams = { type: 'object', properties: inProps, additionalProperties: false };
        inputRequired.push('queryParams');
    }
    if (o.pathParams && typeof o.pathParams === 'object') {
        const props = {}, req = [];
        const custom = o.pathParamSchema || {};
        for (const [k, v] of Object.entries(o.pathParams)) {
            if (custom[k]) props[k] = cloneSchema(custom[k]);
            else if (v && typeof v === 'object' && !Array.isArray(v) && (v.type || v.enum || v.properties)) props[k] = cloneSchema(v);
            else props[k] = { type: 'string', description: `${k} path parameter for this paid call.`, ...(v != null ? { example: String(v) } : {}) };
            req.push(k);
        }
        inputSchemaProps.pathParams = { type: 'object', description: 'Path parameters for this paid call.', properties: props, required: req, additionalProperties: false };
        ensureDescribed(inputSchemaProps.pathParams, 'input');
        inputRequired.push('pathParams');
    }
    if (inputSchemaProps.queryParams) inputSchemaProps.queryParams.description = inputSchemaProps.queryParams.description || 'Query parameters for this paid call.';
    if (inputSchemaProps.body) inputSchemaProps.body.description = inputSchemaProps.body.description || (Object.keys(inProps).length ? 'JSON body for this paid call.' : 'JSON body for this paid call. An empty object is valid.');

    let resourcePath = '/api/agent';
    try { resourcePath = new URL(url).pathname; } catch { /* default agent path */ }
    const outputExampleSchema = (o.outputSchema && typeof o.outputSchema === 'object')
        ? cloneSchema(o.outputSchema)
        : schemaFromExample(example);
    applyFieldDocs(outputExampleSchema, o.outputDocs || outputDocsFor(o.routeTemplate || resourcePath));
    if (!outputExampleSchema.description) outputExampleSchema.description = description;
    ensureDescribed(outputExampleSchema, 'output');

    const bazaar = {
        info: {
            input,
            output: { type: 'json', example }
        },
        schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
                input: { type: 'object', properties: inputSchemaProps, required: inputRequired, additionalProperties: false },
                output: {
                    type: 'object',
                    description: description,
                    properties: {
                        type: { type: 'string', const: 'json' },
                        example: outputExampleSchema
                    },
                    required: ['type', 'example']
                }
            },
            required: ['input', 'output']
        }
    };
    if (o.routeTemplate) bazaar.routeTemplate = o.routeTemplate;

    return {
        x402Version: 2,
        error: 'PAYMENT_REQUIRED',
        resource: {
            url,
            description,
            mimeType: 'application/json',
            serviceName: (o.serviceName || (resourcePath === '/api/agent' ? 'GW8 Regime + WaveTrend' : 'GW8 Signal API')).slice(0, 32),
            tags
        },
        accepts: x402Accepts(url, amount),
        extensions: { bazaar }
    };
}

// Base accept is always first and is the same object as before. Polygon is a second entry
// on the routes in polygon_pay.js, at the same atomic amount, and only while POLYGON_PAYMENTS is on.
function x402Accepts(url, amount) {
    const base = {
        scheme: 'exact',
        network: 'eip155:8453',
        amount,
        asset: USDC_BASE_ADDRESS,
        payTo: VAULT_ADDRESS,
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' }
    };
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch { /* no polygon entry without a resource path */ }
    const accepts = [base];
    if (polygonPaymentsEnabled() && pathAcceptsPolygon(pathname)) accepts.push({
        scheme: 'exact',
        network: 'eip155:137',
        amount,
        asset: USDC_POLYGON,
        payTo: VAULT_ADDRESS,
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' }
    });
    const feePayer = cachedSolanaFeePayer();
    if (feePayer && solanaPaymentsEnabled() && pathAcceptsSolana(pathname)) accepts.push(solanaAccept(amount, SOLANA_VAULT_ADDRESS, feePayer));
    return accepts;
}

// Solana's extra.feePayer is read from the public facilitator's /supported and is not hardcoded.
async function prepareSolanaQuote(product) {
    if (!solanaPaymentsEnabled()) return;
    let pathname = '';
    try { pathname = new URL((product && product.url) || RESOURCE_URL).pathname; } catch { return; }
    if (!pathAcceptsSolana(pathname)) return;
    await refreshSolanaFeePayer();
}

function chooseFacilitator(accepts, payload) {
    const choice = selectPaymentRequirements(accepts, payload);
    if (choice.facilitator !== 'cdp') return choice;
    const net = paymentNetwork(payload);
    if (net === SOLANA_NETWORK || net.toLowerCase() === 'solana') {
        const sol = (accepts || []).find(a => a && a.network === SOLANA_NETWORK);
        if (sol) return { requirements: sol, facilitator: 'solana' };
    }
    return choice;
}

// 1. Root Landing Page
app.get('/', (req, res) => {
    res.json({
        service: "GW8 Signal API",
        status: "ONLINE",
        protocol: "x402 v2",
        network: "eip155:8453",
        asset: "USDC",
        about: "Pay-per-call tools for AI agents. Lead product: the daily crypto brief (GET /api/brief, $0.02, refreshed on each closed 4h bar) — regime, top coins, and BTC/ETH/SOL flows. Free teaser shows today's regime and the top 3 coin names. Daily bundle GET /api/daily ($0.025) is that brief plus the full regime. Also should-I-pay decisions, token safety verdicts (rug check, honeypot, contract risk), payment-rail costs, and other crypto market data. Receipt (Ed25519-signed when signing is enabled; see /.well-known/gw8-receipt-key `enabled`). Signal only, not financial advice. " + MULTI_RAIL_COPY,
        version: API_VERSION,
        multiRail: { httpOnly: true, routes: MULTI_RAIL_HTTP_ROUTES, note: MULTI_RAIL_COPY },
        humans: { pay: "/pay.html", payAlias: "/pay", track: "/track" },
        convenience: { health: "/health", pay: "/pay", robots: "/robots.txt", sitemap: "/sitemap.xml" },
        lead: { method: "GET", path: "/api/brief", priceUsd: "0.02", example: "GET /api/brief", freeTeaser: "/api/brief/teaser", note: "Daily crypto brief, refreshed on each closed 4h bar: regime, WaveTrend dot counts, top coins, BTC/ETH/SOL flows." },
        bundle: { method: "GET", path: "/api/daily", priceUsd: DAILY_BUNDLE_PRICE_USD, example: "GET /api/daily", note: "The brief plus the full regime in one call. Buying them separately is $0.03." },
        startHere: { agentGuide: "/agents.md", freeTeaser: "/api/brief/teaser", freeSample: "/api/sample", agentDocs: "/llms.txt", openapi: "/openapi.json", discovery: "/.well-known/x402", agentCard: "/.well-known/agent.json", payPage: "/pay.html" },
        tiers: {
            starter: {
                free: ["/api/brief/teaser", "/api/sample"],
                paid: [
                    { path: "/api/coin/{symbol}", priceUsd: "0.002" },
                    { path: "/api/regime", priceUsd: "0.01" },
                    { path: "/api/dots", priceUsd: "0.01" }
                ]
            },
            research: {
                paid: [
                    { path: "/api/brief", priceUsd: "0.02", note: "lead product: regime, top coins, BTC/ETH/SOL flows, refreshed on each closed 4h bar" },
                    { path: "/api/daily", priceUsd: DAILY_BUNDLE_PRICE_USD, note: "daily bundle: the brief plus the full regime. Separate price is $0.03" },
                    { path: "/api/verdict/{chain}/{address}", priceUsd: VERDICT_PRICE_USD, note: "token safety, honeypot, rug check, contract risk. Free example: /api/verdict/example" },
                    { path: "/api/verdict-deep/{chain}/{address}", priceUsd: DEEP_PRICE_USD, note: "deep honeypot check: holder concentration, liquidity lock, scam token" },
                    { path: "/api/token-brief/{chain}/{address}", priceUsd: "0.02", note: "token safety plus price, token brief, trade check" },
                    { path: "/api/signals/crypto-bottom", priceUsd: "0.01", note: "crypto bottom-watch research data, not financial advice" },
                    { path: "/api/agent", method: "POST", priceUsd: "0.02" },
                    { path: "/api/history", priceUsd: "0.05" },
                    { path: "/api/flows/{symbol}", priceUsd: "0.02" },
                    { path: "/api/kraken/listings", priceUsd: "0.02" },
                    { path: "/api/rs", priceUsd: "0.02" },
                    { path: "/api/rails", priceUsd: "0.002" },
                    { path: "/api/rails/route", priceUsd: RAILS_ROUTE_PRICE_USD, note: "which x402 facilitator and which rail for a payment of this size" },
                    { path: "/api/truck/fuel-surcharge", priceUsd: FUEL_SURCHARGE_PRICE_USD, note: "EIA weekly diesel per-mile surcharge. Source: U.S. EIA" }
                ]
            },
            agentPayments: {
                paid: [
                    { path: "/api/pay/should-i-pay", method: "POST", priceUsd: PAYDECISION_PLAN.priceUsd, note: SHOULD_I_PAY_COPY },
                    { path: "/api/spend/check", method: "POST", priceUsd: SPEND_PLAN.priceUsd, note: SPEND_CHECK_COPY },
                    { path: "/api/seller/reputation", method: "POST", priceUsd: REPUTATION_PLAN.priceUsd, note: SELLER_REPUTATION_COPY }
                ]
            },
            tokenomics: {
                free: ["/api/value/status", "/api/growth/status"],
                paid: [
                    { path: "/api/value/{symbol}", priceUsd: VALUE_PRICES.one },
                    { path: "/api/value", priceUsd: VALUE_PRICES.batch },
                    { path: "/api/value/{symbol}/history", priceUsd: VALUE_PRICES.history },
                    { path: "/api/growth/{chain}", priceUsd: GROWTH_PRICES.one },
                    { path: "/api/growth", priceUsd: GROWTH_PRICES.list },
                    { path: "/api/growth/history", priceUsd: GROWTH_PRICES.history }
                ]
            },
            access: {
                paid: [
                    { path: "/api/pass/day", method: "POST", priceUsd: "1.00" },
                    { path: "/api/brief/weekly/subscribe", method: "POST", priceUsd: "0.25" },
                    { path: "/api/alerts/subscribe", method: "POST", priceUsd: "0.50" }
                ]
            }
        },
        free: { teaser: "/api/brief/teaser", sample: "/api/sample", valueStatus: "/api/value/status", growthStatus: "/api/growth/status", trackRecord: "/track", trackJson: "/api/track", stats: "/api/stats", statsHtml: "/stats.html", traffic: "/api/traffic", trafficHtml: "/traffic.html", sales: "/api/sales", proofPubkey: "/api/proof/pubkey", receiptKey: RECEIPT_KEY_PATH, receiptVerify: VERIFY_PATH, sellerReputationStatus: "/api/seller/reputation/status" },
        bestValue: { path: "/api/pass/day", method: "POST", priceUsd: "1.00", note: "one payment, 24h of every paid data endpoint" },
        trust: TRUST_LINE + " Safe retry: same PAYMENT-SIGNATURE within 15 min is not charged twice.",
        docs: "/llms.txt",
        agentGuide: "/agents.md",
        allRoutes: "/openapi.json lists every live route, including ones not featured here",
        openapi: "/openapi.json",
        discovery: "/.well-known/x402",
        manifest: "/.well-known/x402",
        pay: "/pay.html"
    });
});

// 2. Manifest Endpoints
app.get('/llms.txt', (req, res) => serveDoc(res, 'llms.txt', 'text/plain; charset=utf-8'));
app.get('/agents.md', (req, res) => serveDoc(res, 'agents.md', 'text/markdown; charset=utf-8'));

// Alias of /.well-known/x402 (x402scan fan-out). Not the proposed origin-manifest format.
app.get(['/.well-known/x402.json', '/well-known/x402.json'], (req, res) => {
    res.json(discoveryFanout());
});

// x402scan / AgentCash discovery: OpenAPI-first, plus /.well-known/x402 fan-out

function discoveryFanout() {
    const passUrl = 'https://micro-saas-agent.onrender.com/api/pass/day';
    const urls = PAID.map(p => `https://micro-saas-agent.onrender.com${p.ex || p.path.replace('{symbol}', 'BTC').replace('{chain}', 'solana')}`);
    return {
        version: 1,
        resources: [passUrl, ...urls.filter(u => u !== passUrl)],
        lead: { method: 'GET', path: '/api/brief', priceUsd: '0.02', freeTeaser: '/api/brief/teaser', bundle: { method: 'GET', path: '/api/daily', priceUsd: DAILY_BUNDLE_PRICE_USD, note: 'brief plus full regime; separate price is $0.03' } },
        instructions: `Day pass first: POST /api/pass/day ($1.00, 24h). Best value if you call more than N times, where N = floor(1.00 / per-call price): $0.002 more than 500, $0.005 more than 200, $0.01 more than 100, $0.015 more than 66, $0.02 more than 50, $0.025 more than 40, $0.03 more than 33, $0.05 more than 20, $0.07 more than 14. Lead product, listed first in endpoints: the daily crypto brief at GET /api/brief ($0.02), refreshed on each closed 4h bar: regime, WaveTrend dot counts, top coins, and BTC/ETH/SOL flows. Free teaser GET /api/brief/teaser shows today's regime and the top 3 coin names. Daily bundle GET /api/daily ($${DAILY_BUNDLE_PRICE_USD}) returns that brief plus the full regime (separate price $0.03). Token safety, rug check, honeypot, and contract risk stay at GET /api/verdict/{chain}/{address} ($${VERDICT_PRICE_USD}) and return CLEAR, CAUTION, AVOID, or UNKNOWN. Free example of that JSON: GET /api/verdict/example. OpenAPI-first discovery at /openapi.json. Agent docs at /llms.txt and /agents.md. A2A agent card at /.well-known/agent.json. Free sample at /api/sample. Unpaid calls return 402 with PAYMENT-REQUIRED (x402 v2, USDC on Base) and extensions.bazaar (input schema, output schema, resource description). Polygon USDC (eip155:137, native USDC ${USDC_POLYGON}, same price and the same payTo) is a second accepts entry on GET /api/rails, GET /api/rails/route, GET /api/regime, POST /api/pay/should-i-pay, and GET /api/coin/{symbol}. POLYGON_PAYMENTS=off removes it. Solana USDC (${SOLANA_NETWORK}, mint ${USDC_SOLANA}, its own payTo) is a further accepts entry on those same routes. SOLANA_PAYMENTS=off removes it. ${TRUST_LINE} Receipt key: ${RECEIPT_KEY_PATH}. Signal only, not financial advice. CDP Bazaar indexes a route after the first successful facilitator settlement for that resource.`,
        tokenSafety: { method: 'GET', path: '/api/verdict/{chain}/{address}', priceUsd: VERDICT_PRICE_USD, verdicts: ['CLEAR', 'CAUTION', 'AVOID', 'UNKNOWN'], searches: ['honeypot', 'honeypot check', 'rug pull', 'token safety', 'token security', 'scam token', 'contract risk', 'rug check'], chains: Object.keys(VERDICT_CHAINS), example: 'GET /api/verdict/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?fresh=0', alias: { method: 'GET', path: '/api/honeypot/{chain}/{address}', priceUsd: VERDICT_PRICE_USD, example: 'GET /api/honeypot/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?fresh=0' } },
        deepToken: { method: 'GET', path: '/api/verdict-deep/{chain}/{address}', priceUsd: DEEP_PRICE_USD, verdicts: ['CLEAR', 'CAUTION', 'AVOID', 'UNKNOWN'], searches: ['deep honeypot check', 'rug pull', 'token safety', 'holder concentration', 'liquidity lock', 'scam token'], example: 'GET /api/verdict-deep/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?fresh=0', alias: { method: 'GET', path: '/api/honeypot-deep/{chain}/{address}', priceUsd: DEEP_PRICE_USD, example: 'GET /api/honeypot-deep/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?fresh=0' } },
        tokenBrief: { method: 'GET', path: '/api/token-brief/{chain}/{address}', priceUsd: '0.02', searches: ['token safety plus price', 'token brief', 'trade check'], example: 'GET /api/token-brief/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?fresh=0' },
        cryptoBottom: { method: 'GET', path: '/api/signals/crypto-bottom', priceUsd: '0.01', tiers: ['NONE', 'EARLY_TELL', 'CONFIRMED'], disclaimer: BOTTOM_DISCLAIMER, example: 'GET /api/signals/crypto-bottom?fresh=0' },
        endpoints: PAID.map(p => ({
            method: p.method.toUpperCase(),
            path: p.path,
            priceUsd: p.price,
            description: p.summary,
            example: p.exampleRequest,
            url: 'https://micro-saas-agent.onrender.com' + (p.ex || p.path)
        })),
        openapi: 'https://micro-saas-agent.onrender.com/openapi.json',
        llms: 'https://micro-saas-agent.onrender.com/llms.txt',
        agents: 'https://micro-saas-agent.onrender.com/agents.md',
        agentCard: 'https://micro-saas-agent.onrender.com/.well-known/agent.json'
    };
}

const RAW_PAID = [
    { path: '/api/agent', method: 'post', price: '0.02', summary: 'Crypto market regime (Stage 1 score 0-4) plus WaveTrend band dots on 66 Kraken 4h pairs. One-shot risk-on or risk-off scan. $0.02.', bodyEx: 'empty' },
    { path: '/api/history', method: 'get', price: '0.05', summary: 'Simulated 90-day WaveTrend band-dot hit-rate backtest (+4h/+24h/+3d). Optional ?pair=BTC. Past performance is not indicative of future results. $0.05.', query: { pair: { type: 'string', description: 'Optional coin symbol, e.g. BTC' } } },
    { path: '/api/regime', method: 'get', price: '0.01', summary: 'Crypto market regime score 0-4, risk-on or risk-off: ETF flows, BTC support, alt breadth, Fear and Greed. $0.01.' },
    { path: '/api/dots', method: 'get', price: '0.01', summary: 'WaveTrend oversold and overbought band dots across 66 Kraken 4h USD pairs. $0.01.' },
    { path: '/api/coin/{symbol}', method: 'get', price: '0.002', summary: 'WaveTrend 4h snapshot for one Kraken USD coin (cheapest call). $0.002.', pathParam: true, ex: '/api/coin/BTC', pathEx: { symbol: 'BTC' } },
    { path: '/api/verdict/{chain}/{address}', method: 'get', price: VERDICT_PRICE_USD, summary: VERDICT_BLURB, params: { chain: { type: 'string', enum: Object.keys(VERDICT_CHAINS), description: 'Chain for a honeypot check: token safety, token security, rug pull, scam token, or contract risk' }, address: { type: 'string', description: 'Token contract (0x and 40 hex) or Solana mint (base58) to honeypot-check for rug pull, scam token, and contract risk' } }, query: { fresh: { type: 'string', enum: ['0', '1'], description: '1 re-reads GoPlus and DexScreener for this honeypot check. 0 uses the 10-minute cache.' } }, ex: '/api/verdict/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', pathEx: { chain: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, responseDescription: 'Paid JSON. The screen is in signal: verdict CLEAR, CAUTION, AVOID, or UNKNOWN, with score, reasons, unknowns, sources, and freshness. Settled only after that screen is ready. A failed lookup is not settled.', responseSchema: { type: 'object', properties: { status: { type: 'string' }, signal: VERDICT_OUTPUT_SCHEMA }, required: ['signal'] } },
    { path: '/api/flows/{symbol}', method: 'get', price: '0.02', summary: 'Kraken large-print buy/sell flow summary joined with WaveTrend 4h state (single venue, not on-chain). $0.02.', pathParam: true, ex: '/api/flows/BTC', pathEx: { symbol: 'BTC' } },
    { path: '/api/brief', method: 'get', price: '0.02', summary: BRIEF_QUOTE, ex: '/api/brief' },
    { path: '/api/rwa', method: 'get', price: '0.02', summary: 'Tokenized RWA flows: protocol TVL, 7d change/estimated flows, movers, yields, top RWA tokens (DefiLlama + CoinGecko). $0.02.' },
    { path: '/api/govcontracts', method: 'get', price: '0.01', summary: 'Government contracts data: 14-day US federal awards (USAspending) for AI, drone, nuclear, robotics, space, quantum, and defense-tech. Not a crypto feed. DoD awards ~90 days late. $0.01.', query: { ticker: { type: 'string', description: 'Optional ticker, e.g. PLTR' }, sector: { type: 'string', enum: GOV_SECTORS, description: 'Optional government-contract sector.' }, q: { type: 'string', description: 'Optional keyword in recipient, description, or agency' } } },
    { path: '/api/kraken/listings', method: 'get', price: '0.02', summary: 'Kraken new USD listings (last 30 days) with price, volume, % since listing, and WaveTrend 4h state. $0.02.' },
    { path: '/api/rules', method: 'get', price: '0.02', summary: 'CFTC + SEC crypto rule-change feed (90 days): ANPRM/NPRM/final/notice/press, RIN, comment deadlines. $0.02.' },
    { path: '/api/rs', method: 'get', price: '0.02', summary: 'Relative strength: 1w/1m % return, percentile ranks and 0-100 strength score for 66 Kraken USD pairs, plus sector scores and breadth (L1, L2, DeFi, RWA, oracles/infra, payments, AI, memes). $0.02.' },
    { path: '/api/rails', method: 'get', price: '0.002', summary: 'Cheapest/fastest payment rail right now for a USD amount: Base USDC, XRPL, Tempo, Arc (live fees) vs card (static estimate), with agent-protocol support per rail, with fee USD/%, settlement time and a recommended pick. Optional ?amount=100. $0.002.', query: { amount: { type: 'number', description: 'USD amount, default 100' } } },
    { path: '/api/rails/route', method: 'get', price: RAILS_ROUTE_PRICE_USD, summary: ROUTE_BLURB, query: { chain: { type: 'string', description: 'Mainnet chain. Omit and the route chooses. base, solana, polygon, arbitrum, avalanche, optimism, ethereum, bsc, sei, or worldchain.', example: 'base' }, amount: { type: 'number', description: 'Payment size in USD. Default 1. Under $1 the lowest live facilitator fee wins. At $1 and above, stay on Base unless another chain is cheaper by more than 1% of the payment.', example: 1 } }, ex: '/api/rails/route', responseDescription: 'Paid JSON. recommended is the one facilitator and chain to use, with why. alternatives, fee, settle_time, and status are supporting fields. status is up, down, or unknown.', responseSchema: { type: 'object', properties: { status: { type: 'string' }, signal: ROUTE_OUTPUT_SCHEMA }, required: ['signal'] } },
    { path: '/api/truck/fuel-surcharge', method: 'get', price: FUEL_SURCHARGE_PRICE_USD, summary: FUEL_BLURB, query: { padd: { type: 'string', description: 'us or a PADD: 1, 1A, 1B, 1C, 2, 3, 4 (Rocky Mountain, default), 5.', example: '4' }, base: { type: 'number', description: 'Base diesel price, USD per gallon, 0 to 100.', example: 5.5 }, mpg: { type: 'number', description: 'Miles per gallon, greater than 0 and at most 100.', example: 6 } }, ex: '/api/truck/fuel-surcharge', responseDescription: 'Paid JSON. EIA weekly on-highway diesel, week-over-week change, and per-mile surcharge max(0, current - base) / mpg. Source: U.S. EIA. A failed page read is not settled.', responseSchema: { type: 'object', properties: { status: { type: 'string' }, signal: FUEL_OUTPUT_SCHEMA }, required: ['signal'] } },
    { path: '/api/value/{symbol}', method: 'get', price: VALUE_PRICES.one, summary: 'Value-capture score for one coin (net supply, holder yield, usage class, burn-versus-held, unlock overhang). $0.015.', params: { symbol: { type: 'string', description: 'Ticker, e.g. BNB' } }, ex: '/api/value/BNB', pathEx: { symbol: 'BNB' } },
    { path: '/api/value', method: 'get', price: VALUE_PRICES.batch, summary: 'Value-capture screen: up to 25 symbols or the whole covered set. Sort score, yield or netSupply90d. $0.03.', query: { symbols: { type: 'string', description: 'Comma-separated tickers, max 25' }, sort: { type: 'string', enum: ['score', 'yield', 'netSupply90d'] }, minScore: { type: 'number', description: '0-100, default 0' } } },
    { path: '/api/value/{symbol}/history', method: 'get', price: VALUE_PRICES.history, summary: 'Weekly value-capture snapshots for one coin, up to 52 weeks. Rule classes are carried forward; yield is recomputed. $0.07.', params: { symbol: { type: 'string', description: 'Ticker, e.g. BNB' } }, query: { weeks: { type: 'integer', description: '1-52, default 12' } }, ex: '/api/value/BNB/history', pathEx: { symbol: 'BNB' } },
    { path: '/api/growth/{chain}', method: 'get', price: GROWTH_PRICES.one, summary: 'Growth-lane rules for one chain or app: stables, fees, TVL versus price, and the relative-return flag. $0.015.', params: { chain: { type: 'string', description: 'Chain slug or ticker, e.g. solana or SOL' } }, ex: '/api/growth/solana', pathEx: { chain: 'solana' } },
    { path: '/api/growth', method: 'get', price: GROWTH_PRICES.list, summary: 'Growth-lane screen across covered chains and apps. Filters: kind, minRulesPassed, triggerOnly, minTvlUsd. Window is 90d. $0.03.', query: { kind: { type: 'string', enum: ['chain', 'app', 'all'] }, minRulesPassed: { type: 'integer', description: '0-4' }, triggerOnly: { type: 'boolean' }, minTvlUsd: { type: 'number', description: 'Default 50000000' }, window: { type: 'string', description: '90d' } } },
    { path: '/api/growth/history', method: 'get', price: GROWTH_PRICES.history, summary: 'Weekly growth-lane snapshots plus the week each rule first passed. Up to 52 weeks. $0.07.', query: { weeks: { type: 'integer', description: '1-52, default 12' }, kind: { type: 'string', enum: ['chain', 'app', 'all'] }, minRulesPassed: { type: 'integer' }, triggerOnly: { type: 'boolean' }, minTvlUsd: { type: 'number' }, window: { type: 'string' } } },
    { path: '/api/pay/should-i-pay', method: 'post', price: PAYDECISION_PLAN.priceUsd, summary: SHOULD_I_PAY_COPY, body: { payment: { type: 'object', description: 'as in /api/spend/check' }, policy: { type: 'object', description: 'as in /api/spend/check' }, seller: { type: 'object', description: '{address (Base 0x...), endpoint (x402 https URL), lookbackDays}' }, sellerRules: { type: 'object', description: 'optional {onCaution, onUnknown: pay|ask_human|dont_pay (default ask_human), minScore 0-100}' } }, required: ['payment', 'policy', 'seller'], bodyEx: 'should-i-pay' },
    { path: '/api/spend/check', method: 'post', price: SPEND_PLAN.priceUsd, summary: SPEND_CHECK_COPY, body: { payment: { type: 'object', description: 'amount (decimal string), currency, recipientId and/or recipientDomain, merchantCategory, chain, timestamp (ISO), agentId, memo' }, policy: { type: 'object', description: 'currency, perTxLimit, rollingCap {limit, spentSoFar, windowHours}, allowedCategories, blockedCategories, allowList, denyList, onUnlisted, allowedHours {start, end, timezone, days}, allowedAssets, allowedChains, requireApprovalAbove' } }, required: ['payment', 'policy'], bodyEx: 'spend' },
    { path: '/api/seller/reputation', method: 'post', price: REPUTATION_PLAN.priceUsd, summary: SELLER_REPUTATION_COPY, body: { address: { type: 'string', description: 'seller wallet on Base (0x...)' }, endpoint: { type: 'string', format: 'uri', description: 'x402 https URL; payTo is read from its unpaid 402 challenge' }, lookbackDays: { type: 'integer', minimum: 1, maximum: 90, default: 90 } }, bodyRequired: true, anyOf: [{ required: ['address'] }, { required: ['endpoint'] }], bodyEx: 'reputation' },
    { path: '/api/pass/day', method: 'post', price: PASS_PLAN.priceUsd, summary: `Day pass: ${PASS_PLAN.hours}h access to paid data endpoints via X-GW8-Pass (excludes alert subscribe). Fair use ${PASS_PLAN.dailyCap}/day, ${PASS_PLAN.perMinute}/min. $1.00.`, bodyEx: 'empty' },
    ...Object.values(WEEKLY_PLANS).map(p => ({ path: p.path, method: 'post', price: p.priceUsd, summary: `Weekly Monday brief webhook (${p.weeks} issues): regime, top WaveTrend dots, 7d hit rates, RWA, federal contracts (DoD ~90d lag). $${p.priceUsd}.`, body: { webhookUrl: { type: 'string', format: 'uri', description: 'public https URL', example: 'https://example.com/hook' } }, required: ['webhookUrl'], bodyEx: 'weekly' })),
    { path: '/api/alerts/subscribe', method: 'post', price: ALERT_PLAN.priceUsd, summary: `Webhook alerts for NEW green WaveTrend band dots (${ALERT_PLAN.days} days or ${ALERT_PLAN.maxAlerts} alerts), HMAC-signed. $0.50.`, body: { webhookUrl: { type: 'string', format: 'uri', description: 'public https URL', example: 'https://example.com/hook' }, filter: { type: 'string', enum: ['outer', 'inner', 'all'], default: 'outer' }, pairs: { type: 'array', items: { type: 'string' }, description: 'optional coin symbols, default all 66' } }, required: ['webhookUrl'], bodyEx: 'alerts' }
];
// Keep the token-safety cluster together, then promote the daily brief to the front of every generated surface.
const _verdictFirst = RAW_PAID.findIndex(p => String(p.path).startsWith('/api/verdict/'));
if (_verdictFirst > 0) RAW_PAID.unshift(RAW_PAID.splice(_verdictFirst, 1)[0]);
// Same token-safety screen on a URL that contains "honeypot", so Bazaar keyword search can match the resource path. Price is VERDICT_PRICE_USD.
{
    const verdictSpec = RAW_PAID.find(p => String(p.path).startsWith('/api/verdict/'));
    if (verdictSpec && !RAW_PAID.some(p => String(p.path).startsWith('/api/honeypot/'))) {
        RAW_PAID.splice(RAW_PAID.indexOf(verdictSpec) + 1, 0, {
            ...verdictSpec,
            path: '/api/honeypot/{chain}/{address}',
            ex: '/api/honeypot/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            pathEx: { ...verdictSpec.pathEx }
        });
    }
}
const EX_TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FRESH_QUERY = { fresh: { type: 'string', enum: ['0', '1'], description: '1 re-reads upstream sources. 0 uses the 10-minute cache.', example: '0' } };
{
    const honeypotSpec = RAW_PAID.find(p => p.path === '/api/honeypot/{chain}/{address}');
    const at = honeypotSpec ? RAW_PAID.indexOf(honeypotSpec) + 1 : 2;
    const deepSpec = {
        path: '/api/verdict-deep/{chain}/{address}', method: 'get', price: DEEP_PRICE_USD, summary: DEEP_BLURB,
        params: DEEP_PATH_SCHEMA, query: FRESH_QUERY,
        ex: '/api/verdict-deep/base/' + EX_TOKEN, pathEx: { chain: 'base', address: EX_TOKEN },
        responseDescription: `Paid JSON. signal is the $${VERDICT_PRICE_USD} screen plus deep: holder concentration, liquidity and LP lock, privileges, buy/sell tax, and contract age. Verdict CLEAR, CAUTION, AVOID, or UNKNOWN. A failed lookup is not settled.`,
        responseSchema: { type: 'object', properties: { status: { type: 'string' }, signal: DEEP_OUTPUT_SCHEMA }, required: ['signal'] }
    };
    const briefSpec = {
        path: '/api/token-brief/{chain}/{address}', method: 'get', price: '0.02', summary: BRIEF_BLURB,
        params: BRIEF_PATH_SCHEMA, query: FRESH_QUERY,
        ex: '/api/token-brief/base/' + EX_TOKEN, pathEx: { chain: 'base', address: EX_TOKEN },
        responseDescription: `Paid JSON. signal is the $${VERDICT_PRICE_USD} safety verdict plus marketSnapshot (price, 24h change, 24h volume, liquidity, FDV). A failed lookup is not settled.`,
        responseSchema: { type: 'object', properties: { status: { type: 'string' }, signal: BRIEF_OUTPUT_SCHEMA }, required: ['signal'] }
    };
    const bottomSpec = {
        path: '/api/signals/crypto-bottom', method: 'get', price: '0.01', summary: BOTTOM_BLURB,
        query: FRESH_QUERY, ex: '/api/signals/crypto-bottom',
        responseDescription: 'Paid JSON. Research data, not financial advice. Each coin has tells_count and tier NONE, EARLY_TELL, or CONFIRMED. Cached about 10 minutes. A failed candle read is not settled.',
        responseSchema: { type: 'object', properties: { status: { type: 'string' }, signal: BOTTOM_OUTPUT_SCHEMA }, required: ['signal'] }
    };
    RAW_PAID.splice(at, 0, deepSpec, { ...deepSpec, path: '/api/honeypot-deep/{chain}/{address}', ex: '/api/honeypot-deep/base/' + EX_TOKEN }, briefSpec, bottomSpec);
}
// Lead product first: daily brief, then the cheaper brief+regime bundle, then the token-safety cluster.
{
    const briefAt = RAW_PAID.findIndex(p => p.path === '/api/brief');
    if (briefAt > 0) RAW_PAID.unshift(RAW_PAID.splice(briefAt, 1)[0]);
    if (!RAW_PAID.some(p => p.path === '/api/daily')) {
        RAW_PAID.splice(1, 0, {
            path: '/api/daily', method: 'get', price: DAILY_BUNDLE_PRICE_USD,
            summary: 'Daily bundle: the $0.02 crypto brief (refreshed on each closed 4h bar) plus the full crypto market regime in one call. Separate price is $0.03. Free teaser: GET /api/brief/teaser. $0.025.',
            ex: '/api/daily',
            responseDescription: 'Paid JSON. signal.brief is the daily brief. signal.regime is the full Stage 1 regime. Settled only after both are ready. A failed lookup is not settled.'
        });
    }
}
// Proposal 25: request examples in /openapi.json so scanners (x402scan) and agents can build a valid call. Unpaid calls
// still get the 402 first regardless of input.
const EX_ADDR = '0x1111111111111111111111111111111111111111';
const EX_PAYMENT = { amount: '0.05', currency: 'USDC', chain: 'base', recipientId: EX_ADDR, merchantCategory: 'data-api', timestamp: '2026-10-21T15:30:00Z', agentId: 'research-agent-1' };
const EX_POLICY = { currency: 'USDC', perTxLimit: '1', rollingCap: { limit: '10', spentSoFar: '2.40' }, allowedChains: ['base'], allowedAssets: ['USDC'], requireApprovalAbove: '0.50' };
const BODY_EXAMPLES = {
    spend: { payment: EX_PAYMENT, policy: EX_POLICY },
    reputation: { address: EX_ADDR, lookbackDays: 90 },
    'should-i-pay': { payment: EX_PAYMENT, policy: EX_POLICY, seller: { address: EX_ADDR }, sellerRules: { onCaution: 'ask_human', onUnknown: 'ask_human' } },
    empty: {},
    weekly: { webhookUrl: 'https://example.com/hook' },
    alerts: { webhookUrl: 'https://example.com/hook', filter: 'outer', pairs: ['BTC', 'ETH'] }
};
const EXAMPLE_QUERY = {
    '/api/verdict/{chain}/{address}': '?fresh=0',
    '/api/honeypot/{chain}/{address}': '?fresh=0',
    '/api/verdict-deep/{chain}/{address}': '?fresh=0',
    '/api/honeypot-deep/{chain}/{address}': '?fresh=0',
    '/api/token-brief/{chain}/{address}': '?fresh=0',
    '/api/signals/crypto-bottom': '?fresh=0',
    '/api/history': '?pair=BTC',
    '/api/rails': '?amount=100',
    '/api/rails/route': '?chain=base&amount=1',
    '/api/truck/fuel-surcharge': '?padd=4&base=5.5&mpg=6',
    '/api/govcontracts': '?ticker=PLTR&sector=ai',
    '/api/value': '?symbols=BNB,ETH&sort=score',
    '/api/value/{symbol}/history': '?weeks=12',
    '/api/growth': '?kind=chain&minRulesPassed=2',
    '/api/growth/history': '?weeks=12&kind=chain'
};
function exampleRequestFor(p) {
    const concrete = p.ex || p.path;
    if (p.method === 'post') {
        const body = Object.prototype.hasOwnProperty.call(BODY_EXAMPLES, p.bodyEx) ? BODY_EXAMPLES[p.bodyEx] : {};
        return `POST ${concrete} ${JSON.stringify(body)}`;
    }
    return `GET ${concrete}${EXAMPLE_QUERY[p.path] || ''}`;
}
const PAID = RAW_PAID.map(p => ({ ...p, summary: withCategory(p.path, p.summary), category: categoryOf(p.path), featured: isFeatured(p.path), exampleRequest: exampleRequestFor(p) }));
function paidCatalogMarkdown() {
    const lines = ['| # | Call | Price | What it returns | Example request |', '| --- | --- | --- | --- | --- |'];
    PAID.forEach((p, i) => lines.push(`| ${i + 1} | \`${p.method.toUpperCase()} ${p.path}\` | $${p.price} | ${p.summary.replace(/\|/g, '/')} | \`${p.exampleRequest}\` |`));
    return lines.join('\n');
}
function serveDoc(res, file, contentType) {
    const raw = readFileSync(path.join(__dirname, file), 'utf8').replaceAll('<!--PAID_CATALOG-->', paidCatalogMarkdown());
    res.type(contentType).send(raw);
}
function openApiDoc() {
    const paths = {};
    for (const p of PAID) {
        const parameters = [];
        const pex = p.pathEx || {};
        if (p.pathParam) parameters.push({ name: 'symbol', in: 'path', required: true, schema: { type: 'string', enum: COINS, example: pex.symbol }, example: pex.symbol });
        for (const [name, schema] of Object.entries(p.params || {})) parameters.push({ name, in: 'path', required: true, schema: { ...schema, ...(pex[name] ? { example: pex[name] } : {}) }, ...(pex[name] ? { example: pex[name] } : {}) });
        const querySchema = { ...(p.query || {}) };
        if (p.method === 'get' && Object.keys(querySchema).length === 0) querySchema.sample = { type: 'string', enum: ['0', '1'], description: '1 asks for the free truncated sample when this route is in today\'s sample set. 0 is the paid call.', example: '0' };
        const queryExamples = { pair: 'BTC', fresh: '0', ticker: 'PLTR', sector: 'ai', q: 'NASA', amount: 100, chain: 'base', padd: '4', base: 5.5, mpg: 6, symbols: 'BNB,ETH', sort: 'score', minScore: 0, weeks: 12, kind: 'chain', minRulesPassed: 2, triggerOnly: false, minTvlUsd: 50000000, window: '90d', sample: '0' };
        for (const [name, schema] of Object.entries(querySchema)) {
            const example = schema.example !== undefined ? schema.example : (queryExamples[name] !== undefined ? queryExamples[name] : (Array.isArray(schema.enum) ? schema.enum[0] : undefined));
            parameters.push({ name, in: 'query', required: false, schema: example === undefined ? schema : { ...schema, example }, ...(example !== undefined ? { example } : {}) });
        }
        const bodyExample = p.method === 'post' && Object.prototype.hasOwnProperty.call(BODY_EXAMPLES, p.bodyEx) ? BODY_EXAMPLES[p.bodyEx] : (p.method === 'post' ? {} : undefined);
        paths[p.path] = { [p.method]: {
            operationId: p.path.replace(/[^a-z]/gi, '_'),
            summary: p.summary,
            tags: [p.category, ...(p.featured ? [] : ['not-featured'])].filter(Boolean),
            description: `${p.summary} Example request: ${p.exampleRequest}`,
            'x-example-request': p.exampleRequest,
            security: [],
            ...(parameters.length ? { parameters } : {}),
            ...(p.method === 'post' ? { requestBody: { required: !!(p.required || p.bodyRequired), content: { 'application/json': {
                schema: { type: 'object', properties: p.body || {}, ...(p.required ? { required: p.required } : {}), ...(p.anyOf ? { anyOf: p.anyOf } : {}) },
                example: bodyExample } } } } : {}),
            'x-payment-info': { protocols: [{ x402: {} }], price: { mode: 'fixed', currency: 'USD', amount: p.price } },
            responses: {
                '200': { description: p.responseDescription || 'Signal JSON (signal only, not financial advice)', content: { 'application/json': { schema: p.responseSchema || { type: 'object' } } } },
                '402': { description: `Day pass first: POST /api/pass/day ($1.00). ${dayPassNote(p.price, { isPass: p.path === '/api/pass/day' })} Payment required: ${p.price} USDC on Base (eip155:8453) via x402 v2.${MULTI_RAIL_HTTP_PATHS.has(p.path) ? ' This HTTP route also accepts Polygon USDC (eip155:137) and Solana USDC at the same price. Other paid HTTP routes are Base only. MCP is Base only.' : ''} Free teaser: /api/brief/teaser. ${TRUST_LINE}` }
            }
        } };
    }
    paths['/api/proof/pubkey'] = { get: { operationId: 'proof_pubkey', summary: 'Free: Ed25519 public key used to sign paid responses (X-GW8-Signature, X-GW8-Signed-At, X-GW8-Body-SHA256)', security: [], responses: { '200': { description: 'Public key JSON' } } } };
    paths[VERIFY_PATH] = { get: { operationId: 'receipt_verify', summary: RECEIPT_VERIFY_COPY.replace('Body {payload, signature, data?} or {receipt, data?}.', 'Query payload (receipt.payload or X-GW8-Receipt) and signature (URL-encoded base64).'), description: RECEIPT_VERIFY_COPY.replace('Body {payload, signature, data?} or {receipt, data?}.', 'Query payload (receipt.payload or X-GW8-Receipt) and signature (URL-encoded base64).'), security: [], parameters: [{ name: 'payload', in: 'query', required: true, schema: { type: 'string' } }, { name: 'signature', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{valid, fields, reason?}' } } },
        post: { operationId: 'receipt_verify_post', summary: RECEIPT_VERIFY_COPY, description: RECEIPT_VERIFY_COPY, security: [], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: '{valid, dataMatches?, fields}' } } } };
    paths[RECEIPT_KEY_PATH] = { get: { operationId: 'receipt_key', summary: 'Free: Ed25519 public key + format for verifying X-GW8-Receipt / X-GW8-Receipt-Signature on paid responses', security: [], responses: { '200': { description: 'Key JSON' } } } };
    paths['/api/seller/reputation/status'] = { get: { operationId: 'seller_reputation_status', summary: 'Free: can the seller-reputation data source (alchemy or blockscout, Base) be reached right now? {source, keyed, reachable, http_status, latency_ms, checked_at, cached}. One fixed tiny probe, cached 60s; no input, no receipt.', security: [], responses: { '200': { description: 'Status JSON' } } } };
    paths['/api/govcontracts/status'] = { get: { operationId: 'govcontracts_status', summary: 'Free: gov-contract feed source health (sourceStatus, asOf, dodAnnouncementDays, dodAwardsParsed, count; no rows)', security: [], responses: { '200': { description: 'Status JSON' } } } };
    paths['/api/value/status'] = { get: { operationId: 'value_status', summary: 'Free: value-capture coverage, last refresh and source health. No scores.', security: [], responses: { '200': { description: 'Status JSON' } } } };
    paths['/api/growth/status'] = { get: { operationId: 'growth_status', summary: 'Free: growth-lane coverage, thresholds, last scan and source health. No named rows.', security: [], responses: { '200': { description: 'Status JSON' } } } };
    paths['/api/track'] = { get: { operationId: 'track', summary: 'Free: honest track record of band-dot signals (backtest simulated vs live-logged, hit rates 1d/7d/30d incl. misses). HTML at /track', security: [], responses: { '200': { description: 'Track JSON' } } } };
    paths['/api/sample'] = { get: { operationId: 'sample', summary: 'Free live sample (regime statuses + core WaveTrend values)', security: [], responses: { '200': { description: 'Sample JSON' } } } };
    paths['/api/brief/teaser'] = { get: { operationId: 'brief_teaser', summary: 'Free: today\'s regime (score, label, check statuses) and the top 3 coins by name, plus kind and band. Strength, WaveTrend values, coins after the top 3, and BTC/ETH/SOL flows stay on the paid brief. Upsells /api/brief ($0.02), /api/daily ($0.025), /api/regime, /api/dots, /api/agent', security: [], responses: { '200': { description: 'Teaser JSON' }, '503': { description: 'Brief is still warming. Retry-After: 5' } } } };
    paths['/api/ready'] = { get: { operationId: 'ready', summary: 'Free readiness for the platform health check. 200 after the first brief prewarm attempt finishes, immediately when prewarm is off, or 120s after boot. 503 while the first build is still in flight. Not a paid route.', security: [], responses: { '200': { description: 'Ready for traffic' }, '503': { description: 'Still warming' } } } };
    paths['/health'] = { get: { operationId: 'health', summary: 'Free alias of GET /api/ready. Same status and JSON body. Not a paid route and not counted in stats.', security: [], responses: { '200': { description: 'Ready for traffic' }, '503': { description: 'Still warming' } } } };
    paths['/pay'] = { get: { operationId: 'pay_page', summary: 'Free redirect to /pay.html, the human wallet pay page.', security: [], responses: { '302': { description: 'Redirect to /pay.html' } } } };
    paths['/robots.txt'] = { get: { operationId: 'robots', summary: 'Free crawler rules. Sitemap: /sitemap.xml.', security: [], responses: { '200': { description: 'text/plain' } } } };
    paths['/sitemap.xml'] = { get: { operationId: 'sitemap', summary: 'Free XML list of the public discovery and docs pages.', security: [], responses: { '200': { description: 'application/xml' } } } };
    paths['/api/verdict/example'] = { get: { operationId: 'verdict_example', summary: 'Free example of a paid token-safety screen (CLEAR / CAUTION / AVOID / UNKNOWN). Not a live lookup of a contract you choose. The paid route is GET /api/verdict/{chain}/{address} ($0.005).', security: [], responses: { '200': { description: 'Example JSON' } } } };
    paths['/api/stats'] = { get: { operationId: 'stats', summary: 'Free: per-endpoint request tallies (402 quotes, paid 2xx, 404, 5xx) for the last 1-30 Mountain Time days, plus audience split (known bots vs likely buyers, unique/returning payers by anonymized id). No IPs or PII. HTML at /stats.html; ?format=md for markdown', security: [], parameters: [
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 30, default: 1 } },
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'md'], default: 'json' } }
    ], responses: { '200': { description: 'Stats JSON or markdown' } } } };
    paths['/api/sales'] = { get: { operationId: 'sales', summary: 'Free: which paid routes sold. Counts of x402 settlements, RapidAPI and Apify 2xx calls, day-pass uses, 402 challenges, and free/sample calls, by route template and UTC day. No IPs, wallet addresses, headers, or request bodies. Not an x402 route.', security: [], parameters: [
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 35, default: 7 } }
    ], responses: { '200': { description: 'Sales counts JSON' } } } };
    paths['/api/traffic'] = { get: { operationId: 'traffic', summary: 'Free operator report: requests by route template x HTTP status x UTC day, surfaces (x402 /api, RapidAPI /mkt/rapidapi, free/public), and a capped list of sanitized unmatched probe paths. HTML at /traffic.html. Not counted in its own totals. If TRAFFIC_REPORT_TOKEN is set on the server, send Authorization: Bearer. No IPs, headers, or payment payloads.', security: [], parameters: [
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 30, default: 7 } }
    ], responses: { '200': { description: 'Traffic JSON' }, '401': { description: 'TRAFFIC_REPORT_TOKEN is set and Authorization Bearer did not match' } } } };
    return {
        openapi: '3.1.0',
        info: { title: 'GW8 Daily Crypto Brief, Payment Rails, and Token Safety API', version: API_VERSION, contact: { name: 'GW8', email: 'mariostefano3@gmail.com', url: 'https://github.com/GrayWolf8-creator/micro-saas-agent' },
            description: 'Pay-per-call tools for AI agents via x402 (USDC on Base). Lead product: the daily crypto brief at GET /api/brief ($0.02), refreshed on each closed 4h bar: crypto market regime, WaveTrend dots, top coins, and BTC/ETH/SOL flows. Free teaser GET /api/brief/teaser shows today\'s regime and the top 3 coin names. Daily bundle GET /api/daily ($0.025) is that brief plus the full regime (separate price $0.03). Payment rails at GET /api/rails ($0.002) compare fee and speed for Base USDC, XRPL, Tempo, Arc, and card. Token safety at GET /api/verdict/{chain}/{address} ($0.005) is a honeypot check, rug check, and token security screen returning CLEAR, CAUTION, AVOID, or UNKNOWN; free example GET /api/verdict/example. Also which-rail facilitator choice, x402 seller reputation, spend policy, and government contracts data (not a crypto feed). Agent guide: /agents.md. No charge on failure (settle only after data is ready), receipts (Ed25519-signed when signing is enabled; see /.well-known/gw8-receipt-key `enabled`), safe retries. Signal only, no trading, not financial advice. ' + MULTI_RAIL_COPY,
            'x-guidance': 'Day pass first: POST /api/pass/day ($1.00, 24h). Best value if you call more than N times (N = floor(1.00 / per-call price): $0.002 more than 500, $0.005 more than 200, $0.01 more than 100, $0.015 more than 66, $0.02 more than 50, $0.025 more than 40, $0.03 more than 33, $0.05 more than 20, $0.07 more than 14). Lead with GET /api/brief ($0.02), refreshed on each closed 4h bar: daily crypto brief, regime, top coins, BTC/ETH/SOL flows. Free teaser GET /api/brief/teaser shows today\'s regime and the top 3 coin names. GET /api/daily ($0.025) is the brief plus the full crypto market regime (separate price $0.03). Token safety, honeypot check, rug pull, token security, scam token, contract risk: GET /api/verdict/{chain}/{address} ($0.005, example GET /api/verdict/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?fresh=0) returns CLEAR / CAUTION / AVOID / UNKNOWN. Free example of that JSON (not a live screen): GET /api/verdict/example. Same $0.005 screen: GET /api/honeypot/{chain}/{address}. Deep honeypot check ($0.03): GET /api/verdict-deep/{chain}/{address} and GET /api/honeypot-deep/{chain}/{address}. Token brief, token safety plus price, trade check ($0.02): GET /api/token-brief/{chain}/{address}. Crypto bottom watch ($0.01, research data, not financial advice): GET /api/signals/crypto-bottom. Then GET /api/coin/{symbol} ($0.002), GET /api/regime ($0.01), GET /api/dots ($0.01), POST /api/agent ($0.02), GET /api/history ($0.05), GET /api/flows/{symbol} ($0.02), GET /api/kraken/listings ($0.02), GET /api/rs ($0.02), GET /api/rails ($0.002), GET /api/rails/route ($0.005), GET /api/truck/fuel-surcharge ($0.005), GET /api/rwa ($0.02), GET /api/govcontracts ($0.01), GET /api/rules ($0.02), POST /api/pay/should-i-pay ($0.02), POST /api/spend/check ($0.02), POST /api/seller/reputation ($0.01), GET /api/value/{symbol} ($0.015), GET /api/value ($0.03), GET /api/value/{symbol}/history ($0.07), GET /api/growth/{chain} ($0.015), GET /api/growth ($0.03), GET /api/growth/history ($0.07), POST /api/brief/weekly/subscribe ($0.25), POST /api/alerts/subscribe ($0.50). Start free: GET /agents.md, GET /api/brief/teaser, GET /api/verdict/example, GET /api/sample, GET /llms.txt, GET /openapi.json, GET /.well-known/x402, GET /.well-known/agent.json. Each paid operation has x-example-request. Pay by retrying with PAYMENT-SIGNATURE from the 402 challenge. No charge on failure; paid responses carry an X-GW8-Receipt (Ed25519-signed when signing is enabled; see /.well-known/gw8-receipt-key `enabled`); resending the same PAYMENT-SIGNATURE within 15 min returns the same response without a second charge. ' + MULTI_RAIL_COPY },
        servers: [{ url: 'https://micro-saas-agent.onrender.com' }],
        paths
    };
}
app.get(['/favicon.ico', '/favicon.svg'], (req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b1220"/><path d="M8 40 Q20 10 32 32 T56 24" stroke="#22c55e" stroke-width="6" fill="none"/></svg>'));
app.get('/pay', (req, res) => res.redirect(302, '/pay.html'));
app.get('/robots.txt', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('text/plain; charset=utf-8').send(`User-agent: *\nAllow: /\n\nSitemap: ${PUBLIC_ORIGIN}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
    const body = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...SITEMAP_PATHS.map(p => `  <url><loc>${PUBLIC_ORIGIN}${p}</loc></url>`), '</urlset>', ''].join('\n');
    res.set('Cache-Control', 'public, max-age=3600').type('application/xml; charset=utf-8').send(body);
});
app.get('/openapi.json', (req, res) => res.json(openApiDoc()));
app.get('/.well-known/x402', (req, res) => res.json(discoveryFanout()));
// A2A agent card. /.well-known/agent.json is the legacy well-known path; agent-card.json is the v1 path.
function agentCard() {
    const skills = PAID.map(p => {
        const deep = p.path.startsWith('/api/verdict-deep/') || p.path.startsWith('/api/honeypot-deep/');
        const tokenBrief = p.path.startsWith('/api/token-brief/');
        const dailyBrief = p.path === '/api/brief';
        const dailyBundle = p.path === '/api/daily';
        const bottoms = p.path === '/api/signals/crypto-bottom';
        const whichRail = p.path === '/api/rails/route';
        const fuel = p.path === '/api/truck/fuel-surcharge';
        const verdict = p.path.startsWith('/api/verdict/');
        const honeypot = p.path.startsWith('/api/honeypot/');
        const name = dailyBrief ? 'Daily crypto brief' : dailyBundle ? 'Daily bundle' : deep ? 'Deep honeypot check' : tokenBrief ? 'Token brief' : bottoms ? 'Crypto bottom watch' : whichRail ? 'Which rail' : fuel ? 'Fuel surcharge' : verdict ? 'Token safety screen' : honeypot ? 'Honeypot check' : `${p.method.toUpperCase()} ${p.path}`;
        const tags = dailyBrief ? ['daily brief', 'market regime', 'wavetrend', 'crypto', 'x402']
            : dailyBundle ? ['daily bundle', 'daily brief', 'market regime', 'crypto', 'x402']
            : deep ? ['deep honeypot check', 'rug pull', 'token safety', 'holder concentration', 'liquidity lock', 'scam token', 'x402']
            : tokenBrief ? ['token safety plus price', 'token brief', 'trade check', 'x402']
            : bottoms ? ['crypto bottom', 'research data', 'not financial advice', 'x402']
            : whichRail ? ['facilitator', 'which rail', 'x402', 'payment rail', 'base']
            : fuel ? ['eia', 'diesel', 'fuel surcharge', 'truck', 'x402']
            : (verdict || honeypot) ? ['honeypot', 'honeypot check', 'token safety', 'token security', 'rug pull', 'scam token', 'contract risk', 'x402']
            : ['x402', 'usdc', 'base', p.featured ? 'paid' : 'unfeatured'];
        const examples = dailyBrief ? [p.exampleRequest, 'Daily crypto brief, refreshed on each closed 4h bar: regime, top coins, and BTC/ETH/SOL flows. Free teaser: GET /api/brief/teaser.']
            : dailyBundle ? [p.exampleRequest, 'Daily bundle: the brief plus the full regime in one call.']
            : deep ? [p.exampleRequest, 'Deep honeypot check for rug pull, token safety, holder concentration, liquidity lock, and scam token.']
            : tokenBrief ? [p.exampleRequest, 'Token brief: token safety plus price, a trade check.']
            : bottoms ? [p.exampleRequest, 'Crypto bottom-watch tells. Research data, not financial advice.']
            : whichRail ? [p.exampleRequest, 'Which x402 facilitator and which rail for a payment of this size.']
            : fuel ? [p.exampleRequest, 'EIA weekly diesel per-mile fuel surcharge. Source: U.S. EIA.']
            : (verdict || honeypot) ? [p.exampleRequest, 'Run a honeypot check for token safety, token security, rug pull, scam token, and contract risk before a swap, transfer, or approval.']
            : [p.exampleRequest];
        return {
            id: p.path.replace(/^\/api\//, '').replace(/[{}]/g, '').replace(/\//g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
            name,
            description: p.summary,
            tags,
            examples,
            inputModes: ['text/plain', 'application/json'],
            outputModes: ['application/json']
        };
    });
    const origin = 'https://micro-saas-agent.onrender.com';
    return {
        name: 'GW8 Signal API',
        description: 'Pay-per-call tools for AI agents on x402 (USDC on Base). Lead skill: the daily crypto brief at GET /api/brief ($0.02), refreshed on each closed 4h bar: regime, top coins, and BTC/ETH/SOL flows. Free teaser GET /api/brief/teaser shows today\'s regime and the top 3 coin names. Daily bundle GET /api/daily ($0.025) is that brief plus the full regime. Token safety screen GET /api/verdict/{chain}/{address} ($0.005) returns CLEAR, CAUTION, AVOID, or UNKNOWN for honeypot, rug check, and contract risk. Free example: GET /api/verdict/example. Each skill is an HTTP route, not an A2A task: call the example URL, read the HTTP 402 extensions.bazaar input and output schema, and retry with PAYMENT-SIGNATURE. Signal only, not financial advice. ' + MULTI_RAIL_COPY,
        version: API_VERSION,
        documentationUrl: origin + '/agents.md',
        iconUrl: origin + '/favicon.svg',
        provider: { organization: 'GW8', url: origin },
        supportedInterfaces: [
            { url: origin + '/mcp', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
            { url: origin, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }
        ],
        url: origin + '/mcp',
        preferredTransport: 'HTTP+JSON',
        protocolVersion: '1.0',
        additionalInterfaces: [{ url: origin, transport: 'HTTP+JSON' }],
        capabilities: {
            streaming: false,
            pushNotifications: false,
            stateTransitionHistory: false,
            extendedAgentCard: false,
            extensions: [{
                uri: 'https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md',
                description: 'Paid skills are x402 HTTP routes. An unpaid call returns 402 with resource.description and extensions.bazaar (input schema, output schema, example). Pay USDC on Base (eip155:8453), then retry with PAYMENT-SIGNATURE. CDP Bazaar indexes a route after a settle that echoes that extension.',
                required: false,
                params: { protocol: 'x402', version: 2, network: 'eip155:8453', asset: 'USDC', openapi: origin + '/openapi.json', discovery: origin + '/.well-known/x402', lead: origin + '/api/brief', freeTeaser: origin + '/api/brief/teaser', bundle: origin + '/api/daily' }
            }]
        },
        defaultInputModes: ['text/plain', 'application/json'],
        defaultOutputModes: ['application/json'],
        skills
    };
}
app.get(['/.well-known/agent.json', '/.well-known/agent-card.json'], (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(agentCard());
});
app.get(RECEIPT_KEY_PATH, (req, res) => res.json(receiptKeyInfo()));
// Free receipt check (public key only). POST {payload, signature, data?} or GET ?payload=&signature=.
app.get(VERIFY_PATH, (req, res) => res.json(verifyReceipt({ payload: req.query.payload, signature: typeof req.query.signature === 'string' ? req.query.signature.replace(/ /g, '+') : undefined })));
app.post(VERIFY_PATH, (req, res) => { const b = req.body || {}, r = b.receipt && typeof b.receipt === 'object' ? b.receipt : b; res.json(verifyReceipt({ payload: r.payload, signature: r.signature, data: b.data })); });

// MCP (remote, streamable HTTP, stateless). Free tools return data. Paid tools take x402 payment in-band
// (via @x402/mcp, _meta["x402/payment"]) when the facilitator is configured; otherwise they fall back to
// returning the x402 HTTP endpoint + price so x402-capable agents pay over HTTP.
const ORIGIN = 'https://micro-saas-agent.onrender.com';
const mcpOk = o => ({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o });
const mcpErr = msg => ({ isError: true, content: [{ type: 'text', text: msg }] });
async function buildMcp() {
    const m = new McpServer({ name: 'gw8-crypto-signal', version: API_VERSION });
    const txt = mcpOk;
    m.registerTool('get_sample', { title: 'Free live sample', description: 'Free: Stage 1 regime statuses, core WaveTrend 4h values (BTC/ETH/SOL/LINK/XRP) and band-dot count. Signal only, not financial advice.', inputSchema: {} },
        async () => { try { return txt(await buildSample()); } catch (e) { return mcpErr('upstream data unavailable, retry shortly'); } });
    m.registerTool('get_brief_teaser', { title: 'Free brief teaser', description: 'Free: today\'s regime (score, label, check statuses) and the top 3 coins by name, plus kind and band. Strength, WaveTrend values, later coins, and BTC/ETH/SOL flows stay paid. Upsells /api/brief ($0.02), /api/daily ($0.025), /api/regime ($0.01).', inputSchema: {} },
        async () => { try { return txt(await getBriefTeaser()); } catch (e) { return mcpErr('upstream data unavailable, retry shortly'); } });
    m.registerTool('list_paid_endpoints', { title: 'Paid x402 endpoints', description: 'Lists paid x402 endpoints (USDC on Base, eip155:8453) with method, URL and USD price. Paid MCP tools also accept x402 payment in-band (@x402/mcp).', inputSchema: {} },
        async () => txt({ protocol: 'x402 v2', network: 'eip155:8453', asset: 'USDC', mcpPayments: mcpPayMode().mode, dayPass: { url: ORIGIN + '/api/pass/day', priceUsd: PASS_PLAN.priceUsd, hours: PASS_PLAN.hours, dailyCap: PASS_PLAN.dailyCap, perMinute: PASS_PLAN.perMinute, header: 'X-GW8-Pass', mcpArg: 'pass', excludes: ['/api/alerts/subscribe', ...Object.values(WEEKLY_PLANS).map(p => p.path)] }, openapi: `${ORIGIN}/openapi.json`, endpoints: PAID.map(p => ({ method: p.method.toUpperCase(), url: ORIGIN + p.path, priceUsd: p.price, summary: p.summary })) }));
    // deliver(a) returns the paid data (or {error} -> isError, which skips settlement so the buyer is not charged).
    // precheck(a) runs before any payment is requested; return an error string to refuse without charging.
    const paidTool = async (name, title, path, method, price, desc, schema = {}, build = () => path, deliver, precheck, opts = {}) => {
        desc = withCategory(path, desc);
        const amount = String(Math.round(Number(price) * 1e6));
        if (!opts.noPass) schema = { ...schema, pass: z.string().max(80).optional().describe('Optional GW8 day pass token (from buy_day_pass / POST /api/pass/day); skips per-call payment') };
        const viaPass = async (a) => {
            const p = await usePass(a.pass); if (!p.ok) return mcpErr(`${p.reason} (no payment was taken)`);
            if (precheck) { const bad = await precheck(a); if (bad) { await refundPass(p); return mcpErr(bad); } }
            try { const out = await deliver(a); if (out && out.error) { await refundPass(p); return mcpErr(String(out.error) + ' (pass call not counted)'); } return txt({ ...out, _pass: { remaining: p.remaining, expiresAt: p.expiresAt }, _receipt: mcpReceipt(a, out, null, 'DAY_PASS') }); }
            catch (e) { await refundPass(p); return mcpErr('upstream data unavailable, retry shortly (pass call not counted)'); }
        };
        // Tool-call receipt (tx hash is in _meta["x402/payment-response"], set after this result is built, so tx is null here).
        const mcpReceipt = (a, out, amt, accessType) => { const { pass, ...q } = a || {}; return buildReceipt({ endpoint: `MCP ${name} (${method} ${build(a)})`, query: q, amount: amt, tx: null, accessType }, out); };
        const wrap = await paidWrapper(name, amount, `${title}: ${desc}`);
        const pointer = async (a) => txt({ paymentRequired: true, protocol: 'x402 v2', method, url: ORIGIN + build(a), priceUsd: price, network: 'eip155:8453', howTo: 'Request the URL; on 402, sign the PAYMENT-REQUIRED challenge and retry with PAYMENT-SIGNATURE (e.g. wrapFetchWithPayment from @x402/fetch).', ...funnel(ORIGIN + path, { passUsd: PASS_PLAN.priceUsd, passHours: PASS_PLAN.hours, passCap: PASS_PLAN.dailyCap, noPass: !!opts.noPass, callUsd: Number(price) }).body });
        if (!wrap) return m.registerTool(name, { title, description: `${desc} Paid: $${price} USDC on Base via x402. Returns the endpoint to call with an x402 client.`, inputSchema: schema }, async (a) => (!opts.noPass && a.pass) ? viaPass(a) : pointer(a));
        const run = wrap(async (a) => {
            try { const out = await deliver(a); return out && out.error ? mcpErr(String(out.error)) : txt({ ...out, _receipt: mcpReceipt(a, out, amount, 'X402_MCP_INBAND') }); }
            catch (e) { return mcpErr('upstream data unavailable, retry shortly (not charged)'); }
        });
        return m.registerTool(name, { title, description: `${desc} Paid: $${price} USDC on Base, paid in-band via x402 MCP (@x402/mcp; _meta "x402/payment"). Also at ${method} ${ORIGIN}${path}.`, inputSchema: schema },
            async (a, extra) => { if (!opts.noPass && a.pass) return viaPass(a); if (precheck) { const bad = await precheck(a); if (bad) return mcpErr(bad + ' (no payment was taken)'); } return run(a, extra); });
    };
    let subV = null;
    await paidTool('get_full_signal', 'Full signal', '/api/agent', 'POST', '0.02', 'Stage 1 regime score + WaveTrend 10/21/4 on 66 Kraken 4h pairs with all band dots.', {}, undefined, () => safeSignal());
    await paidTool('get_band_dots', 'Band dots', '/api/dots', 'GET', '0.01', 'Current WaveTrend band dots across 66 Kraken 4h USD pairs.', {}, undefined, () => getDots());
    await paidTool('get_regime', 'Stage 1 regime detail', '/api/regime', 'GET', '0.01', 'Stage 1 crypto regime check with raw values and rules.', {}, undefined, () => getRegime());
    await paidTool('get_coin', 'WaveTrend for one coin', '/api/coin/{symbol}', 'GET', '0.002', 'WaveTrend 4h snapshot for one coin.', { symbol: z.enum(COINS) }, a => `/api/coin/${a.symbol}`, a => getCoin(a.symbol));
    await paidTool('subscribe_green_dot_alerts', 'Green-dot webhook alerts', '/api/alerts/subscribe', 'POST', ALERT_PLAN.priceUsd, `Subscribe a public https webhook to NEW green WaveTrend band dots (filter outer|inner|all, optional pairs) for ${ALERT_PLAN.days} days or ${ALERT_PLAN.maxAlerts} alerts; HMAC-signed. Args {webhookUrl, filter, pairs}.`,
        { webhookUrl: z.string().optional(), filter: z.enum(['outer', 'inner', 'all']).optional(), pairs: z.array(z.string()).optional() }, undefined,
        async a => { const v = subV || await validateSubscribe(a, COINS); return v.error ? { error: v.error } : createSubscription(v); },
        async a => { subV = await validateSubscribe(a, COINS); return subV.error || null; }, { noPass: true });
    await paidTool('buy_day_pass', 'Day pass (24h)', '/api/pass/day', 'POST', PASS_PLAN.priceUsd, `Buy a ${PASS_PLAN.hours}h pass for every paid GW8 data tool/endpoint: pass the returned token as the "pass" argument (MCP) or X-GW8-Pass header (HTTP). Fair use ${PASS_PLAN.dailyCap} calls, ${PASS_PLAN.perMinute}/min. Excludes alert subscriptions. Token shown once.`, {}, undefined, () => mintPass(), undefined, { noPass: true });
    await paidTool('get_history', 'Band-dot history + hit rates', '/api/history', 'GET', '0.05', 'Rolling 90-day band-dot backtest with forward moves and live hit rates (green dots carry the edge; red near coin-flip).', { pair: z.enum(COINS).optional() }, a => a.pair ? `/api/history?pair=${a.pair}` : '/api/history', a => getHistory(a.pair || null));
    await paidTool('get_token_verdict', 'Token safety verdict', '/api/verdict/{chain}/{address}', 'GET', VERDICT_PRICE_USD, `Token safety verdict (honeypot check and token safety screen): honeypot, rug pull, scam token, token security, and contract risk. Returns CLEAR, CAUTION, AVOID, or UNKNOWN. Same screen at GET /api/honeypot/{chain}/{address} ($${VERDICT_PRICE_USD}). Free example (not a live screen): GET /api/verdict/example. Optional fresh=true re-reads upstream. A failed lookup is not charged.`, { chain: z.enum(Object.keys(VERDICT_CHAINS)), address: z.string(), fresh: z.boolean().optional() }, a => `/api/verdict/${a.chain}/${a.address}`,
        a => getVerdict(String(a.chain).toLowerCase(), String(a.address), { fresh: a.fresh === true }), a => validVerdictInput(String(a.chain).toLowerCase(), String(a.address)) || null);
    await paidTool('get_token_verdict_deep', 'Deep honeypot check', '/api/verdict-deep/{chain}/{address}', 'GET', DEEP_PRICE_USD, DEEP_BLURB, { chain: z.enum(Object.keys(VERDICT_CHAINS)), address: z.string(), fresh: z.boolean().optional() }, a => `/api/verdict-deep/${a.chain}/${a.address}`,
        a => getDeepVerdict(String(a.chain).toLowerCase(), String(a.address), { fresh: a.fresh === true }), a => validVerdictInput(String(a.chain).toLowerCase(), String(a.address)) || null);
    await paidTool('get_token_brief', 'Token brief', '/api/token-brief/{chain}/{address}', 'GET', '0.02', BRIEF_BLURB, { chain: z.enum(Object.keys(VERDICT_CHAINS)), address: z.string(), fresh: z.boolean().optional() }, a => `/api/token-brief/${a.chain}/${a.address}`,
        a => getTokenBrief(String(a.chain).toLowerCase(), String(a.address), { fresh: a.fresh === true }), a => validVerdictInput(String(a.chain).toLowerCase(), String(a.address)) || null);
    await paidTool('get_crypto_bottom', 'Crypto bottom watch', '/api/signals/crypto-bottom', 'GET', '0.01', BOTTOM_BLURB, { fresh: z.boolean().optional() }, a => a.fresh ? '/api/signals/crypto-bottom?fresh=1' : '/api/signals/crypto-bottom', a => getCryptoBottoms({ fresh: a.fresh === true }));
    await paidTool('get_flows', 'Large-print flows + dot state', '/api/flows/{symbol}', 'GET', '0.02', 'Kraken large-print buy/sell summary (single venue, not on-chain) joined with WaveTrend 4h state.', { symbol: z.enum(COINS) }, a => `/api/flows/${a.symbol}`, a => getFlows(a.symbol));
    await paidTool('get_rwa_feed', 'RWA feed', '/api/rwa', 'GET', '0.02', 'Real-world assets on-chain (tokenized treasuries, credit, stocks): top RWA protocols by TVL, 7d change + estimated flows, movers, new launches, yields, top RWA tokens by market cap, with sources and timestamp.', {}, undefined, () => getRwa());
    await paidTool('get_gov_contracts', 'Federal contract feed', '/api/govcontracts', 'GET', '0.01', 'Recent (14-day) US federal contract actions to AI, drone, nuclear, robotics, space, quantum and defense-tech companies (USAspending.gov), with tickers, amount, agency, date, description, award link. Optional ticker / sector / q filters. NOTE: the Department of War daily announcements source is currently blocked from our host (sourceStatus.dodAnnouncements=unavailable; check free GET /api/govcontracts/status), so DoD awards currently appear only via USAspending with a ~90-day lag.', { ticker: z.string().regex(/^[A-Za-z.]{1,6}$/).optional(), sector: z.enum(GOV_SECTORS).optional(), q: z.string().max(60).optional() },
        a => { const p = new URLSearchParams(); for (const k of ['ticker', 'sector', 'q']) if (a[k]) p.set(k, a[k]); const qs = p.toString(); return '/api/govcontracts' + (qs ? '?' + qs : ''); }, a => getGovContracts(a));
    await paidTool('get_kraken_listings', 'Kraken new USD listings', '/api/kraken/listings', 'GET', '0.02', 'New Kraken USD pairs from the last 30 days: first-seen date (our snapshot, or first Kraken daily candle for pairs older than our snapshots), price, 24h volume, % change since listing, WaveTrend 4h dot state, plus Kraken blog listing posts.', {}, undefined, () => getKrakenListings());
    await paidTool('get_crypto_rules', 'Crypto rule-change feed (CFTC + SEC)', '/api/rules', 'GET', '0.02', 'CFTC and SEC crypto / digital-asset / stablecoin / tokenization rulemaking from the last 90 days: Federal Register docs (ANPRM/NPRM/final/notice) with RIN, comment deadline, stage-change flag and Unified Agenda presence, plus agency press releases. Each source labeled ok/unavailable; no stale fill.', {}, undefined, () => getRules());
    await paidTool('get_relative_strength', 'Relative strength + sector scores', '/api/rs', 'GET', '0.02', 'Relative strength across 66 Kraken USD pairs: 1-week and 1-month % return, percentile ranks, 0-100 strength score (60% 1m rank + 40% 1w rank), leaders/laggards, and sector scores with breadth (% of coins with a positive 1m return).', {}, undefined, () => getRs());
    await paidTool('get_payment_rails', 'Cheapest payment rail now', '/api/rails', 'GET', '0.002', 'Which payment rail is cheapest and fastest right now for a USD amount: Base USDC (live gas x ETH/USD), XRPL (live fee x XRP/USD), Tempo and Circle Arc (live gas, USD-denominated) and card (static 2.9% + $0.30 estimate), with documented agent protocols (x402, MPP, card networks) per rail. Fee USD and %, settlement time, data timestamp, sources and a recommended pick. Arg amount (USD, default 100).', { amount: z.number().positive().max(1e7).optional() },
        a => a.amount ? `/api/rails?amount=${a.amount}` : '/api/rails', a => getRails(a.amount || 100));
    await paidTool('get_facilitator_route', 'Which x402 facilitator and rail', '/api/rails/route', 'GET', RAILS_ROUTE_PRICE_USD, ROUTE_BLURB, { chain: z.string().optional(), amount: z.number().positive().max(1e7).optional() },
        a => { const p = new URLSearchParams(); if (a.chain) p.set('chain', a.chain); if (a.amount != null) p.set('amount', String(a.amount)); const qs = p.toString(); return '/api/rails/route' + (qs ? '?' + qs : ''); },
        a => getFacilitatorRoute({ chain: a.chain, amount: a.amount }), a => validRouteQuery({ chain: a.chain, amount: a.amount }).error || null);
    await paidTool('get_fuel_surcharge', 'EIA diesel fuel surcharge', '/api/truck/fuel-surcharge', 'GET', FUEL_SURCHARGE_PRICE_USD, FUEL_BLURB, { padd: z.string().optional(), base: z.number().min(0).max(100), mpg: z.number().positive().max(100) },
        a => `/api/truck/fuel-surcharge?padd=${encodeURIComponent(a.padd || '4')}&base=${a.base}&mpg=${a.mpg}`,
        a => getFuelSurcharge({ padd: a.padd, base: a.base, mpg: a.mpg }), a => validFuelQuery({ padd: a.padd, base: a.base, mpg: a.mpg }).error || null);
    const spendSchema = {
        payment: z.object({ amount: z.union([z.string(), z.number()]), currency: z.string(), recipientId: z.string().optional(), recipientDomain: z.string().optional(), merchantCategory: z.string().optional(), chain: z.string().optional(), timestamp: z.string().optional(), agentId: z.string().optional(), memo: z.string().optional() }).passthrough(),
        policy: z.object({}).passthrough().describe('currency, perTxLimit, rollingCap {limit, spentSoFar, windowHours}, allowedCategories, blockedCategories, allowList, denyList, onUnlisted (deny|needs_approval), allowedHours {start, end, timezone, days}, allowedAssets, allowedChains, requireApprovalAbove')
    };
    const spendBody = a => ({ payment: a.payment, policy: a.policy });
    await paidTool('check_spend_policy', 'Spend policy: agent payment rules check, plus a signed audit record', '/api/spend/check', 'POST', SPEND_PLAN.priceUsd, SPEND_CHECK_COPY,
        spendSchema, undefined, a => checkSpend(spendBody(a)), a => validateSpend(spendBody(a)).error || null);
    const repBody = a => ({ address: a.address, endpoint: a.endpoint, lookbackDays: a.lookbackDays });
    await paidTool('check_seller_reputation', 'Seller reputation: x402 seller risk check, plus a signed audit record', '/api/seller/reputation', 'POST', REPUTATION_PLAN.priceUsd, SELLER_REPUTATION_COPY,
        { address: z.string().optional().describe('seller wallet on Base, 0x...'), endpoint: z.string().optional().describe('x402 https endpoint URL'), lookbackDays: z.number().int().min(1).max(90).optional() },
        undefined, a => checkSellerReputation(repBody(a)), a => validateReputation(repBody(a)).error || null);
    const payBody = a => ({ payment: a.payment, policy: a.policy, seller: a.seller, ...(a.sellerRules ? { sellerRules: a.sellerRules } : {}) });
    await paidTool('should_i_pay', 'Payment decision: may this agent pay, plus a signed audit record', '/api/pay/should-i-pay', 'POST', PAYDECISION_PLAN.priceUsd, SHOULD_I_PAY_COPY,
        { ...spendSchema, seller: z.object({ address: z.string().optional(), endpoint: z.string().optional(), lookbackDays: z.number().int().min(1).max(90).optional() }), sellerRules: z.object({ onCaution: z.enum(['pay', 'ask_human', 'dont_pay']).optional(), onUnknown: z.enum(['pay', 'ask_human', 'dont_pay']).optional(), minScore: z.number().int().min(0).max(100).optional() }).optional() },
        undefined, a => checkShouldIPay(payBody(a)), a => validatePayDecision(payBody(a)).error || null);
    await paidTool('get_daily_brief', 'Daily brief', '/api/brief', 'GET', '0.02', BRIEF_QUOTE, {}, undefined, () => getBrief());
    await paidTool('get_daily_bundle', 'Daily bundle', '/api/daily', 'GET', DAILY_BUNDLE_PRICE_USD, 'Daily bundle: the $0.02 brief (refreshed on each closed 4h bar) plus the full Stage 1 regime in one call. $0.025 USDC, cheaper than buying them separately ($0.03).', {}, undefined, () => getDailyBundle());
    await paidTool('get_value_score', 'Value-capture score', '/api/value/{symbol}', 'GET', VALUE_PRICES.one, 'Value-capture score for one coin: net supply, holder yield, usage class, burn-versus-held class and unlock overhang.', { symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/) }, a => `/api/value/${String(a.symbol).toUpperCase()}`, a => getValueSymbol(a.symbol), a => findCoin(a.symbol) ? null : 'unknown symbol');
    await paidTool('get_value_screen', 'Value-capture screen', '/api/value', 'GET', VALUE_PRICES.batch, 'Sortable value-capture screen for up to 25 symbols or the whole covered set.', { symbols: z.string().optional(), sort: z.enum(['score', 'yield', 'netSupply90d']).optional(), minScore: z.number().min(0).max(100).optional() }, a => { const p = new URLSearchParams(); if (a.symbols) p.set('symbols', a.symbols); if (a.sort) p.set('sort', a.sort); if (a.minScore != null) p.set('minScore', String(a.minScore)); const qs = p.toString(); return '/api/value' + (qs ? '?' + qs : ''); }, a => { const q = parseValueQuery(a); return q.error ? { error: q.error } : getValueBatch(q); }, a => parseValueQuery(a).error || null);
    await paidTool('get_value_history', 'Value-capture history', '/api/value/{symbol}/history', 'GET', VALUE_PRICES.history, 'Weekly value-capture snapshots for one coin, up to 52 weeks.', { symbol: z.string().regex(/^[A-Za-z0-9]{1,12}$/), weeks: z.number().int().min(1).max(52).optional() }, a => `/api/value/${String(a.symbol).toUpperCase()}/history${a.weeks ? '?weeks=' + a.weeks : ''}`, a => { const w = parseWeeks(a.weeks); return w.error ? { error: w.error } : getValueHistory(a.symbol, w.weeks); }, a => !findCoin(a.symbol) ? 'unknown symbol' : (parseWeeks(a.weeks).error || null));
    await paidTool('get_growth_setup', 'Growth-lane setup', '/api/growth/{chain}', 'GET', GROWTH_PRICES.one, 'Growth-lane rules for one chain or app: stables, fees, TVL versus price, and the relative-return flag.', { chain: z.string().min(2).max(32) }, a => `/api/growth/${encodeURIComponent(String(a.chain).toLowerCase())}`, a => getGrowthOne(a.chain), a => findGrowth(a.chain) ? null : 'unknown chain');
    await paidTool('get_growth_screen', 'Growth-lane screen', '/api/growth', 'GET', GROWTH_PRICES.list, 'Filterable growth-lane screen across covered chains and apps. Window is 90 days.', { kind: z.enum(['chain', 'app', 'all']).optional(), minRulesPassed: z.number().int().min(0).max(4).optional(), triggerOnly: z.boolean().optional(), minTvlUsd: z.number().min(0).optional(), window: z.string().optional() }, a => { const p = new URLSearchParams(); for (const k of ['kind', 'minRulesPassed', 'triggerOnly', 'minTvlUsd', 'window']) if (a[k] != null && a[k] !== '') p.set(k, String(a[k])); const qs = p.toString(); return '/api/growth' + (qs ? '?' + qs : ''); }, a => { const q = parseGrowthQuery(a); return q.error ? { error: q.error } : getGrowthList(q); }, a => parseGrowthQuery(a).error || null);
    await paidTool('get_growth_history', 'Growth-lane history', '/api/growth/history', 'GET', GROWTH_PRICES.history, 'Weekly growth-lane snapshots and the week each rule first passed.', { weeks: z.number().int().min(1).max(52).optional(), kind: z.enum(['chain', 'app', 'all']).optional(), minRulesPassed: z.number().int().min(0).max(4).optional(), triggerOnly: z.boolean().optional(), minTvlUsd: z.number().min(0).optional() }, a => { const p = new URLSearchParams(); for (const k of ['weeks', 'kind', 'minRulesPassed', 'triggerOnly', 'minTvlUsd']) if (a[k] != null && a[k] !== '') p.set(k, String(a[k])); const qs = p.toString(); return '/api/growth/history' + (qs ? '?' + qs : ''); }, a => { const w = parseWeeks(a.weeks); const q = parseGrowthQuery(a); if (w.error || q.error) return { error: w.error || q.error }; return getGrowthHistory(q, w.weeks); }, a => parseWeeks(a.weeks).error || parseGrowthQuery(a).error || null);
    m.registerTool('get_signing_pubkey', { title: 'Response-signing public key', description: 'Free: Ed25519 public key and scheme for verifying X-GW8-Signature on paid responses.', inputSchema: {} }, async () => txt(publicKeyInfo()));
    return m;
}
app.post('/mcp', async (req, res) => {
    try {
        const server = await buildMcp();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
});
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST (MCP streamable HTTP, stateless)' }));
// Static mcp.json is the card. mcpInBand is the only runtime field (facilitator keys present or not).
function mcpDiscoveryCard() {
    const card = JSON.parse(readFileSync(path.join(__dirname, 'mcp.json'), 'utf8'));
    if (!card.payment || typeof card.payment !== 'object') card.payment = {};
    card.payment.mcpInBand = mcpPayMode().mode === 'inband';
    return card;
}
app.get(['/.well-known/mcp.json', '/.well-known/mcp/server-card.json', '/mcp.json'], (req, res) => res.json(mcpDiscoveryCard()));

// Helper: Decode and parse incoming payment payload
function decodePaymentPayload(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (e) {
        try {
            const decoded = Buffer.from(raw, 'base64').toString('utf8');
            return JSON.parse(decoded);
        } catch (e2) {
            return null;
        }
    }
}

// Verify -> build data -> settle -> respond. Returns { status, headers, body, payer } and never sends.
// Paid data is only ever returned after the facilitator reports a successful settlement.
async function facilitatorPaidCall(req, product, paymentPayload, deliver) {
    await prepareSolanaQuote(product);
    const requirements = getX402ChallengeV2(product || {});
    const choice = chooseFacilitator(requirements.accepts, paymentPayload);
    const paymentRequirements = choice.requirements;
    const usePolygon = choice.facilitator === 'polygon';
    const useSolana = choice.facilitator === 'solana';
    if (useSolana) {
        const exists = await payeeUsdcAccountExists(SOLANA_VAULT_ADDRESS);
        if (exists == null) return { status: 503, body: { error: 'PAYEE_USDC_ACCOUNT_UNKNOWN', message: 'Could not read the payee USDC account on Solana. Nothing was submitted to the facilitator.', note: 'no payment was taken' } };
        if (!exists) return { status: 402, body: { error: 'PAYEE_USDC_ACCOUNT_MISSING', message: 'The Solana payTo has no USDC associated token account yet. PayAI does not create it, and the fee payer must not. Create the native-USDC account for ' + SOLANA_VAULT_ADDRESS + ' (mint ' + USDC_SOLANA + ') with a SOL-funded setup key, then retry.', doc: 'https://docs.payai.network/x402/solana-mainnet-express', note: 'no payment was taken' } };
    }
    // A client holding a challenge issued before the 500-char cap would still echo an over-long resource.description and
    // get CDP's schema 400. resource is not covered by the EIP-3009 signature, so capping it changes nothing that was signed.
    if (paymentPayload && paymentPayload.resource && typeof paymentPayload.resource.description === 'string')
        paymentPayload = { ...paymentPayload, resource: { ...paymentPayload.resource, description: capDescription(paymentPayload.resource.description) } };
    const facilitatorBody = { x402Version: 2, paymentPayload, paymentRequirements };

    const facilitatorUrl = useSolana ? SOLANA_FACILITATOR_URL : usePolygon ? POLYGON_FACILITATOR_URL : CDP_FACILITATOR_URL;
    const publicFacilitator = usePolygon || useSolana;
    const verifyJwt = publicFacilitator ? null : generateCdpJwt('POST', '/platform/v2/x402/verify');
    const verifyHeaders = { 'Content-Type': 'application/json' };
    if (!publicFacilitator) verifyHeaders.Authorization = `Bearer ${verifyJwt}`;
    const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
        method: 'POST',
        headers: verifyHeaders,
        body: JSON.stringify(facilitatorBody)
    });
    if (!verifyRes.ok) {
        const verifyErr = await verifyRes.text();
        return { status: 400, body: { error: "Payment verification failed", details: verifyErr, note: 'no payment was taken' } };
    }
    const verifyData = await verifyRes.json().catch(() => ({}));
    if (verifyData && verifyData.isValid === false) {
        return { status: 400, body: { error: "Payment verification failed", reason: verifyData.invalidReason || 'invalid', note: 'no payment was taken' } };
    }
    // Standard x402 order: verify -> produce the resource -> settle -> return it only if settle succeeded.
    // If the data fetch fails we never settle, so the buyer is not charged.
    let out;
    try { out = await deliver(); } catch (e) { out = { error: 'upstream data unavailable, retry shortly' }; }
    if (!out || out.error) {
        const status = out && Number(out.http) >= 400 && Number(out.http) < 500 ? Number(out.http) : 503;
        return { status, body: { error: (out && out.error) || 'upstream data unavailable, retry shortly', note: 'no payment was taken (payment verified but not settled)', ...(out && out.sourceStatus ? { sourceStatus: out.sourceStatus } : {}) } };
    }
    const settleJwt = publicFacilitator ? null : generateCdpJwt('POST', '/platform/v2/x402/settle');
    const settleHeaders = { 'Content-Type': 'application/json' };
    if (!publicFacilitator) settleHeaders.Authorization = `Bearer ${settleJwt}`;
    let settleRes, settleData;
    try {
        settleRes = await fetch(`${facilitatorUrl}/settle`, {
            method: 'POST',
            headers: settleHeaders,
            body: JSON.stringify(facilitatorBody)
        });
        settleData = await settleRes.json().catch(() => ({}));
    } catch (e) { settleRes = { ok: false, status: 'network' }; settleData = {}; }
    if (!settleRes.ok || settleData.success === false) {
        console.error(useSolana ? "[SOLANA FACILITATOR] settle failed" : usePolygon ? "[POLYGON FACILITATOR] settle failed" : "[CDP FACILITATOR] settle failed", settleRes.status, settleData.errorReason);
        // Paid data is withheld when settlement fails; undo side effects (pass / subscription) created for it.
        if (product && product.rollback) { try { await product.rollback(out); } catch (e) { console.error('[x402] rollback failed', e.message); } }
        return { status: 402, body: { error: "Payment settlement failed", reason: settleData.errorReason || settleRes.status, note: 'no data returned and nothing was created; you can retry' } };
    }
    const payer = payerFrom(paymentPayload, settleData);
    const body = { status: 'success', accessType: 'X402_FACILITATOR_SETTLED', settlement: settleData, timestamp: new Date().toISOString(), signal: out,
        receipt: buildReceipt({ endpoint: `${req.method} ${req.path}`, query: req.query, amount: paymentRequirements.amount, network: paymentRequirements.network, tx: settleData.transaction, payer, accessType: 'X402_FACILITATOR_SETTLED' }, out) };
    const headers = {
        'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settleData)).toString('base64'),
        ...receiptHeaders({ route: `${req.method} ${req.path}`, resource: paymentRequirements && requirements.resource.url, amount: paymentRequirements.amount, network: paymentRequirements.network, payTo: paymentRequirements.payTo, tx: settleData.transaction, payer, accessType: 'X402_FACILITATOR_SETTLED' }, body)
    };
    return { status: 200, headers, body, payer };
}

// 4. Primary x402 v2 Handler
async function handleX402Agent(req, res, product = null) {
    if (typeof product !== 'object') product = null; // Express passes next() as 3rd arg on /api/agent
    const deliver = product ? product.deliver : safeSignal;
    const paymentSigHeader = req.headers['payment-signature'] || req.headers['x-payment'];
    const legacyTx = req.headers['x-payment-tx'] || req.query.tx; // retired path, see below
    // Day pass: X-GW8-Pass header skips the 402 when valid (checked before the paywall). Not for excluded products.
    const passHdr = req.headers['x-gw8-pass'];
    if (passHdr && !(product && product.noPass)) {
        const p = await usePass(String(passHdr));
        if (!p.ok) return res.status(p.status).json({ error: p.reason, note: 'no payment was taken; buy a pass at POST /api/pass/day or pay per call via x402' });
        if (product && product.precheck) { const pc = await product.precheck(req); if (pc && pc.error) { await refundPass(p); return res.status(400).json({ error: pc.error }); } }
        let out;
        try { out = await deliver(); } catch (e) { out = { error: 'upstream data unavailable, retry shortly' }; }
        if (!out || out.error) { await refundPass(p); const status = out && Number(out.http) >= 400 && Number(out.http) < 500 ? Number(out.http) : 503; return res.status(status).json({ error: (out && out.error) || 'upstream data unavailable, retry shortly', note: 'pass call not counted', ...(out && out.sourceStatus ? { sourceStatus: out.sourceStatus } : {}) }); }
        res.locals.gw8Access = 'daypass';
        return res.set('X-GW8-Pass-Remaining', String(p.remaining)).json({ status: 'success', accessType: 'DAY_PASS', pass: { remaining: p.remaining, expiresAt: p.expiresAt }, timestamp: new Date().toISOString(), signal: out,
            receipt: buildReceipt({ endpoint: `${req.method} ${req.path}`, query: req.query, amount: null, tx: null, accessType: 'DAY_PASS' }, out) });
    }

    // PRIMARY PATH: x402 v2 EIP-3009 Signature Verification via CDP Facilitator
    if (paymentSigHeader && product && product.precheck) {
        const pc = await product.precheck(req);
        if (pc && pc.error) return res.status(400).json({ error: pc.error, note: 'no payment was taken' });
    }
    if (paymentSigHeader) {
        // Base still requires the CDP keys. A Polygon payment on a route that lists Polygon uses the public facilitator and does not.
        const peeked = decodePaymentPayload(paymentSigHeader);
        let publicPay = false;
        try {
            await prepareSolanaQuote(product);
            publicPay = chooseFacilitator(getX402ChallengeV2(product || {}).accepts, peeked).facilitator !== 'cdp';
        } catch { publicPay = false; }
        if (!publicPay && (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET)) {
            console.error("[CDP FACILITATOR] KEYS_MISSING: CDP_API_KEY_ID or CDP_API_KEY_SECRET not set on Render.");
            return res.status(500).json({ error: "Facilitator Configuration Error", code: "KEYS_MISSING", note: 'no payment was taken' });
        }
        try {
            const paymentPayload = peeked;
            if (!paymentPayload) return res.status(400).json({ error: 'Unreadable PAYMENT-SIGNATURE', note: 'no payment was taken' });
            const url = getX402ChallengeV2(product || {}).resource.url; // quote already prepared above
            // Safe retry: the same signed payload to the same resource returns the first successful response.
            const r = await once(replayKey(url, paymentPayload), () => facilitatorPaidCall(req, product, paymentPayload, deliver));
            if (r.status === 200) {
                res.locals.gw8Payer = r.payer || null;
                if (r.replay) { res.locals.gw8Replay = true; res.set('X-GW8-Replay', 'true'); }
                else res.locals.gw8Access = 'x402';
            }
            if (r.headers) res.set(r.headers);
            return res.status(r.status).json(r.body);
        } catch (err) {
            console.error("[CDP FACILITATOR ERROR]", err && err.message);
            return res.status(500).json({ error: "Internal Facilitator Error", note: 'no data was returned; if a charge appears without data, the settle did not complete on our side' });
        }
    }

    // RETIRED: manual tx-hash redemption (X-Payment-Tx / ?tx=). A public USDC transfer to the payout wallet is
    // visible to anyone, so redeeming a tx hash for data let third parties claim other people's payments. It had
    // no recorded use. Nothing is delivered for a tx hash; callers get the x402 challenge to pay the normal way.
    if (legacyTx && !product) {
        await prepareSolanaQuote(null);
        const challenge = getX402ChallengeV2();
        return res.status(410)
            .set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'))
            .json({ error: 'MANUAL_TX_RETIRED', message: 'Paying by raw USDC transfer + tx hash is no longer accepted (anyone could redeem a public tx). Pay with x402 instead: sign the PAYMENT-REQUIRED challenge and retry with PAYMENT-SIGNATURE. No data is returned for a tx hash.', howTo: `${BASE_URL}/pay.html`, freeTeaser: `${BASE_URL}/api/brief/teaser`, note: 'If you already sent a raw transfer expecting data, contact the operator via the GitHub repo for a refund.' });
    }

    // PRIMARY CHALLENGE: 402 Payment Required (x402 Version 2). v2 fields unchanged; GW8 extras ride alongside.
    await prepareSolanaQuote(product);
    const challenge = getX402ChallengeV2(product || {});
    const challengeBase64 = Buffer.from(JSON.stringify(challenge)).toString('base64');
    const callUsd = product && product.amount ? Number(product.amount) / 1e6 : 0.02;
    const f = funnel(challenge.resource.url, { passUsd: PASS_PLAN.priceUsd, passHours: PASS_PLAN.hours, passCap: PASS_PLAN.dailyCap, noPass: !!(product && product.noPass), callUsd });

    return res.status(402)
        .set('PAYMENT-REQUIRED', challengeBase64)
        .set('X-402-Pay-To', VAULT_ADDRESS)
        .set('X-402-Amount-USDC', product ? String(Number(product.amount) / 1e6) : '0.02')
        .set('X-402-Chain', 'eip155:8453')
        .set(f.headers)
        .json({ dayPass: f.body.dayPass, ...challenge, ...(product && product.freeExample ? { freeExample: product.freeExample } : {}), gw8: f.body });
}

// Free public track record (backtest + live log)
let trackCache = null;
const trackData = async () => { if (trackCache && Date.now() - trackCache.t < 10 * 60 * 1000) return trackCache.d; const d = await getTrack(); trackCache = { t: Date.now(), d }; return d; };
app.get('/api/track', async (req, res) => { try { res.json(await trackData()); } catch (e) { res.status(503).json({ error: 'upstream data unavailable, retry shortly' }); } });
app.get('/track', async (req, res) => { try { res.type('html').send(renderTrack(await trackData())); } catch (e) { res.status(503).type('text').send('Track record temporarily unavailable, retry shortly.'); } });

// Free live sample (no payment)
app.get('/api/sample', async (req, res) => {
    try { res.json(await buildSample()); }
    catch (e) { res.status(503).json({ error: 'upstream data unavailable, retry shortly' }); }
});
// Free partial brief teaser (15-min cache in upgrades.js)
app.get('/api/brief/teaser', async (req, res) => {
    try {
        const t = await getBriefTeaser();
        if (t && t.error) {
            const retry = t.retryAfter || 5;
            return res.status(503).set('Retry-After', String(retry)).json({ error: t.error, retryAfter: retry });
        }
        res.json(t);
    } catch (e) { res.status(503).set('Retry-After', '5').json({ error: 'upstream data unavailable, retry shortly', retryAfter: 5 }); }
});
// Platform readiness. Free, not x402, and not counted in stats. Does not replace GET /.
// /health is the same check for load balancers and crawlers.
function sendReady(res) {
    const s = briefReadyStatus();
    if (!s.ready) res.set('Retry-After', String(s.retryAfter || 5));
    res.status(s.http).json({ ready: s.ready, reason: s.reason });
}
app.get('/api/ready', (req, res) => sendReady(res));
app.get('/health', (req, res) => sendReady(res));

// Free per-endpoint request stats (not x402-paid, not listed on Bazaar). No PII.
app.get('/api/stats', async (req, res) => {
    try {
        const s = await getStats(req.query.days);
        if (String(req.query.format || '').toLowerCase() === 'md') return res.type('text/markdown').send(renderStatsMd(s));
        return res.json(s);
    } catch (e) { res.status(503).json({ error: 'stats unavailable, retry shortly' }); }
});
app.get('/stats.html', async (req, res) => {
    try {
        const s = await getStats(req.query.days);
        res.type('html').send(renderStatsHtml(s));
    } catch (e) { res.status(503).type('text').send('Stats temporarily unavailable, retry shortly.'); }
});
// Route x status report. Not an x402 route. Skipped by statsMiddleware so it does not count itself.
mountTrafficReport(app);
// Which routes sold. Not an x402 route and not part of the Bazaar paid catalog.
mountSalesReport(app);

// Card-paid marketplace channels (RapidAPI / Apify). Off unless GW8 sets the channel env var on Render.
mountMarketplace(app, signResponses);
app.use(['/api/agent', '/api/dots', '/api/history', '/api/regime', '/api/coin', '/api/verdict', '/api/honeypot', '/api/verdict-deep', '/api/honeypot-deep', '/api/token-brief', '/api/signals', '/api/flows', '/api/brief', '/api/daily', '/api/rwa', '/api/govcontracts', '/api/kraken/listings', '/api/rules', '/api/rs', '/api/rails', '/api/truck', '/api/value', '/api/growth', '/api/spend/check', '/api/seller/reputation', '/api/pay/should-i-pay'], signResponses);
app.all('/api/agent', handleX402Agent);

// Cheaper single-purpose products (signal only)
const BASE_URL = 'https://micro-saas-agent.onrender.com';
app.get('/api/dots', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/dots`, amount: "10000", name: "GW8 WaveTrend Band Dots (66 Kraken pairs, 4h)",
    description: "WaveTrend oversold and overbought band dots on 66 Kraken 4h USD pairs (green when wt1 is at or below -53, outer at or below -60; red at or above 53, outer at or above 60) from the last 6 closed bars. $0.01 USDC. Signal only.",
    tags: ["wavetrend", "band dots", "oversold", "overbought", "kraken"],
    serviceName: "GW8 WaveTrend Dots",
    example: { asOf: "2026-10-17T20:00:00Z", bandDots: [{ name: "LINK", kind: "green", band: "inner", wt1: -54.8, bar: "2026-10-17T16:00:00.000Z", close: 11.2 }] },
    deliver: getDots
}));
app.get('/api/history', (req, res) => {
    const pair = req.query.pair ? String(req.query.pair).toUpperCase().replace(/\/USD$/, '') : null;
    if (pair && !COINS.includes(pair)) return res.status(404).json({ error: 'unknown pair', supported: COINS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/history`, amount: "50000", name: "GW8 WaveTrend Band-Dot History + Hit Rates (90d, 66 pairs)",
        description: "WaveTrend hit-rate backtest: simulated 90-day forward moves of band dots on 66 Kraken 4h USD pairs (recomputed live, not a live trade log). Returns forward percent at 4h, 24h, and 3d. Optional ?pair=BTC. $0.05 USDC. Past performance is not indicative of future results.",
        tags: ["wavetrend backtest", "hit rate", "band dots", "kraken", "forward return"],
        serviceName: "GW8 WaveTrend Backtest",
        example: { window: "90 days", methodology: "simulated backtest", summary: { green_all: { fwd24hPct: { n: 120, hitRatePct: 55.0, avgMovePct: 0.8 } } }, dots: [{ pair: "LINK/USD", kind: "green", band: "inner", bar: "2026-10-17T16:00:00.000Z", wt1: -54.8, wt2: -48.6, close: 11.2, fwd4hPct: 0.6, fwd24hPct: null, fwd3dPct: null }] },
        inputProps: { pair: { type: "string", description: "Optional coin symbol, e.g. BTC", example: "BTC" } },
        deliver: () => getHistory(pair)
    });
});
app.get('/api/regime', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/regime`, amount: "10000", name: "GW8 Stage 1 Crypto Regime Check (detail)",
    description: "Crypto market regime score from 0 to 4, risk-on or risk-off: BTC spot ETF 3-day net flow, BTC quiet support versus the 20-day low, alt breadth for ETH, SOL, LINK, and XRP, and Fear and Greed. Use before other crypto signals. $0.01 USDC. Signal only, not financial advice.",
    tags: ["crypto market regime", "market regime", "risk-on", "fear and greed", "btc etf"],
    serviceName: "GW8 Crypto Market Regime",
    example: { score: 3, outOf: 4, checks: { btcQuietSupport: { status: "pass", detail: { pctAboveLow: 2.1, avgRange3dPct: 2.4 }, rule: "BTC within quiet band above 20d low" } } },
    deliver: getRegime
}));
// Proposal 26 (x402dash): its listing checker only sends GET, so POST-only paid routes never got listed.
// An UNPAID GET (no PAYMENT-SIGNATURE / X-PAYMENT / X-GW8-Pass / tx) to a POST-only paid route now answers with the
// exact same 402 challenge as an unpaid POST (same accepts, price, description, bazaar schema with method POST),
// plus an Allow: POST header. A GET never delivers, verifies, settles or uses a pass: with any payment, pass or tx
// it gets 405 "use POST" and nothing is taken. POST behavior and pricing are unchanged.
function quoteOnlyGet(routePath, makeProduct) {
    app.get(routePath, (req, res) => {
        res.set('Allow', 'POST');
        if (req.headers['payment-signature'] || req.headers['x-payment'] || req.headers['x-gw8-pass'] || req.headers['x-payment-tx'] || req.query.tx) {
            return res.status(405).json({ error: 'METHOD_NOT_ALLOWED', method: 'POST', message: `${routePath} is POST-only. GET only returns the unpaid x402 quote (402). Retry as POST ${routePath} with a JSON body and your payment header.`, note: 'no payment was taken; nothing was verified or settled' });
        }
        // Quote only: strip every hook that could do work; handleX402Agent with no payment/pass/tx returns the 402.
        const { precheck, deliver, rollback, ...quote } = makeProduct(req);
        return handleX402Agent(req, res, { ...quote, deliver: async () => ({ error: 'quote only' }) });
    });
}
const SUB_URL = `${BASE_URL}/api/alerts/subscribe`;
const alertsProduct = (req) => {
    let v = null;
    return {
        url: SUB_URL, method: "POST", amount: ALERT_PLAN.amount, noPass: true,
        name: "GW8 Green-Dot Webhook Alerts (30 days)",
        description: `WaveTrend green-dot alerts: subscribe a public https webhook to NEW green oversold band dots on 66 Kraken 4h pairs (filter outer, inner, or all; optional pairs). HMAC-signed POSTs for ${ALERT_PLAN.days} days or ${ALERT_PLAN.maxAlerts} alerts. $${ALERT_PLAN.priceUsd} USDC. Invalid bodies rejected before payment. Signal only.`,
        tags: ["wavetrend alerts", "green dots", "oversold", "webhook", "band dots"],
        serviceName: "GW8 WaveTrend Alerts",
        inputProps: { webhookUrl: { type: "string", example: "https://example.com/hook" }, filter: { type: "string", enum: ["outer", "inner", "all"], example: "outer" }, pairs: { type: "array", items: { type: "string" }, example: ["BTC", "ETH"] } },
        bodyRequired: ["webhookUrl"],
        example: { subscriptionId: "sub_…", filter: "outer", expiresAt: "2026-11-17T00:00:00Z", alertsLeft: ALERT_PLAN.maxAlerts, note: "one-time webhook secret returned once at subscribe" },
        precheck: async (r) => { v = await validateSubscribe(r.body, COINS); return v.error ? v : null; },
        deliver: async () => { if (!v) v = await validateSubscribe(req.body, COINS); return v.error ? { error: v.error } : createSubscription(v); },
        rollback: out => cancelSubscription(out && out.subscriptionId)
    };
};
app.post('/api/alerts/subscribe', (req, res) => handleX402Agent(req, res, alertsProduct(req)));
quoteOnlyGet('/api/alerts/subscribe', alertsProduct);
const weeklyProduct = (plan) => (req) => {
    let v = null;
    return {
        url: `${BASE_URL}${plan.path}`, method: "POST", amount: plan.amount, noPass: true,
        name: `GW8 Weekly Brief (${plan.weeks} weeks, webhook)`,
        description: `Weekly crypto brief: ${plan.weeks} Monday webhook issues (HMAC-signed) with the crypto market regime, top WaveTrend dots, 7-day hit rates, tokenized RWA flows, and federal contract highlights (DoD awards about 90 days late via USAspending). Undelivered weeks are not counted. $${plan.priceUsd} USDC.`,
        tags: ["weekly crypto brief", "crypto market regime", "daily crypto brief", "webhook", "wavetrend"],
        serviceName: "GW8 Weekly Crypto Brief",
        inputProps: { webhookUrl: { type: "string", description: "public https URL", example: "https://example.com/hook" } },
        bodyRequired: ["webhookUrl"],
        example: { subscriptionId: "wk_…", plan: plan.id, issuesLeft: plan.weeks, expiresAt: "2026-11-22T00:00:00Z", note: "one-time webhook secret returned once at subscribe" },
        precheck: async (r) => { v = await validateWeekly(r.body); return v.error ? v : null; },
        deliver: async () => { if (!v) v = await validateWeekly(req.body); return v.error ? { error: v.error } : createWeekly(v, plan); },
        rollback: out => cancelWeekly(out && out.subscriptionId)
    };
};
for (const plan of Object.values(WEEKLY_PLANS)) {
    app.post(plan.path, (req, res) => handleX402Agent(req, res, weeklyProduct(plan)(req)));
    quoteOnlyGet(plan.path, weeklyProduct(plan));
}
app.get('/api/brief/weekly/:id', async (req, res) => {
    const s = await getWeeklyStatus(String(req.params.id));
    return s ? res.json(s) : res.status(404).json({ error: 'unknown subscription' });
});
setInterval(() => weeklyTick().then(r => r && r.sent && console.log('[weekly]', JSON.stringify(r))).catch(() => {}), 10 * 60 * 1000).unref();
const passProduct = () => ({
    url: `${BASE_URL}/api/pass/day`, method: "POST", amount: PASS_PLAN.amount, noPass: true,
    name: "GW8 Day Pass (24h, all paid data endpoints)",
    description: `Day pass: one payment unlocks ${PASS_PLAN.hours}h of paid GW8 data endpoints and MCP tools via header X-GW8-Pass (or MCP arg pass). Fair use ${PASS_PLAN.dailyCap} calls per pass, ${PASS_PLAN.perMinute} per minute. Excludes alert subscriptions. Token shown once. $${PASS_PLAN.priceUsd} USDC. Signal only.`,
    tags: ["day pass", "24h access", "x402", "usdc", "paid api"],
    serviceName: "GW8 Day Pass",
    body: {},
    example: { pass: "gw8p_…", expiresAt: "2026-10-19T19:00:00.000Z", header: "X-GW8-Pass" },
    deliver: () => mintPass(),
    rollback: out => revokePass(out && out.pass)
});
app.post('/api/pass/day', (req, res) => handleX402Agent(req, res, passProduct(req)));
quoteOnlyGet('/api/pass/day', passProduct);
app.get('/api/alerts/:id', async (req, res) => {
    const s = await getStatus(String(req.params.id));
    return s ? res.json(s) : res.status(404).json({ error: 'unknown subscription' });
});
onWaveTrendRefresh(wt => logDots(wt).then(r => r.added && console.log('[track] logged', r.added)).catch(() => {}));
onWaveTrendRefresh(wt => onRefresh(wt).then(r => r && (r.sent || r.seeded) && console.log('[alerts]', JSON.stringify(r))));
setInterval(() => getWaveTrend().catch(() => {}), 10 * 60 * 1000).unref();
console.log('[alerts] persistence:', persistenceMode());
// Proposal 25 (x402scan): paywall before input validation. An UNPAID request (no PAYMENT-SIGNATURE / X-PAYMENT and no
// X-GW8-Pass) always gets the 402 challenge, even with an empty body or a literal path template like /api/coin/%7Bsymbol%7D,
// so scanners can read the price. Bad input is still rejected with 400/404 BEFORE any payment is verified or settled and
// before a pass call is used (route check below + product.precheck in handleX402Agent), so invalid input is never charged.
const hasPaymentOrPass = req => !!(req.headers['payment-signature'] || req.headers['x-payment'] || req.headers['x-gw8-pass']);
// For an unpaid request with unusable path params, quote the canonical template URL with example params (no data is served).
const SYM_EXAMPLE = COINS.includes('BTC') ? 'BTC' : COINS[0];

app.get('/api/coin/:symbol', (req, res) => {
    const raw = String(req.params.symbol || '').toUpperCase();
    const ok = COINS.includes(raw);
    if (!ok && hasPaymentOrPass(req)) return res.status(404).json({ error: 'unknown symbol', supported: COINS, note: 'no payment was taken' });
    const sym = ok ? raw : SYM_EXAMPLE;
    return handleX402Agent(req, res, {
        url: ok ? `${BASE_URL}/api/coin/${sym}` : `${BASE_URL}/api/coin/{symbol}`, amount: "2000", name: ok ? `GW8 WaveTrend 4h: ${sym}/USD` : 'GW8 WaveTrend 4h: one coin',
        description: `WaveTrend 4h snapshot for ${ok ? sym : 'one coin'}/USD on Kraken (wt1, wt2, previous values, recent oversold and overbought band dots). One-coin read, not the daily crypto brief. Cheapest paid call. $0.002 USDC. Signal only.`,
        tags: ["wavetrend", "crypto coin", "kraken 4h", "oversold", "one coin"],
        serviceName: "GW8 WaveTrend Coin",
        routeTemplate: "/api/coin/:symbol",
        pathParams: { symbol: sym },
        example: { name: sym, wt1: -41.2, wt2: -38.9, prevWt1: -44.0, prevWt2: -39.5, dots: [] },
        precheck: async () => ok ? null : { error: 'unknown symbol' },
        deliver: () => getCoin(sym)
    });
});

// Upgrades-4: token verdict, flows, daily brief (signal only, public data)
app.get('/api/proof/pubkey', (req, res) => res.json(publicKeyInfo()));
// Free static example of the paid screen. Registered before /:chain/:address so "example" is not a chain.
app.get('/api/verdict/example', (req, res) => res.json({ ...verdictExampleBody(), url: `${BASE_URL}/api/verdict/example` }));
// /api/honeypot is the same screen and price as /api/verdict. The path is an alias so Bazaar can match "honeypot".
function sendVerdictChallenge(req, res) {
    const alias = String(req.path || '').startsWith('/api/honeypot/');
    const root = alias ? '/api/honeypot' : '/api/verdict';
    const rawChain = String(req.params.chain).toLowerCase(), rawAddress = String(req.params.address);
    const bad = validVerdictInput(rawChain, rawAddress);
    if (bad && hasPaymentOrPass(req)) return res.status(400).json({ error: bad, chains: Object.keys(VERDICT_CHAINS), note: 'no payment was taken' });
    const chain = bad ? VERDICT_EXAMPLE.chain : rawChain, address = bad ? VERDICT_EXAMPLE.address : rawAddress;
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    return handleX402Agent(req, res, {
        url: bad ? `${BASE_URL}${root}/{chain}/{address}` : `${BASE_URL}${root}/${chain}/${address}`, amount: usdAtomic(VERDICT_PRICE_USD), name: VERDICT_SERVICE_NAME,
        description: VERDICT_BLURB,
        tags: VERDICT_TAGS,
        serviceName: VERDICT_SERVICE_NAME,
        routeTemplate: `${root}/:chain/:address`,
        pathParams: { chain, address },
        pathParamSchema: VERDICT_PATH_SCHEMA,
        inputProps: { fresh: { type: 'string', enum: ['0', '1'], description: '1 re-reads GoPlus and DexScreener for this honeypot check. 0 uses the 10-minute cache.', example: '0' } },
        outputSchema: VERDICT_OUTPUT_SCHEMA,
        example: VERDICT_EXAMPLE,
        freeExample: { ...verdictExampleBody(), url: `${BASE_URL}/api/verdict/example` },
        precheck: async () => bad ? { error: bad } : null,
        deliver: () => getVerdict(chain, address, { fresh }).catch(() => ({ error: 'upstream data unavailable, retry shortly', http: 503, sourceStatus: { goplus: 'unavailable', dexscreener: 'unavailable' } }))
    });
}
app.get('/api/verdict/:chain/:address', sendVerdictChallenge);
app.get('/api/honeypot/:chain/:address', sendVerdictChallenge);
function sendDeepChallenge(req, res) {
    const alias = String(req.path || '').startsWith('/api/honeypot-deep/');
    const root = alias ? '/api/honeypot-deep' : '/api/verdict-deep';
    const rawChain = String(req.params.chain).toLowerCase(), rawAddress = String(req.params.address);
    const bad = validVerdictInput(rawChain, rawAddress);
    if (bad && hasPaymentOrPass(req)) return res.status(400).json({ error: bad, chains: Object.keys(VERDICT_CHAINS), note: 'no payment was taken' });
    const chain = bad ? DEEP_EXAMPLE.chain : rawChain, address = bad ? DEEP_EXAMPLE.address : rawAddress;
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    return handleX402Agent(req, res, {
        url: bad ? `${BASE_URL}${root}/{chain}/{address}` : `${BASE_URL}${root}/${chain}/${address}`, amount: usdAtomic(DEEP_PRICE_USD), name: DEEP_SERVICE_NAME,
        description: DEEP_BLURB,
        tags: DEEP_TAGS,
        serviceName: DEEP_SERVICE_NAME,
        routeTemplate: `${root}/:chain/:address`,
        pathParams: { chain, address },
        pathParamSchema: DEEP_PATH_SCHEMA,
        inputProps: FRESH_QUERY,
        outputSchema: DEEP_OUTPUT_SCHEMA,
        example: DEEP_EXAMPLE,
        precheck: async () => bad ? { error: bad } : null,
        deliver: () => getDeepVerdict(chain, address, { fresh }).catch(() => ({ error: 'upstream data unavailable, retry shortly', http: 503 }))
    });
}
app.get('/api/verdict-deep/:chain/:address', sendDeepChallenge);
app.get('/api/honeypot-deep/:chain/:address', sendDeepChallenge);
app.get('/api/token-brief/:chain/:address', (req, res) => {
    const rawChain = String(req.params.chain).toLowerCase(), rawAddress = String(req.params.address);
    const bad = validVerdictInput(rawChain, rawAddress);
    if (bad && hasPaymentOrPass(req)) return res.status(400).json({ error: bad, chains: Object.keys(VERDICT_CHAINS), note: 'no payment was taken' });
    const chain = bad ? BRIEF_EXAMPLE.chain : rawChain, address = bad ? BRIEF_EXAMPLE.address : rawAddress;
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    return handleX402Agent(req, res, {
        url: bad ? `${BASE_URL}/api/token-brief/{chain}/{address}` : `${BASE_URL}/api/token-brief/${chain}/${address}`, amount: '20000', name: BRIEF_SERVICE_NAME,
        description: BRIEF_BLURB,
        tags: BRIEF_TAGS,
        serviceName: BRIEF_SERVICE_NAME,
        routeTemplate: '/api/token-brief/:chain/:address',
        pathParams: { chain, address },
        pathParamSchema: BRIEF_PATH_SCHEMA,
        inputProps: FRESH_QUERY,
        outputSchema: BRIEF_OUTPUT_SCHEMA,
        example: BRIEF_EXAMPLE,
        precheck: async () => bad ? { error: bad } : null,
        deliver: () => getTokenBrief(chain, address, { fresh }).catch(() => ({ error: 'upstream data unavailable, retry shortly', http: 503 }))
    });
});
app.get('/api/signals/crypto-bottom', (req, res) => {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/signals/crypto-bottom`, amount: '10000', name: BOTTOM_SERVICE_NAME,
        description: BOTTOM_BLURB,
        tags: BOTTOM_TAGS,
        serviceName: BOTTOM_SERVICE_NAME,
        routeTemplate: '/api/signals/crypto-bottom',
        inputProps: FRESH_QUERY,
        outputSchema: BOTTOM_OUTPUT_SCHEMA,
        example: BOTTOM_EXAMPLE,
        deliver: () => getCryptoBottoms({ fresh }).catch(() => ({ error: 'upstream data unavailable, retry shortly', http: 503 }))
    });
});
app.get('/api/flows/:symbol', (req, res) => {
    const raw = String(req.params.symbol || '').toUpperCase();
    const ok = COINS.includes(raw);
    if (!ok && hasPaymentOrPass(req)) return res.status(404).json({ error: 'unknown symbol', supported: COINS, note: 'no payment was taken' });
    const sym = ok ? raw : SYM_EXAMPLE;
    return handleX402Agent(req, res, {
        url: ok ? `${BASE_URL}/api/flows/${sym}` : `${BASE_URL}/api/flows/{symbol}`, amount: "20000", name: ok ? `GW8 Large-Print Flows + WaveTrend: ${sym}/USD` : 'GW8 Large-Print Flows + WaveTrend: one coin',
        description: `Kraken large-print flows for ${ok ? sym : 'one coin'}/USD: buy versus sell on the last 1000 public trades (one venue, not on-chain) joined to the WaveTrend 4h state. $0.02 USDC. Signal only.`,
        tags: ["kraken flows", "large prints", "crypto flows", "wavetrend", "buy sell"],
        serviceName: "GW8 Kraken Flows",
        routeTemplate: "/api/flows/:symbol",
        pathParams: { symbol: sym },
        example: { symbol: sym, flows: { largePrints: { count: 12, buyUsd: 420000, sellUsd: 180000, netUsd: 240000 }, bias: "large buyers dominant" }, wavetrend: { wt1: -41.2, wt2: -38.9, zone: "neutral" } },
        precheck: async () => ok ? null : { error: 'unknown symbol' },
        deliver: () => getFlows(sym).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});
app.get('/api/brief', async (req, res) => {
    const paying = req.headers['payment-signature'] || req.headers['x-payment'] || req.headers['x-gw8-pass'];
    if (paying) {
        const brief = await getBrief({ maxWaitMs: TEASER_COLD_WAIT_MS });
        if (!brief || brief.error || brief.notReady || !brief.regime || brief.regime.error) {
            const retry = (brief && brief.retryAfter) || 5;
            return res.status(503).set('Retry-After', String(retry)).json({
                error: (brief && brief.error) || 'brief is still warming up, retry shortly',
                retryAfter: retry,
                note: 'no payment was taken'
            });
        }
    }
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/brief`, amount: "20000", name: "GW8 Daily Crypto Brief",
        description: BRIEF_QUOTE,
        tags: ["daily crypto brief", "crypto brief", "crypto market regime", "daily bundle", "wavetrend"],
        serviceName: "GW8 Daily Crypto Brief",
        example: { date: "2026-10-17", builtAt: "2026-10-17T20:05:00.000Z", asOf: "2026-10-17T20:00:00.000Z", bar: "2026-10-17T16:00:00.000Z", barClose: "2026-10-17T20:00:00.000Z", regime: { score: 3, outOf: 4 }, dots: { green: 5, red: 2 }, top10ByDotStrength: [{ name: "LINK", kind: "green", strength: 68.5 }], flowsSummary: [{ symbol: "BTC", bias: "balanced" }] },
        deliver: () => getBrief()
    });
});
app.get('/api/daily', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/daily`, amount: usdAtomic(DAILY_BUNDLE_PRICE_USD), name: "GW8 Daily Bundle",
    serviceName: "GW8 Daily Bundle",
    description: "Daily bundle: the $0.02 crypto brief (refreshed on each closed 4h bar) plus the full crypto market regime (raw check values and rules) in one call. Separate price is $0.03. Free teaser GET /api/brief/teaser shows today's regime and the top 3 coin names. $" + DAILY_BUNDLE_PRICE_USD + " USDC. Signal only.",
    tags: ["daily bundle", "daily crypto brief", "crypto market regime", "brief plus regime", "wavetrend"],
    example: { bundle: true, priceUsd: DAILY_BUNDLE_PRICE_USD, separateUsd: "0.03", brief: { date: "2026-11-18", builtAt: "2026-11-18T20:05:00.000Z", asOf: "2026-11-18T20:00:00.000Z", bar: "2026-11-18T16:00:00.000Z", barClose: "2026-11-18T20:00:00.000Z", regime: { score: 3, outOf: 4 }, dots: { green: 4, red: 1 }, top10ByDotStrength: [{ name: "LINK", kind: "green", strength: 68.5 }], flowsSummary: [{ symbol: "BTC", bias: "balanced" }] }, regime: { score: 3, outOf: 4, checks: { etfInflows: { status: "pass", rule: "3-day ETF flow is positive" } } } },
    deliver: () => getDailyBundle()
}));

app.get('/api/rwa', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/rwa`, amount: "20000", name: "GW8 RWA Feed (tokenized treasuries, credit, stocks)",
    description: "Tokenized RWA data: top real-world-asset protocols by TVL with 1-day and 7-day change, estimated 7-day flows, movers, new listings, yield pools, and top RWA tokens (DefiLlama and CoinGecko). 10-minute cache. $0.02 USDC. Signal only.",
    tags: ["tokenized rwa", "rwa tvl", "real world assets", "defillama", "rwa yields"],
    serviceName: "GW8 Tokenized RWA",
    example: { asOf: "2026-10-18T17:00:00Z", summary: { totalTvlUsd: 12500000000, netChange7dPct: 1.2 }, topProtocolsByTvl: [{ name: "Example RWA", tvlUsd: 1000000000, change7dPct: 1.1 }], yields: { topPoolsByTvl: [{ symbol: "USDY", apyPct: 3.69 }] }, sources: ["https://api.llama.fi/protocols"] },
    deliver: () => getRwa().catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
}));

// Free: source health for the gov feed (no award rows). Registered before the paid route.
app.get('/api/govcontracts/status', async (req, res) => {
    try { res.json(await getGovStatus()); } catch (e) { res.status(503).json({ status: 'unavailable' }); }
});
app.get('/api/govcontracts', (req, res) => {
    const f = { ticker: req.query.ticker ? String(req.query.ticker) : undefined, sector: req.query.sector ? String(req.query.sector) : undefined, q: req.query.q ? String(req.query.q) : undefined };
    const bad = validGovFilters(f);
    if (bad) return res.status(400).json({ error: bad, sectors: GOV_SECTORS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/govcontracts`, amount: "10000", name: "GW8 Federal Contract Feed",
        description: "Government contracts data, not a crypto feed: US federal contract awards from the last 14 days of USAspending to AI, drone, nuclear, robotics, space, quantum, and defense-tech companies, with ticker, amount, agency, date, and award link. Optional ticker, sector, and q filters. Defense awards show on USAspending about 90 days late. $0.01 USDC.",
        tags: ["government contracts", "federal contracts", "usaspending", "procurement", "defense contracts"],
        serviceName: "GW8 Gov Contracts",
        inputProps: { ticker: { type: "string", description: "Optional stock ticker filter, for example PLTR.", example: "PLTR" }, sector: { type: "string", description: "Optional government-contract sector filter.", enum: GOV_SECTORS, example: "ai" }, q: { type: "string", description: "Optional keyword in the recipient, award description, or agency.", example: "NASA" } },
        example: { window: { start: "2026-10-04", end: "2026-10-18" }, count: 1, note: "DoD awards via USAspending lag ~90 days", awards: [{ date: "2026-10-08", recipient: "Example Defense Co", ticker: "BAH", sector: "defense-tech", amountUsd: 1250000, agency: "General Services Administration", link: "https://www.usaspending.gov/award/CONT_AWD_example" }] },
        deliver: () => getGovContracts(f).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});

// Kraken new-listings feed (public REST only). Free status registered before the paid route.
app.get('/api/kraken/listings/status', async (req, res) => { try { res.json(await getKrakenStatus()); } catch { res.status(503).json({ status: 'unavailable' }); } });
app.get('/api/kraken/listings', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/kraken/listings`, amount: "20000", name: "GW8 Kraken New USD Listings",
    description: "Kraken new USD listings from the last 30 days: first-seen date, price, 24h volume, percent change since listing, and WaveTrend 4h state. Public exchange-listing data. $0.02 USDC. Signal only.",
    tags: ["kraken listings", "new listings", "usd pairs", "wavetrend", "exchange listing"],
    serviceName: "GW8 Kraken Listings",
    example: { liveSince: "2026-10-19T00:00:00Z", count: 1, newUsdPairs: [{ pair: "PNT/USD", firstSeenByGw8: null, firstTradeDayOnKraken: "2026-10-08", dateSource: "kraken-first-candle", priceUsd: 0.5, volume24hUsd: 120000, changeSinceListingPct: -12.3, wavetrend4h: { wt1: -40.1, zone: "neutral", dotOnLatestBar: null } }] },
    deliver: getKrakenListings
}));
setTimeout(() => krakenSnapshot().catch(() => {}), 60e3).unref();
setInterval(() => krakenSnapshot().catch(() => {}), 30 * 60e3).unref();

// Crypto rule-change feed (public keyless sources). Free status registered before the paid route.
app.get('/api/rules/status', async (req, res) => { try { res.json(await getRulesStatus()); } catch { res.status(503).json({ status: 'unavailable' }); } });
app.get('/api/rules', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/rules`, amount: "20000", name: "GW8 Crypto Rule-Change Feed (CFTC + SEC)",
    description: "Crypto regulation feed: CFTC and SEC rule changes from the last 90 days, including Federal Register ANPRM, NPRM, final rules, and notices, with RIN, comment deadlines, and stage changes, plus agency press. $0.02 USDC. Signal only.",
    tags: ["crypto regulation", "cftc", "sec rules", "federal register", "rule changes"],
    serviceName: "GW8 Crypto Rule Feed",
    example: { count: 1, openComments: [{ rin: "3038-AF80", agency: "CFTC", docType: "ANPRM", commentDeadline: "2026-12-14" }], rows: [{ date: "2026-10-13", agency: "CFTC", docType: "ANPRM", title: "Regulation Crypto Asset Transactions", rin: "3038-AF80", commentDeadline: "2026-12-14", link: "https://www.federalregister.gov/", stageChange: { from: null, to: "ANPRM" } }] },
    deliver: getRules
}));

// Relative strength + sector scores (Kraken public daily OHLC, our own math). Warmed after boot so the first buyer doesn't wait ~75s.
app.get('/api/rs', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/rs`, amount: "20000", name: "GW8 Relative Strength + Sector Scores (66 Kraken pairs)",
    description: "Crypto relative strength across 66 Kraken USD pairs: 1-week and 1-month percent return, percentile ranks, a 0-100 strength score, leaders, laggards, and sector breadth. 30-minute cache. $0.02 USDC. Signal only.",
    tags: ["relative strength", "crypto sectors", "sector breadth", "kraken", "momentum"],
    serviceName: "GW8 Relative Strength",
    example: { universe: 66, scored: 64, breadth: { pctPositive1m: 41, n: 64 }, leaders: ["ZEC", "HYPE"], sectors: [{ sector: "payments", coins: 6, avgStrength: 68, breadth1mPct: 67, leader: "ZEC" }], coins: [{ symbol: "ZEC", sector: "payments", ret1wPct: 8.1, ret1mPct: 32.5, rank1wPct: 92.2, rank1mPct: 98.4, strength: 96 }] },
    deliver: getRs
}));
setTimeout(() => getRs().catch(() => {}), 3 * 60e3).unref();

// Payment-rail cost check (public keyless reads, 60s cache). Card is a static reference rate.
app.get('/api/rails', (req, res) => {
    const v = validAmount(req.query.amount);
    if (v.error) return res.status(400).json({ error: v.error });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/rails`, amount: "2000", name: "GW8 Payment Rail Check (Base USDC, XRPL, Tempo, Arc, card)",
        description: "Cheapest and fastest payment rail right now for a USD amount (?amount=100): Base USDC (live gas x ETH/USD, ~2s), XRPL RLUSD/XRP (live fee x XRP/USD, ~3-5s), Tempo and Circle Arc (live gas, USD fees, ~1s), card (static 2.9% + $0.30, days). Fee USD/%, settlement time, sources, agent protocols per rail, recommended pick. Dead sources marked unavailable. 60s cache. $0.002 USDC. Signal only.",
        tags: ["payments", "rails", "base", "xrpl", "x402"],
        inputProps: { amount: { type: "number", description: "USD amount used to compare payment-rail fees and speed. Default 100.", example: 100 } },
        outputSchema: RAILS_OUTPUT_SCHEMA,
        example: { amountUsd: 100, recommended: { rail: "xrpl-rlusd-xrp", fastest: "base-usdc" }, rails: [{ rail: "base-usdc", status: "live", feeUsd: 0.00095, feePct: 0.00095, settlement: "~2s" }, { rail: "xrpl-rlusd-xrp", status: "live", feeUsd: 0.000025, feePct: 0.000025, settlement: "~3-5s" }, { rail: "card", status: "static-estimate", feeUsd: 3.2, feePct: 3.2, settlement: "~1-3 business days" }] },
        deliver: () => getRails(v.amount).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});

// Which x402 facilitator and chain for one payment. GET /api/rails stays $0.002.
// Unpaid calls always get the 402, including a bad query. A payment or pass header with a bad query is 400 before verify.
app.get('/api/rails/route', (req, res) => {
    const v = validRouteQuery(req.query);
    if (v.error && hasPaymentOrPass(req)) return res.status(400).json({ error: v.error, note: 'no payment was taken' });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/rails/route`, amount: usdAtomic(RAILS_ROUTE_PRICE_USD), name: ROUTE_SERVICE_NAME,
        description: ROUTE_BLURB,
        tags: ROUTE_TAGS,
        serviceName: ROUTE_SERVICE_NAME,
        routeTemplate: '/api/rails/route',
        inputProps: {
            chain: { type: 'string', description: 'Mainnet chain. Omit and the route chooses.', example: 'base' },
            amount: { type: 'number', description: 'Payment size in USD. Default 1.', example: 1 }
        },
        outputSchema: ROUTE_OUTPUT_SCHEMA,
        example: ROUTE_EXAMPLE,
        precheck: async (r) => { const bad = validRouteQuery(r.query); return bad.error ? { error: bad.error } : null; },
        deliver: () => getFacilitatorRoute(req.query)
    });
});

// EIA weekly on-highway diesel and a per-mile surcharge. Public page, no API key.
app.get('/api/truck/fuel-surcharge', (req, res) => {
    const v = validFuelQuery(req.query);
    if (v.error && hasPaymentOrPass(req)) return res.status(400).json({ error: v.error, note: 'no payment was taken' });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/truck/fuel-surcharge`, amount: usdAtomic(FUEL_SURCHARGE_PRICE_USD), name: FUEL_SERVICE_NAME,
        description: FUEL_BLURB,
        tags: FUEL_TAGS,
        serviceName: FUEL_SERVICE_NAME,
        routeTemplate: '/api/truck/fuel-surcharge',
        inputProps: {
            padd: { type: 'string', description: 'us or a PADD. Default 4 (Rocky Mountain).', example: '4' },
            base: { type: 'number', description: 'Base diesel price, USD per gallon.', example: 5.5 },
            mpg: { type: 'number', description: 'Miles per gallon.', example: 6 }
        },
        outputSchema: FUEL_OUTPUT_SCHEMA,
        example: FUEL_EXAMPLE,
        precheck: async (r) => { const bad = validFuelQuery(r.query); return bad.error ? { error: bad.error } : null; },
        deliver: () => getFuelSurcharge(req.query)
    });
});

// Spend-policy check for AI agents (pure rule evaluation; stateless; no custody, no payment execution).
// Unpaid (no payment / pass header): always the 402 challenge, even for an empty body (proposal 25, x402scan probe).
// With a payment or pass header: a malformed body gets 400 before the payment is verified or a pass call is used,
// so it is never charged. Valid bodies fall through to the paid route below.
app.post('/api/spend/check', (req, res, next) => { if (!hasPaymentOrPass(req)) return next(); const v = validateSpend(req.body); return v.error ? res.status(400).json({ error: v.error, note: 'no payment was taken' }) : next(); });
const spendProduct = (req) => ({
    url: `${BASE_URL}/api/spend/check`, method: "POST", amount: SPEND_PLAN.amount, name: "GW8 Spend-Policy Check (AI agent payments)",
    description: SPEND_CHECK_CHALLENGE,
    tags: ["spend policy", "payment risk", "allow or deny", "agent payment", "x402"],
    serviceName: "GW8 Spend Policy",
    inputProps: {
        payment: { type: "object", description: "Proposed payment: amount, currency, recipient, category, chain, and time.", example: { amount: "420.00", currency: "USDC", chain: "base", recipientId: "acct_acme_supplies", recipientDomain: "acme-supplies.com", merchantCategory: "office-supplies", timestamp: "2026-10-21T15:30:00Z", agentId: "ap-agent-7", memo: "INV-10442" } },
        policy: { type: "object", description: "Buyer spend policy: per-transaction limit, rolling cap, lists, hours, assets, and chains.", example: { currency: "USDC", perTxLimit: "1000", rollingCap: { limit: "5000", spentSoFar: "1200", windowHours: 24 }, blockedCategories: ["gambling", "crypto-exchange"], allowList: ["acme-supplies.com"], allowedHours: { start: "08:00", end: "18:00", timezone: "America/Denver", days: ["mon", "tue", "wed", "thu", "fri"] }, allowedAssets: ["USDC"], allowedChains: ["base"], requireApprovalAbove: "750" } }
    },
    bodyRequired: ["payment", "policy"],
    example: { engine: "gw8-spend-policy/1", decision: "allow", reasons: [], checks: [{ rule: "per_tx_limit", result: "pass", detail: "420 <= per-tx limit 1000" }], remaining: { perTx: "1000", rollingCapBefore: "3800", rollingCapAfter: "3380" }, decisionReceipt: { endpoint: "POST /api/spend/check", accessType: "SPEND_POLICY_DECISION", query: { decision: "allow", requestSha256: "7faa…" }, response_sha256: "…", payload: "eyJ2Ijox…", signature: "base64…", signed: true, alg: "Ed25519", verify_url: "https://micro-saas-agent.onrender.com/api/receipt/verify" } },
    precheck: async (r) => { const v = validateSpend(r.body); return v.error ? { error: v.error } : null; },
    deliver: async () => checkSpend(req.body)
});
app.post('/api/spend/check', (req, res) => handleX402Agent(req, res, spendProduct(req)));
quoteOnlyGet('/api/spend/check', spendProduct);

// Free: is the reputation data source reachable from this server? Fixed probe (no user input), cached 60s, no receipt.
app.get('/api/seller/reputation/status', async (req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json(await getSourceStatus()); });

// x402 seller reputation for AI agents (public Base USDC history via Alchemy when ALCHEMY_API_KEY is set, else keyless
// Blockscout; the key is only read in reputation.js and never returned or logged; stateless; never pays anyone).
// Unpaid: always the 402 challenge (proposal 25). Paid/pass: a malformed body gets 400 before verify / pass use, so it is
// never charged. If the data source is down (or an endpoint-only request has no readable payTo), deliver returns
// {error}: the payment is verified but not settled / the pass call is refunded, so "unknown because no data" is free.
app.post('/api/seller/reputation', (req, res, next) => { if (!hasPaymentOrPass(req)) return next(); const v = validateReputation(req.body); return v.error ? res.status(400).json({ error: v.error, note: 'no payment was taken' }) : next(); });
const reputationProduct = (req) => ({
    url: `${BASE_URL}/api/seller/reputation`, method: "POST", amount: REPUTATION_PLAN.amount, name: "GW8 x402 Seller Reputation (AI agent payments)",
    description: SELLER_REPUTATION_COPY,
    tags: ["seller reputation", "x402 seller", "seller trust", "payment risk", "base"],
    serviceName: "GW8 Seller Reputation",
    inputProps: {
        address: { type: "string", description: "Seller wallet on Base, 0x and 40 hex.", example: "0x1111111111111111111111111111111111111111" },
        endpoint: { type: "string", description: "x402 https URL. payTo is read from its unpaid 402.", example: "https://seller.example/api/data" },
        lookbackDays: { type: "integer", description: "How many days of public USDC history to score, from 1 to 90.", example: 90 }
    },
    example: { engine: "gw8-seller-reputation/1", verdict: "caution", score: 58, components: { distinctBuyers: { value: 4, points: 12, max: 30 }, washShare: { value: 0.1, points: 23, max: 25 }, walletAge: { days: 86, points: 10, max: 15 }, concentration: { topPayerShare: 0.45, points: 14, max: 20 }, volume30d: { organicUsd: 0.6, points: 3, max: 10 } }, reasons: ["only 4 distinct organic paying buyer(s)"], reputationReceipt: { endpoint: "POST /api/seller/reputation", accessType: "SELLER_REPUTATION", query: { verdict: "caution", score: 58, requestSha256: "…", dataSha256: "…" }, signed: true, alg: "Ed25519", verify_url: "https://micro-saas-agent.onrender.com/api/receipt/verify" } },
    precheck: async (r) => { const v = validateReputation(r.body); return v.error ? { error: v.error } : null; },
    deliver: async () => checkSellerReputation(req.body)
});
app.post('/api/seller/reputation', (req, res) => handleX402Agent(req, res, reputationProduct(req)));
quoteOnlyGet('/api/seller/reputation', reputationProduct);

// Should my agent pay this? spend policy + seller reputation -> one verdict and one receipt.
// Unpaid: always the 402 (proposal 25). Paid/pass: validate first (400 before verify / pass use). Seller data unavailable -> deliver {error} -> not settled / pass refunded.
app.post('/api/pay/should-i-pay', (req, res, next) => { if (!hasPaymentOrPass(req)) return next(); const v = validatePayDecision(req.body); return v.error ? res.status(400).json({ error: v.error, note: 'no payment was taken' }) : next(); });
const payDecisionProduct = (req) => ({
    url: `${BASE_URL}/api/pay/should-i-pay`, method: "POST", amount: PAYDECISION_PLAN.amount, name: "GW8 Should-I-Pay (spend policy + seller reputation)",
    description: SHOULD_I_PAY_CHALLENGE,
    tags: ["should I pay", "spend policy", "seller reputation", "payment decision", "x402"],
    serviceName: "GW8 Should I Pay",
    inputProps: {
        payment: { type: "object", description: "Proposed payment: amount, currency, recipient, category, chain, and time.", example: { amount: "0.05", currency: "USDC", chain: "base", recipientId: "0x1111111111111111111111111111111111111111", merchantCategory: "data-api", timestamp: "2026-10-21T15:30:00Z", agentId: "research-agent-1" } },
        policy: { type: "object", description: "Buyer spend policy: limits, rolling cap, lists, hours, assets, and chains.", example: { currency: "USDC", perTxLimit: "1", rollingCap: { limit: "10", spentSoFar: "2.40" }, allowedChains: ["base"], allowedAssets: ["USDC"], requireApprovalAbove: "0.50" } },
        seller: { type: "object", description: "x402 seller to score: Base address and/or https endpoint.", example: { address: "0x1111111111111111111111111111111111111111" } },
        sellerRules: { type: "object", description: "What to do on a caution or unknown seller reputation, and an optional minimum score.", example: { onCaution: "ask_human", onUnknown: "ask_human" } }
    },
    bodyRequired: ["payment", "policy", "seller"],
    example: { engine: "gw8-should-i-pay/1", verdict: "ask_human", reasons: [{ source: "seller_reputation", action: "ask_human", detail: "seller verdict caution (score 58) -> ask_human" }], spend: { decision: "allow" }, seller: { verdict: "caution", score: 58 }, decisionReceipt: { endpoint: "POST /api/pay/should-i-pay", accessType: "PAY_DECISION", query: { verdict: "ask_human", spendDecision: "allow", sellerVerdict: "caution", sellerScore: 58, requestSha256: "…" }, signed: true, alg: "Ed25519", verify_url: "https://micro-saas-agent.onrender.com/api/receipt/verify" } },
    precheck: async (r) => { const v = validatePayDecision(r.body); return v.error ? { error: v.error } : null; },
    deliver: async () => checkShouldIPay(req.body)
});
app.post('/api/pay/should-i-pay', (req, res) => handleX402Agent(req, res, payDecisionProduct(req)));
quoteOnlyGet('/api/pay/should-i-pay', payDecisionProduct);

app.get('/api/value/status', async (req, res) => {
    try { res.json(await getValueStatus()); }
    catch { res.json({ free: true, product: 'value-capture', coverage: [], sourceStatus: { defillama: 'unavailable', krakenTicker: 'unavailable' }, sources: [], disclaimer: 'Rule-based tokenomics data and score. Not investment advice; no trade recommendation.' }); }
});
app.get('/api/value/:symbol/history', (req, res) => {
    const raw = String(req.params.symbol || '').toUpperCase();
    const meta = findCoin(raw);
    const weeks = parseWeeks(req.query.weeks);
    if (hasPaymentOrPass(req)) {
        if (!meta) return res.status(404).json({ error: 'unknown symbol', note: 'no payment was taken' });
        if (weeks.error) return res.status(400).json({ error: weeks.error, note: 'no payment was taken' });
    }
    const sym = meta ? raw : 'BNB';
    const w = weeks.weeks || 12;
    return handleX402Agent(req, res, {
        url: meta && !weeks.error ? `${BASE_URL}/api/value/${sym}/history` : `${BASE_URL}/api/value/{symbol}/history`,
        amount: VALUE_PRICES.historyAtomic, name: 'GW8 Value-Capture History',
        description: 'Value-capture history: weekly tokenomics snapshots for one coin, up to 52 weeks. Rule classes are carried forward; yield is recomputed. $0.07 USDC. Data and scores only.',
        tags: ['value capture history', 'tokenomics', 'weekly score', 'holder yield', 'net supply'],
        serviceName: 'GW8 Value History',
        routeTemplate: '/api/value/:symbol/history', pathParams: { symbol: sym },
        inputProps: { weeks: { type: 'integer', description: 'How many weekly value-capture snapshots to return, from 1 to 52. Default 12.', example: 12 } },
        example: { symbol: sym, name: sym, weeks: 12, snapshots: [{ weekEnding: '2026-11-08', score: 72, grade: 'medium' }], note: 'Rule classes are carried forward. Yield is recomputed.', disclaimer: 'Rule-based tokenomics data and score. Not investment advice.' },
        precheck: async () => !meta ? { error: 'unknown symbol' } : (weeks.error ? { error: weeks.error } : null),
        deliver: () => getValueHistory(sym, w)
    });
});
app.get('/api/value/:symbol', (req, res) => {
    const raw = String(req.params.symbol || '').toUpperCase();
    const meta = findCoin(raw);
    if (!meta && hasPaymentOrPass(req)) return res.status(404).json({ error: 'unknown symbol', note: 'no payment was taken' });
    const sym = meta ? raw : 'BNB';
    return handleX402Agent(req, res, {
        url: meta ? `${BASE_URL}/api/value/${sym}` : `${BASE_URL}/api/value/{symbol}`,
        amount: VALUE_PRICES.oneAtomic, name: meta ? `GW8 Value-Capture: ${sym}` : 'GW8 Value-Capture: one coin',
        description: `Value-capture score for ${meta ? sym : 'one coin'}: net supply, holder yield, usage class, burn-versus-held class, and unlock overhang. Tokenomics data and scores only. $0.015 USDC.`,
        tags: ['value capture', 'tokenomics score', 'holder yield', 'net supply', 'unlock overhang'],
        serviceName: 'GW8 Value Capture',
        routeTemplate: '/api/value/:symbol', pathParams: { symbol: sym },
        example: { symbol: sym, name: sym, score: 72, grade: 'medium', components: { netSupply: { points: 30, pass: true }, holderYield: { points: 25, annualPct: 2.1 } }, unverified: [], disclaimer: 'Rule-based tokenomics data and score. Not investment advice.' },
        precheck: async () => meta ? null : { error: 'unknown symbol' },
        deliver: () => getValueSymbol(sym)
    });
});
app.get('/api/value', (req, res) => {
    const q = parseValueQuery(req.query);
    if (hasPaymentOrPass(req)) {
        if (q.error) return res.status(400).json({ error: q.error, note: 'no payment was taken' });
        if (q.symbols && !q.symbols.some(s => findCoin(s))) return res.status(404).json({ error: 'unknown symbol', unknown: q.symbols, note: 'no payment was taken' });
    }
    const query = q.error ? { sort: 'score', minScore: 0, symbols: null } : q;
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/value`, amount: VALUE_PRICES.batchAtomic, name: 'GW8 Value-Capture Screen',
        description: 'Value-capture screen for up to 25 symbols or the whole covered set. Sort by score, yield, or netSupply90d. Tokenomics data and scores only. $0.03 USDC.',
        tags: ['value capture screen', 'tokenomics', 'holder yield', 'net supply', 'crypto score'],
        serviceName: 'GW8 Value Screen',
        inputProps: { symbols: { type: 'string', description: 'Comma-separated tickers, at most 25. Omit for the covered set.', example: 'BNB,ETH' }, sort: { type: 'string', description: 'Sort the value-capture screen by score, yield, or netSupply90d.', enum: ['score', 'yield', 'netSupply90d'], example: 'score' }, minScore: { type: 'number', description: 'Minimum value-capture score to keep, from 0 to 100.', example: 0 } },
        example: { count: 2, sort: 'score', minScore: 0, rows: [{ symbol: 'BNB', score: 72, grade: 'medium' }], disclaimer: 'Rule-based tokenomics data and score. Not investment advice.' },
        precheck: async () => q.error ? { error: q.error } : null,
        deliver: () => getValueBatch(query)
    });
});
app.get('/api/growth/status', async (req, res) => {
    try { res.json(await getGrowthStatus()); }
    catch { res.json({ free: true, product: 'growth-lane', coverage: [], sourceStatus: { defillamaTvl: 'unavailable' }, sources: [], disclaimer: 'On-chain growth data and rule flags. Not investment advice; no trade recommendation.' }); }
});
app.get('/api/growth/history', (req, res) => {
    const weeks = parseWeeks(req.query.weeks);
    const q = parseGrowthQuery(req.query);
    if (hasPaymentOrPass(req)) {
        if (weeks.error) return res.status(400).json({ error: weeks.error, note: 'no payment was taken' });
        if (q.error) return res.status(q.http || 400).json({ error: q.error, note: 'no payment was taken' });
    }
    const query = q.error ? { kind: 'all', minRulesPassed: 0, triggerOnly: false, minTvlUsd: 50000000, window: '90d' } : q;
    const w = weeks.weeks || 12;
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/growth/history`, amount: GROWTH_PRICES.historyAtomic, name: 'GW8 Growth-Lane History',
        description: 'Growth-lane history: weekly on-chain snapshots and the week each rule first passed. Up to 52 weeks. Window is 90 days. $0.07 USDC. Data and rule flags only.',
        tags: ['growth lane history', 'on-chain growth', 'weekly rules', 'tvl', 'chain fees'],
        serviceName: 'GW8 Growth History',
        inputProps: { weeks: { type: 'integer', description: 'How many weekly growth-lane snapshots to return, from 1 to 52. Default 12.', example: 12 }, kind: { type: 'string', description: 'chain, app, or all.', enum: ['chain', 'app', 'all'], example: 'all' }, minRulesPassed: { type: 'integer', description: 'Minimum growth-lane rules passed, from 0 to 4.', example: 0 }, triggerOnly: { type: 'boolean', description: 'When true, keep rows whose relative-return flag passed.', example: false }, minTvlUsd: { type: 'number', description: 'Minimum TVL in USD. Default 50000000.', example: 50000000 } },
        example: { asOf: '2026-11-16T00:00:00.000Z', window: '90d', weeks: 12, snapshots: [{ weekEnding: '2026-11-08', btcReturn90dPct: 4.2 }], firstFlip: [], disclaimer: 'On-chain growth data and rule flags. Not investment advice.' },
        precheck: async () => (weeks.error || q.error) ? { error: weeks.error || q.error } : null,
        deliver: () => getGrowthHistory(query, w)
    });
});
app.get('/api/growth/:chain', (req, res) => {
    const raw = String(req.params.chain || '');
    const meta = findGrowth(raw);
    if (!meta && hasPaymentOrPass(req)) return res.status(404).json({ error: 'unknown chain', note: 'no payment was taken' });
    const id = meta ? meta.chain : 'solana';
    return handleX402Agent(req, res, {
        url: meta ? `${BASE_URL}/api/growth/${id}` : `${BASE_URL}/api/growth/{chain}`,
        amount: GROWTH_PRICES.oneAtomic, name: meta ? `GW8 Growth-Lane: ${id}` : 'GW8 Growth-Lane: one chain',
        description: `Growth-lane setup for ${meta ? id : 'one chain or app'}: stablecoin change, fees, TVL versus price, and the relative-return flag. On-chain data and rule flags only. $0.015 USDC.`,
        tags: ['growth lane', 'on-chain growth', 'stablecoins', 'chain fees', 'tvl'],
        serviceName: 'GW8 Growth Lane',
        routeTemplate: '/api/growth/:chain', pathParams: { chain: id },
        example: { chain: id, state: 'early', rulesPassed: 2, rules: { stables: { pass: true }, fees: { pass: false }, tvl: { pass: true }, vsBtc: { pass: false } }, window: '90d', disclaimer: 'On-chain growth data and rule flags. Not investment advice.' },
        precheck: async () => meta ? null : { error: 'unknown chain' },
        deliver: () => getGrowthOne(id)
    });
});
app.get('/api/growth', (req, res) => {
    const q = parseGrowthQuery(req.query);
    if (q.error && hasPaymentOrPass(req)) return res.status(q.http || 400).json({ error: q.error, note: 'no payment was taken' });
    const query = q.error ? { kind: 'all', minRulesPassed: 0, triggerOnly: false, minTvlUsd: 50000000, window: '90d' } : q;
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/growth`, amount: GROWTH_PRICES.listAtomic, name: 'GW8 Growth-Lane Screen',
        description: 'Growth-lane screen across covered chains and apps. Filters: kind, minRulesPassed, triggerOnly, minTvlUsd. Window is 90 days. On-chain data and rule flags only. $0.03 USDC.',
        tags: ['growth lane screen', 'on-chain growth', 'chain screen', 'tvl', 'chain fees'],
        serviceName: 'GW8 Growth Screen',
        inputProps: { kind: { type: 'string', description: 'chain, app, or all.', enum: ['chain', 'app', 'all'], example: 'all' }, minRulesPassed: { type: 'integer', description: 'Minimum growth-lane rules passed, from 0 to 4.', example: 0 }, triggerOnly: { type: 'boolean', description: 'When true, keep rows whose relative-return flag passed.', example: false }, minTvlUsd: { type: 'number', description: 'Minimum TVL in USD. Default 50000000.', example: 50000000 }, window: { type: 'string', description: 'Lookback. 90d.', example: '90d' } },
        example: { asOf: '2026-11-16T00:00:00.000Z', window: '90d', count: 1, rows: [{ chain: 'solana', state: 'early', rulesPassed: 2 }], minTvlUsd: 50000000, disclaimer: 'On-chain growth data and rule flags. Not investment advice.' },
        precheck: async () => q.error ? { error: q.error } : null,
        deliver: () => getGrowthList(query)
    });
});

initMcpPayments({ facilitatorUrl: CDP_FACILITATOR_URL, payTo: VAULT_ADDRESS, asset: USDC_BASE_ADDRESS, makeJwt: generateCdpJwt, onPaid: (tool, payer) => { recordMcpPaid(tool, payer); recordMcpSale(tool); } })
    .then(st => console.log('[mcp-pay] mode:', st.mode, st.reason ? `(${st.reason})` : ''))
    .catch(() => console.log('[mcp-pay] mode: pointer (init error)'));
// Background only. Listen is not waiting on this build. NODE_ENV=test and BRIEF_PREWARM=off skip it.
startBriefPrewarm();
app.listen(PORT, () => {
    console.log(`GW8 Capital x402 v2 Gateway online on port ${PORT}`);
});
