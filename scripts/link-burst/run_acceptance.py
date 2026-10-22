#!/usr/bin/env python3
"""Run an isolated fake-link experiment using already available local images."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from urllib.request import ProxyHandler, build_opener

SOURCE = "link-burst-fake"
SINK = "link-burst-slow-sink"
INTERVALS = (9, 1, 130, 50, 40, 71, 161)
ROOT = Path(__file__).resolve().parent


def constant(name):
    text = (ROOT.parents[1] / "src/core/link-burst/contract.ts").read_text()
    match = re.search(r"export const " + name + r" = ([\d_]+)", text)
    if not match:
        raise ValueError("missing contract constant: " + name)
    return int(match[1].replace("_", ""))


def stall_schedule(scenario):
    lengths = (150, 500, 1000, 1800) if scenario == "lossless" else (2500, 4000)
    if scenario not in ("lossless", "overflow", "upstream", "late-shed"):
        return ""
    # Repeat the joint cycle, preserving both sequences across schedule wraps.
    import math
    return ",".join(f"{INTERVALS[i % len(INTERVALS)]}:{lengths[i % len(lengths)]}"
                    for i in range(math.lcm(len(INTERVALS), len(lengths))))


def branch_percent(branch):
    dropped = branch["droppedBytesTotal"]
    total = branch["totalBytesWritten"]
    return 100 * dropped / total if total else 0


class InvalidRun(Exception):
    pass


def interrupted(signum, _frame):
    raise InvalidRun("interrupted by " + signal.Signals(signum).name)


class Experiment:
    def __init__(self, args):
        self.args = args
        self.env = dict(os.environ)
        self.env.update(LINK_BURST_RATE=str(args.rate), LINK_BURST_SECONDS="2",
                        LINK_BURST_DURATION=str(args.minutes * 60 + 1800),
                        LINK_BURST_SCHEDULE=stall_schedule(args.scenario),
                        LINK_BURST_MODE="drop" if args.scenario == "upstream" else "catchup")
        if args.scenario == "late-shed":
            # Leave a bounded smooth graduation window without restarting the source.
            entries = stall_schedule("late-shed").split(",") * 20
            entries[0] = "600:2500"
            self.env["LINK_BURST_SCHEDULE"] = ",".join(entries)
        self.command = ["docker", "compose", "-p", f"wkburst-{os.getpid()}",
                        "-f", str(ROOT / "compose.yaml")]
        self.opener = build_opener(ProxyHandler({}))
        self.summary = {"scenario": args.scenario, "rate": args.rate, "sinkMode": "fast",
                        "sinkRestarts": 0, "branches": {}, "attributionCounts": {},
                        "overflowBytes": 0, "suspensions": [], "sheds": [],
                        "peakHeldBytes10m": 0, "peakHeldMs10m": 0,
                        "laggardExcludeMsMax10m": 0, "oneChunkMs": 0,
                        "ABSORBER_LAGGARD_MS": constant("ABSORBER_LAGGARD_MS")}
        self.previous = {}
        self.previous_eligible = {}
        self.order = {}
        self.attributions = Counter()
        self.first_drops = None
        self.slow_at = None
        self.pause_at = None
        self.phase = "graduating" if args.scenario == "late-shed" else "measuring"
        self.phase_at = None
        self.known_suspensions = set()
        self.sink_pid = None
        self.last_overflow = 0
        self.interval_failures = set()
        self.admission_groups = {}
        self.previous_sink_uptime = None
        self.consumer_baseline = None
        self.consumer_peaks = None
        self.upstream_baseline = None
        self.summary["upstreamDroppedBytes"] = 0

    def compose(self, *args, check=True):
        return subprocess.run(self.command + list(args), env=self.env, text=True,
                              capture_output=True, check=check, timeout=90)

    def get(self, path):
        with self.opener.open(self.base + path, timeout=5) as response:
            return json.load(response)

    def sentinel(self, rate):
        self.compose("exec", "-T", "core", "sh", "-c",
                     f"printf '%s' {rate} > /tmp/link-burst-slow")
        self.summary["sinkMode"] = "pause" if rate == 0 else "throttle"

    def sample(self, now):
        sample = {"mono": now, "phase": self.phase,
                  "linkQuality": self.get("/api/resources/link-quality"),
                  "efficiency": self.get("/api/decoders/efficiency"),
                  "fanout": self.get("/api/telemetry/fanout"),
                  "decoders": self.get("/api/decoders"),
                  "backpressure": self.get("/api/resources/backpressure")}
        return sample

    def record(self, sample):
        now = sample["mono"]
        reports = sample["linkQuality"]
        if not isinstance(reports, list):
            raise InvalidRun("link-quality response must be an array")
        report = next((r for r in reports if r.get("sourceId") == SOURCE), None)
        if report is None or report.get("transport") != "network":
            raise InvalidRun("fake source has no network link report")
        absorber = report["absorber"]
        if not absorber["enabled"]:
            raise InvalidRun("burst absorber is disabled")
        for key in ("peakHeldBytes10m", "peakHeldMs10m", "laggardExcludeMsMax10m"):
            self.summary[key] = max(self.summary[key], absorber[key] or 0)
        overflow = absorber["overflowBytesTotal"]
        if overflow < self.last_overflow:
            raise InvalidRun("absorber counter reset")
        # `at` is the report read time, not a completed monitor interval.
        # The API exposes no interval counter/attribution pair: never compare
        # live cumulative overflow with attribution.last from an earlier tick.
        if overflow > self.last_overflow and self.args.scenario in ("overflow", "upstream"):
            self.summary["overflowAttributionUnavailable"] = True
        self.last_overflow = overflow
        self.summary["overflowBytes"] = overflow
        histogram = report["histograms"]
        edges = histogram["chunkSizeBucketUpperBytes"]
        counts = histogram["chunkSizeCounts"]
        if len(edges) != len(counts) or not any(counts):
            raise InvalidRun("chunk histogram is missing samples")
        chunk = max(edge for edge, count in zip(edges, counts) if count)
        self.summary["oneChunkMs"] = max(self.summary["oneChunkMs"], chunk * 1000 / (self.args.rate * 2))
        attribution = report["attribution"]["last"]
        self.attributions[attribution or "unknown"] += 1
        self.summary["attributionCounts"] = dict(self.attributions)
        self.summary["attributionWindowCounts"] = report["attribution"]["counts10m"]
        upstream = next((b for b in sample["backpressure"] if b["sourceId"] == SOURCE), None)
        if self.args.scenario == "upstream":
            if upstream is None or not upstream["available"]:
                raise InvalidRun("upstream statistics are unavailable")
            total = upstream["bytesDroppedUpstream"]
            if self.upstream_baseline is None:
                self.upstream_baseline = total
            if total < self.upstream_baseline:
                raise InvalidRun("upstream counter reset")
            self.summary["upstreamDroppedBytes"] = total - self.upstream_baseline
        branches = [b for b in sample["fanout"]["branches"] if b.get("sourceId") == SOURCE]
        sinks = [b for b in branches if SINK in b["id"]]
        if len(sinks) != 1:
            raise InvalidRun("expected exactly one slow-sink fanout branch")
        sink = sinks[0]
        self.summary["sinkBranchId"] = sink["id"]
        for branch in branches:
            self.summary["branches"][branch["id"]] = {
                **branch, "dropPercent": branch_percent(branch), "sink": branch["id"] == sink["id"]}
        self.record_consumer(sample, absorber, branches)
        self.summary["sinkDropPercent"] = branch_percent(sink)
        if self.slow_at is not None and sink["droppedBytesTotal"] > self.sink_baseline:
            self.first_drops = self.first_drops if self.first_drops is not None else now
        decoder = next((d for d in sample["decoders"] if d.get("id") == SINK), None)
        if decoder is None:
            raise InvalidRun("slow-sink decoder is missing")
        self.summary["sinkRestarts"] = decoder["restartCount"]
        pid = decoder["pid"]
        if not decoder["running"]:
            raise InvalidRun("slow sink is not running")
        if self.sink_pid is not None and pid != self.sink_pid:
            raise InvalidRun("slow sink restarted")
        self.sink_pid = pid
        uptime = decoder["uptime"]
        if self.previous_sink_uptime is not None and uptime < self.previous_sink_uptime:
            raise InvalidRun("slow sink uptime reset")
        self.previous_sink_uptime = uptime
        if decoder["restartCount"] or decoder.get("health") in ("restarting", "faulted"):
            raise InvalidRun("slow sink restarted or faulted")
        sources = sample["efficiency"]["sources"]
        source = next((s for s in sources if s["sourceId"] == SOURCE), None)
        if source is None:
            raise InvalidRun("fake source has no efficiency view")
        admitted = {self.key(p): p for p in source["admitted"]}
        new_keys = [key for key, placement in admitted.items()
                    if placement.get("detail") != "configured" and key not in self.order]
        for key in new_keys:
            self.order[key] = len(self.order)
            self.admission_groups[key] = list(new_keys)
        for placement in source["blocked"]:
            key = self.key(placement)
            event = {"mono": now, "key": key, "admissionOrder": self.order.get(key),
                     "detail": placement.get("detail"), "phase": self.phase}
            identity = (key, placement.get("detail"), placement.get("retryAt"))
            if identity not in self.known_suspensions and key in self.previous:
                self.known_suspensions.add(identity)
                self.summary["suspensions"].append(event)
                if placement.get("detail") == "late-drops" and key in self.previous:
                    if key not in self.previous_eligible:
                        raise InvalidRun("shed placement was not an eligible graduated automatic catalogue placement")
                    newest = max(self.previous_eligible, key=lambda k: self.order[k])
                    event["expectedNewestKey"] = newest
                    self.summary["sheds"].append(event)
        statuses = {d["id"]: d for d in sample["decoders"]}
        self.previous_eligible = {
            key: p for key, p in admitted.items() if not p["probation"] and
            statuses.get(p["decoderId"], {}).get("mode") == "auto" and
            statuses.get(p["decoderId"], {}).get("origin") == "catalogue" and
            statuses.get(p["decoderId"], {}).get("startMode") == "auto"
        }
        self.previous = admitted
        return source, sink

    def record_consumer(self, sample, absorber, branches):
        if sample["phase"] != "consumer":
            return
        if self.consumer_baseline is None:
            self.consumer_baseline = {b["id"]: b["droppedBytesTotal"] for b in branches}
        self.summary["consumerSiblingDrops"] = max(self.summary.get("consumerSiblingDrops", 0), sum(
            max(0, b["droppedBytesTotal"] - self.consumer_baseline.get(b["id"], 0))
            for b in branches if SINK not in b["id"]))
        # Rolling maxima still contain the deliberately overflowing link phase
        # until a full ten-minute window has elapsed after the phase transition.
        if self.slow_at is not None and (self.args.scenario == "consumer" or sample["mono"] - self.slow_at >= 600):
            peak = max(absorber["peakHeldMs10m"], absorber["laggardExcludeMsMax10m"] or 0)
            self.consumer_peaks = max(self.consumer_peaks or 0, peak)
            self.summary["consumerPeakHeldMs"] = self.consumer_peaks

    @staticmethod
    def key(placement):
        return json.dumps([placement["decoderId"], placement["sourceId"], placement.get("channelHz")])

    def run(self):
        self.args.out.mkdir(parents=True, exist_ok=True)
        exit_code = 2
        handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            self.compose("up", "-d", "--no-build", "--pull", "never")
            deadline = time.monotonic() + 120
            while True:
                port = self.compose("port", "core", "3000", check=False).stdout.strip()
                if re.fullmatch(r"127\.0\.0\.1:\d+", port):
                    self.base = "http://" + port
                    try:
                        self.get("/api/decoders/efficiency")
                        break
                    except (OSError, ValueError):
                        pass
                if time.monotonic() >= deadline:
                    raise InvalidRun("API did not become ready")
                time.sleep(2)
            if self.args.scenario == "host":
                self.compose("exec", "-T", "-d", "core", "stress-ng", "--cpu", "0",
                             "--timeout", f"{int(self.args.minutes * 60 + 60)}s")
            start = time.monotonic()
            measured_at = start
            with (self.args.out / "samples.jsonl").open("w") as output:
                while True:
                    now = time.monotonic()
                    sample = self.sample(now)
                    output.write(json.dumps(sample) + "\n")
                    output.flush()
                    source, sink = self.record(sample)
                    if self.args.scenario == "late-shed" and self.phase == "graduating":
                        catalogue = [p for p in source["admitted"] if p.get("detail") != "configured"]
                        if catalogue and not any(p["probation"] for p in catalogue):
                            self.phase = "waiting-link"
                        elif now - start > 600:
                            raise InvalidRun("catalogue did not graduate within 10 minutes")
                    if self.args.scenario == "late-shed":
                        report = next(r for r in sample["linkQuality"] if r["sourceId"] == SOURCE)
                        stalled = (report["arrivals"]["worstStallMs"] or 0) >= 2500
                        if stalled and self.phase == "graduating":
                            raise InvalidRun("overflow started before catalogue graduation")
                        if stalled and self.phase == "waiting-link":
                            self.phase, self.phase_at = "link-only", now
                        if self.phase == "waiting-link" and now - start > 900:
                            raise InvalidRun("late-shed overflow phase did not start")
                    slow_due = ((self.args.scenario == "consumer" and now - start >= 60) or
                                (self.args.scenario == "late-shed" and self.phase == "link-only" and
                                 now - self.phase_at >= 180))
                    if slow_due and self.slow_at is None:
                        self.sentinel(131072)
                        self.slow_at, self.sink_baseline = now, sink["droppedBytesTotal"]
                        self.phase = "consumer"
                        self.consumer_baseline = {
                            b["id"]: b["droppedBytesTotal"] for b in sample["fanout"]["branches"]
                            if b.get("sourceId") == SOURCE}
                    if self.slow_at is not None and self.first_drops is None:
                        if self.pause_at is None and now - self.slow_at >= 120:
                            self.sentinel(0)
                            self.pause_at = now
                        if self.pause_at is not None and now - self.pause_at >= 120:
                            raise InvalidRun("slow sink never dropped in pause mode")
                    if self.args.scenario in ("consumer", "late-shed"):
                        measured_at = self.first_drops
                    if measured_at is not None and now - measured_at >= self.args.minutes * 60:
                        self.summary["measuredSeconds"] = now - measured_at
                        break
                    time.sleep(2)
            failures = self.failures()
            self.summary["failures"] = failures
            self.summary["result"] = "fail" if failures else "pass"
            exit_code = 1 if failures else 0
        except (InvalidRun, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            self.summary.update(result="invalid", invalidReason=str(exc))
        finally:
            # A repeated termination request must not interrupt teardown.
            for sig in handlers:
                signal.signal(sig, signal.SIG_IGN)
            try:
                self.compose("down", "--volumes", "--remove-orphans")
            except (OSError, subprocess.SubprocessError) as exc:
                self.summary.update(result="invalid", invalidReason="teardown failed: " + str(exc))
                exit_code = 2
            (self.args.out / "summary.json").write_text(json.dumps(self.summary, indent=2) + "\n")
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
        return exit_code

    def failures(self):
        failures = sorted(self.interval_failures)
        scenario = self.args.scenario
        branches = self.summary["branches"].values()
        siblings = [b for b in branches if not b["sink"]]
        if not siblings:
            raise InvalidRun("no sibling fanout branches were observed")
        drops = sum(b["droppedBytesTotal"] for b in branches)
        if scenario == "lossless" and (drops or self.summary["overflowBytes"]):
            failures.append("lossless run dropped bytes")
        if scenario == "overflow" and not self.summary["overflowBytes"]:
            failures.append("overflow was not exercised")
        if self.summary.get("overflowAttributionUnavailable"):
            raise InvalidRun("link-quality API lacks completed interval counters and attribution; overflow attribution cannot be verified")
        if scenario == "upstream" and drops and not self.attributions["unknown"]:
            failures.append("upstream with core drops was not attributed unknown")
        if scenario == "upstream" and not self.summary["upstreamDroppedBytes"]:
            failures.append("upstream drops were not exercised")
        expected = {"overflow": "link", "host": "host", "consumer": "consumer"}.get(scenario)
        if scenario == "host" and not drops:
            failures.append("host drops were not exercised")
        if expected and not self.attributions[expected]:
            failures.append("expected attribution was not observed: " + expected)
        if scenario in ("lossless", "overflow", "upstream") and self.summary["sheds"]:
            failures.append("link-only or unknown run shed a placement")
        if scenario == "overflow" and self.summary["suspensions"]:
            failures.append("link overflow suspended a placement")
        if scenario in ("consumer", "late-shed"):
            if self.summary.get("consumerSiblingDrops", 0):
                failures.append("slow sink caused sibling drops")
            bound = self.summary["ABSORBER_LAGGARD_MS"] + self.summary["oneChunkMs"]
            if self.consumer_peaks is None:
                raise InvalidRun("consumer phase needs a full 10-minute latency window")
            if self.consumer_peaks > bound:
                failures.append("sibling latency proxy exceeded laggard plus one chunk")
        if scenario == "late-shed":
            sheds = self.summary["sheds"]
            if not sheds:
                failures.append("no late shed observed")
            if any(e["key"] != e["expectedNewestKey"] for e in sheds):
                failures.append("shed did not target the newest eligible placement")
            if any(e["phase"] != "consumer" for e in sheds):
                failures.append("shed during link-only phase")
            if any(len(self.admission_groups.get(e["key"], [])) > 1 for e in sheds):
                raise InvalidRun("shed admission order is ambiguous at polling resolution")
            orders = [e["admissionOrder"] for e in sheds]
            if any(order is None for order in orders) or orders != sorted(orders, reverse=True):
                failures.append("sheds were not in reverse admission order")
            # The cooldown contract belongs to the enablement gate.
            contract = (ROOT.parents[1] / "src/decoders/enablement/contract.ts").read_text()
            match = re.search(r"LATE_SHED_COOLDOWN_MS = ([\d_]+)", contract)
            if not match:
                raise InvalidRun("missing late-shed cooldown contract")
            cooldown = int(match[1].replace("_", "")) / 1000
            if any(b["mono"] - a["mono"] < cooldown - 2 for a, b in zip(sheds, sheds[1:])):
                failures.append("shed cooldown was not respected")
        return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rate", type=int, choices=(2048000, 2400000), required=True)
    parser.add_argument("--scenario", choices=("lossless", "overflow", "consumer", "host", "upstream", "late-shed"), required=True)
    parser.add_argument("--minutes", type=float, default=10)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not 0 < args.minutes <= 60:
        parser.error("--minutes must be positive and at most 60")
    return Experiment(args).run()


if __name__ == "__main__":
    sys.exit(main())
