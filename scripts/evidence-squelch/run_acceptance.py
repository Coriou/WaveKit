#!/usr/bin/env python3
"""Evidence squelch fake-link acceptance on a scratch Compose project (plan Task FX.3).

Per fixture: an `auto` run and a `manual` baseline on the same looped CU8 file, each in its
own project `wkevs-<pid>` with an internal network, the in-container fake rtl_tcp
(`fake:1234`) and the core image from EVIDENCE_SQUELCH_IMAGE (default wavekit:latest; never
built or pulled here). The API and the audio stream are reached through a forwarder
published on 127.0.0.1 ports the driver picks from SAFE_PORTS (never a live-setup port) and
verifies after `up`, before any client starts. Recorded: `/stream.wav` bytes with arrival
times, `live-audio:level` and `live-audio:transmission` events, status samples, the
event-loop p99 of the link-quality report and the fake source's connection time (the
source clock every timing verdict is measured on).

Exit codes: 0 pass, 1 fail, 2 invalid (setup, teardown, recording or timing evidence failure).

  run_acceptance.py --rate 2048000 --engine csdr --fixture all --out <dir> [--cpu-quota 0.75]
  run_acceptance.py --replay <dir>      # recompute verdicts from a recorded <dir>
  run_acceptance.py --self-test         # verdict functions on synthetic observations, no Docker
"""
import argparse
import asyncio
import base64
from bisect import bisect_left
import calendar
import json
import math
import operator
import os
from pathlib import Path
import random
import re
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
RATES = (2_048_000, 2_400_000)
ENGINES = ("csdr", "rust")
GAP_S = 3.0
ONSET_TOLERANCE_S = 0.020
MAX_DELAY_S = 1.5
BYTE_RATE_TOLERANCE = 0.005
EVENT_TOLERANCE_S = 0.010
P99_TOLERANCE_MS = 2.0
REF_RATE = 8_000
CORR_WINDOW_S = 0.25
CORR_SEARCH_S = 0.05
API_PORT = 3000
STREAM_PORT = 3001
# Ports of the live setup on this host; never published, connected to or configured.
FORBIDDEN_PORTS = frozenset((15555, 15556, 18080, 9000, 5173, 8081, 8082))
# Host ports the forwarder may be published on (900 ports, none of them forbidden).
SAFE_PORTS = range(47100, 48000)
assert not FORBIDDEN_PORTS & set(SAFE_PORTS)
# A stage-1 open may precede the source onset by this much (block quantisation) and still
# belong to that over.
ASSOC_SLACK_S = 0.1
# Carrier-bearing fixtures must close at least max(MIN_EVENTS, overs in the recording after
# STARTUP_S, minus one) transmissions in both runs.
MIN_EVENTS = 3
STARTUP_S = 30.0
# Fixtures whose over has no carrier: the manual baseline may legitimately see no transmission.
CARRIERLESS = frozenset(("nfm-noise", "nfm-impulse"))
# The status rate (fractional, e.g. 2.048 Msps / 82 = 24 975.61 Hz) must match the WAV header
# rate (integer) within this.
RATE_MATCH_HZ = 1.0
# Resampler: windowed-sinc low-pass at RESAMPLE_CUTOFF x REF_RATE, Blackman window spanning
# ±RESAMPLE_HALF_WIDTH output periods, fractional position quantised to 1/RESAMPLE_PHASES of an
# input sample (time error ≤ 1 / (2 x 512 x 24 975) s ≈ 39 ns). Symmetric kernel: zero delay.
RESAMPLE_CUTOFF = 0.45
RESAMPLE_HALF_WIDTH = 16
RESAMPLE_PHASES = 512


class InvalidRun(Exception):
	pass


def contract_ms(name):
	"""A constant of the frozen api-types contract (e.g. CLOSE_GUARD_MS)."""
	text = (ROOT.parents[1] / "packages/api-types/src/live-audio.ts").read_text()
	match = re.search(r"export const LIVE_AUDIO_AUTO_SQUELCH_" + name + r" = ([\d_]+)", text)
	if not match:
		raise InvalidRun("missing contract constant " + name)
	return int(match[1].replace("_", ""))


def manifest():
	path = ROOT.parents[1] / "tests/mocks/fixtures/evidence-squelch/manifest.json"
	return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Endpoint safety (pure; exercised by --self-test)


def check_port(port):
	if not isinstance(port, int) or port in FORBIDDEN_PORTS or port not in SAFE_PORTS:
		raise InvalidRun("refusing host port outside the safe range " + f"{SAFE_PORTS.start}-{SAFE_PORTS.stop - 1}")
	return port


def check_endpoint(host, port, expected=None):
	"""Refuse anything but 127.0.0.1 on a safe, non-forbidden port (and the requested one)."""
	if host != "127.0.0.1":
		raise InvalidRun("published endpoint is not 127.0.0.1")
	check_port(port)
	if expected is not None and port != expected:
		raise InvalidRun("published port differs from the requested one")
	return host, port


def pick_ports(count, is_free, rng=None):
	"""`count` distinct safe ports for which is_free(port) holds."""
	rng = rng or random.Random()
	candidates = [p for p in SAFE_PORTS if p not in FORBIDDEN_PORTS]
	rng.shuffle(candidates)
	out = []
	for port in candidates:
		if is_free(port):
			out.append(check_port(port))
			if len(out) == count:
				return out
	raise InvalidRun("no free port in the safe range")


def loopback_free(port):
	"""Bind-only probe on 127.0.0.1 (never connects)."""
	check_port(port)
	with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
		try:
			probe.bind(("127.0.0.1", port))
		except OSError:
			return False
	return True


# ---------------------------------------------------------------------------
# Resampling (pure; exercised by --self-test)


def _resample_table(ratio):
	"""Per phase, the normalised taps for input offsets -half..half (ratio = in/out rate)."""
	fc = RESAMPLE_CUTOFF / ratio  # cycles per input sample
	half = math.ceil(RESAMPLE_HALF_WIDTH * ratio)
	span = RESAMPLE_HALF_WIDTH * ratio
	table = []
	for p in range(RESAMPLE_PHASES):
		frac = p / RESAMPLE_PHASES
		taps = []
		for j in range(-half, half + 1):
			x = j - frac
			if abs(x) >= span:
				taps.append(0.0)
				continue
			sinc = 2 * fc if x == 0 else math.sin(2 * math.pi * fc * x) / (math.pi * x)
			w = 0.42 + 0.5 * math.cos(math.pi * x / span) + 0.08 * math.cos(2 * math.pi * x / span)
			taps.append(sinc * w)
		total = sum(taps)
		table.append([t / total for t in taps])
	return half, table


