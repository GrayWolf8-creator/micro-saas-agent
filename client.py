import requests
import json

GATEWAY_PREVIEW_URL = "https://micro-saas-agent.onrender.com/api/preview"
GATEWAY_AGENT_URL = "https://micro-saas-agent.onrender.com/api/agent"

def test_1_public_preview():
    print("--- 1. Testing Public Preview Endpoint ---")
    res = requests.get(GATEWAY_PREVIEW_URL, timeout=5)
    print(f"Status Code: {res.status_code}")
    print(json.dumps(res.json(), indent=2))
    print("\n" + "="*50 + "\n")

def test_2_unpaid_gated_request():
    print("--- 2. Testing Unpaid Request (Expecting 402 Payment Challenge) ---")
    res = requests.post(GATEWAY_AGENT_URL, json={"pair": "ETH/USDC"}, timeout=5)
    print(f"Status Code: {res.status_code}")
    print(res.text)
    print("\n" + "="*50 + "\n")

def test_3_paid_subscriber_request():
    print("--- 3. Testing Authorized Subscriber Call (Expecting 200 + Signal Payload) ---")
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
    print("      GW8 SUBSCRIBER CLIENT SIMULATOR (FULL)      ")
    print("==================================================\n")
    test_1_public_preview()
    test_2_unpaid_gated_request()
    test_3_paid_subscriber_request()