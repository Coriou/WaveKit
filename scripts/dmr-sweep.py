#!/usr/bin/env python3
"""
DMR Pipeline Parameter Sweep Tool

Systematically tests different csdr + dsd-fme pipeline parameters to find
the optimal configuration for decoding DMR audio from IQ captures.

Success criteria:
- Color Code 1 (user-confirmed expected value)
- Valid voice frames (no VC* errors)
- Non-empty WAV output with actual audio content

Usage:
    python3 /scripts/dmr-sweep.py [--iq-file PATH] [--quick] [--verbose]
"""

import argparse
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional


@dataclass
class PipelineConfig:
    """Parameters for a single pipeline test run."""
    gain: float = 0.5
    transition: float = 0.05
    decimation: int = 43
    dc_block: bool = True
    use_limiter: bool = True
    input_rate: int = 2_048_000
    output_rate: int = 48000
    invert_polarity: bool = False


@dataclass
class TestResult:
    """Results from a single pipeline test."""
    config: PipelineConfig
    success: bool = False
    color_code: Optional[int] = None
    sync_type: Optional[str] = None
    voice_frames: int = 0
    error_frames: int = 0
    fec_errors: int = 0
    cach_errors: int = 0
    wav_size: int = 0
    wav_duration: float = 0.0
    log_excerpt: str = ""
    error_msg: str = ""

    def score(self) -> float:
        """Calculate a quality score for ranking results."""
        score = 0.0
        
        # Color Code 1 is the target (major bonus)
        if self.color_code == 1:
            score += 100
        elif self.color_code is not None:
            score += 20  # At least we got sync
        
        # Voice frames are good
        score += self.voice_frames * 2
        
        # Error frames are bad
        score -= self.error_frames * 1
        
        # FEC/CACH errors are bad
        score -= (self.fec_errors + self.cach_errors) * 0.5
        
        # WAV with actual content
        if self.wav_size > 1000:
            score += 50
        if self.wav_duration > 0.5:
            score += 30
        
        return score


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sweep DMR pipeline parameters to find optimal settings"
    )
    parser.add_argument(
        "--iq-file",
        default="/data/debug_audio/iq_capture_20260108_233019.u8",
        help="Path to IQ capture file (u8 format)"
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Run quick sweep with fewer parameter combinations"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show detailed output for each test"
    )
    parser.add_argument(
        "--output-dir",
        default="/data/debug_audio/sweep_results",
        help="Directory to store results and artifacts"
    )
    parser.add_argument(
        "--best-only",
        action="store_true",
        help="Only save artifacts for the best result"
    )
    return parser.parse_args()


def ensure_pulseaudio():
    """Ensure PulseAudio is running (required by dsd-fme)."""
    try:
        result = subprocess.run(
            ["pulseaudio", "--check"],
            capture_output=True,
            timeout=5
        )
        if result.returncode != 0:
            print("Starting PulseAudio...")
            subprocess.run(
                ["pulseaudio", "-D", "--exit-idle-time=-1"],
                capture_output=True,
                timeout=10
            )
    except Exception as e:
        print(f"Warning: Could not check/start PulseAudio: {e}")


def build_pipeline_command(config: PipelineConfig, iq_file: str, wav_out: str, log_out: str) -> str:
    """Build the complete pipeline command string."""
    actual_demod_rate = config.input_rate / config.decimation
    
    stages = [f"cat {iq_file}"]
    stages.append("csdr convert -i char -o float")
    stages.append(f"csdr firdecimate {config.decimation} {config.transition}")
    stages.append("csdr fmdemod")
    
    if config.dc_block:
        stages.append("csdr dcblock")
    
    # Polarity inversion (multiply by -1)
    if config.invert_polarity:
        stages.append("csdr gain -1")
        stages.append(f"csdr gain {abs(config.gain)}")
    else:
        stages.append(f"csdr gain {config.gain}")
    
    if config.use_limiter:
        stages.append("csdr limit")
    
    stages.append("csdr convert -i float -o s16")
    
    # sox WAV wrapper with proper sample rate
    sox_cmd = f"sox -t raw -r {actual_demod_rate:.1f} -e signed -b 16 -c 1 - -t wav -r {config.output_rate} -"
    stages.append(sox_cmd)
    
    # dsd-fme with DMR mode, no ncurses, WAV output
    dsd_cmd = f"dsd-fme -i /dev/stdin -fs -N -w {wav_out}"
    stages.append(dsd_cmd)
    
    return " | ".join(stages) + f" 2> {log_out}"


