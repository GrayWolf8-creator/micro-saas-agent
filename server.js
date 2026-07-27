import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Paid Agent Signal Endpoint
app.post('/api/agent', (req, res) => {
  try {
    const signalData = {
      agent: "GW8-BASE-SIGNAL-01",
      timestamp: new Date().toISOString(),
      signal: "BUY",
      asset: "ETH/USD",
      target_entry: "Market",
      stop_loss: "-2.5%",
      take_profit: "+7.5%",
      confidence: "88%"
    };

    return res.status(200).json({
      status: "SUCCESS",
      payment_received: true,
      data: signalData
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to generate market signal." });
  }
});

// Public Preview Endpoint
app.get('/api/preview', (req, res) => {
  res.json({
    status: "ACTIVE",
    agent_id: "GW8-BASE-SIGNAL-01",
    network: "Base Mainnet",
    preview: {
      market_condition: "RVOL_MOMENTUM_SURGE",
      confidence: "88%",
      access: "Requires x402 payment on /api/agent"
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});