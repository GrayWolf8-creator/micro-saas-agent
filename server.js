import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Interface, formatUnits } from 'ethers';

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
const INGEST_SECRET = process.env.INGEST_SECRET || 'gw8-secret-scout-cluster-key';
const VIP_TOKEN = process.env.VIP_TOKEN || 'SUB-GW8-CAPITAL-ALPHA-SECURE';

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

// Official x402 Version 2 + Bazaar Discovery Spec
function getX402ChallengeV2() {
    return {
        x402Version: 2,
        error: "PAYMENT_REQUIRED",
        resource: {
            url: RESOURCE_URL,
            description: "Live momentum signal: RSI(14), Bollinger %B, BUY/HOLD/SELL, confidence",
            mimeType: "application/json"
        },
        accepts: [
            {
                scheme: "exact",
                network: "eip155:8453",
                amount: "50000", // 0.05 USDC (6 decimals)
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
                    type: "object",
                    properties: {
                        pair: {
                            type: "string",
                            enum: ["BTC/USD", "ONDO/USD", "XPR/USD"],
                            default: "BTC/USD"
                        }
                    }
                },
                info: {
                    name: "GW8 Base Market Signal Agent",
                    description: "Real-time BTC/USD momentum signal, RSI(14), and Bollinger Band regime confirmation for autonomous trading agents.",
                    input: {
                        type: "http",
                        method: "POST",
                        body: {
                            type: "object",
                            properties: {
                                pair: {
                                    type: "string",
                                    enum: ["BTC/USD", "ONDO/USD", "XPR/USD"],
                                    default: "BTC/USD"
                                }
                            }
                        }
                    },
                    output: {
                        example: {
                            status: "success",
                            telemetry: {
                                symbol: "BTC/USD",
                                price: 63881,
                                metrics: {
                                    rsi_14: 50,
                                    sma_20: 63881,
                                    bb_upper: 63881,
                                    bb_lower: 63881
                                },
                                signal: "NEUTRAL_CONSOLIDATION",
                                timestamp: 1786526256,
                                updatedAt: "2026-08-27T02:18:00.000Z"
                            }
                        }
                    }
                }
            }
        }
    };
}

// 1. Root Landing Page
app.get('/', (req, res) => {
    res.json({
        service: "GW8 Base Signal Agent API",
        status: "ONLINE",
        protocol: "x402 v2",
        price: "0.05 USDC",
        leadAsset: "BTC/USD",
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

// 3. Ingestion Route
app.post('/api/ingest', (req, res) => {
    const authHeader = req.headers['x-ingest-key'] || req.headers['authorization'];
    if (authHeader !== INGEST_SECRET && authHeader !== `Bearer ${INGEST_SECRET}`) {
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
                    if (to.toLowerCase() === VAULT_ADDRESS.toLowerCase() && amountUsdc >= 0.05) {
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

// 4. Primary x402 v2 Handler
async function handleX402Agent(req, res) {
    const authHeader = req.headers['authorization'];
    const paymentSig = req.headers['payment-signature'] || req.headers['x-payment'];
    const legacyTx = req.headers['x-payment-tx'] || req.query.tx;
    const requestedSymbol = req.body?.pair || req.query?.symbol || 'BTC/USD';
    const telemetry = telemetryStore[requestedSymbol] || telemetryStore['BTC/USD'];

    // VIP Bypass
    if (authHeader === `Bearer ${VIP_TOKEN}`) {
        return res.json({
            status: 'success',
            accessType: 'VIP_BYPASS',
            timestamp: new Date().toISOString(),
            telemetry
        });
    }

    // PRIMARY PATH: x402 v2 EIP-3009 Signature Verification via CDP Facilitator
    if (paymentSig) {
        if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
            console.error("[CDP FACILITATOR] KEYS_MISSING: CDP_API_KEY_ID or CDP_API_KEY_SECRET not set on Render.");
            return res.status(500).json({ error: "Facilitator Configuration Error", code: "KEYS_MISSING" });
        }

        try {
            const verifyRes = await fetch(`${CDP_FACILITATOR_URL}/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.CDP_API_KEY_SECRET}`
                },
                body: JSON.stringify({
                    payment: paymentSig,
                    resource: RESOURCE_URL
                })
            });

            if (verifyRes.ok) {
                const settleRes = await fetch(`${CDP_FACILITATOR_URL}/settle`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.CDP_API_KEY_SECRET}`
                    },
                    body: JSON.stringify({ payment: paymentSig })
                });
                const settleData = await settleRes.json();

                return res
                    .set('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settleData)).toString('base64'))
                    .json({
                        status: 'success',
                        accessType: 'X402_FACILITATOR_SETTLED',
                        settlement: settleData,
                        timestamp: new Date().toISOString(),
                        telemetry
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
    if (legacyTx) {
        const manualCheck = await verifyManualUsdcTx(legacyTx);
        if (manualCheck.valid) {
            return res.json({
                status: 'success',
                accessType: 'MANUAL_TX_FALLBACK',
                txHash: legacyTx,
                amountPaid: manualCheck.amount,
                timestamp: new Date().toISOString(),
                telemetry
            });
        }
        return res.status(400).json({ error: "Invalid Payment", reason: manualCheck.reason });
    }

    // PRIMARY CHALLENGE: 402 Payment Required (x402 Version 2)
    const challenge = getX402ChallengeV2();
    const challengeBase64 = Buffer.from(JSON.stringify(challenge)).toString('base64');

    return res.status(402)
        .set('PAYMENT-REQUIRED', challengeBase64)
        .set('X-402-Pay-To', VAULT_ADDRESS)
        .set('X-402-Amount-USDC', '0.05')
        .set('X-402-Chain', 'eip155:8453')
        .json(challenge);
}

app.all('/api/agent', handleX402Agent);
app.all('/api/telemetry', handleX402Agent);

app.listen(PORT, () => {
    console.log(`GW8 Capital x402 v2 Gateway online on port ${PORT}`);
});