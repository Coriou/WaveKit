#!/usr/bin/env python3
"""Bench the LoRa/Meshtastic chain against carrier offsets (CFO).

Each committed LongFast capture is moved off its channel in numpy at 1.024 Msps,
re-quantised to cu8, repeated --repeat times and piped through the live chain
(`sox ... rate -m -b 74 500000`, then the wrapper with the argv buildDecoderArgs()
builds). A case is MODEL + PREAMBLE:

- shift: a pure frequency shift (the channel off the capture centre, which centre
  placement allows, or a mistuned centre). No sample-clock error.
- crystal: a transmitter crystal error: the same shift plus the matching
  sample-clock error (offset / 869.525 MHz), applied by resampling.
- 8: the committed captures (8 preamble upchirps, as gen_lora.py modulates).
- 16: 8 synthetic upchirps inserted before the frame, so 16 like Meshtastic sends.

A variant is NAME:EXTRA_WRAPPER_ARGS. `new` is the live argv; `old` adds
`--cfo-search-hz 0 --preamble-len 8`, the wrapper before the CFO search (one
gr-lora_sdr path expecting 8 upchirps).

Needs sox, numpy, gnuradio + gr-lora_sdr and the wrapper: run it inside the core
image from the repository root, never against a live receiver:

    python3 scripts/fixtures/bench_lora_cfo.py
    python3 scripts/fixtures/bench_lora_cfo.py --variant old --variant new --repeat 1

This is the in-image acceptance for the decoder's offset handling (the image has
no pnpm or dev dependencies). Exit status 1 when a gating `new`-variant run decodes
other than --repeat frames (fewer, or a duplicate the two paths both let through).
A run gates when its offset is within the range that model must decode:

- shift: --target-hz, default the search range bw/5 (50 kHz for 250 kHz), the
  largest offset the planner places a slot off the capture centre. The recentred
  path removes it.
- crystal: --crystal-target-hz, default 20 kHz (23 ppm at 869.525 MHz). Only the
  direct path (gr-lora_sdr's own clock model) decodes a large crystal offset: the
  recentred path removes the offset but not its clock error, which drifts the
  symbol timing by N x offset / 869.525 MHz chips per symbol, past half a chip
  within the ~40 symbols after sync once |offset| > 0.5 x 869.525 MHz / (40 x
  2048) = 5.3 kHz. In-image runs decoded every crystal16 copy up to +-20 kHz and
  missed one of three at -25 kHz.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
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
DEFAULT_OFFSETS_HZ = [0, 2_000, -2_000, 5_000, -5_000, 10_000, -10_000, 15_000, -15_000,
                      20_000, -20_000, 25_000, -25_000, 30_000, -30_000, 40_000, -40_000,
                      50_000, -50_000]
DEFAULT_CASES = ["shift8", "crystal16"]
VARIANTS = {"new": [], "old": ["--cfo-search-hz", "0", "--preamble-len", "8"]}
# scripts/fixtures/gen_lora.py: 0.25 s of 1.024 Msps noise precede the frame.
FRAME_START = 256_000
INSERTED_UPCHIRPS = 8
# Largest crystal offset a run must decode (module docstring).
CRYSTAL_TARGET_HZ = 20_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fixtures", default="fixtures/lora", help="capture directory")
    parser.add_argument("--offsets", default=",".join(str(o) for o in DEFAULT_OFFSETS_HZ),
                        help="comma-separated carrier offsets in Hz")
    parser.add_argument("--case", action="append", choices=["shift8", "shift16",
                        "crystal8", "crystal16"], help=f"repeatable; default {DEFAULT_CASES}")
    parser.add_argument("--variant", action="append", choices=sorted(VARIANTS),
                        help="repeatable; default new")
    parser.add_argument("--target-hz", type=int, default=None,
                        help="exit 1 on a failed new shift run within +-this; default bw/5")
    parser.add_argument("--crystal-target-hz", type=int, default=CRYSTAL_TARGET_HZ,
                        help="exit 1 on a failed new crystal run within +-this; "
                        f"default {CRYSTAL_TARGET_HZ}")
    parser.add_argument("--repeat", type=int, default=3,
                        help="copies of each 0.91 s capture per run (default 3)")
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
    args.offsets = [int(o) for o in args.offsets.split(",") if o.strip()]
    args.case = args.case or DEFAULT_CASES
    args.variant = args.variant or ["new"]
    if args.target_hz is None:
        args.target_hz = cfo_search_hz(args.bw)
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
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


def make_capture(x: np.ndarray, case: str, offset_hz: int, args: argparse.Namespace) -> np.ndarray:
    fs = float(args.input_rate)
    if case.endswith("16"):
        x = insert_upchirps(x, fs, float(args.bw), 1 << args.sf)
    if case.startswith("crystal") and offset_hz:
        x = crystal_resample(x, 1 + offset_hz / CHANNEL_HZ)
    if offset_hz:
        x = x * np.exp(2j * np.pi * offset_hz * np.arange(len(x)) / fs)
    return x


def wrapper_argv(args: argparse.Namespace, out_rate: int, extra: list[str]) -> list[str]:
    # buildDecoderArgs() in src/decoders/builtin/lora-meshtastic.ts, then the variant's
    # extra arguments (argparse keeps the last value of a repeated option).
    return ["python3", args.wrapper, "--bw", str(args.bw), "--sf", str(args.sf),
            "--cr", str(args.cr), "--samp-rate", str(out_rate), "--frequency", str(CHANNEL_HZ),
            "--channel-key", "AQ==", "--region", "EU_868",
            "--cfo-search-hz", str(cfo_search_hz(args.bw)), *extra]


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


def run_chain(args: argparse.Namespace, capture: Path, extra: list[str],
              preexec: Callable[[], None] | None) -> dict[str, Any]:
    out_rate = args.bw * args.os_factor
    started = time.monotonic()
    with open(capture, "rb") as source, tempfile.TemporaryFile() as py_err:
        sox = subprocess.Popen(sox_argv(args.sox, args.input_rate, out_rate,
                                        args.sox_rate_opts.split()),
                               stdin=source, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, preexec_fn=preexec)
        py = subprocess.Popen(wrapper_argv(args, out_rate, extra), stdin=sox.stdout,
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


def main() -> int:
    args = parse_args()
    preexec = pinner(args.cpu)
    failed = False
    if not args.json:
        print(f"repeat={args.repeat} cpu={args.cpu} bw={args.bw} sf={args.sf} "
              f"os={args.os_factor} target shift +-{args.target_hz} Hz, "
              f"crystal +-{args.crystal_target_hz} Hz")
        print(f"{'capture':27} {'case':9} {'var':4} {'offset':>7} {'dec':>5} {'direct':>6} "
              f"{'recent':>6} {'cfo est':>8} {'sox/s':>6} {'py/s':>6} {'wall s':>6}")
    with tempfile.TemporaryDirectory(prefix="lora-cfo-bench-") as tmp:
        for name in FIXTURES:
            base = load_cu8(Path(args.fixtures) / name)
            for case in args.case:
                for offset in args.offsets:
                    x = make_capture(base, case, offset, args)
                    path = Path(tmp) / "capture.cu8"
                    path.write_bytes(to_cu8(x) * args.repeat)
                    # cu8: 2 bytes per complex sample.
                    signal_s = len(x) * args.repeat / args.input_rate
                    for variant in args.variant:
                        r = run_chain(args, path, VARIANTS[variant], preexec)
                        ok = (r["decodes"] == args.repeat and r["py_exit"] == 0
                              and r["sox_exit"] == 0)
                        target = (args.crystal_target_hz if case.startswith("crystal")
                                  else args.target_hz)
                        gating = variant == "new" and abs(offset) <= target
                        failed = failed or (gating and not ok)
                        row = {"capture": name, "case": case, "variant": variant,
                               "offset_hz": offset, "expected": args.repeat, "ok": ok,
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
                        print(f"{name:27} {case:9} {variant:4} {offset:>7} "
                              f"{r['decodes']:>2}/{args.repeat:<2} {paths.get('direct', '-')!s:>6} "
                              f"{paths.get('recentred', '-')!s:>6} {cfo:>8} "
                              f"{row['sox_cpu_per_signal_s']:6.3f} {row['py_cpu_per_signal_s']:6.3f} "
                              f"{r['wall_s']:6.1f}{flag}", flush=True)
                        if not ok and r["py_stderr_tail"]:
                            print("    wrapper stderr: " + " | ".join(r["py_stderr_tail"]),
                                  flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
