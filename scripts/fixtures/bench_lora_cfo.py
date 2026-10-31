#!/usr/bin/env python3
"""Bench the LoRa/Meshtastic chain against placement shifts plus crystal errors.

Each committed LongFast capture gets 8 synthetic upchirps inserted before the
frame (16, as Meshtastic sends), then a crystal error C (the matching
sample-clock error C / 869.525 MHz by resampling, plus the carrier offset C),
then a placement shift S (the channel S Hz above the capture centre: a pure
frequency shift, no clock error). It is re-quantised to cu8 at 1.024 Msps,
repeated --repeat times and piped through the live chain (`sox ... rate -m -b 74
500000`, then the wrapper with the argv buildDecoderArgs() builds).

A variant is how the wrapper learns the shift:

- known: `--shift-hz S --cfo-search-hz 0`, the adapter's argv when it knows the
  capture centre (always in the core: the source reports it). The default.
- search: `--shift-hz 0 --cfo-search-hz bw/5`, the adapter's argv when the
  centre is unknown (the opt-in recentred path).
- none: `--shift-hz 0 --cfo-search-hz 0`, no offset handling but frame_sync's own.

Needs sox, numpy, gnuradio + gr-lora_sdr and the wrapper: run it inside the core
image from the repository root, never against a live receiver. The acceptance
command (also printed first):

    python3 scripts/fixtures/bench_lora_cfo.py --cpu-seconds 60

Exit status 1 when a gating `known` run decodes other than --repeat frames
(fewer, or a duplicate). A run gates when |S| <= --target-hz (default 45 kHz:
loraMaxShiftHz() at 869.525 MHz, 190 000 - 125 000 - 20 000) and |C| <=
--crystal-target-hz (default 20 kHz, 23 ppm at 869.525 MHz).

--cpu-seconds N also measures the steady-state CPU of the default chain (known
variant, the largest gating shift so the rotator runs) on noise alone: the CPU of
a run of 10 + N seconds less that of a 10-second run, per signal second, so
gnuradio's import and flowgraph startup cancel out.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_lora_chain import (  # noqa: E402
    FIXTURES,
    cfo_search_hz,
    count_decodes,
    pinner,
    reap,
    sox_argv,
)

CHANNEL_HZ = 869_525_000
DEFAULT_SHIFTS_HZ = [0, 25_000, -25_000, 45_000, -45_000]
DEFAULT_CRYSTALS_HZ = [0, 5_000, -5_000, 10_000, -10_000, 20_000, -20_000]
VARIANTS = ["known", "search", "none"]
# scripts/fixtures/gen_lora.py: 0.25 s of 1.024 Msps noise precede the frame.
FRAME_START = 256_000
INSERTED_UPCHIRPS = 8
# loraMaxShiftHz() in src/decoders/builtin/lora-meshtastic.ts for LongFast at os 2
# and 869.525 MHz: 76 % x 500 000 / 2 - 125 000 - ceil(23 x 869.525) = 45 000 Hz.
SHIFT_TARGET_HZ = 45_000
# Largest crystal offset a run must decode: 20 kHz, 23 ppm at 869.525 MHz
# (LORA_CRYSTAL_MARGIN_PPM).
CRYSTAL_TARGET_HZ = 20_000
# The CPU baseline run's length; the measured run is this plus --cpu-seconds.
CPU_BASE_S = 10.0
ACCEPTANCE = "python3 scripts/fixtures/bench_lora_cfo.py --cpu-seconds 60"


def int_list(text: str) -> list[int]:
    return [int(o) for o in text.split(",") if o.strip()]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fixtures", default="fixtures/lora", help="capture directory")
    parser.add_argument("--shifts", default=",".join(str(o) for o in DEFAULT_SHIFTS_HZ),
                        help="comma-separated placement shifts in Hz")
    parser.add_argument("--crystals", default=",".join(str(o) for o in DEFAULT_CRYSTALS_HZ),
                        help="comma-separated crystal errors in Hz")
    parser.add_argument("--variant", action="append", choices=VARIANTS,
                        help="repeatable; default known")
    parser.add_argument("--target-hz", type=int, default=SHIFT_TARGET_HZ,
                        help=f"gate shifts within +-this (default {SHIFT_TARGET_HZ})")
    parser.add_argument("--crystal-target-hz", type=int, default=CRYSTAL_TARGET_HZ,
                        help=f"gate crystal errors within +-this (default {CRYSTAL_TARGET_HZ})")
    parser.add_argument("--repeat", type=int, default=3,
                        help="copies of each 0.91 s capture per run (default 3)")
    parser.add_argument("--cpu-seconds", type=float, default=0.0,
                        help="steady-state CPU over this many noise seconds; 0 skips it")
    parser.add_argument("--cpu", type=int, default=0,
                        help="CPU to pin both stages to; -1 leaves them unpinned")
    parser.add_argument("--input-rate", type=int, default=1_024_000)
    parser.add_argument("--bw", type=int, default=250_000)
    parser.add_argument("--sf", type=int, default=11)
    parser.add_argument("--cr", type=int, default=5)
    parser.add_argument("--os-factor", type=int, default=2)
    parser.add_argument("--sox-rate-opts", default="-m -b 74")
    parser.add_argument("--wrapper", default="/usr/local/bin/lora_meshtastic_decode.py")
    parser.add_argument("--sox", default="sox")
    parser.add_argument("--json", action="store_true", help="one JSON object per run")
    args = parser.parse_args()
    args.shifts = int_list(args.shifts)
    args.crystals = int_list(args.crystals)
    args.variant = args.variant or ["known"]
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    if args.cpu_seconds < 0:
        parser.error("--cpu-seconds must be at least 0")
    return args


def load_cu8(path: Path) -> np.ndarray:
    raw = np.frombuffer(path.read_bytes(), dtype=np.uint8).astype(np.float32)
    return ((raw[0::2] - 127.5) + 1j * (raw[1::2] - 127.5)) / 127.5


def to_cu8(x: np.ndarray) -> bytes:
    iq = np.empty(2 * len(x), dtype=np.float32)
    iq[0::2] = x.real
    iq[1::2] = x.imag
    return np.clip(np.round(iq * 127.5 + 127.5), 0, 255).astype(np.uint8).tobytes()


def upchirps(t: np.ndarray, bw: float, n: int) -> np.ndarray:
    """The base LoRa upchirp (-bw/2 to +bw/2 per symbol) at times t seconds, repeated."""
    period = n / bw
    tau = np.mod(t, period)
    return np.exp(2j * np.pi * (bw * bw / (2 * n) * tau * tau - bw / 2 * tau))


def fractional_advance(x: np.ndarray, samples: float) -> np.ndarray:
    """x moved earlier by a fraction of a sample (band-limited, zero-padded FFT)."""
    size = 1 << math.ceil(math.log2(len(x) + 4096))
    spectrum = np.fft.fft(x, size)
    spectrum *= np.exp(2j * np.pi * np.fft.fftfreq(size) * samples)
    return np.fft.ifft(spectrum)[: len(x)]


def insert_upchirps(x: np.ndarray, fs: float, bw: float, n: int) -> np.ndarray:
    """INSERTED_UPCHIRPS more preamble upchirps, so an 8-upchirp frame has 16.

    The frame start and complex gain come from correlating the committed preamble
    with the base upchirp near FRAME_START; the inserted symbols get the noise level
    of the leading noise, and the original frame moves later by exactly 8 symbols.
    """
    sym = n / bw * fs  # 8388.608 samples at 1.024 Msps
    span = int(8 * sym)
    template = upchirps(np.arange(span) / fs, bw, n)
    lags = np.arange(FRAME_START - 64, FRAME_START + 65)
    power = np.array([abs(np.vdot(template, x[lag:lag + span])) for lag in lags])
    peak = int(np.argmax(power[1:-1])) + 1
    start = int(lags[peak])
    # Parabolic peak: the frame starts `frac` samples after `start`, |frac| <= 0.5.
    below, at, above = power[peak - 1], power[peak], power[peak + 1]
    frac = 0.5 * (below - above) / (below - 2 * at + above)
    gain = np.vdot(upchirps((np.arange(span) - frac) / fs, bw, n), x[start:start + span]) / span
    sigma = np.std(x[: FRAME_START - 20_000])
    total = INSERTED_UPCHIRPS * sym
    whole = math.ceil(total)
    rng = np.random.default_rng(16)
    noise = sigma / math.sqrt(2) * (rng.standard_normal(whole) + 1j * rng.standard_normal(whole))
    inserted = gain * upchirps((np.arange(whole) - frac) / fs, bw, n) + noise
    tail = fractional_advance(x[start:], whole - total)
    return np.concatenate([x[:start], inserted, tail])


def crystal_resample(x: np.ndarray, ratio: float) -> np.ndarray:
    """y[k] = x(k x ratio): a transmitter clock fast by ratio - 1 (4x FFT upsampling, linear)."""
    up = 4
    size = len(x)
    spectrum = np.fft.fft(x)
    wide = np.zeros(size * up, dtype=np.complex128)
    half = size // 2
    wide[:half] = spectrum[:half]
    wide[-(size - half):] = spectrum[half:]
    fine = np.fft.ifft(wide) * up
    t = np.arange(int((size - 2) / ratio)) * ratio * up
    i = np.floor(t).astype(np.int64)
    frac = t - i
    return fine[i] * (1 - frac) + fine[i + 1] * frac


def make_capture(x: np.ndarray, shift_hz: int, crystal_hz: int,
                 args: argparse.Namespace) -> np.ndarray:
    """16 preamble upchirps, the crystal error (clock and carrier), then the placement shift."""
    fs = float(args.input_rate)
    x = insert_upchirps(x, fs, float(args.bw), 1 << args.sf)
    if crystal_hz:
        x = crystal_resample(x, 1 + crystal_hz / CHANNEL_HZ)
    offset = crystal_hz + shift_hz
    if offset:
        x = x * np.exp(2j * np.pi * offset * np.arange(len(x)) / fs)
    return x


def wrapper_argv(args: argparse.Namespace, out_rate: int, variant: str,
                 shift_hz: int) -> list[str]:
    # buildDecoderArgs() in src/decoders/builtin/lora-meshtastic.ts. The channel sits
    # shift_hz above the capture centre, so the adapter passes slot - centre = shift_hz.
    known = variant == "known"
    search = cfo_search_hz(args.bw) if variant == "search" else 0
    return ["python3", args.wrapper, "--bw", str(args.bw), "--sf", str(args.sf),
            "--cr", str(args.cr), "--samp-rate", str(out_rate), "--frequency", str(CHANNEL_HZ),
            "--channel-key", "AQ==", "--region", "EU_868",
            "--shift-hz", str(shift_hz if known else 0), "--cfo-search-hz", str(search)]


def wrapper_report(stderr: str) -> dict[str, Any]:
    """Per-path decodes and the last CFO estimate from the wrapper's exit summaries."""
    report: dict[str, Any] = {"paths": {}, "cfo_hz": None}
    for line in stderr.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("event") == "frame_drop_summary":
            report["paths"][event.get("path", "?")] = event.get("decoded_total")
        elif event.get("event") == "cfo_search_summary":
            report["cfo_hz"] = event.get("last_cfo_hz")
    return report


