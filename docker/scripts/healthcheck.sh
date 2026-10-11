#!/bin/sh
# Health check script for WaveKit container
# Used by Docker HEALTHCHECK and monitoring
# The public /health response includes system health; detailed /api/status
# remains protected and is not queried by this credential-free probe.
#
# Requirements:
# - 4.4: Return exit code 0 when all checks pass and exit code 1 when any check fails
# - 4.6: Complete within 10 seconds to avoid timeout issues

# Configuration
TIMEOUT=10
API_HOST="${WAVEKIT_API_HOST:-localhost}"
API_PORT="${WAVEKIT_API_PORT:-9000}"
HEALTH_ENDPOINT="http://${API_HOST}:${API_PORT}/health"
PROBE_TARGET="${WAVEKIT_ACCESS__HEALTH_PROBE__TARGET:-}"
PROBE_HOST="${WAVEKIT_ACCESS__HEALTH_PROBE__HOST:-}"
if [ -n "$PROBE_TARGET$PROBE_HOST" ] || [ "${WAVEKIT_ACCESS__MODE:-legacy}" = protected ]; then
    case "$PROBE_TARGET" in
        http://127.0.0.1:*) probe_port="${PROBE_TARGET#http://127.0.0.1:}" ;;
        http://\[::1\]:*) probe_port="${PROBE_TARGET#http://\[::1\]:}" ;;
        *) echo "API health probe configuration invalid"; exit 1 ;;
    esac
    case "$probe_port" in
        ''|*[!0-9]*) echo "API health probe configuration invalid"; exit 1 ;;
    esac
    if [ "$probe_port" -lt 1 ] || [ "$probe_port" -gt 65535 ]; then
        echo "API health probe configuration invalid"; exit 1
    fi
    case "$PROBE_HOST" in
        ''|*[!A-Za-z0-9.:[\]-]*) echo "API health probe configuration invalid"; exit 1 ;;
    esac
    HEALTH_ENDPOINT="$PROBE_TARGET/health"
fi

# Check WaveKit API health endpoint
# Returns 0 if healthy (200 OK), 1 if unhealthy (503 or connection error)
check_wavekit_api() {
    # Use timeout to ensure we don't hang (Requirement 4.6)
    if [ -n "$PROBE_HOST" ]; then
        response=$(timeout "${TIMEOUT}s" curl -sf -w "%{http_code}" -o /dev/null -H "Host: $PROBE_HOST" "$HEALTH_ENDPOINT" 2>/dev/null)
    else
        response=$(timeout "${TIMEOUT}s" curl -sf -w "%{http_code}" -o /dev/null "$HEALTH_ENDPOINT" 2>/dev/null)
    fi
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
