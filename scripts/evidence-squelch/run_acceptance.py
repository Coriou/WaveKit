#!/usr/bin/env python3
"""Evidence squelch fake-link acceptance on a scratch Compose project (plan Task FX.3).

Per fixture: an `auto` run and a `manual` baseline on the same looped CU8 file, each in its
own project `wkevs-<pid>` with an internal network, the in-container fake rtl_tcp
(`fake:1234`) and the core image from EVIDENCE_SQUELCH_IMAGE (default wavekit:latest; never
built or pulled here). The API and the audio stream are reached through a forwarder
published on ephemeral loopback ports only. Recorded: `/stream.wav` bytes with arrival
times, `live-audio:level` and `live-audio:transmission` events, status samples and the
event-loop p99 of the link-quality report.

Exit codes: 0 pass, 1 fail, 2 invalid (setup, teardown or recording failure).

  run_acceptance.py --rate 2048000 --engine csdr --fixture all --out <dir> [--cpu-quota 0.75]
  run_acceptance.py --replay <dir>      # recompute verdicts from a recorded <dir>
  run_acceptance.py --self-test         # verdict functions on synthetic observations, no Docker
"""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
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
		score = abs(sum(x * y for x, y in zip(seg, ref))) / (energy * ref_energy) ** 0.5
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


def stream_lag(arrivals, byte_rate):
	"""Per arrival (mono, cumulative bytes): wall time minus stream time, relative to the first."""
	if not arrivals:
		return []
	t0 = arrivals[0][0] - arrivals[0][1] / byte_rate
	return [(t, t - t0 - b / byte_rate) for t, b in arrivals]


def verdict_delay(arrivals, byte_rate, overs):
	"""Per over (mono start, mono end): stream delay growth inside the over ≤ MAX_DELAY_S."""
	lags = stream_lag(arrivals, byte_rate)
	worst = 0.0
	for start, end in overs:
		inside = [lag for t, lag in lags if start <= t <= end + MAX_DELAY_S]
		before = [lag for t, lag in lags if t < start]
		if inside and before:
			worst = max(worst, max(inside) - before[-1])
	return (None if worst <= MAX_DELAY_S else f"per-over delay {worst:.3f} s > {MAX_DELAY_S} s"), worst


def verdict_byte_rate(arrivals, byte_rate):
	"""Bytes per full minute within BYTE_RATE_TOLERANCE of nominal."""
	if not arrivals:
		return "no stream bytes", []
	t0, b0 = arrivals[0]
	rates, edge, i = [], t0 + 60.0, 0
	prev_b = b0
	for t, b in arrivals:
		if t >= edge:
			rates.append((b - prev_b) / 60.0)
			prev_b, edge = b, edge + 60.0
		i += 1
	bad = [r for r in rates if abs(r / byte_rate - 1) > BYTE_RATE_TOLERANCE]
	if not rates:
		return "under one minute of stream recorded", rates
	return (f"byte rate off nominal {byte_rate}: {bad}" if bad else None), rates


def event_edges(events):
	"""(open, close) seconds relative to the first open, from transmission events."""
	opens = [e for e in events if e.get("state") == "closed" and e.get("durationMs") is not None]
	if not opens:
		return []
	first = parse_iso(opens[0]["startedAt"])
	return [(parse_iso(e["startedAt"]) - first, parse_iso(e["startedAt"]) - first + e["durationMs"] / 1000) for e in opens]


def parse_iso(text):
	match = re.match(r"(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+(?:\.\d+)?)Z$", text or "")
	if not match:
		raise InvalidRun("unparsable event timestamp")
	y, mo, d, h, mi = (int(match[i]) for i in range(1, 6))
	return time.mktime((y, mo, d, h, mi, 0, 0, 0, 0)) - time.timezone + float(match[6])


