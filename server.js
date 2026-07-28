import express from 'express';
import { ethers } from 'ethers';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CONFIGURATION
const PAYOUT_WALLET = "0xb4527dccac81eb73d4988a51a4cb1fbbf2c3cabd".toLowerCase();
const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase(); // Base Mainnet USDC
const PRICE_PER_CALL_USDC = "0.05";
const BASE_RPC_URL = "https://mainnet.base.org";

// Base Mainnet Provider
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);

// ERC-20 Transfer Event Signature (Transfer(address,address,uint256))
const TRANSFER_EVENT_TOPIC = ethers.id("Transfer(address,address,uint256)");

// Global Signal Memory
let currentSignal = {
  agent: "GW8-BASE-SIGNAL-01",
  status: "ACTIVE",
  pair: "ETH/USDC",
  signal: "ACCUMULATE",
  confidence: "91%",
  timestamp: new Date().toISOString()
};

// On-Chain Transaction Verification Function
async function verifyBasePayment(txHash) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return false;

    // Check transaction logs for USDC Transfer to PAYOUT_WALLET
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === BASE_USDC_CONTRACT) {
        if (log.topics[0] === TRANSFER_EVENT_TOPIC) {
          const toAddress = ethers.hexZeroPadTo32(log.topics[2]).toLowerCase();
          const recipientPadded = ethers.hexZeroPadTo32(PAYOUT_WALLET).toLowerCase();

          if (toAddress === recipientPadded) {
            // USDC has 6 decimals on Base
            const amount = ethers.formatUnits(log.data, 6);
            if (parseFloat(amount) >= parseFloat(PRICE_PER_CALL_USDC)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  } catch (err) {
    console.error("[RPC VERIFY ERROR]", err.message);
    return false;
  }
}

// 1. Agent Manifest
app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    schema_version: "1.0.0",
    name: "GW8 Base Signal Agent",
    description: "Delivers real-time DEX relative volume surge and momentum signals for Base Mainnet tokens.",
    image: "https://micro-saas-agent.onrender.com/logo.png",
    provider: { name: "GW8 Capital", url: "https://micro-saas-agent.onrender.com" },
    payment_model: "x402",
    pricing: {
      amount: PRICE_PER_CALL_USDC,
      currency: "USDC",
      chain: "Base Mainnet (eip155:8453)",
      recipient: PAYOUT_WALLET
    },
    endpoints: [
      { path: "/api/agent", method: "POST", requires_payment: true },
      { path: "/api/preview", method: "GET", requires_payment: false }
    ]
  });
});

// 2. Paid Agent Signal Endpoint (On-Chain RPC Verification + Subscriber Bypass)
app.post('/api/agent', async (req, res) => {
  const paymentHeader = 
    req.get('x-payment') || 
    req.get('payment-signature') || 
    req.get('x-402-payment') ||
    req.body?.payment_proof;

  const authHeader = req.get('authorization');
  const isSubscriber = authHeader === 'Bearer GW8_SUBSCRIBER_KEY';

  // If Subscriber Key is used, grant immediate access
  if (isSubscriber) {
    return res.status(200).json({
      status: "SUCCESS",
      payment_verified: true,
      auth_type: "SUBSCRIBER_KEY_BYPASS",
      data: currentSignal
    });
  }

  // If no payment header/hash provided, reject with 402
  if (!paymentHeader) {
    return res.status(402).json({
      error: "Payment Required",
      message: "Access requires 0.05 USDC on Base Mainnet or valid subscriber authorization",
      x402_spec: {
        recipient: PAYOUT_WALLET,
        amount: PRICE_PER_CALL_USDC,
        currency: "USDC",
        chain_id: 8453,
        token_address: BASE_USDC_CONTRACT
      }
    });
  }

  // Verify transaction hash on Base Mainnet RPC
  console.log(`[VERIFYING TX] Checking hash: ${paymentHeader}`);
  const isValidOnChain = await verifyBasePayment(paymentHeader);

  if (isValidOnChain) {
    return res.status(200).json({
      status: "SUCCESS",
      payment_verified: true,
      tx_hash: paymentHeader,
      data: currentSignal
    });
  } else {
    return res.status(402).json({
      error: "Payment Verification Failed",
      message: "Provided transaction hash was invalid, unconfirmed, or did not meet payment criteria on Base Mainnet."
    });
  }
});

// 3. Public Free Preview Endpoint
app.get('/api/preview', (req, res) => {
  res.json({
    status: "ACTIVE",
    agent_id: "GW8-BASE-SIGNAL-01",
    network: "Base Mainnet (8453)",
    price_per_call: `${PRICE_PER_CALL_USDC} USDC`,
    payment_receiver: PAYOUT_WALLET,
    preview: {
      market_condition: "RVOL_MOMENTUM_SURGE",
      confidence: "91%",
      access: "Requires valid tx_hash header or subscriber key on POST /api/agent"
    }
  });
});

// 4. Internal Fleet Update Route
app.post('/api/update-signal', (req, res) => {
  const fleetKey = req.headers['x-gw8-key'];
  if (process.env.FLEET_SECRET_KEY && fleetKey !== process.env.FLEET_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized fleet key" });
  }

  currentSignal = req.body;
  console.log(`[FLEET UPDATE] New signal cached for ${currentSignal.pair || currentSignal.symbol || 'ASSET'}`);
  return res.status(200).json({ status: "Signal cached successfully" });
});

// Start Server
app.listen(PORT, () => {
  console.log(`GW8 Micro-SaaS Agent running on port ${PORT}`);
});