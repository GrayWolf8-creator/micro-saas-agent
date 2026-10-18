
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Interface, formatUnits } from 'ethers';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { safeSignal, buildSample, getCoin, getDots, getHistory, getRegime, COINS } from './Signal.js';
import { getVerdict, validVerdictInput, VERDICT_CHAINS, VERDICT_RULES, getFlows, getBrief, signResponses, publicKeyInfo } from './upgrades.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const VAULT_ADDRESS = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RESOURCE_URL = 'https://micro-saas-agent.onrender.com/api/agent';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const CDP_FACILITATOR_URL = process.env.CDP_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402';
const INGEST_SECRET = process.env.INGEST_SECRET 
const VIP_TOKEN = process.env.VIP_TOKEN 

// Multi-Asset Telemetry Store
const telemetryStore = {
    'BTC/USD': {
        symbol: 'BTC/USD',
        price: 63881.0,
        metrics: { rsi_14: 50.0, sma_20: 63881.0, bb_upper: 63881.0, bb_lower: 63881.0 },
        signal: 'NEUTRAL_CONSOLIDATION',
        timestamp: Math.floor(Date.now() / 1000),
        updatedAt: new Date().toISOString()
    }
};

const processedTxs = new Set();

let providerInstance = null;
function getProvider() {
    if (!providerInstance) {
        providerInstance = new JsonRpcProvider(BASE_RPC_URL, 8453, { staticNetwork: true });
    }
    return providerInstance;
}

const erc20Interface = new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)"
]);

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
function getX402ChallengeV2(o = {}) {
    const base = {
        x402Version: 2,
        error: "PAYMENT_REQUIRED",
        resource: {
            url: RESOURCE_URL,
            description: "Crypto regime signal: Stage 1 score (0-4) + WaveTrend 10/21/4 band dots on 66 Kraken 4h pairs",
            mimeType: "application/json"
        },
        accepts: [
            {
                scheme: "exact",
                network: "eip155:8453",
                amount: "20000",
                asset: USDC_BASE_ADDRESS,
                payTo: VAULT_ADDRESS,
                maxTimeoutSeconds: 300,
                extra: {
                    name: "USD Coin",
                    version: "2"
                }
            }
        ],
        extensions: {
            bazaar: {
                schema: {
                    $schema: "https://json-schema.org/draft/2020-12/schema",
                    type: "object",
                    properties: {
                        input: { type: "object", properties: { type: { const: "http" }, method: { const: "POST" } }, required: ["type", "method"] },
                        output: { type: "object" }
                    },
                    required: ["input"]
                },
                info: {
                    name: "GW8 Crypto Regime + WaveTrend Signal (66 Kraken pairs)",
                    category: "crypto-market-data",
                    tags: ["crypto", "trading-signal", "wavetrend", "market-regime", "btc", "kraken", "technical-analysis"],
                    description: "Stage 1 crypto regime check (ETF flows, BTC support, alt breadth, Fear & Greed) plus LazyBear WaveTrend band dots across 66 Kraken USD pairs, 4h. Free live sample at /api/sample.",
                    input: {
                        type: "http",
                        method: "POST",
                        bodyType: "json",
                        body: {}
                    },
                    output: {
                        example: {
                            status: "success",
                            signal: {
                                stage1: { score: 1, outOf: 4, checks: { etfInflows: { status: "fail" }, btcQuietSupport: { status: "fail" }, altsNotFreefall: { status: "pass" }, noGreedChase: { status: "fail" } } },
                                wavetrend: { settings: "LazyBear 10/21/4, Kraken 4h", core: [{ name: "XRP", wt1: -48.65, wt2: -45.1 }], bandDots: [], universe: 66 },
                                disclaimer: "signal only, not financial advice"
                            }
                        }
                    }
                }
            }
        }
    };
    if (o.url) {
        base.resource = { url: o.url, description: o.description, mimeType: "application/json" };
        base.accepts[0].amount = o.amount;
        base.extensions.bazaar.info = { name: o.name, description: o.description, input: { type: "http", method: "GET" }, output: { example: o.example } };
    }
    // Spec-shaped Bazaar extension: info.input/info.output + JSON schema describing them
    const method = o.url ? "GET" : "POST";
    const inProps = o.inputProps || {};
    const inKey = method === "GET" ? "queryParams" : "body";
    const inSchema = { type: "object", properties: inProps, additionalProperties: false };
    const info = base.extensions.bazaar.info;
    info.input = { type: "http", method, ...(method === "POST" ? { bodyType: "json" } : {}), [inKey]: Object.fromEntries(Object.entries(inProps).map(([k, v]) => [k, v.example ?? ""])) };
    info.output = { type: "json", example: info.output.example };
    base.extensions.bazaar.schema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: [method] }, ...(method === "POST" ? { bodyType: { type: "string", enum: ["json"] } } : {}), [inKey]: inSchema }, required: ["type", "method"] },
            output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["example"] }
        },
        required: ["input"]
    };
    return base;
}

