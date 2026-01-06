#!/bin/sh
# s6-rc service: sdrpp-server
# Purpose: SDR++ server for IQ stream capture from hardware

# Log startup
echo "[sdrpp-server] Starting SDR++ server..." >> /var/log/wavekit/system.log

# Redirect stderr to stdout for unified logging
exec 2>&1

# Execute SDR++ server
exec sdrpp \
  --server \
  --port 5259 \
  --addr 0.0.0.0 \
  --log-level info
