#!/usr/bin/env python3
"""
DMR Signal Analyzer - Analyze IQ capture to determine optimal demodulation parameters.
"""

import numpy as np
from scipy import signal
import sys

def analyze_dmr_signal(iq_file: str):
    """Analyze DMR signal to determine proper demodulation settings."""
    
    print("=" * 60)
    print("DMR Signal Analysis")
    print("=" * 60)
    
    # Load IQ data
    iq_raw = np.fromfile(iq_file, dtype=np.uint8)
    i = iq_raw[0::2].astype(np.float32) - 127.5
    q = iq_raw[1::2].astype(np.float32) - 127.5
    iq = i + 1j * q

    sample_rate = 2_048_000
    print(f"\nInput: {iq_file}")
    print(f"IQ samples: {len(iq):,}")
    print(f"Duration: {len(iq)/sample_rate:.2f}s")
    print(f"Sample rate: {sample_rate:,} Hz")

    # Find the signal in the spectrum
    print("\n--- Spectrum Analysis ---")
    chunk_size = 4096
    f, psd = signal.welch(iq[:chunk_size*50], fs=sample_rate, nperseg=chunk_size, return_onesided=False)
    f = np.fft.fftshift(f)
    psd = np.fft.fftshift(psd)

    peak_idx = np.argmax(psd)
    offset_hz = f[peak_idx]
    peak_power_db = 10 * np.log10(psd[peak_idx])
    noise_floor_db = 10 * np.log10(np.median(psd))
    snr = peak_power_db - noise_floor_db
    
    print(f"Frequency offset: {offset_hz:.0f} Hz")
    print(f"Peak power: {peak_power_db:.1f} dB")
    print(f"Noise floor: {noise_floor_db:.1f} dB")
    print(f"SNR: {snr:.1f} dB")

    # Mix to baseband
    print("\n--- Baseband Conversion ---")
    t = np.arange(len(iq)) / sample_rate
    iq_centered = iq * np.exp(-1j * 2 * np.pi * offset_hz * t)
    print(f"Shifted by: {-offset_hz:.0f} Hz")

    # Test different decimation rates
    print("\n--- Decimation Rate Analysis ---")
    for dec in [40, 42, 43, 48, 50, 64, 85]:
        rate = sample_rate / dec
        nyq_bw = rate / 2
        print(f"  Dec={dec:2d}: Rate={rate:,.0f} Hz, Nyquist={nyq_bw:,.0f} Hz")
    
    # Use 43 for main analysis (close to 48kHz)
    decimation = 43
    iq_decimated = signal.decimate(iq_centered, decimation, ftype='fir')
    actual_rate = sample_rate / decimation
    print(f"\nUsing decimation={decimation} -> {actual_rate:.1f} Hz")

    # FM Demodulation  
    print("\n--- FM Demodulation ---")
    phase = np.unwrap(np.angle(iq_decimated))
    freq_inst = np.diff(phase) * actual_rate / (2 * np.pi)

    print(f"Demod samples: {len(freq_inst):,}")
    print(f"Freq deviation range: {freq_inst.min():.0f} to {freq_inst.max():.0f} Hz")
    print(f"Freq std: {np.std(freq_inst):.0f} Hz")

    # Find signal burst
    print("\n--- Signal Detection ---")
    power = np.abs(iq_decimated[:-1])**2
    power_smooth = np.convolve(power, np.ones(500)/500, mode='same')
    threshold = np.mean(power_smooth) * 1.5
    signal_mask = power_smooth > threshold
    
    signal_samples = np.sum(signal_mask)
    print(f"Signal threshold: {threshold:.2f}")
    print(f"Signal samples: {signal_samples:,} ({100*signal_samples/len(signal_mask):.1f}%)")

    if signal_samples > 1000:
        freq_during_signal = freq_inst[signal_mask]
        print(f"\n--- 4FSK Symbol Analysis (during signal) ---")
        print(f"Samples: {len(freq_during_signal):,}")
        print(f"Freq range: {freq_during_signal.min():.0f} to {freq_during_signal.max():.0f} Hz")
        print(f"Freq std: {np.std(freq_during_signal):.0f} Hz")
        
        # Histogram to find 4FSK levels
        hist, edges = np.histogram(freq_during_signal, bins=400)
        centers = (edges[:-1] + edges[1:]) / 2
        
        # Smooth histogram
        hist_smooth = np.convolve(hist, np.ones(5)/5, mode='same')
        
        # Find peaks
        peaks, props = signal.find_peaks(hist_smooth, height=np.max(hist_smooth)*0.05, distance=15)
        
        print(f"\nDetected symbol levels: {len(peaks)}")
        if len(peaks) > 0:
            peak_freqs = centers[peaks]
            peak_heights = hist_smooth[peaks]
            
            # Sort by height (prominence)
            sorted_idx = np.argsort(peak_heights)[::-1]
            top_peaks = peak_freqs[sorted_idx[:min(6, len(peaks))]]
            top_peaks_sorted = np.sort(top_peaks)
            
            print(f"Top level frequencies: {np.round(top_peaks_sorted, 0)}")
            print(f"Expected DMR levels: [-1944, -648, 648, 1944] Hz")
            
            # Calculate scaling factor
            if len(top_peaks_sorted) >= 4:
                # Use outer levels for scaling
                outer_pos = np.max(top_peaks_sorted)
                outer_neg = np.min(top_peaks_sorted)
                
                # DMR outer deviation is ±1944 Hz
                if abs(outer_pos) > 100 and abs(outer_neg) > 100:
                    current_outer = (abs(outer_pos) + abs(outer_neg)) / 2
                    scale_needed = 1944 / current_outer
                    print(f"\nCurrent outer deviation: ±{current_outer:.0f} Hz")
                    print(f"Target outer deviation: ±1944 Hz")
                    print(f"Scale factor needed: {scale_needed:.3f}")
                    
                    # What gain does this translate to?
                    print(f"\n--- Recommended Settings ---")
                    # csdr gain is applied after FM demod, scales the deviation
                    # The limit stage clips to ±1.0, so we need to scale appropriately
                    # dsd-fme expects audio levels, not frequency deviation
                    
                    # For dsd-fme, the audio input should have symbols at specific amplitude levels
                    # At 48kHz sample rate, normalized to ±1.0 range:
                    # Symbol ±3 (±1944Hz) should be at ~0.6-0.8 amplitude
                    # Symbol ±1 (±648Hz) should be at ~0.2-0.3 amplitude
                    
                    # The csdr pipeline outputs deviation in Hz, then converts to S16
                    # sox expects frequency deviation normalized to sample rate
                    
                    print(f"1. Frequency offset: {offset_hz:.0f} Hz - Apply shift in pipeline")
                    print(f"2. Deviation scaling: Current is {scale_needed:.2f}x off target")
                    
                    # Suggest optimal gain
                    # The fmdemod outputs normalized -1 to 1 based on instantaneous frequency
                    # We need to scale so ±1944Hz maps to a usable range for dsd-fme
                    
                    # dsd-fme uses a symbol slicer that expects certain audio levels
                    # Typically works best with -g auto or moderate gain
                    
                    return {
                        'offset_hz': offset_hz,
                        'snr_db': snr,
                        'scale_factor': scale_needed,
                        'current_deviation': current_outer,
                        'target_deviation': 1944,
                        'decimation': decimation,
                        'demod_rate': actual_rate,
                    }
    
    return None


