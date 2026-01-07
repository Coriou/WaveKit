#!/bin/bash
# IQ Recording Tool for creating synchronized reference test files
# 
# Connects to rtlmux and records raw IQ data (U8 format) while allowing
# simultaneous SDR++ WAV recording for comparison testing.
#
# Usage: ./record-iq.sh [OPTIONS]
#
# Options:
#   -h, --host HOST     rtlmux host (default: 192.168.1.69)
#   -p, --port PORT     rtlmux port (default: 1235)
#   -d, --delay SECS    countdown delay before recording (default: 5)
#   -o, --output DIR    output directory (default: /debug_audio)
#   --help              show this help

set -euo pipefail

# Default configuration
RTLMUX_HOST="${RTLMUX_HOST:-192.168.1.69}"
RTLMUX_PORT="${RTLMUX_PORT:-1235}"
COUNTDOWN_DELAY=2
OUTPUT_DIR="./debug_audio"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--host)
            RTLMUX_HOST="$2"
            shift 2
            ;;
        -p|--port)
            RTLMUX_PORT="$2"
            shift 2
            ;;
        -d|--delay)
            COUNTDOWN_DELAY="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --help)
            head -20 "$0" | tail -15
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Generate timestamped filename
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="${OUTPUT_DIR}/iq_${TIMESTAMP}.u8"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║           IQ RECORDING TOOL - Reference Capture            ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Host: ${RTLMUX_HOST}:${RTLMUX_PORT}"
echo "║  Output: ${OUTPUT_FILE}"
echo "║  Countdown: ${COUNTDOWN_DELAY} seconds"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 INSTRUCTIONS:"
echo "   1. Open SDR++ and tune to your signal"
echo "   2. Prepare SDR++ to record (Recorder → WAV → Audio)"  
echo "   3. Press ENTER when ready to start countdown"
echo ""
read -r -p "Press ENTER when SDR++ is ready... "

echo ""
echo "⏳ Starting countdown... Switch to SDR++ and START recording!"
echo ""

for i in $(seq "$COUNTDOWN_DELAY" -1 1); do
    echo "   $i..."
    sleep 1
done

echo ""
echo "🔴 RECORDING NOW - Press Ctrl+C to stop"
echo ""

# Handle Ctrl+C gracefully - kill all child processes
cleanup() {
    echo ""
    echo "⏹️  Stopping recording..."
    # Kill all child processes of this script
    pkill -P $$ 2>/dev/null || true
    sleep 0.5
    
    # Show file info
    if [[ -f "$OUTPUT_FILE" ]] && [[ -s "$OUTPUT_FILE" ]]; then
        SIZE=$(ls -lh "$OUTPUT_FILE" | awk '{print $5}')
        echo ""
        echo "✅ Recording saved!"
        echo "   File: $OUTPUT_FILE"
        echo "   Size: $SIZE"
        echo ""
        echo "📝 Remember to:"
        echo "   1. Stop SDR++ recording"
        echo "   2. Move SDR++ WAV to ${OUTPUT_DIR}/ with matching timestamp"
        echo "   3. Test with: ./scripts/test-csdr-pipeline.sh $OUTPUT_FILE"
    else
        echo "❌ No recording saved (file empty or missing)"
    fi
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Connect to rtlmux, skip 12-byte rtl_tcp header, save raw IQ
# Brace group reads from nc: first dd discards header, then cat streams the rest
nc "$RTLMUX_HOST" "$RTLMUX_PORT" | { dd bs=1 count=12 of=/dev/null 2>/dev/null; cat; } > "$OUTPUT_FILE"
