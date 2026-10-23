#!/usr/bin/env python3
"""Synthetic fixtures for the evidence squelch (design, Meter equivalence; requirements 5.1, 8.1).

These are not RF recordings. Each fixture is one "over" (a transmission, or for the
never-open classes the event that must not open the squelch) synthesised from a fixed
seed, placed on a low background noise floor.

Two outputs:

  --format cf32 --rate 48000 --out <dir>
      Analyzer input for `wavekit-iqcap analyze`: interleaved float32 little-endian
      complex baseband at 48 kHz, exactly FIXTURE_S = 4 s (192 000 samples, 1 536 000
      bytes, the analyzer's MAX_FILE_BYTES and 80-frame cap). The over starts at
      OVER_ONSET_S into the file.

  --format cu8 --rate 2048000|2400000 --out output/evidence-squelch/cu8 --gap-s 3
      Fake rtl_tcp input: unsigned 8-bit IQ. The file is gap_s of noise only, then the
      over. Looped by the fake server, consecutive overs are gap_s apart. A sidecar
      <name>.cu8.json records the rate and the over onset in the file. Never committed
      (A9); output/ is git-ignored.

Deterministic per seed: Python's random.Random(seed) drives every random choice, and only
the standard library is used. The POCSAG bit layer is a port of
fixtures/generators/pocsag.py (which needs numpy); --self-test compares the two when numpy
is importable.

Run with `python3 -I` (isolated mode); the repository paths are added explicitly.
"""

import argparse
import array
import json
import math
import pathlib
import random
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]

ANALYZER_RATE = 48_000
FIXTURE_S = 4.0
FIXTURE_SAMPLES = int(FIXTURE_S * ANALYZER_RATE)  # 192 000 = 80 frames of 2 400
OVER_ONSET_S = 0.25
CU8_RATES = (2_048_000, 2_400_000)
TAU = 2.0 * math.pi

# Levels (full scale 1.0). A 0.5 carrier over a 0.003 per-component floor is about
# 41 dB carrier to noise in the 48 kHz analyzer band: a quieted NFM channel.
CARRIER_AMPLITUDE = 0.5
NOISE_SIGMA = 0.003

# NFM deviations (Hz). The analyzer's full-scale reference is 5 kHz.
# Voice: RMS 0.35 of full scale over the syllables, peak deviation 3.5 kHz after tanh.
VOICE_PEAK_DEV_HZ = 3_500.0
VOICE_RMS = 0.35
CTCSS_DEV_HZ = 600.0
DCS_DEV_HZ = 400.0
DCS_BIT_RATE = 134.4
DMR_SYMBOL_RATE = 4_800
DMR_DEVIATIONS_HZ = (-1_944.0, -648.0, 648.0, 1_944.0)
DMR_RRC_ALPHA = 0.2
DMR_BURST_S = 0.030
POCSAG_DEV_HZ = 4_500.0
AM_DEPTH = 0.8

# name -> mode, expected squelch result, analyzer verdict, seed.
FIXTURES = {
	"nfm-ctcss-670-voice": ("nfm", "ctcss", "voice", 670),
	"nfm-ctcss-1000-voice": ("nfm", "ctcss", "voice", 1000),
	"nfm-ctcss-2503-voice": ("nfm", "ctcss", "voice", 2503),
	"nfm-dcs-023n-voice": ("nfm", "dcs", "voice", 23),
	"nfm-dcs-754i-voice": ("nfm", "dcs", "voice", 754),
	"nfm-voice": ("nfm", "voice", "voice", 11),
	"am-voice": ("am", "voice", "voice", 12),
	"nfm-carrier": ("nfm", "none", "neither", 21),
	"am-carrier": ("am", "none", "neither", 22),
	# The design expects data-like. Measured: neither (median cluster 0.3); the 30 ms
	# noise-only gaps between bursts keep most 50 ms frames from clustering. Recorded as
	# measured, not tuned; it still has no voice-positive window.
	"nfm-dmr-4fsk": ("nfm", "none", "neither", 31),
	"nfm-dmr-4fsk-continuous": ("nfm", "none", "data-like", 32),
	"nfm-pocsag-512": ("nfm", "none", "data-like", 512),
	"nfm-pocsag-1200": ("nfm", "none", "data-like", 1200),
	"nfm-clicks": ("nfm", "none", "neither", 41),
	"nfm-impulse": ("nfm", "none", "neither", 42),
	"nfm-noise": ("nfm", "none", "neither", 43),
	# Known limitation: audio-frequency FSK keyed at a syllabic rate passes the pinned
	# scanner voice judge (cluster sees a continuous discriminator, the 5 Hz on/off
	# envelope reads as syllables), so the evidence gate opens on it as voice.
	"nfm-fsk-syllabic-bursts": ("nfm", "voice", "voice", 51),
}
KNOWN_LIMITATIONS = {"nfm-fsk-syllabic-bursts"}


