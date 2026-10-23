#!/usr/bin/env python3
"""Run an isolated fake-link experiment using already available local images."""
import argparse
from collections import Counter
import json
import math
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
SIBLING = "link-burst-sibling"
INTERVALS = (9, 1, 130, 50, 40, 71, 161)
STALL_MS = (2500, 4000)
# Assumed excess drain rate of a non-excluded sibling, as a multiple of the
# source byte rate (a sibling consuming at twice real time). The 2 s polls
# cannot measure it; the implied excess is reported and checked against it.
SIBLING_EXCESS = 1.0
LOOP_METER_RESOLUTION_MS = 10
ROOT = Path(__file__).resolve().parent


def constant(name, contract="src/core/link-burst/contract.ts"):
    text = (ROOT.parents[1] / contract).read_text()
    match = re.search(r"export const " + name + r" = ([\d_]+)", text)
    if not match:
        raise ValueError("missing contract constant: " + name)
    return int(match[1].replace("_", ""))


def stall_schedule(scenario):
    lengths = (150, 500, 1000, 1800) if scenario == "lossless" else STALL_MS
    if scenario not in ("lossless", "overflow", "upstream", "upstream-host", "late-shed"):
        return ""
    # Repeat the joint cycle, preserving both sequences across schedule wraps.
    import math
    return ",".join(f"{INTERVALS[i % len(INTERVALS)]}:{lengths[i % len(lengths)]}"
                    for i in range(math.lcm(len(INTERVALS), len(lengths))))


def branch_percent(branch):
    dropped = branch["droppedBytesTotal"]
    total = branch["totalBytesWritten"]
    return 100 * dropped / total if total else 0


RESULT_EXIT = {"pass": 0, "fail": 1, "invalid": 2, "not-applicable": 3}


class InvalidRun(Exception):
    pass


# Host runs: the core gets two CPUs under a 0.75-CPU quota and shares it with
# four stress-ng workers, so host-caused loss is sustained without the source
# disconnecting (the core kept up on two or five saturated CPUs without a
# quota). The fake keeps the last CPU to itself.
HOST_CORE_CPUS = 2
HOST_STRESS_WORKERS = 4
HOST_CORE_QUOTA = "0.75"
HOST_SCENARIOS = ("host", "upstream-host")
UPSTREAM_SCENARIOS = ("upstream", "upstream-host")
# Host runs: at most this share of aggregate host-or-consumer classifications
# may be consumer. A strict subset is host loss whenever its own interval shows
# host evidence, so consumer remains only for intervals sampled without it.
# Recorded before the rule: 143 of 235 (61 %) at 2.048 Msps and 9 of 280
# (3.2 %) at 2.4 Msps; 10 % keeps about three times the 2.4 Msps residual.
HOST_CONSUMER_SHARE_MAX = 0.10
# Upstream-host runs: a stall's gap loss is held by the monitor and resolves
# (unknown, with the upstream rise accumulated) when its pending wait expires,
# MAX_PENDING_WAIT_MS = LINK_RECOVERY_WAIT_MS + LINK_GAP_MS + EFFICIENCY_SAMPLE_MS
# (12.2 s) after the first held loss, checked only on a monitor tick (one more
# sample). The fake counts a whole stall when it starts, so the first held loss
# lands up to one stall plus one sample after the upstream rise that the driver
# observed at the coinciding poll. An unknown increase pairs when the poll
# before it is within that bound of the coinciding poll; the next poll then
# observes it, whatever the poll period. Recorded at 2.4 Msps: coinciding
# polls 64 and 106, held losses resolved unknown 10.8 s and 10.9 s later
# (polls 69 and 111), outside the former three-poll window.
EFFICIENCY_CONTRACT = "src/decoders/enablement/contract.ts"
UPSTREAM_UNKNOWN_PAIRING_S = (
    constant("BURST_ABSORBER_MAX_S") * 1000 + constant("LINK_GAP_MS")
    + 2 * constant("EFFICIENCY_SAMPLE_MS", EFFICIENCY_CONTRACT)
    + max(STALL_MS) + constant("EFFICIENCY_SAMPLE_MS", EFFICIENCY_CONTRACT)) / 1000
