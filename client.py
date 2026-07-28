import requests
import json

GATEWAY_PREVIEW_URL = "https://micro-saas-agent.onrender.com/api/preview"
GATEWAY_AGENT_URL = "https://micro-saas-agent.onrender.com/api/agent"

def test_1_invalid_tx_hash():
    print("--- 1. Testing Invalid Tx Hash (Expecting 402 Verification Failed) ---")
    headers = {
        "Content-Type": "application/json",
        "x-payment": "0x1111111111111111111111111111111111111111111111111111111111111111"
    }
    res = requests.post(GATEWAY_AGENT_URL, headers=headers, json={"pair": "ETH/USDC"}, timeout=10)
    print(f"Status Code: {res.status_code}")
    print(res.text)
    print("\n" + "="*50 + "\n")

def test_2_subscriber_bypass():
    print("--- 2. Testing Authorized Subscriber Call (Expecting 200 + Signal Payload) ---")
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer GW8_SUBSCRIBER_KEY"
    }
    res = requests.post(GATEWAY_AGENT_URL, headers=headers, json={"pair": "ETH/USDC"}, timeout=5)
    print(f"Status Code: {res.status_code}")
    try:
        print(json.dumps(res.json(), indent=2))
    except Exception:
        print(res.text)
    print("\n" + "="*50 + "\n")

if __name__ == "__main__":
    print("\n==================================================")
    print("   GW8 ON-CHAIN RPC VERIFICATION CLIENT TESTER   ")
    print("==================================================\n")
    test_1_invalid_tx_hash()
    test_2_subscriber_bypass()