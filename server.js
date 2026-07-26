import express from 'express';

const app = express();

app.use(express.json());

// Middleware / Gatekeeper check for x402 payment
app.post('/api/agent', (req, res) => {
  const paymentHeader = req.headers['x-402-payment'] || req.headers['authorization'];

  // If no payment proof is provided, reject with HTTP 402
  if (!paymentHeader) {
    return res.status(402).json({
      error: "Payment Required",
      code: 402,
      message: "Access to GW8-BASE-SIGNAL-01 requires payment.",
      price: "0.05 USDC"
    });
  }

  // If payment header is present, return the signal payload
  return res.json({
    status: "success",
    signal: "BUY",
    asset: "ETH",
    confidence: 0.88,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()mode => {
  console.log(`Server running on port ${PORT}`);
});