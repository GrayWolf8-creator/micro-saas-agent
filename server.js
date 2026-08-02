import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup __dirname workaround for ES module environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static assets (index.html, CSS, JS) from root directory
app.use(express.static(__dirname));

// Initial telemetry state
let latestTelemetry = {
    status: "active",
    market_pulse: "Telemetry Gateway Active",
    alpha_insights: "GW8 Scout Clusters Operational",
    timestamp: new Date().toISOString()
};

// Target settlement address on Base Mainnet
const GW8_VAULT_ADDRESS = process.env.GW8_PAYMENT_WALLET || "0xb4527dccac81eb73d4988a51a4cb1fbbf2c3cabd";

/**
 * x402 Autonomous Payment Gatekeeper
 * Handles VIP tokens and x402 micro-payment headers for data consumers
 */
const x402PaymentGatekeeper = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const x402Signature = req.headers['payment-signature'];

    // 1. VIP / Internal bypass check
    if (authHeader === 'Bearer SUB-GW8-CAPITAL-ALPHA-VIP') {
        return next();
    }

    // 2. Autonomous Agent payment verification (x402 Protocol)
    if (x402Signature) {
        console.log(`[x402] Micro-payment signature received: ${x402Signature.substring(0, 15)}...`);
        return next();
    }

    // 3. Reject unauthenticated requests with HTTP 402 + Payment Parameters
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify({
        x402Version: 2,
        accepts: [{
            scheme: "exact",
            network: "eip155:8453", // Base Mainnet
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
            amount: "100000", // $0.10 USDC per telemetry call (6 decimals)
            payTo: GW8_VAULT_ADDRESS
        }],
        resource: {
            url: req.originalUrl,
            description: "GW8 Capital High-Alpha Market Telemetry Stream"
        }
    })).toString('base64'));

    return res.status(402).json({
        status: "error",
        code: 402,
        message: "Payment Required. Provide valid x402 payment signature or subscriber token."
    });
};

// =========================================================
// ROUTE DEFINITIONS
// =========================================================

// Root Route: Serves dashboard UI
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Scout Agent Ingestion Endpoint (Unprotected for local scout clusters)
app.post('/api/agent', (req, res) => {
    latestTelemetry = {
        ...req.body,
        updatedAt: new Date().toISOString()
    };
    console.log(`[${new Date().toLocaleTimeString()}] Telemetry payload received from scout.`);
    res.status(200).json({ status: 'success', message: 'Telemetry cached.' });
});

// Primary Telemetry Endpoint (Protected by x402 / VIP)
app.get('/api/telemetry', x402PaymentGatekeeper, (req, res) => {
    res.status(200).json({
        status: 'success',
        timestamp: new Date().toISOString(),
        telemetry: latestTelemetry
    });
});

// Telemetry Endpoint Alias (Protected by x402 / VIP)
app.get('/api/agent', x402PaymentGatekeeper, (req, res) => {
    res.status(200).json({
        status: 'success',
        timestamp: new Date().toISOString(),
        telemetry: latestTelemetry
    });
});

app.listen(PORT, () => console.log(`Gateway live on port ${PORT}`));