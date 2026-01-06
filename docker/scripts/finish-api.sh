#!/bin/sh
# s6-rc finish script: wavekit-api
# Purpose: Graceful cleanup when WaveKit API stops

# Exit code from the run script
EXIT_CODE="${1:-0}"
# Signal that killed the service (0 if normal exit)
SIGNAL="${2:-0}"

# Log shutdown event
echo "[wavekit-api] Service stopped with exit code ${EXIT_CODE}, signal ${SIGNAL}" >> /var/log/wavekit/system.log

# Cleanup any stale PID files
rm -f /var/run/wavekit/wavekit-api.pid 2>/dev/null || true

# Cleanup any Unix sockets
rm -f /var/run/wavekit/*.sock 2>/dev/null || true

# Cleanup any temporary decoder files
rm -f /tmp/wavekit/decoder_* 2>/dev/null || true
rm -f /tmp/wavekit/audio_* 2>/dev/null || true

# Cleanup any orphaned decoder processes
# This ensures decoders spawned by the API are properly terminated
pkill -TERM -f "dsd-fme" 2>/dev/null || true
pkill -TERM -f "multimon-ng" 2>/dev/null || true
pkill -TERM -f "rtl_433" 2>/dev/null || true
pkill -TERM -f "acarsdec" 2>/dev/null || true
pkill -TERM -f "AIS-catcher" 2>/dev/null || true
pkill -TERM -f "direwolf" 2>/dev/null || true
pkill -TERM -f "dumpvdl2" 2>/dev/null || true
pkill -TERM -f "readsb" 2>/dev/null || true