def parse_dsd_log(log_path: str) -> dict:
    """Parse dsd-fme log file for key metrics."""
    result = {
        "color_codes": [],
        "sync_types": [],
        "voice_frames": 0,
        "error_frames": 0,
        "fec_errors": 0,
        "cach_errors": 0,
        "burst_errors": 0,
        "log_lines": [],
    }
    
    try:
        with open(log_path, "r", errors="ignore") as f:
            for line in f:
                result["log_lines"].append(line.rstrip())
                
                # Color Code detection
                cc_match = re.search(r"Color Code[:\s]+(\d+)", line, re.I)
                if cc_match:
                    result["color_codes"].append(int(cc_match.group(1)))
                
                # Also try CC format
                cc_match2 = re.search(r"\bCC[:\s]+(\d+)\b", line)
                if cc_match2:
                    result["color_codes"].append(int(cc_match2.group(1)))
                
                # Sync type
                if "Decoding DMR" in line:
                    result["sync_types"].append("DMR")
                elif "Sync:" in line:
                    sync_match = re.search(r"Sync:\s*(\w+)", line)
                    if sync_match:
                        result["sync_types"].append(sync_match.group(1))
                
                # Voice frames
                if re.search(r"\bVC\d\b", line) and "ERR" not in line:
                    result["voice_frames"] += 1
                
                # Error frames  
                if re.search(r"VC\d?\*|VC\s*ERR", line):
                    result["error_frames"] += 1
                
                # FEC errors
                if "FEC ERR" in line or "FEC Err" in line:
                    result["fec_errors"] += 1
                
                # CACH errors
                if "CACH" in line and "ERR" in line:
                    result["cach_errors"] += 1
                
                # Burst errors
                if "Burst" in line and "ERR" in line:
                    result["burst_errors"] += 1
    
    except Exception as e:
        result["parse_error"] = str(e)
    
    return result


def get_wav_info(wav_path: str) -> dict:
    """Get WAV file information."""
    result = {"size": 0, "duration": 0.0, "has_audio": False}
    
    try:
        if os.path.exists(wav_path):
            result["size"] = os.path.getsize(wav_path)
            
            # Use sox to get audio stats
            proc = subprocess.run(
                ["sox", wav_path, "-n", "stat"],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            # Parse duration from stderr (sox outputs to stderr)
            duration_match = re.search(r"Length\s*\(seconds\)[:\s]+(\d+\.?\d*)", proc.stderr)
            if duration_match:
                result["duration"] = float(duration_match.group(1))
            
            # Check for actual audio content via RMS
            rms_match = re.search(r"RMS\s+amplitude[:\s]+(\d+\.?\d*)", proc.stderr)
            if rms_match:
                rms = float(rms_match.group(1))
                result["has_audio"] = rms > 0.001
                result["rms"] = rms
    
    except Exception as e:
        result["error"] = str(e)
    
    return result


def run_test(config: PipelineConfig, iq_file: str, work_dir: str, verbose: bool = False) -> TestResult:
    """Run a single pipeline test with given configuration."""
    result = TestResult(config=config)
    
    wav_path = os.path.join(work_dir, "output.wav")
    log_path = os.path.join(work_dir, "dsd.log")
    
    # Build and execute pipeline
    cmd = build_pipeline_command(config, iq_file, wav_path, log_path)
    
    if verbose:
        print(f"\n  Command: {cmd[:100]}...")
    
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60
        )
    except subprocess.TimeoutExpired:
        result.error_msg = "Pipeline timeout (60s)"
        return result
    except Exception as e:
        result.error_msg = f"Pipeline error: {e}"
        return result
    
    # Parse results
    log_data = parse_dsd_log(log_path)
    wav_info = get_wav_info(wav_path)
    
    # Populate result
    if log_data["color_codes"]:
        # Most common color code
        result.color_code = max(set(log_data["color_codes"]), key=log_data["color_codes"].count)
    
    if log_data["sync_types"]:
        result.sync_type = log_data["sync_types"][0]
    
    result.voice_frames = log_data["voice_frames"]
    result.error_frames = log_data["error_frames"]
    result.fec_errors = log_data["fec_errors"]
    result.cach_errors = log_data["cach_errors"]
    result.wav_size = wav_info["size"]
    result.wav_duration = wav_info["duration"]
    
    # Keep last 20 relevant log lines
    relevant_lines = [l for l in log_data["log_lines"] if any(k in l.lower() for k in ["color", "sync", "vc", "err", "decod"])]
    result.log_excerpt = "\n".join(relevant_lines[-20:])
    
    # Determine success
    result.success = (
        result.color_code == 1 and 
        result.voice_frames > result.error_frames and
        wav_info.get("has_audio", False)
    )
    
    return result


