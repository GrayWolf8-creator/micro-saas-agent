
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON body parsing
app.use(express.json());

// Memory store for latest telemetry
let latestTelemetry = null;

// Middleware: x402 Payment Gatekeeper Authentication
const x402PaymentGatekeeper = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const expectedToken = 'Bearer SUB-GW8-CAPITAL-ALPHA-VIP';

    if (!authHeader || authHeader !== expectedToken) {
        return res.status(401).json({ 
            status: 'error', 
            message: 'Unauthorized: Valid x402 subscriber token required.' 
        });
    }
    next();
};

// Health Check Route
app.get('/', (req, res) => {
    res.send('GW8 Capital Telemetry Gateway Online');
});

// POST /api/agent - Scout agent pushes fresh market telemetry here
app.post('/api/agent', x402PaymentGatekeeper, (req, res) => {
    latestTelemetry = req.body;
    console.log(`[${new Date().toLocaleTimeString()}] Telemetry updated via scout agent.`);
    
    res.status(200).json({
        status: 'success',
        message: 'Telemetry payload received and cached successfully.'
    });
});

// GET /api/telemetry - Subscribers read the cached high-alpha telemetry here
app.get('/api/telemetry', x402PaymentGatekeeper, (req, res) => {
    if (!latestTelemetry) {
        return res.status(404).json({ 
            status: 'error', 
            message: 'No telemetry data cached yet. Agent is warming up.' 
        });
    }

    res.status(200).json({
        status: 'success',
        timestamp: new Date().toISOString(),
        telemetry: latestTelemetry
    });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});