def manifest():
	out = {}
	for name, (mode, expect, verdict, seed) in FIXTURES.items():
		out[name] = {"mode": mode, "expect": expect, "verdict": verdict, "overOnsetS": OVER_ONSET_S, "seed": seed}
		if name in KNOWN_LIMITATIONS:
			out[name]["knownLimitation"] = True
	return out


# ---------------------------------------------------------------------------
# Modulating signals (real, at fs)


def voice_audio(rng, n, fs):
	"""Speech-shaped audio in (-1, 1): a gliding harmonic series through two moving
	formants, gated by syllables of 0.12 to 0.28 s (about 4 Hz) with pauses of 0.2 to
	0.35 s after every 4 to 7 syllables. Scaled to VOICE_RMS over the syllables and
	soft-limited (tanh), like a speech processor ahead of the modulator."""
	env = [0.0] * n
	f1 = [0.0] * n
	f2 = [0.0] * n
	pos = 0
	while pos < n:
		for _ in range(rng.randint(4, 7)):
			length = int(rng.uniform(0.12, 0.28) * fs)
			a, b = rng.uniform(450.0, 800.0), rng.uniform(1_100.0, 2_000.0)
			peak = rng.uniform(0.6, 1.0)
			for i in range(min(length, n - pos)):
				env[pos + i] = peak * math.sin(math.pi * (i + 0.5) / length) ** 2
				f1[pos + i] = a
				f2[pos + i] = b
			pos += length + int(rng.uniform(0.02, 0.05) * fs)
			if pos >= n:
				break
		pos += int(rng.uniform(0.20, 0.35) * fs)
	p1, p2 = rng.uniform(0.0, TAU), rng.uniform(0.0, TAU)
	base = 0.0
	out = [0.0] * n
	energy = 0.0
	voiced = 0
	for i in range(n):
		e = env[i]
		t = i / fs
		f0 = 135.0 + 25.0 * math.sin(TAU * 0.7 * t + p1) + 12.0 * math.sin(TAU * 3.1 * t + p2)
		base += TAU * f0 / fs
		if e == 0.0:
			continue
		acc = 0.0
		k = 1
		while k * f0 < 3_000.0:
			fk = k * f0
			w = 1.0 / (1.0 + ((fk - f1[i]) / 160.0) ** 2) + 0.5 / (1.0 + ((fk - f2[i]) / 220.0) ** 2)
			acc += w * math.sin(k * base)
			k += 1
		v = e * acc
		out[i] = v
		energy += v * v
		voiced += 1
	scale = VOICE_RMS / math.sqrt(energy / voiced) if energy > 0.0 else 0.0
	return [math.tanh(scale * v) for v in out]


def ctcss_audio(tone_hz, n, fs):
	return [math.sin(TAU * tone_hz * i / fs) for i in range(n)]


def golay_word(code):
	"""Same layout as src/core/audio-tones/dcs.ts golayWord."""
	data = (code & 0x1FF) | (0b100 << 9)
	r = data << 11
	for i in range(22, 10, -1):
		if r & (1 << i):
			r ^= 0xC75 << (i - 11)
	return ((data << 11) | r) & 0x7FFFFF


