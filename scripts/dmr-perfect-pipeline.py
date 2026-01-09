#!/usr/bin/env python3
"""
DMR Perfect Pipeline Finder

Based on dsd-fme documentation analysis:
- Input: 48kHz or 96kHz mono WAV with FM discriminator audio
- DMR: 10 samples/symbol at 48kHz (4800 sym/s)
- Expected symbol levels: normalized to {-3, -1, +1, +3}
- No de-emphasis (critical for digital)

This script finds the optimal csdr pipeline parameters to produce
audio that dsd-fme can decode perfectly.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
import numpy as np
from scipy import signal


@dataclass
class PipelineConfig:
    """Pipeline configuration parameters."""
    gain: float = 1.0
    decimation: int = 43  # 2.048M / 43 ≈ 47.6kHz
    transition: float = 0.05
    dc_block: bool = True
    use_limiter: bool = True


@dataclass 
class TestResult:
    """Results from a pipeline test."""
    config: PipelineConfig
    color_code: Optional[int] = None
    sync_achieved: bool = False
    voice_frames: int = 0
    error_frames: int = 0
    fec_errors: int = 0
    wav_size: int = 0
    log_excerpt: str = ""
    
    def score(self) -> float:
        """Calculate quality score."""
        score = 0.0
        if self.color_code == 1:
            score += 200  # Target color code
        elif self.color_code is not None and self.color_code >= 0:
            score += 50  # Got some sync
        if self.sync_achieved:
            score += 100
        score += self.voice_frames * 5
        score -= self.error_frames * 2
        score -= self.fec_errors * 0.5
        if self.wav_size > 1000:
            score += 30
        return score


def analyze_iq_signal(iq_file: str) -> dict:
    """Analyze IQ file to determine signal characteristics."""
    print("Analyzing IQ signal...")
    
    iq_raw = np.fromfile(iq_file, dtype=np.uint8)
    i = iq_raw[0::2].astype(np.float32) - 127.5
    q = iq_raw[1::2].astype(np.float32) - 127.5
    iq = i + 1j * q
    
    fs = 2_048_000
    
    # Find signal in spectrum
    f, psd = signal.welch(iq, fs=fs, nperseg=8192, return_onesided=False)
    f = np.fft.fftshift(f)
    psd = np.fft.fftshift(psd)
    
    peak_idx = np.argmax(psd)
    offset = f[peak_idx]
    snr = 10 * np.log10(psd[peak_idx] / np.median(psd))
    
    print(f"  Signal offset: {offset:.0f} Hz")
    print(f"  SNR: {snr:.1f} dB")
    
    return {
        "offset_hz": offset,
        "snr_db": snr,
        "sample_rate": fs,
        "duration": len(iq) / fs,
    }


def build_pipeline(config: PipelineConfig, iq_file: str, wav_out: str, log_out: str) -> str:
    """Build the csdr + dsd-fme pipeline command."""
    
    input_rate = 2_048_000
    actual_rate = input_rate / config.decimation
    
    stages = [f"cat {iq_file}"]
    stages.append("csdr convert -i char -o float")
    stages.append(f"csdr firdecimate {config.decimation} {config.transition}")
    stages.append("csdr fmdemod")
    
    if config.dc_block:
        stages.append("csdr dcblock")
    
    stages.append(f"csdr gain {config.gain}")
    
    if config.use_limiter:
        stages.append("csdr limit")
    
    stages.append("csdr convert -i float -o s16")
    
    # sox wrapper: convert to 48kHz WAV for dsd-fme
    sox_cmd = f"sox -t raw -r {actual_rate:.1f} -e signed -b 16 -c 1 - -t wav -r 48000 -"
    stages.append(sox_cmd)
    
    # dsd-fme with DMR mode
    dsd_cmd = f"dsd-fme -i /dev/stdin -fs -N -w {wav_out}"
    stages.append(dsd_cmd)
    
    return " | ".join(stages) + f" 2> {log_out}"


def parse_log(log_path: str) -> dict:
    """Parse dsd-fme log for key metrics."""
    result = {
        "color_codes": [],
        "sync_achieved": False,
        "voice_frames": 0,
        "error_frames": 0,
        "fec_errors": 0,
        "relevant_lines": [],
    }
    
    try:
        with open(log_path, "r", errors="ignore") as f:
            for line in f:
                line = line.strip()
                
                # Check for sync
                if "Decoding DMR" in line:
                    result["sync_achieved"] = True
                
                # Color code
                cc_match = re.search(r"Color Code[=:\s]+(\d+)", line, re.I)
                if cc_match:
                    result["color_codes"].append(int(cc_match.group(1)))
                
                # Also handle "CC=XX" format
                if "Color Code=XX" in line:
                    result["color_codes"].append(-1)  # Invalid/error
                
                # Voice frames (VCx without error marker)
                if re.search(r"\bVC[0-6]\b", line) and "*" not in line and "ERR" not in line:
                    result["voice_frames"] += 1
                
                # Error frames (VC* or VC ERR)
                if re.search(r"VC[0-6]?\*", line) or "VC ERR" in line:
                    result["error_frames"] += 1
                
                # FEC errors
                if "FEC ERR" in line or "FEC Err" in line:
                    result["fec_errors"] += 1
                
                # Keep relevant lines
                if any(k in line.lower() for k in ["sync", "color", "vc", "err", "decod", "slot"]):
                    result["relevant_lines"].append(line)
    
    except Exception as e:
        result["error"] = str(e)
    
    return result


def run_test(config: PipelineConfig, iq_file: str, work_dir: str) -> TestResult:
    """Run a single pipeline test."""
    result = TestResult(config=config)
    
    wav_path = os.path.join(work_dir, "out.wav")
    log_path = os.path.join(work_dir, "dsd.log")
    
    cmd = build_pipeline(config, iq_file, wav_path, log_path)
    
    try:
        subprocess.run(cmd, shell=True, capture_output=True, timeout=60)
    except subprocess.TimeoutExpired:
        return result
    except Exception as e:
        return result
    
    # Parse log
    log_data = parse_log(log_path)
    
    result.sync_achieved = log_data["sync_achieved"]
    result.voice_frames = log_data["voice_frames"]
    result.error_frames = log_data["error_frames"]
    result.fec_errors = log_data["fec_errors"]
    
    # Determine most common color code (excluding errors)
    valid_ccs = [cc for cc in log_data["color_codes"] if cc >= 0]
    if valid_ccs:
        result.color_code = max(set(valid_ccs), key=valid_ccs.count)
    elif log_data["color_codes"]:
        result.color_code = -1  # All errors
    
    # WAV size
    if os.path.exists(wav_path):
        result.wav_size = os.path.getsize(wav_path)
    
    # Log excerpt
    result.log_excerpt = "\n".join(log_data["relevant_lines"][-15:])
    
    return result


def ensure_pulseaudio():
    """Start PulseAudio if needed."""
    try:
        subprocess.run(["pulseaudio", "--check"], capture_output=True, timeout=5)
    except:
        subprocess.run(["pulseaudio", "-D", "--exit-idle-time=-1"], 
                      capture_output=True, timeout=10)


def main():
    parser = argparse.ArgumentParser(description="Find optimal DMR decoding pipeline")
    parser.add_argument("--iq-file", default="/data/debug_audio/iq_capture_20260108_233019.u8")
    parser.add_argument("--quick", action="store_true", help="Quick sweep with fewer configs")
    parser.add_argument("--output", default="/data/debug_audio/pipeline_results")
    args = parser.parse_args()
    
    if not os.path.exists(args.iq_file):
        print(f"Error: IQ file not found: {args.iq_file}")
        return 1
    
    os.makedirs(args.output, exist_ok=True)
    ensure_pulseaudio()
    
    # Analyze signal
    sig_info = analyze_iq_signal(args.iq_file)
    
    print(f"\n{'='*60}")
    print("DMR Perfect Pipeline Finder")
    print(f"{'='*60}")
    print(f"IQ File: {args.iq_file}")
    print(f"Duration: {sig_info['duration']:.2f}s")
    print(f"SNR: {sig_info['snr_db']:.1f} dB")
    
    # Generate test configurations
    # Based on dsd-fme docs: expects 48kHz, 10 samples/symbol for DMR
    # Our input is 2.048 MHz, so decimation of 42-43 gives ~48kHz
    
    if args.quick:
        gains = [0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0]
        decimations = [42, 43]
        transitions = [0.05, 0.08]
        dc_blocks = [True]
        limiters = [True, False]
    else:
        gains = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0, 3.0, 5.0]
        decimations = [40, 42, 43, 48]
        transitions = [0.03, 0.05, 0.08, 0.1]
        dc_blocks = [True, False]
        limiters = [True, False]
    
    configs = []
    for g in gains:
        for d in decimations:
            for t in transitions:
                for dc in dc_blocks:
                    for lim in limiters:
                        configs.append(PipelineConfig(
                            gain=g, decimation=d, transition=t,
                            dc_block=dc, use_limiter=lim
                        ))
    
    print(f"Testing {len(configs)} configurations...")
    print(f"{'='*60}\n")
    
    results = []
    
    with tempfile.TemporaryDirectory() as work_dir:
        for i, config in enumerate(configs):
            pct = (i + 1) / len(configs) * 100
            rate = 2_048_000 / config.decimation
            print(f"\r[{pct:5.1f}%] G={config.gain:4.1f} D={config.decimation} "
                  f"T={config.transition:.2f} DC={'Y' if config.dc_block else 'N'} "
                  f"Lim={'Y' if config.use_limiter else 'N'} ({rate:.0f}Hz)    ",
                  end="", flush=True)
            
            result = run_test(config, args.iq_file, work_dir)
            results.append(result)
    
    print("\n")
    
    # Sort by score
    results.sort(key=lambda r: r.score(), reverse=True)
    
    # Display top results
    print(f"{'='*60}")
    print("TOP 15 RESULTS")
    print(f"{'='*60}")
    
    for i, r in enumerate(results[:15]):
        cc_str = f"CC:{r.color_code}" if r.color_code is not None else "CC:--"
        sync_str = "SYNC" if r.sync_achieved else "----"
        print(f"{i+1:2d}. Score:{r.score():6.1f} | "
              f"G:{r.config.gain:4.1f} D:{r.config.decimation} T:{r.config.transition:.2f} "
              f"DC:{'Y' if r.config.dc_block else 'N'} Lim:{'Y' if r.config.use_limiter else 'N'} | "
              f"{sync_str} {cc_str} VF:{r.voice_frames:3d} EF:{r.error_frames:3d} "
              f"WAV:{r.wav_size/1024:.1f}KB")
    
    # Summary stats
    sync_count = sum(1 for r in results if r.sync_achieved)
    cc1_count = sum(1 for r in results if r.color_code == 1)
    
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"  Total tests: {len(results)}")
    print(f"  Achieved sync: {sync_count} ({100*sync_count/len(results):.1f}%)")
    print(f"  Got Color Code 1: {cc1_count} ({100*cc1_count/len(results):.1f}%)")
    
    # Best result details
    if results:
        best = results[0]
        rate = 2_048_000 / best.config.decimation
        
        print(f"\n{'='*60}")
        print("BEST CONFIGURATION")
        print(f"{'='*60}")
        print(f"  Gain: {best.config.gain}")
        print(f"  Decimation: {best.config.decimation} ({rate:.1f} Hz)")
        print(f"  Transition: {best.config.transition}")
        print(f"  DC Block: {best.config.dc_block}")
        print(f"  Limiter: {best.config.use_limiter}")
        print(f"\n  Sync: {best.sync_achieved}")
        print(f"  Color Code: {best.color_code}")
        print(f"  Voice Frames: {best.voice_frames}")
        print(f"  Error Frames: {best.error_frames}")
        print(f"  FEC Errors: {best.fec_errors}")
        print(f"  WAV Size: {best.wav_size} bytes")
        
        if best.log_excerpt:
            print(f"\n  Recent log output:")
            for line in best.log_excerpt.split("\n")[-10:]:
                print(f"    {line}")
        
        # Generate recommended command
        print(f"\n{'='*60}")
        print("RECOMMENDED PIPELINE COMMAND")
        print(f"{'='*60}")
        print(f"""
