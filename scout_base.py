import time
import requests
import pandas as pd
import numpy as np

# Global Gateway Configuration (Updated to dedicated ingestion endpoint)
RENDER_GATEWAY_URL = "https://micro-saas-agent.onrender.com/api/ingest"
INGEST_HEADERS = {
    "Content-Type": "application/json"
}

def calculate_rsi(series: pd.Series, period: int = 14) -> float:
    if len(series) < period:
        return 50.0  # Default neutral if warming up
    delta = series.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    
    # Prevent division by zero
    loss_val = loss.iloc[-1]
    if loss_val == 0:
        return 100.0
        
    rs = gain.iloc[-1] / loss_val
    rsi = 100 - (100 / (1 + rs))
    return float(rsi)

def calculate_bollinger_bands(series: pd.Series, period: int = 20, std_dev: int = 2):
    if len(series) < period:
        latest = float(series.iloc[-1]) if len(series) > 0 else 0.0
        return latest, latest, latest
    
    sma = series.rolling(window=period).mean().iloc[-1]
    std = series.rolling(window=period).std().iloc[-1]
    upper = sma + (std * std_dev)
    lower = sma - (std * std_dev)
    return float(sma), float(upper), float(lower)

def generate_signal(price: float, rsi: float, bb_lower: float, bb_upper: float) -> str:
    if rsi <= 30 and price <= bb_lower:
        return "OVERSOLD_ACCUMULATION_ZONE"
    elif rsi >= 70 and price >= bb_upper:
        return "OVERBOUGHT_DISTRIBUTION_ZONE"
    elif rsi < 45:
        return "BULLISH_MOMENTUM_BUILD"
    elif rsi > 55:
        return "BEARISH_MOMENTUM_BUILD"
    return "NEUTRAL_CONSOLIDATION"

def dispatch_telemetry(symbol: str, price: float, price_history: list):
    """
    Formats indicator calculations and posts directly to the Render Ingestion Route.
    """
    df = pd.DataFrame({"close": price_history})
    rsi = calculate_rsi(df["close"])
    sma, bb_upper, bb_lower = calculate_bollinger_bands(df["close"])
    signal = generate_signal(price, rsi, bb_lower, bb_upper)

    payload = {
        "symbol": symbol,
        "price": round(price, 6),
        "metrics": {
            "rsi_14": round(rsi, 2),
            "sma_20": round(sma, 6),
            "bb_upper": round(bb_upper, 6),
            "bb_lower": round(bb_lower, 6)
        },
        "signal": signal,
        "timestamp": int(time.time())
    }

    try:
        res = requests.post(RENDER_GATEWAY_URL, json=payload, headers=INGEST_HEADERS, timeout=5)
        print(f"[{symbol}] Telemetry Ingested | Status: {res.status_code} | Price: ${price} | Signal: {signal}")
    except Exception as e:
        print(f"[{symbol}] Ingestion Dispatch Error: {e}")