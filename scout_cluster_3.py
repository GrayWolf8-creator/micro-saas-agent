import sys
import os
import time
import requests

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scout_base import dispatch_telemetry

SYMBOL = "ONDO/USD"
COINGECKO_ID = "ondo-finance"
PRICE_HISTORY = []

def fetch_price():
    url = f"https://api.coingecko.com/api/v3/simple/price?ids={COINGECKO_ID}&vs_currencies=usd"
    res = requests.get(url, timeout=5).json()
    return float(res[COINGECKO_ID]["usd"])

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
            print(f"[{SYMBOL}] Ingestion Error: {e}")
            
        time.sleep(60)

if __name__ == "__main__":
    run()