def resample(samples, rate_in, rate_out=REF_RATE):
	"""Arbitrary-ratio windowed-sinc resampling; output n sits at input time n x rate_in/rate_out
	exactly (symmetric kernel, so no group delay to compensate). Edges are zero-padded."""
	if rate_in <= 0 or not math.isfinite(rate_in):
		raise InvalidRun("invalid audio rate")
	if rate_in < rate_out:
		raise InvalidRun("audio rate below the reference rate")
	ratio = rate_in / rate_out
	half, table = _resample_table(ratio)
	padded = [0.0] * half + list(samples) + [0.0] * (half + 1)
	width = 2 * half + 1
	out = []
	count = int(len(samples) / ratio)
	mul = operator.mul
	for n in range(count):
		t = n * ratio
		i0 = int(t)
		phase = int((t - i0) * RESAMPLE_PHASES + 0.5)
		if phase == RESAMPLE_PHASES:
			i0, phase = i0 + 1, 0
		out.append(sum(map(mul, padded[i0 : i0 + width], table[phase])))
	return out


# ---------------------------------------------------------------------------
# Verdict functions (pure; exercised by --self-test)


def nonzero_runs(samples, rate, min_gap_s=0.5):
	"""(start, end) sample index pairs of audio separated by at least min_gap_s of exact zeros."""
	runs, start, last, gap = [], None, None, int(min_gap_s * rate)
	for i, v in enumerate(samples):
		if v != 0:
			if start is None:
				start = i
			elif i - last > gap:
				runs.append((start, last + 1))
				start = i
			last = i
	if start is not None:
		runs.append((start, last + 1))
	return runs


def best_lag(recorded, start, reference, ref_start, rate):
	"""Lag in seconds (recorded minus reference) of the normalised correlation peak within
	±CORR_SEARCH_S, comparing CORR_WINDOW_S of reference from ref_start."""
	n = int(CORR_WINDOW_S * rate)
	ref = reference[ref_start : ref_start + n]
	if len(ref) < n:
		return None
	ref_energy = sum(v * v for v in ref) or 1e-12
	best, best_score = None, -1.0
	search = int(CORR_SEARCH_S * rate)
	for lag in range(-search, search + 1):
		a = start + lag
		if a < 0 or a + n > len(recorded):
			continue
		seg = recorded[a : a + n]
		energy = sum(v * v for v in seg)
		if energy <= 0:
			continue
		score = abs(sum(map(operator.mul, seg, ref))) / (energy * ref_energy) ** 0.5
		if score > best_score:
			best, best_score = lag, score
	return None if best is None else best / rate


def verdict_opened(expect, runs):
	opened = len(runs) > 0
	want = expect != "none"
	return None if opened == want else f"opened={opened}, manifest expect={expect}"


def verdict_onset(lags):
	bad = [lag for lag in lags if lag is None or abs(lag) > ONSET_TOLERANCE_S]
	if not lags or bad:
		return f"first played sample off the over onset: lags {lags} (limit {ONSET_TOLERANCE_S * 1000:.0f} ms)"
	return None


def parse_iso(text):
	match = re.match(r"(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+(?:\.\d+)?)Z$", text if isinstance(text, str) else "")
	if not match:
		raise InvalidRun("unparsable event timestamp")
	y, mo, d, h, mi = (int(match[i]) for i in range(1, 6))
	return calendar.timegm((y, mo, d, h, mi, 0, 0, 0, 0)) + float(match[6])


def format_iso(t):
	whole = math.floor(t)
	ms = int(round((t - whole) * 1000))
	if ms == 1000:
		whole, ms = whole + 1, 0
	return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(whole)) + f".{ms:03d}Z"


def _number(value):
	return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def source_clock(side, fixture):
	"""The source timeline of one run: when the fake started sending the file (its `connected`
	event, core-side wall clock), where the over sits in the file (fixture sidecar), the file
	period, and the host-monotonic minus core-wall offset bounded by the earliest transmission
	event receipt (None without events). Missing evidence is an invalid run."""
	src = side.get("source")
	if not isinstance(src, dict) or not _number(src.get("connectedTs")):
		raise InvalidRun("missing source clock (fake rtl_tcp connected event)")
	if src.get("connections") != 1:
		raise InvalidRun("fake rtl_tcp saw more than one connection (source clock ambiguous)")
	if not isinstance(fixture, dict) or not _number(fixture.get("overOnsetS")) or not _number(fixture.get("periodS")):
		raise InvalidRun("missing fixture sidecar onset or period")
	if fixture["periodS"] <= 0:
		raise InvalidRun("invalid fixture period")
	offsets = []
	for event in side.get("transmissions", []):
		if _number(event.get("mono")) and isinstance(event.get("startedAt"), str):
			offsets.append(event["mono"] - parse_iso(event["startedAt"]))
	return {"connected": float(src["connectedTs"]), "onset": float(fixture["overOnsetS"]),
		"period": float(fixture["periodS"]), "offset": min(offsets) if offsets else None}


def over_at(clock, wall):
	"""(index, source onset wall time) of the over a core-wall time belongs to."""
	k = math.floor((wall - clock["connected"] - clock["onset"] + ASSOC_SLACK_S) / clock["period"])
	return k, clock["connected"] + clock["onset"] + k * clock["period"]


def arrival_time(arrivals, byte_index):
	"""Host-monotonic arrival of the chunk holding byte_index; arrivals are (mono, cumulative)."""
	totals = [b for _t, b in arrivals]
	i = bisect_left(totals, byte_index + 1)
	return arrivals[i][0] if i < len(arrivals) else None