// 1. Root Landing Page
app.get('/', (req, res) => {
    res.json({
        service: "GW8 Base Signal Agent API",
        status: "ONLINE",
        protocol: "x402 v2",
        price: "0.02 USDC",
        sample: "/api/sample",
        supportedAssets: Object.keys(telemetryStore),
        docs: "/llms.txt",
        manifest: "/.well-known/x402.json"
    });
});

// 2. Manifest Endpoints
app.get('/llms.txt', (req, res) => {
    res.sendFile(path.join(__dirname, 'llms.txt'));
});

app.get(['/.well-known/x402.json', '/well-known/x402.json'], (req, res) => {
    res.json(getX402ChallengeV2());
});

// x402scan / AgentCash discovery: OpenAPI-first, plus /.well-known/x402 fan-out
const PAID = [
    { path: '/api/agent', method: 'post', price: '0.02', summary: 'Full signal: Stage 1 regime score + WaveTrend 10/21/4 on 66 Kraken 4h pairs with all band dots' },
    { path: '/api/history', method: 'get', price: '0.05', summary: 'Rolling 90-day band-dot backtest with forward +4h/+24h/+3d moves and live hit rates (green dots carry the edge; red dots near coin-flip)', query: { pair: { type: 'string', description: 'Optional coin symbol, e.g. BTC' } } },
    { path: '/api/regime', method: 'get', price: '0.01', summary: 'Stage 1 crypto regime check detail (ETF flows, BTC support, alt breadth, Fear & Greed)' },
    { path: '/api/dots', method: 'get', price: '0.01', summary: 'Current WaveTrend band dots across 66 Kraken 4h USD pairs' },
    { path: '/api/coin/{symbol}', method: 'get', price: '0.005', summary: 'WaveTrend 4h snapshot for one coin', pathParam: true },
    { path: '/api/verdict/{chain}/{address}', method: 'get', price: '0.02', summary: 'Token safety verdict: score 0-100, safe/caution/danger, reasons and source URLs (GoPlus + DexScreener, fixed published rules, 10-min cache)', params: { chain: { type: 'string', enum: Object.keys(VERDICT_CHAINS) }, address: { type: 'string', description: 'Token contract (0x...) or Solana mint' } }, ex: '/api/verdict/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { path: '/api/flows/{symbol}', method: 'get', price: '0.02', summary: 'Large-print flow summary from Kraken public trades (single venue, not on-chain) joined with the coin WaveTrend 4h dot state', pathParam: true, ex: '/api/flows/BTC' },
    { path: '/api/brief', method: 'get', price: '0.05', summary: 'Daily brief (built once per Mountain Time day): regime, dot counts, top 10 coins by dot strength, BTC/ETH/SOL flow summary' }
];
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
            security: [],
            ...(parameters.length ? { parameters } : {}),
            ...(p.method === 'post' ? { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: {} } } } } } : {}),
            'x-payment-info': { protocols: [{ x402: {} }], price: { mode: 'fixed', currency: 'USD', amount: p.price } },
            responses: {
                '200': { description: 'Signal JSON (signal only, not financial advice)', content: { 'application/json': { schema: { type: 'object' } } } },
                '402': { description: `Payment required: ${p.price} USDC on Base (eip155:8453) via x402 v2` }
            }
        } };
    }
    paths['/api/proof/pubkey'] = { get: { operationId: 'proof_pubkey', summary: 'Free: Ed25519 public key used to sign paid responses (X-GW8-Signature, X-GW8-Signed-At, X-GW8-Body-SHA256)', security: [], responses: { '200': { description: 'Public key JSON' } } } };
    paths['/api/sample'] = { get: { operationId: 'sample', summary: 'Free live sample', security: [], responses: { '200': { description: 'Sample JSON' } } } };
    return {
        openapi: '3.1.0',
        info: { title: 'GW8 Crypto Regime + WaveTrend Signal API', version: '1.1.0', contact: { url: 'https://github.com/GrayWolf8-creator/micro-saas-agent' },
            description: 'Pay-per-call crypto market signals for AI agents via x402 (USDC on Base). Signal only, no trading.',
            'x-guidance': 'Start with free GET /api/sample. Cheapest: GET /api/coin/{symbol} ($0.005). Full snapshot: POST /api/agent ($0.02). Backtest: GET /api/history ($0.05). Token safety: GET /api/verdict/{chain}/{address} ($0.02). Flows: GET /api/flows/{symbol} ($0.02). Daily brief: GET /api/brief ($0.05). Paid responses may be Ed25519-signed; key at /api/proof/pubkey. Pay by retrying with the PAYMENT-SIGNATURE header from the 402 challenge.' },
        servers: [{ url: 'https://micro-saas-agent.onrender.com' }],
        paths
    };
}
app.get(['/favicon.ico', '/favicon.svg'], (req, res) => res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b1220"/><path d="M8 40 Q20 10 32 32 T56 24" stroke="#22c55e" stroke-width="6" fill="none"/></svg>'));
app.get('/openapi.json', (req, res) => res.json(openApiDoc()));
app.get('/.well-known/x402', (req, res) => res.json({
    version: 1,
    resources: PAID.map(p => `https://micro-saas-agent.onrender.com${(p.ex || p.path.replace('{symbol}', 'BTC'))}`),
    instructions: 'See /openapi.json and /llms.txt'
}));

// MCP (remote, streamable HTTP, stateless). Free tools return data; paid tools return the x402 HTTP
// endpoint + price so x402-capable agents pay over HTTP. No payment logic lives here.
const ORIGIN = 'https://micro-saas-agent.onrender.com';
function buildMcp() {
    const m = new McpServer({ name: 'gw8-crypto-signal', version: '1.1.0' });
    const txt = o => ({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o });
    m.registerTool('get_sample', { title: 'Free live sample', description: 'Free: Stage 1 regime statuses, core WaveTrend 4h values (BTC/ETH/SOL/LINK/XRP) and band-dot count. Signal only, not financial advice.', inputSchema: {} },
        async () => { try { return txt(await buildSample()); } catch (e) { return { isError: true, content: [{ type: 'text', text: 'upstream data unavailable, retry shortly' }] }; } });
    m.registerTool('list_paid_endpoints', { title: 'Paid x402 endpoints', description: 'Lists paid x402 endpoints (USDC on Base, eip155:8453) with method, URL and USD price. Call them over HTTP with an x402 client (e.g. @x402/fetch).', inputSchema: {} },
        async () => txt({ protocol: 'x402 v2', network: 'eip155:8453', asset: 'USDC', openapi: `${ORIGIN}/openapi.json`, endpoints: PAID.map(p => ({ method: p.method.toUpperCase(), url: ORIGIN + p.path, priceUsd: p.price, summary: p.summary })) }));
    const paidTool = (name, title, path, method, price, desc, schema = {}, build = () => path) =>
        m.registerTool(name, { title, description: `${desc} Paid: $${price} USDC on Base via x402. Returns the endpoint to call with an x402 client.`, inputSchema: schema },
            async (a) => txt({ paymentRequired: true, protocol: 'x402 v2', method, url: ORIGIN + build(a), priceUsd: price, network: 'eip155:8453', howTo: 'Request the URL; on 402, sign the PAYMENT-REQUIRED challenge and retry with PAYMENT-SIGNATURE (e.g. wrapFetchWithPayment from @x402/fetch).' }));
    paidTool('get_full_signal', 'Full signal', '/api/agent', 'POST', '0.02', 'Stage 1 regime score + WaveTrend 10/21/4 on 66 Kraken 4h pairs with all band dots.');
    paidTool('get_band_dots', 'Band dots', '/api/dots', 'GET', '0.01', 'Current WaveTrend band dots across 66 Kraken 4h USD pairs.');
    paidTool('get_regime', 'Stage 1 regime detail', '/api/regime', 'GET', '0.01', 'Stage 1 crypto regime check with raw values and rules.');
    paidTool('get_coin', 'WaveTrend for one coin', '/api/coin/{symbol}', 'GET', '0.005', 'WaveTrend 4h snapshot for one coin.', { symbol: z.enum(COINS) }, a => `/api/coin/${a.symbol}`);
    paidTool('get_history', 'Band-dot history + hit rates', '/api/history', 'GET', '0.05', 'Rolling 90-day band-dot backtest with forward moves and live hit rates (green dots carry the edge; red near coin-flip).', { pair: z.enum(COINS).optional() }, a => a.pair ? `/api/history?pair=${a.pair}` : '/api/history');
    paidTool('get_token_verdict', 'Token safety verdict', '/api/verdict/{chain}/{address}', 'GET', '0.02', 'Is this token safe? Score 0-100, safe/caution/danger, reasons, sources (GoPlus + DexScreener, fixed rules).', { chain: z.enum(Object.keys(VERDICT_CHAINS)), address: z.string() }, a => `/api/verdict/${a.chain}/${a.address}`);
    paidTool('get_flows', 'Large-print flows + dot state', '/api/flows/{symbol}', 'GET', '0.02', 'Kraken large-print buy/sell summary (single venue, not on-chain) joined with WaveTrend 4h state.', { symbol: z.enum(COINS) }, a => `/api/flows/${a.symbol}`);
    paidTool('get_daily_brief', 'Daily brief', '/api/brief', 'GET', '0.05', 'Once-per-day brief: regime, dot counts, top 10 coins by dot strength, BTC/ETH/SOL flows.');
    m.registerTool('get_signing_pubkey', { title: 'Response-signing public key', description: 'Free: Ed25519 public key and scheme for verifying X-GW8-Signature on paid responses.', inputSchema: {} }, async () => txt(publicKeyInfo()));
    return m;
}
app.post('/mcp', async (req, res) => {
    try {
        const server = buildMcp();
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
    name: 'gw8-crypto-signal', title: 'GW8 Crypto Regime + WaveTrend Signal', version: '1.1.0',
    description: 'Crypto market signals for AI agents: Stage 1 regime + WaveTrend band dots on 66 Kraken 4h pairs. Free sample; paid endpoints via x402 (USDC on Base). Signal only, no trading.',
    transport: { type: 'streamable-http', url: `${ORIGIN}/mcp` },
    tools: ['get_sample', 'list_paid_endpoints', 'get_full_signal', 'get_band_dots', 'get_regime', 'get_coin', 'get_history'],
    payment: { protocol: 'x402', version: 2, network: 'eip155:8453', asset: 'USDC', openapi: `${ORIGIN}/openapi.json` }
}));

// 3. Ingestion Route
app.post('/api/ingest', (req, res) => {
    const authHeader = req.headers['x-ingest-key'] || req.headers['authorization'];
    if (!INGEST_SECRET || (authHeader !== INGEST_SECRET && authHeader !== `Bearer ${INGEST_SECRET}`)) {
        return res.status(401).json({ error: "Unauthorized ingestion" });
    }

    const { symbol, price, metrics, signal, timestamp } = req.body;
    if (!symbol) return res.status(400).json({ error: "Missing symbol in payload" });

    telemetryStore[symbol] = {
        symbol,
        price,
        metrics,
        signal,
        timestamp: timestamp || Math.floor(Date.now() / 1000),
        updatedAt: new Date().toISOString()
    };

    res.json({ status: "success", symbol, receivedAt: telemetryStore[symbol].updatedAt });
});

// Helper: Manual TX Fallback
async function verifyManualUsdcTx(txHash) {
    if (processedTxs.has(txHash)) return { valid: false, reason: "Tx hash already spent" };
    try {
        const provider = getProvider();
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return { valid: false, reason: "Tx not found or failed" };

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase()) continue;
            try {
                const parsed = erc20Interface.parseLog(log);
                if (parsed && parsed.name === 'Transfer') {
                    const [from, to, value] = parsed.args;
                    const amountUsdc = parseFloat(formatUnits(value, 6));
                    if (to.toLowerCase() === VAULT_ADDRESS.toLowerCase() && amountUsdc >= 0.02) {
                        processedTxs.add(txHash);
                        return { valid: true, amount: amountUsdc, sender: from };
                    }
                }
            } catch (e) {}
        }
        return { valid: false, reason: "No matching USDC transfer to vault found" };
    } catch (err) {
        return { valid: false, reason: "RPC error verifying transaction" };
    }
}

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

