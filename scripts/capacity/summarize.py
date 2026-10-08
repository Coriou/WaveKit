#!/usr/bin/env python3
"""Reduce run_capacity.py output directories to one JSON summary per run.

usage: summarize.py output/capacity/<run> [...]  (prints JSON lines)

Window figures use the first and last sampler records. The sampler's own CPU
is subtracted using its last per-process snapshot. "maxSampledBufferBytes" is
the largest branch queue seen at a sample instant. It is a lower bound, not a
true high-water mark, because the fanout does not export a peak.
"""

import collections
import json
import sys
from pathlib import Path


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def by_id(rows):
    return {row.get("id"): row for row in rows} if isinstance(rows, list) else {}


def summarize(run):
    meta = json.loads((run / "meta.json").read_text())
    samples = load(run / "samples.jsonl") if (run / "samples.jsonl").exists() else []
    if len(samples) < 2:
        return {"run": run.name, "meta": meta, "error": "fewer than two samples"}
    first, last = samples[0], samples[-1]
    seconds = last["ts"] - first["ts"]
    sampler_cpu = 0.0
    snapshots = [s for s in samples if "procs" in s]
    if snapshots:
        sampler_cpu = sum(p["utime"] + p["stime"] for p in snapshots[-1]["procs"]
                          if p["cmd"] == "python sampler.py")
        first_sampler = sum(p["utime"] + p["stime"] for p in snapshots[0]["procs"]
                            if p["cmd"] == "python sampler.py")
        sampler_cpu -= first_sampler

    def cpu(key):
        return (last["cpu"][key] - first["cpu"][key]) / 1e6

    groups = collections.defaultdict(lambda: collections.Counter())
    for proc in snapshots[-1]["procs"] if snapshots else []:
        group = groups[proc["cmd"]]
        group["n"] += 1
        for field in ("rssKiB", "pssKiB", "pssShmemKiB", "pssAnonKiB"):
            group[field] += proc[field]
    csdr = collections.Counter()
    for name, group in groups.items():
        if name.startswith("csdr"):
            csdr.update(group)

    branches_first, branches_last = by_id(first["branches"]), by_id(last["branches"])
    branch_rows = {}
    max_buffer = collections.Counter()
    for sample in samples:
        for bid, row in by_id(sample["branches"]).items():
            max_buffer[bid] = max(max_buffer[bid], row.get("bufferBytes", 0))
    for bid, row in branches_last.items():
        before = branches_first.get(bid, {})
        branch_rows[bid] = {
            "droppedBytes": row["droppedBytesTotal"] - before.get("droppedBytesTotal", 0),
            "droppedChunks": row["droppedChunksTotal"] - before.get("droppedChunksTotal", 0),
            "droppedBytesSinceStart": row["droppedBytesTotal"],
            "writtenBytes": row["totalBytesWritten"] - before.get("totalBytesWritten", 0),
            "backpressureEnters": row["backpressureEnterCount"] - before.get("backpressureEnterCount", 0),
            "maxSampledBufferBytes": max_buffer[bid],
            "highWaterMark": row.get("highWaterMark"),
        }
    dec_first, dec_last = by_id(first["decoders"]), by_id(last["decoders"])
    decoders = {
        did: {"restartsInWindow": row.get("restartCount", 0) - dec_first.get(did, {}).get("restartCount", 0),
              "restartsSinceStart": row.get("restartCount", 0), "running": row.get("running"),
              "health": row.get("health")}
        for did, row in dec_last.items()
    }
    fake = [json.loads(line) for line in (run / "fake.log").read_text().splitlines()
            if line.startswith("{")] if (run / "fake.log").exists() else []
    guard = load(run / "guard.jsonl") if (run / "guard.jsonl").exists() else []
    trajectory = [{"t": s["t"], "currentMiB": round(s["mem"]["current"] / 2**20),
                   "shmemMiB": round((s["mem"]["shmem"] or 0) / 2**20),
                   "oomKill": s["memEvents"].get("oom_kill", 0)} for s in samples]
    first_oom = next((s["t"] for s in samples if s["memEvents"].get("oom_kill", 0) > 0), None)
    total_written = sum(r["writtenBytes"] for r in branch_rows.values())
    total_dropped = sum(r["droppedBytes"] for r in branch_rows.values())
    return {
        "run": run.name,
        "rate": meta["rate"], "buffers": meta["buffers"], "decoders": meta["decoders"],
        "windowSeconds": round(seconds, 1), "aborted": meta.get("aborted"),
        "cpuCores": {"total": round((cpu("usage_usec") - sampler_cpu) / seconds, 3),
                     "user": round(cpu("user_usec") / seconds, 3),
                     "system": round(cpu("system_usec") / seconds, 3),
                     "samplerCores": round(sampler_cpu / seconds, 4),
                     "throttledSeconds": round(cpu("throttled_usec"), 2)},
        "memoryMiB": {"cgroupMax": round(max(s["mem"]["current"] for s in samples) / 2**20),
                      "cgroupPeakSinceStart": round(last["mem"]["peak"] / 2**20),
                      "shmemMax": round(max((s["mem"]["shmem"] or 0) for s in samples) / 2**20),
                      "anonMax": round(max((s["mem"]["anon"] or 0) for s in samples) / 2**20),
                      "csdrProcs": csdr["n"],
                      "csdrRss": round(csdr["rssKiB"] / 1024), "csdrPss": round(csdr["pssKiB"] / 1024),
                      "csdrPssShmem": round(csdr["pssShmemKiB"] / 1024),
                      "allPss": round(sum(g["pssKiB"] for g in groups.values()) / 1024)},
        "pssByCommandMiB": {k: round(v["pssKiB"] / 1024, 1) for k, v in
                            sorted(groups.items(), key=lambda kv: -kv[1]["pssKiB"])[:16]},
        "oomKillsSinceStart": last["memEvents"].get("oom_kill", 0),
        "firstOomSampleT": first_oom,
        "branchTotals": {"writtenBytes": total_written, "droppedBytes": total_dropped,
                         "dropFraction": round(total_dropped / (total_written + total_dropped), 6)
                         if total_written + total_dropped else None},
        "branches": branch_rows,
        "decoders": decoders,
        "source": fake[-1] if fake else None,
        "sourceConnections": sum(1 for e in fake if e.get("event") == "connected"),
        "sourceDisconnects": sum(1 for e in fake if e.get("event") == "disconnected"),
        "minVmMemAvailableMiB": min((g["vmMemAvailableMiB"] for g in guard
                                     if g.get("vmMemAvailableMiB") is not None), default=None),
        "protect": [g["protect"] for g in guard[:: max(1, len(guard) // 4)]],
        "trajectory": trajectory,
    }


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        print(json.dumps(summarize(Path(argument))))