def recommend_pipeline(analysis: dict):
    """Generate recommended pipeline command."""
    if not analysis:
        print("\nCould not generate recommendations - signal analysis failed")
        return
    
    print("\n" + "=" * 60)
    print("RECOMMENDED PIPELINE")
    print("=" * 60)
    
    offset = analysis['offset_hz']
    scale = analysis['scale_factor']
    dec = analysis['decimation']
    rate = analysis['demod_rate']
    
    # Calculate shift parameter for csdr
    shift = -offset / 2_048_000
    
    print(f"""
# Frequency-corrected pipeline with proper scaling
cat /data/debug_audio/iq_capture_20260108_233019.u8 | \\
csdr convert -i char -o float | \\
csdr shift {shift:.6f} | \\
csdr firdecimate {dec} 0.05 | \\
csdr fmdemod | \\
csdr dcblock | \\
csdr gain {scale:.2f} | \\
csdr limit | \\
csdr convert -i float -o s16 | \\
sox -t raw -r {rate:.1f} -e signed -b 16 -c 1 - -t wav -r 48000 - | \\
dsd-fme -i /dev/stdin -fs -N -w /data/debug_audio/dmr_test.wav 2>&1
""")
    
    # Also suggest trying without limiter (DMR 4FSK may need amplitude info)
    print(f"""
# Alternative: Without limiter (4FSK uses amplitude for symbols)
cat /data/debug_audio/iq_capture_20260108_233019.u8 | \\
csdr convert -i char -o float | \\
csdr shift {shift:.6f} | \\
csdr firdecimate {dec} 0.05 | \\
csdr fmdemod | \\
csdr dcblock | \\
csdr gain {scale * 0.8:.2f} | \\
csdr convert -i float -o s16 | \\
sox -t raw -r {rate:.1f} -e signed -b 16 -c 1 - -t wav -r 48000 - | \\
dsd-fme -i /dev/stdin -fs -N -w /data/debug_audio/dmr_test2.wav 2>&1
""")


if __name__ == "__main__":
    iq_file = sys.argv[1] if len(sys.argv) > 1 else "/data/debug_audio/iq_capture_20260108_233019.u8"
    analysis = analyze_dmr_signal(iq_file)
    recommend_pipeline(analysis)
