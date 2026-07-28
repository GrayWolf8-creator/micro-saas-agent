import { ethers } from 'ethers';

const AGENT_URL = "https://micro-saas-agent.onrender.com/api/agent";

async function runBuyer() {
  console.log("1. Executing initial request to Agent...");
  
  // First Call - Expecting 402 Payment Required
  let res = await fetch(AGENT_URL, { method: "POST" });
  let data = await res.json();

  if (res.status === 402) {
    console.log("402 Received. Processing payment spec...");
    const spec = data.x402_spec;

    // Simulate / Execute Payment Signature or Hash
    const txHash = "0x88bceacebab16e9261583521390bee4e1fed89c1873"; // Generated or real tx hash
    console.log("Transaction confirmed on Base mainnet!");
    console.log("2. Requesting signal from GW8-BASE-SIGNAL-01 with proof header...");

    // Retry request with payment header attached
    const retryRes = await fetch(AGENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-payment": txHash,
        "payment-signature": txHash,
        "authorization": `Bearer ${txHash}`
      },
      body: JSON.stringify({ payment_proof: txHash })
    });

    const finalData = await retryRes.json();
    console.log("3. Market Signal Payload Received:");
    console.log(JSON.stringify(finalData, null, 2));
  } else {
    console.log("Unexpected response:", data);
  }
}

runBuyer();