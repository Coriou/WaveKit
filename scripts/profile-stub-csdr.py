#!/usr/bin/env python3
"""Rate-only csdr stand-in for scratch-core profiling (profile-spectrum-main --load).

Never a DSP implementation: each stage reads stdin and writes synthetic noise at
the byte rate the real stage would produce, so the core's live-demod pipes,
squelch and audio paths see realistic volumes without csdr installed.

  convert -i u8|s8 -o float   x4 (x2 for s16), divided by the firdecimate factor
                              found in the parent shell command (the whole chain
                              is one `sh -c`), so the full-rate float stream never
                              crosses a pipe
  firdecimate N               x1 when convert already decimated, else 1/N
  fmdemod|amdemod|realpart    1/2 (complex float to real float)
  convert -i float -o s16     1/2
  anything else               x1
"""
import array
import os
import random
import re
import subprocess
import sys

args = sys.argv[1:]
joined = " ".join(args)


def parent_command() -> str:
	try:
		out = subprocess.run(
			["ps", "-o", "args=", "-p", str(os.getppid())],
			capture_output=True,
			text=True,
			timeout=2,
		)
		return out.stdout
	except Exception:
		return ""


def decimation_in(command: str) -> int:
	m = re.search(r"csdr firdecimate (\d+)", command)
	return int(m.group(1)) if m else 1


ratio = 1.0
unit = 4
s16_out = False
stage = args[0] if args else ""
if stage == "convert" and "-o float" in joined:
	widen = 2.0 if "-i s16" in joined else 4.0
	ratio = widen / decimation_in(parent_command())
	unit = 8
elif stage == "firdecimate":
	ratio = 1.0 if "convert -i" in parent_command() else 1.0 / max(1, int(args[1]))
	unit = 8
elif stage in ("fmdemod", "amdemod", "realpart"):
	ratio = 0.5
elif stage == "convert" and "-o s16" in joined:
	ratio = 0.5
	unit = 2
	s16_out = True
elif stage in ("shift", "bandpass"):
	unit = 8

rng = random.Random(1)
if s16_out:
	pattern = array.array("h", (int(rng.gauss(0, 300)) for _ in range(32768))).tobytes()
else:
	pattern = array.array("f", (rng.gauss(0, 0.01) for _ in range(16384))).tobytes()

stdin = sys.stdin.buffer
stdout = sys.stdout.buffer
total_in = 0
written = 0
pos = 0
try:
	while True:
		data = stdin.read1(65536)
		if not data:
			break
		total_in += len(data)
		due = int(total_in * ratio) // unit * unit - written
		while due > 0:
			n = min(due, len(pattern) - pos)
			stdout.write(pattern[pos : pos + n])
			pos = (pos + n) % len(pattern)
			written += n
			due -= n
		stdout.flush()
except (BrokenPipeError, KeyboardInterrupt):
	pass