def verdict_events(auto_events, manual_events):
	a, m = event_edges(auto_events), event_edges(manual_events)
	if len(a) != len(m):
		return f"transmission count auto {len(a)} != manual {len(m)}"
	for (ao, ac), (mo, mc) in zip(a, m):
		if abs(ao - mo) > EVENT_TOLERANCE_S or abs(ac - mc) > EVENT_TOLERANCE_S:
			return f"transmission edges differ: auto {ao:.3f}-{ac:.3f} manual {mo:.3f}-{mc:.3f}"
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
	rate = auto["audioRate"]
	byte_rate = rate * 2
	runs = nonzero_runs(auto["samples8k"], REF_RATE)
	for f in (verdict_opened(obs["expect"], runs),):
		if f:
			failures.append(f)
	if obs["expect"] != "none" and runs:
		lags = [best_lag(auto["samples8k"], s, obs["reference8k"], obs["refOnset8k"], REF_RATE) for s, _e in runs]
		if f := verdict_onset(lags):
			failures.append(f)
		notes["onsetLagsS"] = lags
		overs = [(auto["streamT0"] + s / REF_RATE, auto["streamT0"] + e / REF_RATE) for s, e in runs]
		f, worst = verdict_delay(auto["arrivals"], byte_rate, overs)
		notes["maxDelayS"] = worst
		if f:
			failures.append(f)
	f, rates = verdict_byte_rate(auto["arrivals"], byte_rate)
	notes["byteRates"] = rates
	if f:
		failures.append(f)
	if f := verdict_events(auto["transmissions"], manual["transmissions"]):
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


def self_test():
	rate = REF_RATE
	seed = [12345]

	def noise():
		seed[0] = (seed[0] * 1103515245 + 12345) % (1 << 31)
		return seed[0] / (1 << 30) - 1.0 or 0.5

	onset = int(0.25 * rate)
	ref = [0.0] * onset + [noise() for _ in range(int(3.75 * rate))]

	def recorded(skip):
		"""Waiting zeros, then the over from `skip` samples after its first sample."""
		return [0.0] * rate + ref[onset + skip :] + [0.0] * rate

	def arrivals(seconds, byte_rate, stretch=1.0):
		return [(100.0 + t * 0.1 * stretch, int(t * 0.1 * byte_rate)) for t in range(int(seconds * 10) + 1)]

	tx = [{"state": "closed", "startedAt": "2026-10-23T10:00:00.000Z", "durationMs": 3750}]
	base = {
		"expect": "voice", "reference8k": ref, "refOnset8k": onset,
		"auto": {"audioRate": rate, "samples8k": recorded(0), "streamT0": 100.0, "arrivals": arrivals(130, 2 * rate),
			"transmissions": tx, "p99Ms": [3.0]},
		"manual": {"audioRate": rate, "transmissions": tx, "p99Ms": [2.5], "drainsMs": [120.0]},
	}

	def variant(**changes):
		obs = json.loads(json.dumps(base))
		for path, value in changes.items():
			side, key = path.split("__")
			if side == "top":
				obs[key] = value
			else:
				obs[side][key] = value
		return evaluate(obs, 200)[0]

	assert variant() == [], variant()
	assert any("opened" in f for f in variant(top__expect="none"))
	assert any("onset" in f for f in variant(auto__samples8k=recorded(int(0.03 * rate))))
	assert any("byte rate" in f for f in variant(auto__arrivals=arrivals(130, 2 * rate, 1.02)))
	assert any("count" in f for f in variant(manual__transmissions=tx * 2))
	late = [dict(tx[0], durationMs=3800)]
	assert any("edges" in f for f in variant(manual__transmissions=late))
	assert any("p99" in f for f in variant(auto__p99Ms=[5.0]))
	assert any("p99" in f for f in variant(auto__p99Ms=[]))
	stalled = arrivals(130, 2 * rate)
	stalled = [(t + (2.0 if t > 101.5 else 0.0), b) for t, b in stalled]
	assert any("delay" in f for f in variant(auto__arrivals=stalled))
	assert verdict_drain([250.0], 200)[0] is not None and verdict_drain([150.0], 200)[0] is None
	assert nonzero_runs([0, 1, 1, 0, 0, 0, 2], 1, min_gap_s=2) == [(1, 3), (6, 7)]
	assert parse_iso("1970-01-01T00:00:01.5Z") == 1.5
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


def loopback_only(host):
	if host not in ("127.0.0.1", "::1", "localhost"):
		raise InvalidRun("published port is not on loopback")


