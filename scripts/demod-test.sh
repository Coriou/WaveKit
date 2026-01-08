#!/bin/bash
# Demodulate strong IQ capture and try POCSAG decode

set -e

INPUT_FILE="${1:-/output/iq_auto_20260108_204703.u8}"
SAMPLE_RATE=2048000

echo "=== Demodulating: $INPUT_FILE ==="

# First, find where the signal is in the spectrum
echo "Finding signal offset..."
python3 << 'PYEOF'
import numpy as np
from scipy import signal

iq = np.fromfile("/output/iq_auto_20260108_204703.u8", dtype=np.uint8)
i = iq[0::2].astype(float) - 127.5
q = iq[1::2].astype(float) - 127.5
complex_sig = i + 1j*q

# Analyze in chunks to find signal
chunk_size = 2048000  # 1 second
best_power = 0
best_time = 0
for start in range(0, len(complex_sig) - chunk_size, chunk_size // 4):
    chunk = complex_sig[start:start+chunk_size//4]
    power = np.mean(np.abs(chunk)**2)
    if power > best_power:
        best_power = power
        best_time = start / 2048000

print(f"Strongest signal at: {best_time:.2f}s")
print(f"Signal power: {best_power:.1f}")

# Find frequency offset in strongest region
start_sample = int(best_time * 2048000)
chunk = complex_sig[start_sample:start_sample + 204800]  # 100ms
f, psd = signal.welch(chunk, fs=2048000, nperseg=8192, return_onesided=False)
f = np.fft.fftshift(f)
psd = np.fft.fftshift(psd)
peak_idx = np.argmax(psd)
offset_hz = f[peak_idx]
print(f"Frequency offset: {offset_hz:.0f} Hz")
print(f"Normalized shift: {-offset_hz / 2048000:.6f}")
PYEOF

echo ""
echo "Trying csdr demodulation..."

# Try with the pipeline from the handoff doc
cat "$INPUT_FILE" | \
    csdr convert -i char -o float | \
    csdr firdecimate 42 0.012 | \
    csdr fmdemod | \
    csdr gain 3 | \
    csdr limit | \
    csdr convert -i float -o s16 > /tmp/audio.raw

# Resample to 22050 for multimon-ng
sox -t raw -e signed -b 16 -r 48762 -c 1 /tmp/audio.raw \
    -t raw -e signed -b 16 -r 22050 -c 1 /tmp/audio22k.raw 2>/dev/null

echo ""
echo "Audio stats:"
python3 << 'PYEOF'
import numpy as np
data = np.fromfile("/tmp/audio22k.raw", dtype=np.int16)
print(f"  Duration: {len(data)/22050:.2f}s")
print(f"  RMS: {np.sqrt(np.mean(data.astype(float)**2)):.0f} (target: ~19000)")
print(f"  Max: {np.abs(data).max()}")

# Zero crossings
zc = np.sum(np.abs(np.diff(np.sign(data))) > 0)
print(f"  Zero crossings/s: {zc/(len(data)/22050):.0f} (target: ~8500)")
PYEOF

echo ""
echo "Trying POCSAG decode..."
multimon-ng -t raw -a POCSAG1200 /tmp/audio22k.raw 2>&1 | head -30