// 4. Primary x402 v2 Handler
async function handleX402Agent(req, res, product = null) {
    const deliver = product ? product.deliver : safeSignal;
    const authHeader = req.headers['authorization'];
    const paymentSigHeader = req.headers['payment-signature'] || req.headers['x-payment'];
    const legacyTx = req.headers['x-payment-tx'] || req.query.tx;
    const requestedSymbol = req.body?.pair || req.query?.symbol || 'BTC/USD';
    const telemetry = telemetryStore[requestedSymbol] || telemetryStore['BTC/USD'];

    // VIP Bypass
    if (VIP_TOKEN && VIP_TOKEN.length >= 24 && authHeader === `Bearer ${VIP_TOKEN}`) {
        return res.json({
            status: 'success',
            accessType: 'VIP_BYPASS',
            timestamp: new Date().toISOString(),
            signal: await deliver()
        });
    }

    // PRIMARY PATH: x402 v2 EIP-3009 Signature Verification via CDP Facilitator
    if (paymentSigHeader) {
        if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
            console.error("[CDP FACILITATOR] KEYS_MISSING: CDP_API_KEY_ID or CDP_API_KEY_SECRET not set on Render.");
            return res.status(500).json({ error: "Facilitator Configuration Error", code: "KEYS_MISSING" });
        }

        try {
            const paymentPayload = decodePaymentPayload(paymentSigHeader);
            const challenge = getX402ChallengeV2();
            const paymentRequirements = getX402ChallengeV2(product || {}).accepts[0];

            const facilitatorBody = {
                x402Version: 2,
                paymentPayload,
                paymentRequirements
            };

            const verifyJwt = generateCdpJwt('POST', '/platform/v2/x402/verify');
            const verifyRes = await fetch(`${CDP_FACILITATOR_URL}/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${verifyJwt}`
                },
                body: JSON.stringify(facilitatorBody)
            });

            if (verifyRes.ok) {
                const settleJwt = generateCdpJwt('POST', '/platform/v2/x402/settle');
                const settleRes = await fetch(`${CDP_FACILITATOR_URL}/settle`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${settleJwt}`
                    },
                    body: JSON.stringify(facilitatorBody)
                });
                const settleData = await settleRes.json().catch(() => ({}));
                if (!settleRes.ok || settleData.success === false) {
                    console.error("[CDP FACILITATOR] settle failed", settleRes.status, settleData.errorReason);
                    return res.status(402).json({ error: "Payment settlement failed", reason: settleData.errorReason || settleRes.status });
                }

                return res
                    .set('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settleData)).toString('base64'))
                    .json({
                        status: 'success',
                        accessType: 'X402_FACILITATOR_SETTLED',
                        settlement: settleData,
                        timestamp: new Date().toISOString(),
                        signal: await deliver()
                    });
            } else {
                const verifyErr = await verifyRes.text();
                return res.status(400).json({ error: "Payment verification failed", details: verifyErr });
            }
        } catch (err) {
            console.error("[CDP FACILITATOR ERROR]", err);
            return res.status(500).json({ error: "Internal Facilitator Error" });
        }
    }

    // FALLBACK ONLY: Manual Transfer Hash Check
    if (legacyTx && !product) {
        const manualCheck = await verifyManualUsdcTx(legacyTx);
        if (manualCheck.valid) {
            return res.json({
                status: 'success',
                accessType: 'MANUAL_TX_FALLBACK',
                txHash: legacyTx,
                amountPaid: manualCheck.amount,
                timestamp: new Date().toISOString(),
                signal: await deliver()
            });
        }
        return res.status(400).json({ error: "Invalid Payment", reason: manualCheck.reason });
    }

    // PRIMARY CHALLENGE: 402 Payment Required (x402 Version 2)
    const challenge = getX402ChallengeV2(product || {});
    const challengeBase64 = Buffer.from(JSON.stringify(challenge)).toString('base64');

    return res.status(402)
        .set('PAYMENT-REQUIRED', challengeBase64)
        .set('X-402-Pay-To', VAULT_ADDRESS)
        .set('X-402-Amount-USDC', product ? String(Number(product.amount) / 1e6) : '0.02')
        .set('X-402-Chain', 'eip155:8453')
        .json(challenge);
}

// Free live sample (no payment)
app.get('/api/sample', async (req, res) => {
    try { res.json(await buildSample()); }
    catch (e) { res.status(503).json({ error: 'upstream data unavailable, retry shortly' }); }
});

app.use(['/api/agent', '/api/telemetry', '/api/dots', '/api/history', '/api/regime', '/api/coin', '/api/verdict', '/api/flows', '/api/brief'], signResponses);
app.all('/api/agent', handleX402Agent);
app.all('/api/telemetry', handleX402Agent);

// Cheaper single-purpose products (signal only)
const BASE_URL = 'https://micro-saas-agent.onrender.com';
app.get('/api/dots', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/dots`, amount: "10000", name: "GW8 WaveTrend Band Dots (66 Kraken pairs, 4h)",
    description: "Every LazyBear WaveTrend 10/21/4 oversold/overbought band cross (green<=-53, red>=+53) in the last 6 closed 4h bars across 66 Kraken USD pairs. $0.01.",
    example: { asOf: "2026-10-17T20:00:00Z", bandDots: [{ name: "LINK", kind: "green", band: "inner", wt1: -54.8, bar: "2026-10-17T16:00:00.000Z", close: 11.2 }] },
    deliver: getDots
}));
app.get('/api/history', (req, res) => {
    const pair = req.query.pair ? String(req.query.pair).toUpperCase().replace(/\/USD$/, '') : null;
    if (pair && !COINS.includes(pair)) return res.status(404).json({ error: 'unknown pair', supported: COINS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/history`, amount: "50000", name: "GW8 WaveTrend Band-Dot History + Hit Rates (90d, 66 pairs)",
        description: "Rolling 90-day backtest of WaveTrend 10/21/4 band dots on 66 Kraken 4h USD pairs, recomputed live. Green dots carry the edge (recent window: outer green dots ~64% higher after 3d); red dots are near coin-flip and reported honestly. Per dot: pair, green/red, inner/outer, wt1/wt2, price, forward % +4h/+24h/+3d, plus live hit-rate summary. Optional ?pair=BTC. $0.05.",
        example: { window: "90 days", summary: { green_all: { fwd24hPct: { n: 120, hitRatePct: 55.0, avgMovePct: 0.8 } } }, dots: [{ pair: "LINK/USD", kind: "green", band: "inner", bar: "2026-10-17T16:00:00.000Z", wt1: -54.8, wt2: -48.6, close: 11.2, fwd4hPct: 0.6, fwd24hPct: null, fwd3dPct: null }] },
        inputProps: { pair: { type: "string", description: "Optional coin symbol, e.g. BTC", example: "BTC" } },
        deliver: () => getHistory(pair)
    });
});
app.get('/api/regime', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/regime`, amount: "10000", name: "GW8 Stage 1 Crypto Regime Check (detail)",
    description: "Stage 1 crypto market regime score 0-4 with full detail: BTC spot ETF 3-day net flow (Farside), BTC quiet support vs 20-day low, alt breadth (ETH/SOL/LINK/XRP), Fear & Greed / weekend pump. Raw values and rules. $0.01.",
    example: { score: 3, outOf: 4, checks: { btcQuietSupport: { status: "pass", detail: { pctAboveLow: 2.1, avgRange3dPct: 2.4 }, rule: "..." } } },
    deliver: getRegime
}));
app.get('/api/coin/:symbol', (req, res) => {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!COINS.includes(sym)) return res.status(404).json({ error: 'unknown symbol', supported: COINS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/coin/${sym}`, amount: "5000", name: `GW8 WaveTrend 4h: ${sym}/USD`,
        description: `LazyBear WaveTrend 10/21/4 on Kraken 4h for ${sym}/USD: wt1, wt2, previous values, recent band dots. $0.005.`,
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
        url: `${BASE_URL}/api/verdict/${chain}/${address}`, amount: "20000", name: "GW8 Token Safety Verdict (GoPlus + DexScreener)",
        description: "Is this token safe? Score 0-100 and verdict safe/caution/danger with reasons and source URLs, from GoPlus token security + DexScreener liquidity using fixed published rules. Chains: base, ethereum, bsc, arbitrum, solana. 10-min cache. $0.02.",
        example: { chain: "base", address: "0x...", score: 85, verdict: "safe", reasons: ["-15: mintable"], sources: ["https://api.gopluslabs.io/...", "https://api.dexscreener.com/..."] },
        deliver: () => getVerdict(chain, address).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});
app.get('/api/flows/:symbol', (req, res) => {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!COINS.includes(sym)) return res.status(404).json({ error: 'unknown symbol', supported: COINS });
    return handleX402Agent(req, res, {
        url: `${BASE_URL}/api/flows/${sym}`, amount: "20000", name: `GW8 Large-Print Flows + WaveTrend: ${sym}/USD`,
        description: `Large-print buy vs sell summary for ${sym}/USD from Kraken public trades (last 1000 prints; single venue, not on-chain whale wallets) joined with WaveTrend 10/21/4 4h state. $0.02.`,
        example: { symbol: sym, flows: { largePrints: { count: 12, buyUsd: 420000, sellUsd: 180000, netUsd: 240000 }, bias: "large buyers dominant" }, wavetrend: { wt1: -41.2, wt2: -38.9, zone: "neutral" } },
        deliver: () => getFlows(sym).catch(() => ({ error: 'upstream data unavailable, retry shortly' }))
    });
});
app.get('/api/brief', (req, res) => handleX402Agent(req, res, {
    url: `${BASE_URL}/api/brief`, amount: "50000", name: "GW8 Daily Crypto Brief",
    description: "Once-per-day (Mountain Time) brief: Stage 1 regime, band-dot counts, top 10 coins by WaveTrend dot strength, BTC/ETH/SOL Kraken large-print flows, with honest notes. $0.05.",
    example: { date: "2026-10-17", regime: { score: 3, outOf: 4 }, dots: { green: 5, red: 2 }, top10ByDotStrength: [{ name: "LINK", kind: "green", strength: 68.5 }], flowsSummary: [{ symbol: "BTC", bias: "balanced" }] },
    deliver: getBrief
}));

app.listen(PORT, () => {
    console.log(`GW8 Capital x402 v2 Gateway online on port ${PORT}`);
});
