
import numpy as np
import sys

def analyze_iq(filename, sample_rate=2048000):
    try:
        data = np.fromfile(filename, dtype=np.uint8)
        # Convert to complex float
        iq = (data.astype(np.float32) - 127.5) / 127.5
        iq = iq[0::2] + 1j * iq[1::2]
        
        # Take a slice from the middle
        start = len(iq) // 3
        slice_len = 32768
        segment = iq[start : start + slice_len]
        
        # FFT
        fft = np.fft.fftshift(np.fft.fft(segment))
        freqs = np.fft.fftshift(np.fft.fftfreq(slice_len, 1/sample_rate))
        mag = 20 * np.log10(np.abs(fft) + 1e-9)
        
        # Find peak
        peak_idx = np.argmax(mag)
        peak_freq = freqs[peak_idx]
        peak_pwr = mag[peak_idx]
        
        # Noise floor (approximate) - median
        noise_floor = np.median(mag)
        
        print(f"File: {filename}")
        print(f"Peak Freq: {peak_freq:.1f} Hz")
        print(f"Peak Power: {peak_pwr:.1f} dB")
        print(f"Noise Floor: {noise_floor:.1f} dB")
        print(f"SNR: {peak_pwr - noise_floor:.1f} dB")
        
        # Check centering (is peak near 0?)
        if abs(peak_freq) > 15000:
            print("WARNING: Signal is significantly offset from center (>15kHz)!")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 plot_psd.py <file>")
        sys.exit(1)
    analyze_iq(sys.argv[1])