def run_chain(args: argparse.Namespace, capture: Path, argv: list[str],
              preexec: Callable[[], None] | None) -> dict[str, Any]:
    out_rate = args.bw * args.os_factor
    started = time.monotonic()
    with open(capture, "rb") as source, tempfile.TemporaryFile() as py_err:
        sox = subprocess.Popen(sox_argv(args.sox, args.input_rate, out_rate,
                                        args.sox_rate_opts.split()),
                               stdin=source, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, preexec_fn=preexec)
        py = subprocess.Popen(argv, stdin=sox.stdout,
                              stdout=subprocess.PIPE, stderr=py_err, preexec_fn=preexec)
        assert sox.stdout is not None and py.stdout is not None
        sox.stdout.close()
        stdout = py.stdout.read()
        py.stdout.close()
        py_code, py_cpu = reap(py)
        sox_code, sox_cpu = reap(sox)
        py_err.seek(0)
        stderr = py_err.read().decode("utf-8", "replace")
    return {"decodes": count_decodes(stdout), "sox_cpu_s": sox_cpu, "sox_exit": sox_code,
            "py_cpu_s": py_cpu, "py_exit": py_code, "wall_s": time.monotonic() - started,
            **wrapper_report(stderr), "py_stderr_tail": stderr.strip().splitlines()[-3:]}


