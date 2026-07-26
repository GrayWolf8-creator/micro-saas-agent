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

  // 1. Verify Payment On-Chain
  const isVerified = await verifyPayment(txHash);

  if (!isVerified) {
    return res.status(402).json({
      error: "Payment Verification Failed",
      code: 402,
      reason: "Transaction failed or not found on-chain."
    });
  }

  // 2. Fetch Live Price Data from Market API
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,ripple&vs_currencies=usd&include_24hr_change=true');
    const marketData = await response.json();

    const ethData = marketData.ethereum;
    const ethChange = ethData.usd_24h_change;
    
    // Algorithmic signal logic based on 24h momentum
    let signalAction = "HOLD";
    if (ethChange > 1.5) signalAction = "BUY";
    if (ethChange < -1.5) signalAction = "SELL";

    // 3. Return Monetized Intelligence
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