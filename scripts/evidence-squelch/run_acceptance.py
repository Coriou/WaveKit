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
# Stage-1 edge bias (verdict_events): half a squelch block.
EDGE_BIAS_S = 0.005
P99_TOLERANCE_MS = 2.0
# Loop meter (verdict_p99): one interval per EFFICIENCY_SAMPLE_MS (decoders/enablement/contract.ts)
# of 2 s; a tick may run late by the slack. At least P99_MIN_STEADY steady samples (polled each
# second, so about P99_MIN_STEADY / 2 intervals).
EFFICIENCY_SAMPLE_S = 2.0
P99_TICK_SLACK_S = 0.5
P99_MIN_STEADY = 10
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
# Overs both WebSocket recordings must fully cover; a close is announced after its hang, so
# an over counts as covered only CLOSE_ALLOWANCE_S after its end.
MIN_OVERS = 3
CLOSE_ALLOWANCE_S = 3.0
CLOCK_PORT = 3002
# The forwarder's wall-clock probe aligns host monotonic time with the containers' clock to
# within half its round trip; probes slower than this are not trusted.
CLOCK_MAX_RTT_S = 0.020
# Fixtures whose over has no carrier: the manual baseline may legitimately see no transmission.
CARRIERLESS = frozenset(("nfm-noise", "nfm-impulse"))
# LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS (amendment A8: NFM only); the self-test checks the
# contract. Other modulations in auto keep today's stage-1 auto squelch.
EVIDENCE_MODULATIONS = frozenset(("nfm",))
# The status rate (fractional, e.g. 2.048 Msps / 82 = 24 975.61 Hz) must match the WAV header
# rate (integer) within this.
RATE_MATCH_HZ = 1.0
# Drain close bound terms (see drain_per_over): the fake's send chunk (fake_rtl_tcp.py BLOCK),
# the core's squelch block (live-demodulator.ts LEVEL_BLOCK_SECONDS). The fake's pacing epoch
# comes with its own logged bracket (epochErrS); larger than this is not trusted.
FAKE_CHUNK_BYTES = 262_144
SQUELCH_BLOCK_S = 0.010
EPOCH_MAX_ERR_S = 0.005
# Clock-step check (clock_drift): allowed movement of the container wall clock beyond the
# measurement uncertainty, the longest gap between clock probes, and the fake's ts-after-elapsed
# read lag. Docker Desktop's VM clock drifts a few ms over a run; the measured drift is subtracted
# from the drain bound (close_lo), so 25 ms keeps such runs valid and only widens that bound.
CLOCK_DRIFT_MAX_S = 0.025
PROBE_GAP_MAX_S = 5.0
EMIT_LAG_S = 0.002
# Resampler: windowed-sinc low-pass at RESAMPLE_CUTOFF x REF_RATE, Blackman window spanning
# ±RESAMPLE_HALF_WIDTH output periods, fractional position quantised to 1/RESAMPLE_PHASES of an
# input sample (time error ≤ 1 / (2 x 512 x 24 975) s ≈ 39 ns). Symmetric kernel: zero delay.
RESAMPLE_CUTOFF = 0.45
RESAMPLE_HALF_WIDTH = 16
RESAMPLE_PHASES = 512
# Ungated (AM, amendment A8) auto runs are judged against the manual run as one stage-1 stream:
# a closed AM stage 1 is not exact zeros (the -80 dBFS hold through the fast AGC and DC block
# leaves a low-frequency residue near -29 dBFS on both runs), so played audio cannot be split
# into overs. The auto stream is located in the manual one by an exact match of a
# STAGE1_PROBE_S probe (or, failing that, a short probe within the LSB tolerance) within
# STAGE1_SEARCH_S of the arrival-time estimate, keeping the best-agreeing shift; then every sample
# must agree within STAGE1_LSB_TOLERANCE (AGC state after a block-different edge), and larger
# differences may only form clusters (merged across STAGE1_MERGE_S), at most one per over edge (the open and the close edge: auto and manual thresholds differ),
# each diverging inside that edge's window and only decaying after it. The content shift
# must also match the arrival-time shift (stage1_timing), so a playback delay cannot be aligned
# away. Evidence gating (a waiting gate mutes at least the 1 s voice window per over), a pre-roll
# delay or an interior mute breaks this. The search is bounded because the residue
# is periodic: an unbounded search could align a delayed over (am-voice 2.048 Msps csdr: the
# estimate was 323 samples, 13 ms, off the true shift).
STAGE1_PROBE_S = 0.05
STAGE1_PROBES = 8
STAGE1_SEARCH_S = 0.2
STAGE1_LSB_TOLERANCE = 1
STAGE1_MERGE_S = 0.1
# Difference tail past an edge window (verdict_stage1_identity): once both gates agree, the
# difference decays through the back chain's memory. Measured on the 2.048 Msps csdr am-voice
# close: a factor 0.607 per 10 ms block (tau 20.0 ms) for 13 consecutive blocks (19 664, 6 767,
# 1 493, 907, 551, 335, ... to within 1 LSB 165 ms after the divergence). 0.7 per block (tau
# 28 ms) leaves 40 % margin on tau. With a 32 767 peak the tail is at most 30 blocks (0.3 s).
STAGE1_TAIL_BLOCK_S = 0.010
STAGE1_TAIL_DECAY = 0.7
# Timing of the ungated stream (stage1_timing): latency-floor jitter between two runs (measured
# p1 minus min of the arrival latency envelope: 3.5 and 4.0 ms on the 2.048 Msps csdr am-voice
# runs), and the largest tolerance that still shows a 20 ms delay.
STAGE1_FLOOR_JITTER_S = 0.005
STAGE1_TIMING_TOL_MAX_S = 0.020
# Edge mapping (open_steps, stage1_edges). The AM golden does not correlate with the live
# chain's stream (scores 0.17-0.49 at inconsistent lags on 2.048 Msps csdr am-voice), so each
# over is placed by the stage-1 open step in the manual stream: hold residue peaking at 2 958,
# then 32 767. Arrival-anchor latency of that step ranged -68 to -17 ms over the 19 overs (the
# fake's chunked early delivery), hence the per-over placement. A difference cluster must start
# within the edge slack of a gate edge of either run: one 10 ms squelch block, one fake send
# chunk (event times are core wall stamps, which move against stream samples by the chunk
# phase: 64.0 ms at 2.048 Msps, 54.6 ms at 2.4 Msps; measured 30 ms on am-voice) and
# STAGE1_EDGE_MAP_ERR_S for ms timestamps and the step sample: 84 ms at 2.048 Msps. At most one
# cluster per over edge. An interior mute (a waiting gate mutes 1 s) starts far from any edge.
STEP_MIN_ABS = 16_384
STEP_QUIET_ABS = 8_192
STEP_QUIET_S = 0.05
STEP_EARLY_S = 0.2
# Rise allowance: 5 ms, the fast AGC attack the design quotes; live am-voice rose in one sample
# (850 to 32 767) and the analyzer's am-carrier and am-voice goldens in one 10 ms block. Shorter
# than STAGE1_EDGE_MAP_ERR_S, so a ramp's crossing still places the edge within the map error.
STEP_RISE_S = 0.005
STAGE1_EDGE_MAP_ERR_S = 0.010


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


def verdict_opened(expect_open, runs):
	opened = len(runs) > 0
	return None if opened == expect_open else f"opened={opened}, expected open={expect_open}"


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
	"""The source timeline of one run on the containers' shared wall clock: when the fake
	started sending the file (its `connected` event), where the over sits in the file and how
	long it is (fixture sidecar), the file period, and host-monotonic to wall from the
	forwarder's clock probe with the smallest round trip. Transmission events are not used to
	align clocks: the core announces them late on purpose (qualification and hang). Missing
	evidence is an invalid run."""
	src = side.get("source")
	if not isinstance(src, dict) or not _number(src.get("epochTs")) or not _number(src.get("epochErrS")):
		raise InvalidRun("missing source clock (fake rtl_tcp pacing epoch on its connected event)")
	if not 0 <= src["epochErrS"] <= EPOCH_MAX_ERR_S:
		raise InvalidRun("fake rtl_tcp pacing epoch bracket too wide")
	if src.get("connections") != 1:
		raise InvalidRun("fake rtl_tcp saw more than one connection (source clock ambiguous)")
	if not isinstance(fixture, dict) or not all(_number(fixture.get(k)) for k in ("overOnsetS", "periodS", "overS")):
		raise InvalidRun("missing fixture sidecar onset, length or period")
	if fixture["periodS"] <= 0 or fixture["overS"] <= 0:
		raise InvalidRun("invalid fixture period")
	probes = []
	for probe in side.get("clockProbes") or []:
		if isinstance(probe, (list, tuple)) and len(probe) == 3 and all(_number(v) for v in probe) and probe[1] >= probe[0]:
			m0, m1, wall = probe
			probes.append((m1 - m0, wall - (m0 + m1) / 2, m0))
	if not probes:
		raise InvalidRun("missing clock probe (host monotonic to container wall clock)")
	good = sorted((m0, rtt, off) for rtt, off, m0 in probes if rtt <= CLOCK_MAX_RTT_S)
	if not good:
		raise InvalidRun(f"every clock probe round trip exceeds {CLOCK_MAX_RTT_S * 1000:.0f} ms")
	rtt, to_wall, _m0 = min(probes)
	drift = clock_drift(good, rtt, to_wall, src, src.get("progress"))
	return {"connected": float(src["epochTs"]), "epochErr": float(src["epochErrS"]), "driftS": drift, "onset": float(fixture["overOnsetS"]),
		"period": float(fixture["periodS"]), "overS": float(fixture["overS"]), "toWall": to_wall, "rttS": rtt,
		"iqRate": fixture.get("rate")}


def clock_drift(good, rtt, to_wall, src, progress):
	"""Largest observed movement of the container wall clock over the run, or an invalid run.

	Probes: every low-RTT probe's host-to-container offset must agree with the best one within
	CLOCK_DRIFT_MAX_S beyond both half round trips, and consecutive ones may be at most
	PROBE_GAP_MAX_S apart. Fake progress: wall ts minus (epochTs + monotonic elapsedS) must stay
	within CLOCK_DRIFT_MAX_S beyond the epoch bracket, the ts rounding (0.5 ms) and EMIT_LAG_S
	(ts is read after elapsed). A wall step shows in both. Returns the raw maximum deviation
	(probe offset spread and progress step), which close_lo subtracts."""
	if len(good) < 2 or any(b[0] - a[0] > PROBE_GAP_MAX_S for a, b in zip(good, good[1:])):
		raise InvalidRun(f"clock probes do not cover the run (need one per {PROBE_GAP_MAX_S:.0f} s)")
	spread = 0.0
	for _m0, r, off in good:
		dev = abs(off - to_wall)
		if dev - (r + rtt) / 2 > CLOCK_DRIFT_MAX_S:
			raise InvalidRun(f"container wall clock moved {dev * 1000:.1f} ms during the run (clock step or drift)")
		spread = max(spread, dev)
	if not isinstance(progress, list) or not progress:
		raise InvalidRun("missing fake rtl_tcp progress (wall vs paced elapsed) for the clock-step check")
	step_max = 0.0
	slack = float(src["epochErrS"]) + 0.0005
	for item in progress:
		if not (isinstance(item, (list, tuple)) and len(item) == 2 and all(_number(v) for v in item)):
			raise InvalidRun("malformed fake rtl_tcp progress")
		step = item[0] - (float(src["epochTs"]) + item[1])
		if not -slack - CLOCK_DRIFT_MAX_S <= step <= slack + EMIT_LAG_S + CLOCK_DRIFT_MAX_S:
			raise InvalidRun(f"fake wall clock stepped {step * 1000:.1f} ms against its paced elapsed time")
		step_max = max(step_max, abs(step))
	return max(spread, step_max)


