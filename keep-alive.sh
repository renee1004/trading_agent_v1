#!/bin/bash
cd /home/z/my-project
while true; do
  if ! curl -s http://localhost:3000/api/trading/history?limit=1 > /dev/null 2>&1; then
    echo "[$(date)] Server down, restarting..." >> /tmp/keep-alive.log
    # Kill any existing process
    pkill -f "node.*server.js" 2>/dev/null
    pkill -f "next start" 2>/dev/null
    sleep 1
    # Restart
    node .next/standalone/server.js -p 3000 >> /tmp/next-standalone.log 2>&1 &
    sleep 5
    # Verify
    if curl -s http://localhost:3000/api/trading/history?limit=1 > /dev/null 2>&1; then
      echo "[$(date)] Server restarted successfully" >> /tmp/keep-alive.log
    else
      echo "[$(date)] Server restart failed" >> /tmp/keep-alive.log
    fi
  fi
  sleep 5
done
