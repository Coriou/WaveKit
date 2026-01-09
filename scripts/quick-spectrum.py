#!/usr/bin/env python3
"""Quick spectrum check for IQ file."""
import numpy as np
from scipy import signal

iq_raw = np.fromfile('/data/debug_audio/iq_capture_20260108_233019.u8', dtype=np.uint8)
i = iq_raw[0::2].astype(np.float32) - 127.5
q = iq_raw[1::2].astype(np.float32) - 127.5
iq = i + 1j * q
fs = 2_048_000

print(f"Samples: {len(iq)}, Duration: {len(iq)/fs:.2f}s")

# Full spectrum analysis
f, psd = signal.welch(iq, fs=fs, nperseg=8192, return_onesided=False)
f = np.fft.fftshift(f)
psd = np.fft.fftshift(psd)

# Find peak
peak_idx = np.argmax(psd)
offset = f[peak_idx]
print(f'Peak at: {offset:.0f} Hz')
print(f'Peak power: {10*np.log10(psd[peak_idx]):.1f} dB')

# Noise floor
noise = np.median(psd)
print(f'Noise floor: {10*np.log10(noise):.1f} dB')
print(f'SNR: {10*np.log10(psd[peak_idx]/noise):.1f} dB')

# Signal bandwidth
peak_power = psd[peak_idx]
threshold = peak_power / 10
above_thresh = psd > threshold
indices = np.where(above_thresh)[0]
if len(indices) > 0:
    bw = f[indices[-1]] - f[indices[0]]
    center = (f[indices[-1]] + f[indices[0]])/2
    print(f'Bandwidth (-10dB): {bw:.0f} Hz')
    print(f'Signal center: {center:.0f} Hz')
