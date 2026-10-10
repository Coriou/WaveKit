#!/usr/bin/env python3
"""Reduce run_capacity.py output directories to one JSON summary per run.

usage: summarize.py output/capacity/<run> [...]  (prints JSON lines)

Window figures use the first and last sampler records. The sampler's own CPU
is subtracted using its last per-process snapshot. "maxSampledBufferBytes" is
the largest branch queue seen at a sample instant. It is a lower bound, not a
true high-water mark, because the fanout does not export a peak.

With the channelizer on, "channelizer" reduces the app.log lines inside the
measurement window: dropped and saturated samples are the growth of
wavekit-chan's cumulative counters over the window (the last "channelizer
stats" line in the window minus the last one before it; a channel with no line
before the window opened inside it and counts from zero), and only
queue-overflow discontinuities inside the window count. The queue high-water
mark is wavekit-chan's maximum since the channel opened, so it includes the
warm-up; "queueHighWaterBytesAtWindowStart" is its value before the window.
"cpuCores.wavekitChan" is the wavekit-chan processes' CPU over the window.

"decodedSet" (fixture runs) is the signal instance's outputs.jsonl reduced like
the golden harness's keySet: the sorted distinct key tuples over the fixture's
expected.key_fields, counting only expected.output_types (else every type but
stats/error/sync). After the per-run lines, one "decodedSetComparison" line per
channelizer-on cell compares it with the channelizer-off, --buffers on cell of
the same fixture, rate, channels, placement and playback (addendum §9: the
same decoded set as the bounded-CSDR path). A collector that did not exit 0
never compares equal.

Clock domains: pino's `time` in app.log and the sampler's `ts` both come from
the container clock (sampler.py runs inside wkcap-app), so the window is the
first-to-last sampler span. meta "windowWall" is the driver's host clock; it is
used only if the sampler records carry no `ts`, and its offset from the sampler
span is reported as "windowCoverage.hostClockSkewS". "windowCoverage" also
gives the number of stats lines inside the window and how far the first and
last of them sit from the window edges. With the channelizer on, "warnings"
flags a window with no stats line, or one whose stats lines leave more than one
stats interval (plus jitter) uncovered at either edge: its channelizer figures
would otherwise read as zero.
"""

import collections
import datetime
import json
import sys
from pathlib import Path


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def by_id(rows):
    return {row.get("id"): row for row in rows} if isinstance(rows, list) else {}


UNCOUNTED_TYPES = {"stats", "error", "sync"}  # as tests/integration/fixtures/harness.ts
STATS_INTERVAL_S = 5  # wavekit-chan emits "stats" every 5 s (addendum §11)
COVERAGE_SLACK_S = STATS_INTERVAL_S + 2


def log_seconds(value):
    """A pino `time` (isoTime string, or epoch ms) in epoch seconds, or None."""
    if isinstance(value, (int, float)):
        return value / 1000
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def channelizer_stats(app_log, window=None):
    """Reduce the pino lines of a WaveKit log to channelizer queue, drop and saturation figures.

    `window` is (start, end) in epoch seconds; without it every line is inside. Lines after the
    window are ignored. A cumulative counter that goes down restarted (a new wavekit-chan
    generation) and counts again from zero.
    """
    high_water, high_water_before, dropped, saturated = {}, {}, {}, {}
    last = {}  # channel id -> (droppedSamples, saturatedSamples) as last reported
    overflows = 0
    stats_times = []  # times of the stats lines inside the window
    for line in app_log.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        inside = True
        t = log_seconds(entry.get("time"))
        if window is not None:
            if t is None or t > window[1]:
                continue
            inside = t >= window[0]
        if entry.get("msg") == "Channel discontinuity" and entry.get("cause") == "queue-overflow":
            if inside:
                overflows += 1
        elif entry.get("msg") == "channelizer stats":
            if inside:
                stats_times.append(t)
            for channel in entry.get("channels") or []:
                cid = channel.get("id")
                now = (channel.get("droppedSamples", 0), channel.get("saturatedSamples", 0))
                before = last.get(cid, (0, 0))
                last[cid] = now
                peaks = high_water if inside else high_water_before
                peaks[cid] = max(peaks.get(cid, 0), channel.get("queueHighWaterBytes", 0))
                if inside:
                    for totals, value, previous in ((dropped, now[0], before[0]), (saturated, now[1], before[1])):
                        totals[cid] = totals.get(cid, 0) + (value - previous if value >= previous else value)
    edges = window is not None and stats_times
    coverage = {"statsLines": len(stats_times),
                "firstStatsAfterStartS": round(stats_times[0] - window[0], 1) if edges else None,
                "lastStatsBeforeEndS": round(window[1] - stats_times[-1], 1) if edges else None}
    return {"queueHighWaterBytes": high_water, "queueHighWaterBytesAtWindowStart": high_water_before,
            "droppedSamples": dropped, "saturatedSamples": saturated, "queueOverflowEvents": overflows,
            "windowCoverage": coverage}


