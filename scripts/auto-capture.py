#!/usr/bin/env python3
"""
Smart IQ Capture - Signal-triggered recording with pre/post buffers.

Monitors rtlmux/rtl_tcp stream and captures IQ when signal is detected.
Uses a state machine with hysteresis to capture full transmissions.

Features:
- Pre-trigger buffer to capture signal preamble
- Post-trigger tail to capture signal end
- Separate trigger/release thresholds (hysteresis)
- Smoothed std to prevent false triggers
- Stats file for each capture
- Quiet mode for minimal output

Usage:
    python3 auto-capture.py --host 192.168.1.69 --port 1235 --threshold 1.5 --output /data/debug_audio
    python3 auto-capture.py --threshold 1.5 --release 1.2 --pre 2.0 --post 1.0 --output /data/debug_audio
    python3 auto-capture.py --quiet --max 20 --timeout 3600 --output /data/debug_audio
"""

import socket
import struct
import time
import argparse
import sys
from collections import deque
from pathlib import Path
from datetime import datetime

import numpy as np


def _running_in_container() -> bool:
    if Path("/.dockerenv").exists():
        return True
    try:
        cgroup = Path("/proc/1/cgroup").read_text(errors="ignore")
        return "docker" in cgroup or "containerd" in cgroup
    except Exception:
        return False


