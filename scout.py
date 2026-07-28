import time
import requests

# -------------------------------------------------------------------
# CONFIGURATION
# -------------------------------------------------------------------
RENDER_GATEWAY_URL = "https://micro-saas-agent.onrender.com/api/update-signal"
FLEET_SECRET_KEY = "GW8_ SUPER_SECRET_KEY"

# Interval in seconds (300 seconds = 5 minutes)
UPDATE_INTERVAL_SECONDS = 300 

# Asset Mapping: (CoinGecko API ID -> Display Pair Name)
ASSETS = {
    "ethereum": "ETH/USDC",
    "bitcoin": "BTC/USDC",
    "ripple": "XRP/USDC"
}


def fetch_multi_asset_data():
    """Fetches real-time price & 24h trend data for all target assets in one call."""
    try:
        ids_param = ",".join(ASSETS.keys())
        url = f"https://api.coingecko.com/api/v3/simple/price?ids={ids_param}&vs_currencies=usd&include_24hr_change=true"
        res = requests.get(url, timeout=10)
        return res.json()
    except Exception as e:
        print(f"[SCOUT ERROR] Failed to fetch market data: {e}")
        return {}


def analyze_signal(price, change_24h):
    """Confluence Engine logic: converts market metrics into a signal."""
    if price is None:
        return "HOLD", "50%"

    if change_24h >= 1.5:
        signal = "ACCUMULATE"
        confidence = f"{min(80 + int(change_24h * 2), 99)}%"
    elif change_24h <= -1.5:
        signal = "DISTRIBUTE"
        confidence = f"{min(80 + int(abs(change_24h) * 2), 99)}%"
    else:
        signal = "NEUTRAL_HOLD"
        confidence = "65%"

    return signal, confidence


def push_signal(pair, price, signal, confidence):
    """Pushes the computed payload across the network to Render."""
    headers = {
        "Content-Type": "application/json",
        "x-gw8-key": FLEET_SECRET_KEY,
    }

    payload = {
        "pair": pair,
        "price": f"${price:,.2f}" if price >= 1.0 else f"${price:,.4f}",
        "signal": signal,
        "confidence": confidence,
        "status": "ACTIVE",
        "last_updated": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    }

    try:
        response = requests.post(
            RENDER_GATEWAY_URL, json=payload, headers=headers, timeout=10
        )
        if response.status_code == 200:
            print(
                f"[{time.strftime('%H:%M:%S')}] [SUCCESS] {pair:<8} | Price: {payload['price']:<10} | Signal: {signal} ({confidence}) -> Gateway Updated!"
            )
        else:
            print(
                f"[{time.strftime('%H:%M:%S')}] [ERROR] Code {response.status_code}: {response.text}"
            )
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] [CRITICAL] Failed to reach Render Gateway: {e}")


# -------------------------------------------------------------------
# AUTOMATED CONTINUOUS LOOP
# -------------------------------------------------------------------
if __name__ == "__main__":
    print("\n==================================================")
    print("   GW8 MULTI-ASSET AUTOMATED SCOUT INITIALIZED    ")
    print(f"   Target: {RENDER_GATEWAY_URL}")
    print(f"   Tracking: {', '.join(ASSETS.values())}")
    print(f"   Interval: Every {UPDATE_INTERVAL_SECONDS // 60} minutes")
    print("   Press Ctrl + C in terminal to stop at any time.")
    print("==================================================\n")

    while True:
        market_data = fetch_multi_asset_data()

        if market_data:
            for cg_id, pair_name in ASSETS.items():
                asset_info = market_data.get(cg_id)
                if asset_info:
                    price = asset_info.get("usd")
                    change_24h = asset_info.get("usd_24h_change", 0.0)
                    signal, confidence = analyze_signal(price, change_24h)
                    push_signal(pair_name, price, signal, confidence)
                    # Small delay between pushes to prevent rapid hitting
                    time.sleep(1)
        else:
            print(f"[{time.strftime('%H:%M:%S')}] Skipping update due to API fetch failure.")

        print(f"\n--- Cycle complete. Waiting {UPDATE_INTERVAL_SECONDS // 60} minutes... ---\n")
        time.sleep(UPDATE_INTERVAL_SECONDS)