def decoded_set(outputs_text, key_fields, output_types=None):
    """The collector's output lines as {"count", "keys"}: keys are JSON arrays of key_fields, sorted, distinct."""
    keys, count = set(), 0
    for line in outputs_text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        output = entry.get("output") if isinstance(entry, dict) and entry.get("kind") == "output" else None
        if not isinstance(output, dict):
            continue
        kind = output.get("type")
        if (kind not in output_types) if output_types else (kind in UNCOUNTED_TYPES):
            continue
        data = output.get("data") if isinstance(output.get("data"), dict) else {}
        count += 1
        keys.add(json.dumps([data.get(k) for k in key_fields], separators=(",", ":")))
    return {"count": count, "keys": sorted(keys)}


def decoded_set_comparisons(summaries):
    """One comparison per channelizer-on run that has a bounded-CSDR (off, buffers on) run of the same cell."""
    def cell(r):
        m = r.get("matrix") or {}
        return ((m.get("fixture") or {}).get("id"), r.get("rate"), m.get("channels"), m.get("placement"),
                m.get("playback"))
    runs = [r for r in summaries if r.get("decodedSet")]
    reference = {cell(r): r for r in runs
                 if (r.get("matrix") or {}).get("channelizer") == "off" and r.get("buffers") == "on"}
    comparisons = []
    for r in runs:
        ref = reference.get(cell(r))
        if (r.get("matrix") or {}).get("channelizer") != "on" or ref is None:
            continue
        on, off = set(r["decodedSet"]["keys"]), set(ref["decodedSet"]["keys"])
        fixture, rate, channels, placement, playback = cell(r)
        row = {"fixture": fixture, "rate": rate, "channels": channels, "placement": placement,
               "playback": playback, "channelizerRun": r["run"], "boundedCsdrRun": ref["run"],
               "equal": on == off, "onlyBoundedCsdr": sorted(off - on), "onlyChannelizer": sorted(on - off)}
        failed = [f"collector exit {x['decodedSet']['collectorExit']} ({x['run']})" for x in (ref, r)
                  if x["decodedSet"]["collectorExit"] != 0]
        if failed:
            row["equal"] = False
            row["error"] = "; ".join(failed)
        comparisons.append({"decodedSetComparison": row})
    return comparisons


