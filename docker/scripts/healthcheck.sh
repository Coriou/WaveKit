#!/bin/sh
# Health check script for WaveKit container
# Used by Docker HEALTHCHECK and monitoring
#
# Requirements:
# - 4.4: Return exit code 0 when all checks pass and exit code 1 when any check fails
# - 4.6: Complete within 10 seconds to avoid timeout issues

# Configuration
TIMEOUT=10
API_HOST="${WAVEKIT_API_HOST:-localhost}"
API_PORT="${WAVEKIT_API_PORT:-9000}"
HEALTH_ENDPOINT="http://${API_HOST}:${API_PORT}/health"

# Check WaveKit API health endpoint
# Returns 0 if healthy (200 OK), 1 if unhealthy (503 or connection error)
check_wavekit_api() {
    # Use timeout to ensure we don't hang (Requirement 4.6)
    response=$(timeout "${TIMEOUT}s" curl -sf -w "%{http_code}" -o /dev/null "${HEALTH_ENDPOINT}" 2>/dev/null)
    curl_exit=$?

    # Check if curl timed out or failed
    if [ $curl_exit -ne 0 ]; then
        echo "❌ API health check failed: connection error (exit code: $curl_exit)"
        return 1
    fi

    # Check HTTP status code
    if [ "$response" = "200" ]; then
        return 0
    elif [ "$response" = "503" ]; then
        echo "❌ API health check failed: service unhealthy (HTTP 503)"
        return 1
    else
        echo "❌ API health check failed: unexpected status code $response"
        return 1
    fi
}

# Check if critical s6 services are running
check_services() {
    # Check if s6-svstat is available
    if ! command -v s6-svstat > /dev/null 2>&1; then
        # s6 not available, skip service checks
        return 0
    fi

    # Check WaveKit API service
    if [ -d /run/service/wavekit-api ]; then
        if ! s6-svstat /run/service/wavekit-api > /dev/null 2>&1; then
            echo "❌ Service check failed: wavekit-api not running"
            return 1
        fi
    fi

    # Check SDR++ server if in full mode (directory exists)
    if [ -d /run/service/sdrpp-server ]; then
        if ! s6-svstat /run/service/sdrpp-server > /dev/null 2>&1; then
            echo "⚠️  SDR++ server not running (degraded mode)"
            # Don't fail on SDR++ - it's not critical for API health
        fi
    fi

    return 0
}

# Check all configured decoders via the API status endpoint
check_decoders() {
    # Get detailed status from API
    status_response=$(timeout "${TIMEOUT}s" curl -sf "http://${API_HOST}:${API_PORT}/api/status" 2>/dev/null)
    curl_exit=$?

    if [ $curl_exit -ne 0 ]; then
        # Can't reach API, but that's already checked in check_wavekit_api
        return 0
    fi

    # Check overall health status from the response
    # Using grep to check if status is "unhealthy"
    if echo "$status_response" | grep -q '"status":"unhealthy"'; then
        echo "❌ System status: unhealthy"
        return 1
    fi

    if echo "$status_response" | grep -q '"status":"degraded"'; then
        echo "⚠️  System status: degraded"
        # Degraded is not a failure, just a warning
    fi

    return 0
}

# Main health check logic
main() {
    # Track overall health
    healthy=true

    # Check s6 services first (fast check)
    if ! check_services; then
        healthy=false
    fi

    # Check WaveKit API health endpoint (Requirement 4.1, 4.4)
    if ! check_wavekit_api; then
        healthy=false
    fi

    # Check decoder status via API (Requirement 4.2)
    if ! check_decoders; then
        healthy=false
    fi

    # Return appropriate exit code (Requirement 4.4)
    if [ "$healthy" = true ]; then
        echo "✅ Health check passed"
        exit 0
    else
        echo "❌ Health check failed"
        exit 1
    fi
}

# Run main function
main