cat {args.iq_file} | \\
csdr convert -i char -o float | \\
csdr firdecimate {best.config.decimation} {best.config.transition} | \\
csdr fmdemod | \\
{"csdr dcblock | " if best.config.dc_block else ""}csdr gain {best.config.gain} | \\
{"csdr limit | " if best.config.use_limiter else ""}csdr convert -i float -o s16 | \\
sox -t raw -r {rate:.1f} -e signed -b 16 -c 1 - -t wav -r 48000 - | \\
dsd-fme -i /dev/stdin -fs -N -w output.wav 2>&1
""")
        
        # Save results
        config_path = os.path.join(args.output, "best_config.json")
        with open(config_path, "w") as f:
            json.dump({
                "gain": best.config.gain,
                "decimation": best.config.decimation,
                "transition": best.config.transition,
                "dc_block": best.config.dc_block,
                "use_limiter": best.config.use_limiter,
                "demod_rate": rate,
                "results": {
                    "sync": best.sync_achieved,
                    "color_code": best.color_code,
                    "voice_frames": best.voice_frames,
                    "error_frames": best.error_frames,
                    "score": best.score(),
                }
            }, f, indent=2)
        print(f"\nSaved best config to: {config_path}")
    
    print(f"\n{'='*60}\n")
    
    return 0 if (results and results[0].color_code == 1) else 1


if __name__ == "__main__":
    sys.exit(main())
