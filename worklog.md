---
Task ID: 1
Agent: Main Agent
Task: Fix strategyAggressiveness=TEST DB persistence + KRX code normalization

Work Log:
- Read current state of all relevant files (settings route, effective-settings, trading-agent, status route, KIS API, stock-master, market-scanner, page.tsx)
- Analyzed root cause: strategyAggressiveness not persisting despite correct code - added read-after-write verification with auto-retry in settings route
- Improved test-mode endpoint with DB read-back verification and retry logic (up to 3 retries)
- Added diagnostic logging in getEffectiveTradingSettings() to track strategyAggressiveness from DB/default/merged
- Added normalizeStockCode() safety net in KIS API methods: getStockPrice, getStockDailyCandles, placeOrder
- Added normalizeStockCode() in trading-agent executeOrder for order request safety
- Committed and pushed to GitHub (525d659)

Stage Summary:
- Key fix: Read-after-write verification ensures strategyAggressiveness=TEST is actually saved to DB
- KRX code normalization now applied at KIS API level (safety net) + trading-agent level
- Detailed logging added for debugging persistence issues
- Pushed to GitHub, Railway will auto-deploy
