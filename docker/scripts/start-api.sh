#!/bin/sh
# s6-rc service: wavekit-api
# Purpose: Main WaveKit TypeScript API server

# Log startup
echo "[wavekit-api] Starting WaveKit API server..." >> /var/log/wavekit/system.log

# Change to app directory
cd /app

# Redirect stderr to stdout for unified logging
exec 2>&1

# Execute the Node.js application
exec node /app/dist/index.js
