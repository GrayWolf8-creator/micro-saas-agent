
import express from 'express';
import path from 'path';
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
import { getVerdict, validVerdictInput, VERDICT_CHAINS, VERDICT_RULES, getFlows, getBrief, getBriefTeaser, signResponses, publicKeyInfo } from './upgrades.js';
import { getRwa } from './rwa.js';
import { mintPass, usePass, refundPass, revokePass, PASS_PLAN, tail } from './pass.js';
import { getTrack, renderTrack, logDots } from './track.js';
import { getKrakenListings, getKrakenStatus, snapshot as krakenSnapshot } from './kraken.js';
import { getRules, getRulesStatus } from './rules.js';
import { getRs } from './rs.js';
import { getRails, validAmount } from './rails.js';
import { getGovContracts, validGovFilters, GOV_SECTORS, getGovStatus } from './gov.js';
import { WEEKLY_PLANS, validateWeekly, createWeekly, cancelWeekly, getWeeklyStatus, weeklyTick } from './weekly.js';
import { statsMiddleware, getStats, renderStatsHtml, renderStatsMd, recordMcpPaid } from './stats.js';
import { funnel, receiptHeaders, receiptKeyInfo, replayKey, once, TRUST_LINE, RECEIPT_KEY_PATH, buildReceipt, verifyReceipt, VERIFY_PATH } from './trust.js';
import { payerFrom } from './buyers.js';
import { checkSpend, validateSpend, SPEND_PLAN } from './spend.js';
import { checkSellerReputation, validateReputation, REPUTATION_PLAN, getSourceStatus } from './reputation.js';
import { checkShouldIPay, validatePayDecision, PAYDECISION_PLAN } from './paydecision.js';
import { withCategory, categoryOf, isFeatured } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Per-endpoint request tallies (402 quotes vs paid 2xx etc). Free, no PII. Before x402 handlers.
app.use(statsMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const VAULT_ADDRESS = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
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
    const inProps = o.inputProps || {};
    const exampleFromProps = (props) => Object.fromEntries(Object.entries(props).flatMap(([k, v]) => {
        if (v && Object.prototype.hasOwnProperty.call(v, 'example')) return [[k, v.example]];
        if (v && Array.isArray(v.enum) && v.enum.length) return [[k, v.enum[0]]];
        return [];
    }));
    const queryExample = exampleFromProps(inProps);
    const bodyExample = (o.body !== undefined) ? o.body : exampleFromProps(inProps);

    const description = withCategory(o.url ? new URL(o.url).pathname : '/api/agent', o.description || (
        'Crypto market regime (Stage 1 score 0-4: ETF flows, BTC support, alt breadth, Fear & Greed) plus WaveTrend oversold/overbought band dots on 66 Kraken 4h USD pairs. ' +
        'Use when an agent needs a compact risk-on/risk-off + oversold scan. $0.02 USDC on Base. Free sample: GET /api/sample. Signal only, not financial advice.'
    ));
    const url = o.url || RESOURCE_URL;
    const amount = o.amount || '20000';
    const tags = (o.tags || ['crypto', 'wavetrend', 'market-regime', 'kraken', 'x402']).slice(0, 5);
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
    } else if (Object.keys(queryExample).length) {
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
    } else if (Object.keys(inProps).length) {
        inputSchemaProps.queryParams = { type: 'object', properties: inProps, additionalProperties: false };
    }
    if (o.pathParams) inputSchemaProps.pathParams = { type: 'object', additionalProperties: { type: 'string' } };

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
                output: { type: 'object', properties: { type: { type: 'string' }, example: {} }, required: ['type'] }
            },
            required: ['input']
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
            serviceName: 'GW8 Signal API',
            tags
        },
        accepts: [{
            scheme: 'exact',
            network: 'eip155:8453',
            amount,
            asset: USDC_BASE_ADDRESS,
            payTo: VAULT_ADDRESS,
            maxTimeoutSeconds: 300,
            extra: { name: 'USD Coin', version: '2' }
        }],
        extensions: { bazaar }
    };
}