def coverage_warnings(stats):
    """Why the window's channelizer figures cannot be trusted (channelizer on), if anything."""
    coverage = stats["windowCoverage"]
    if coverage["statsLines"] == 0:
        return ["channelizer: no channelizer stats line inside the window (clock mismatch, or the "
                "channelizer not running): its figures read as zero but are not measured"]
    warnings = []
    if (coverage["firstStatsAfterStartS"] or 0) > COVERAGE_SLACK_S:
        warnings.append(f"channelizer: first stats line {coverage['firstStatsAfterStartS']} s after the window start")
    if (coverage["lastStatsBeforeEndS"] or 0) > COVERAGE_SLACK_S:
        warnings.append(f"channelizer: last stats line {coverage['lastStatsBeforeEndS']} s before the window end")
    return warnings


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
    chan_cpu = 0.0
    if snapshots:
        before = {p["pid"]: p["utime"] + p["stime"] for p in snapshots[0]["procs"]
                  if p["cmd"] == "wavekit-chan"}
        chan_cpu = sum(p["utime"] + p["stime"] - before.get(p["pid"], 0.0)
                       for p in snapshots[-1]["procs"] if p["cmd"] == "wavekit-chan")

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
            "offeredBytes": row["totalBytesWritten"] - before.get("totalBytesWritten", 0),
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
    total_written = sum(r["offeredBytes"] for r in branch_rows.values())
    total_dropped = sum(r["droppedBytes"] for r in branch_rows.values())
    chan = groups.get("wavekit-chan", collections.Counter())
    app_log = (run / "app.log").read_text(errors="replace") if (run / "app.log").exists() else ""
    wall = meta.get("windowWall") or {}
    has_wall = isinstance(wall.get("start"), (int, float)) and isinstance(wall.get("end"), (int, float))
    has_ts = isinstance(first.get("ts"), (int, float)) and isinstance(last.get("ts"), (int, float))
    window = (first["ts"], last["ts"]) if has_ts else (wall["start"], wall["end"]) if has_wall else None
    chan_stats = channelizer_stats(app_log, window)
    chan_stats["windowCoverage"]["hostClockSkewS"] = (
        round(wall["start"] - first["ts"], 1) if has_wall and has_ts else None)
    warnings = coverage_warnings(chan_stats) if meta.get("channelizer") == "on" else []
    outputs = run / "outputs.jsonl"
    decoded = None
    if meta.get("signalDecoder") and outputs.exists():
        decoded = {"decoderId": meta["signalDecoder"], "collectorExit": meta.get("collectorExit"),
                   **decoded_set(outputs.read_text(errors="replace"), meta.get("keyFields") or [],
                                 meta.get("outputTypes"))}
    return {
        "run": run.name,
        "rate": meta["rate"], "buffers": meta["buffers"], "decoders": meta["decoders"],
        "matrix": {k: meta.get(k) for k in ("channelizer", "channels", "placement", "placements",
                                            "fixture", "playback", "wavekitChanVersion")},
        "decoderStatus": meta.get("decoderStatus"),
        "windowSeconds": round(seconds, 1), "aborted": meta.get("aborted"),
        "cpuCores": {"total": round((cpu("usage_usec") - sampler_cpu) / seconds, 3),
                     "user": round(cpu("user_usec") / seconds, 3),
                     "system": round(cpu("system_usec") / seconds, 3),
                     "samplerCores": round(sampler_cpu / seconds, 4),
                     "wavekitChan": round(chan_cpu / seconds, 3),
                     "throttledSeconds": round(cpu("throttled_usec"), 2)},
        "memoryMiB": {"cgroupMax": round(max(s["mem"]["current"] for s in samples) / 2**20),
                      "cgroupPeakSinceStart": round(last["mem"]["peak"] / 2**20),
                      "shmemMax": round(max((s["mem"]["shmem"] or 0) for s in samples) / 2**20),
                      "anonMax": round(max((s["mem"]["anon"] or 0) for s in samples) / 2**20),
                      "csdrProcs": csdr["n"],
                      "csdrRss": round(csdr["rssKiB"] / 1024), "csdrPss": round(csdr["pssKiB"] / 1024),
                      "csdrPssShmem": round(csdr["pssShmemKiB"] / 1024),
                      "wavekitChanProcs": chan["n"], "wavekitChanPss": round(chan["pssKiB"] / 1024),
                      "allPss": round(sum(g["pssKiB"] for g in groups.values()) / 1024)},
        "pssByCommandMiB": {k: round(v["pssKiB"] / 1024, 1) for k, v in
                            sorted(groups.items(), key=lambda kv: -kv[1]["pssKiB"])[:16]},
        "oomKillsSinceStart": last["memEvents"].get("oom_kill", 0),
        "firstOomSampleT": first_oom,
        # totalBytesWritten counts every byte offered to the branch, including
        # the bytes dropped, so the drop fraction is dropped / offered.
        "branchTotals": {"offeredBytes": total_written, "droppedBytes": total_dropped,
                         "dropFraction": round(total_dropped / total_written, 6)
                         if total_written else None},
        "branches": branch_rows,
        "channelizer": chan_stats,
        "warnings": warnings,
        "decoders": decoders,
        "decodedSet": decoded,
        "source": fake[-1] if fake else None,
        "sourceConnections": sum(1 for e in fake if e.get("event") == "connected"),
        "sourceDisconnects": sum(1 for e in fake if e.get("event") == "disconnected"),
        "minVmMemAvailableMiB": min((g["vmMemAvailableMiB"] for g in guard
                                     if g.get("vmMemAvailableMiB") is not None), default=None),
        "protect": [g["protect"] for g in guard[:: max(1, len(guard) // 4)]],
        "trajectory": trajectory,
    }


if __name__ == "__main__":
    summaries = [summarize(Path(argument)) for argument in sys.argv[1:]]
    for summary in summaries:
        print(json.dumps(summary))
    for comparison in decoded_set_comparisons(summaries):
        print(json.dumps(comparison))