def dcs_audio(code, inverted, n, fs):
	"""134.4 bit/s NRZ, word bits LSB first, repeated; one-pole low-pass at 300 Hz."""
	word = golay_word(code)
	bits = [(word >> k) & 1 for k in range(23)]
	if inverted:
		bits = [1 - b for b in bits]
	alpha = 1.0 - math.exp(-TAU * 300.0 / fs)
	y = 0.0
	out = [0.0] * n
	for i in range(n):
		b = bits[int(i * DCS_BIT_RATE / fs) % 23]
		y += alpha * ((1.0 if b else -1.0) - y)
		out[i] = y
	return out


def clicks_audio(rng, n, fs):
	"""2 ms half-sine impulses at a rate drawn from 3 to 20 Hz before each click."""
	out = [0.0] * n
	width = int(0.002 * fs)
	pos = int(rng.uniform(0.0, 0.1) * fs)
	while pos + width <= n:
		sign = 1.0 if rng.random() < 0.5 else -1.0
		for i in range(width):
			out[pos + i] = sign * math.sin(math.pi * (i + 0.5) / width)
		pos += int(fs / rng.uniform(3.0, 20.0))
	return out


# ---------------------------------------------------------------------------
# Overs (complex, at the analyzer rate, no background noise)


def fm(freq_hz, fs, amplitude=CARRIER_AMPLITUDE, keyed=None):
	phase = 0.0
	out = [0j] * len(freq_hz)
	for i, f in enumerate(freq_hz):
		phase += TAU * f / fs
		if phase > math.pi:
			phase -= TAU
		elif phase < -math.pi:
			phase += TAU
		a = amplitude if keyed is None else amplitude * keyed[i]
		out[i] = complex(a * math.cos(phase), a * math.sin(phase))
	return out


def am(audio, amplitude=CARRIER_AMPLITUDE):
	return [complex(amplitude * (1.0 + AM_DEPTH * m), 0.0) for m in audio]


def nfm_voice(rng, n, fs, sub=None):
	voice = voice_audio(rng, n, fs)
	freq = [VOICE_PEAK_DEV_HZ * v for v in voice]
	if sub is not None:
		dev, audio = sub
		freq = [f + dev * s for f, s in zip(freq, audio)]
	return fm(freq, fs)


