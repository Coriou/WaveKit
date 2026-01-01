#!/bin/sh
# Health check script for WaveKit container
# Used by Docker HEALTHCHECK and monitoring

check_wavekit_api() {
    curl -sf http://localhost:9000/health > /dev/null 2>&1
    return $?
}

check_services() {
    # Check if critical services are running
    s6-svstat /run/service/wavekit-api > /dev/null 2>&1 || return 1
    
    # Optionally check SDR++ if in full mode
    if [ -d /run/service/sdrpp-server ]; then
        s6-svstat /run/service/sdrpp-server > /dev/null 2>&1 || return 1
    fi
    
    return 0
}

# Perform checks
if ! check_services; then
    echo "❌ Service check failed"
    exit 1
fi

if ! check_wavekit_api; then
    echo "❌ API health check failed"
    exit 1
fi

echo "✅ Health check passed"
exit 0