// 1. Root Landing Page
app.get('/', (req, res) => {
    res.json({
        service: "GW8 Signal API",
        status: "ONLINE",
        protocol: "x402 v2",
        network: "eip155:8453",
        asset: "USDC",
        about: "Pay-per-call tools for AI agents: should-I-pay decisions (spend policy + x402 seller reputation), payment risk checks, token verdicts, payment-rail costs, and crypto market data (regime, WaveTrend dots, relative strength). Signed receipts. Signal only, not financial advice.",
        humans: { pay: "/pay.html", track: "/track" },
        startHere: { agentGuide: "/agents.md", freeTeaser: "/api/brief/teaser", freeSample: "/api/sample", agentDocs: "/llms.txt", openapi: "/openapi.json", discovery: "/.well-known/x402", payPage: "/pay.html" },
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
                    { path: "/api/agent", method: "POST", priceUsd: "0.02" },
                    { path: "/api/brief", priceUsd: "0.02" },
                    { path: "/api/history", priceUsd: "0.05" },
                    { path: "/api/flows/{symbol}", priceUsd: "0.02" },
                    { path: "/api/kraken/listings", priceUsd: "0.02" },
                    { path: "/api/rs", priceUsd: "0.02" },
                    { path: "/api/rails", priceUsd: "0.002" },
                    { path: "/api/verdict/{chain}/{address}", priceUsd: "0.01" }
                ]
            },
            agentPayments: {
                paid: [
                    { path: "/api/pay/should-i-pay", method: "POST", priceUsd: PAYDECISION_PLAN.priceUsd, note: "one call: spend policy + seller reputation -> pay / dont_pay / ask_human + one signed receipt" },
                    { path: "/api/spend/check", method: "POST", priceUsd: SPEND_PLAN.priceUsd, note: "spend-policy check: allow / deny / needs_approval + signed decision receipt" },
                    { path: "/api/seller/reputation", method: "POST", priceUsd: REPUTATION_PLAN.priceUsd, note: "x402 seller reputation: 0-100 score + trusted / caution / avoid / unknown from public Base USDC history + signed receipt" }
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
        free: { teaser: "/api/brief/teaser", sample: "/api/sample", trackRecord: "/track", trackJson: "/api/track", stats: "/api/stats", statsHtml: "/stats.html", proofPubkey: "/api/proof/pubkey", receiptKey: RECEIPT_KEY_PATH, receiptVerify: VERIFY_PATH, sellerReputationStatus: "/api/seller/reputation/status" },
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
app.get('/llms.txt', (req, res) => {
    res.sendFile(path.join(__dirname, 'llms.txt'));
});
app.get('/agents.md', (req, res) => {
    res.type('text/markdown; charset=utf-8').sendFile(path.join(__dirname, 'agents.md'));
});

// Alias of /.well-known/x402 (x402scan fan-out). Not the proposed origin-manifest format.
app.get(['/.well-known/x402.json', '/well-known/x402.json'], (req, res) => {
    res.json(discoveryFanout());
});

// x402scan / AgentCash discovery: OpenAPI-first, plus /.well-known/x402 fan-out

function discoveryFanout() {
    return {
        version: 1,
        resources: PAID.map(p => `https://micro-saas-agent.onrender.com${p.ex || p.path.replace('{symbol}', 'BTC')}`),
        instructions: `OpenAPI-first discovery at /openapi.json. Agent docs at /llms.txt. Free sample at /api/sample. Unpaid calls return 402 with PAYMENT-REQUIRED (x402 v2, USDC on Base). ${TRUST_LINE} Receipt key: ${RECEIPT_KEY_PATH}. Best value: POST /api/pass/day ($1.00, 24h). Signal only, not financial advice. CDP Bazaar indexes a route after the first successful facilitator settlement for that resource.`,
        openapi: 'https://micro-saas-agent.onrender.com/openapi.json',
        llms: 'https://micro-saas-agent.onrender.com/llms.txt'
    };
}

const RAW_PAID = [
    { path: '/api/agent', method: 'post', price: '0.02', summary: 'Full crypto market regime + WaveTrend band-dot snapshot (66 Kraken 4h pairs). Use for a one-shot risk-on/risk-off + oversold scan. $0.02.' },
    { path: '/api/history', method: 'get', price: '0.05', summary: 'Simulated 90-day WaveTrend band-dot hit-rate backtest (+4h/+24h/+3d). Optional ?pair=BTC. Past performance is not indicative of future results. $0.05.', query: { pair: { type: 'string', description: 'Optional coin symbol, e.g. BTC' } } },
    { path: '/api/regime', method: 'get', price: '0.01', summary: 'Stage 1 crypto market regime check detail (ETF flows, BTC support, alt breadth, Fear & Greed). $0.01.' },
    { path: '/api/dots', method: 'get', price: '0.01', summary: 'Current WaveTrend oversold/overbought band dots across 66 Kraken 4h USD pairs. $0.01.' },
    { path: '/api/coin/{symbol}', method: 'get', price: '0.002', summary: 'WaveTrend 4h snapshot for one coin (cheapest call). $0.002.', pathParam: true, ex: '/api/coin/BTC' },
    { path: '/api/verdict/{chain}/{address}', method: 'get', price: '0.01', summary: 'Token safety verdict 0-100 (safe/caution/danger) from GoPlus + DexScreener. Automated screen, not a guarantee. $0.01.', params: { chain: { type: 'string', enum: Object.keys(VERDICT_CHAINS) }, address: { type: 'string', description: 'Token contract (0x...) or Solana mint' } }, ex: '/api/verdict/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { path: '/api/flows/{symbol}', method: 'get', price: '0.02', summary: 'Kraken large-print buy/sell flow summary joined with WaveTrend 4h state (single venue, not on-chain). $0.02.', pathParam: true, ex: '/api/flows/BTC' },
    { path: '/api/brief', method: 'get', price: '0.02', summary: 'Once-per-day (Mountain Time) crypto brief: regime, WaveTrend dot counts, top coins, BTC/ETH/SOL flows. Free teaser: /api/brief/teaser. $0.02.' },
    { path: '/api/rwa', method: 'get', price: '0.02', summary: 'Tokenized RWA flows: protocol TVL, 7d change/estimated flows, movers, yields, top RWA tokens (DefiLlama + CoinGecko). $0.02.' },
    { path: '/api/govcontracts', method: 'get', price: '0.01', summary: 'Federal contract awards (14-day USAspending actions) to AI/drone/nuclear/robotics/space/quantum/defense-tech. DoD awards ~90 days late via USAspending. $0.01.', query: { ticker: { type: 'string', description: 'Optional ticker, e.g. PLTR' }, sector: { type: 'string', enum: GOV_SECTORS }, q: { type: 'string', description: 'Optional keyword in recipient/description/agency' } } },
    { path: '/api/kraken/listings', method: 'get', price: '0.02', summary: 'Kraken new USD listings (last 30 days) with price, volume, % since listing, and WaveTrend 4h state. $0.02.' },
    { path: '/api/rules', method: 'get', price: '0.02', summary: 'CFTC + SEC crypto rule-change feed (90 days): ANPRM/NPRM/final/notice/press, RIN, comment deadlines. $0.02.' },
    { path: '/api/rs', method: 'get', price: '0.02', summary: 'Relative strength: 1w/1m % return, percentile ranks and 0-100 strength score for 66 Kraken USD pairs, plus sector scores and breadth (L1, L2, DeFi, RWA, oracles/infra, payments, AI, memes). $0.02.' },
    { path: '/api/rails', method: 'get', price: '0.002', summary: 'Cheapest/fastest payment rail right now for a USD amount: Base USDC, XRPL, Tempo, Arc (live fees) vs card (static estimate), with agent-protocol support per rail, with fee USD/%, settlement time and a recommended pick. Optional ?amount=100. $0.002.', query: { amount: { type: 'number', description: 'USD amount, default 100' } } },
    { path: '/api/pay/should-i-pay', method: 'post', price: PAYDECISION_PLAN.priceUsd, summary: `Should my agent pay this? One call runs the spend-policy check (your limits, caps, categories, lists, hours) AND the x402 seller reputation check (public Base USDC history) and returns one verdict pay / dont_pay / ask_human, the reasons, both sub-results and one signed receipt. Deterministic; stateless; never pays anyone. Free when the seller data source is down. $${PAYDECISION_PLAN.priceUsd}.`, body: { payment: { type: 'object', description: 'as in /api/spend/check' }, policy: { type: 'object', description: 'as in /api/spend/check' }, seller: { type: 'object', description: '{address (Base 0x...), endpoint (x402 https URL), lookbackDays}' }, sellerRules: { type: 'object', description: 'optional {onCaution, onUnknown: pay|ask_human|dont_pay (default ask_human), minScore 0-100}' } }, required: ['payment', 'policy', 'seller'] },
    { path: '/api/spend/check', method: 'post', price: SPEND_PLAN.priceUsd, summary: `Spend-policy check for AI agents: POST a proposed payment + the buyer's rules (per-tx limit, rolling cap with your spent-so-far, categories, allow/deny lists, hours+timezone, assets/chains, human-approval threshold). Returns allow / deny / needs_approval, which rules fired, and a signed decision receipt. Stateless, deterministic; not custody, does not move money. $${SPEND_PLAN.priceUsd}.`, body: { payment: { type: 'object', description: 'amount (decimal string), currency, recipientId and/or recipientDomain, merchantCategory, chain, timestamp (ISO), agentId, memo' }, policy: { type: 'object', description: 'currency, perTxLimit, rollingCap {limit, spentSoFar, windowHours}, allowedCategories, blockedCategories, allowList, denyList, onUnlisted, allowedHours {start, end, timezone, days}, allowedAssets, allowedChains, requireApprovalAbove' } }, required: ['payment', 'policy'] },
    { path: '/api/seller/reputation', method: 'post', price: REPUTATION_PLAN.priceUsd, summary: `x402 seller reputation for AI agents: before paying a seller, POST its Base wallet and/or x402 endpoint URL. Reads public USDC (Base) transfer history (Alchemy Transfers API, or keyless Blockscout as fallback when no key is configured) and returns a 0-100 score, verdict trusted / caution / avoid / unknown, components (distinct paying buyers, wash/self-dealing share, wallet age, top-payer concentration, 30-day organic volume), reasons and a signed receipt. Deterministic formula; stateless; never pays anyone. $${REPUTATION_PLAN.priceUsd}.`, body: { address: { type: 'string', description: 'seller wallet on Base (0x...)' }, endpoint: { type: 'string', format: 'uri', description: 'x402 https URL; payTo is read from its unpaid 402 challenge' }, lookbackDays: { type: 'integer', minimum: 1, maximum: 90, default: 90 } } },
    { path: '/api/pass/day', method: 'post', price: PASS_PLAN.priceUsd, summary: `Day pass: ${PASS_PLAN.hours}h access to paid data endpoints via X-GW8-Pass (excludes alert subscribe). Fair use ${PASS_PLAN.dailyCap}/day, ${PASS_PLAN.perMinute}/min. $1.00.` },
    ...Object.values(WEEKLY_PLANS).map(p => ({ path: p.path, method: 'post', price: p.priceUsd, summary: `Weekly Monday brief webhook (${p.weeks} issues): regime, top WaveTrend dots, 7d hit rates, RWA, federal contracts (DoD ~90d lag). $${p.priceUsd}.`, body: { webhookUrl: { type: 'string', format: 'uri', description: 'public https URL' } }, required: ['webhookUrl'] })),
    { path: '/api/alerts/subscribe', method: 'post', price: ALERT_PLAN.priceUsd, summary: `Webhook alerts for NEW green WaveTrend band dots (${ALERT_PLAN.days} days or ${ALERT_PLAN.maxAlerts} alerts), HMAC-signed. $0.50.`, body: { webhookUrl: { type: 'string', format: 'uri', description: 'public https URL' }, filter: { type: 'string', enum: ['outer', 'inner', 'all'], default: 'outer' }, pairs: { type: 'array', items: { type: 'string' }, description: 'optional coin symbols, default all 66' } }, required: ['webhookUrl'] }
];
const PAID = RAW_PAID.map(p => ({ ...p, summary: withCategory(p.path, p.summary), category: categoryOf(p.path), featured: isFeatured(p.path) }));
function openApiDoc() {
    const paths = {};
    for (const p of PAID) {
        const parameters = [];
        if (p.pathParam) parameters.push({ name: 'symbol', in: 'path', required: true, schema: { type: 'string', enum: COINS } });
        for (const [name, schema] of Object.entries(p.params || {})) parameters.push({ name, in: 'path', required: true, schema });
        for (const [name, schema] of Object.entries(p.query || {})) parameters.push({ name, in: 'query', required: false, schema });
        paths[p.path] = { [p.method]: {
            operationId: p.path.replace(/[^a-z]/gi, '_'),
            summary: p.summary,
            tags: [p.category, ...(p.featured ? [] : ['not-featured'])].filter(Boolean),
            description: p.summary,
            security: [],
            ...(parameters.length ? { parameters } : {}),
            ...(p.method === 'post' ? { requestBody: { required: !!p.required, content: { 'application/json': { schema: { type: 'object', properties: p.body || {}, ...(p.required ? { required: p.required } : {}) } } } } } : {}),
            'x-payment-info': { protocols: [{ x402: {} }], price: { mode: 'fixed', currency: 'USD', amount: p.price } },
            responses: {
                '200': { description: 'Signal JSON (signal only, not financial advice)', content: { 'application/json': { schema: { type: 'object' } } } },
                '402': { description: `Payment required: ${p.price} USDC on Base (eip155:8453) via x402 v2. Free teaser: /api/brief/teaser. Best value: POST /api/pass/day. ${TRUST_LINE}` }
            }
        } };
    }
    paths['/api/proof/pubkey'] = { get: { operationId: 'proof_pubkey', summary: 'Free: Ed25519 public key used to sign paid responses (X-GW8-Signature, X-GW8-Signed-At, X-GW8-Body-SHA256)', security: [], responses: { '200': { description: 'Public key JSON' } } } };
    paths[VERIFY_PATH] = { get: { operationId: 'receipt_verify', summary: 'Free: verify a paid-call receipt signature (Ed25519). Query payload (receipt.payload or X-GW8-Receipt) and signature (URL-encoded base64).', security: [], parameters: [{ name: 'payload', in: 'query', required: true, schema: { type: 'string' } }, { name: 'signature', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{valid, fields, reason?}' } } },
        post: { operationId: 'receipt_verify_post', summary: 'Free: verify a receipt; body {payload, signature, data?} or {receipt, data?}. dataMatches checks response_sha256 against data.', security: [], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: '{valid, dataMatches?, fields}' } } } };
    paths[RECEIPT_KEY_PATH] = { get: { operationId: 'receipt_key', summary: 'Free: Ed25519 public key + format for verifying X-GW8-Receipt / X-GW8-Receipt-Signature on paid responses', security: [], responses: { '200': { description: 'Key JSON' } } } };
    paths['/api/seller/reputation/status'] = { get: { operationId: 'seller_reputation_status', summary: 'Free: can the seller-reputation data source (alchemy or blockscout, Base) be reached right now? {source, keyed, reachable, http_status, latency_ms, checked_at, cached}. One fixed tiny probe, cached 60s; no input, no receipt.', security: [], responses: { '200': { description: 'Status JSON' } } } };
    paths['/api/govcontracts/status'] = { get: { operationId: 'govcontracts_status', summary: 'Free: gov-contract feed source health (sourceStatus, asOf, dodAnnouncementDays, dodAwardsParsed, count; no rows)', security: [], responses: { '200': { description: 'Status JSON' } } } };
    paths['/api/track'] = { get: { operationId: 'track', summary: 'Free: honest track record of band-dot signals (backtest simulated vs live-logged, hit rates 1d/7d/30d incl. misses). HTML at /track', security: [], responses: { '200': { description: 'Track JSON' } } } };
    paths['/api/sample'] = { get: { operationId: 'sample', summary: 'Free live sample (regime statuses + core WaveTrend values)', security: [], responses: { '200': { description: 'Sample JSON' } } } };
    paths['/api/brief/teaser'] = { get: { operationId: 'brief_teaser', summary: 'Free: partial live brief — regime score, green/red counts, top 3 dots (symbol+band only), simulated 7d hit-rate headline; upsells full brief/dots/agent', security: [], responses: { '200': { description: 'Teaser JSON' } } } };
    paths['/api/stats'] = { get: { operationId: 'stats', summary: 'Free: per-endpoint request tallies (402 quotes, paid 2xx, 404, 5xx) for the last 1-30 Mountain Time days, plus audience split (known bots vs likely buyers, unique/returning payers by anonymized id). No IPs or PII. HTML at /stats.html; ?format=md for markdown', security: [], parameters: [
        { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 30, default: 1 } },
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'md'], default: 'json' } }
    ], responses: { '200': { description: 'Stats JSON or markdown' } } } };
    return {
        openapi: '3.1.0',
        info: { title: 'GW8 Crypto Regime + WaveTrend Signal API', version: '1.2.0', contact: { url: 'https://github.com/GrayWolf8-creator/micro-saas-agent' },
            description: 'Pay-per-call tools for AI agents via x402 (USDC on Base): should-I-pay decisions (spend policy + seller reputation in one call), spend-policy risk checks, x402 seller reputation verdicts, token safety verdicts, payment-rail cost checks, and crypto market data (regime, WaveTrend band dots, relative strength, flows, simulated hit-rate backtests). Agent guide: /agents.md. No charge on failure (settle only after data is ready), signed receipts, safe retries. Signal only, no trading, not financial advice.',
            'x-guidance': 'Start free: GET /agents.md (when to use each call, examples), GET /api/brief/teaser, GET /api/sample, GET /api/seller/reputation/status, GET /llms.txt, GET /openapi.json, GET /.well-known/x402. Humans: /pay.html. Agent payments (risk checks before paying): POST /api/pay/should-i-pay ($0.02, spend policy + seller reputation -> pay / dont_pay / ask_human, one signed receipt), POST /api/spend/check ($0.02, allow/deny/needs_approval against the buyer policy), POST /api/seller/reputation ($0.01, 0-100 score + trusted/caution/avoid/unknown for an x402 seller). Verdicts: GET /api/verdict/{chain}/{address} ($0.01, token safety). Payment rails: GET /api/rails ($0.002). Market data: GET /api/coin/{symbol} ($0.002), GET /api/regime ($0.01), GET /api/dots ($0.01), POST /api/agent ($0.02), GET /api/brief ($0.02), GET /api/rs ($0.02), GET /api/flows/{symbol} ($0.02), GET /api/kraken/listings ($0.02), GET /api/history ($0.05). Access: POST /api/pass/day ($1.00), POST /api/brief/weekly/subscribe ($0.25), POST /api/alerts/subscribe ($0.50). Pay by retrying with PAYMENT-SIGNATURE from the 402 challenge. No charge on failure; paid responses carry a signed X-GW8-Receipt (key: /.well-known/gw8-receipt-key); resending the same PAYMENT-SIGNATURE within 15 min returns the same response without a second charge.' },
        servers: [{ url: 'https://micro-saas-agent.onrender.com' }],
        paths
    };
}
app.get(['/favicon.ico', '/favicon.svg'], (req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b1220"/><path d="M8 40 Q20 10 32 32 T56 24" stroke="#22c55e" stroke-width="6" fill="none"/></svg>'));
app.get('/openapi.json', (req, res) => res.json(openApiDoc()));
app.get('/.well-known/x402', (req, res) => res.json(discoveryFanout()));
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
    const m = new McpServer({ name: 'gw8-crypto-signal', version: '1.2.0' });
    const txt = mcpOk;
    m.registerTool('get_sample', { title: 'Free live sample', description: 'Free: Stage 1 regime statuses, core WaveTrend 4h values (BTC/ETH/SOL/LINK/XRP) and band-dot count. Signal only, not financial advice.', inputSchema: {} },
        async () => { try { return txt(await buildSample()); } catch (e) { return mcpErr('upstream data unavailable, retry shortly'); } });
    m.registerTool('get_brief_teaser', { title: 'Free brief teaser', description: 'Free partial live brief: regime score, green/red counts, top 3 dots (symbol+band only), simulated 7d hit-rate headline. Upsells paid /api/brief ($0.02), /api/dots ($0.01), /api/agent ($0.02).', inputSchema: {} },
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
        const pointer = async (a) => txt({ paymentRequired: true, protocol: 'x402 v2', method, url: ORIGIN + build(a), priceUsd: price, network: 'eip155:8453', howTo: 'Request the URL; on 402, sign the PAYMENT-REQUIRED challenge and retry with PAYMENT-SIGNATURE (e.g. wrapFetchWithPayment from @x402/fetch).', ...funnel(ORIGIN + path, { passUsd: PASS_PLAN.priceUsd, passHours: PASS_PLAN.hours, passCap: PASS_PLAN.dailyCap, noPass: !!opts.noPass }).body });
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
    await paidTool('get_token_verdict', 'Token safety verdict', '/api/verdict/{chain}/{address}', 'GET', '0.01', 'Is this token safe? Score 0-100, safe/caution/danger, reasons, sources (GoPlus + DexScreener, fixed rules).', { chain: z.enum(Object.keys(VERDICT_CHAINS)), address: z.string() }, a => `/api/verdict/${a.chain}/${a.address}`,
        a => getVerdict(a.chain, a.address), a => validVerdictInput(String(a.chain).toLowerCase(), String(a.address)) || null);
    await paidTool('get_flows', 'Large-print flows + dot state', '/api/flows/{symbol}', 'GET', '0.02', 'Kraken large-print buy/sell summary (single venue, not on-chain) joined with WaveTrend 4h state.', { symbol: z.enum(COINS) }, a => `/api/flows/${a.symbol}`, a => getFlows(a.symbol));
    await paidTool('get_rwa_feed', 'RWA feed', '/api/rwa', 'GET', '0.02', 'Real-world assets on-chain (tokenized treasuries, credit, stocks): top RWA protocols by TVL, 7d change + estimated flows, movers, new launches, yields, top RWA tokens by market cap, with sources and timestamp.', {}, undefined, () => getRwa());
    await paidTool('get_gov_contracts', 'Federal contract feed', '/api/govcontracts', 'GET', '0.01', 'Recent (14-day) US federal contract actions to AI, drone, nuclear, robotics, space, quantum and defense-tech companies (USAspending.gov), with tickers, amount, agency, date, description, award link. Optional ticker / sector / q filters. NOTE: the Department of War daily announcements source is currently blocked from our host (sourceStatus.dodAnnouncements=unavailable; check free GET /api/govcontracts/status), so DoD awards currently appear only via USAspending with a ~90-day lag.', { ticker: z.string().regex(/^[A-Za-z.]{1,6}$/).optional(), sector: z.enum(GOV_SECTORS).optional(), q: z.string().max(60).optional() },
        a => { const p = new URLSearchParams(); for (const k of ['ticker', 'sector', 'q']) if (a[k]) p.set(k, a[k]); const qs = p.toString(); return '/api/govcontracts' + (qs ? '?' + qs : ''); }, a => getGovContracts(a));
    await paidTool('get_kraken_listings', 'Kraken new USD listings', '/api/kraken/listings', 'GET', '0.02', 'New Kraken USD pairs from the last 30 days: first-seen date (our snapshot, or first Kraken daily candle for pairs older than our snapshots), price, 24h volume, % change since listing, WaveTrend 4h dot state, plus Kraken blog listing posts.', {}, undefined, () => getKrakenListings());
    await paidTool('get_crypto_rules', 'Crypto rule-change feed (CFTC + SEC)', '/api/rules', 'GET', '0.02', 'CFTC and SEC crypto / digital-asset / stablecoin / tokenization rulemaking from the last 90 days: Federal Register docs (ANPRM/NPRM/final/notice) with RIN, comment deadline, stage-change flag and Unified Agenda presence, plus agency press releases. Each source labeled ok/unavailable; no stale fill.', {}, undefined, () => getRules());
    await paidTool('get_relative_strength', 'Relative strength + sector scores', '/api/rs', 'GET', '0.02', 'Relative strength across 66 Kraken USD pairs: 1-week and 1-month % return, percentile ranks, 0-100 strength score (60% 1m rank + 40% 1w rank), leaders/laggards, and sector scores with breadth (% of coins with a positive 1m return).', {}, undefined, () => getRs());
    await paidTool('get_payment_rails', 'Cheapest payment rail now', '/api/rails', 'GET', '0.002', 'Which payment rail is cheapest and fastest right now for a USD amount: Base USDC (live gas x ETH/USD), XRPL (live fee x XRP/USD), Tempo and Circle Arc (live gas, USD-denominated) and card (static 2.9% + $0.30 estimate), with documented agent protocols (x402, MPP, card networks) per rail. Fee USD and %, settlement time, data timestamp, sources and a recommended pick. Arg amount (USD, default 100).', { amount: z.number().positive().max(1e7).optional() },
        a => a.amount ? `/api/rails?amount=${a.amount}` : '/api/rails', a => getRails(a.amount || 100));
    const spendSchema = {
        payment: z.object({ amount: z.union([z.string(), z.number()]), currency: z.string(), recipientId: z.string().optional(), recipientDomain: z.string().optional(), merchantCategory: z.string().optional(), chain: z.string().optional(), timestamp: z.string().optional(), agentId: z.string().optional(), memo: z.string().optional() }).passthrough(),
        policy: z.object({}).passthrough().describe('currency, perTxLimit, rollingCap {limit, spentSoFar, windowHours}, allowedCategories, blockedCategories, allowList, denyList, onUnlisted (deny|needs_approval), allowedHours {start, end, timezone, days}, allowedAssets, allowedChains, requireApprovalAbove')
    };
    const spendBody = a => ({ payment: a.payment, policy: a.policy });
    await paidTool('check_spend_policy', 'Spend-policy check (allow / deny / needs_approval)', '/api/spend/check', 'POST', SPEND_PLAN.priceUsd, "Before an agent pays: check a proposed payment against the buyer's rules (per-tx limit, rolling cap with spent-so-far, merchant categories, allow/deny lists, allowed hours + timezone, assets/chains, human-approval threshold). Returns decision, the rules that fired, every check, and a signed decision receipt. Stateless, deterministic; not custody, does not execute payments.",
        spendSchema, undefined, a => checkSpend(spendBody(a)), a => validateSpend(spendBody(a)).error || null);
    const repBody = a => ({ address: a.address, endpoint: a.endpoint, lookbackDays: a.lookbackDays });
    await paidTool('check_seller_reputation', 'x402 seller reputation (trusted / caution / avoid / unknown)', '/api/seller/reputation', 'POST', REPUTATION_PLAN.priceUsd, "Before an agent pays an x402 seller: score the seller's Base wallet (or the payTo read from its endpoint's 402 challenge) 0-100 from public USDC transfer history: distinct paying buyers, wash/self-dealing share (self-transfers, round-trips), wallet age, top-payer concentration, 30-day organic volume. Returns verdict, components, reasons and a signed receipt. Deterministic; stateless; never pays anyone. Give address and/or endpoint.",
        { address: z.string().optional().describe('seller wallet on Base, 0x...'), endpoint: z.string().optional().describe('x402 https endpoint URL'), lookbackDays: z.number().int().min(1).max(90).optional() },
        undefined, a => checkSellerReputation(repBody(a)), a => validateReputation(repBody(a)).error || null);
    const payBody = a => ({ payment: a.payment, policy: a.policy, seller: a.seller, ...(a.sellerRules ? { sellerRules: a.sellerRules } : {}) });
    await paidTool('should_i_pay', 'Should my agent pay this? (pay / dont_pay / ask_human)', '/api/pay/should-i-pay', 'POST', PAYDECISION_PLAN.priceUsd, "Use right before an agent pays an invoice, merchant or x402 seller: runs the spend-policy check (limits, rolling cap, categories, allow/deny lists, hours, assets/chains, approval threshold) and the seller reputation check (public Base USDC history: buyers, wash share, age, concentration) and returns one verdict pay / dont_pay / ask_human with reasons and one signed receipt. Deterministic; stateless; never pays anyone; not charged if seller data is unavailable.",
        { ...spendSchema, seller: z.object({ address: z.string().optional(), endpoint: z.string().optional(), lookbackDays: z.number().int().min(1).max(90).optional() }), sellerRules: z.object({ onCaution: z.enum(['pay', 'ask_human', 'dont_pay']).optional(), onUnknown: z.enum(['pay', 'ask_human', 'dont_pay']).optional(), minScore: z.number().int().min(0).max(100).optional() }).optional() },
        undefined, a => checkShouldIPay(payBody(a)), a => validatePayDecision(payBody(a)).error || null);
    await paidTool('get_daily_brief', 'Daily brief', '/api/brief', 'GET', '0.02', 'Once-per-day brief: regime, dot counts, top 10 coins by dot strength, BTC/ETH/SOL flows.', {}, undefined, () => getBrief());
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
app.get(['/.well-known/mcp.json', '/.well-known/mcp/server-card.json', '/mcp.json'], (req, res) => res.json({
    name: 'gw8-crypto-signal', title: 'GW8 Crypto Regime + WaveTrend Signal', version: '1.2.0',
    description: 'Agent payment risk checks (should-I-pay, spend policy, x402 seller reputation), token verdicts, payment-rail costs and crypto market data (regime, WaveTrend dots, relative strength). Free sample; paid tools via x402 (USDC on Base). Signed receipts. Signal only, no trading.',
    transport: { type: 'streamable-http', url: `${ORIGIN}/mcp` },
    tools: ['get_sample', 'get_brief_teaser', 'list_paid_endpoints', 'get_full_signal', 'get_band_dots', 'get_regime', 'get_coin', 'get_history', 'subscribe_green_dot_alerts', 'get_token_verdict', 'get_flows', 'get_daily_brief', 'get_rwa_feed', 'get_gov_contracts', 'get_kraken_listings', 'get_crypto_rules', 'get_relative_strength', 'get_payment_rails', 'should_i_pay', 'check_spend_policy', 'check_seller_reputation', 'buy_day_pass', 'get_signing_pubkey'],
    dayPass: { endpoint: `${ORIGIN}/api/pass/day`, mcpTool: 'buy_day_pass', priceUsd: PASS_PLAN.priceUsd, hours: PASS_PLAN.hours, dailyCap: PASS_PLAN.dailyCap, perMinute: PASS_PLAN.perMinute, header: 'X-GW8-Pass', mcpArg: 'pass' },
    payment: { protocol: 'x402', version: 2, network: 'eip155:8453', asset: 'USDC', openapi: `${ORIGIN}/openapi.json`, mcpInBand: mcpPayMode().mode === 'inband', mcpMetaKey: 'x402/payment' }
}));

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
    const requirements = getX402ChallengeV2(product || {});
    const paymentRequirements = requirements.accepts[0];
    const facilitatorBody = { x402Version: 2, paymentPayload, paymentRequirements };

    const verifyJwt = generateCdpJwt('POST', '/platform/v2/x402/verify');
    const verifyRes = await fetch(`${CDP_FACILITATOR_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${verifyJwt}` },
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
        return { status: 503, body: { error: (out && out.error) || 'upstream data unavailable, retry shortly', note: 'no payment was taken (payment verified but not settled)' } };
    }
    const settleJwt = generateCdpJwt('POST', '/platform/v2/x402/settle');
    let settleRes, settleData;
    try {
        settleRes = await fetch(`${CDP_FACILITATOR_URL}/settle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settleJwt}` },
            body: JSON.stringify(facilitatorBody)
        });
        settleData = await settleRes.json().catch(() => ({}));
    } catch (e) { settleRes = { ok: false, status: 'network' }; settleData = {}; }
    if (!settleRes.ok || settleData.success === false) {
        console.error("[CDP FACILITATOR] settle failed", settleRes.status, settleData.errorReason);
        // Paid data is withheld when settlement fails; undo side effects (pass / subscription) created for it.
        if (product && product.rollback) { try { await product.rollback(out); } catch (e) { console.error('[x402] rollback failed', e.message); } }
        return { status: 402, body: { error: "Payment settlement failed", reason: settleData.errorReason || settleRes.status, note: 'no data returned and nothing was created; you can retry' } };
    }
    const payer = payerFrom(paymentPayload, settleData);
    const body = { status: 'success', accessType: 'X402_FACILITATOR_SETTLED', settlement: settleData, timestamp: new Date().toISOString(), signal: out,
        receipt: buildReceipt({ endpoint: `${req.method} ${req.path}`, query: req.query, amount: paymentRequirements.amount, tx: settleData.transaction, payer, accessType: 'X402_FACILITATOR_SETTLED' }, out) };
    const headers = {
        'PAYMENT-RESPONSE': Buffer.from(JSON.stringify(settleData)).toString('base64'),
        ...receiptHeaders({ route: `${req.method} ${req.path}`, resource: paymentRequirements && requirements.resource.url, amount: paymentRequirements.amount, payTo: VAULT_ADDRESS, tx: settleData.transaction, payer, accessType: 'X402_FACILITATOR_SETTLED' }, body)
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
        if (!out || out.error) { await refundPass(p); return res.status(503).json({ error: (out && out.error) || 'upstream data unavailable, retry shortly', note: 'pass call not counted' }); }
        return res.set('X-GW8-Pass-Remaining', String(p.remaining)).json({ status: 'success', accessType: 'DAY_PASS', pass: { remaining: p.remaining, expiresAt: p.expiresAt }, timestamp: new Date().toISOString(), signal: out,
            receipt: buildReceipt({ endpoint: `${req.method} ${req.path}`, query: req.query, amount: null, tx: null, accessType: 'DAY_PASS' }, out) });
    }

    // PRIMARY PATH: x402 v2 EIP-3009 Signature Verification via CDP Facilitator
    if (paymentSigHeader && product && product.precheck) {
        const pc = await product.precheck(req);
        if (pc && pc.error) return res.status(400).json({ error: pc.error, note: 'no payment was taken' });
    }
    if (paymentSigHeader) {
        if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
            console.error("[CDP FACILITATOR] KEYS_MISSING: CDP_API_KEY_ID or CDP_API_KEY_SECRET not set on Render.");
            return res.status(500).json({ error: "Facilitator Configuration Error", code: "KEYS_MISSING", note: 'no payment was taken' });
        }
        try {
            const paymentPayload = decodePaymentPayload(paymentSigHeader);
            if (!paymentPayload) return res.status(400).json({ error: 'Unreadable PAYMENT-SIGNATURE', note: 'no payment was taken' });
            const url = getX402ChallengeV2(product || {}).resource.url;
            // Safe retry: the same signed payload to the same resource returns the first successful response.
            const r = await once(replayKey(url, paymentPayload), () => facilitatorPaidCall(req, product, paymentPayload, deliver));
            if (r.status === 200) {
                res.locals.gw8Payer = r.payer || null;
                if (r.replay) { res.locals.gw8Replay = true; res.set('X-GW8-Replay', 'true'); }
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
        const challenge = getX402ChallengeV2();
        return res.status(410)
            .set('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(challenge)).toString('base64'))
            .json({ error: 'MANUAL_TX_RETIRED', message: 'Paying by raw USDC transfer + tx hash is no longer accepted (anyone could redeem a public tx). Pay with x402 instead: sign the PAYMENT-REQUIRED challenge and retry with PAYMENT-SIGNATURE. No data is returned for a tx hash.', howTo: `${BASE_URL}/pay.html`, freeTeaser: `${BASE_URL}/api/brief/teaser`, note: 'If you already sent a raw transfer expecting data, contact the operator via the GitHub repo for a refund.' });
    }

    // PRIMARY CHALLENGE: 402 Payment Required (x402 Version 2). v2 fields unchanged; GW8 extras ride alongside.
    const challenge = getX402ChallengeV2(product || {});
    const challengeBase64 = Buffer.from(JSON.stringify(challenge)).toString('base64');
    const f = funnel(challenge.resource.url, { passUsd: PASS_PLAN.priceUsd, passHours: PASS_PLAN.hours, passCap: PASS_PLAN.dailyCap, noPass: !!(product && product.noPass) });

    return res.status(402)
        .set('PAYMENT-REQUIRED', challengeBase64)
        .set('X-402-Pay-To', VAULT_ADDRESS)
        .set('X-402-Amount-USDC', product ? String(Number(product.amount) / 1e6) : '0.02')
        .set('X-402-Chain', 'eip155:8453')
        .set(f.headers)
        .json({ ...challenge, gw8: f.body });
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
        if (t && t.error) return res.status(503).json(t);
        res.json(t);
    } catch (e) { res.status(503).json({ error: 'upstream data unavailable, retry shortly' }); }
});

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

app.use(['/api/agent', '/api/dots', '/api/history', '/api/regime', '/api/coin', '/api/verdict', '/api/flows', '/api/brief', '/api/rwa', '/api/govcontracts', '/api/kraken/listings', '/api/rules', '/api/rs', '/api/rails', '/api/spend/check', '/api/seller/reputation', '/api/pay/should-i-pay'], signResponses);
app.all('/api/agent', handleX402Agent);

// Cheaper single-purpose products (signal only)
const BASE_URL = 'https://micro-saas-agent.onrender.com';
app.get('/api/dots', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/dots`, amount: "10000", name: "GW8 WaveTrend Band Dots (66 Kraken pairs, 4h)",
    description: "WaveTrend oversold/overbought band dots on 66 Kraken 4h USD pairs (green wt1<=-53 / outer<=-60, red wt1>=53 / outer>=60) from the last 6 closed bars. Use when scanning for fresh oversold/overbought crosses. $0.01 USDC. Signal only.",
    tags: ["wavetrend", "oversold", "crypto", "kraken", "x402"],
    example: { asOf: "2026-10-17T20:00:00Z", bandDots: [{ name: "LINK", kind: "green", band: "inner", wt1: -54.8, bar: "2026-10-17T16:00:00.000Z", close: 11.2 }] },
    deliver: getDots
}));
app.get('/api/history', (req, res) => {
    const pair = req.query.pair ? String(req.query.pair).toUpperCase().replace(/\/USD$/, '') : null;
    if (pair && !COINS.includes(pair)) return res.status(404).json({ error: 'unknown pair', supported: COINS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/history`, amount: "50000", name: "GW8 WaveTrend Band-Dot History + Hit Rates (90d, 66 pairs)",
        description: "Simulated 90-day hit-rate backtest of WaveTrend band dots on 66 Kraken 4h USD pairs (recomputed live, not a live trade log). Returns forward % +4h/+24h/+3d and hit-rate summary; green dots historically stronger than red (near coin-flip). Optional ?pair=BTC. $0.05 USDC. Past performance is not indicative of future results.",
        tags: ["backtest", "hit-rate", "wavetrend", "crypto", "x402"],
        example: { window: "90 days", methodology: "simulated backtest", summary: { green_all: { fwd24hPct: { n: 120, hitRatePct: 55.0, avgMovePct: 0.8 } } }, dots: [{ pair: "LINK/USD", kind: "green", band: "inner", bar: "2026-10-17T16:00:00.000Z", wt1: -54.8, wt2: -48.6, close: 11.2, fwd4hPct: 0.6, fwd24hPct: null, fwd3dPct: null }] },
        inputProps: { pair: { type: "string", description: "Optional coin symbol, e.g. BTC", example: "BTC" } },
        deliver: () => getHistory(pair)
    });
});
app.get('/api/regime', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/regime`, amount: "10000", name: "GW8 Stage 1 Crypto Regime Check (detail)",
    description: "Stage 1 crypto market regime score 0-4 with raw values and rules: BTC spot ETF 3-day net flow, BTC quiet support vs 20-day low, alt breadth (ETH/SOL/LINK/XRP), Fear & Greed / weekend pump. Use for risk-on/risk-off context before other signals. $0.01 USDC. Signal only.",
    tags: ["market-regime", "crypto", "etf", "fear-greed", "x402"],
    example: { score: 3, outOf: 4, checks: { btcQuietSupport: { status: "pass", detail: { pctAboveLow: 2.1, avgRange3dPct: 2.4 }, rule: "BTC within quiet band above 20d low" } } },
    deliver: getRegime
}));
const SUB_URL = `${BASE_URL}/api/alerts/subscribe`;
app.post('/api/alerts/subscribe', (req, res) => {
    let v = null;
    return handleX402Agent(req, res, {
        url: SUB_URL, method: "POST", amount: ALERT_PLAN.amount, noPass: true,
        name: "GW8 Green-Dot Webhook Alerts (30 days)",
        description: `Subscribe a public https webhook to NEW green WaveTrend oversold band dots on 66 Kraken 4h pairs (filter outer|inner|all, optional pairs). HMAC-signed POSTs for ${ALERT_PLAN.days} days or ${ALERT_PLAN.maxAlerts} alerts. Use when an agent should wake on fresh green dots. $${ALERT_PLAN.priceUsd} USDC. Invalid bodies rejected before payment. Signal only.`,
        tags: ["wavetrend", "alerts", "webhook", "crypto", "x402"],
        inputProps: { webhookUrl: { type: "string", example: "https://example.com/hook" }, filter: { type: "string", enum: ["outer", "inner", "all"], example: "outer" }, pairs: { type: "array", items: { type: "string" }, example: ["BTC", "ETH"] } },
        bodyRequired: ["webhookUrl"],
        example: { subscriptionId: "sub_…", filter: "outer", expiresAt: "2026-11-17T00:00:00Z", alertsLeft: ALERT_PLAN.maxAlerts, note: "one-time webhook secret returned once at subscribe" },
        precheck: async (r) => { v = await validateSubscribe(r.body, COINS); return v.error ? v : null; },
        deliver: async () => { if (!v) v = await validateSubscribe(req.body, COINS); return v.error ? { error: v.error } : createSubscription(v); },
        rollback: out => cancelSubscription(out && out.subscriptionId)
    });
});
for (const plan of Object.values(WEEKLY_PLANS)) app.post(plan.path, (req, res) => {
    let v = null;
    return handleX402Agent(req, res, {
        url: `${BASE_URL}${plan.path}`, method: "POST", amount: plan.amount, noPass: true,
        name: `GW8 Weekly Brief (${plan.weeks} weeks, webhook)`,
        description: `${plan.weeks} Monday webhook issues (HMAC-signed): crypto market regime, top WaveTrend dots, 7d hit rates, tokenized RWA flows, and federal contract highlights (DoD awards ~90 days late via USAspending). Undelivered weeks not counted. $${plan.priceUsd} USDC.`,
        tags: ["weekly-brief", "crypto", "rwa", "gov-contracts", "x402"],
        inputProps: { webhookUrl: { type: "string", description: "public https URL", example: "https://example.com/hook" } },
        bodyRequired: ["webhookUrl"],
        example: { subscriptionId: "wk_…", plan: plan.id, issuesLeft: plan.weeks, expiresAt: "2026-11-22T00:00:00Z", note: "one-time webhook secret returned once at subscribe" },
        precheck: async (r) => { v = await validateWeekly(r.body); return v.error ? v : null; },
        deliver: async () => { if (!v) v = await validateWeekly(req.body); return v.error ? { error: v.error } : createWeekly(v, plan); },
        rollback: out => cancelWeekly(out && out.subscriptionId)
    });
});
app.get('/api/brief/weekly/:id', async (req, res) => {
    const s = await getWeeklyStatus(String(req.params.id));
    return s ? res.json(s) : res.status(404).json({ error: 'unknown subscription' });
});
setInterval(() => weeklyTick().then(r => r && r.sent && console.log('[weekly]', JSON.stringify(r))).catch(() => {}), 10 * 60 * 1000).unref();
app.post('/api/pass/day', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/pass/day`, method: "POST", amount: PASS_PLAN.amount, noPass: true,
    name: "GW8 Day Pass (24h, all paid data endpoints)",
    description: `Day pass: one payment unlocks ${PASS_PLAN.hours}h of paid GW8 data endpoints/MCP tools via header X-GW8-Pass (or MCP arg pass). Fair use ${PASS_PLAN.dailyCap} calls/pass, ${PASS_PLAN.perMinute}/min. Excludes alert subscriptions. Token shown once (bearer-style). $${PASS_PLAN.priceUsd} USDC. Signal only.`,
    tags: ["day-pass", "crypto", "x402", "usdc", "agents"],
    body: {},
    example: { pass: "gw8p_…", expiresAt: "2026-10-19T19:00:00.000Z", header: "X-GW8-Pass" },
    deliver: () => mintPass(),
    rollback: out => revokePass(out && out.pass)
}));
app.get('/api/alerts/:id', async (req, res) => {
    const s = await getStatus(String(req.params.id));
    return s ? res.json(s) : res.status(404).json({ error: 'unknown subscription' });
});
onWaveTrendRefresh(wt => logDots(wt).then(r => r.added && console.log('[track] logged', r.added)).catch(() => {}));
onWaveTrendRefresh(wt => onRefresh(wt).then(r => r && (r.sent || r.seeded) && console.log('[alerts]', JSON.stringify(r))));
setInterval(() => getWaveTrend().catch(() => {}), 10 * 60 * 1000).unref();
console.log('[alerts] persistence:', persistenceMode());
app.get('/api/coin/:symbol', (req, res) => {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!COINS.includes(sym)) return res.status(404).json({ error: 'unknown symbol', supported: COINS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/coin/${sym}`, amount: "2000", name: `GW8 WaveTrend 4h: ${sym}/USD`,
        description: `WaveTrend 4h snapshot for ${sym}/USD on Kraken (wt1/wt2, previous values, recent oversold/overbought band dots). Cheapest paid call. $0.002 USDC. Signal only.`,
        tags: ["wavetrend", "crypto", "kraken", "x402", "agents"],
        routeTemplate: "/api/coin/:symbol",
        pathParams: { symbol: sym },
        example: { name: sym, wt1: -41.2, wt2: -38.9, prevWt1: -44.0, prevWt2: -39.5, dots: [] },
        deliver: () => getCoin(sym)
    });
});

// Upgrades-4: token verdict, flows, daily brief (signal only, public data)
app.get('/api/proof/pubkey', (req, res) => res.json(publicKeyInfo()));
app.get('/api/verdict/:chain/:address', (req, res) => {
    const chain = String(req.params.chain).toLowerCase(), address = String(req.params.address);
    const bad = validVerdictInput(chain, address);
    if (bad) return res.status(400).json({ error: bad, chains: Object.keys(VERDICT_CHAINS) });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/verdict/${chain}/${address}`, amount: "10000", name: "GW8 Token Safety Verdict (GoPlus + DexScreener)",
        description: "Token safety verdict: score 0-100 and safe/caution/danger with reasons + source URLs (GoPlus token security + DexScreener liquidity, fixed published rules). Chains: base, ethereum, bsc, arbitrum, solana. Automated screen, not a guarantee. 10-min cache. $0.01 USDC.",
        tags: ["token-safety", "crypto", "goplus", "dexscreener", "x402"],
        routeTemplate: "/api/verdict/:chain/:address",
        pathParams: { chain, address },
        example: { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", score: 85, verdict: "safe", reasons: ["liquidity ok"], sources: ["https://api.gopluslabs.io/", "https://api.dexscreener.com/"] },
        deliver: () => getVerdict(chain, address).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});
app.get('/api/flows/:symbol', (req, res) => {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!COINS.includes(sym)) return res.status(404).json({ error: 'unknown symbol', supported: COINS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/flows/${sym}`, amount: "20000", name: `GW8 Large-Print Flows + WaveTrend: ${sym}/USD`,
        description: `Kraken large-print buy vs sell summary for ${sym}/USD (last 1000 public trades; single venue, not on-chain whales) joined with WaveTrend 4h state. Use for short-horizon flow context. $0.02 USDC. Signal only.`,
        tags: ["flows", "kraken", "wavetrend", "crypto", "x402"],
        routeTemplate: "/api/flows/:symbol",
        pathParams: { symbol: sym },
        example: { symbol: sym, flows: { largePrints: { count: 12, buyUsd: 420000, sellUsd: 180000, netUsd: 240000 }, bias: "large buyers dominant" }, wavetrend: { wt1: -41.2, wt2: -38.9, zone: "neutral" } },
        deliver: () => getFlows(sym).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});
app.get('/api/brief', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/brief`, amount: "20000", name: "GW8 Daily Crypto Brief",
    description: "Once-per-day (Mountain Time) crypto brief: Stage 1 market regime, WaveTrend band-dot counts, top 10 coins by WaveTrend dot strength, BTC/ETH/SOL Kraken large-print flows. Free partial teaser at GET /api/brief/teaser. Use for a daily agent digest. $0.02 USDC. Signal only.",
    tags: ["daily-brief", "market-regime", "wavetrend", "crypto", "x402"],
    example: { date: "2026-10-17", regime: { score: 3, outOf: 4 }, dots: { green: 5, red: 2 }, top10ByDotStrength: [{ name: "LINK", kind: "green", strength: 68.5 }], flowsSummary: [{ symbol: "BTC", bias: "balanced" }] },
    deliver: getBrief
}));

app.get('/api/rwa', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/rwa`, amount: "20000", name: "GW8 RWA Feed (tokenized treasuries, credit, stocks)",
    description: "Tokenized RWA flows: top RWA protocols by TVL with 1d/7d change and estimated 7d flows (TVL change includes price effects), movers, new listings (30d), yield pools, top RWA tokens (DefiLlama + CoinGecko). 10-min cache. $0.02 USDC. Signal only.",
    tags: ["rwa", "tokenized", "tvl", "defillama", "x402"],
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
        description: "Federal contract awards: recent 14-day USAspending actions to AI, drone, nuclear, robotics, space, quantum and defense-tech companies (ticker, amount, agency, date, award link). Optional ?ticker=PLTR&sector=ai&q=NASA. Defense/DoD awards appear on USAspending about 90 days late; war.gov daily announcements are currently unavailable from our host (see free /api/govcontracts/status). 30-min cache. $0.01 USDC. Signal only.",
        tags: ["gov-contracts", "federal", "defense", "usaspending", "x402"],
        inputProps: { ticker: { type: "string", example: "PLTR" }, sector: { type: "string", enum: GOV_SECTORS, example: "ai" }, q: { type: "string", example: "NASA" } },
        example: { window: { start: "2026-10-04", end: "2026-10-18" }, count: 1, note: "DoD awards via USAspending lag ~90 days", awards: [{ date: "2026-10-08", recipient: "Example Defense Co", ticker: "BAH", sector: "defense-tech", amountUsd: 1250000, agency: "General Services Administration", link: "https://www.usaspending.gov/award/CONT_AWD_example" }] },
        deliver: () => getGovContracts(f).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});

// Kraken new-listings feed (public REST only). Free status registered before the paid route.
app.get('/api/kraken/listings/status', async (req, res) => { try { res.json(await getKrakenStatus()); } catch { res.status(503).json({ status: 'unavailable' }); } });
app.get('/api/kraken/listings', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/kraken/listings`, amount: "20000", name: "GW8 Kraken New USD Listings",
    description: "Kraken new USD listings (last 30 days): first-seen date, price, 24h volume, % since listing, WaveTrend 4h state, listing posts. Use when watching fresh exchange listings. Public data. $0.02 USDC. Signal only.",
    tags: ["kraken", "new-listings", "crypto", "wavetrend", "x402"],
    example: { liveSince: "2026-10-19T00:00:00Z", count: 1, newUsdPairs: [{ pair: "PNT/USD", firstSeenByGw8: null, firstTradeDayOnKraken: "2026-10-08", dateSource: "kraken-first-candle", priceUsd: 0.5, volume24hUsd: 120000, changeSinceListingPct: -12.3, wavetrend4h: { wt1: -40.1, zone: "neutral", dotOnLatestBar: null } }] },
    deliver: getKrakenListings
}));
setTimeout(() => krakenSnapshot().catch(() => {}), 60e3).unref();
setInterval(() => krakenSnapshot().catch(() => {}), 30 * 60e3).unref();

