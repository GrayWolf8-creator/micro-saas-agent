import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration & Envs ---
const PORT = process.env.PORT || 10000;
const PAYOUT_WALLET = "0xb4527dccac81eb73d4988a51a4cb1fbbf2c3cabd";
const SUBSCRIBER_KEY = process.env.SUBSCRIBER_KEY || "SUB-GW8-CAPITAL-ALPHA-VIP";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// Base Mainnet USDC Contract
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_EVENT_TOPIC = ethers.id("Transfer(address,address,uint256)");

const STANDARD_PRICE = "0.05";
const PRO_PRICE = "0.25";

// Shared RPC Provider
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);

// Dual-Tier Telemetry Store
let telemetryStore = {
  standard: { timestamp: null, data: "No telemetry pushed yet." },
  pro: { timestamp: null, data: "No alpha telemetry pushed yet." }
};

// --- Helper: On-Chain Settlement Verifier ---
async function verifyPaymentOnChain(txHash, requiredAmount) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || !receipt.status) return false;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
        if (log.topics[0] === TRANSFER_EVENT_TOPIC) {
          const toAddress = ethers.dataSlice(log.topics[2], 12);
          if (toAddress.toLowerCase() === PAYOUT_WALLET.toLowerCase()) {
            const amountBN = ethers.BigNumber ? ethers.BigNumber.from(log.data) : BigInt(log.data);
            const amountUSDC = Number(amountBN) / 1e6;
            
            if (amountUSDC >= parseFloat(requiredAmount)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  } catch (err) {
    console.error("RPC Verification Error:", err.message);
    return false;
  }
}

// --- Helper: Dual-Auth Check ---
async function validateAccess(authHeader, paymentHash, price) {
  if (authHeader === `Bearer ${SUBSCRIBER_KEY}`) {
    return { authorized: true, method: "Subscriber Key" };
  }
  if (paymentHash) {
    const paid = await verifyPaymentOnChain(paymentHash, price);
    if (paid) return { authorized: true, method: "On-Chain USDC Settlement" };
  }
  return { authorized: false };
}

// --- Routes ---

// 1. Landing Page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// 2. Discovery Manifest
app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: "GW8 Capital Telemetry Gateway",
    version: "2.0.0",
    description: "Autonomous micro-SaaS agent gateway providing dual-tiered market signals on Base Mainnet.",
    payment_recipient: PAYOUT_WALLET,
    tiers: {
      standard: { endpoint: "/api/agent", price: "0.05 USDC" },
      pro_alpha: { endpoint: "/api/agent/alpha", price: "0.25 USDC" }
    }
  });
});

// 3. Free Preview Teaser
app.get('/api/preview', (req, res) => {
  res.json({
    status: "online",
    gateway: "GW8 Capital Agent Engine",
    last_updated: telemetryStore.standard.timestamp || telemetryStore.pro.timestamp || "N/A",
    teaser: "Active market pulse detected. Connect x402 payment headers for full stream."
  });
});

// 4. Scout Ingestion Route
app.post('/api/telemetry/update', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${SUBSCRIBER_KEY}`) {
    return res.status(401).json({ error: "Unauthorized scout payload" });
  }

  const { tier, signal } = req.body;

  if (tier === 'pro') {
    telemetryStore.pro = { timestamp: new Date().toISOString(), data: signal };
  } else {
    telemetryStore.standard = { timestamp: new Date().toISOString(), data: signal };
  }

  res.json({ status: "success", updated_tier: tier || "standard" });
});

// 5. Standard Tier Endpoint (0.05 USDC / call)
app.post('/api/agent', async (req, res) => {
  const auth = await validateAccess(req.headers.authorization, req.headers['x-payment-hash'], STANDARD_PRICE);
  
  if (!auth.authorized) {
    return res.status(402).json({
      error: "Payment Required",
      tier: "Standard",
      price: `${STANDARD_PRICE} USDC`,
      settlement_chain: "Base Mainnet (8453)",
      recipient: PAYOUT_WALLET,
      instructions: "Pass x-payment-hash header with valid Base USDC transfer tx or Bearer auth token."
    });
  }

  res.json({
    tier: "Standard",
    auth_method: auth.method,
    timestamp: telemetryStore.standard.timestamp,
    telemetry: telemetryStore.standard.data
  });
});

// 6. Pro Alpha Tier Endpoint (0.25 USDC / call)
app.post('/api/agent/alpha', async (req, res) => {
  const auth = await validateAccess(req.headers.authorization, req.headers['x-payment-hash'], PRO_PRICE);
  
  if (!auth.authorized) {
    return res.status(402).json({
      error: "Payment Required for Alpha Feed",
      tier: "Pro Alpha",
      price: `${PRO_PRICE} USDC`,
      settlement_chain: "Base Mainnet (8453)",
      recipient: PAYOUT_WALLET,
      instructions: "Pass x-payment-hash header with valid Base USDC transfer tx or Bearer auth token."
    });
  }

  res.json({
    tier: "Pro Alpha",
    auth_method: auth.method,
    timestamp: telemetryStore.pro.timestamp,
    telemetry: telemetryStore.pro.data
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`GW8 Capital Gateway running on port ${PORT}`);
});