def played_overs(side, runs, clock, rate):
	"""Per played run: its over, stage-1 latency and the delay of its first and last sample
	behind the source. Every played run must sit on a recorded stage-1 open of its over."""
	if clock["offset"] is None:
		raise InvalidRun("audio played but no transmission event places it on the source clock")
	opens = sorted(parse_iso(e["startedAt"]) for e in side.get("transmissions", [])
		if e.get("state") == "open" and isinstance(e.get("startedAt"), str))
	if not opens:
		raise InvalidRun("audio played but no stage-1 open event recorded")
	out = []
	for s, e in runs:
		first = arrival_time(side["arrivals"], int(s * rate / REF_RATE) * 2)
		last = arrival_time(side["arrivals"], int((e - 1) * rate / REF_RATE) * 2)
		if first is None or last is None:
			raise InvalidRun("played sample without an arrival time")
		w_first, w_last = first - clock["offset"], last - clock["offset"]
		i = bisect_left(opens, w_first + 1e-9) - 1
		if i < 0:
			raise InvalidRun("played audio before any stage-1 open")
		k, onset = over_at(clock, opens[i])
		if k < 0 or not onset - ASSOC_SLACK_S <= opens[i] <= onset + MAX_DELAY_S:
			raise InvalidRun("stage-1 open does not match a source over onset")
		out.append({"over": k, "stage1S": opens[i] - onset, "startS": w_first - onset,
			"endS": w_last - (onset + (e - 1 - s) / REF_RATE)})
	return out


def verdict_delay(overs):
	"""Per played over: delay of its first and last sample behind the source ≤ MAX_DELAY_S."""
	if not overs:
		raise InvalidRun("no played over to measure delay on")
	delays = [d for o in overs for d in (o["startS"], o["endS"])]
	worst, least = max(delays), min(delays)
	if least < -ONSET_TOLERANCE_S:
		return f"played {-least:.3f} s before its source time (clock evidence inconsistent)", worst
	return (None if worst <= MAX_DELAY_S else f"per-over delay {worst:.3f} s > {MAX_DELAY_S} s"), worst


def verdict_byte_rate(arrivals, byte_rate):
	"""Bytes per full minute within BYTE_RATE_TOLERANCE of nominal."""
	if not arrivals:
		return "no stream bytes", []
	t0, b0 = arrivals[0]
	rates, edge = [], t0 + 60.0
	prev_b = b0
	for t, b in arrivals:
		if t >= edge:
			rates.append((b - prev_b) / 60.0)
			prev_b, edge = b, edge + 60.0
	bad = [r for r in rates if abs(r / byte_rate - 1) > BYTE_RATE_TOLERANCE]
	if not rates:
		return "under one minute of stream recorded", rates
	return (f"byte rate off nominal {byte_rate}: {bad}" if bad else None), rates


def event_edges(events, clock):
	"""{(over, n): (open, close)} of completed transmissions, seconds after the source onset of
	their over (the n-th transmission within that over)."""
	out, seen = {}, {}
	for e in events:
		if e.get("state") != "closed" or not _number(e.get("durationMs")):
			continue
		start = parse_iso(e.get("startedAt"))
		k, onset = over_at(clock, start)
		n = seen.get(k, 0)
		seen[k] = n + 1
		out[(k, n)] = (start - onset, start - onset + e["durationMs"] / 1000)
	return out


def required_events(carrier, seconds, period):
	if not carrier:
		return 0
	return max(MIN_EVENTS, int((seconds - STARTUP_S) / period) - 1)


def verdict_events(auto_events, manual_events, auto_clock, manual_clock, required):
	"""Transmissions of both runs on their own source clock: enough of them, the same overs and
	edges within EVENT_TOLERANCE_S (a systematic shift fails)."""
	a, m = event_edges(auto_events, auto_clock), event_edges(manual_events, manual_clock)
	if len(a) < required or len(m) < required:
		return f"too few completed transmissions: auto {len(a)}, manual {len(m)}, need {required}"
	if a or m:
		horizon = min(max(a)[0] if a else -1, max(m)[0] if m else -1)
		differ = sorted(key for key in set(a) ^ set(m) if key[0] <= horizon)
		if differ:
			return f"transmission sets differ at over {differ[0][0]}: auto {len(a)} manual {len(m)}"
	for key in sorted(set(a) & set(m)):
		(ao, ac), (mo, mc) = a[key], m[key]
		if abs(ao - mo) > EVENT_TOLERANCE_S or abs(ac - mc) > EVENT_TOLERANCE_S:
			return f"transmission edges differ at over {key[0]}: auto {ao:.3f}-{ac:.3f} manual {mo:.3f}-{mc:.3f}"
	return None


def verdict_p99(auto_p99, manual_p99):
	if not auto_p99 or not manual_p99:
		return "missing event-loop p99 samples"
	a, m = max(auto_p99), max(manual_p99)
	return None if a - m <= P99_TOLERANCE_MS else f"event-loop p99 {a:.2f} ms vs manual {m:.2f} ms"


def verdict_drain(drains_ms, guard_ms):
	"""Back-chain drain: last audible stream byte after the close event (manual run)."""
	if not drains_ms:
		return None, None
	worst = max(drains_ms)
	return (None if worst <= guard_ms else f"measured back-chain drain {worst:.0f} ms > CLOSE_GUARD_MS {guard_ms}"), worst


def evaluate(obs, guard_ms):
	"""All verdicts of one fixture from its recorded observations."""
	failures, notes = [], {}
	auto, manual = obs["auto"], obs["manual"]
	clocks = {mode: source_clock(obs[mode], obs[mode].get("fixture")) for mode in ("auto", "manual")}
	rate = auto["audioRate"]
	byte_rate = rate * 2
	runs = nonzero_runs(auto["samples8k"], REF_RATE)
	if f := verdict_opened(obs["expect"], runs):
		failures.append(f)
	if obs["expect"] != "none" and runs:
		lags = [best_lag(auto["samples8k"], s, obs["reference8k"], obs["refOnset8k"], REF_RATE) for s, _e in runs]
		if f := verdict_onset(lags):
			failures.append(f)
		notes["onsetLagsS"] = lags
		overs = played_overs(auto, runs, clocks["auto"], rate)
		notes["overs"] = overs
		f, worst = verdict_delay(overs)
		notes["maxDelayS"] = worst
		if f:
			failures.append(f)
	f, rates = verdict_byte_rate(auto["arrivals"], byte_rate)
	notes["byteRates"] = rates
	if f:
		failures.append(f)
	required = required_events(obs["carrier"], obs["seconds"], clocks["auto"]["period"])
	if f := verdict_events(auto["transmissions"], manual["transmissions"], clocks["auto"], clocks["manual"], required):
		failures.append(f)
	if f := verdict_p99(auto["p99Ms"], manual["p99Ms"]):
		failures.append(f)
	f, drain = verdict_drain(manual.get("drainsMs", []), guard_ms)
	notes["drainMs"] = drain
	if f:
		notes["drainReport"] = f  # reported, not a failure (plan: else report the measured drain)
	return failures, notes


