import { ethers } from 'ethers';

// Live API Endpoint
const API_URL = 'https://micro-saas-agent.onrender.com/api/agent';

// Base Mainnet Setup
const RPC_URL = 'https://mainnet.base.org';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECEIVER_ADDRESS = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)"
];

async function executePaidCall() {
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Error: BUYER_PRIVATE_KEY environment variable is missing.');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(privateKey, provider);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  console.log('1. Executing 0.05 USDC payment on Base...');
  // 0.05 USDC = 50,000 units (6 decimals)
  const tx = await usdcContract.transfer(RECEIVER_ADDRESS, 50000);
  console.log(`Transaction submitted! Hash: ${tx.hash}`);
  
  await tx.wait();
  console.log('Transaction confirmed on Base mainnet!');

  console.log('2. Requesting signal from GW8-BASE-SIGNAL-01...');
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-402-payment': tx.hash
    }
  });

  const data = await response.json();
  console.log('3. Market Signal Payload Received:');
  console.log(JSON.stringify(data, null, 2));
}

executePaidCall();