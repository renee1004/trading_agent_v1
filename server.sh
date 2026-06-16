#!/bin/bash
cd /home/z/my-project
export PORT=3000
export HOSTNAME=0.0.0.0

# Kill any existing process on port 3000
pkill -f "node.*server.js" 2>/dev/null
sleep 1

while true; do
  echo "[$(date)] Starting server..." >> /tmp/server-lifecycle.log
  node .next/standalone/server.js >> /tmp/server-lifecycle.log 2>&1
  EXIT_CODE=$?
  echo "[$(date)] Server exited with code $EXIT_CODE" >> /tmp/server-lifecycle.log
  sleep 2
done
