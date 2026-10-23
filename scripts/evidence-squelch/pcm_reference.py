#!/usr/bin/env python3
"""Same-path reference statistics for the evidence squelch meter (requirement 5.1, A9).

Applies the IQ analyzer's statistic definitions (native/wavekit-chan/src/iqcap/analyze.rs:
`audio_band_power`, `syllabic_index`, `cluster_levels` / `kmeans_hist`) to the committed
8 kHz s16le audio goldens, at 8 kHz, in float64 with the Python standard library, and writes
`<name>.pcmstats.json` next to them: one record per 50 ms frame (400 samples) with `audioDb`,
`syllabic` and `cluster`.

The 8 kHz analogues of the analyzer's 48 kHz paths (fixed here, by definition):
- audioDb: RBJ high-pass 300 Hz then low-pass 3 kHz (Q = 1/sqrt 2) at 8 kHz; frame mean
  square over 0.32 (a full-deviation sine at gain 2), 10 log10, -160 for silence.
- syllabic: the mean square of each frame into a 20-frame ring; one-pole 2 Hz high-pass at
  the 20 Hz envelope rate, at rest on the oldest value; RMS over ring mean, 0 below 1e-12,
  clamped to [0, 160].
- cluster: PCM to discriminator radians at 48 kHz (5 kHz deviation = 0.8 at gain 2); the
  analyzer's 2.4 kHz low-pass view is the RBJ 2.4 kHz low-pass at 8 kHz, and its 4.8 kHz
  view (above the 8 kHz Nyquist) is the unfiltered PCM; every sample of the frame (no
  stride); the larger of the k = 2 and k = 4 histogram k-means scores of each view, the
  larger of the two views. View samples are rounded to binary32, the storage type of the
  analyzer's `disc_lo` / `disc_hi`; the rest is float64.

An adapted reference, not an exact oracle of analyze.rs: it follows the Rust definitions
(written from them, not from src/core/evidence-squelch/voice-meter.ts) at 8 kHz, but does the
filter, histogram and k-means arithmetic in float64 where analyze.rs (cluster_levels,
kmeans_hist, Biquad) uses binary32. The meter equivalence test compares it with the meter. Deterministic: same input, same bytes.

Usage: python3 -I scripts/evidence-squelch/pcm_reference.py [--dir tests/mocks/fixtures/evidence-squelch] [--check]
"""

import argparse
import json
import math
import pathlib
import struct
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_DIR = REPO / "tests/mocks/fixtures/evidence-squelch"
RATE = 8_000
FRAME = 400
RING = 20
BINS = 256
ITERS = 6
FRACTION = 0.15
MIN_SPAN = 0.15
FULL_SCALE_MS = 0.32
RAD_PER_UNIT = 2 * math.pi * 5_000 / 48_000 / 0.8
MAX_BYTES = 65_536


def rbj(high, hz):
	w0 = 2 * math.pi * hz / RATE
	c, alpha = math.cos(w0), math.sin(w0) / (2 * math.sqrt(0.5))
	a0 = 1 + alpha
	b0 = ((1 + c) if high else (1 - c)) / 2 / a0
	b1 = (-(1 + c) if high else (1 - c)) / a0
	return (b0, b1, b0, -2 * c / a0, (1 - alpha) / a0)


def filt(coef, xs):
	b0, b1, b2, a1, a2 = coef
	x1 = x2 = y1 = y2 = 0.0
	out = []
	for x in xs:
		y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
		x2, x1, y2, y1 = x1, x, y1, y
		out.append(y)
	return out


def syllabic(ring):
	if len(ring) < 2:
		return 0.0
	alpha = math.exp(-2 * math.pi * 2 / 20)
	prev, y, acc = ring[0], 0.0, 0.0
	for x in ring:
		y = alpha * (y + x - prev)
		prev = x
		acc += y * y
	mean = sum(ring) / len(ring)
	if mean <= 1e-12:
		return 0.0
	return min(160.0, max(0.0, math.sqrt(acc / len(ring)) / mean))


