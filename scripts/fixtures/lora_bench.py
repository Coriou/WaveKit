"""Shared pieces of the LoRa/Meshtastic benches (bench_lora_chain.py, bench_lora_cfo.py).

Both feed the committed LongFast captures through the live chain: sox with the argv
loraResampleCommand() builds, then the wrapper with the argv buildDecoderArgs()
builds (src/decoders/builtin/lora-meshtastic.ts). The captures hold the 8 preamble
upchirps gen_lora.py writes; the wrapper's direct path expects Meshtastic's 16
(MESHTASTIC_PREAMBLE_LEN in docker/scripts/lora_meshtastic_decode.py), so both
benches insert the missing 8 first (meshtastic_capture()).

Importing this module needs numpy only; building argv needs nothing else.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Callable

import numpy as np

FIXTURES = ["lora_longfast_dc_snr10.cu8", "lora_longfast_dc_snrm5.cu8"]
# fixtures/lora/README.md: the frame every capture holds, on this channel.
EXPECTED_FROM = 169552957
EXPECTED_PAYLOAD_B64 = "aGVsbG8gd2F2ZWtpdA=="
CHANNEL_HZ = 869_525_000
# The captures' channel key and region (fixtures/lora/README.md).
CHANNEL_KEY = "AQ=="
REGION = "EU_868"
# scripts/fixtures/gen_lora.py: 0.25 s of 1.024 Msps noise precede the frame.
FRAME_START = 256_000
INSERTED_UPCHIRPS = 8


def pinner(cpu: int) -> Callable[[], None] | None:
    if cpu < 0:
        return None
    if not hasattr(os, "sched_setaffinity"):
        print("note: no sched_setaffinity on this OS; stages run unpinned", file=sys.stderr)
        return None
    return lambda: os.sched_setaffinity(0, {cpu})


def sox_argv(sox: str, input_rate: int, out_rate: int, rate_opts: list[str]) -> list[str]:
    # Same argv as loraResampleCommand() in src/decoders/builtin/lora-meshtastic.ts.
    fmt = ["-t", "raw", "-e", "unsigned-integer", "-b", "8", "-c", "2"]
    return [sox, "-q", "-D", "--ignore-length", *fmt, "-r", str(input_rate), "-",
            *fmt, "-r", str(out_rate), "-", "rate", *rate_opts, str(out_rate)]


def cfo_search_hz(bw: int) -> int:
    # loraCfoSearchHz() in src/decoders/builtin/lora-meshtastic.ts: bw / 5, whole Hz.
    return bw // 5


def wrapper_argv(args: argparse.Namespace, out_rate: int, shift_hz: int = 0,
                 cfo_search: int = 0) -> list[str]:
    """buildDecoderArgs() in src/decoders/builtin/lora-meshtastic.ts, run by python3.

    `args` carries wrapper, bw, sf and cr. `shift_hz` is the known placement offset
    (slot minus capture centre); `cfo_search` the opt-in search (cfo_search_hz(bw)),
    which the adapter passes only when the capture centre is unknown.
    """
    return ["python3", args.wrapper, "--bw", str(args.bw), "--sf", str(args.sf),
            "--cr", str(args.cr), "--samp-rate", str(out_rate),
            "--frequency", str(CHANNEL_HZ), "--channel-key", CHANNEL_KEY,
            "--region", REGION, "--shift-hz", str(shift_hz),
            "--cfo-search-hz", str(cfo_search)]


def reap(proc: subprocess.Popen[Any]) -> tuple[int, float]:
    """Exit code and user+sys CPU seconds of one child."""
    _, status, usage = os.wait4(proc.pid, 0)
    proc.returncode = os.waitstatus_to_exitcode(status)
    return proc.returncode, usage.ru_utime + usage.ru_stime


def count_decodes(stdout: bytes) -> int:
    hits = 0
    for line in stdout.decode("utf-8", "replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if (isinstance(event, dict) and event.get("from") == EXPECTED_FROM
                and event.get("payload_b64") == EXPECTED_PAYLOAD_B64):
            hits += 1
    return hits


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


def meshtastic_capture(path: Path, input_rate: int, bw: int, sf: int) -> np.ndarray:
    """A committed capture with Meshtastic's 16 preamble upchirps, as the wrapper expects."""
    return insert_upchirps(load_cu8(path), float(input_rate), float(bw), 1 << sf)