class WsClient:
	"""Minimal RFC 6455 text client (stdlib only) for the core's /ws."""

	def __init__(self, host, port, channels):
		loopback_only(host)
		self.sock = socket.create_connection((host, port), timeout=10)
		key = base64.b64encode(os.urandom(16)).decode()
		self.sock.sendall((f"GET /ws HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
			f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
		head = b""
		while b"\r\n\r\n" not in head:
			chunk = self.sock.recv(4096)
			if not chunk:
				raise InvalidRun("websocket handshake closed")
			head += chunk
		if b" 101 " not in head.split(b"\r\n", 1)[0]:
			raise InvalidRun("websocket handshake refused")
		self.buf = head.split(b"\r\n\r\n", 1)[1]
		self.send(json.dumps({"type": "subscribe", "channels": channels}))

	def send(self, text, opcode=1):
		data = text.encode() if isinstance(text, str) else text
		mask = os.urandom(4)
		header = bytes([0x80 | opcode])
		n = len(data)
		header += bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", n))
		self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

	def _read(self, n):
		while len(self.buf) < n:
			chunk = self.sock.recv(65536)
			if not chunk:
				raise EOFError
			self.buf += chunk
		out, self.buf = self.buf[:n], self.buf[n:]
		return out

	def messages(self):
		while True:
			b0, b1 = self._read(2)
			n = b1 & 0x7F
			if n == 126:
				n = struct.unpack(">H", self._read(2))[0]
			elif n == 127:
				n = struct.unpack(">Q", self._read(8))[0]
			payload = self._read(n)
			opcode = b0 & 0x0F
			if opcode == 8:
				return
			if opcode == 9:
				self.send(payload, opcode=10)
			elif opcode == 1:
				yield payload.decode("utf-8", "replace")


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

	def port(self, inner):
		out = self.compose("port", "api", str(inner)).stdout.strip()
		host, _, port = out.rpartition(":")
		host = host.strip("[]")
		loopback_only(host if host != "0.0.0.0" else "invalid")
		return host, int(port)

	def get(self, path, method="GET"):
		req = Request(self.base + path, method=method, data=b"{}" if method == "POST" else None,
			headers={"Content-Type": "application/json"} if method == "POST" else {})
		with self.opener.open(req, timeout=5) as response:
			return json.load(response)

	def write_config(self, entry, cu8_meta):
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

	def run(self, entry, cu8, cu8_meta):
		self.dir.mkdir(parents=True, exist_ok=True)
		config = self.write_config(entry, cu8_meta)
		self.env = dict(os.environ, EVIDENCE_SQUELCH_CU8=cu8.name, EVIDENCE_SQUELCH_DATA=str(cu8.parent.resolve()),
			EVIDENCE_SQUELCH_CONFIG=str(config.resolve()), EVIDENCE_SQUELCH_RATE=str(self.args.rate),
			EVIDENCE_SQUELCH_DURATION=str(int(self.args.seconds) + 300),
			EVIDENCE_SQUELCH_CORE_QUOTA=str(self.args.cpu_quota or 0))
		threads = []
		try:
			self.compose("up", "-d", "--no-build", "--pull", "never", timeout=180)
			host, api = self.port(API_PORT)
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
				(self.record_stream, self.port(STREAM_PORT)), (self.record_ws, (host, api)), (self.poll, ()))]
			for t in threads:
				t.start()
			end = time.monotonic() + self.args.seconds
			while time.monotonic() < end and not self.stop.is_set():
				time.sleep(0.5)
			if "error" in self.obs:
				raise InvalidRun(self.obs["error"])
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
		loopback_only(host)
		try:
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
							break
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
			ws = WsClient(host, port, ["live-audio"])
			ws.sock.settimeout(2)
			messages = ws.messages()
			while not self.stop.is_set():
				try:
					text = next(messages)
				except socket.timeout:
					continue
				except (StopIteration, EOFError):
					break
				msg = json.loads(text)
				kind = msg.get("type")
				if kind == "live-audio:level":
					self.obs["levels"].append((time.monotonic(), msg.get("data")))
				elif kind == "live-audio:transmission":
					self.obs["transmissions"].append(dict(msg.get("data") or {}, mono=time.monotonic()))
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


def to_8k(path, rate):
	data = path.read_bytes()
	samples = struct.unpack(f"<{len(data) // 2}h", data[: len(data) // 2 * 2])
	if rate % REF_RATE:
		raise InvalidRun(f"audio rate {rate} is not a multiple of {REF_RATE}")
	k = rate // REF_RATE
	return [sum(samples[i : i + k]) / (k * 32768) for i in range(0, len(samples) - k + 1, k)]


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
	obs = {"expect": entry["expect"], "reference8k": reference(name), "refOnset8k": int(entry["overOnsetS"] * REF_RATE)}
	for mode in ("auto", "manual"):
		path = run_dir / mode / "observations.json"
		if not path.exists():
			raise InvalidRun(f"missing {path}")
		side = json.loads(path.read_text())
		side["dir"] = str(run_dir / mode)
		if "audioRate" not in side or "streamT0" not in side:
			raise InvalidRun(f"{name} {mode}: no stream recorded")
		side["samples8k"] = to_8k(run_dir / mode / "stream.s16le", side["audioRate"])
		side["drainsMs"] = drains(side) if mode == "manual" else []
		obs[mode] = side
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
