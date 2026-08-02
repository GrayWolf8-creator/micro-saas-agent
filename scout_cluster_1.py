import sys
import os
import time
import requests

# Link to root scout_base
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from scout_base import dispatch_telemetry

SYMBOL = "BTC/USD"
PRICE_HISTORY = []

def fetch_price():
    # Public CoinGecko fallback endpoint (no API key required)
    url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
    headers = {"User-Agent": "Mozilla/5.0"}
    
    res = requests.get(url, headers=headers, timeout=10)
    res.raise_for_status() # Throws error if non-200 HTTP code
    
    data = res.json()
    return float(data["bitcoin"]["usd"])

def run():
    print(f"Starting Scout Agent for {SYMBOL}...")
    while True:
        try:
            price = fetch_price()
            PRICE_HISTORY.append(price)
            if len(PRICE_HISTORY) > 50:
                PRICE_HISTORY.pop(0)

            dispatch_telemetry(SYMBOL, price, PRICE_HISTORY)
        except Exception as e:
            print(f"[{SYMBOL}] Error during execution cycle: {e}")
            
        time.sleep(30)

if __name__ == "__main__":
    run()