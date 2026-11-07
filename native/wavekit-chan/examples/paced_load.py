#!/usr/bin/env python3
"""Paced process-level CPU probe of one wavekit-chan; synthetic noise, no RF, no network.

python3 native/wavekit-chan/examples/paced_load.py <release-binary> \
    --rate 1024000 --channels 4 --chunk 65536 --seconds 20 --consumer fast

Writes cu8 to the child's stdin at real time in chunks of --chunk bytes, the way the fanout
branch does, with IQ channels open over Unix sockets read by a separate consumer process.
Prints one JSON line: child CPU in ms per second of IQ split user/system, voluntary and
involuntary context switches per second of IQ (where the OS fills them in), per-thread CPU
from `ps -M` where available, output bytes, and the host load average before and after.
A run takes at most --seconds plus start and stop, and is refused above 60 s of IQ.
"""
import argparse
import json
import os
import queue
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

CENTER_HZ = 100_000_000  # synthetic; nothing tunes
NOISE_BYTES = 1 << 22


def consumer_main(paths, mode):
    """One process, one selector loop. Exits on EOF of every socket; prints the bytes read."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    selector = selectors.DefaultSelector()
    socks = []
    for path in paths:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        for _ in range(500):
            try:
                s.connect(path)
                break
            except OSError:
                time.sleep(0.01)
        else:
            raise SystemExit(f"cannot connect {path}")
        socks.append(s)
    total = 0
    if mode == "stalled":
        # Connected, never reads: the writer blocks and the queue overflows.
        while True:
            time.sleep(1)
    for s in socks:
        s.setblocking(False)
        selector.register(s, selectors.EVENT_READ)
    open_count = len(socks)
    buf = bytearray(1 << 16)
    while open_count > 0:
        if mode == "slow":
            time.sleep(0.05)
        for key, _ in selector.select(timeout=1):
            try:
                n = key.fileobj.recv_into(buf)
            except BlockingIOError:
                continue
            except OSError:
                n = 0
            if n == 0:
                selector.unregister(key.fileobj)
                open_count -= 1
            total += n
    print(total, flush=True)


def per_thread(pid):
    """`ps -M` rows as [user s, system s]; empty where the platform has no such view."""
    try:
        out = subprocess.run(["ps", "-M", "-p", str(pid)], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return []
    lines = out.stdout.splitlines()
    if not lines:
        return []
    header = lines[0].split()
    if "UTIME" not in header or "STIME" not in header:
        return []

    def secs(text):
        parts = text.split(":")
        return round(sum(float(p) * 60 ** k for k, p in enumerate(reversed(parts))), 2)

    rows = []
    for line in lines[1:]:
        fields = line.split()
        # The first row carries the command at the end; times are always the last two
        # numeric-looking columns before it, so index from the header for thread rows.
        try:
            idx_s = len(fields) - 1
            while idx_s > 0 and ":" not in fields[idx_s]:
                idx_s -= 1
            rows.append([secs(fields[idx_s]), secs(fields[idx_s - 1])])  # user, system
        except (ValueError, IndexError):
            continue
    return rows


def run(a):
    if a.seconds > 60:
        raise SystemExit("at most 60 s of IQ per run")
    noise = bytearray(os.urandom(NOISE_BYTES))
    view = memoryview(noise)
    with tempfile.TemporaryDirectory(prefix="wk-paced-", dir="/tmp") as directory:
        ctl_read, ctl_write = os.pipe()
        argv = [
            os.path.abspath(a.binary), "--generation", "1", "--input-format", "cu8",
            "--input-rate", str(a.rate), "--input-center", str(CENTER_HZ),
            "--usable-fraction", "0.8", "--block-samples", str(a.block_samples),
            "--control-fd", str(ctl_read), "--socket-dir", directory,
        ]
        if a.dsp_helpers is not None:
            argv += ["--dsp-helpers", str(a.dsp_helpers)]
        proc = subprocess.Popen(argv, pass_fds=(ctl_read,), stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE)
        os.close(ctl_read)
        opened = {}
        lines = {"n": 0, "overflow": 0}
        ready = threading.Event()
        replies = queue.Queue()
        total = a.channels + a.unconnected

        def events():
            for raw in proc.stdout:
                lines["n"] += 1
                e = json.loads(raw)
                if e["type"] == "ready":
                    ready.set()
                elif e["type"] in ("opened", "rejected"):
                    replies.put(e)
                elif e["type"] == "discontinuity" and e.get("cause") == "queue-overflow":
                    lines["overflow"] += e["droppedSamples"]

        threading.Thread(target=events, daemon=True).start()
        assert ready.wait(30), "no ready"
        span = int(a.rate * 0.7)
        # One open at a time: the planner refuses a burst as busy.
        for n in range(total):
            offset = -span // 2 + (n + 1) * span // (total + 1)
            line = dict(v=1, type="open", id=f"ch{n}", centerHz=CENTER_HZ + offset,
                        bandwidthHz=a.bandwidth, transitionHz=a.transition,
                        outputRateHz=a.output_rate, format=a.format,
                        queueBytes=1 << 20)
            os.write(ctl_write, (json.dumps(line) + "\n").encode())
            reply = replies.get(timeout=60)
            if reply["type"] != "opened":
                raise SystemExit(f"rejected: {reply}")
            opened[reply["id"]] = reply["socket"]
        paths = [opened[f"ch{n}"] for n in range(a.channels)]
        consumer = None
        if paths:
            consumer = subprocess.Popen(
                [sys.executable, "-I", os.path.abspath(__file__), "--consume", a.consumer, *paths],
                stdout=subprocess.PIPE, text=True)
        load_before = os.getloadavg()[0]
        before = per_thread(proc.pid)
        total_bytes = int(a.rate * a.seconds) * 2
        period = a.chunk / (a.rate * 2)
        start = time.monotonic()
        sent = 0
        pos = 0
        behind_max = 0.0
        while sent < total_bytes:
            n = min(a.chunk, total_bytes - sent)
            if pos + n > NOISE_BYTES:
                pos = 0
            os.write(proc.stdin.fileno(), view[pos:pos + n])
            pos += n
            sent += n
            due = start + sent / (a.rate * 2)
            now = time.monotonic()
            if due > now:
                time.sleep(due - now)
            else:
                behind_max = max(behind_max, now - due)
        elapsed = time.monotonic() - start
        threads = per_thread(proc.pid)
        proc.stdin.close()
        # wait4 owns the exit: the rusage covers the whole child, every thread.
        _, status, usage = os.wait4(proc.pid, 0)
        proc.returncode = os.waitstatus_to_exitcode(status)
        os.close(ctl_write)
        out_bytes = None
        if consumer:
            if a.consumer == "stalled":
                consumer.kill()
            else:
                out_bytes = int(consumer.communicate(timeout=20)[0].strip() or 0)
            consumer.wait(timeout=5)
        delta = []
        for k, row in enumerate(threads):
            base = before[k] if k < len(before) else [0.0, 0.0]
            delta.append([round(row[0] - base[0], 2), round(row[1] - base[1], 2)])
        return dict(
            rate=a.rate, channels=a.channels, unconnected=a.unconnected, chunk=a.chunk,
            block=a.block_samples, consumer=a.consumer, helpers=a.dsp_helpers,
            bandwidth=a.bandwidth, output=a.output_rate, format=a.format,
            iq_s=round(sent / (a.rate * 2), 2), wall_s=round(elapsed, 2),
            pace_behind_max_ms=round(behind_max * 1000, 1), period_ms=round(period * 1000, 2),
            user_ms_per_iq_s=round(usage.ru_utime * 1000 / a.seconds, 1),
            sys_ms_per_iq_s=round(usage.ru_stime * 1000 / a.seconds, 1),
            nvcsw_per_iq_s=round(usage.ru_nvcsw / a.seconds),
            nivcsw_per_iq_s=round(usage.ru_nivcsw / a.seconds),
            minflt_per_iq_s=round(usage.ru_minflt / a.seconds),
            maxrss=usage.ru_maxrss,
            thread_user_sys_s=delta, out_bytes=out_bytes, event_lines=lines["n"],
            overflow_samples=lines["overflow"], exit=proc.returncode,
            load_before=round(load_before, 1), load_after=round(os.getloadavg()[0], 1),
        )


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--consume":
        consumer_main(sys.argv[3:], sys.argv[2])
        sys.exit(0)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("binary")
    parser.add_argument("--rate", type=int, default=1_024_000)
    parser.add_argument("--channels", type=int, default=4, help="channels with a connected consumer")
    parser.add_argument("--unconnected", type=int, default=0, help="channels no client ever connects to")
    parser.add_argument("--chunk", type=int, default=65536, help="bytes per stdin write")
    parser.add_argument("--seconds", type=float, default=20)
    parser.add_argument("--block-samples", type=int, default=16384)
    parser.add_argument("--dsp-helpers", type=int)
    parser.add_argument("--consumer", choices=["fast", "slow", "stalled"], default="fast")
    parser.add_argument("--bandwidth", type=int, default=12500)
    parser.add_argument("--transition", type=int, default=5000)
    parser.add_argument("--output-rate", type=int, default=48000)
    parser.add_argument("--format", default="cu8")
    print(json.dumps(run(parser.parse_args())), flush=True)
