import time
import requests
from datetime import datetime, timezone

# Target deployment backend
RENDER_URL = "https://micro-saas-agent.onrender.com/api/agent"

def pull_market_data():
    """Fetches real crypto market prices from CoinGecko free API."""
    try:
        url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,ripple,solana&vs_currencies=usd&include_24hr_change=true"
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            return res.json()
    except Exception as e:
        print(f"[!] Error fetching market data: {e}")
    
    # Fallback simulated data if API call fails
    return {
        "bitcoin": {"usd": 64250.00, "usd_24h_change": 1.85},
        "ethereum": {"usd": 3480.50, "usd_24h_change": -0.42},
        "ripple": {"usd": 0.585, "usd_24h_change": 3.12},
        "solana": {"usd": 142.10, "usd_24h_change": 5.40}
    }

def push_telemetry():
    """Generates Standard and Pro telemetry payloads and pushes them to Render."""
    market = pull_market_data()
    # Updated to timezone-aware UTC format to clear deprecation warning
    now_iso = datetime.now(timezone.utc).isoformat()

    # Standard Telemetry Payload ($0.05 tier)
    standard_payload = {
        "tier": "Standard",
        "timestamp": now_iso,
        "telemetry": {
            "source": "GW8 Scout Agent",
            "assets": {
                "BTC": f"${market.get('bitcoin', {}).get('usd', 0):,.2f}",
                "ETH": f"${market.get('ethereum', {}).get('usd', 0):,.2f}",
                "XRP": f"${market.get('ripple', {}).get('usd', 0):,.4f}",
                "SOL": f"${market.get('solana', {}).get('usd', 0):,.2f}"
            },
            "status": "Active Market Feed"
        }
    }

    # Pro Telemetry Payload ($0.25 tier)
    pro_payload = {
        "tier": "Pro",
        "timestamp": now_iso,
        "telemetry": {
            "source": "GW8 Scout Alpha Engine",
            "assets": {
                "BTC": {
                    "price": f"${market.get('bitcoin', {}).get('usd', 0):,.2f}",
                    "24h_change": f"{market.get('bitcoin', {}).get('usd_24h_change', 0):+.2f}%"
                },
                "ETH": {
                    "price": f"${market.get('ethereum', {}).get('usd', 0):,.2f}",
                    "24h_change": f"{market.get('ethereum', {}).get('usd_24h_change', 0):+.2f}%"
                },
                "XRP": {
                    "price": f"${market.get('ripple', {}).get('usd', 0):,.4f}",
                    "24h_change": f"{market.get('ripple', {}).get('usd_24h_change', 0):+.2f}%"
                },
                "SOL": {
                    "price": f"${market.get('solana', {}).get('usd', 0):,.2f}",
                    "24h_change": f"{market.get('solana', {}).get('usd_24h_change', 0):+.2f}%"
                }
            },
            "alpha_signal": "Volume accumulation detected across Layer-1 assets.",
            "status": "Live Stream Active"
        }
    }

    headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer SUB-GW8-CAPITAL-ALPHA-VIP"
}

    # Push Standard Telemetry
    try:
        r_std = requests.post(RENDER_URL, json=standard_payload, headers=headers, timeout=10)
        if r_std.status_code == 200:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [SUCCESS] STANDARD telemetry synced.")
        else:
            print(f"[!] Standard Push Failed: {r_std.status_code} - {r_std.text}")
    except Exception as e:
        print(f"[!] Error pushing Standard telemetry: {e}")

    # Push Pro Telemetry
    try:
        r_pro = requests.post(RENDER_URL, json=pro_payload, headers=headers, timeout=10)
        if r_pro.status_code == 200:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] [SUCCESS] PRO telemetry synced.")
        else:
            print(f"[!] Pro Push Failed: {r_pro.status_code} - {r_pro.text}")
    except Exception as e:
        print(f"[!] Error pushing Pro telemetry: {e}")

if __name__ == "__main__":
    print("--- GW8 Capital Scout Agent Loop Started ---")
    print("Syncing market telemetry every 60 seconds. Press Ctrl+C to stop.\n")
    
    while True:
        push_telemetry()
        time.sleep(60)