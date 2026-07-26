import express from 'express';

const app = express();
app.use(express.json());

// YOUR CONFIGURATION
const RECEIVING_WALLET = "0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd".toLowerCase();
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase();
const REQUIRED_PRICE_USDC = 0.05;

// Memory cache for processed transaction hashes
const processedHashes = new Set();

/**
 * Direct RPC Call to Base Mainnet to verify transaction receipt
 */
async function verifyBasePayment(txHash) {
  if (processedHashes.has(txHash)) {
    return { valid: false, reason: "Transaction hash already used." };
  }

  try {
    const response = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [txHash]
      })
    });

    const data = await response.json();
    const receipt = data.result;

    if (!receipt || receipt.status !== '0x1') {
      return { valid: false, reason: "Transaction failed or not found on-chain." };
    }

    // Filter logs for USDC Transfer event topic
    const transferLogs = receipt.logs.filter(log => 
      log.address.toLowerCase() === BASE_USDC_ADDRESS
    );

    let validPayment = false;

    for (const log of transferLogs) {
      if (log.topics.length === 3) {
        const toAddress = `0x${log.topics[2].slice(26)}`.toLowerCase();
        const rawAmount = BigInt(log.data);
        const amountUSDC = Number(rawAmount) / 1e6;

        if (toAddress === RECEIVING_WALLET && amountUSDC >= REQUIRED_PRICE_USDC) {
          validPayment = true;
          break;
        }
      }
    }

    if (validPayment) {
      processedHashes.add(txHash);
      return { valid: true };
    } else {
      return { valid: false, reason: "Payment amount or receiving address mismatch." };
    }

  } catch (error) {
    return { valid: false, reason: "Invalid transaction hash or network error." };
  }
}

// Gatekeeper Endpoint
app.post('/api/agent', async (req, res) => {
  const paymentHeader = req.headers['x-402-payment'];

  if (!paymentHeader) {
    return res.status(402).json({
      error: "Payment Required",
      code: 402,
      message: "Access to GW8-BASE-SIGNAL-01 requires payment.",
      price: `${REQUIRED_PRICE_USDC} USDC`,
      payTo: RECEIVING_WALLET,
      chain: "Base Mainnet (Chain ID 8453)",
      asset: "USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)"
    });
  }

  const verification = await verifyBasePayment(paymentHeader);

  if (!verification.valid) {
    return res.status(402).json({
      error: "Payment Verification Failed",
      code: 402,
      reason: verification.reason
    });
  }

  res.status(200).json({
    status: "success",
    signal: "BUY",
    asset: "ETH",
    confidence: 0.88,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gatekeeper agent listening on port ${PORT}`));