def generate_configs(quick: bool = False) -> list[PipelineConfig]:
    """Generate parameter combinations to test."""
    
    if quick:
        # Quick sweep - key parameters only
        gains = [0.3, 0.5, 0.7, 1.0]
        transitions = [0.05, 0.08]
        decimations = [42, 43, 50]
        dc_blocks = [True]
        limiters = [True, False]
        polarities = [False]
    else:
        # Full sweep
        gains = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 2.0]
        transitions = [0.03, 0.05, 0.08, 0.1, 0.12, 0.15]
        decimations = [40, 42, 43, 48, 50, 64]  # Different demod rates
        dc_blocks = [True, False]
        limiters = [True, False]
        polarities = [False, True]
    
    configs = []
    for gain, trans, dec, dc, lim, pol in itertools.product(
        gains, transitions, decimations, dc_blocks, limiters, polarities
    ):
        configs.append(PipelineConfig(
            gain=gain,
            transition=trans,
            decimation=dec,
            dc_block=dc,
            use_limiter=lim,
            invert_polarity=pol,
        ))
    
    return configs


def print_result_summary(result: TestResult, rank: int):
    """Print a formatted summary of a test result."""
    status = "✓" if result.success else "○" if result.color_code is not None else "✗"
    cc_str = f"CC:{result.color_code}" if result.color_code is not None else "CC:--"
    
    print(f"  {rank:3d}. {status} Score:{result.score():6.1f} | "
          f"G:{result.config.gain:4.1f} T:{result.config.transition:.2f} "
          f"D:{result.config.decimation:2d} DC:{'Y' if result.config.dc_block else 'N'} "
          f"Lim:{'Y' if result.config.use_limiter else 'N'} Inv:{'Y' if result.config.invert_polarity else 'N'} | "
          f"{cc_str} VF:{result.voice_frames:3d} EF:{result.error_frames:3d} "
          f"WAV:{result.wav_size/1024:.1f}KB")


