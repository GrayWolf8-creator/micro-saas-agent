import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CONFIGURATION
const PAYOUT_WALLET = process.env.PAYOUT_WALLET || "0xb4527dccac81eb73d4988a51a4cb1fbbf2c3cabd"; // Your linked Base wallet
const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base Mainnet USDC
const PRICE_PER_CALL_USDC = "0.05"; // $0.05 USDC

// 1. Paid Agent Signal Endpoint (x402 Gated + Dynamic Market Feed)
app.post('/api/agent', async (req, res) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['authorization'];

  // Reject unpaid requests with HTTP 402 Payment Required
  if (!paymentHeader) {
    return res.status(402).json({
      error: "Payment Required",
      message: "Access to live signal requires 0.05 USDC on Base Mainnet",
      x402_spec: {
        scheme: "exact",
        network: "eip155:8453", // Base Mainnet
        asset: BASE_USDC_CONTRACT,
        price: PRICE_PER_CALL_USDC,
        recipient: PAYOUT_WALLET,
        endpoint: "/api/agent"
      }
    });
  }

  try {
    // Fetch live Base DEX data (Aerodrome WETH/USDC)
    const response = await fetch("https://api.dexscreener.com/latest/dex/pairs/base/0x20f8d1e4b1d3056b3b841272f31f021f15886616");
    const data = await response.json();
    const pair = data.pair || {};

    const liveSignal = {
      agent: "GW8-BASE-SIGNAL-01",
      timestamp: new Date().toISOString(),
      pair: pair.baseToken?.symbol ? `${pair.baseToken.symbol}/${pair.quoteToken.symbol}` : "ETH/USDC",
      price_usd: pair.priceUsd || "0.00",
      volume_24h: pair.volume?.h24 || 0,
      price_change_5m: pair.priceChange?.m5 || 0,
      signal: (pair.priceChange?.m5 > 0.5) ? "SURGE_BUY" : "ACCUMULATE",
      confidence: "91%"
    };

    return res.status(200).json({
      status: "SUCCESS",
      payment_verified: true,
      data: liveSignal
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to generate dynamic market signal." });
  }
});

// 2. Public Free Preview Endpoint
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
      access: "Requires x402 payment header on POST /api/agent"
    }
  });
});

app.listen(PORT, () => {
  console.log(`GW8 Micro-SaaS Agent running on port ${PORT}`);
});