def over_at(clock, wall):
	"""(index, source onset wall time) of the over a wall time belongs to."""
	k = math.floor((wall - clock["connected"] - clock["onset"] + ASSOC_SLACK_S) / clock["period"])
	return k, clock["connected"] + clock["onset"] + k * clock["period"]


def complete_overs(start_mono, end_mono, clock, tail_s):
	"""Overs whose onset is at least ASSOC_SLACK_S after the start of a recording and whose end
	plus tail_s is inside it (boundary overs are genuinely incomplete and excluded)."""
	base = clock["connected"] + clock["onset"]
	start, end = start_mono + clock["toWall"], end_mono + clock["toWall"]
	first = math.ceil((start + ASSOC_SLACK_S - base) / clock["period"])
	last = math.floor((end - clock["overS"] - tail_s - base) / clock["period"])
	return set(range(max(0, first), last + 1))


def arrival_time(arrivals, byte_index):
	"""Host-monotonic arrival of the chunk holding byte_index; arrivals are (mono, cumulative)."""
	totals = [b for _t, b in arrivals]
	i = bisect_left(totals, byte_index + 1)
	return arrivals[i][0] if i < len(arrivals) else None


def played_overs(side, runs, clock, rate):
	"""Evidence-gated (NFM) auto run. Per played run: its over, the stage-1 start (event
	startedAt) after the source onset and the delay of its first and last sample behind the
	source. Returns (overs, early): a run whose first sample arrives before the first over's
	onset (over index < 0: only pre-over noise has been received) is returned in `early` as
	played audio without evidence, a failure for the caller. Every other played run must have a
	recorded stage-1 transmission starting at its over, else the run is invalid."""
	starts = sorted(parse_iso(e["startedAt"]) for e in side.get("transmissions", [])
		if isinstance(e.get("startedAt"), str))
	out, early = [], []
	for s, e in runs:
		first = arrival_time(side["arrivals"], int(s * rate / REF_RATE) * 2)
		last = arrival_time(side["arrivals"], int((e - 1) * rate / REF_RATE) * 2)
		if first is None or last is None:
			raise InvalidRun("played sample without an arrival time")
		w_first, w_last = first + clock["toWall"], last + clock["toWall"]
		k, onset = over_at(clock, w_first)
		if k < 0:
			early.append({"startS": w_first - clock["connected"], "lengthS": (e - s) / REF_RATE,
				"firstOnsetS": clock["onset"]})
			continue
		stage1 = [t for t in starts if onset - ASSOC_SLACK_S <= t <= onset + MAX_DELAY_S]
		if not stage1:
			raise InvalidRun(f"no stage-1 transmission recorded for played over {k}")
		out.append({"over": k, "stage1S": stage1[0] - onset, "startS": w_first - onset,
			"endS": w_last - (onset + (e - 1 - s) / REF_RATE)})
	return out, early


def verdict_early(early):
	"""Evidence-gated run: audio played before the first over's onset was let through on
	pre-over noise, a failure of "never opens without evidence" (requirement 1.4)."""
	if not early:
		return None
	first = early[0]
	return (f"played {len(early)} run(s) before the first over without evidence (never opens without"
		f" evidence): first at {first['startS']:.3f} s after connect, {first['lengthS']:.3f} s long,"
		f" first over onset {first['firstOnsetS']:.3f} s")


def stream_anchor(side, clock):
	"""Arrival-time position of a stream on its source clock: min over reads of (read time
	minus the samples received so far / rate), in s after the fake's pacing epoch. That is the
	source time of the stream's first sample plus the stream's latency floor. Host time is
	mapped by the low-RTT clock probe nearest the pacing epoch: the source schedule is the epoch
	plus monotonic elapsed time, so later wall-clock drift does not move it. Returns (anchor,
	error) with error = that probe's half round trip."""
	arrivals = side.get("arrivals") or []
	rate = side.get("audioRate")
	if not arrivals or not _number(rate) or rate <= 0:
		raise InvalidRun("no stream arrivals to time the ungated stage-1 stream")
	epoch_host = clock["connected"] - clock["toWall"]
	near = []
	for probe in side.get("clockProbes") or []:
		if isinstance(probe, (list, tuple)) and len(probe) == 3 and all(_number(v) for v in probe):
			m0, m1, wall = probe
			if 0 <= m1 - m0 <= CLOCK_MAX_RTT_S:
				near.append((abs((m0 + m1) / 2 - epoch_host), (m1 - m0) / 2, wall - (m0 + m1) / 2))
	if not near:
		raise InvalidRun("no low round-trip clock probe to time the ungated stage-1 stream")
	dist, err, to_wall = min(near)
	if dist > PROBE_GAP_MAX_S:
		raise InvalidRun(f"nearest clock probe is {dist:.1f} s from the pacing epoch (limit {PROBE_GAP_MAX_S:.0f} s)")
	anchor = min(t + to_wall - clock["connected"] - (b / 2) / rate for t, b in arrivals)
	return anchor, err


def stage1_timing(auto, manual, clocks):
	"""Expected auto-to-manual sample shift from arrival times alone, and its tolerance.

	A same-source sample sits at auto index i and manual index i + shift with
	shift = (anchorAuto - anchorManual) x rate when both streams have the same latency floor
	(no pre-roll on either). A playback delay d on auto raises anchorAuto by d, so the content
	shift then misses this estimate by d. Tolerance, all measured per run:
	  STAGE1_FLOOR_JITTER_S (latency-floor jitter between runs) + both probes' half round trips
	  + both pacing-epoch brackets (epochErrS).
	2.048 Msps csdr am-voice: 5 + 0.7 + 0.8 + 0 + 0 = 6.5 ms; the estimate missed the content
	shift by 0.66 ms. More than STAGE1_TIMING_TOL_MAX_S is invalid (a 20 ms delay must show)."""
	a, ea = stream_anchor(auto, clocks["auto"])
	m, em = stream_anchor(manual, clocks["manual"])
	tol = STAGE1_FLOOR_JITTER_S + ea + em + clocks["auto"]["epochErr"] + clocks["manual"]["epochErr"]
	if tol > STAGE1_TIMING_TOL_MAX_S:
		raise InvalidRun(f"stage-1 timing tolerance {tol * 1000:.1f} ms exceeds {STAGE1_TIMING_TOL_MAX_S * 1000:.0f} ms")
	return {"autoAnchorS": a, "manualAnchorS": m, "expectedShiftS": a - m, "tolS": tol}