def kmeans(hist, origin, w, n, k):
	cents = [origin] * k
	cum, q = 0, 0
	for b, count in enumerate(hist):
		cum += count
		while q < k and cum >= (q + 0.5) / k * n:
			cents[q] = origin + (b + 0.5) * w
			q += 1
	while q < k:
		cents[q] = origin + (BINS - 0.5) * w
		q += 1
	for _ in range(ITERS):
		sums, counts = [0.0] * k, [0] * k
		for b, weight in enumerate(hist):
			if weight:
				x = origin + (b + 0.5) * w
				best = min(range(k), key=lambda i: (abs(x - cents[i]), i))
				sums[best] += x * weight
				counts[best] += weight
		cents = [sums[i] / counts[i] if counts[i] else cents[i] for i in range(k)]
	cents.sort()
	if cents[-1] - cents[0] < MIN_SPAN:
		return 0.0
	gaps = [b - a for a, b in zip(cents, cents[1:]) if b - a > 0]
	if not gaps:
		return 0.0
	tol = FRACTION * min(gaps)
	hit = 0.0
	for b, weight in enumerate(hist):
		if weight:
			left = origin + b * w
			nearest = min(cents, key=lambda c: abs(left + 0.5 * w - c))
			lo, hi = max(left, nearest - tol), min(left + w, nearest + tol)
			if hi > lo:
				hit += weight * (hi - lo) / w
	return hit / n


def cluster(view):
	lo, hi = min(view), max(view)
	if hi - lo < MIN_SPAN:
		return 0.0
	hist = [0] * BINS
	scale = BINS / (hi - lo)
	for v in view:
		hist[min(BINS - 1, int((v - lo) * scale))] += 1
	w = (hi - lo) / BINS
	return max(kmeans(hist, lo, w, len(view), 2), kmeans(hist, lo, w, len(view), 4))


_F32 = struct.Struct("<f")


def f32(x):
	"""Round to binary32, the storage type of the analyzer's discriminator views (`disc_lo`, `disc_hi`)."""
	return _F32.unpack(_F32.pack(x))[0]


def stats(pcm):
	band = filt(rbj(False, 3_000), filt(rbj(True, 300), pcm))
	low = filt(rbj(False, 2_400), pcm)
	frames, ring = [], []
	for s in range(0, len(pcm) - FRAME + 1, FRAME):
		power = sum(y * y for y in band[s : s + FRAME]) / FRAME
		ring = (ring + [power])[-RING:]
		raw = [f32(x * RAD_PER_UNIT) for x in pcm[s : s + FRAME]]
		lo = [f32(x * RAD_PER_UNIT) for x in low[s : s + FRAME]]
		frames.append({
			"audioDb": -160.0 if power <= 0 else 10 * math.log10(power / FULL_SCALE_MS),
			"syllabic": syllabic(ring),
			"cluster": max(cluster(lo), cluster(raw)),
		})
	return frames


def render(path):
	data = path.read_bytes()
	pcm = [v / 32_768 for v in struct.unpack(f"<{len(data) // 2}h", data)]
	text = json.dumps({"rate": RATE, "frameSamples": FRAME, "frames": stats(pcm)}, indent="\t") + "\n"
	if len(text) > MAX_BYTES:
		raise SystemExit(f"{path.name}: pcmstats over {MAX_BYTES} bytes")
	return text


def main():
	p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
	p.add_argument("--dir", type=pathlib.Path, default=DEFAULT_DIR)
	p.add_argument("--check", action="store_true", help="fail when a committed file differs")
	args = p.parse_args()
	manifest = json.loads((args.dir / "manifest.json").read_text())
	stale = []
	for name in manifest:
		text = render(args.dir / f"{name}.audio.s16le")
		out = args.dir / f"{name}.pcmstats.json"
		if args.check:
			if not out.exists() or out.read_text() != text:
				stale.append(name)
		else:
			out.write_text(text)
	if stale:
		print("stale: " + ", ".join(stale), file=sys.stderr)
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(main())