NOT_COINCIDING = "core loss never coincided with upstream loss"


def cpu_split(count):
    """Core CPUs and the fake's reserved CPU for the host scenario."""
    if count < HOST_CORE_CPUS + 1:
        raise InvalidRun(f"host scenario needs at least {HOST_CORE_CPUS + 1} CPUs")
    return f"0-{HOST_CORE_CPUS - 1}", str(count - 1)


def interrupted(signum, _frame):
    raise InvalidRun("interrupted by " + signal.Signals(signum).name)


class Experiment:
    def __init__(self, args):
        self.args = args
        self.env = dict(os.environ)
        self.env.update(LINK_BURST_RATE=str(args.rate), LINK_BURST_SECONDS="2",
                        LINK_BURST_DURATION=str(args.minutes * 60 + 1800),
                        LINK_BURST_SCHEDULE=stall_schedule(args.scenario),
                        LINK_BURST_MODE="drop" if args.scenario in UPSTREAM_SCENARIOS else "catchup")
        if args.scenario == "late-shed":
            # Leave a bounded smooth graduation window before the link-only phase.
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
        self.last_overflow = None
        self.previous_counts = None
        self.monitor_counts = Counter()
        self.interval_failures = set()
        self.admission_groups = {}
        self.previous_sink_uptime = None
        self.consumer_baseline = None
        self.consumer_peaks = None
        self.previous_loop_ms = None
        self.exclusion = None
        self.drain = None
        self.upstream_baseline = None
        self.summary["upstreamDroppedBytes"] = 0
        self.polls = 0
        self.previous_core_loss = None
        self.previous_upstream = None
        self.coincident_polls = []
        self.core_loss_polls = set()
        self.unknown_polls = []
        self.poll_mono = {}

    def compose(self, *args, check=True):
        return subprocess.run(self.command + list(args), env=self.env, text=True,
                              capture_output=True, check=check, timeout=90)

    def get(self, path):
        with self.opener.open(self.base + path, timeout=5) as response:
            return json.load(response)

    def ready(self):
        # The API answers before the source connects; wait for the source's
        # link report and the slow-sink branch so the first sample is complete.
        reports = self.get("/api/resources/link-quality")
        branches = self.get("/api/telemetry/fanout")["branches"]
        ready = (any(r.get("sourceId") == SOURCE and r.get("transport") == "network" for r in reports)
                 and any(b.get("sourceId") == SOURCE and SINK in b["id"] for b in branches)
                 and any(b.get("sourceId") == SOURCE and SIBLING in b["id"] for b in branches))
        if ready and self.args.scenario in UPSTREAM_SCENARIOS:
            # The sdr-host poller can take a few seconds (with backoff) to read
            # the fake's statistics for the first time.
            upstream = self.get("/api/resources/backpressure")
            ready = any(b.get("sourceId") == SOURCE and b.get("available") for b in upstream)
        return ready

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
        self.polls += 1
        self.poll_mono[self.polls] = now
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
        if self.last_overflow is not None:
            if overflow < self.last_overflow:
                raise InvalidRun("absorber counter reset")
            self.summary["overflowBytes"] += overflow - self.last_overflow
        self.last_overflow = overflow
        self.record_attribution(report["attribution"]["counts10m"])
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
        if self.args.scenario in UPSTREAM_SCENARIOS:
            if upstream is None or not upstream["available"]:
                raise InvalidRun("upstream statistics are unavailable")
            total = upstream["bytesDroppedUpstream"]
            if self.upstream_baseline is None:
                self.upstream_baseline = total
            if total < self.upstream_baseline:
                raise InvalidRun("upstream counter reset")
            self.summary["upstreamDroppedBytes"] = total - self.upstream_baseline
        branches = [b for b in sample["fanout"]["branches"] if b.get("sourceId") == SOURCE]
        self.record_coincidence(overflow, branches, upstream)
        sinks = [b for b in branches if SINK in b["id"]]
        if len(sinks) != 1:
            raise InvalidRun("expected exactly one slow-sink fanout branch")
        sink = sinks[0]
        # Scanner and catalogue branches come and go; the YAML sibling keeps the
        # consumer checks from passing vacuously.
        if not any(SIBLING in b["id"] for b in branches):
            raise InvalidRun("always-on sibling fanout branch is missing")
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

    def record_coincidence(self, overflow, branches, upstream):
        """Records polls in which core loss and upstream loss both rose (upstream-host)."""
        if self.args.scenario != "upstream-host":
            return
        # Branches come and go; only those present in both polls contribute.
        totals = {b["id"]: b["droppedBytesTotal"] for b in branches}
        totals[None] = overflow
        upstream_total = upstream["bytesDroppedUpstream"]
        if self.previous_core_loss is not None:
            core = sum(max(0, total - self.previous_core_loss.get(key, total))
                       for key, total in totals.items())
            if core > 0:
                self.core_loss_polls.add(self.polls)
            if core > 0 and upstream_total > self.previous_upstream:
                self.coincident_polls.append(self.polls)
        self.previous_core_loss = totals
        self.previous_upstream = upstream_total
        self.summary["coincidentLossPolls"] = len(self.coincident_polls)

    def record_attribution(self, counts):
        if self.previous_counts is not None:
            if counts.get("unknown", 0) > self.previous_counts.get("unknown", 0):
                self.unknown_polls.append(self.polls)
            for key, count in counts.items():
                self.monitor_counts[key] += max(0, count - self.previous_counts[key])
        self.previous_counts = dict(counts)
        self.summary["attributionIncreases"] = dict(self.monitor_counts)
        if self.args.scenario in ("overflow", "upstream"):
            self.summary["attributionCheck"] = "aggregate"

    def smooth_link(self):
        self.phase = "reconnecting"
        self.env["LINK_BURST_SCHEDULE"] = ""
        self.compose("up", "-d", "--no-deps", "--force-recreate", "--no-build",
                     "--pull", "never", "fake")
        deadline = time.monotonic() + 120
        previous = None
        while time.monotonic() < deadline:
            sources = self.get("/api/sources")
            source = next((s for s in sources if s["id"] == SOURCE), None)
            if source is None:
                raise InvalidRun("fake source is missing during reconnect")
            received = source["bytesReceived"]
            if source["connected"] and previous is not None and received > previous:
                return
            previous = received
            time.sleep(2)
        raise InvalidRun("smooth fake source did not reconnect and resume traffic")

    def record_consumer(self, sample, absorber, branches):
        report = next((r for r in sample.get("linkQuality", []) if r.get("sourceId") == SOURCE), {})
        loop_ms = ((report.get("loopDelay") or {}).get("last") or {}).get("maxMs")
        previous_loop_ms, self.previous_loop_ms = self.previous_loop_ms, loop_ms
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
            # Exclusion runs on ingest and drain events, so its timing carries
            # the loop delay of the interval in which it happened (or the one
            # before, at a poll boundary).
            loops = [v for v in (loop_ms, previous_loop_ms) if v is not None]
            tolerance = max(loops) if loops else None
            lag = absorber["laggardExcludeMsMax10m"] or 0
            if self.exclusion is None or lag > self.exclusion["ms"]:
                self.exclusion = {"ms": lag, "loopMs": tolerance}
            held = absorber["peakHeldMs10m"] or 0
            if self.drain is None or held > self.drain["ms"]:
                self.drain = {"ms": held, "bytes": absorber["peakHeldBytes10m"] or 0,
                              "exclusionMs": lag, "loopMs": tolerance}

    @staticmethod
    def key(placement):
        return json.dumps([placement["decoderId"], placement["sourceId"], placement.get("channelHz")])

    def run(self):
        self.args.out.mkdir(parents=True, exist_ok=True)
        exit_code = 2
        handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            if self.args.scenario in HOST_SCENARIOS:
                # Confine stress-ng (run inside core) to the core's CPU set so the
                # fake receiver is not starved: a loaded core host does not slow
                # the remote receiver.
                count = int(subprocess.run(["docker", "info", "--format", "{{.NCPU}}"], text=True,
                                           capture_output=True, check=True, timeout=30).stdout)
                core, fake = cpu_split(count)
                self.env.update(LINK_BURST_CORE_CPUS=core, LINK_BURST_FAKE_CPUS=fake,
                                LINK_BURST_CORE_QUOTA=HOST_CORE_QUOTA)
                self.summary.update(coreCpus=core, fakeCpus=fake, stressWorkers=HOST_STRESS_WORKERS,
                                    coreQuota=HOST_CORE_QUOTA)
            self.compose("up", "-d", "--no-build", "--pull", "never")
            deadline = time.monotonic() + 120
            while True:
                port = self.compose("port", "api", "3000", check=False).stdout.strip()
                if re.fullmatch(r"127\.0\.0\.1:\d+", port):
                    self.base = "http://" + port
                    try:
                        if self.ready():
                            break
                    except (OSError, ValueError, KeyError, TypeError):
                        pass
                if time.monotonic() >= deadline:
                    raise InvalidRun("API did not become ready")
                time.sleep(2)
            if self.args.scenario in HOST_SCENARIOS:
                self.compose("exec", "-T", "-d", "core", "stress-ng", "--cpu", str(HOST_STRESS_WORKERS),
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
                        if self.args.scenario == "late-shed":
                            self.smooth_link()
                            now = time.monotonic()
                            sample = self.sample(now)
                            output.write(json.dumps(sample) + "\n")
                            output.flush()
                            source, sink = self.record(sample)
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
            self.summary["result"] = self.result(failures)
            exit_code = RESULT_EXIT[self.summary["result"]]
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

    def exclusion_bound(self, loop_ms):
        if loop_ms is None:
            raise InvalidRun("loop delay is missing for the latency check")
        tolerance = math.ceil(loop_ms / LOOP_METER_RESOLUTION_MS) * LOOP_METER_RESOLUTION_MS
        return self.summary["ABSORBER_LAGGARD_MS"] + self.summary["oneChunkMs"] + tolerance

    def latency_failures(self):
        """Amended 9.2: exclusion latency gates; post-exclusion drain is bounded."""
        failures = []
        byte_rate = self.args.rate * 2
        exclusion, drain = self.exclusion, self.drain
        exclusion_bound = self.exclusion_bound(exclusion["loopMs"])
        drain_bound = (self.exclusion_bound(drain["loopMs"])
                       + drain["bytes"] * 1000 / (SIBLING_EXCESS * byte_rate))
        drain_ms = drain["ms"] - drain["exclusionMs"]
        implied = (drain["bytes"] * 1000 / drain_ms / byte_rate) if drain_ms > 0 else None
        self.summary.update(
            SIBLING_EXCESS=SIBLING_EXCESS, consumerExclusionMs=exclusion["ms"],
            consumerExclusionBoundMs=exclusion_bound, consumerDrainMs=drain["ms"],
            consumerDrainBoundMs=drain_bound, consumerBacklogBytes=drain["bytes"],
            impliedSiblingExcess=implied)
        if exclusion["ms"] > exclusion_bound:
            failures.append("laggard exclusion exceeded laggard plus one chunk plus loop delay")
        if drain["ms"] > drain_bound:
            failures.append("post-exclusion drain exceeded its bound")
        if implied is not None and implied < SIBLING_EXCESS:
            failures.append("implied sibling excess rate is below the assumption")
        return failures

    def pairs(self, coinciding, unknown):
        """Whether an unknown increase can be the coinciding poll's held loss resolving."""
        if unknown == coinciding:
            return True
        if not coinciding < unknown or unknown - 1 not in self.poll_mono:
            return False
        return self.poll_mono[unknown - 1] - self.poll_mono[coinciding] < UPSTREAM_UNKNOWN_PAIRING_S

    def result(self, failures):
        """Pass, fail, or not applicable for an upstream-host run without coincidence.

        A drop-mode stall withholds input, so the core has no pressure while it
        lasts; core and upstream loss share a poll only when host loss happens
        just before a stall starts within that poll. When both losses were
        exercised but never shared a poll and nothing else failed, the
        attribution of coinciding loss was not tested: not applicable, not pass.
        """
        if (failures == [NOT_COINCIDING] and self.core_loss_polls
                and self.summary["upstreamDroppedBytes"]):
            return "not-applicable"
        return "fail" if failures else "pass"

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
        if scenario == "overflow" or (scenario == "upstream" and self.summary["overflowBytes"]):
            if not self.monitor_counts["link"]:
                failures.append("aggregate link classifications did not increase")
            if self.monitor_counts["consumer"] or self.monitor_counts["host"]:
                failures.append("aggregate consumer or host classifications increased")
        if scenario == "upstream" and drops and not self.attributions["unknown"]:
            failures.append("upstream with core drops was not attributed unknown")
        if scenario in UPSTREAM_SCENARIOS and not self.summary["upstreamDroppedBytes"]:
            failures.append("upstream drops were not exercised")
        if scenario == "host":
            judged = self.monitor_counts["host"] + self.monitor_counts["consumer"]
            if self.monitor_counts["consumer"] > HOST_CONSUMER_SHARE_MAX * judged:
                failures.append("host overload was attributed consumer beyond its share")
        if scenario == "upstream-host":
            if not self.coincident_polls:
                failures.append(NOT_COINCIDING)
            # The unknown must itself bear core loss: an unknown from a drop-free
            # interval (an unreadable read, a reconnect) proves nothing here.
            elif not any(self.pairs(p, u) and u in self.core_loss_polls
                         for p in self.coincident_polls for u in self.unknown_polls):
                failures.append("coinciding core and upstream loss was not attributed unknown")
            if self.monitor_counts["link"]:
                failures.append("aggregate link classifications increased with upstream loss")
        expected = {"host": "host", "consumer": "consumer"}.get(scenario)
        # Absorber overflow counts as dropped bytes, like branch drops.
        if scenario == "host" and not (drops or self.summary["overflowBytes"]):
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
            if self.consumer_peaks is None:
                raise InvalidRun("consumer phase needs a full 10-minute latency window")
            failures += self.latency_failures()
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


def replay(directory):
    """Recompute a run's verdicts from its kept samples."""
    original = directory / "summary.original.json"
    if not original.exists():
        original.write_text((directory / "summary.json").read_text())
    kept = json.loads(original.read_text())
    args = argparse.Namespace(rate=kept["rate"], scenario=kept["scenario"],
                              minutes=kept.get("measuredSeconds", 600) / 60, out=directory)
    experiment = Experiment(args)
    experiment.summary["sinkMode"] = kept.get("sinkMode", "fast")
    if "measuredSeconds" in kept:
        experiment.summary["measuredSeconds"] = kept["measuredSeconds"]
    previous = None
    try:
        with (directory / "samples.jsonl").open() as samples:
            for line in samples:
                sample = json.loads(line)
                if sample["phase"] == "consumer" and experiment.slow_at is None and previous:
                    # The slow sink was enabled on the sample before the first consumer one.
                    branches = [b for b in previous["fanout"]["branches"] if b.get("sourceId") == SOURCE]
                    sink = next(b for b in branches if SINK in b["id"])
                    experiment.slow_at, experiment.sink_baseline = previous["mono"], sink["droppedBytesTotal"]
                    experiment.consumer_baseline = {b["id"]: b["droppedBytesTotal"] for b in branches}
                experiment.phase = sample["phase"]
                experiment.record(sample)
                previous = sample
        failures = experiment.failures()
        experiment.summary.update(failures=failures, result=experiment.result(failures))
    except (InvalidRun, KeyError, TypeError, ValueError) as exc:
        experiment.summary.update(result="invalid", invalidReason=str(exc))
    if kept.get("result") == "invalid":
        # Invalidity decided by the live loop (timeouts, teardown) is kept.
        experiment.summary.update(result="invalid", invalidReason=kept.get("invalidReason"))
    experiment.summary["replayedFrom"] = original.name
    (directory / "summary.json").write_text(json.dumps(experiment.summary, indent=2) + "\n")
    return RESULT_EXIT.get(experiment.summary["result"], 2)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--replay":
        return replay(Path(sys.argv[2]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rate", type=int, choices=(2048000, 2400000), required=True)
    parser.add_argument("--scenario", choices=("lossless", "overflow", "consumer", "host", "upstream", "upstream-host", "late-shed"), required=True)
    parser.add_argument("--minutes", type=float, default=10)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not 0 < args.minutes <= 60:
        parser.error("--minutes must be positive and at most 60")
    return Experiment(args).run()


if __name__ == "__main__":
    sys.exit(main())