class SignalCapture:
    """Smart IQ capture with state machine and hysteresis."""
    
    HEADER_SIZE = 12
    SAMPLE_RATE = 2_048_000  # 2.048 Msps (as configured in rtl_tcp)
    
    def __init__(
        self,
        host: str = "192.168.1.69",
        port: int = 1235,
        trigger_threshold: float = 1.5,
        release_threshold: float | None = None,
        release_hold_sec: float = 0.15,
        pre_buffer_sec: float = 1.0,
        post_signal_sec: float = 0.5,
        min_duration_sec: float = 0.5,
        max_duration_sec: float = 60.0,
        cooldown_sec: float = 2.0,
        output_dir: str = "/data/debug_audio",
        quiet: bool = False,
    ):
        self.host = host
        self.port = port
        self.trigger_threshold = trigger_threshold
        self.release_threshold = release_threshold or (trigger_threshold * 0.85)
        self.release_hold_sec = release_hold_sec
        self.pre_buffer_sec = pre_buffer_sec
        self.post_signal_sec = post_signal_sec
        self.min_duration_sec = min_duration_sec
        self.max_duration_sec = max_duration_sec
        self.cooldown_sec = cooldown_sec
        self.output_dir = Path(output_dir)
        self.quiet = quiet
        
        # Derived values
        self.bytes_per_sec = self.SAMPLE_RATE * 2
        self.chunk_size = 32768  # ~8ms at 2.048 Msps
        
        # Ring buffer for pre-trigger
        pre_buffer_bytes = int(self.pre_buffer_sec * self.bytes_per_sec)
        self.pre_buffer_chunks = pre_buffer_bytes // self.chunk_size + 1
        
        self.output_dir.mkdir(parents=True, exist_ok=True)
    
    def _log(self, msg: str, end: str = "\n", flush: bool = False):
        """Print message if not in quiet mode."""
        if not self.quiet:
            print(msg, end=end, flush=flush)
    
    def _progress(self, msg: str):
        """Print progress line (overwritten)."""
        if not self.quiet:
            sys.stdout.write(f"\r{msg}   ")
            sys.stdout.flush()
    
    def connect(self) -> socket.socket:
        """Connect to rtlmux/rtl_tcp and read header."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(30.0)
        self._log(f"Connecting to {self.host}:{self.port}...")
        sock.connect((self.host, self.port))
        
        # Read RTL-TCP header
        header = sock.recv(self.HEADER_SIZE)
        if len(header) < self.HEADER_SIZE:
            raise RuntimeError("Failed to receive RTL-TCP header")
        
        magic = header[:4]
        tuner_type = struct.unpack(">I", header[4:8])[0]
        self._log(f"Connected! Magic: {magic}, Tuner type: {tuner_type}")
        
        sock.settimeout(1.0)
        return sock
    
    def analyze_chunk(self, data: bytes) -> float:
        """Calculate std dev of chunk."""
        arr = np.frombuffer(data, dtype=np.uint8)
        return float(np.std(arr))
    
    def save_capture(self, data: bytes, stats: dict) -> Path:
        """Save captured IQ data and stats file."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        iq_file = self.output_dir / f"iq_capture_{timestamp}.u8"
        stats_file = self.output_dir / f"iq_capture_{timestamp}_stats.txt"
        
        # Save IQ data
        with open(iq_file, "wb") as f:
            f.write(data)
        
        # Save stats
        duration = len(data) / self.bytes_per_sec
        with open(stats_file, "w") as f:
            f.write(f"Capture: {iq_file.name}\n")
            f.write(f"Timestamp: {timestamp}\n")
            f.write(f"Size: {len(data):,} bytes\n")
            f.write(f"Duration: {duration:.2f}s\n")
            f.write(f"Sample rate: {self.SAMPLE_RATE:,} Sps\n")
            f.write(f"Peak std: {stats.get('peak_std', 0):.2f}\n")
            f.write(f"Mean std: {stats.get('mean_std', 0):.2f}\n")
            f.write(f"Trigger threshold: {self.trigger_threshold}\n")
            f.write(f"Release threshold: {self.release_threshold}\n")
        
        return iq_file
    
    def monitor(self, max_captures: int = 10, timeout_sec: float = 300) -> int:
        """Monitor stream and capture on signal detection."""
        sock = self.connect()
        
        captures = 0
        start_time = time.time()
        
        # State machine
        state = "WAITING"  # WAITING, CAPTURING, POST_SIGNAL
        ring_buffer: deque[bytes] = deque(maxlen=self.pre_buffer_chunks)
        capture_buffer: list[bytes] = []
        signal_start_time = 0.0
        last_signal_time = 0.0
        last_capture_time = 0.0
        capture_stats = {"peak_std": 0.0, "std_samples": []}

        # Debounce signal end detection (prevents rapid end/resume flapping)
        release_candidate_since: float | None = None
        
        # Smoothing for std (prevent false triggers)
        std_history: deque[float] = deque(maxlen=5)
        
        self._log(f"\n{'=' * 60}")
        self._log(f"Monitoring for signals")
        self._log(f"  Trigger: std > {self.trigger_threshold}")
        self._log(f"  Release: std < {self.release_threshold}")
        self._log(f"  Pre-buffer: {self.pre_buffer_sec}s, Post-tail: {self.post_signal_sec}s")
        self._log(f"  Duration: {self.min_duration_sec}s - {self.max_duration_sec}s")
        self._log(f"{'=' * 60}\n")
        
        try:
            while captures < max_captures:
                # Check timeout
                elapsed = time.time() - start_time
                if timeout_sec > 0 and elapsed > timeout_sec:
                    self._log(f"\nTimeout reached ({timeout_sec}s)")
                    break
                
                # Read chunk
                try:
                    data = sock.recv(self.chunk_size)
                    if not data:
                        self._log("Connection closed")
                        break
                except socket.timeout:
                    continue
                
                # Analyze
                std = self.analyze_chunk(data)
                std_history.append(std)
                smoothed_std = float(np.mean(std_history))
                
                now = time.time()
                
                if state == "WAITING":
                    ring_buffer.append(data)
                    
                    # Check for trigger (with cooldown)
                    if smoothed_std > self.trigger_threshold and (now - last_capture_time) > self.cooldown_sec:
                        self._log(f"\n🔊 TRIGGERED! std={smoothed_std:.2f}")
                        state = "CAPTURING"
                        signal_start_time = now
                        last_signal_time = now
                        
                        # Start with pre-buffer
                        capture_buffer = list(ring_buffer)
                        capture_buffer.append(data)
                        capture_stats = {"peak_std": smoothed_std, "std_samples": [smoothed_std]}
                        
                        pre_sec = len(b"".join(capture_buffer)) / self.bytes_per_sec
                        self._log(f"  Pre-buffer: {pre_sec:.2f}s")
                    else:
                        # Show progress
                        bar_len = int(min(smoothed_std / 2.0, 1.0) * 30)
                        bar = "█" * bar_len + "░" * (30 - bar_len)
                        marker_pos = min(int(self.trigger_threshold / 2.0 * 30), 29)
                        bar = bar[:marker_pos] + "|" + bar[marker_pos + 1:]
                        self._progress(f"[{bar}] std={smoothed_std:.2f} cap={captures}/{max_captures}")
                
                elif state == "CAPTURING":
                    capture_buffer.append(data)
                    capture_stats["std_samples"].append(smoothed_std)
                    if smoothed_std > capture_stats["peak_std"]:
                        capture_stats["peak_std"] = smoothed_std
                    
                    duration = now - signal_start_time
                    
                    # Check for signal end
                    if smoothed_std < self.release_threshold:
                        if release_candidate_since is None:
                            release_candidate_since = now
                        elif (now - release_candidate_since) >= self.release_hold_sec:
                            self._log(f"\n  Signal ended at {duration:.2f}s")
                            state = "POST_SIGNAL"
                            last_signal_time = now
                    elif duration >= self.max_duration_sec:
                        self._log(f"\n  Max duration reached")
                        state = "SAVING"
                    else:
                        release_candidate_since = None
                        self._progress(f"  Capturing: {duration:.1f}s std={smoothed_std:.2f}")
                
                elif state == "POST_SIGNAL":
                    capture_buffer.append(data)
                    
                    if smoothed_std > self.trigger_threshold:
                        # Signal came back strongly enough to re-trigger
                        state = "CAPTURING"
                        release_candidate_since = None
                        self._log("  Signal resumed")
                    elif (now - last_signal_time) >= self.post_signal_sec:
                        state = "SAVING"
                
                if state == "SAVING":
                    total_duration = now - signal_start_time
                    
                    if total_duration >= self.min_duration_sec:
                        all_data = b"".join(capture_buffer)
                        capture_stats["mean_std"] = float(np.mean(capture_stats["std_samples"]))
                        del capture_stats["std_samples"]
                        
                        filepath = self.save_capture(all_data, capture_stats)
                        captures += 1
                        last_capture_time = now
                        
                        self._log(f"✅ Saved: {filepath.name}")
                        self._log(f"   Duration: {total_duration:.2f}s, Size: {len(all_data):,} bytes")
                        self._log(f"   Peak std: {capture_stats['peak_std']:.2f}, Mean std: {capture_stats['mean_std']:.2f}")
                        self._log("")
                    else:
                        self._log(f"⚠️  Too short ({total_duration:.2f}s < {self.min_duration_sec}s), discarding\n")
                    
                    # Reset
                    state = "WAITING"
                    capture_buffer = []
                    ring_buffer.clear()
                    capture_stats = {"peak_std": 0.0, "std_samples": []}
                    release_candidate_since = None
        
        except KeyboardInterrupt:
            self._log("\n\nInterrupted by user")
            
            # Save in-progress capture
            if capture_buffer and len(b"".join(capture_buffer)) > self.min_duration_sec * self.bytes_per_sec:
                all_data = b"".join(capture_buffer)
                capture_stats["mean_std"] = float(np.mean(capture_stats.get("std_samples", [0])))
                if "std_samples" in capture_stats:
                    del capture_stats["std_samples"]
                filepath = self.save_capture(all_data, capture_stats)
                captures += 1
                self._log(f"Saved partial: {filepath.name}")
        finally:
            sock.close()
        
        self._log(f"\nTotal captures: {captures}")
        return captures