def main():
    args = parse_args()
    
    # Validate IQ file exists
    if not os.path.exists(args.iq_file):
        print(f"Error: IQ file not found: {args.iq_file}")
        sys.exit(1)
    
    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)
    
    # Ensure PulseAudio is running
    ensure_pulseaudio()
    
    # Generate test configurations
    configs = generate_configs(quick=args.quick)
    print(f"\n{'='*70}")
    print(f"DMR Pipeline Parameter Sweep")
    print(f"{'='*70}")
    print(f"IQ File: {args.iq_file}")
    print(f"Mode: {'Quick' if args.quick else 'Full'} sweep ({len(configs)} configurations)")
    print(f"Output: {args.output_dir}")
    print(f"{'='*70}\n")
    
    results: list[TestResult] = []
    
    # Run tests
    with tempfile.TemporaryDirectory() as work_dir:
        for i, config in enumerate(configs):
            pct = (i + 1) / len(configs) * 100
            demod_rate = config.input_rate / config.decimation
            print(f"\r[{pct:5.1f}%] Testing: G={config.gain:.1f} T={config.transition:.2f} "
                  f"D={config.decimation} ({demod_rate/1000:.1f}kHz) "
                  f"DC={'Y' if config.dc_block else 'N'} Lim={'Y' if config.use_limiter else 'N'}    ",
                  end="", flush=True)
            
            result = run_test(config, args.iq_file, work_dir, verbose=args.verbose)
            results.append(result)
            
            if args.verbose and result.log_excerpt:
                print(f"\n  Log:\n{result.log_excerpt[:500]}")
    
    print("\n")
    
    # Sort by score
    results.sort(key=lambda r: r.score(), reverse=True)
    
    # Display results
    print(f"\n{'='*70}")
    print("TOP 20 RESULTS (by score)")
    print(f"{'='*70}")
    
    for i, result in enumerate(results[:20]):
        print_result_summary(result, i + 1)
    
    # Summary stats
    sync_count = sum(1 for r in results if r.color_code is not None)
    cc1_count = sum(1 for r in results if r.color_code == 1)
    audio_count = sum(1 for r in results if r.wav_size > 1000)
    
    print(f"\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    print(f"  Total tests: {len(results)}")
    print(f"  Achieved sync: {sync_count} ({sync_count/len(results)*100:.1f}%)")
    print(f"  Got Color Code 1: {cc1_count} ({cc1_count/len(results)*100:.1f}%)")
    print(f"  Produced audio: {audio_count} ({audio_count/len(results)*100:.1f}%)")
    
    # Best result details
    if results:
        best = results[0]
        print(f"\n{'='*70}")
        print("BEST CONFIGURATION")
        print(f"{'='*70}")
        print(f"  Gain: {best.config.gain}")
        print(f"  Transition: {best.config.transition}")
        print(f"  Decimation: {best.config.decimation}")
        print(f"  Demod Rate: {best.config.input_rate / best.config.decimation:.1f} Hz")
        print(f"  DC Block: {best.config.dc_block}")
        print(f"  Limiter: {best.config.use_limiter}")
        print(f"  Invert Polarity: {best.config.invert_polarity}")
        print(f"\n  Color Code: {best.color_code}")
        print(f"  Voice Frames: {best.voice_frames}")
        print(f"  Error Frames: {best.error_frames}")
        print(f"  WAV Size: {best.wav_size} bytes")
        print(f"  WAV Duration: {best.wav_duration:.2f}s")
        
        if best.log_excerpt:
            print(f"\n  Log excerpt:")
            for line in best.log_excerpt.split("\n")[-10:]:
                print(f"    {line}")
        
        # Save best config as JSON
        best_config_path = os.path.join(args.output_dir, "best_config.json")
        with open(best_config_path, "w") as f:
            json.dump({
                "gain": best.config.gain,
                "transition": best.config.transition,
                "decimation": best.config.decimation,
                "demod_rate": best.config.input_rate / best.config.decimation,
                "dc_block": best.config.dc_block,
                "use_limiter": best.config.use_limiter,
                "invert_polarity": best.config.invert_polarity,
                "results": {
                    "color_code": best.color_code,
                    "voice_frames": best.voice_frames,
                    "error_frames": best.error_frames,
                    "score": best.score(),
                }
            }, f, indent=2)
        print(f"\n  Saved best config to: {best_config_path}")
    
    # Save full results
    results_path = os.path.join(args.output_dir, "sweep_results.json")
    with open(results_path, "w") as f:
        json.dump([{
            "config": {
                "gain": r.config.gain,
                "transition": r.config.transition,
                "decimation": r.config.decimation,
                "dc_block": r.config.dc_block,
                "use_limiter": r.config.use_limiter,
                "invert_polarity": r.config.invert_polarity,
            },
            "score": r.score(),
            "color_code": r.color_code,
            "voice_frames": r.voice_frames,
            "error_frames": r.error_frames,
            "wav_size": r.wav_size,
        } for r in results], f, indent=2)
    print(f"  Saved full results to: {results_path}")
    
    print(f"\n{'='*70}\n")
    
    return 0 if (results and results[0].success) else 1


if __name__ == "__main__":
    sys.exit(main())
