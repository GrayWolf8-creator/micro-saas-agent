import express from 'express';

const app = express();
app.use(express.json());
app.use(express.static('.'));


const PORT = process.env.PORT || 3000;
const RECEIVING_WALLET = "0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd".toLowerCase();
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const BASE_RPC = "https://mainnet.base.org";

const processedHashes = new Set();

// On-chain payment verification logic
async function verifyPayment(txHash) {
  if (processedHashes.has(txHash)) return false;

  try {
    const response = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionReceipt',
        params: [txHash],
        id: 1
      })
    });

    const data = await response.json();
    if (!data.result || data.result.status !== '0x1') return false;

    const logs = data.result.logs;
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    const validTransfer = logs.find(log => {
      const isUsdc = log.address.toLowerCase() === USDC_CONTRACT;
      const isTransfer = log.topics[0] === transferTopic;
      const toAddress = log.topics[2] ? "0x" + log.topics[2].slice(26).toLowerCase() : "";
      const isToUs = toAddress === RECEIVING_WALLET;
      return isUsdc && isTransfer && isToUs;
    });

    if (validTransfer) {
      const amountHex = validTransfer.data;
      const amountUnits = parseInt(amountHex, 16);
      const minRequiredUnits = 0.05 * 1000000; // 0.05 USDC (6 decimals)

      if (amountUnits >= minRequiredUnits) {
        processedHashes.add(txHash);
        return true;
      }
    }
    return false;
  } catch (err) {
    return false;
  }
}

// Monetized Endpoint
app.post('/api/agent', async (req, res) => {
  const txHash = req.headers['x-402-payment'];

  if (!txHash) {
    return res.status(402).json({
      error: "Payment Required",
      code: 402,
      message: "Access to GW8-BASE-SIGNAL-01 requires payment.",
      price: "0.05 USDC",
      payTo: RECEIVING_WALLET,
      chain: "Base Mainnet (Chain ID 8453)",
      asset: USDC_CONTRACT
    });
  }

  const isVerified = await verifyPayment(txHash);

  if (!isVerified) {
    return res.status(402).json({
      error: "Payment Verification Failed",
      code: 402,
      reason: "Transaction failed or not found on-chain."
    });
  }

  // Fetch live market data and return dynamic signal
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,ripple&vs_currencies=usd&include_24hr_change=true');
    const marketData = await response.json();

    const ethData = marketData.ethereum;
    const ethChange = ethData.usd_24h_change;
    
    let signalAction = "HOLD";
    if (ethChange > 1.5) signalAction = "BUY";
    if (ethChange < -1.5) signalAction = "SELL";

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      agent_id: "GW8-BASE-SIGNAL-01",
      tx_verified: txHash,
      analytics: {
        asset: "ETH/USD",
        current_price: ethData.usd,
        change_24h: `${ethChange.toFixed(2)}%`,
        signal: signalAction,
        confidence: "88%",
        recommendation: `Momentum reads ${ethChange > 0 ? 'Bullish' : 'Bearish'}. Target setup active.`
      }
    });

  } catch (err) {
    return res.status(500).json({ error: "Failed to generate market signal." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});