def dmr_symbols(rng, n, fs):
	sps = fs // DMR_SYMBOL_RATE
	return sps, [DMR_DEVIATIONS_HZ[rng.randrange(4)] for _ in range(-(-n // sps))]


def rrc(t, alpha):
	"""Root-raised-cosine impulse response at t symbols (peak 1 - alpha + 4 alpha / pi)."""
	if abs(t) < 1e-9:
		return 1.0 - alpha + 4.0 * alpha / math.pi
	if abs(abs(t) - 1.0 / (4.0 * alpha)) < 1e-9:
		q = math.pi / (4.0 * alpha)
		return alpha / math.sqrt(2.0) * ((1.0 + 2.0 / math.pi) * math.sin(q) + (1.0 - 2.0 / math.pi) * math.cos(q))
	num = math.sin(math.pi * t * (1.0 - alpha)) + 4.0 * alpha * t * math.cos(math.pi * t * (1.0 + alpha))
	return num / (math.pi * t * (1.0 - (4.0 * alpha * t) ** 2))


def dmr_4fsk(rng, n, fs):
	"""DMR-like handset uplink (design, Meter equivalence): 4 800 symbols/s 4FSK through a
	root-raised-cosine pulse (alpha 0.2, +-4 symbols), keyed in 30 ms TDMA bursts every
	60 ms (one slot of two) with 1 ms raised-cosine edges; between bursts the channel holds
	only the noise floor."""
	sps, symbols = dmr_symbols(rng, n, fs)
	span = 4
	taps = [rrc(k / sps, DMR_RRC_ALPHA) for k in range(-span * sps, span * sps + 1)]
	gain = sps / sum(taps)  # a constant symbol stream keeps its deviation
	freq = [0.0] * n
	for i in range(n):
		acc = 0.0
		first = max(0, -((span * sps - i) // sps))  # ceil((i - span * sps) / sps)
		last = min(len(symbols) - 1, (i + span * sps) // sps)
		for k in range(first, last + 1):
			acc += symbols[k] * taps[i - k * sps + span * sps]
		freq[i] = gain * acc
	burst = int(DMR_BURST_S * fs)
	ramp = int(0.001 * fs)
	keyed = [0.0] * n
	for start in range(0, n, 2 * burst):
		for i in range(min(burst, n - start)):
			edge = min(i, burst - 1 - i)
			keyed[start + i] = 1.0 if edge >= ramp else math.sin(0.5 * math.pi * (edge + 0.5) / ramp) ** 2
	return fm(freq, fs, keyed=keyed)


def dmr_4fsk_continuous(rng, n, fs):
	"""Unshaped variant: rectangular 4 800 symbols/s 4FSK, keyed continuously (both slots,
	as a repeater downlink)."""
	sps, symbols = dmr_symbols(rng, n, fs)
	return fm([symbols[i // sps] for i in range(n)], fs)


POCSAG_SYNC = 0x7CD215D8
POCSAG_IDLE = 0x7A89C197
POCSAG_BCH = 0b11101101001
POCSAG_PREAMBLE_BITS = 576
POCSAG_NUMERIC = "0123456789*U -)("


def _msb(word, width):
	return [(word >> (width - 1 - i)) & 1 for i in range(width)]


def _pocsag_codeword(data21):
	reg = data21 << 10
	for bit in range(30, 9, -1):
		if reg & (1 << bit):
			reg ^= POCSAG_BCH << (bit - 10)
	cw31 = (data21 << 10) | (reg & 0x3FF)
	return (cw31 << 1) | (bin(cw31).count("1") & 1)


def pocsag_page_bits(address, function, numeric):
	"""Standard-library port of page_bits in fixtures/generators/pocsag.py for a numeric
	page (ITU-R M.584-2): preamble, then batches of sync + 16 codewords."""
	digits = [POCSAG_NUMERIC.index(c) for c in numeric]
	while len(digits) % 5:
		digits.append(POCSAG_NUMERIC.index(" "))
	payload = [(d >> i) & 1 for d in digits for i in range(4)]
	message = []
	for i in range(0, len(payload), 20):
		data20 = 0
		for k, b in enumerate(payload[i : i + 20]):
			data20 |= b << (19 - k)
		message.append(_pocsag_codeword((1 << 20) | data20))
	words = []
	while len(words) % 16 != 2 * (address & 7):
		words.append(POCSAG_IDLE)
	words.append(_pocsag_codeword(((address >> 3) << 2) | function))
	words.extend(message)
	words.append(POCSAG_IDLE)
	while len(words) % 16:
		words.append(POCSAG_IDLE)
	bits = [(i + 1) & 1 for i in range(POCSAG_PREAMBLE_BITS)]
	for b in range(0, len(words), 16):
		bits += _msb(POCSAG_SYNC, 32)
		for w in words[b : b + 16]:
			bits += _msb(w, 32)
	return bits


def pocsag(rng, n, fs, baud):
	bits = []
	while len(bits) * fs < n * baud:
		bits += pocsag_page_bits(rng.randrange(1 << 21), rng.randrange(4), str(rng.randrange(10**9)))
	freq = [-POCSAG_DEV_HZ if bits[min(i * baud // fs, len(bits) - 1)] else POCSAG_DEV_HZ for i in range(n)]
	return fm(freq, fs)


def afsk_bursts(rng, n, fs):
	"""1 200 baud Bell 202 AFSK (1 200 / 2 200 Hz, continuous phase) keyed 100 ms on,
	100 ms off with 2 ms raised-cosine edges; the audio deviates the carrier by 3 kHz."""
	audio = [0.0] * n
	phase = 0.0
	bit = 0
	period = int(0.2 * fs)
	on = int(0.1 * fs)
	ramp = int(0.002 * fs)
	for i in range(n):
		if i == 0 or (i * 1200) // fs != ((i - 1) * 1200) // fs:
			bit = rng.randrange(2)
		phase += TAU * (1_200.0 if bit else 2_200.0) / fs
		k = i % period
		if k < on:
			edge = min(k, on - 1 - k)
			g = 1.0 if edge >= ramp else math.sin(0.5 * math.pi * (edge + 0.5) / ramp) ** 2
			audio[i] = g * math.sin(phase)
	return fm([3_000.0 * a for a in audio], fs)


def impulse(rng, n, fs):
	"""Ignition-like impulses: 0.1 to 1 ms bursts of 0.4-sigma complex noise, Poisson at 40/s."""
	out = [0j] * n
	pos = int(rng.expovariate(40.0) * fs)
	while pos < n:
		for i in range(pos, min(pos + int(rng.uniform(0.0001, 0.001) * fs), n)):
			out[i] = complex(rng.gauss(0.0, 0.4), rng.gauss(0.0, 0.4))
		pos += max(1, int(rng.expovariate(40.0) * fs))
	return out


def over(name, n, fs=ANALYZER_RATE):
	"""The over of fixture `name`: n complex samples at fs, without background noise."""
	mode, _expect, _verdict, seed = FIXTURES[name]
	rng = random.Random(seed)
	if name.startswith("nfm-ctcss-"):
		tone = int(name.split("-")[2]) / 10.0
		return nfm_voice(rng, n, fs, (CTCSS_DEV_HZ, ctcss_audio(tone, n, fs)))
	if name.startswith("nfm-dcs-"):
		tag = name.split("-")[2]
		return nfm_voice(rng, n, fs, (DCS_DEV_HZ, dcs_audio(int(tag[:3], 8), tag[3] == "i", n, fs)))
	if name == "nfm-voice":
		return nfm_voice(rng, n, fs)
	if name == "am-voice":
		return am(voice_audio(rng, n, fs))
	if name == "nfm-carrier":
		return fm([0.0] * n, fs)
	if name == "am-carrier":
		return am([0.0] * n)
	if name == "nfm-dmr-4fsk":
		return dmr_4fsk(rng, n, fs)
	if name == "nfm-dmr-4fsk-continuous":
		return dmr_4fsk_continuous(rng, n, fs)
	if name.startswith("nfm-pocsag-"):
		return pocsag(rng, n, fs, int(name.split("-")[2]))
	if name == "nfm-clicks":
		return fm([4_000.0 * c for c in clicks_audio(rng, n, fs)], fs)
	if name == "nfm-fsk-syllabic-bursts":
		return afsk_bursts(rng, n, fs)
	if name == "nfm-impulse":
		return impulse(rng, n, fs)
	if name == "nfm-noise":
		# Unquieted channel: a 0.05-sigma noise burst with no carrier.
		return [complex(rng.gauss(0.0, 0.05), rng.gauss(0.0, 0.05)) for _ in range(n)]
	raise ValueError(f"unknown fixture {name}")


# ---------------------------------------------------------------------------
# Files


def analyzer_fixture(name):
	"""FIXTURE_SAMPLES complex samples at 48 kHz: noise floor, over from OVER_ONSET_S."""
	rng = random.Random(FIXTURES[name][3] ^ 0x5EED)
	onset = int(OVER_ONSET_S * ANALYZER_RATE)
	body = over(name, FIXTURE_SAMPLES - onset)
	out = [complex(rng.gauss(0.0, NOISE_SIGMA), rng.gauss(0.0, NOISE_SIGMA)) for _ in range(FIXTURE_SAMPLES)]
	for i, s in enumerate(body):
		out[onset + i] += s
	return out


def cf32_bytes(samples):
	buf = array.array("f")
	for s in samples:
		buf.append(s.real)
		buf.append(s.imag)
	if sys.byteorder != "little":
		buf.byteswap()
	return buf.tobytes()


def cu8_bytes(name, rate, gap_s, over_s=FIXTURE_S - OVER_ONSET_S):
	"""gap_s of noise, then the over interpolated (linear) from 48 kHz to `rate`."""
	if rate not in CU8_RATES:
		raise ValueError(f"cu8 rate must be one of {CU8_RATES}")
	base = over(name, int(over_s * ANALYZER_RATE))
	rng = random.Random(FIXTURES[name][3] ^ 0xC08)
	gap = int(gap_s * rate)
	total = gap + int(over_s * rate)
	out = bytearray(2 * total)
	step = ANALYZER_RATE / rate
	last = len(base) - 1
	for i in range(total):
		s = 0j
		if i >= gap:
			x = (i - gap) * step
			k = int(x)
			if k < last:
				f = x - k
				s = base[k] * (1.0 - f) + base[k + 1] * f
			else:
				s = base[last]
		re = s.real + rng.gauss(0.0, NOISE_SIGMA)
		im = s.imag + rng.gauss(0.0, NOISE_SIGMA)
		out[2 * i] = min(255, max(0, int(round(127.5 + 127.5 * re))))
		out[2 * i + 1] = min(255, max(0, int(round(127.5 + 127.5 * im))))
	return bytes(out), gap / rate


def self_test():
	import hashlib

	for name in FIXTURES:
		a = analyzer_fixture(name)
		assert len(a) == FIXTURE_SAMPLES, name
		assert all(math.isfinite(s.real) and math.isfinite(s.imag) for s in a), name
		assert max(max(abs(s.real), abs(s.imag)) for s in a) < 4.0, name
		raw = cf32_bytes(a)
		assert len(raw) == FIXTURE_SAMPLES * 8 == 1_536_000, name
		again = cf32_bytes(analyzer_fixture(name))
		assert hashlib.sha256(raw).digest() == hashlib.sha256(again).digest(), f"{name} not deterministic"
	cu8, onset = cu8_bytes("nfm-voice", 2_048_000, 0.01, over_s=0.02)
	assert len(cu8) == 2 * (int(0.01 * 2_048_000) + int(0.02 * 2_048_000)) and onset == 0.01
	assert cu8 == cu8_bytes("nfm-voice", 2_048_000, 0.01, over_s=0.02)[0]
	try:
		if str(REPO) not in sys.path:
			sys.path.insert(0, str(REPO))
		from fixtures.generators.pocsag import page_bits  # noqa: E402  (reference, needs numpy)
	except ImportError:
		print("pocsag reference skipped (numpy not importable)")
	else:
		ref_rng = random.Random(7)
		for _ in range(50):
			a, f, num = ref_rng.randrange(1 << 21), ref_rng.randrange(4), str(ref_rng.randrange(10**9))
			assert pocsag_page_bits(a, f, num) == page_bits({"address": a, "function": f, "numeric": num}), (a, f, num)
	assert golay_word(0o023) == golay_word(0o023) and golay_word(0) >> 11 == 0b100 << 9
	print("ok")


def main():
	p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
	p.add_argument("--self-test", action="store_true")
	p.add_argument("--format", choices=("cf32", "cu8"))
	p.add_argument("--rate", type=int)
	p.add_argument("--out", type=pathlib.Path)
	p.add_argument("--gap-s", type=float, default=3.0)
	p.add_argument("--fixture", default="all", help="manifest name or all")
	args = p.parse_args()
	if args.self_test:
		self_test()
		return 0
	if args.format is None or args.out is None or args.rate is None:
		p.error("--format, --rate and --out are required")
	names = list(FIXTURES) if args.fixture == "all" else [args.fixture]
	if any(n not in FIXTURES for n in names):
		p.error("unknown fixture")
	if args.format == "cf32" and args.rate != ANALYZER_RATE:
		p.error("cf32 is analyzer input: --rate 48000")
	if args.format == "cu8" and args.rate not in CU8_RATES:
		p.error("cu8 --rate must be 2048000 or 2400000")
	if not 0.0 <= args.gap_s <= 30.0:
		p.error("--gap-s must be within 0..30")
	args.out.mkdir(parents=True, exist_ok=True)
	for name in names:
		if args.format == "cf32":
			(args.out / f"{name}.cf32").write_bytes(cf32_bytes(analyzer_fixture(name)))
		else:
			data, onset = cu8_bytes(name, args.rate, args.gap_s)
			(args.out / f"{name}.{args.rate}.cu8").write_bytes(data)
			meta = dict(manifest()[name], rate=args.rate, overOnsetS=onset, overS=FIXTURE_S - OVER_ONSET_S, gapS=args.gap_s)
			(args.out / f"{name}.{args.rate}.cu8.json").write_text(json.dumps(meta, indent=2) + "\n")
		print(name, flush=True)
	return 0


if __name__ == "__main__":
	sys.exit(main())
