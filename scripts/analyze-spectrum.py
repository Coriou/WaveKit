#!/usr/bin/env python3
"""
Detailed spectral analysis to find signal location in IQ capture.
"""

import sys
import numpy as np
from scipy import signal as sig


def analyze_spectrum(filepath: str):
    """Analyze the spectrum of an IQ capture file."""
    # Load the IQ data
    data = np.fromfile(filepath, dtype=np.uint8)
    iq = (data[::2].astype(np.float32) - 127.5) + 1j * (data[1::2].astype(np.float32) - 127.5)

    print(f"Total samples: {len(iq):,} ({len(iq)/2.4e6:.2f}s)")
    print(f"Sample rate: 2.4 Msps")

    # FFT with higher resolution
    fft_size = 65536
    spectrum = np.abs(np.fft.fftshift(np.fft.fft(iq[:fft_size])))
    freqs = np.fft.fftshift(np.fft.fftfreq(fft_size, 1/2.4e6))

    # Find top peaks
    peak_indices = np.argsort(spectrum)[-10:][::-1]
    print("\n=== Top 10 Spectral Peaks (first 65536 samples) ===")
    for i, idx in enumerate(peak_indices):
        power_db = 20*np.log10(spectrum[idx] + 1e-10)
        print(f"  {i+1}. {freqs[idx]/1000:8.1f} kHz  ({power_db:.1f} dB)")

    # Also look at power spectral density across the full file
    print("\n=== Full file PSD analysis ===")
    f, Pxx = sig.welch(iq, fs=2.4e6, nperseg=8192, return_onesided=False)
    f = np.fft.fftshift(f)
    Pxx = np.fft.fftshift(Pxx)

    # Find peaks in PSD
    Pxx_db = 10*np.log10(Pxx + 1e-10)
    noise_floor = np.median(Pxx_db)
    print(f"Noise floor: {noise_floor:.1f} dB")

    # Find significant peaks (>10dB above noise)
    threshold = noise_floor + 10
    peak_mask = Pxx_db > threshold
    peak_freqs = f[peak_mask]
    peak_powers = Pxx_db[peak_mask]

    if len(peak_freqs) > 0:
        # Cluster peaks
        print(f"\nSignificant peaks (>{threshold:.0f} dB):")
        sorted_idx = np.argsort(peak_powers)[::-1]
        shown = set()
        for idx in sorted_idx[:20]:
            freq_khz = peak_freqs[idx]/1000
            # Skip if we already showed something within 5 kHz
            if any(abs(freq_khz - s) < 5 for s in shown):
                continue
            shown.add(freq_khz)
            print(f"  {freq_khz:8.1f} kHz  ({peak_powers[idx]:.1f} dB)")
    else:
        print("No significant peaks found above noise floor + 10dB")

    # Check for narrowband signal characteristics
    print("\n=== Narrowband signal scan (25 kHz steps) ===")
    for center_khz in range(-1000, 1001, 25):
        center_hz = center_khz * 1000
        # Filter around this frequency
        freq_idx = np.abs(f - center_hz) < 15000  # 15 kHz bandwidth
        if np.any(freq_idx):
            local_power = np.mean(Pxx_db[freq_idx])
            if local_power > noise_floor + 5:
                print(f"  Signal at {center_khz:+5d} kHz: {local_power:.1f} dB")
    
    # Time-domain analysis - look for bursts
    print("\n=== Time-domain burst analysis ===")
    chunk_samples = int(2.4e6 * 0.1)  # 100ms chunks
    for i in range(min(10, len(iq) // chunk_samples)):
        chunk = iq[i*chunk_samples:(i+1)*chunk_samples]
        chunk_std = np.std(np.abs(chunk))
        if chunk_std > 10:  # Significant activity
            # Find where the signal is in this chunk
            chunk_fft = np.abs(np.fft.fftshift(np.fft.fft(chunk[:8192])))
            chunk_freqs = np.fft.fftshift(np.fft.fftfreq(8192, 1/2.4e6))
            peak_idx = np.argmax(chunk_fft)
            peak_freq = chunk_freqs[peak_idx]
            print(f"  Chunk {i} ({i*0.1:.1f}-{(i+1)*0.1:.1f}s): std={chunk_std:.1f}, peak at {peak_freq/1000:.1f} kHz")

    return iq, f, Pxx_db


if __name__ == "__main__":
    filepath = sys.argv[1] if len(sys.argv) > 1 else "/output/iq_capture_20260108_173232.u8"
    analyze_spectrum(filepath)
