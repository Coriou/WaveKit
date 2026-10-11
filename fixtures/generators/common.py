"""Shared helpers for the synthetic generators."""
import numpy as np


def bits_lsb_first(byte_values):
    """Bytes to a bit list, least significant bit first (ACARS, AX.25 order)."""
    return [(b >> i) & 1 for b in byte_values for i in range(8)]


def bits_msb_first(word, width):
    return [(word >> (width - 1 - i)) & 1 for i in range(width)]


def bit_index(n_bits, baud, fs):
    """Index of the bit each sample belongs to (baud need not divide fs)."""
    n_samples = int(np.ceil(n_bits * fs / baud))
    return np.minimum((np.arange(n_samples) * baud) // fs, n_bits - 1).astype(np.int64)


def cpfsk_phase(freq_hz, fs):
    """Continuous phase for a per-sample instantaneous frequency."""
    return np.cumsum(2.0 * np.pi * np.asarray(freq_hz, dtype=np.float64) / fs)


def keyed_envelope(n_samples, fs, ramp_s=0.002):
    """1.0 with raised-cosine key-up/key-down ramps, so bursts do not splatter."""
    env = np.ones(n_samples)
    r = min(int(round(ramp_s * fs)), n_samples // 2)
    if r > 0:
        ramp = 0.5 - 0.5 * np.cos(np.pi * (np.arange(r) + 0.5) / r)
        env[:r] = ramp
        env[-r:] = ramp[::-1]
    return env


def schedule(bursts, fs, duration_s, start_s, gap_s):
    """Lay bursts end to end from start_s with gap_s silence; returns (iq, offsets)."""
    total = int(round(duration_s * fs))
    out = np.zeros(total, dtype=np.complex128)
    pos = int(round(start_s * fs))
    placed = []
    for burst in bursts:
        if pos + len(burst) > total:
            raise ValueError(
                f'burst {len(placed)} ends at {(pos + len(burst)) / fs:.3f} s, past duration {duration_s} s'
            )
        out[pos : pos + len(burst)] = burst
        placed.append(pos / fs)
        pos += len(burst) + int(round(gap_s * fs))
    return out, placed
