#!/bin/sh
# s6-rc finish script: sdrpp-server
# Purpose: Graceful cleanup when SDR++ server stops

# Exit code from the run script
EXIT_CODE="${1:-0}"
# Signal that killed the service (0 if normal exit)
SIGNAL="${2:-0}"

# Log shutdown event
echo "[sdrpp-server] Service stopped with exit code ${EXIT_CODE}, signal ${SIGNAL}" >> /var/log/wavekit/system.log

# Cleanup any stale PID files
rm -f /var/run/wavekit/sdrpp.pid 2>/dev/null || true

# Cleanup any shared memory segments created by SDR++
if [ -d /dev/shm ]; then
    rm -f /dev/shm/sdrpp_* 2>/dev/null || true
fi

# Cleanup any temporary files
rm -f /tmp/wavekit/sdrpp_* 2>/dev/null || true

# If the service crashed (non-zero exit), log additional info
if [ "${EXIT_CODE}" != "0" ]; then
    echo "[sdrpp-server] WARNING: Service exited abnormally, will be restarted by s6" >> /var/log/wavekit/system.log
fi