# ---------------------------------------------------------------------------
# Self-test


class _FakeSock:
	"""recv() replays bytes, "timeout" (socket.timeout) or b"" (peer closed)."""

	def __init__(self, items):
		self.items, self.sent = list(items), []

	def recv(self, _n):
		if not self.items:
			raise socket.timeout()
		item = self.items.pop(0)
		if item == "timeout":
			raise socket.timeout()
		return item

	def sendall(self, data):
		self.sent.append(data)


def _frame(payload, opcode=1, fin=True):
	data = payload.encode() if isinstance(payload, str) else payload
	n = len(data)
	head = bytes([(0x80 if fin else 0) | opcode]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack(">H", n))
	return head + data


def _self_test_ws():
	big = json.dumps({"type": "live-audio:transmission", "data": {"state": "open", "x": "y" * 300}})
	small = json.dumps({"type": "live-audio:level", "data": {"dbfs": -20}})
	wire = _frame(big) + _frame(small[:10], fin=False) + _frame(small[10:], opcode=0) + _frame(b"", opcode=9)
	# Timeouts inside the 2-byte header, the 16-bit length and the payload.
	items = [wire[:1], "timeout", wire[1:3], "timeout", wire[3:50], "timeout", "timeout", wire[50:]]
	stop = threading.Event()
	obs = {"levels": [], "transmissions": []}
	ws = WsClient(_FakeSock(items + [_frame(b"", opcode=8)]), stop)
	try:
		read_ws(ws, stop, obs)
		raise AssertionError("unexpected close not reported")
	except InvalidRun as exc:
		assert "closed" in str(exc)
	assert len(obs["transmissions"]) == 1 and len(obs["levels"]) == 1, obs
	assert obs["transmissions"][0]["x"] == "y" * 300
	assert any(s[0] == 0x8A for s in ws.sock.sent), "ping not answered"
	# Peer EOF mid-run is invalid.
	try:
		read_ws(WsClient(_FakeSock([wire[:5], b""]), threading.Event()), threading.Event(), {"levels": [], "transmissions": []})
		raise AssertionError("EOF not reported")
	except InvalidRun:
		pass
	# Stop during timeouts ends cleanly, keeping what was read.
	stop = threading.Event()
	obs = {"levels": [], "transmissions": []}
	sock = _FakeSock([_frame(small), wire[:3]])
	ws = WsClient(sock, stop)
	orig = sock.recv

	def recv(n):
		if not sock.items:
			stop.set()
		return orig(n)

	sock.recv = recv
	read_ws(ws, stop, obs)
	assert len(obs["levels"]) == 1


def _self_test_ports():
	for port in sorted(FORBIDDEN_PORTS):
		for call in (lambda: check_port(port), lambda: check_endpoint("127.0.0.1", port)):
			try:
				call()
				raise AssertionError(f"forbidden port {port} accepted")
			except InvalidRun:
				pass
	for host, port, expected in (("0.0.0.0", 47100, None), ("::1", 47100, None), ("192.168.1.2", 47100, None),
			("localhost", 47100, None), ("127.0.0.1", 32768, None), ("127.0.0.1", 47101, 47100)):
		try:
			check_endpoint(host, port, expected)
			raise AssertionError(f"endpoint {host}:{port} accepted")
		except InvalidRun:
			pass
	assert check_endpoint("127.0.0.1", 47100, 47100) == ("127.0.0.1", 47100)
	ports = pick_ports(2, lambda p: p % 3 == 0, random.Random(1))
	assert len(set(ports)) == 2 and all(p in SAFE_PORTS and p not in FORBIDDEN_PORTS and p % 3 == 0 for p in ports)
	try:
		pick_ports(2, lambda _p: False)
		raise AssertionError("no-free-port not refused")
	except InvalidRun:
		pass


def _self_test_resampler():
	for rate_in in (2_048_000 / 82, 25_000.0, 16_000.0):
		for freq in (300.0, 1_000.0, 2_500.0):
			n_in = int(0.6 * rate_in)
			x = [0.5 * math.sin(2 * math.pi * freq * i / rate_in + 0.3) for i in range(n_in)]
			y = resample(x, rate_in)
			assert abs(len(y) - int(0.6 * REF_RATE)) <= 1, len(y)
			margin = int(0.05 * REF_RATE)
			seg = range(margin, len(y) - margin)
			sin_p = sum(y[n] * math.sin(2 * math.pi * freq * n / REF_RATE + 0.3) for n in seg)
			cos_p = sum(y[n] * math.cos(2 * math.pi * freq * n / REF_RATE + 0.3) for n in seg)
			amp = 2 * math.hypot(sin_p, cos_p) / len(seg)
			delay = math.atan2(-cos_p, sin_p) / (2 * math.pi * freq)
			err = max(abs(y[n] - 0.5 * math.sin(2 * math.pi * freq * n / REF_RATE + 0.3)) for n in seg)
			assert abs(amp / 0.5 - 1) < 0.003, (rate_in, freq, amp)
			assert abs(delay) < 2e-6, (rate_in, freq, delay)
			if freq <= 1_000.0:
				assert err < 2e-3, (rate_in, freq, err)
		# A band-limited pulse at a known time lands on the same output time (no delay).
		center = 0.3
		x = [math.exp(-(((i / rate_in) - center) / 0.0008) ** 2) for i in range(int(0.6 * rate_in))]
		y = resample(x, rate_in)
		k = max(range(len(y)), key=y.__getitem__)
		a, b, c = (math.log(y[i]) for i in (k - 1, k, k + 1))  # a Gaussian is a log-parabola
		peak = (k + 0.5 * (a - c) / (a - 2 * b + c)) / REF_RATE
		assert abs(peak - center) < 5e-6, (rate_in, peak)
	assert resample([1.0] * 8000, 8000.0)[100] == 1.0


