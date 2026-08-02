import time
import requests
import numpy as np

# ==========================================
# CONFIGURATION
# ==========================================

# Your Live Render Gateway Endpoint (Hyphenated)
GATEWAY_URL = "https://micro-saas-agent.onrender.com/api/agent"

# Internal Gateway Security Token
VIP_TOKEN = "Bearer SUB-GW8-CAPITAL-ALPHA-VIP"

# Alpaca Credentials & Endpoint
ALPACA_API_KEY = "PKYWXISBWH4JU4LJQWBCKG65XV"
ALPACA_SECRET_KEY = "D2GBGDvy2Ho18V44gSDTBJyBEQatVTHjhcPssQGK8tRx"
ALPACA_DATA_URL = "https://data.alpaca.markets/v1beta3/crypto/us/bars"

SYMBOL = "BTC/USD"

# ==========================================
# HELPER FUNCTIONS & INDICATORS
# ==========================================

def get_alpaca_crypto_data(symbol):
    """Fetches recent 1-minute historical bars from Alpaca Crypto API."""
    headers = {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY
    }
    params = {
        "symbols": symbol,
        "timeframe": "1Min",
        "limit": 30 # Increased limit to calculate 20-period Bollinger Bands
    }
    
    response = requests.get(ALPACA_DATA_URL, headers=headers, params=params)
    if response.status_code == 200:
        data = response.json()
        bars = data.get("bars", {}).get(symbol, [])
        close_prices = [bar["c"] for bar in bars]
        return close_prices
    else:
        print(f"[ALPACA ERROR] Status {response.status_code}: {response.text}")
        return None

def calculate_rsi(prices, period=14):
    """Calculates standard 14-period Relative Strength Index."""
    if not prices or len(prices) < period + 1:
        return 50.0
    
    deltas = np.diff(prices)
    gains = np.where(deltas > 0, deltas, 0)
    losses = np.where(deltas < 0, -deltas, 0)
    
    avg_gain = np.mean(gains[-period:])
    avg_loss = np.mean(losses[-period:])
    
    if avg_loss == 0:
        return 100.0
        
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return round(float(rsi), 2)

def calculate_bollinger_bands(prices, window=20, num_std=2):
    """Calculates 20-period Bollinger Bands (Upper, Middle, Lower)."""
    if not prices or len(prices) < window:
        current = prices[-1] if prices else 0
        return current, current, current
    
    recent_prices = prices[-window:]
    sma = np.mean(recent_prices)
    std_dev = np.std(recent_prices)
    
    upper_band = sma + (num_std * std_dev)
    lower_band = sma - (num_std * std_dev)
    
    return round(float(upper_band), 2), round(float(sma), 2), round(float(lower_band), 2)

def generate_alpha_signal(price, rsi, upper_bb, lower_bb):
    """Multi-indicator confluence signal generator."""
    if price >= upper_bb and rsi >= 70:
        return "OVERBOUGHT_REJECTION_ZONE"
    elif price <= lower_bb and rsi <= 30:
        return "OVERSOLD_ACCUMULATION_ZONE"
    elif price > upper_bb:
        return "UPPER_BAND_BREAKOUT"
    elif price < lower_bb:
        return "LOWER_BAND_BREAKDOWN"
    elif rsi > 55:
        return "BULLISH_MOMENTUM"
    elif rsi < 45:
        return "BEARISH_MOMENTUM"
    else:
        return "NEUTRAL_CONSOLIDATION"

# ==========================================
# MAIN SCOUT LOOP
# ==========================================

print(f"--- GW8 Telemetry Engine v2 Started [{SYMBOL}] ---")

gateway_headers = {
    "Authorization": VIP_TOKEN,
    "Content-Type": "application/json"
}

while True:
    try:
        prices = get_alpaca_crypto_data(SYMBOL)
        
        if prices and len(prices) >= 20:
            current_price = round(prices[-1], 2)
            rsi_val = calculate_rsi(prices)
            upper_bb, mid_bb, lower_bb = calculate_bollinger_bands(prices)
            signal = generate_alpha_signal(current_price, rsi_val, upper_bb, lower_bb)
            
            # Formulate multi-tiered telemetry package
            telemetry_payload = {
                "standard_tier": {
                    "asset": SYMBOL,
                    "price": current_price,
                    "source": "Alpaca Crypto Engine",
                    "timestamp": time.time()
                },
                "pro_tier": {
                    "asset": SYMBOL,
                    "price": current_price,
                    "indicators": {
                        "rsi_14": rsi_val,
                        "bb_upper": upper_bb,
                        "bb_middle": mid_bb,
                        "bb_lower": lower_bb
                    },
                    "alpha_signal": signal,
                    "execution_venue": "GW8 Capital Backend"
                }
            }
            
            # Post telemetry update to Render
            response = requests.post(GATEWAY_URL, json=telemetry_payload, headers=gateway_headers)
            
            if response.status_code == 200:
                print(f"[{time.strftime('%H:%M:%S')}] {SYMBOL} @ ${current_price} | RSI: {rsi_val} | BB Upper: {upper_bb} | Signal: {signal} -> Render Cached")
            else:
                print(f"[{time.strftime('%H:%M:%S')}] Gateway Error {response.status_code}: {response.text}")
        else:
            print(f"[{time.strftime('%H:%M:%S')}] Accumulating price history for indicator calculations...")

    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] Loop Exception: {e}")

    time.sleep(30)