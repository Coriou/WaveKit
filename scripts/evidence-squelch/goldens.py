#!/usr/bin/env python3
"""Analyzer goldens for the evidence squelch fixtures (A9, requirement 5.1).

For every fixture in fixtures.py: write the 48 kHz cf32 input to a temporary directory,
run `wavekit-iqcap analyze --in <abs cf32> --mode nfm|am` with fd 4 inherited to capture
the one JSON line, and store stdout as <name>.audio.s16le (8 kHz s16le) and the JSON as
<name>.stats.json next to manifest.json. Exits non-zero on any analyzer `reject`, on a
golden over its size bound, or when the medians do not give the manifest verdict.

The verdict check mirrors `isVoice` (median syllabic >= 0.3 and median audioDb >= -30)
and `dataLike` (median cluster >= 0.6) of src/core/scanner/analog-trial.ts with the
thresholds of src/core/scanner/scanner-redesign-contract.ts. It is a generation guard;
tests/unit/core/evidence-squelch/meter-equivalence.test.ts is the authority.

Usage: python3 -I scripts/evidence-squelch/goldens.py --out tests/mocks/fixtures/evidence-squelch
"""

import argparse
import importlib.util
import json
import os
import pathlib
import statistics
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
# Loaded under its own name: `fixtures` is also the repository's top-level package
# (fixtures/generators), which fixtures.py imports for POCSAG.
_spec = importlib.util.spec_from_file_location("evs_fixtures", HERE / "fixtures.py")
fixtures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fixtures)

ANALYZER = fixtures.REPO / "native/wavekit-chan/target/release/wavekit-iqcap"
# 4 s of 8 kHz s16le is 64 000 bytes; both files must stay within 64 KiB (A9).
MAX_GOLDEN_BYTES = 65_536
VOICE_INDEX = 0.3
AUDIO_MIN_DB = -30.0
DATA_SCORE = 0.6


def analyze(cf32, mode):
	# The child gets the pipe's write end as fd 4 (dup2 clears close-on-exec; when the
	# pipe already is fd 4, the flag is cleared directly).
	read_fd, write_fd = os.pipe()
	try:
		proc = subprocess.Popen(
			[str(ANALYZER), "analyze", "--in", str(cf32), "--mode", mode],
			stdin=subprocess.DEVNULL,
			stdout=subprocess.PIPE,
			stderr=subprocess.PIPE,
			close_fds=False,
			preexec_fn=lambda: os.set_inheritable(4, True) if write_fd == 4 else os.dup2(write_fd, 4),
		)
	finally:
		os.close(write_fd)
	audio, err = proc.communicate(timeout=60)
	with os.fdopen(read_fd, "rb") as events:
		lines = events.read().decode("utf-8", "replace").splitlines()
	if len(lines) != 1:
		raise SystemExit(f"analyze {cf32.name}: expected one event line, got {len(lines)} (exit {proc.returncode})")
	event = json.loads(lines[0])
	if proc.returncode != 0 or event.get("event") != "analysis":
		raise SystemExit(f"analyze {cf32.name}: reject {event.get('code')!r} (exit {proc.returncode}) {err.decode(errors='replace').strip()}")
	return audio, event


def verdict(frames):
	cluster = statistics.median(f["cluster"] for f in frames)
	if cluster >= DATA_SCORE:
		return "data-like"
	syllabic = statistics.median(f["syllabic"] for f in frames)
	audio = statistics.median(f["audioDb"] for f in frames)
	return "voice" if syllabic >= VOICE_INDEX and audio >= AUDIO_MIN_DB else "neither"


def main():
	p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
	p.add_argument("--out", type=pathlib.Path, required=True)
	p.add_argument("--fixture", default="all", help="manifest name or all (manifest.json is always complete)")
	args = p.parse_args()
	if args.fixture != "all" and args.fixture not in fixtures.FIXTURES:
		p.error("unknown fixture")
	if not ANALYZER.is_file():
		raise SystemExit(f"missing {ANALYZER.relative_to(fixtures.REPO)}: run make chan-build")
	args.out.mkdir(parents=True, exist_ok=True)
	entries = fixtures.manifest()
	failed = []
	with tempfile.TemporaryDirectory(prefix="evs-fx-") as tmp:
		for name, entry in entries.items():
			if args.fixture not in ("all", name):
				continue
			cf32 = pathlib.Path(tmp).resolve() / f"{name}.cf32"
			cf32.write_bytes(fixtures.cf32_bytes(fixtures.analyzer_fixture(name)))
			audio, event = analyze(cf32, entry["mode"])
			stats = json.dumps(event, indent="\t") + "\n"  # Prettier-conformant layout
			if len(audio) > MAX_GOLDEN_BYTES or len(stats) > MAX_GOLDEN_BYTES:
				raise SystemExit(f"{name}: golden over {MAX_GOLDEN_BYTES} bytes")
			(args.out / f"{name}.audio.s16le").write_bytes(audio)
			(args.out / f"{name}.stats.json").write_text(stats)
			frames = event["frames"]
			got = verdict(frames)
			med = {k: round(statistics.median(f[k] for f in frames), 2) for k in ("carrierDb", "hfNoiseDb", "audioDb", "syllabic", "cluster")}
			print(f"{name:22s} frames={len(frames)} audio={len(audio)}B stats={len(stats)}B verdict={got} {json.dumps(med)}")
			if got != entry["verdict"]:
				failed.append(f"{name}: verdict {got}, manifest {entry['verdict']}")
	(args.out / "manifest.json").write_text(json.dumps(entries, indent="\t") + "\n")
	if failed:
		print("\n".join(failed), file=sys.stderr)
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(main())