// Crypto rule-change feed (public keyless sources). Free status registered before the paid route.
app.get('/api/rules/status', async (req, res) => { try { res.json(await getRulesStatus()); } catch { res.status(503).json({ status: 'unavailable' }); } });
app.get('/api/rules', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/rules`, amount: "20000", name: "GW8 Crypto Rule-Change Feed (CFTC + SEC)",
    description: "CFTC + SEC crypto rule-change feed (last 90 days): Federal Register ANPRM/NPRM/final/notices with RIN, comment deadlines and stage-change flags, plus agency press. Per-source status; no stale fill. $0.02 USDC. Signal only.",
    tags: ["cftc", "sec", "crypto-rules", "regulation", "x402"],
    example: { count: 1, openComments: [{ rin: "3038-AF80", agency: "CFTC", docType: "ANPRM", commentDeadline: "2026-12-14" }], rows: [{ date: "2026-10-13", agency: "CFTC", docType: "ANPRM", title: "Regulation Crypto Asset Transactions", rin: "3038-AF80", commentDeadline: "2026-12-14", link: "https://www.federalregister.gov/", stageChange: { from: null, to: "ANPRM" } }] },
    deliver: getRules
}));

// Relative strength + sector scores (Kraken public daily OHLC, our own math). Warmed after boot so the first buyer doesn't wait ~75s.
app.get('/api/rs', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/rs`, amount: "20000", name: "GW8 Relative Strength + Sector Scores (66 Kraken pairs)",
    description: "Relative strength across 66 Kraken USD pairs: 1w and 1m % return, percentile ranks, 0-100 strength (60% 1m + 40% 1w rank), leaders/laggards, and sector scores with breadth (% positive 1m) for L1, L2, DeFi, RWA, oracles/infra, payments, AI, memes. Kraken public daily candles, 30-min cache. $0.02 USDC. Signal only.",
    tags: ["relative-strength", "sectors", "crypto", "kraken", "x402"],
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
        description: "Which payment rail is cheapest and fastest right now for a USD amount (?amount=100): Base USDC (live eth_gasPrice x ~65k gas x Kraken ETH/USD, ~2s), XRPL RLUSD/XRP (live open-ledger fee x Kraken XRP/USD, ~3-5s), Tempo and Circle Arc (live eth_gasPrice, fees in USD stablecoins, ~1s), card (static 2.9% + $0.30 estimate, days). Fee USD/%, settlement, timestamps, sources, agent protocols per rail, recommended pick. Failed live sources are marked unavailable. 60s cache. $0.002 USDC. Signal only.",
        tags: ["payments", "rails", "base", "xrpl", "x402"],
        inputProps: { amount: { type: "number", example: 100 } },
        example: { amountUsd: 100, recommended: { rail: "xrpl-rlusd-xrp", fastest: "base-usdc" }, rails: [{ rail: "base-usdc", status: "live", feeUsd: 0.00095, feePct: 0.00095, settlement: "~2s" }, { rail: "xrpl-rlusd-xrp", status: "live", feeUsd: 0.000025, feePct: 0.000025, settlement: "~3-5s" }, { rail: "card", status: "static-estimate", feeUsd: 3.2, feePct: 3.2, settlement: "~1-3 business days" }] },
        deliver: () => getRails(v.amount).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});

