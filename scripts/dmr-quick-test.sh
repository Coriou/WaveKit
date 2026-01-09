#!/bin/bash
# Quick DMR decode test - run inside demod-test container
# Usage: docker compose -f docker-compose.demod-test.yml run --rm demod-test /scripts/dmr-quick-test.sh

set -e

echo "Starting PulseAudio..."
pulseaudio -D --exit-idle-time=-1 2>/dev/null || true
sleep 1

IQ_FILE="/data/debug_audio/iq_capture_20260108_233019.u8"
GAIN="${1:-0.25}"

echo "=== DMR Quick Test (gain=$GAIN) ==="

# Create discriminator audio
echo "Creating discriminator audio..."
cat "$IQ_FILE" | \
  csdr convert -i char -o float | \
  csdr firdecimate 43 0.05 | \
  csdr fmdemod | \
  csdr dcblock | \
  csdr gain $GAIN | \
  csdr convert -i float -o s16 | \
  sox -t raw -r 47627.9 -e signed -b 16 -c 1 - -t wav -r 48000 /tmp/input.wav

echo ""
echo "Input WAV stats:"
sox /tmp/input.wav -n stat 2>&1 | grep -E "Maximum|RMS|amplitude"

echo ""
echo "Running dsd-fme (output goes to /tmp/output.wav)..."
# Note: Do NOT use -N flag - it ENABLES ncurses, which causes hangs
# Use -o null for no audio output, -w for WAV file output
timeout 15 dsd-fme -i /tmp/input.wav -fs -o null -w /tmp/output.wav 2>&1 || true

echo ""
echo "=== Results ==="
echo "Output WAV:"
ls -la /tmp/output.wav

WAV_SIZE=$(stat -c%s /tmp/output.wav 2>/dev/null || stat -f%z /tmp/output.wav 2>/dev/null)
if [ "$WAV_SIZE" -gt 100 ]; then
  echo "SUCCESS: Output WAV has audio data ($WAV_SIZE bytes)"
  sox /tmp/output.wav -n stat 2>&1 | head -5
else
  echo "FAILED: Output WAV is empty/header only ($WAV_SIZE bytes)"
fi
