Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " LAUNCHING SCOUT CLUSTER MATRIX (3 GROUPS) " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# --- Cluster 1: Compute & L1s ---
Write-Host "Deploying Cluster 1 (Compute & L1s)..." -ForegroundColor Yellow
Start-Process python -ArgumentList "scout_cluster_1.py" -WindowStyle Minimized

# --- Cluster 2: Payments & Settlement Rails ---
Write-Host "Deploying Cluster 2 (Payments & Settlement)..." -ForegroundColor Yellow
Start-Process python -ArgumentList "scout_cluster_2.py" -WindowStyle Minimized

# --- Cluster 3: AI, RWA & Strategic ---
Write-Host "Deploying Cluster 3 (AI, Oracles & RWA)..." -ForegroundColor Yellow
Start-Process python -ArgumentList "scout_cluster_3.py" -WindowStyle Minimized

Write-Host ""
Write-Host "All Clusters Active. High-Alpha Telemetry streaming to Render Gateway." -ForegroundColor Green