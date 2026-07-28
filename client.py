import requests
import json

# -------------------------------------------------------------------
# BUYER SIMULATION CONFIGURATION
# -------------------------------------------------------------------
GATEWAY_PREVIEW_URL = "https://micro-saas-agent.onrender.com/api/preview"
GATEWAY_AGENT_URL = "https://micro-saas-agent.onrender.com/api/agent"

def test_public_preview():
    """Queries the free public preview endpoint."""
    print("--- 1. Testing Public Preview Endpoint ---")
    try:
        res = requests.get(GATEWAY_PREVIEW_URL, timeout=5)
        print(f"Status Code: {res.status_code}")
        print("Response Payload:")
        print(json.dumps(res.json(), indent=2))
    except Exception as e:
        print(f"Failed to fetch public preview: {e}")
    print("\n" + "="*50 + "\n")


def test_paid_agent_access():
    """Queries the main signal payload endpoint using POST."""
    print("--- 2. Testing Paid/Gated Signal Endpoint ---")
    
    headers = {
        "Content-Type": "application/json",
        "X-402-Payment": "simulated_buyer_tx_hash_0x123456"
    }

    try:
        # Using POST here
        res = requests.post(GATEWAY_AGENT_URL, headers=headers, json={"pair": "ETH/USDC"}, timeout=5)
        print(f"Status Code: {res.status_code}")
        
        if res.status_code == 402:
            print("[x402 PAYMENT REQUIRED] Endpoint properly gated!")
            print("Payment challenge header/data received from gateway:")
            print(res.text)
        elif res.status_code == 200:
            print("[ACCESS GRANTED] Cached Signals Received:")
            try:
                print(json.dumps(res.json(), indent=2))
            except Exception:
                print(res.text)
        else:
            print(f"Server response ({res.status_code}): {res.text}")
    except Exception as e:
        print(f"Failed to fetch paid signal: {e}")
    print("\n" + "="*50 + "\n")


if __name__ == "__main__":
    print("\n==================================================")
    print("      GW8 SUBSCRIBER CLIENT SIMULATOR             ")
    print("==================================================\n")
    
    test_public_preview()
    test_paid_agent_access()