def _pcm16(raw):
	from array import array

	out = array("h")
	out.frombytes(bytes(raw[: len(raw) // 2 * 2]))
	if sys.byteorder != "little":
		out.byteswap()
	return out


def open_steps(manual_pcm, manual, clock, anchor):
	"""{over: (manual sample index, source open time)} of the stage-1 open as the manual stream
	renders it. While closed the AM chain plays the hold residue (peak about -21 dBFS); the first
	open block arrives with the AGC at full gain and clips. The step is the first sample at least
	STEP_MIN_ABS reached within STEP_RISE_S of the end of a STEP_QUIET_S run with no sample of
	STEP_QUIET_ABS (a finite rise time is allowed; its crossing lies within the edge map error),
	searched from
	STEP_EARLY_S before to MAX_DELAY_S after the open's source time on the arrival anchor (the
	fake sends IQ up to one chunk early). Each over's edges are placed from its own step."""
	x, rate = _pcm16(manual_pcm), manual["audioRate"]
	quiet, rise = int(STEP_QUIET_S * rate), max(1, int(STEP_RISE_S * rate))
	out = {}
	for e in manual.get("transmissions", []):
		if e.get("state") != "closed" or not isinstance(e.get("startedAt"), str):
			continue
		rel = parse_iso(e["startedAt"]) - clock["connected"]
		k = math.floor((rel - clock["onset"] + ASSOC_SLACK_S) / clock["period"])
		lo = int((rel - anchor - STEP_EARLY_S) * rate)
		hi = int((rel - anchor + MAX_DELAY_S) * rate)
		if lo < quiet or hi > len(x):
			continue  # the open is outside the recording
		# runs[j]: consecutive quiet samples ending just before sample (lo - quiet - rise + j).
		base = lo - quiet - rise
		if base < 0:
			continue
		runs, run = [], 0
		for i in range(base, hi):
			runs.append(run)
			v = x[i]
			run = 0 if v >= STEP_QUIET_ABS or v <= -STEP_QUIET_ABS else run + 1
		for i in range(lo, hi):
			v = x[i]
			if v >= STEP_MIN_ABS or v <= -STEP_MIN_ABS:
				# A quiet run ends at most `rise` samples before the crossing (finite rise time).
				if any(runs[j - base] >= quiet for j in range(i - rise, i + 1)):
					out[k] = (i, rel)
					break
		else:
			raise InvalidRun(f"over {k}: stage-1 open step not found in the manual AM stream")
	if len(out) < MIN_OVERS:
		raise InvalidRun(f"{len(out)} stage-1 open steps in the manual AM stream, need {MIN_OVERS}")
	return out


def stage1_edges(sides, clocks, steps, rate, hang_s):
	"""Stage-1 gate edges of both runs as (manual sample index, over, kind): open at startedAt,
	close at startedAt + durationMs + hang, each placed from its over's open step in the manual
	stream by its source-time offset from the manual open (each run on its own source clock;
	both fakes replay the same file from their epoch). Overs without a step are not placed."""
	out = []
	for side, clock in zip(sides, clocks):
		for e in side.get("transmissions", []):
			if e.get("state") != "closed" or not isinstance(e.get("startedAt"), str) or not _number(e.get("durationMs")):
				continue
			rel = parse_iso(e["startedAt"]) - clock["connected"]
			k = math.floor((rel - clock["onset"] + ASSOC_SLACK_S) / clock["period"])
			if k not in steps:
				continue
			j, ref = steps[k]
			for t, kind in ((rel, "open"), (rel + e["durationMs"] / 1000 + hang_s, "close")):
				out.append((j + round((t - ref) * rate), k, kind))
	return out


def verdict_stage1_identity(auto_pcm, manual_pcm, rate, timing, edges, slack_s, period_s, min_periods=MIN_OVERS):
	"""Ungated (AM, A8) auto run against the manual run: the same stage-1 stream at the same
	time (see STAGE1_* above). auto_pcm and manual_pcm are raw s16le bytes; timing is
	stage1_timing(); edges are stage1_edges() in auto samples. Returns (failure or None, notes)."""
	a, m = _pcm16(auto_pcm), _pcm16(manual_pcm)
	estimate = round(timing["expectedShiftS"] * rate)
	probe_n, search = max(1, int(STAGE1_PROBE_S * rate)), int(STAGE1_SEARCH_S * rate)
	tol = STAGE1_LSB_TOLERANCE
	mb = m.tobytes()
	probes = [p for p in range(0, max(0, len(a) - probe_n), max(1, int(2 * rate)))
		if len(set(a[p : p + probe_n])) > 2]  # a flat (muted) probe matches anywhere
	candidates = set()
	for p in probes[:STAGE1_PROBES]:
		needle = a[p : p + probe_n].tobytes()
		lo, hi = max(0, p + estimate - search), min(len(m), p + estimate + search + probe_n)
		at = mb.find(needle, 2 * lo, 2 * hi)
		while at >= 0:
			if at % 2 == 0:
				candidates.add(at // 2 - p)
			at = mb.find(needle, at + 1, 2 * hi)
	if not candidates:  # ±1 LSB differences everywhere: a short probe within tolerance
		short = min(probe_n, 64)
		for p in probes[:4]:
			probe = a[p : p + short]
			for d in range(estimate - search, estimate + search + 1):
				j = p + d
				if j < 0 or j + short > len(m):
					continue
				if all(-tol <= x - y <= tol for x, y in zip(probe, m[j : j + short])):
					candidates.add(d)

	def agreement(d):
		lo, hi = max(0, -d), min(len(a), len(m) - d)
		idx = range(lo, hi, 97)
		return sum(1 for i in idx if -tol <= a[i] - m[i + d] <= tol) / max(1, len(idx))

	# A periodic residue matches one residue period apart too: keep the best-agreeing shift.
	scored = sorted(((agreement(d), -abs(d - estimate), d) for d in candidates), reverse=True)
	if not scored or scored[0][0] < 0.5:
		return "auto stream never equals the manual stage-1 stream (evidence-gated or delayed on an ungated modulation)", {}
	shift = scored[0][2]
	# Content alignment alone would absorb a playback delay: the arrival times must agree too.
	late = timing["expectedShiftS"] - shift / rate
	notes = {"shiftSamples": shift, "expectedShiftSamples": timing["expectedShiftS"] * rate,
		"autoLaterMs": late * 1000, "timingTolMs": timing["tolS"] * 1000}
	if abs(late) > timing["tolS"]:
		return (f"auto plays {abs(late) * 1000:.1f} ms {'later' if late > 0 else 'earlier'} than the manual stage-1"
			f" stream (arrival-time tolerance {timing['tolS'] * 1000:.1f} ms)"), notes
	start, end = max(0, -shift), min(len(a), len(m) - shift)
	overlap_s = (end - start) / rate
	if overlap_s < min_periods * period_s:
		raise InvalidRun(f"auto and manual streams overlap {overlap_s:.1f} s, need {min_periods} periods")
	merge = int(STAGE1_MERGE_S * rate)
	clusters, lsb = [], 0
	for i in range(start, end):
		d = a[i] - m[i + shift]
		if d == 0:
			continue
		if -tol <= d <= tol:
			lsb += 1
			continue
		if clusters and i - clusters[-1][1] <= merge:
			clusters[-1][1] = i
		else:
			clusters.append([i, i])
	longest = max(((e - s + 1) / rate for s, e in clusters), default=0.0)
	notes.update({"overlapS": overlap_s, "lsbDiffs": lsb, "edgeClusters": len(clusters), "longestClusterS": longest})
	slack = slack_s * rate
	# One window per over edge: from the earlier of the two runs' own edge stamps minus the
	# slack to the later plus the slack (manual sample indices).
	windows = {}
	for i, k, kind in edges:
		lo, hi = windows.get((k, kind), (i, i))
		windows[(k, kind)] = (min(lo, i), max(hi, i))
	windows = {key: (lo - slack, hi + slack) for key, (lo, hi) in windows.items()}
	block = max(1, int(STAGE1_TAIL_BLOCK_S * rate))
	claimed, offsets, tails = {}, [], []
	notes.update({"edgeOffsetsMs": offsets, "tailBlocks": tails})
	for s, e in clusters:
		# The two gates first disagree at a gate edge of either run: the whole divergence (the
		# cluster's start and its largest difference) lies inside that edge's window. Auto
		# sample s is manual sample s + shift.
		ms, me = s + shift, e + shift
		inside = sorted((abs(ms - (lo + hi) / 2), key, lo, hi) for key, (lo, hi) in windows.items() if lo <= ms <= hi)
		if not inside:
			return (f"auto differs from the manual stage-1 stream at {s / rate:.3f} s into the auto stream,"
				f" not within {slack_s * 1000:.0f} ms of a stage-1 edge (interior mute)"), notes
		_d, (k, kind), lo, hi = inside[0]
		offsets.append(round((ms - (lo + hi) / 2) / rate * 1000, 2))
		if (k, kind) in claimed:
			return f"more than one difference at the over {k} {kind} edge (at {claimed[(k, kind)] / rate:.3f} s and {s / rate:.3f} s)", notes
		claimed[(k, kind)] = s
		stop = min(me, int(hi))
		peak = max(abs(a[i - shift] - m[i]) for i in range(ms, stop + 1))
		# Past the window both gates agree, and the difference only decays through the back
		# chain's memory: each STAGE1_TAIL_BLOCK_S block's largest difference stays under
		# peak x STAGE1_TAIL_DECAY^(n + 1) + LSB tolerance. A mute or any new difference does not.
		n = 0
		for b in range(stop + 1, me + 1, block):
			top = max(abs(a[i - shift] - m[i]) for i in range(b, min(me + 1, b + block)))
			bound = peak * STAGE1_TAIL_DECAY ** (n + 1) + tol
			if top > bound:
				return (f"auto differs from the manual stage-1 stream {(b - hi) / rate * 1000:.0f} ms after the over {k} {kind}"
					f" edge window by {top} (decaying bound {bound:.0f} from {peak}): not a stage-1 edge difference"), notes
			n += 1
		tails.append(n)
	return None, notes


def verdict_playback(overs, eligible):
	"""Every complete source over in the stream recording is played exactly once."""
	if not eligible:
		raise InvalidRun("stream recording covers no complete over")
	played = [o["over"] for o in overs]
	missing = sorted(eligible - set(played))
	if missing:
		return f"no playback for complete overs {missing} of {len(eligible)}"
	twice = sorted({k for k in played if played.count(k) > 1})
	return f"overs {twice} played as more than one run" if twice else None


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


def verdict_auto_state(statuses, squelch_mode, modulation, expect_open):
	"""Evidence squelch is NFM only (A8): `off` on AM and on manual runs; `waiting`/`open` on NFM
	auto runs, reaching `open` exactly when the fixture is expected to open."""
	states = [s["autoSquelch"].get("state") for _t, s in statuses
		if isinstance(s, dict) and isinstance(s.get("autoSquelch"), dict)]
	if not states:
		raise InvalidRun(f"no autoSquelch state in {squelch_mode} status samples")
	seen = set(states)
	if squelch_mode != "auto" or modulation not in EVIDENCE_MODULATIONS:
		return None if seen == {"off"} else f"autoSquelch {sorted(seen)} on {modulation} {squelch_mode}, want off"
	if seen - {"waiting", "open"}:
		return f"autoSquelch {sorted(seen)} on nfm auto, want waiting/open"
	if expect_open != ("open" in seen):
		return f"autoSquelch {'never' if expect_open else 'did'} open on nfm auto"
	return None


def event_edges(events, clock):
	"""{over: [(open, close), ...]} of completed transmissions, seconds after the source onset
	of their over, from each event's startedAt (not its late announcement)."""
	out = {}
	for e in events:
		if e.get("state") != "closed" or not _number(e.get("durationMs")):
			continue
		start = parse_iso(e.get("startedAt"))
		k, onset = over_at(clock, start)
		out.setdefault(k, []).append((start - onset, start - onset + e["durationMs"] / 1000))
	return out


def ws_overs(side, clock):
	span = side.get("wsSpan")
	if not isinstance(span, (list, tuple)) or len(span) != 2 or not all(_number(v) for v in span):
		raise InvalidRun("missing websocket recording span")
	return complete_overs(span[0], span[1], clock, CLOSE_ALLOWANCE_S)


def verdict_events(auto, manual, auto_clock, manual_clock, carrier, jitter_s):
	"""Transmissions over the overs both WebSocket recordings fully cover, each run on its own
	source clock: the same transmissions per over, at least one per over on carrier-bearing
	fixtures, and edges that match within the stamp physics (requirement 1.6: stage-1 open and
	close times as today; 8.2 checks them against the manual run).

	An edge's startedAt is the core's wall clock when Node handles the squelch edge, not a
	sample-derived time. Its offset from the source onset carries the fake's chunk phase (-55 to
	+6 ms over the 19 overs, the same pattern in every run: both fakes replay the same file from
	their epoch), which cancels between the runs. What does not cancel: the two thresholds may
	cross the carrier in adjacent 10 ms blocks, and each stamp is late by that run's event-loop
	delay. Per over, |auto - manual| <= EVENT_TOLERANCE_S + jitter_s, where jitter_s is the sum of
	both runs' median steady interval p99 loop delay (2.048 Msps csdr: 10 + 12.7 + 12.7 = 35 ms).
	A gate that delays stage-1 events shows as a bias, so the median of auto - manual over all
	compared overs must stay within EDGE_BIAS_S (half a block), for opens and for closes. Returns (failure or None, notes)."""
	common = ws_overs(auto, auto_clock) & ws_overs(manual, manual_clock)
	if len(common) < MIN_OVERS:
		raise InvalidRun(f"recordings share {len(common)} complete overs, need {MIN_OVERS}")
	a, m = event_edges(auto["transmissions"], auto_clock), event_edges(manual["transmissions"], manual_clock)
	limit = EVENT_TOLERANCE_S + jitter_s
	opens, closes = [], []
	notes = {"edgeLimitMs": limit * 1000, "edgeBiasLimitMs": EDGE_BIAS_S * 1000}
	worst = None
	for k in sorted(common):
		la, lm = a.get(k, []), m.get(k, [])
		if carrier and (not la or not lm):
			return f"no completed transmission in over {k}: auto {len(la)} manual {len(lm)}", notes
		if len(la) != len(lm):
			return f"transmission count differs in over {k}: auto {len(la)} manual {len(lm)}", notes
		for (ao, ac), (mo, mc) in zip(la, lm):
			opens.append(ao - mo)
			closes.append(ac - mc)
			d = max(abs(ao - mo), abs(ac - mc))
			if worst is None or d > worst[0]:
				worst = (d, k, ao, ac, mo, mc)
	if worst is not None:
		notes["edgeMaxMs"] = worst[0] * 1000
		if worst[0] > limit:
			_d, k, ao, ac, mo, mc = worst
			return (f"transmission edges differ in over {k}: auto {ao:.3f}-{ac:.3f} manual {mo:.3f}-{mc:.3f}"
				f" (limit {limit * 1000:.1f} ms: one block + both runs' median steady loop p99)"), notes

	def median(values):
		v = sorted(values)
		return (v[len(v) // 2] + v[(len(v) - 1) // 2]) / 2

	for kind, values in (("open", opens), ("close", closes)):
		if values:
			bias = median(values)
			notes[f"{kind}BiasMs"] = bias * 1000
			if abs(bias) > EDGE_BIAS_S:
				return (f"auto stage-1 {kind}s are {abs(bias) * 1000:.1f} ms {'later' if bias > 0 else 'earlier'} than manual"
					f" in the median of {len(values)} overs (limit {EDGE_BIAS_S * 1000:.0f} ms)"), notes
	return None, notes


def p99_series(side, clock):
	"""(poll host time, p99 ms) of each loop-meter sample. New recordings carry p99Samples
	[[mono, intervals10m, p99Ms, maxMs], ...]; older ones carry p99Ms, one per status sample
	(the same poll iteration appends the status first), so they pair with the status times only
	when the counts agree."""
	samples = side.get("p99Samples")
	if samples is not None:
		out = [(s[0], s[2]) for s in samples if isinstance(s, (list, tuple)) and len(s) >= 3 and _number(s[0]) and _number(s[2])]
		if len(out) != len(samples):
			raise InvalidRun("malformed loop-meter samples")
		return out
	values, status = side.get("p99Ms") or [], side.get("status") or []
	if values and len(values) != len(status):
		raise InvalidRun(f"{len(values)} p99 samples for {len(status)} status polls: cannot time them")
	return [(t, v) for (t, _s), v in zip(status, values) if _number(t) and _number(v)]


def steady_p99(side, clock):
	"""Split one run's loop-meter samples at the settle point: the source's first over onset
	(sidecar) on the host clock. Live audio starts about 0.8-1.0 s after the fake's epoch
	(stream anchors 0.77-0.96 s), before that onset, and the first over is also where stage 1
	first opens (the gate's first-run code paths). The meter takes one interval per
	EFFICIENCY_SAMPLE_S and the poll reports the latest, so a sample polled at t covers no
	earlier than t - 2 x EFFICIENCY_SAMPLE_S - P99_TICK_SLACK_S: it is steady when that is at or
	after the settle point. Returns (steady values, startup values)."""
	settle = clock["connected"] + clock["onset"] - clock["toWall"]
	cover = 2 * EFFICIENCY_SAMPLE_S + P99_TICK_SLACK_S
	steady, startup = [], []
	for t, v in p99_series(side, clock):
		(steady if t - cover >= settle else startup).append(v)
	return steady, startup


def verdict_p99(auto, manual, clocks):
	"""Requirement 6.1 at steady state (design amendment 2026-10-23): median(auto steady p99) -
	median(manual steady p99) <= P99_TOLERANCE_MS. Single 2 s intervals carry host noise (the
	ungated am-voice, identical code in both modes, showed a 7.7 ms gap in the maxima), so the
	median measures the gate's added steady delay. Polls see each interval about twice, which
	leaves the median of the intervals unchanged. Steady p90 and max and the startup intervals are
	reported only. Returns (failure or None, notes)."""
	a, a0 = steady_p99(auto, clocks["auto"])
	m, m0 = steady_p99(manual, clocks["manual"])
	notes = {"startupMs": {"auto": sorted(set(a0), key=a0.index), "manual": sorted(set(m0), key=m0.index)},
		"steadySamples": [len(a), len(m)]}
	if not a and not a0 or not m and not m0:
		return "missing event-loop p99 samples", notes
	if min(len(a), len(m)) < P99_MIN_STEADY:
		raise InvalidRun(f"{min(len(a), len(m))} steady loop-meter samples, need {P99_MIN_STEADY}")
	def q(values, f):
		v = sorted(values)
		return v[min(len(v) - 1, int(f * len(v)))]

	notes.update({"autoSteadyMaxMs": max(a), "manualSteadyMaxMs": max(m),
		"steadyMedianMs": [q(a, 0.5), q(m, 0.5)], "steadyP90Ms": [q(a, 0.9), q(m, 0.9)]})
	med_a, med_m = q(a, 0.5), q(m, 0.5)
	if med_a - med_m > P99_TOLERANCE_MS:
		return f"steady median event-loop p99 {med_a:.2f} ms vs manual {med_m:.2f} ms (limit +{P99_TOLERANCE_MS} ms)", notes
	return None, notes


def drain_per_over(samples, rate, arrivals, events, levels, clock, hang_s, carrier, ws_complete):
	"""Manual run: per over, the back-chain drain as an interval [lowerMs, upperMs] that holds
	the true drain (arrival of the last audible stream sample minus the stage-1 close).

	Close, lower bound (so upperMs can only over-estimate), on the container wall clock:
	  carrier_off + hang - SQUELCH_BLOCK_S - chunk_s - epoch_err - drift
	  - carrier_off: sidecar over end on the source clock (the fake's pacing epoch, the exact
	    instant its byte schedule is computed from, + onset + k x period). epoch_err is the
	    logged half-width of the two wall reads bracketing that monotonic read (epochErrS).
	    carrier_off extrapolates wall time from that epoch, so drift (clock_drift: the largest
	    wall-clock movement seen by the probes and the fake's progress) is subtracted too.
	  - hang runs from the last qualifying 10 ms squelch block (channel-squelch.ts), which
	    starts no earlier than one block before carrier-off: SQUELCH_BLOCK_S = 10 ms.
	  - the fake sends BLOCK-byte chunks at their starting source time, so IQ arrives up to
	    chunk_s = 262 144 / (2 x rate) early (64.0 ms at 2.048 Msps, 54.6 ms at 2.4 Msps).
	Close, upper bound (so lowerMs can only under-estimate): the first `live-audio:level`
	receipt with squelchOpen false after the lower bound (an observation of the closed gate).
	Host times map to the container clock with the probe's half round trip as error in either
	direction: upperMs (host tail minus container close) adds it; lowerMs (host minus host)
	needs none. Arrival of the tail is the read that
	returned the last audible byte (late, never early). endedAt is informational only.

	One squelch close per over; another close reason, a second close, a closed over without an
	open level then a closed level, or (carrier-bearing) without a played tail is invalid.
	Measured over the overs the stream and the WebSocket both fully cover."""
	if not _number(clock.get("iqRate")) or clock["iqRate"] <= 0:
		raise InvalidRun("missing fixture IQ rate (sidecar) for the chunk bound")
	chunk_s = FAKE_CHUNK_BYTES / (2 * clock["iqRate"])
	err = clock["rttS"] / 2
	closes = {}
	for e in events:
		if e.get("state") != "closed":
			continue
		k, onset = over_at(clock, parse_iso(e.get("startedAt")))
		if e.get("closeReason") != "squelch":
			raise InvalidRun(f"over {k}: unsupported close reason for drain (want squelch)")
		if k in closes:
			raise InvalidRun(f"over {k}: more than one close (merged or split transmission)")
		carrier_off = onset + clock["overS"]
		ended = parse_iso(e["endedAt"]) - carrier_off if isinstance(e.get("endedAt"), str) else None
		closes[k] = (carrier_off, ended)
	observed = sorted((t + clock["toWall"], bool(d.get("squelchOpen"))) for t, d in levels
		if _number(t) and isinstance(d, dict) and isinstance(d.get("squelchOpen"), bool))
	tails = {}
	for s, e in nonzero_runs(samples, rate):
		first = arrival_time(arrivals, s * 2)
		last = arrival_time(arrivals, (e - 1) * 2)
		if first is None or last is None:
			raise InvalidRun("played sample without an arrival time")
		k, _onset = over_at(clock, first + clock["toWall"])
		tails[k] = max(tails.get(k, -math.inf), last + clock["toWall"])
	eligible = complete_overs(arrivals[0][0], arrivals[-1][0], clock, MAX_DELAY_S) if arrivals else set()
	out = []
	for k in sorted(eligible & ws_complete & set(closes)):  # boundary overs may be cut short
		if k not in tails:
			if carrier:
				raise InvalidRun(f"over {k}: stage-1 closed but no played tail to measure drain on")
			continue
		carrier_off, ended = closes[k]
		close_lo = carrier_off + hang_s - SQUELCH_BLOCK_S - chunk_s - clock["epochErr"] - clock["driftS"]
		was_open = any(v for t, v in observed if carrier_off - clock["overS"] <= t <= close_lo)
		closed_at = next((t for t, v in observed if t >= close_lo and not v), None)
		if not was_open or closed_at is None or closed_at > carrier_off + clock["period"] - clock["overS"]:
			raise InvalidRun(f"over {k}: no observed stage-1 close (open then closed level) to bound the drain")
		# Tail and level receipt are both host times: the probe error cancels in lowerMs.
		out.append({"over": k, "lowerMs": (tails[k] - closed_at) * 1000,
			"upperMs": (tails[k] - close_lo + err) * 1000,
			"endedAfterCarrierOffMs": None if ended is None else ended * 1000})
	return out


def verdict_drain(per_over, guard_ms):
	"""Drain intervals against CLOSE_GUARD_MS, flagged on the upper bound: (flag or None, summary)."""
	if not per_over:
		return None, None

	def stats(key):
		values = sorted(o[key] for o in per_over)
		mid = len(values) // 2
		return values[-1], values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2

	upper_max, upper_median = stats("upperMs")
	lower_max, lower_median = stats("lowerMs")
	summary = {"maxMs": upper_max, "medianMs": upper_median, "lowerMaxMs": lower_max, "lowerMedianMs": lower_median,
		"overs": len(per_over), "guardMs": guard_ms, "exceedsGuard": upper_max > guard_ms, "perOver": per_over}
	flag = (f"back-chain drain upper bound max {upper_max:.0f} ms (median {upper_median:.0f} ms; lower max"
		f" {lower_max:.0f} ms) > CLOSE_GUARD_MS {guard_ms}")
	return (flag if upper_max > guard_ms else None), summary


def expects_open(modulation, expect):
	"""AM is not evidence-gated (A8): stage-1 auto squelch opens on the carrier and passes audio
	for am-voice and am-carrier alike. NFM follows the manifest."""
	return modulation not in EVIDENCE_MODULATIONS or expect != "none"


def evaluate(obs, guard_ms):
	"""All verdicts of one fixture from its recorded observations."""
	failures, notes = [], {}
	auto, manual = obs["auto"], obs["manual"]
	modulation = obs["mode"]
	clocks = {mode: source_clock(obs[mode], obs[mode].get("fixture")) for mode in ("auto", "manual")}
	notes["clockRttMs"] = [clocks[m]["rttS"] * 1000 for m in ("auto", "manual")]
	expect_open = expects_open(modulation, obs["expect"])
	rate = auto["audioRate"]
	byte_rate = rate * 2
	runs = nonzero_runs(auto["samples8k"], REF_RATE)
	if f := verdict_opened(expect_open, runs):
		failures.append(f)
	for mode in ("auto", "manual"):
		if f := verdict_auto_state(obs[mode].get("status", []), mode, modulation, expect_open):
			failures.append(f)
	gated = modulation in EVIDENCE_MODULATIONS
	if not gated:
		# A8: auto is today's stage-1 auto squelch, judged as one stream against the manual
		# stage-1 run; a closed AM stage 1 is not exact silence, so there are no overs to split.
		for mode in ("auto", "manual"):
			raw = obs[mode].get("pcm")
			if not isinstance(raw, (bytes, bytearray)) or len(raw) < 2:
				raise InvalidRun(f"no {mode} raw stream to compare the ungated auto run with its manual baseline")
		timing = stage1_timing(auto, manual, clocks)
		steps = open_steps(manual["pcm"], manual, clocks["manual"], timing["manualAnchorS"])
		edges = stage1_edges((auto, manual), (clocks["auto"], clocks["manual"]), steps, manual["audioRate"], obs["hangS"])
		if not _number(clocks["auto"].get("iqRate")) or clocks["auto"]["iqRate"] <= 0:
			raise InvalidRun("missing fixture IQ rate (sidecar) for the edge slack")
		slack_s = SQUELCH_BLOCK_S + FAKE_CHUNK_BYTES / (2 * clocks["auto"]["iqRate"]) + STAGE1_EDGE_MAP_ERR_S
		f, ident = verdict_stage1_identity(auto["pcm"], manual["pcm"], rate, timing, edges, slack_s, clocks["auto"]["period"])
		notes["stage1Identity"] = dict(ident, edgeSlackMs=slack_s * 1000, openSteps=len(steps))
		if f:
			failures.append(f)
	elif expect_open and runs:
		overs, early = played_overs(auto, runs, clocks["auto"], rate)
		if f := verdict_early(early):
			failures.append(f)
		if early:
			notes["earlyRuns"] = early
		# Pre-roll onset is an evidence-squelch property (NFM only). Early runs come first and
		# have no over onset to align.
		lags = [best_lag(auto["samples8k"], s, obs["reference8k"], obs["refOnset8k"], REF_RATE) for s, _e in runs[len(early) :]]
		if f := verdict_onset(lags):
			failures.append(f)
		notes["onsetLagsS"] = lags
		notes["overs"] = overs
		if auto["arrivals"]:
			eligible = complete_overs(auto["arrivals"][0][0], auto["arrivals"][-1][0], clocks["auto"], MAX_DELAY_S)
		else:
			eligible = set()
		if f := verdict_playback(overs, eligible):
			failures.append(f)
		if overs or not early:  # only early audio: already failed, no over to measure delay on
			f, worst = verdict_delay(overs)
			notes["maxDelayS"] = worst
			if f:
				failures.append(f)
	f, rates = verdict_byte_rate(auto["arrivals"], byte_rate)
	notes["byteRates"] = rates
	if f:
		failures.append(f)
	f, notes["p99"] = verdict_p99(auto, manual, clocks)
	if f:
		failures.append(f)
	# Edge stamps are Node callbacks at random moments: a typical interval's p99 bounds their
	# lateness, so the jitter term is each run's median steady interval p99 (the maxima are set by
	# single-interval spikes: up to 106.6 ms on a manual run).
	steady = notes["p99"].get("steadyMedianMs") or []
	jitter_s = sum(steady) / 1000 if len(steady) == 2 and all(_number(v) for v in steady) else 0.0
	f, notes["events"] = verdict_events(auto, manual, clocks["auto"], clocks["manual"], obs["carrier"], jitter_s)
	if f:
		failures.append(f)
	if not gated:
		# The close guard is the evidence gate's (NFM); a closed AM stage 1 leaves no exact-zero
		# tail edge to measure a drain on.
		notes["drain"] = None
		notes["drainSkipped"] = f"{modulation} is not evidence-gated (A8): no close guard, no drain"
		return failures, notes
	per_over = drain_per_over(manual.get("samples", []), manual["audioRate"], manual.get("arrivals", []),
		manual["transmissions"], manual.get("levels", []), clocks["manual"], obs["hangS"], obs["carrier"], ws_overs(manual, clocks["manual"]))
	f, notes["drain"] = verdict_drain(per_over, guard_ms)
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
	conn, gap, period, over_s = 1_792_000_000.0, 3.0, 6.75, 3.75
	host_offset, stream_lead, latency, stage1, stream_s = -1_791_990_000.0, 0.3, 0.25, 0.05, 65.0
	hang = 0.25
	complete = range(9)  # overs 0..8 are complete in both the stream and the WebSocket span

	def recorded(skip=0, overs=complete):
		"""Stream sample i carries source time conn + stream_lead + i / rate; over k plays whole."""
		out = [0.0] * int(stream_s * rate)
		for k in overs:
			i = int((gap + k * period - stream_lead) * rate)
			body = ref[onset + skip :]
			out[i : i + len(body)] = body
		return out

	def arrivals(stretch=1.0, stall_after=None):
		out = []
		for step in range(int(stream_s * 50) + 1):
			t = conn + stream_lead + latency + step * 0.02 * stretch
			if stall_after is not None and step * 0.02 > stall_after:
				t += 2.0
			out.append((t + host_offset, int(step * 0.02 * 2 * rate)))
		return out

	def events(shift=0.0, overs=range(10), announce=0.6, close_late=1.6):
		"""Opens are announced `announce` s after they start (qualification); closes `close_late`
		s after the stage-1 close (merge gap). endedAt is the audio end, the close minus hang."""
		out = []
		for k in overs:
			start = conn + gap + k * period + stage1 + shift
			mono = start + host_offset + announce
			out.append({"state": "open", "startedAt": format_iso(start), "endedAt": None, "durationMs": None, "mono": mono})
			out.append({"state": "closed", "startedAt": format_iso(start), "endedAt": format_iso(start + 3.75),
				"closeReason": "squelch", "durationMs": 3750, "mono": start + 3.75 + hang + close_late + host_offset})
		return out

	def true_close(k, delta):
		"""Stage-1 close on the container clock: carrier-off + hang + delta (delta = one 10 ms
		block of detection by default; negative when the fake delivered IQ early)."""
		return conn + gap + k * period + over_s + hang + delta

	def manual_stream(tail, delta=0.01):
		"""Manual run: over k audible from its onset until `tail` s after its stage-1 close arrives."""
		out = [0] * int(stream_s * rate)
		for k in complete:
			close = true_close(k, delta)
			i = int((gap + k * period - stream_lead) * rate)
			j = int((close + tail - conn - stream_lead - latency) * rate)
			out[i:j] = [1000] * (j - i)
		return out

	def manual_levels(delta=0.01, ws=0.02, closed=True, opened=True):
		"""live-audio:level receipts (host mono): open every 50 ms during the over, closed after."""
		out = []
		for k in range(10):
			o, c = conn + gap + k * period, true_close(k, delta)
			t = o + 0.3
			while opened and t < c:
				out.append([t + ws + host_offset, {"squelchOpen": True}])
				t += 0.05
			if closed:
				out += [[c + ws + i * 0.05 + host_offset, {"squelchOpen": False}] for i in range(3)]
		return out

	def status(*states):
		return [[0.0, {"autoSquelch": {"state": s}}] for s in states]

	m0 = conn + 10.0 + host_offset

	def probe_series(leg=0.001, step_at=None, step=0.0, drift_per_s=0.0):
		"""One probe per second over the run (2 ms round trip, `leg` of it before the container
		reads its clock), a slow wrong one, and an optional wall step or linear drift."""
		out = [[m0 - 5, m0 - 4.9, conn + 7.0]]
		for i in range(-9, 60):
			wall = conn + 10.0 + i + leg + drift_per_s * (i + 9)
			if step_at is not None and i >= step_at:
				wall += step
			out.append([m0 + i, m0 + i + (0.002 if leg <= 0.002 else 0.018), wall])
		return out

	def progress(step_at=None, step=0.0, drift_per_s=0.0):
		"""Fake progress every 5 s: [wall ts (ms rounding), monotonic elapsed]."""
		return [[round(conn + t + 0.0003 + drift_per_s * t + (step if step_at is not None and t >= step_at else 0.0), 3), t]
			for t in range(5, 70, 5)]

	probes = probe_series()

	def p99s(steady, startup, spikes=None):
		"""Loop-meter polls each second from 1 s after the epoch (host clock); polls 0-6 cover
		the settle point (over 0 onset at 3 s, + 4.5 s of interval cover), 7 on are steady."""
		out = []
		for i in range(65):
			v = startup if i <= 6 else steady
			v = (spikes or {}).get(i, v)
			out.append([conn + host_offset + 1.0 + i, i // 2, v, v])
		return out
	ws_span = [conn + 0.5 + host_offset, conn + 65.6 + host_offset]
	# `connected` is logged 30 ms after the pacing epoch (header send, thread start): unused.
	source = {"epochTs": conn, "epochErrS": 0.0001, "connectedTs": conn + 0.03, "connections": 1, "progress": progress()}
	common = {"source": source, "clockProbes": probes, "wsSpan": ws_span,
		"fixture": {"overOnsetS": gap, "periodS": period, "overS": over_s, "rate": 2_048_000}}
	base = {
		"expect": "voice", "mode": "nfm", "hangS": hang, "reference8k": ref, "refOnset8k": onset, "carrier": True,
		"auto": dict(common, audioRate=rate, samples8k=recorded(), arrivals=arrivals(), transmissions=events(),
			p99Samples=p99s(3.0, 135.0), status=status("waiting", "open")),
		"manual": dict(common, audioRate=rate, transmissions=events(), p99Samples=p99s(2.5, 1684.0), arrivals=arrivals(),
			samples=manual_stream(0.05), levels=manual_levels(), status=status("off")),
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

	def drain_of(**changes):
		obs = json.loads(json.dumps(base))
		for path, value in changes.items():
			side, key = path.split("__")
			obs[side][key] = value
		return evaluate(obs, 200)[1]["drain"]

	def invalid(**changes):
		try:
			variant(**changes)
		except InvalidRun as exc:
			return str(exc)
		raise AssertionError(f"accepted without timing evidence: {list(changes)}")

	def rejected(**changes):
		"""Failures, or the invalid-run reason (a dropped manual close also voids its drain)."""
		try:
			return variant(**changes)
		except InvalidRun as exc:
			return ["invalid: " + str(exc)]

	silent = [0.0] * int(stream_s * rate)
	assert variant() == [], variant()
	# Late announcements (event receipt) do not move any timing verdict.
	assert variant(auto__transmissions=events(announce=1.4), manual__transmissions=events(announce=0.9)) == []
	assert any("opened" in f for f in variant(top__expect="none"))
	assert any("onset" in f for f in variant(auto__samples8k=recorded(int(0.03 * rate))))
	assert any("byte rate" in f for f in variant(auto__arrivals=arrivals(1.02)))
	assert any("delay" in f for f in variant(auto__arrivals=arrivals(stall_after=gap + 1.0)))
	# Every complete over must play (2 of 9 played no longer passes); boundary overs are exempt.
	assert any("no playback" in f for f in variant(auto__samples8k=recorded(overs=range(2))))
	assert any("no playback" in f for f in variant(auto__samples8k=recorded(overs=[k for k in complete if k != 4])))
	# Missing timing evidence is invalid, never a zero-delay pass.
	assert "source clock" in invalid(auto__source=None)
	assert "more than one" in invalid(auto__source=dict(source, connections=2))
	assert "pacing epoch" in invalid(manual__source={"connectedTs": conn, "connections": 1})
	assert "bracket" in invalid(manual__source=dict(source, epochErrS=0.02))
	assert "sidecar" in invalid(auto__fixture={"periodS": period, "overOnsetS": gap})
	assert "clock probe" in invalid(auto__clockProbes=None)
	assert "round trip" in invalid(auto__clockProbes=[probes[0]])
	# Container wall-clock steps and drift over the run (pacing is monotonic, carrier_off is
	# extrapolated wall time): a 50 ms backward step is invalid in the probes and in the fake's
	# progress; drift inside the bound is valid, subtracted, and the drain stays contained.
	assert "moved" in invalid(manual__clockProbes=probe_series(step_at=20, step=-0.05))
	assert "stepped" in invalid(manual__source=dict(source, progress=progress(step_at=30, step=-0.05)))
	assert "moved" in invalid(manual__clockProbes=probe_series(step_at=20, step=0.05),
		manual__source=dict(source, progress=progress(step_at=30, step=0.05)))
	assert "cover" in invalid(manual__clockProbes=probes[:3] + probes[10:])
	assert "progress" in invalid(manual__source=dict(source, progress=[]))
	drifting = dict(manual__clockProbes=probe_series(drift_per_s=0.00002),
		manual__source=dict(source, progress=progress(drift_per_s=0.00002)))
	assert variant(**drifting) == []
	assert "stage-1" in invalid(auto__transmissions=[])
	assert "stage-1" in invalid(auto__transmissions=events(shift=MAX_DELAY_S + 0.2))
	assert "span" in invalid(manual__wsSpan=None)
	assert "autoSquelch" in invalid(auto__status=[])
	# Transmissions: a systematic shift, a dropped over (also a trailing one inside coverage),
	# missing and empty sets fail; an over outside the shared coverage is not compared.
	assert any("edges" in f for f in variant(manual__transmissions=events(shift=0.05)))
	late = [dict(e, durationMs=3800) if e["state"] == "closed" else e for e in events()]
	assert any("edges" in f for f in variant(manual__transmissions=late))
	assert any("over 3" in f for f in rejected(manual__transmissions=events(overs=[k for k in range(10) if k != 3])))
	assert any("over 8" in f for f in rejected(manual__transmissions=events(overs=range(8))))
	assert variant(manual__transmissions=events(overs=range(9))) == []
	short = [ws_span[0], conn + 29.0 + host_offset]  # manual covers overs 0..2 only
	assert variant(manual__wsSpan=short, manual__transmissions=events(overs=range(3))) == []
	assert any("over 2" in f for f in rejected(manual__wsSpan=short, manual__transmissions=events(overs=range(2))))
	assert "complete overs" in invalid(manual__wsSpan=[ws_span[0], conn + 15.0 + host_offset])
	empty = variant(top__expect="none", auto__samples8k=silent, auto__status=status("waiting"),
		auto__transmissions=[], manual__transmissions=[])
	assert any("no completed transmission" in f for f in empty), empty
	assert variant(top__expect="none", top__carrier=False, auto__samples8k=silent, auto__status=status("waiting"),
		auto__transmissions=[], manual__transmissions=[]) == []
	# A8: evidence squelch is NFM only. AM plays every over on stage-1 (no onset/pre-roll check,
	# am-carrier included) with autoSquelch off; NFM auto must be waiting/open.
	# AM auto is judged as one stage-1 stream against manual: a closed AM stage 1 is not exact
	# zeros (a low-frequency residue on both runs), so there are no exact-zero overs to split.
	# Each over opens with a clipped step (the AGC at full gain), as the AM chain renders it.
	residue = [(i % 80) - 40 or 1 for i in range(int(stream_s * rate))]
	am_manual = [int(8000 * noise()) + r if v else r for v, r in zip(manual_stream(0.05), residue)]
	step_at = {k: int((gap + k * period - stream_lead) * rate) for k in range(10)}
	for i in step_at.values():
		if i + 5 <= len(am_manual):
			am_manual[i : i + 5] = [32767] * 5

	def pcm(values):
		return [max(-32768, min(32767, int(v))) for v in values]

	def am_obs(auto_values, manual_values=None, **changes):
		obs = json.loads(json.dumps(base))
		obs["mode"] = "am"
		obs["auto"]["status"] = status("off")
		obs["auto"]["pcm"] = struct.pack(f"<{len(auto_values)}h", *pcm(auto_values))
		mv = am_manual if manual_values is None else manual_values
		obs["manual"]["pcm"] = struct.pack(f"<{len(mv)}h", *pcm(mv))
		for path, value in changes.items():
			side, key = path.split("__")
			if side == "top":
				obs[key] = value
			elif value is None:
				obs[side].pop(key, None)
			else:
				obs[side][key] = value
		return evaluate(obs, 200)

	def am_invalid(*args, **changes):
		try:
			am_obs(*args, **changes)
		except InvalidRun as exc:
			return str(exc)
		raise AssertionError(f"ungated run accepted without evidence: {list(changes)}")

	f, am_notes = am_obs(am_manual)
	assert f == [], f
	assert am_notes["drain"] is None and "A8" in am_notes["drainSkipped"], am_notes
	ident = am_notes["stage1Identity"]
	assert ident["shiftSamples"] == 0 and ident["openSteps"] == 10 and abs(ident["autoLaterMs"]) < 0.1, ident
	# The recorded am-voice shape: the auto stream starts 40 samples (5 ms) later in the same
	# stage-1 stream and its reads arrive 5 ms later; ±1 LSB AGC differences anywhere; one 0.2 s
	# cluster at each over's close edge (thresholds differ).
	shifted = am_obs(am_manual[40:], auto__arrivals=[[t + 40 / rate, b] for t, b in arrivals()])
	assert shifted[0] == [] and shifted[1]["stage1Identity"]["shiftSamples"] == 40, shifted
	lsb = [v + (1 if i % 7 == 0 else 0) for i, v in enumerate(am_manual)]
	assert am_obs(lsb)[0] == []
	def decaying(values, at, peak=19_664, factor=0.607):
		"""The recorded close shape: a divergence, then 0.607 per 10 ms block to within 1 LSB."""
		out, n = list(values), 0
		while peak * factor ** (n / (0.01 * rate)) >= 2:
			out[at + n] += int(peak * factor ** (n / (0.01 * rate)))
			n += 1
		return out

	edged = list(am_manual)
	for k in complete:
		c = step_at[k] + int((over_s + hang) * rate)  # gate close: startedAt + durationMs + hang
		edged = decaying(edged, c - int(0.03 * rate))  # 30 ms before the stamp, as recorded
		edged = decaying(edged, step_at[k] + 10, peak=4000)  # and at the open
	f, edged_notes = am_obs(edged)
	assert f == [] and max(edged_notes["stage1Identity"]["tailBlocks"]) >= 5, (f, edged_notes)
	# Interior mutes next to an edge: 400 ms from 80 ms after every open step (inside the 84 ms
	# slack), the first 400 ms of every over, and a constant (not decaying) difference at a close.
	for label, lo_s in (("80 ms after the open", 0.08), ("first 400 ms", 0.0)):
		near_edge = list(am_manual)
		for k in complete:
			i = step_at[k] + int(lo_s * rate)
			near_edge[i : i + int(0.4 * rate)] = [0] * int(0.4 * rate)
		got = am_obs(near_edge)[0]
		assert any("edge window" in f for f in got), (label, got)
	flat = list(am_manual)
	c = step_at[3] + int((over_s + hang) * rate)
	flat[c : c + int(0.2 * rate)] = [v + 500 for v in flat[c : c + int(0.2 * rate)]]
	assert any("edge window" in f for f in am_obs(flat)[0]), am_obs(flat)[0]
	# A playback delay cannot be aligned away: content shift -400/-800 samples, arrivals unchanged.
	for delay_ms in (50, 100):
		n = delay_ms * rate // 1000
		late = am_obs([0] * n + am_manual[:-n])[0]
		assert any(f"plays {delay_ms}.0 ms later" in f for f in late), (delay_ms, late)
	# Evidence gating on AM (a waiting gate mutes the 1 s voice window of every over), a pre-roll
	# delay only while the over plays, an all-muted stream: fail, never pass.
	waiting = list(am_manual)
	for k in complete:
		waiting[step_at[k] : step_at[k] + int(1.0 * rate)] = [0] * int(1.0 * rate)
	assert any("edge window" in f for f in am_obs(waiting)[0]), am_obs(waiting)[0]
	delayed = list(am_manual)
	for k in complete:
		i, n = step_at[k], int((over_s + 0.3) * rate)
		delayed[i : i + n] = [residue[i]] * int(0.3 * rate) + am_manual[i : i + n - int(0.3 * rate)]
	assert any("manual stage-1 stream" in f for f in am_obs(delayed)[0]), am_obs(delayed)[0]
	assert any("never equals" in f for f in am_obs([0] * len(am_manual))[0])
	# Interior mutes (400 ms at 4, 10.75, 17.5, 24.25 s, inside overs 0-3) are not stage-1 edges.
	muted = list(am_manual)
	for t in (4.0, 10.75, 17.5, 24.25):
		muted[int(t * rate) : int((t + 0.4) * rate)] = [0] * int(0.4 * rate)
	assert any("interior mute" in f for f in am_obs(muted)[0]), am_obs(muted)[0]
	scattered = [v + (300 if 1000 <= i % int(0.5 * rate) < 1008 else 0) for i, v in enumerate(am_manual)]
	assert any("interior mute" in f for f in am_obs(scattered)[0]), am_obs(scattered)[0]
	# Concentrated clusters: two separate differences at one close edge (80 ms before and 30 ms
	# after it, both inside the slack), and a third difference in one period away from its edges.
	c = step_at[2] + int((over_s + hang) * rate)
	twice = list(am_manual)
	for a in (c - int(0.08 * rate), c + int(0.03 * rate)):
		twice[a : a + 40] = [v + 500 for v in twice[a : a + 40]]
	assert any("more than one difference at the over 2 close edge" in f for f in am_obs(twice)[0]), am_obs(twice)[0]
	third = list(edged)
	third[c + int(0.6 * rate) : c + int(0.65 * rate)] = [0] * int(0.05 * rate)
	assert any("interior mute" in f for f in am_obs(third)[0]), am_obs(third)[0]
	# A finite rise at the open (10 000, 20 000, then clipped) in both streams is still located.
	ramped = list(am_manual)
	for i in step_at.values():
		if i + 5 <= len(ramped):
			ramped[i : i + 5] = [10000, 20000, 32767, 32767, 32767]
	f, ramp_notes = am_obs(ramped, ramped)
	assert f == [] and ramp_notes["stage1Identity"]["openSteps"] == 10, (f, ramp_notes)
	slow_rise = list(am_manual)
	for i in step_at.values():
		if i + 60 <= len(slow_rise):
			slow_rise[i : i + 60] = [9000] * 55 + [32767] * 5  # 6.9 ms above quiet before the clip
	assert "open step" in am_invalid(slow_rise, slow_rise)
	# Carrier-only PCM: the analyzer's am-carrier golden (noise peaking at about 150, then the
	# key-up clip at 0.25 s) tiled as a 4 s period. Every over whose search window is recorded is
	# located within 10 ms of its onset: valid edges, not INVALID.
	golden = reference("am-carrier")
	tiles = [int(v * 32768) for v in golden] * 7
	side = {"audioRate": 8000.0, "transmissions": [{"state": "closed", "startedAt": format_iso(conn + 0.25 + 4 * k),
		"durationMs": 3750} for k in range(7)]}
	found = open_steps(struct.pack(f"<{len(tiles)}h", *pcm(tiles)), side, {"connected": conn, "onset": 0.25, "period": 4.0}, 0.0)
	assert sorted(found) == list(range(1, 7)), found
	assert all(abs(j / 8000 - (0.25 + 4 * k)) <= 0.010 for k, (j, _rel) in found.items()), found
	# Container clock drift of either sign near the 25 ms limit (probes and the fake's progress)
	# does not move the arrival-time check: the probe nearest the pacing epoch maps host time.
	for d in (0.00034, -0.00034):
		drift = dict(manual__clockProbes=probe_series(drift_per_s=d), manual__source=dict(source, progress=progress(drift_per_s=d)))
		assert am_obs(am_manual, **drift)[0] == [], (d, am_obs(am_manual, **drift)[0])
		assert any("plays 50.0 ms later" in f for f in am_obs([0] * 400 + am_manual[:-400], **drift)[0]), d
	# Missing evidence is invalid: no or empty raw stream, a probe-less epoch, no open steps,
	# timing too uncertain to show a 20 ms delay.
	assert "raw stream" in am_invalid(am_manual, manual__pcm=None)
	assert "raw stream" in am_invalid([])
	assert "raw stream" in am_invalid(am_manual, [])
	assert "nearest clock probe" in am_invalid(am_manual, manual__clockProbes=[p for p in probes if p[0] > m0 + 0.5])
	assert "open step" in am_invalid(am_manual, [v if abs(v) < 32767 else 0 for v in am_manual])
	slow = [[a, a + 0.016, w] for a, _b, w in probe_series(leg=0.0)[1:]]  # 8 ms half round trip each
	assert "timing tolerance" in am_invalid(am_manual, auto__clockProbes=slow, manual__clockProbes=slow)
	am_auto = dict(auto__status=status("off"), top__mode="am",
		auto__pcm=struct.pack(f"<{len(am_manual)}h", *pcm(am_manual)), manual__pcm=struct.pack(f"<{len(am_manual)}h", *pcm(am_manual)))
	assert variant(**am_auto) == []
	assert variant(auto__samples8k=recorded(int(0.03 * rate)), **am_auto) == []
	assert variant(top__expect="none", **am_auto) == []
	assert any("opened" in f for f in variant(top__expect="none", auto__samples8k=silent, **am_auto))
	assert any("autoSquelch" in f for f in variant(**dict(am_auto, auto__status=status("waiting", "open"))))
	# The driver's gated set is the frozen contract's.
	contract = (ROOT.parents[1] / "packages/api-types/src/live-audio.ts").read_text()
	listed = re.search(r"LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS\b[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)", contract)
	assert listed and frozenset(re.findall(r'"(\w+)"', listed[1])) == EVIDENCE_MODULATIONS, listed
	# NFM (gated): audio played before the first over (gate open on pre-over noise) is a failure
	# of "never opens without evidence", not an invalid run, with or without the overs after it.
	noisy = recorded()
	noisy[int(0.5 * rate) : int(1.5 * rate)] = [noise() for _ in range(int(1.0 * rate))]
	early = variant(auto__samples8k=noisy)
	assert len(early) == 1 and "before the first over" in early[0], early
	only_early = [0.0] * int(stream_s * rate)
	only_early[int(0.5 * rate) : int(1.5 * rate)] = noisy[int(0.5 * rate) : int(1.5 * rate)]
	failed = variant(auto__samples8k=only_early)
	assert any("before the first over" in f for f in failed) and any("no playback" in f for f in failed), failed
	assert any("autoSquelch" in f for f in variant(auto__status=status("off")))
	assert any("autoSquelch" in f for f in variant(manual__status=status("waiting")))
	assert any("never open" in f for f in variant(auto__status=status("waiting")))
	assert any("did open" in f for f in variant(top__expect="none", auto__samples8k=silent))
	# p99 at steady state: the startup intervals (here 135 and 1 684 ms) are reported only; the
	# steady medians differ by at most 2 ms; single steady spikes (host noise) are reported only.
	p99_notes = evaluate(json.loads(json.dumps(base)), 200)[1]["p99"]
	assert p99_notes["startupMs"] == {"auto": [135.0], "manual": [1684.0]} and p99_notes["steadySamples"] == [58, 58], p99_notes
	assert any("steady median event-loop p99" in f for f in variant(auto__p99Samples=p99s(5.0, 135.0)))
	assert any("steady median event-loop p99" in f for f in variant(auto__p99Samples=p99s(5.1, 135.0)))  # +2.6 ms
	assert variant(auto__p99Samples=p99s(4.4, 135.0)) == []  # +1.9 ms
	assert variant(auto__p99Samples=p99s(3.0, 135.0, {7: 50.0, 20: 34.0})) == []  # single spikes
	raised = {i: 5.6 for i in range(7, 65) if i % 5 < 3}  # 60 % of the steady polls +3.1 ms
	assert any("steady median event-loop p99" in f for f in variant(auto__p99Samples=p99s(3.0, 135.0, raised)))
	settle = {i: 50.0 for i in range(0, 7)}  # polls covering the settle point never count
	assert variant(auto__p99Samples=p99s(3.0, 135.0, settle)) == []
	spiky = evaluate(json.loads(json.dumps(dict(base, auto=dict(base["auto"], p99Samples=p99s(3.0, 135.0, {20: 34.0}))))), 200)[1]["p99"]
	assert spiky["autoSteadyMaxMs"] == 34.0 and spiky["steadyMedianMs"] == [3.0, 2.5], spiky
	assert any("missing event-loop p99" in f for f in variant(auto__p99Samples=[]))
	assert "steady loop-meter samples" in invalid(manual__p99Samples=p99s(2.5, 1684.0)[:12])
	assert "malformed loop-meter" in invalid(manual__p99Samples=[[0.0, 1]])
	# Older recordings: p99Ms pairs with the status poll times, only when the counts agree.
	polls = [[t, {"autoSquelch": {"state": "off"}}] for t, _i, _v, _m in p99s(0, 0)]
	old_format = dict(manual__p99Samples=None, manual__p99Ms=[v for _t, _i, v, _m in p99s(2.5, 1684.0)], manual__status=polls)
	assert variant(**old_format) == [], variant(**old_format)
	assert "cannot time them" in invalid(**dict(old_format, manual__status=polls[:-1]))
	contract_ms_text = (ROOT.parents[1] / "src/decoders/enablement/contract.ts").read_text()
	assert re.search(r"EFFICIENCY_SAMPLE_MS = ([\d_]+)", contract_ms_text)[1].replace("_", "") == str(int(EFFICIENCY_SAMPLE_S * 1000))
	# Stage-1 edges: chunk phase cancels; one block + both median steady p99 (10 + 3 + 2.5 = 15.5 ms) per
	# over, and a median bias of at most 5 ms. Zero-median jitter of ±12 ms passes; a gate that
	# delays every stage-1 event by 8 ms (inside the per-over limit) or one over by 20 ms fails.
	def jittered(amount, overs=range(10)):
		return [e for k in overs for e in events(shift=(-amount, 0.0, amount, 0.0)[k % 4], overs=[k])]

	assert variant(manual__transmissions=jittered(0.012)) == [], variant(manual__transmissions=jittered(0.012))
	assert variant(auto__transmissions=events(shift=0.004)) == []
	assert any("later than manual" in f for f in variant(auto__transmissions=events(shift=0.008)))
	assert any("earlier than manual" in f for f in variant(auto__transmissions=events(shift=-0.008)))
	one_late = [e for k in range(10) for e in events(shift=0.02 if k == 4 else 0.0, overs=[k])]
	assert any("edges differ in over 4" in f for f in variant(auto__transmissions=one_late))
	limits = evaluate(json.loads(json.dumps(base)), 200)[1]["events"]
	assert abs(limits["edgeLimitMs"] - 15.5) < 1e-9, limits
	# Drain intervals: the true drain (tail) always lies in [lowerMs, upperMs]; the guard is
	# flagged on upperMs, so a drain over 200 ms can never read as under the guard.
	def holds(d, tail_ms):
		return all(o["lowerMs"] <= tail_ms <= o["upperMs"] for o in d["perOver"]) and d["overs"] == len(complete)

	d = drain_of()
	assert holds(d, 50) and not d["exceedsGuard"], d
	# A 350 ms tail whose close is announced 1.6 s late (events) is measured from the close.
	d = drain_of(manual__samples=manual_stream(0.35))
	assert holds(d, 350) and d["lowerMaxMs"] > 200 and d["exceedsGuard"], d
	# Early chunk delivery: IQ 64 ms ahead closes stage 1 54 ms before carrier-off + hang; a true
	# 230 ms drain must not read under the guard (the old reference read 176 ms).
	early = dict(manual__samples=manual_stream(0.23, delta=0.01 - 0.064), manual__levels=manual_levels(delta=0.01 - 0.064))
	d = drain_of(**early)
	assert holds(d, 230) and d["exceedsGuard"], d
	# The pacing epoch, not `connected` (logged 30 ms later), anchors carrier-off: anchored on
	# `connected` the same run's upper bound would fall below the true drain; the progress check
	# catches such a misplaced anchor.
	late_anchor = dict(source, epochTs=conn + 0.03)
	assert not holds(drain_of(manual__source=dict(late_anchor, progress=progress(step=0.03, step_at=0)), **early), 230)
	assert "stepped" in invalid(manual__source=late_anchor)
	d = drain_of(**drifting, **early)
	assert holds(d, 230) and d["exceedsGuard"], d
	# The fake's serialised epoch bracket contains both wall reads (outward rounding).
	import importlib.util
	spec = importlib.util.spec_from_file_location("fake_rtl_tcp", ROOT.parent / "capacity/fake_rtl_tcp.py")
	fake = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(fake)
	rng = random.Random(7)
	for _ in range(2000):
		w0 = conn + rng.uniform(0, 100)
		w1 = w0 + rng.choice((0.0, 1e-7, 4.9e-7, 5e-7, 1e-6, rng.uniform(0, 1e-3)))
		f = fake.epoch_fields(w0, w1)
		assert f["epochTs"] - f["epochErrS"] <= w0 and w1 <= f["epochTs"] + f["epochErrS"], (w0, w1, f)
		assert f["epochErrS"] == round(f["epochErrS"], 6) and f["epochTs"] == round(f["epochTs"], 6)
	# Probe error both directions (18 ms round trip, all of it on one leg): bounds still hold.
	for leg in (0.0, 0.018):
		probe = probe_series(leg=leg)
		d = drain_of(manual__clockProbes=probe, manual__samples=manual_stream(0.15), **{"manual__levels": manual_levels()})
		assert holds(d, 150), (leg, d)
		d = drain_of(manual__clockProbes=probe, **{k: v for k, v in early.items()})
		assert holds(d, 230) and d["exceedsGuard"], (leg, d)
	# 150 ms of valid upstream latency (front buffering): the close and endedAt are late; valid,
	# endedAt reported only.
	lagged = [dict(e, endedAt=format_iso(parse_iso(e["startedAt"]) - stage1 + over_s + 0.15)) if e["state"] == "closed" else e
		for e in events()]
	d = drain_of(manual__transmissions=lagged, manual__samples=manual_stream(0.1, delta=0.15),
		manual__levels=manual_levels(delta=0.15))
	assert holds(d, 100) and all(abs(o["endedAfterCarrierOffMs"] - 150) < 2 for o in d["perOver"]), d
	assert variant(manual__transmissions=lagged, manual__samples=manual_stream(0.1, delta=0.15),
		manual__levels=manual_levels(delta=0.15)) == []
	# endedAt missing or clamped (short final segment) is informational, never the close.
	d = drain_of(manual__transmissions=[dict(e, endedAt=None) for e in events()])
	assert holds(d, 50) and d["perOver"][0]["endedAfterCarrierOffMs"] is None
	clamped = [dict(e, endedAt=format_iso(parse_iso(e["startedAt"]) - stage1 + over_s - 0.2)) if e["state"] == "closed" else e
		for e in events()]
	d = drain_of(manual__transmissions=clamped, manual__samples=manual_stream(0.35))
	assert holds(d, 350) and d["exceedsGuard"], d
	# Missing timing evidence is invalid, never a short drain.
	assert "observed stage-1 close" in invalid(manual__levels=manual_levels(closed=False))
	assert "observed stage-1 close" in invalid(manual__levels=manual_levels(opened=False))
	assert "observed stage-1 close" in invalid(manual__levels=[])
	assert "IQ rate" in invalid(manual__fixture={"overOnsetS": gap, "periodS": period, "overS": over_s})
	assert "played tail" in invalid(manual__samples=[v if not (conn + gap + 5 * period - 1 < conn + stream_lead + i / rate
		< conn + gap + 6 * period - 1) else 0 for i, v in enumerate(manual_stream(0.05))])

	def closes_with(**fields):
		return [dict(e, **fields) if e["state"] == "closed" else e for e in events()]

	for reason in ("stopped", "config", "retune", "max-duration", None):
		assert "close reason" in invalid(manual__transmissions=closes_with(closeReason=reason))
	split = events() + [e for e in events(overs=[4]) if e["state"] == "closed"]
	assert "more than one close" in invalid(manual__transmissions=split)
	flag, summary = verdict_drain([{"over": 0, "lowerMs": 180.0, "upperMs": 250.0},
		{"over": 1, "lowerMs": 90.0, "upperMs": 150.0}], 200)
	assert flag and summary["maxMs"] == 250.0 and summary["medianMs"] == 200.0 and summary["lowerMaxMs"] == 180.0
	assert nonzero_runs([0, 1, 1, 0, 0, 0, 2], 1, min_gap_s=2) == [(1, 3), (6, 7)]
	assert parse_iso("1970-01-01T00:00:01.5Z") == 1.5 and parse_iso(format_iso(conn + 0.25)) == conn + 0.25
	# NFM: container clock drift of either sign near the 25 ms limit stays valid, is subtracted
	# from the drain bound (the true drain still lies in the interval), and just past the limit
	# is invalid.
	for d in (0.00034, -0.00034):
		near_limit = dict(manual__clockProbes=probe_series(drift_per_s=d), manual__source=dict(source, progress=progress(drift_per_s=d)))
		assert variant(**near_limit) == [], (d, variant(**near_limit))
		dd = drain_of(**near_limit, **early)
		assert holds(dd, 230) and dd["exceedsGuard"], (d, dd)
		past = dict(manual__clockProbes=probe_series(drift_per_s=d * 1.25), manual__source=dict(source, progress=progress(drift_per_s=d * 1.25)))
		assert "moved" in invalid(**past) or "stepped" in invalid(**past), d
	# Replay: a fixture whose stream or observations cannot be read is INVALID and the later
	# fixtures are still judged.
	import contextlib
	import io
	import tempfile
	with tempfile.TemporaryDirectory() as tmp:
		out = Path(tmp)
		(out / "am-voice" / "auto").mkdir(parents=True)
		(out / "am-voice" / "auto" / "observations.json").write_text(json.dumps({"audioRate": 8000, "streamT0": 0.0}))
		(out / "nfm-carrier" / "auto").mkdir(parents=True)
		(out / "nfm-carrier" / "auto" / "observations.json").write_text("[1]")
		(out / "nfm-voice" / "auto").mkdir(parents=True)
		(out / "nfm-voice" / "auto" / "observations.json").write_text("{not json")
		printed = io.StringIO()
		with contextlib.redirect_stdout(printed):
			code = replay(out)
		got = json.loads((out / "verdicts.json").read_text())
		assert code == 2 and sorted(got) == ["am-voice", "nfm-carrier", "nfm-voice"], (code, got)
		assert "stream.s16le" in got["am-voice"]["invalid"], got
		assert "not an object" in got["nfm-carrier"]["invalid"] and "unreadable observations" in got["nfm-voice"]["invalid"], got
		assert printed.getvalue().count("INVALID") == 3, printed.getvalue()
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

	async def clock(_reader, writer):
		# The containers' wall clock (the fake's `connected` ts and the core's startedAt).
		writer.write(json.dumps({"t": time.time()}).encode())
		await writer.drain()
		writer.close()

	async def main():
		server = await asyncio.start_server(clock, "0.0.0.0", CLOCK_PORT)
		async with server:
			await asyncio.gather(serve(API_PORT), serve(STREAM_PORT), server.serve_forever())

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
		self.obs = {"mode": mode, "arrivals": [], "levels": [], "transmissions": [], "status": [], "p99Ms": [], "p99Samples": []}

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
		connected, progress = [], []
		for line in out.splitlines():
			try:
				event = json.loads(line)
			except ValueError:
				continue
			if isinstance(event, dict) and event.get("event") == "connected":
				connected.append(event)
			elif isinstance(event, dict) and event.get("event") == "progress" and event.get("connection") == 1:
				if _number(event.get("ts")) and _number(event.get("elapsedS")):
					progress.append([event["ts"], event["elapsedS"]])
		if not connected:
			raise InvalidRun("fake rtl_tcp logged no connection")
		first = connected[0]
		# A missing epoch (an older fake) stays missing: source_clock makes the run invalid.
		return {"epochTs": first.get("epochTs"), "epochErrS": first.get("epochErrS"),
			"connectedTs": first.get("ts"), "connections": len(connected), "progress": progress}

	def run(self, entry, cu8, cu8_meta):
		self.dir.mkdir(parents=True, exist_ok=True)
		config = self.write_config(entry)
		api_port, stream_port, clock_port = pick_ports(3, loopback_free)
		self.obs["clockProbes"] = []
		self.obs["fixture"] = cu8_meta
		self.obs["seconds"] = self.args.seconds
		self.env = dict(os.environ, EVIDENCE_SQUELCH_CU8=cu8.name, EVIDENCE_SQUELCH_DATA=str(cu8.parent.resolve()),
			EVIDENCE_SQUELCH_CONFIG=str(config.resolve()), EVIDENCE_SQUELCH_RATE=str(self.args.rate),
			EVIDENCE_SQUELCH_DURATION=str(int(self.args.seconds) + 300),
			EVIDENCE_SQUELCH_CORE_QUOTA=str(self.args.cpu_quota or 0),
			EVIDENCE_SQUELCH_API_PORT=str(api_port), EVIDENCE_SQUELCH_STREAM_PORT=str(stream_port),
			EVIDENCE_SQUELCH_CLOCK_PORT=str(clock_port))
		threads = []
		try:
			self.compose("up", "-d", "--no-build", "--pull", "never", timeout=180)
			# Both endpoints are verified before any client (including the readiness poll) starts.
			host, api = self.endpoint(API_PORT, api_port)
			stream = self.endpoint(STREAM_PORT, stream_port)
			self.clock = self.endpoint(CLOCK_PORT, clock_port)
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
			ws = WsClient.connect(host, port, ["live-audio"], self.stop)
			start = time.monotonic()
			read_ws(ws, self.stop, self.obs)
			self.obs["wsSpan"] = [start, time.monotonic()]
		except (OSError, InvalidRun, ValueError) as exc:
			self.obs["error"] = "websocket: " + str(exc)
			self.stop.set()

	def probe_clock(self):
		"""(host mono before, host mono after, container wall clock) from the forwarder."""
		host, port = check_endpoint(*self.clock)
		m0 = time.monotonic()
		with socket.create_connection((host, port), timeout=2) as sock:
			data = b""
			while chunk := sock.recv(256):
				data += chunk
		m1 = time.monotonic()
		wall = json.loads(data).get("t")
		if _number(wall):
			self.obs["clockProbes"].append([m0, m1, wall])

	def poll(self):
		while not self.stop.wait(1.0):
			try:
				self.probe_clock()
				self.obs["status"].append((time.monotonic(), self.get("/api/live-audio/status")))
				for report in self.get("/api/resources/link-quality"):
					loop = report.get("loopDelay") or {}
					last = loop.get("last") or {}
					if isinstance(last.get("p99Ms"), (int, float)):
						self.obs["p99Ms"].append(last["p99Ms"])
						self.obs["p99Samples"].append([time.monotonic(), loop.get("intervals10m"), last["p99Ms"], last.get("maxMs")])
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


def squelch_hang_ms():
	"""The stage-1 squelch hang the core uses (SQUELCH_HANG_MS in live-demodulator.ts)."""
	text = (ROOT.parents[1] / "src/core/live-demodulator.ts").read_text()
	match = re.search(r"^const SQUELCH_HANG_MS = ([\d_]+)$", text, re.M)
	if not match:
		raise InvalidRun("missing SQUELCH_HANG_MS")
	return int(match[1].replace("_", ""))


def judge(run_dir, name, entry, guard_ms):
	obs = {"expect": entry["expect"], "mode": entry["mode"], "reference8k": reference(name), "refOnset8k": int(entry["overOnsetS"] * REF_RATE),
		"carrier": name not in CARRIERLESS}
	for mode in ("auto", "manual"):
		path = run_dir / mode / "observations.json"
		if not path.exists():
			raise InvalidRun(f"missing {path}")
		try:
			side = json.loads(path.read_text())
		except (OSError, ValueError) as exc:  # unreadable, not UTF-8 or not JSON
			raise InvalidRun(f"{name} {mode}: unreadable observations ({type(exc).__name__})") from exc
		if not isinstance(side, dict):
			raise InvalidRun(f"{name} {mode}: observations are not an object")
		side["dir"] = str(run_dir / mode)
		if "audioRate" not in side or "streamT0" not in side:
			raise InvalidRun(f"{name} {mode}: no stream recorded")
		side["audioRate"] = audio_rate(side)
		try:
			data = (run_dir / mode / "stream.s16le").read_bytes()
		except OSError as exc:
			raise InvalidRun(f"{name} {mode}: unreadable stream.s16le ({type(exc).__name__})") from exc
		side["samples8k"] = to_8k(run_dir / mode / "stream.s16le", side["audioRate"]) if mode == "auto" else []
		side["pcm"] = data  # raw s16le: the ungated (A8) stage-1 identity check
		if mode == "manual":
			side["samples"] = struct.unpack(f"<{len(data) // 2}h", data[: len(data) // 2 * 2])
		obs[mode] = side
	obs["hangS"] = squelch_hang_ms() / 1000
	return evaluate(obs, guard_ms)


def report(out, results):
	(out / "verdicts.json").write_text(json.dumps(results, indent=2) + "\n")
	for name, r in results.items():
		if "invalid" in r:
			print(f"{name}: INVALID {r['invalid']}")
			continue
		print(f"{name}: {'PASS' if not r['failures'] else 'FAIL'} {json.dumps(r['notes'])}")
		drain = r["notes"].get("drain")
		if drain:
			print(f"  drain upper max {drain['maxMs']:.0f} ms, median {drain['medianMs']:.0f} ms; lower max"
				f" {drain['lowerMaxMs']:.0f} ms over {drain['overs']} overs"
				f" (CLOSE_GUARD_MS {drain['guardMs']}){' EXCEEDS GUARD' if drain['exceedsGuard'] else ''}")
		for f in r["failures"]:
			print("  - " + f)
	if any("invalid" in r for r in results.values()):
		return 2
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
		try:
			failures, notes = judge(out / name, name, entries[name], guard_ms)
		except InvalidRun as exc:  # one fixture's missing evidence does not hide the others
			results[name] = {"invalid": str(exc)}
			continue
		except (KeyError, TypeError, ValueError, IndexError, AttributeError, struct.error) as exc:
			# Malformed recorded observations (wrong field types or shapes): invalid, never a pass.
			results[name] = {"invalid": f"malformed observations ({type(exc).__name__}: {exc})"}
			continue
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
