import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Contract, formatUnits } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const VAULT_ADDRESS = '0xb4527dccac81eb73d4988a51a4cb1fbbf2c3cabd'.toLowerCase();
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VIP_TOKEN = 'SUB-GW8-CAPITAL-ALPHA-VIP';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Provider and Minimal ERC-20 ABI
const provider = new JsonRpcProvider(BASE_RPC_URL);
const erc20Abi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// In-memory memory caches & state
let latestTelemetry = { status: "Awaiting scout data...", updatedAt: new Date().toISOString() };
const processedTxs = new Set(); // Stores spent transaction hashes to prevent replay attacks

// 1. Ingestion endpoint (Unprotected for local Python scout cluster)
app.post('/api/agent', (req, res) => {
    latestTelemetry = {
        ...req.body,
        updatedAt: new Date().toISOString()
    };
    console.log(`[SCOUT INGESTION] Telemetry updated at ${latestTelemetry.updatedAt}`);
    res.json({ status: "success", receivedAt: latestTelemetry.updatedAt });
});

// Helper: Verify Base Mainnet USDC Transaction
async function verifyUsdcPayment(txHash, requiredAmountUsdc) {
    if (processedTxs.has(txHash)) {
        return { valid: false, reason: "Transaction hash already used (replay protection)" };
    }

    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) {
            return { valid: false, reason: "Transaction not found or failed on-chain" };
        }

        const usdcContract = new Contract(USDC_BASE_ADDRESS, erc20Abi, provider);

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase()) continue;
            
            try {
                const parsedLog = usdcContract.interface.parseLog(log);
                if (parsedLog && parsedLog.name === 'Transfer') {
                    const [from, to, value] = parsedLog.args;
                    const amountUsdc = parseFloat(formatUnits(value, 6)); // USDC uses 6 decimals

                    if (to.toLowerCase() === VAULT_ADDRESS && amountUsdc >= requiredAmountUsdc) {
                        processedTxs.add(txHash); // Mark as spent
                        return { valid: true, amount: amountUsdc, sender: from };
                    }
                }
            } catch (e) {
                // Ignore logs that don't match the Transfer event signature
            }
        }
        return { valid: false, reason: "No matching USDC transfer to vault found in transaction" };
    } catch (err) {
        console.error("[RPC VERIFICATION ERROR]", err);
        return { valid: false, reason: "RPC error verifying transaction" };
    }
}

// 2. Gated Telemetry Route (x402 Micropayment or VIP token)
app.get('/api/telemetry', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const paymentTx = req.headers['x-payment-tx'] || req.query.tx;

    // Check VIP Token Bypass
    if (authHeader === `Bearer ${VIP_TOKEN}`) {
        return res.json({
            status: 'success',
            accessType: 'VIP_BYPASS',
            timestamp: new Date().toISOString(),
            telemetry: latestTelemetry
        });
    }

    // Check On-Chain x402 Payment
    if (paymentTx) {
        const verification = await verifyUsdcPayment(paymentTx, 0.05); // 0.05 USDC standard tier
        if (verification.valid) {
            return res.json({
                status: 'success',
                accessType: 'ON_CHAIN_SETTLED',
                settledTx: paymentTx,
                amountPaid: verification.amount,
                timestamp: new Date().toISOString(),
                telemetry: latestTelemetry
            });
        } else {
            return res.status(400).json({ error: "Invalid Payment", reason: verification.reason });
        }
    }

    // Enforce HTTP 402 Payment Required
    res.status(402)
       .set('X-402-Pay-To', VAULT_ADDRESS)
       .set('X-402-Amount-USDC', '0.05')
       .set('X-402-Chain', 'Base-Mainnet')
       .json({
           status: '402_PAYMENT_REQUIRED',
           message: 'Access requires 0.05 USDC micro-payment on Base Mainnet',
           paymentDetails: {
               recipient: VAULT_ADDRESS,
               token: 'USDC',
               chainId: 8453,
               chainName: 'Base Mainnet',
               amount: 0.05
           },
           instructions: 'Send payment and re-query this endpoint with header "X-Payment-Tx: <TX_HASH>" or "?tx=<TX_HASH>"'
       });
});

app.listen(PORT, () => {
    console.log(`GW8 Capital x402 Gateway online on port ${PORT}`);
});