#!/usr/bin/env python3
"""Bench the LoRa/Meshtastic chain (sox resample, then the gr-lora_sdr wrapper) per stage.

For each committed LongFast capture and each variant, the capture is repeated --repeat
times, piped through `sox ... rate <opts> <bw*os>` and then
`python3 lora_meshtastic_decode.py --samp-rate <bw*os>`, with both stages pinned to one
CPU (os.sched_setaffinity, Linux only). Each stage's user+sys CPU comes from os.wait4 on
its own process, so sox and python are reported separately. The python figure is also
given net of its startup (gnuradio import + flowgraph build, measured with empty stdin),
which is a one-off cost of a long-running decoder.

A variant is NAME:OS_FACTOR:SOX_RATE_OPTIONS, for example `old:8:-h` (the former
1.024 -> 2.0 Msps path) or `new:4:-m -b 74` (the current default). An OS_FACTOR whose
rate equals --input-rate skips sox, as the decoder does. Variants come from repeated
--variant flags, else from LORA_BENCH_VARIANTS (semicolon-separated), else old and new.

Needs sox, python3, gnuradio + gr-lora_sdr and the wrapper: run it inside the core image
from the repository root, never against a live receiver:

    python3 scripts/fixtures/bench_lora_chain.py
    python3 scripts/fixtures/bench_lora_chain.py --variant 'os2:2:-m -b 74' --variant 'new:4:-m -b 74'

Exit status 1 when any run decodes fewer frames than it was fed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable

FIXTURES = ["lora_longfast_dc_snr10.cu8", "lora_longfast_dc_snrm5.cu8"]
DEFAULT_VARIANTS = ["old:8:-h", "new:4:-m -b 74"]
# fixtures/lora/README.md: the frame every capture holds.
EXPECTED_FROM = 169552957
EXPECTED_PAYLOAD_B64 = "aGVsbG8gd2F2ZWtpdA=="


def parse_variant(text: str) -> tuple[str, int, list[str]]:
    name, os_factor, opts = text.split(":", 2)
    factor = int(os_factor)
    if not name or factor < 1:
        raise argparse.ArgumentTypeError(f"bad variant {text!r}")
    return name, factor, opts.split()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fixtures", default="fixtures/lora", help="capture directory")
    parser.add_argument("--repeat", type=int, default=10,
                        help="copies of each 0.91 s capture fed per run (default 10)")
    parser.add_argument("--cpu", type=int, default=0,
                        help="CPU to pin both stages to; -1 leaves them unpinned")
    parser.add_argument("--input-rate", type=int, default=1_024_000)
    parser.add_argument("--bw", type=int, default=250_000)
    parser.add_argument("--sf", type=int, default=11)
    parser.add_argument("--cr", type=int, default=5)
    parser.add_argument("--wrapper", default="/usr/local/bin/lora_meshtastic_decode.py")
    parser.add_argument("--sox", default="sox")
    parser.add_argument("--variant", action="append", type=parse_variant,
                        help="NAME:OS_FACTOR:SOX_RATE_OPTIONS (repeatable)")
    parser.add_argument("--json", action="store_true", help="one JSON object per run")
    args = parser.parse_args()
    if args.variant is None:
        env = os.environ.get("LORA_BENCH_VARIANTS", "")
        texts = [t for t in env.split(";") if t.strip()] or DEFAULT_VARIANTS
        args.variant = [parse_variant(t.strip()) for t in texts]
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    return args


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


def wrapper_argv(args: argparse.Namespace, out_rate: int) -> list[str]:
    # Same argv as buildDecoderArgs() in src/decoders/builtin/lora-meshtastic.ts.
    return ["python3", args.wrapper, "--bw", str(args.bw), "--sf", str(args.sf),
            "--cr", str(args.cr), "--samp-rate", str(out_rate), "--frequency", "869525000",
            "--channel-key", "AQ==", "--region", "EU_868"]


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


def run_chain(args: argparse.Namespace, capture: Path, out_rate: int,
              rate_opts: list[str], preexec: Callable[[], None] | None) -> dict[str, Any]:
    started = time.monotonic()
    with open(capture, "rb") as source, tempfile.TemporaryFile() as py_err:
        sox = None
        stdin: Any = source
        if out_rate != args.input_rate:
            sox = subprocess.Popen(sox_argv(args.sox, args.input_rate, out_rate, rate_opts),
                                   stdin=source, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, preexec_fn=preexec)
            stdin = sox.stdout
        py = subprocess.Popen(wrapper_argv(args, out_rate), stdin=stdin,
                              stdout=subprocess.PIPE, stderr=py_err, preexec_fn=preexec)
        if sox is not None and sox.stdout is not None:
            sox.stdout.close()
        assert py.stdout is not None
        stdout = py.stdout.read()
        py.stdout.close()
        py_code, py_cpu = reap(py)
        sox_code, sox_cpu = reap(sox) if sox is not None else (0, 0.0)
        py_err.seek(0)
        err_tail = py_err.read().decode("utf-8", "replace").strip().splitlines()[-3:]
    return {"decodes": count_decodes(stdout), "sox_cpu_s": sox_cpu, "sox_exit": sox_code,
            "py_cpu_s": py_cpu, "py_exit": py_code, "wall_s": time.monotonic() - started,
            "py_stderr_tail": err_tail}


def startup_cpu(args: argparse.Namespace, out_rate: int,
                preexec: Callable[[], None] | None) -> float:
    """Wrapper CPU with empty stdin: gnuradio import plus flowgraph build and teardown."""
    py = subprocess.Popen(wrapper_argv(args, out_rate), stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          preexec_fn=preexec)
    return reap(py)[1]


def main() -> int:
    args = parse_args()
    preexec = pinner(args.cpu)
    failed = False
    with tempfile.TemporaryDirectory(prefix="lora-bench-") as tmp:
        captures: list[tuple[str, Path, float]] = []
        for name in FIXTURES:
            data = (Path(args.fixtures) / name).read_bytes()
            path = Path(tmp) / name
            path.write_bytes(data * args.repeat)
            # cu8: 2 bytes per complex sample.
            captures.append((name, path, len(data) * args.repeat / 2 / args.input_rate))
        if not args.json:
            print(f"repeat={args.repeat} cpu={args.cpu} input_rate={args.input_rate} "
                  f"bw={args.bw} sf={args.sf}")
            print(f"{'capture':28} {'variant':8} {'os':>2} {'rate':>8} {'dec':>5} "
                  f"{'sox s':>6} {'sox/s':>6} {'py s':>6} {'py0 s':>6} {'py/s':>6} "
                  f"{'pynet/s':>7} {'wall s':>6}")
        for name, factor, rate_opts in args.variant:
            out_rate = args.bw * factor
            py0 = startup_cpu(args, out_rate, preexec)
            for capture, path, signal_s in captures:
                r = run_chain(args, path, out_rate, rate_opts, preexec)
                ok = r["decodes"] == args.repeat and r["py_exit"] == 0 and r["sox_exit"] == 0
                failed = failed or not ok
                row = {"capture": capture, "variant": name, "os_factor": factor,
                       "samp_rate": out_rate, "sox_rate_opts": " ".join(rate_opts),
                       "signal_s": round(signal_s, 3), "expected": args.repeat,
                       "ok": ok, "py_startup_cpu_s": round(py0, 3),
                       "sox_cpu_per_signal_s": round(r["sox_cpu_s"] / signal_s, 4),
                       "py_cpu_per_signal_s": round(r["py_cpu_s"] / signal_s, 4),
                       "py_net_cpu_per_signal_s": round(max(0.0, r["py_cpu_s"] - py0) / signal_s, 4),
                       **{k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()}}
                if args.json:
                    print(json.dumps(row, sort_keys=True), flush=True)
                    continue
                print(f"{capture:28} {name:8} {factor:>2} {out_rate:>8} "
                      f"{r['decodes']:>2}/{args.repeat:<2} {r['sox_cpu_s']:6.2f} "
                      f"{row['sox_cpu_per_signal_s']:6.3f} {r['py_cpu_s']:6.2f} {py0:6.2f} "
                      f"{row['py_cpu_per_signal_s']:6.3f} {row['py_net_cpu_per_signal_s']:7.3f} "
                      f"{r['wall_s']:6.1f}{'' if ok else '  FAIL'}", flush=True)
                if not ok and r["py_stderr_tail"]:
                    print("    wrapper stderr: " + " | ".join(r["py_stderr_tail"]), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