// Spend-policy check for AI agents (pure rule evaluation; stateless; no custody, no payment execution).
// Validate first: a malformed body gets 400 before the x402 challenge or any pass/payment header is looked at,
// so it is never charged and never uses a pass call. Valid bodies fall through to the paid route below.
app.post('/api/spend/check', (req, res, next) => { const v = validateSpend(req.body); return v.error ? res.status(400).json({ error: v.error, note: 'no payment was taken' }) : next(); });
app.post('/api/spend/check', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/spend/check`, method: "POST", amount: SPEND_PLAN.amount, name: "GW8 Spend-Policy Check (AI agent payments)",
    description: `Before an AI agent pays an invoice or merchant: POST {payment, policy} and get allow / deny / needs_approval, the rules that fired (per-tx limit, rolling cap using your spent-so-far, blocked/allowed merchant categories, allow/deny lists, allowed hours + timezone, assets/chains, human-approval threshold) and an Ed25519-signed decision receipt bound to a hash of your request. Deterministic and stateless: nothing is stored. Not custody, does not move money. Invalid bodies rejected before payment. $${SPEND_PLAN.priceUsd} USDC.`,
    tags: ["agent-payments", "spend-policy", "guardrails", "x402", "usdc"],
    inputProps: {
        payment: { type: "object", example: { amount: "420.00", currency: "USDC", chain: "base", recipientId: "acct_acme_supplies", recipientDomain: "acme-supplies.com", merchantCategory: "office-supplies", timestamp: "2026-10-21T15:30:00Z", agentId: "ap-agent-7", memo: "INV-10442" } },
        policy: { type: "object", example: { currency: "USDC", perTxLimit: "1000", rollingCap: { limit: "5000", spentSoFar: "1200", windowHours: 24 }, blockedCategories: ["gambling", "crypto-exchange"], allowList: ["acme-supplies.com"], allowedHours: { start: "08:00", end: "18:00", timezone: "America/Denver", days: ["mon", "tue", "wed", "thu", "fri"] }, allowedAssets: ["USDC"], allowedChains: ["base"], requireApprovalAbove: "750" } }
    },
    bodyRequired: ["payment", "policy"],
    example: { engine: "gw8-spend-policy/1", decision: "allow", reasons: [], checks: [{ rule: "per_tx_limit", result: "pass", detail: "420 <= per-tx limit 1000" }], remaining: { perTx: "1000", rollingCapBefore: "3800", rollingCapAfter: "3380" }, decisionReceipt: { endpoint: "POST /api/spend/check", accessType: "SPEND_POLICY_DECISION", query: { decision: "allow", requestSha256: "7faa…" }, response_sha256: "…", payload: "eyJ2Ijox…", signature: "base64…", signed: true, alg: "Ed25519", verify_url: "https://micro-saas-agent.onrender.com/api/receipt/verify" } },
    precheck: async (r) => { const v = validateSpend(r.body); return v.error ? { error: v.error } : null; },
    deliver: async () => checkSpend(req.body)
}));

// Free: is the reputation data source reachable from this server? Fixed probe (no user input), cached 60s, no receipt.
app.get('/api/seller/reputation/status', async (req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json(await getSourceStatus()); });

// x402 seller reputation for AI agents (public Base USDC history via Alchemy when ALCHEMY_API_KEY is set, else keyless
// Blockscout; the key is only read in reputation.js and never returned or logged; stateless; never pays anyone).
// Validate first: a malformed body gets 400 before the x402 challenge or any pass/payment header is looked at, so it is
// never charged. If the data source is down (or an endpoint-only request has no readable payTo), deliver returns
// {error}: the payment is verified but not settled / the pass call is refunded, so "unknown because no data" is free.
app.post('/api/seller/reputation', (req, res, next) => { const v = validateReputation(req.body); return v.error ? res.status(400).json({ error: v.error, note: 'no payment was taken' }) : next(); });
app.post('/api/seller/reputation', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/seller/reputation`, method: "POST", amount: REPUTATION_PLAN.amount, name: "GW8 x402 Seller Reputation (AI agent payments)",
    description: `Before an AI agent pays an x402 seller: POST {address} (seller wallet on Base) and/or {endpoint} (x402 URL; payTo read from its unpaid 402 challenge). Returns a 0-100 score and verdict trusted / caution / avoid / unknown from public USDC transfer history: distinct paying buyers, wash/self-dealing share (self-transfers, round-trips), wallet age, top-payer concentration, 30-day organic volume, with reasons and an Ed25519-signed receipt. Deterministic formula; stateless; never pays anyone. Invalid bodies rejected before payment; no charge when the data source is unavailable. $${REPUTATION_PLAN.priceUsd} USDC.`,
    tags: ["agent-payments", "seller-reputation", "trust", "x402", "usdc", "base"],
    inputProps: {
        address: { type: "string", example: "0x1111111111111111111111111111111111111111" },
        endpoint: { type: "string", example: "https://seller.example/api/data" },
        lookbackDays: { type: "integer", example: 90 }
    },
    example: { engine: "gw8-seller-reputation/1", verdict: "caution", score: 58, components: { distinctBuyers: { value: 4, points: 12, max: 30 }, washShare: { value: 0.1, points: 23, max: 25 }, walletAge: { days: 86, points: 10, max: 15 }, concentration: { topPayerShare: 0.45, points: 14, max: 20 }, volume30d: { organicUsd: 0.6, points: 3, max: 10 } }, reasons: ["only 4 distinct organic paying buyer(s)"], reputationReceipt: { endpoint: "POST /api/seller/reputation", accessType: "SELLER_REPUTATION", query: { verdict: "caution", score: 58, requestSha256: "…", dataSha256: "…" }, signed: true, alg: "Ed25519", verify_url: "https://micro-saas-agent.onrender.com/api/receipt/verify" } },
    precheck: async (r) => { const v = validateReputation(r.body); return v.error ? { error: v.error } : null; },
    deliver: async () => checkSellerReputation(req.body)
}));