def self_test():
	_self_test_ports()
	_self_test_ws()
	_self_test_resampler()
	rate = REF_RATE
	seed = [12345]

	def noise():
		seed[0] = (seed[0] * 1103515245 + 12345) % (1 << 31)
		return seed[0] / (1 << 30) - 1.0 or 0.5

	onset = int(0.25 * rate)
	ref = [0.0] * onset + [noise() for _ in range(int(3.75 * rate))]
	conn, gap, period, host_offset, pipe_delay = 1_792_000_000.0, 3.0, 6.75, -1_791_990_000.0, 0.3
	stream_s, overs_played, overs_tx, stage1 = 65.0, 2, 8, 0.05

	def recorded(skip=0):
		"""Stream samples: over k plays from source onset (minus pipe_delay of stream start)."""
		out = [0.0] * int(stream_s * rate)
		for k in range(overs_played):
			i = int((gap + k * period - pipe_delay) * rate)
			body = ref[onset + skip :]
			out[i : i + len(body)] = body
		return out

	def arrivals(stretch=1.0, stall_after=None):
		out = []
		for step in range(int(stream_s * 10) + 1):
			t = conn + pipe_delay + 0.25 + step * 0.1 * stretch
			if stall_after is not None and step * 0.1 > stall_after:
				t += 2.0
			out.append((t + host_offset, int(step * 0.1 * 2 * rate)))
		return out

	def events(shift=0.0, count=overs_tx, skip=()):
		out = []
		for k in range(count):
			if k in skip:
				continue
			start = conn + gap + k * period + stage1 + shift
			mono = start + host_offset + 0.002
			out.append({"state": "open", "startedAt": format_iso(start), "durationMs": None, "mono": mono})
			out.append({"state": "closed", "startedAt": format_iso(start), "durationMs": 3750, "mono": mono + 3.75})
		return out

	fixture = {"overOnsetS": gap, "periodS": period}
	source = {"connectedTs": conn, "connections": 1}
	base = {
		"expect": "voice", "reference8k": ref, "refOnset8k": onset, "carrier": True, "seconds": stream_s,
		"auto": {"audioRate": rate, "samples8k": recorded(), "arrivals": arrivals(), "transmissions": events(),
			"p99Ms": [3.0], "source": source, "fixture": fixture},
		"manual": {"audioRate": rate, "transmissions": events(), "p99Ms": [2.5], "drainsMs": [120.0],
			"source": source, "fixture": fixture},
	}

	def variant(**changes):
		obs = json.loads(json.dumps(base))
		for path, value in changes.items():
			side, key = path.split("__")
			if side == "top":
				obs[key] = value
			elif value is None:
				obs[side].pop(key, None)
			else:
				obs[side][key] = value
		return evaluate(obs, 200)[0]

	def invalid(**changes):
		try:
			variant(**changes)
		except InvalidRun as exc:
			return str(exc)
		raise AssertionError(f"accepted without timing evidence: {list(changes)}")

	assert variant() == [], variant()
	assert any("opened" in f for f in variant(top__expect="none"))
	assert any("onset" in f for f in variant(auto__samples8k=recorded(int(0.03 * rate))))
	assert any("byte rate" in f for f in variant(auto__arrivals=arrivals(1.02)))
	assert any("delay" in f for f in variant(auto__arrivals=arrivals(stall_after=gap + 1.0)))
	# Missing timing evidence is invalid, never a zero-delay pass.
	assert "source clock" in invalid(auto__source=None)
	assert "more than one" in invalid(auto__source={"connectedTs": conn, "connections": 2})
	assert "sidecar" in invalid(auto__fixture={"periodS": period})
	assert "transmission event" in invalid(auto__transmissions=[], manual__transmissions=[])
	assert "stage-1" in invalid(auto__transmissions=events(shift=MAX_DELAY_S + 0.2))
	assert "stage-1" in invalid(auto__transmissions=[e for e in events() if e["state"] == "closed"])
	# Transmissions: a systematic shift, a missing over, too few and empty sets all fail.
	assert any("edges" in f for f in variant(manual__transmissions=events(shift=0.05)))
	late = [dict(e, durationMs=3800) if e["state"] == "closed" else e for e in events()]
	assert any("edges" in f for f in variant(manual__transmissions=late))
	assert any("differ" in f for f in variant(manual__transmissions=events(skip=(3,))))
	assert any("few" in f for f in variant(auto__transmissions=events(count=2), manual__transmissions=events(count=2)))
	empty = variant(top__expect="none", auto__samples8k=[0.0] * int(stream_s * rate),
		auto__transmissions=[], manual__transmissions=[])
	assert any("few" in f for f in empty), empty
	assert variant(top__expect="none", top__carrier=False, auto__samples8k=[0.0] * int(stream_s * rate),
		auto__transmissions=[], manual__transmissions=[]) == []
	assert any("p99" in f for f in variant(auto__p99Ms=[5.0]))
	assert any("p99" in f for f in variant(auto__p99Ms=[]))
	assert verdict_drain([250.0], 200)[0] is not None and verdict_drain([150.0], 200)[0] is None
	assert nonzero_runs([0, 1, 1, 0, 0, 0, 2], 1, min_gap_s=2) == [(1, 3), (6, 7)]
	assert parse_iso("1970-01-01T00:00:01.5Z") == 1.5 and parse_iso(format_iso(conn + 0.25)) == conn + 0.25
	print("ok")


# ---------------------------------------------------------------------------
# Forwarder (runs inside the `api` container: --proxy)


async def _pipe(reader, writer):
	try:
		while data := await reader.read(65536):
			writer.write(data)
			await writer.drain()
	finally:
		writer.close()


def proxy():
	async def serve(port):
		async def handle(reader, writer):
			try:
				up_reader, up_writer = await asyncio.open_connection("core", port)
			except OSError:
				writer.close()
				return
			await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer), return_exceptions=True)

		server = await asyncio.start_server(handle, "0.0.0.0", port)
		async with server:
			await server.serve_forever()

	async def main():
		await asyncio.gather(serve(API_PORT), serve(STREAM_PORT))

	asyncio.run(main())


# ---------------------------------------------------------------------------
# Live recording (Docker; never run by --self-test or --replay)


class _WsStopped(Exception):
	pass