def noise_capture(path: Path, seconds: float, sigma: float, rate: int) -> None:
    """Complex Gaussian noise at the captures' level, written in 1 s blocks."""
    rng = np.random.default_rng(60)
    left = int(seconds * rate)
    with open(path, "wb") as out:
        while left > 0:
            count = min(left, rate)
            x = sigma / math.sqrt(2) * (rng.standard_normal(count)
                                        + 1j * rng.standard_normal(count))
            out.write(to_cu8(x))
            left -= count


def steady_cpu(args: argparse.Namespace, tmp: Path, sigma: float,
               preexec: Callable[[], None] | None) -> dict[str, Any]:
    """CPU-s per signal second of the default chain on noise, startup excluded."""
    shift = max((s for s in args.shifts if abs(s) <= args.target_hz), key=abs, default=0)
    argv = wrapper_argv(args, args.bw * args.os_factor, "known", shift)
    runs = []
    for seconds in (CPU_BASE_S, CPU_BASE_S + args.cpu_seconds):
        path = tmp / "noise.cu8"
        noise_capture(path, seconds, sigma, args.input_rate)
        runs.append(run_chain(args, path, argv, preexec))
        path.unlink()
    span = args.cpu_seconds
    return {"shift_hz": shift, "noise_s": span,
            "sox_cpu_per_signal_s": round((runs[1]["sox_cpu_s"] - runs[0]["sox_cpu_s"]) / span, 4),
            "py_cpu_per_signal_s": round((runs[1]["py_cpu_s"] - runs[0]["py_cpu_s"]) / span, 4),
            "py_exit": [r["py_exit"] for r in runs], "decodes": [r["decodes"] for r in runs]}


