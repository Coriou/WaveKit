#!/usr/bin/env python3
"""AFSK1200 APRS (direwolf's gen_packets) -> NFM IQ cu8 at 1.024 Msps.

Writes aprs_msg.txt (TNC2 text, callsign N0CALL), aprs_afsk1200_48k.wav and four
aprs_144800_*.cu8 captures to OUTDIR; fixtures/aprs/README.md lists them. Needs
gen_packets (in the core image), numpy and scipy. Noise seeds are 200 + variant index.

Usage: python3 gen_aprs.py OUTDIR
"""
import subprocess
import sys
import wave

import numpy as np
from scipy.signal import resample_poly

OUT = sys.argv[1]
AUDIO_RATE = 48_000
IQ_RATE = 1_024_000
DEV_HZ = 3_000.0  # peak deviation for full-scale audio
TNC2 = "N0CALL-1>APRS,WIDE1-1:!4903.50N/07201.75W-WaveKit synthetic test\n"

open(f"{OUT}/aprs_msg.txt", "w").write(TNC2)
subprocess.run(["gen_packets", "-r", str(AUDIO_RATE), "-a", "100", "-o",
                f"{OUT}/aprs_afsk1200_48k.wav", f"{OUT}/aprs_msg.txt"], check=True,
               stdout=subprocess.DEVNULL)
with wave.open(f"{OUT}/aprs_afsk1200_48k.wav") as w:
    assert w.getframerate() == AUDIO_RATE and w.getsampwidth() == 2 and w.getnchannels() == 1
    a = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
print("audio samples", len(a), "secs", len(a) / AUDIO_RATE, "peak", float(np.max(np.abs(a))))
pad = np.zeros(int(0.1 * AUDIO_RATE))
a = np.concatenate([pad, a, pad])
a = a / np.max(np.abs(a))
a_up = resample_poly(a, 64, 3)  # 48k -> 1.024M
phase = 2 * np.pi * DEV_HZ * np.cumsum(a_up) / IQ_RATE


def make(offset_hz: float, cnr_db: float | None, seed: int, dc: complex = 0j) -> np.ndarray:
    n = np.arange(len(phase))
    x = 0.4 * np.exp(1j * (phase + 2 * np.pi * offset_hz * n / IQ_RATE))
    if cnr_db is not None:
        rng = np.random.default_rng(seed)
        ps = 0.4 ** 2
        pn_total = ps / 10 ** (cnr_db / 10) * IQ_RATE / 12_500  # CNR in 12.5 kHz
        s = np.sqrt(pn_total / 2)
        x = x + s * (rng.standard_normal(len(x)) + 1j * rng.standard_normal(len(x)))
    return x + dc


def cu8(x: np.ndarray) -> bytes:
    iq = np.empty(2 * len(x))
    iq[0::2] = x.real
    iq[1::2] = x.imag
    return np.clip(np.round(iq * 127.5 + 127.5), 0, 255).astype(np.uint8).tobytes()


variants = {
    "aprs_144800_c144600_cnr20": (200_000.0, 20.0, 0j),
    "aprs_144800_c144600_cnr10": (200_000.0, 10.0, 0j),
    "aprs_144800_c144800_cnr20": (0.0, 20.0, 0j),
    "aprs_144800_c144800_cnr20_dcspike": (0.0, 20.0, 0.1 + 0.05j),
}
for i, (name, (off, cnr, dc)) in enumerate(variants.items()):
    x = make(off, cnr, 200 + i, dc)
    open(f"{OUT}/{name}.cu8", "wb").write(cu8(x))
    print("wrote", name, len(x))