// Should my agent pay this? spend policy + seller reputation -> one verdict and one signed receipt.
// Validate first (400 before any 402/pass). Seller data unavailable -> deliver {error} -> not settled / pass refunded.
app.post('/api/pay/should-i-pay', (req, res, next) => { const v = validatePayDecision(req.body); return v.error ? res.status(400).json({ error: v.error, note: 'no payment was taken' }) : next(); });
app.post('/api/pay/should-i-pay', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/pay/should-i-pay`, method: "POST", amount: PAYDECISION_PLAN.amount, name: "GW8 Should-I-Pay (spend policy + seller reputation)",
    description: `Use right before an AI agent pays: POST {payment, policy, seller} and get ONE verdict pay / dont_pay / ask_human. Runs the spend-policy check (per-tx limit, rolling cap with your spent-so-far, categories, allow/deny lists, hours + timezone, assets/chains, approval threshold) and the x402 seller reputation check (public Base USDC history: distinct buyers, wash share, wallet age, concentration, 30d volume), with reasons, both sub-results and one Ed25519-signed receipt. Deterministic; stateless; never pays anyone. Invalid bodies rejected before payment; not charged if seller data is unavailable. $${PAYDECISION_PLAN.priceUsd} USDC.`,
    tags: ["agent-payments", "risk-check", "spend-policy", "seller-reputation", "x402"],
    inputProps: {
        payment: { type: "object", example: { amount: "0.05", currency: "USDC", chain: "base", recipientId: "0x1111111111111111111111111111111111111111", merchantCategory: "data-api", timestamp: "2026-10-21T15:30:00Z", agentId: "research-agent-1" } },
        policy: { type: "object", example: { currency: "USDC", perTxLimit: "1", rollingCap: { limit: "10", spentSoFar: "2.40" }, allowedChains: ["base"], allowedAssets: ["USDC"], requireApprovalAbove: "0.50" } },
        seller: { type: "object", example: { address: "0x1111111111111111111111111111111111111111" } },
        sellerRules: { type: "object", example: { onCaution: "ask_human", onUnknown: "ask_human" } }
    },
    bodyRequired: ["payment", "policy", "seller"],
    example: { engine: "gw8-should-i-pay/1", verdict: "ask_human", reasons: [{ source: "seller_reputation", action: "ask_human", detail: "seller verdict caution (score 58) -> ask_human" }], spend: { decision: "allow" }, seller: { verdict: "caution", score: 58 }, decisionReceipt: { endpoint: "POST /api/pay/should-i-pay", accessType: "PAY_DECISION", query: { verdict: "ask_human", spendDecision: "allow", sellerVerdict: "caution", sellerScore: 58, requestSha256: "…" }, signed: true, alg: "Ed25519", verify_url: "https://micro-saas-agent.onrender.com/api/receipt/verify" } },
    precheck: async (r) => { const v = validatePayDecision(r.body); return v.error ? { error: v.error } : null; },
    deliver: async () => checkShouldIPay(req.body)
}));

initMcpPayments({ facilitatorUrl: CDP_FACILITATOR_URL, payTo: VAULT_ADDRESS, asset: USDC_BASE_ADDRESS, makeJwt: generateCdpJwt, onPaid: recordMcpPaid })
    .then(st => console.log('[mcp-pay] mode:', st.mode, st.reason ? `(${st.reason})` : ''))
    .catch(() => console.log('[mcp-pay] mode: pointer (init error)'));
app.listen(PORT, () => {
    console.log(`GW8 Capital x402 v2 Gateway online on port ${PORT}`);
});