def main() -> int:
    args = parse_args()
    preexec = pinner(args.cpu)
    failed = False
    out_rate = args.bw * args.os_factor
    if not args.json:
        print(f"acceptance: {ACCEPTANCE}")
        print(f"this run:   python3 {shlex.join(sys.argv)}")
        print(f"repeat={args.repeat} cpu={args.cpu} bw={args.bw} sf={args.sf} "
              f"os={args.os_factor}; gating: shift +-{args.target_hz} Hz x "
              f"crystal +-{args.crystal_target_hz} Hz, variant known")
        print(f"{'capture':27} {'var':6} {'shift':>7} {'xtal':>7} {'dec':>5} {'direct':>6} "
              f"{'recent':>6} {'cfo est':>8} {'sox/s':>6} {'py/s':>6} {'wall s':>6}")
    sigma = 0.0
    with tempfile.TemporaryDirectory(prefix="lora-cfo-bench-") as tmp_dir:
        tmp = Path(tmp_dir)
        for name in FIXTURES:
            base = load_cu8(Path(args.fixtures) / name)
            sigma = max(sigma, float(np.std(base[: FRAME_START - 20_000])))
            for shift in args.shifts:
                for crystal in args.crystals:
                    x = make_capture(base, shift, crystal, args)
                    path = tmp / "capture.cu8"
                    path.write_bytes(to_cu8(x) * args.repeat)
                    signal_s = len(x) * args.repeat / args.input_rate
                    for variant in args.variant:
                        r = run_chain(args, path, wrapper_argv(args, out_rate, variant, shift),
                                      preexec)
                        ok = (r["decodes"] == args.repeat and r["py_exit"] == 0
                              and r["sox_exit"] == 0)
                        gating = (variant == "known" and abs(shift) <= args.target_hz
                                  and abs(crystal) <= args.crystal_target_hz)
                        failed = failed or (gating and not ok)
                        row = {"capture": name, "variant": variant, "shift_hz": shift,
                               "crystal_hz": crystal, "expected": args.repeat, "ok": ok,
                               "gating": gating, "signal_s": round(signal_s, 3),
                               "sox_cpu_per_signal_s": round(r["sox_cpu_s"] / signal_s, 4),
                               "py_cpu_per_signal_s": round(r["py_cpu_s"] / signal_s, 4),
                               **{k: (round(v, 3) if isinstance(v, float) else v)
                                  for k, v in r.items()}}
                        if args.json:
                            print(json.dumps(row, sort_keys=True), flush=True)
                            continue
                        paths = r["paths"]
                        cfo = "-" if r["cfo_hz"] is None else f"{r['cfo_hz']:.0f}"
                        flag = "" if ok else ("  FAIL" if gating else "  miss")
                        print(f"{name:27} {variant:6} {shift:>7} {crystal:>7} "
                              f"{r['decodes']:>2}/{args.repeat:<2} {paths.get('direct', '-')!s:>6} "
                              f"{paths.get('recentred', '-')!s:>6} {cfo:>8} "
                              f"{row['sox_cpu_per_signal_s']:6.3f} {row['py_cpu_per_signal_s']:6.3f} "
                              f"{r['wall_s']:6.1f}{flag}", flush=True)
                        if not ok and r["py_stderr_tail"]:
                            print("    wrapper stderr: " + " | ".join(r["py_stderr_tail"]),
                                  flush=True)
        if args.cpu_seconds > 0:
            cpu = steady_cpu(args, tmp, sigma, preexec)
            # Noise alone must decode nothing and exit cleanly.
            failed = failed or cpu["py_exit"] != [0, 0] or any(cpu["decodes"])
            if args.json:
                print(json.dumps({"steady_state": cpu}, sort_keys=True), flush=True)
            else:
                print(f"steady state on {cpu['noise_s']:g} s of noise (shift {cpu['shift_hz']} Hz, "
                      f"run of {CPU_BASE_S + cpu['noise_s']:g} s less one of {CPU_BASE_S:g} s): "
                      f"sox {cpu['sox_cpu_per_signal_s']:.3f}, wrapper "
                      f"{cpu['py_cpu_per_signal_s']:.3f} CPU-s per signal second; "
                      f"exits {cpu['py_exit']}, decodes {cpu['decodes']}")
    if not args.json:
        print("FAIL: a gating case missed" if failed else "PASS: every gating case decoded")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
