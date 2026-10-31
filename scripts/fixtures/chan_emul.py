"""Approximates the core channelizer's channel tail for direwolf: cu8 1.024 Msps in,
shift OFFSET_HZ to DC, resample 3/64 to cf32 48 kHz on stdout. numpy + scipy; it is an
approximation of wavekit-chan, not the Rust channelizer.

Usage: python3 chan_emul.py FILE.cu8 OFFSET_HZ | csdr fmdemod | ... | direwolf ...
"""
import sys, numpy as np
from scipy.signal import resample_poly
off = float(sys.argv[2])
u = np.fromfile(sys.argv[1], dtype=np.uint8).astype(np.float32)
x = ((u[0::2] - 127.5) + 1j * (u[1::2] - 127.5)) / 127.5
n = np.arange(len(x))
x = x * np.exp(-2j * np.pi * off * n / 1024000)
y = resample_poly(x, 3, 64).astype(np.complex64)
sys.stdout.buffer.write(y.tobytes())