class WsClient:
	"""Minimal RFC 6455 text client (stdlib only) for the core's /ws. A socket timeout only
	re-checks `stop`; buffered bytes of a partial frame are kept."""

	def __init__(self, sock, stop, buf=b""):
		self.sock, self.stop, self.buf = sock, stop, buf

	@classmethod
	def connect(cls, host, port, channels, stop):
		check_endpoint(host, port)
		sock = socket.create_connection((host, port), timeout=10)
		key = base64.b64encode(os.urandom(16)).decode()
		sock.sendall((f"GET /ws HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
			f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
		head = b""
		while b"\r\n\r\n" not in head:
			chunk = sock.recv(4096)
			if not chunk:
				raise InvalidRun("websocket handshake closed")
			head += chunk
		if b" 101 " not in head.split(b"\r\n", 1)[0]:
			raise InvalidRun("websocket handshake refused")
		sock.settimeout(2)
		ws = cls(sock, stop, head.split(b"\r\n\r\n", 1)[1])
		ws.send(json.dumps({"type": "subscribe", "channels": channels}))
		return ws

	def send(self, text, opcode=1):
		data = text.encode() if isinstance(text, str) else text
		mask = os.urandom(4)
		header = bytes([0x80 | opcode])
		n = len(data)
		header += bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", n))
		self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

	def _fill(self, n):
		while len(self.buf) < n:
			if self.stop.is_set():
				raise _WsStopped
			try:
				chunk = self.sock.recv(65536)
			except socket.timeout:
				continue
			if not chunk:
				raise InvalidRun("websocket ended by the core before the run did")
			self.buf += chunk

	def _frame(self):
		"""One whole frame (fin, opcode, payload); consumes nothing until it is complete."""
		self._fill(2)
		b0, b1 = self.buf[0], self.buf[1]
		n, head = b1 & 0x7F, 2
		if n == 126:
			self._fill(4)
			n, head = struct.unpack(">H", self.buf[2:4])[0], 4
		elif n == 127:
			self._fill(10)
			n, head = struct.unpack(">Q", self.buf[2:10])[0], 10
		self._fill(head + n)
		payload, self.buf = self.buf[head : head + n], self.buf[head + n :]
		return bool(b0 & 0x80), b0 & 0x0F, payload

	def messages(self):
		"""Text messages until `stop`; a close frame or EOF before it is an invalid run."""
		parts = None
		try:
			while True:
				fin, opcode, payload = self._frame()
				if opcode == 8:
					raise InvalidRun("websocket closed by the core before the run did")
				if opcode == 9:
					self.send(payload, opcode=10)
				elif opcode == 1:
					parts = [payload]
				elif opcode == 0 and parts is not None:
					parts.append(payload)
				if opcode in (0, 1) and fin and parts is not None:
					yield b"".join(parts).decode("utf-8", "replace")
					parts = None
		except _WsStopped:
			return


def read_ws(ws, stop, obs):
	for text in ws.messages():
		msg = json.loads(text)
		kind = msg.get("type") if isinstance(msg, dict) else None
		if kind == "live-audio:level":
			obs["levels"].append((time.monotonic(), msg.get("data")))
		elif kind == "live-audio:transmission":
			data = msg.get("data")
			obs["transmissions"].append(dict(data if isinstance(data, dict) else {}, mono=time.monotonic()))
	if not stop.is_set():
		raise InvalidRun("websocket reader ended before the run did")


def parse_wav_header(read):
	"""Read RIFF chunks up to `data`; returns (rate, channels, bits)."""
	head = read(12)
	if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
		raise InvalidRun("stream.wav is not a WAV stream")
	rate = channels = bits = None
	while True:
		cid, size = struct.unpack("<4sI", read(8))
		if cid == b"data":
			break
		body = read(size + (size & 1))
		if cid == b"fmt ":
			_fmt, channels, rate, _br, _ba, bits = struct.unpack("<HHIIHH", body[:16])
	if rate is None or channels != 1 or bits != 16:
		raise InvalidRun("stream.wav is not mono s16le")
	return rate, channels, bits


class Recorder:
	def __init__(self, args, name, mode, run_dir):
		self.args, self.name, self.mode, self.dir = args, name, mode, run_dir
		self.project = f"wkevs-{os.getpid()}"
		self.opener = build_opener(ProxyHandler({}))
		self.stop = threading.Event()
		self.obs = {"mode": mode, "arrivals": [], "levels": [], "transmissions": [], "status": [], "p99Ms": []}

	def compose(self, *args, check=True, timeout=120):
		cmd = ["docker", "compose", "-p", self.project, "-f", str(ROOT / "compose.yaml"), *args]
		return subprocess.run(cmd, env=self.env, text=True, capture_output=True, check=check, timeout=timeout)

	def endpoint(self, inner, expected):
		"""The published endpoint of the forwarder's `inner` port; must be the requested safe one."""
		lines = [line.strip() for line in self.compose("port", "api", str(inner)).stdout.splitlines() if line.strip()]
		if len(lines) != 1:
			raise InvalidRun("forwarder must publish exactly one endpoint per port")
		host, _, port = lines[0].rpartition(":")
		if not port.isdigit():
			raise InvalidRun("unparsable published port")
		return check_endpoint(host.strip("[]"), int(port), expected)

	def get(self, path, method="GET"):
		req = Request(self.base + path, method=method, data=b"{}" if method == "POST" else None,
			headers={"Content-Type": "application/json"} if method == "POST" else {})
		with self.opener.open(req, timeout=5) as response:
			return json.load(response)

	def write_config(self, entry):
		text = (ROOT / "config.yaml").read_text()
		swaps = {
			r'sampleRate: \d+ # driver: --rate': f"sampleRate: {self.args.rate}",
			r'modulation: "nfm" # driver: fixture mode': f'modulation: "{entry["mode"]}"',
			r'squelchMode: "auto" # driver: auto \| manual': f'squelchMode: "{self.mode}"',
			r'engine: "csdr" # driver: --engine': f'engine: "{self.args.engine}"',
		}
		for pattern, value in swaps.items():
			text, count = re.subn(pattern, value, text)
			if count != 1:
				raise InvalidRun("config.yaml driver marker missing: " + pattern)
		path = self.dir / "config.yaml"
		path.write_text(text)
		return path

	def source_events(self):
		"""The fake's `connected` events (core-side wall clock) from its log."""
		out = self.compose("logs", "--no-color", "--no-log-prefix", "fake").stdout
		connected = []
		for line in out.splitlines():
			try:
				event = json.loads(line)
			except ValueError:
				continue
			if isinstance(event, dict) and event.get("event") == "connected" and _number(event.get("ts")):
				connected.append(float(event["ts"]))
		if not connected:
			raise InvalidRun("fake rtl_tcp logged no connection")
		return {"connectedTs": connected[0], "connections": len(connected)}

	def run(self, entry, cu8, cu8_meta):
		self.dir.mkdir(parents=True, exist_ok=True)
		config = self.write_config(entry)
		api_port, stream_port = pick_ports(2, loopback_free)
		self.obs["fixture"] = cu8_meta
		self.obs["seconds"] = self.args.seconds
		self.env = dict(os.environ, EVIDENCE_SQUELCH_CU8=cu8.name, EVIDENCE_SQUELCH_DATA=str(cu8.parent.resolve()),
			EVIDENCE_SQUELCH_CONFIG=str(config.resolve()), EVIDENCE_SQUELCH_RATE=str(self.args.rate),
			EVIDENCE_SQUELCH_DURATION=str(int(self.args.seconds) + 300),
			EVIDENCE_SQUELCH_CORE_QUOTA=str(self.args.cpu_quota or 0),
			EVIDENCE_SQUELCH_API_PORT=str(api_port), EVIDENCE_SQUELCH_STREAM_PORT=str(stream_port))
		threads = []
		try:
			self.compose("up", "-d", "--no-build", "--pull", "never", timeout=180)
			# Both endpoints are verified before any client (including the readiness poll) starts.
			host, api = self.endpoint(API_PORT, api_port)
			stream = self.endpoint(STREAM_PORT, stream_port)
			self.base = f"http://{host}:{api}"
			deadline = time.monotonic() + 90
			while True:
				try:
					if self.get("/api/live-audio/status").get("sourceConnected"):
						break
				except OSError:
					pass
				if time.monotonic() > deadline:
					raise InvalidRun("core or fake source not ready within 90 s")
				time.sleep(1)
			if not self.get("/api/live-audio/status").get("running"):
				self.get("/api/live-audio/start", method="POST")
			threads = [threading.Thread(target=t, args=a, daemon=True) for t, a in (
				(self.record_stream, stream), (self.record_ws, (host, api)), (self.poll, ()))]
			for t in threads:
				t.start()
			end = time.monotonic() + self.args.seconds
			while time.monotonic() < end and not self.stop.is_set():
				time.sleep(0.5)
			self.stop.set()
			for t in threads:
				t.join(timeout=10)
			if "error" in self.obs:
				raise InvalidRun(self.obs["error"])
			if any(t.is_alive() for t in threads):
				raise InvalidRun("a recorder thread did not stop")
			self.obs["source"] = self.source_events()
		finally:
			self.stop.set()
			for t in threads:
				t.join(timeout=10)
			try:
				self.compose("down", "--volumes", "--remove-orphans", "--timeout", "10", timeout=120)
			except (subprocess.SubprocessError, OSError) as exc:
				raise InvalidRun("teardown failed: " + str(exc)) from exc
		(self.dir / "observations.json").write_text(json.dumps(self.obs) + "\n")
		return self.obs

	def record_stream(self, host, port):
		try:
			check_endpoint(host, port)
			with socket.create_connection((host, port), timeout=10) as sock:
				sock.sendall(f"GET /stream.wav HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n".encode())
				reader = sock.makefile("rb")
				status = reader.readline()
				if b" 200 " not in status:
					raise InvalidRun("stream.wav refused")
				chunked = False
				while (line := reader.readline().strip()):
					chunked |= line.lower() == b"transfer-encoding: chunked"
				read = (lambda n: dechunk(reader, n)) if chunked else reader.read
				rate, _c, _b = parse_wav_header(read)
				self.obs["audioRate"] = rate
				total = 0
				with open(self.dir / "stream.s16le", "wb") as out:
					while not self.stop.is_set():
						data = reader.read1(65536) if not chunked else dechunk(reader, None)
						if not data:
							raise InvalidRun("stream ended before the run did")
						now = time.monotonic()
						if total == 0:
							self.obs["streamT0"] = now
						total += len(data)
						out.write(data)
						self.obs["arrivals"].append((now, total))
		except (OSError, InvalidRun) as exc:
			self.obs["error"] = "stream: " + str(exc)
			self.stop.set()

	def record_ws(self, host, port):
		try:
			read_ws(WsClient.connect(host, port, ["live-audio"], self.stop), self.stop, self.obs)
		except (OSError, InvalidRun, ValueError) as exc:
			self.obs["error"] = "websocket: " + str(exc)
			self.stop.set()

	def poll(self):
		while not self.stop.wait(1.0):
			try:
				self.obs["status"].append((time.monotonic(), self.get("/api/live-audio/status")))
				for report in self.get("/api/resources/link-quality"):
					last = ((report.get("loopDelay") or {}).get("last") or {})
					if isinstance(last.get("p99Ms"), (int, float)):
						self.obs["p99Ms"].append(last["p99Ms"])
			except (OSError, ValueError):
				continue


_chunk_left = {}


def dechunk(reader, n):
	"""Read n bytes (or one available piece when n is None) of an HTTP chunked body."""
	out = b""
	while n is None or len(out) < n:
		left = _chunk_left.get(id(reader), 0)
		if left == 0:
			size = int(reader.readline().split(b";")[0].strip() or b"0", 16)
			if size == 0:
				return out
			left = size
		take = left if n is None else min(left, n - len(out))
		piece = reader.read(take)
		if not piece:
			return out
		out += piece
		left -= len(piece)
		if left == 0:
			reader.readline()
		_chunk_left[id(reader)] = left
		if n is None:
			return out
	return out


# ---------------------------------------------------------------------------
# Post-processing


def audio_rate(side):
	"""The exact (possibly fractional) audio rate: the status effectiveSampleRate, which must
	agree with the integer WAV header rate."""
	header = side.get("audioRate")
	if not _number(header):
		raise InvalidRun("no WAV header rate")
	status = [s.get("effectiveSampleRate") for _t, s in side.get("status", []) if isinstance(s, dict)]
	status = [r for r in status if _number(r) and r > 0]
	if not status:
		return float(header)
	if abs(status[-1] - header) > RATE_MATCH_HZ:
		raise InvalidRun(f"status rate {status[-1]} disagrees with WAV header {header}")
	return float(status[-1])


def to_8k(path, rate):
	data = path.read_bytes()
	samples = struct.unpack(f"<{len(data) // 2}h", data[: len(data) // 2 * 2])
	# Filtering smears held/closed silence; outputs whose kernel support lies wholly inside
	# exact zeros are kept exactly zero so nonzero_runs still sees the gate. One linear pass.
	out = resample([v / 32768 for v in samples], rate)
	ratio = rate / REF_RATE
	half = math.ceil(RESAMPLE_HALF_WIDTH * ratio)
	mask = [False] * len(out)
	for s, e in nonzero_runs(samples, rate, min_gap_s=(2 * half + 2) / rate):
		lo, hi = max(0, math.ceil((s - half) / ratio)), min(len(out) - 1, int((e - 1 + half) / ratio))
		for n in range(lo, hi + 1):
			mask[n] = True
	return [v if m else 0.0 for v, m in zip(out, mask)]


def reference(name):
	path = ROOT.parents[1] / "tests/mocks/fixtures/evidence-squelch" / f"{name}.audio.s16le"
	data = path.read_bytes()
	return [v / 32768 for v in struct.unpack(f"<{len(data) // 2}h", data)]


def drains(obs):
	"""Manual run: last non-zero stream byte after each close event, in ms (arrival time)."""
	out = []
	if not obs.get("arrivals"):
		return out
	samples_path = Path(obs["dir"]) / "stream.s16le"
	data = samples_path.read_bytes() if samples_path.exists() else b""
	for event in obs["transmissions"]:
		if event.get("state") != "closed":
			continue
		after = [(t, b) for t, b in obs["arrivals"] if t >= event["mono"]]
		last_audible = None
		for t, b in after[:50]:
			window = data[max(0, b - 4096) : b]
			if any(window):
				last_audible = t
		if last_audible is not None:
			out.append((last_audible - event["mono"]) * 1000)
	return out


def judge(run_dir, name, entry, guard_ms):
	obs = {"expect": entry["expect"], "reference8k": reference(name), "refOnset8k": int(entry["overOnsetS"] * REF_RATE),
		"carrier": name not in CARRIERLESS}
	for mode in ("auto", "manual"):
		path = run_dir / mode / "observations.json"
		if not path.exists():
			raise InvalidRun(f"missing {path}")
		side = json.loads(path.read_text())
		side["dir"] = str(run_dir / mode)
		if "audioRate" not in side or "streamT0" not in side:
			raise InvalidRun(f"{name} {mode}: no stream recorded")
		side["audioRate"] = audio_rate(side)
		side["samples8k"] = to_8k(run_dir / mode / "stream.s16le", side["audioRate"]) if mode == "auto" else []
		side["drainsMs"] = drains(side) if mode == "manual" else []
		obs[mode] = side
	obs["seconds"] = obs["auto"].get("seconds")
	if not _number(obs["seconds"]):
		raise InvalidRun(f"{name}: recording length missing")
	return evaluate(obs, guard_ms)


def report(out, results):
	(out / "verdicts.json").write_text(json.dumps(results, indent=2) + "\n")
	for name, r in results.items():
		print(f"{name}: {'PASS' if not r['failures'] else 'FAIL'} {json.dumps(r['notes'])}")
		for f in r["failures"]:
			print("  - " + f)
	return 1 if any(r["failures"] for r in results.values()) else 0


def acceptance(args):
	entries = manifest()
	names = list(entries) if args.fixture == "all" else [args.fixture]
	guard_ms = contract_ms("CLOSE_GUARD_MS")
	cu8_dir = args.out / "cu8"
	results = {}
	for name in names:
		cu8 = cu8_dir / f"{name}.{args.rate}.cu8"
		if not cu8.exists():
			subprocess.run([sys.executable, "-I", str(ROOT / "fixtures.py"), "--format", "cu8", "--rate", str(args.rate),
				"--out", str(cu8_dir), "--gap-s", str(GAP_S), "--fixture", name], check=True, timeout=900)
		meta = json.loads((cu8_dir / f"{cu8.name}.json").read_text())
		if not _number(meta.get("overOnsetS")):
			raise InvalidRun(f"{name}: sidecar has no over onset")
		# The fake replays whole I/Q pairs of the file in a loop: that is the over period.
		meta["periodS"] = (cu8.stat().st_size // 2) / args.rate
		for mode in ("auto", "manual"):
			Recorder(args, name, mode, args.out / name / mode).run(entries[name], cu8, meta)
		failures, notes = judge(args.out / name, name, entries[name], guard_ms)
		results[name] = {"failures": failures, "notes": notes, "rate": args.rate, "engine": args.engine,
			"cpuQuota": args.cpu_quota}
	return report(args.out, results)


def replay(out):
	entries = manifest()
	guard_ms = contract_ms("CLOSE_GUARD_MS")
	results = {}
	for name in sorted(p.name for p in out.iterdir() if p.is_dir() and p.name in entries):
		failures, notes = judge(out / name, name, entries[name], guard_ms)
		results[name] = {"failures": failures, "notes": notes}
	if not results:
		raise InvalidRun("no recorded fixtures under " + str(out))
	return report(out, results)


def interrupted(signum, _frame):
	raise InvalidRun("interrupted by " + signal.Signals(signum).name)


def main():
	p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
	p.add_argument("--rate", type=int, choices=RATES)
	p.add_argument("--engine", choices=ENGINES)
	p.add_argument("--fixture", help="manifest name or all")
	p.add_argument("--cpu-quota", type=float, help="core CPU quota, e.g. 0.75")
	p.add_argument("--seconds", type=float, default=130.0, help="recording per run (at least 60)")
	p.add_argument("--out", type=Path)
	p.add_argument("--replay", type=Path, metavar="OUT")
	p.add_argument("--self-test", action="store_true")
	p.add_argument("--proxy", action="store_true", help=argparse.SUPPRESS)
	args = p.parse_args()
	try:
		if args.proxy:
			proxy()
			return 0
		if args.self_test:
			self_test()
			return 0
		if args.replay is not None:
			return replay(args.replay)
		if args.rate is None or args.engine is None or args.fixture is None or args.out is None:
			p.error("--rate, --engine, --fixture and --out are required")
		if args.fixture != "all" and args.fixture not in manifest():
			p.error("unknown fixture")
		if args.cpu_quota is not None and not 0.05 <= args.cpu_quota <= 64:
			p.error("--cpu-quota must be within 0.05..64")
		if args.seconds < 60:
			p.error("--seconds must be at least 60 (byte rate is judged per minute)")
		signal.signal(signal.SIGINT, interrupted)
		signal.signal(signal.SIGTERM, interrupted)
		args.out.mkdir(parents=True, exist_ok=True)
		return acceptance(args)
	except InvalidRun as exc:
		print("invalid: " + str(exc), file=sys.stderr)
		return 2


if __name__ == "__main__":
	sys.exit(main())