def main():
    parser = argparse.ArgumentParser(
        description="Smart IQ Capture - Signal-triggered recording",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --threshold 1.5              # Basic monitoring
  %(prog)s --threshold 1.5 --release 1.2 --pre 2.0  # Custom hysteresis
  %(prog)s --quiet --max 20 --timeout 3600  # Long unattended capture
        """
    )
    parser.add_argument("--host", default="192.168.1.69", help="rtlmux/rtl_tcp host")
    parser.add_argument("--port", type=int, default=1235, help="rtlmux/rtl_tcp port")
    parser.add_argument("--threshold", type=float, default=1.5, 
                        help="Trigger threshold (std dev)")
    parser.add_argument("--release", type=float, default=None,
                        help="Release threshold (default: 85%% of trigger)")
    parser.add_argument(
        "--release-hold",
        type=float,
        default=0.15,
        help="Seconds below release threshold required to end signal (debounce)",
    )
    parser.add_argument("--pre", type=float, default=1.0,
                        help="Pre-trigger buffer seconds")
    parser.add_argument("--post", type=float, default=0.5,
                        help="Post-signal tail seconds")
    parser.add_argument("--min-duration", type=float, default=0.5,
                        help="Minimum capture duration")
    parser.add_argument("--max-duration", type=float, default=60.0,
                        help="Maximum capture duration")
    parser.add_argument("--cooldown", type=float, default=2.0,
                        help="Cooldown between captures")
    parser.add_argument("--max", type=int, default=10,
                        help="Maximum number of captures")
    parser.add_argument("--timeout", type=float, default=300,
                        help="Monitoring timeout (0 = no timeout)")
    parser.add_argument("--output", default="/data/debug_audio",
                        help="Output directory")
    parser.add_argument("--quiet", "-q", action="store_true",
                        help="Minimal output")
    parser.add_argument(
        "--allow-host",
        action="store_true",
        help="Allow running outside the demod-test container (advanced)",
    )
    
    args = parser.parse_args()

    if not args.allow_host and not _running_in_container():
        print(
            "This tool is intended to run inside the demod-test container.\n\n"
            "Run it via:\n"
            "  docker compose -f docker-compose.demod-test.yml run --rm demod-test "
            "python3 /scripts/auto-capture.py --output /data/debug_audio\n\n"
            "Or use the interactive wrapper:\n"
            "  node scripts/auto-capture.mjs\n",
            file=sys.stderr,
        )
        raise SystemExit(2)
    
    capture = SignalCapture(
        host=args.host,
        port=args.port,
        trigger_threshold=args.threshold,
        release_threshold=args.release,
        release_hold_sec=args.release_hold,
        pre_buffer_sec=args.pre,
        post_signal_sec=args.post,
        min_duration_sec=args.min_duration,
        max_duration_sec=args.max_duration,
        cooldown_sec=args.cooldown,
        output_dir=args.output,
        quiet=args.quiet,
    )
    
    capture.monitor(max_captures=args.max, timeout_sec=args.timeout)


if __name__ == "__main__":
    main()
