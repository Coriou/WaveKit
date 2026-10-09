#!/usr/bin/env python3
"""In-container sampler for WaveKit software capacity runs (Linux, cgroup v2).

The sampler runs inside the WaveKit container under test. It only reads /proc,
/sys/fs/cgroup and the local WaveKit API, and it writes JSON lines to --out.
Each interval it records:
  - cgroup CPU (user/system usec), memory.current/peak, anon/shmem/file,
    memory.events (oom, oom_kill)
  - VM-wide MemAvailable from /proc/meminfo, so the driver can stop the run
    before the shared VM gets starved
  - decoder restart counts and running state (GET /api/decoders)
  - fanout branch counters (GET /api/telemetry/fanout/branches)
Every --proc-every samples, and once more at the end, it also records each
process's smaps_rollup (Rss/Pss/Pss_Anon/Pss_Shmem) and utime/stime, labelled
by command (for example "csdr firdecimate"). The sampler subtracts its own CPU
in the summary step, not here, because it records /proc/self/stat as well.
"""

import argparse
import json
import os
import time
import urllib.request

CG = "/sys/fs/cgroup"
TICK = os.sysconf("SC_CLK_TCK")


def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def kv(text):
    out = {}
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            try:
                out[parts[0].rstrip(":")] = int(parts[1])
            except ValueError:
                pass
    return out


def api(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as r:
            return json.loads(r.read())
    except Exception as error:  # noqa: BLE001 - recorded, never fatal
        return {"error": str(error)}


def label(pid):
    raw = read(f"/proc/{pid}/cmdline")
    if not raw:
        return None
    argv = [a for a in raw.split("\0") if a]
    if not argv:
        return None
    exe = os.path.basename(argv[0])
    if exe == "csdr":
        sub = next((a for a in argv[1:] if not a.startswith("-")), "?")
        return f"csdr {sub}"
    if exe in ("python3", "python") and len(argv) > 1:
        return f"python {os.path.basename(argv[1])}"
    if exe == "node" and len(argv) > 1:
        return f"node {os.path.basename(argv[-1])}"
    return exe


def processes():
    rows = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        lab = label(pid)
        if lab is None:
            continue
        smaps = kv(read(f"/proc/{pid}/smaps_rollup"))
        stat = read(f"/proc/{pid}/stat")
        utime = stime = 0
        if stat:
            fields = stat[stat.rfind(")") + 2:].split()
            utime, stime = int(fields[11]) / TICK, int(fields[12]) / TICK
        rows.append({
            "pid": pid, "cmd": lab,
            "rssKiB": smaps.get("Rss", 0), "pssKiB": smaps.get("Pss", 0),
            "pssAnonKiB": smaps.get("Pss_Anon", 0), "pssShmemKiB": smaps.get("Pss_Shmem", 0),
            "utime": utime, "stime": stime,
        })
    return rows


def sample(port, with_procs):
    cpu = kv(read(f"{CG}/cpu.stat"))
    mem = kv(read(f"{CG}/memory.stat"))
    meminfo = kv(read("/proc/meminfo"))
    record = {
        "ts": time.time(),
        "cpu": {k: cpu.get(k) for k in ("usage_usec", "user_usec", "system_usec",
                                         "nr_throttled", "throttled_usec")},
        "mem": {
            "current": int((read(f"{CG}/memory.current") or "0").strip() or 0),
            "peak": int((read(f"{CG}/memory.peak") or "0").strip() or 0),
            "anon": mem.get("anon"), "shmem": mem.get("shmem"), "file": mem.get("file"),
        },
        "memEvents": kv(read(f"{CG}/memory.events")),
        "vmMemAvailableKiB": meminfo.get("MemAvailable"),
        "decoders": api(port, "/api/decoders"),
        "branches": api(port, "/api/telemetry/fanout/branches"),
    }
    if with_procs:
        record["procs"] = processes()
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--proc-every", type=int, default=6)
    options = parser.parse_args()
    start = time.monotonic()
    index = 0
    with open(options.out, "a") as out:
        while True:
            elapsed = time.monotonic() - start
            final = elapsed >= options.duration
            record = sample(options.port, final or index % options.proc_every == 0)
            record["t"] = round(elapsed, 2)
            record["final"] = final
            out.write(json.dumps(record) + "\n")
            out.flush()
            if final:
                break
            index += 1
            time.sleep(max(0, start + index * options.interval - time.monotonic()))


if __name__ == "__main__":
    main()
