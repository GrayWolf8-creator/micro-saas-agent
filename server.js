const express = require('express');
const { createPublicClient, http } = require('viem');
const { base } = require('viem/chains');

const app = express();
app.use(express.json());

// Initialize public client connected to Base RPC
const publicClient = createPublicClient({
  chain: base,
  transport: http()
});

// YOUR CONFIGURATION
const RECEIVING_WALLET = "0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd".toLowerCase();
const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase(); // Official USDC on Base Mainnet
const REQUIRED_PRICE_USDC = 0.05;

// Memory cache for processed transaction hashes to prevent replay attacks
const processedHashes = new Set();

/**
 * Verifies a transaction on Base Mainnet:
 * 1. Confirms the transaction succeeded on-chain.
 * 2. Verifies it hasn't been used before.
 * 3. Confirms it sent at least 0.05 USDC to your wallet address.
 */
async function verifyBasePayment(txHash) {
  if (processedHashes.has(txHash)) {
    return { valid: false, reason: "Transaction hash already used." };
  }

  try {
    // 1. Get the transaction receipt
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      return { valid: false, reason: "Transaction failed on-chain." };
    }

    // 2. Scan logs for standard ERC-20 Transfer event
    const transferLogs = receipt.logs.filter(log => 
      log.address.toLowerCase() === BASE_USDC_ADDRESS
    );

    let validPayment = false;

    for (const log of transferLogs) {
      // Decode ERC-20 Transfer topics: [TransferSignature, FromAddress, ToAddress]
      if (log.topics.length === 3) {
        const toAddress = `0x${log.topics[2].slice(26)}`.toLowerCase();
        
        // Parse transfer amount (USDC uses 6 decimals)
        const rawAmount = BigInt(log.data);
        const amountUSDC = Number(rawAmount) / 1e6;

        if (toAddress === RECEIVING_WALLET && amountUSDC >= REQUIRED_PRICE_USDC) {
          validPayment = true;
          break;
        }
      }
    }

    if (validPayment) {
      processedHashes.add(txHash); // Mark tx as consumed
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

  // Perform on-chain verification
  const verification = await verifyBasePayment(paymentHeader);

  if (!verification.valid) {
    return res.status(402).json({
      error: "Payment Verification Failed",
      code: 402,
      reason: verification.reason
    });
  }

  // Success payload
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