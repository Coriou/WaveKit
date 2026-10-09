#!/usr/bin/env python3
"""Driver for one bounded WaveKit software capacity run (host side, Docker).

It starts two throwaway containers on a private network: a SYNTHETIC rtl_tcp
server (fake_rtl_tcp.py) and a WaveKit container built from --image. Both get
distinct names (wkcap-*). No host ports are published, and running
deployments, compose projects and image tags are never touched. The WaveKit
container gets a hard memory cap (--memory equal to --memory-swap, so it
cannot swap) and a CPU quota. If its usage hits the cap, the OOM killer works
inside that cgroup and other containers are unaffected.

Safety: before starting, and every --guard seconds while running, the driver
reads VM MemAvailable. It aborts the run (removing its own containers only) if
MemAvailable is below --min-available-mib. It also records `docker stats` for
the --protect container, which defaults to the live wavekit-app. Preflight
refuses to start while that container uses more than --max-protect-cpu
(default 5%) unless --allow-live is given. A run is marked aborted if the
synthetic source logs a client disconnect inside the measurement window.

All output goes to --out (e.g. output/capacity/<run-id>/, gitignored):
config.yaml, meta.json, samples.jsonl (from sampler.py), app.log, fake.log
and guard.jsonl. Use summarize.py to reduce them.

With --fixture <id> the source replays that manifest fixture in a loop
instead (--playback paced|unpaced), and the decoders are --channels instances
of the fixture's decoder type at admissible --placement channel centres
(addendum §9, plan A10). --channelizer on routes them through wavekit-chan.
A cell counts only if every instance runs at window start and end.

Exit codes: 0 ok, 2 preflight abort (including an inadmissible fixture
signal), 3 app not healthy, 4 aborted inside the window, 5 a decoder
instance suspended, missing or not running at window start or end.

This measures software delivery capacity on this host only. It is not RF
decode correctness or Pi/streaming stability.
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = Path(__file__).resolve().parents[2]
ADMISSION_EPSILON_HZ = 1e-6  # same tolerance as admission.rs / admission.ts (Review Focus 1)
USABLE_FRACTION = 0.8  # ChannelizerConfigSchema default (addendum §6)
# Channel request output rate per channelisable decoder type (src/decoders/builtin/ais-catcher.ts)
CHANNEL_OUT_RATE = {"ais-catcher": 384_000}
ALL_DECODERS = [
    ("dsd-fme", "dsd-fme", {"mode": "auto", "output": "null"}),
    ("multimon-ng", "multimon-ng", {"modes": ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX",
                                              "EAS", "AFSK1200", "FSK9600", "DTMF"]}),
    ("rtl433", "rtl433", {}),
    ("readsb", "readsb", {"outputFormat": "sbs", "outputPort": 30003}),
    ("acarsdec", "acarsdec", {}),
    ("ais-catcher", "ais-catcher", {}),
    ("dumpvdl2", "dumpvdl2", {"frequencies": [136975000], "followCenter": True}),
    ("direwolf", "direwolf", {}),
    ("lora-meshtastic", "lora-meshtastic", {"region": "EU_868", "preset": "LongFast",
                                            "frequency": 869525000, "channelKey": "AQ==",
                                            "followCenter": True}),
]


def docker(*args, check=True, capture=True):
    result = subprocess.run(["docker", *args], capture_output=capture, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:3])}... failed: {result.stderr.strip()}")
    return result.stdout if capture else ""


def cpu_percent(stats):
    try:
        return float(str(stats.get("CPUPerc", "")).rstrip("%"))
    except ValueError:
        return None  # container absent: nothing to protect


def parse_events(text):
    events = []
    for line in text.splitlines():
        if line.startswith("{"):
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
    return events


def cap_mib(value):
    units = {"k": 1 / 1024, "m": 1, "g": 1024}
    return int(float(value[:-1]) * units[value[-1].lower()]) if value[-1].isalpha() \
        else int(value) // 2**20


def vm_mem_available_mib(image):
    text = docker("run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/proc/meminfo")
    for line in text.splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable not found")


def protect_stats(name):
    out = docker("stats", "--no-stream", "--format", "{{json .}}", name, check=False)
    try:
        row = json.loads(out.strip().splitlines()[0])
        return {k: row.get(k) for k in ("Name", "CPUPerc", "MemUsage", "MemPerc")}
    except (ValueError, IndexError):
        return {"error": out.strip()[:200]}


def placements(center, rate, usable, n, mode, signal_hz, out_rate, half_occupied=None):
    """Addendum §9 placements, restricted to the admissible centre range (plan A10).

    A channel at offset d is admitted iff |d| + h <= rate*usable/2 (addendum §6), h = bw/2 + tr,
    which is out_rate/2 for the §2 default passband at any t. Channels may overlap; they are load.
    """
    h = out_rate / 2 if half_occupied is None else half_occupied
    limit = math.floor(rate * usable / 2 - h + ADMISSION_EPSILON_HZ)  # largest admissible |offset|, whole Hz
    if limit < 0 or abs(signal_hz - center) > limit:
        raise ValueError(f"fixture signal {signal_hz} Hz is not admissible in a {rate} Hz capture at {center} Hz "
                         f"(|offset| must be <= {limit} Hz for bw/2+tr = {h} Hz)")
    if mode == "spread":
        # §9's (k + 0.5)/N spacing over 2·limit instead of the raw usable span; int() truncates toward the centre
        offsets = [int(2 * limit * ((k + 0.5) / n - 0.5)) for k in range(n)]
    else:
        step = round(1.25 * out_rate)
        if n > 1:
            step = min(step, (2 * limit) // (n - 1))
        sig = signal_hz - center
        offsets = [sig + (step * (2 * k - (n - 1))) // 2 for k in range(n)]  # span is exactly step·(n-1) <= 2·limit
        shift = max(-limit - min(offsets), 0) + min(limit - max(offsets), 0)
        offsets = [o + shift for o in offsets]
    points = [center + o for o in offsets]
    nearest = min(range(n), key=lambda k: abs(points[k] - signal_hz))
    points[nearest] = signal_hz
    return points


def decoder_problems(statuses, expected_ids):
    """Plan A10: a capacity cell counts only if all N instances run; channel suspensions report `suspended: true` (A3)."""
    by_id = {s.get("id"): s for s in statuses}
    problems = []
    for decoder_id in expected_ids:
        s = by_id.get(decoder_id)
        if s is None:
            problems.append(f"{decoder_id}: missing")
        elif s.get("suspended"):
            problems.append(f"{decoder_id}: suspended")
        elif not s.get("running"):
            problems.append(f"{decoder_id}: not running ({s.get('health')})")
    return problems


def decoder_statuses():
    """GET /api/decoders; any failure or non-list reply is [] (every instance then reads as missing: exit 5)."""
    result = subprocess.run(
        ["docker", "exec", "wkcap-app", "curl", "-fsS", "http://127.0.0.1:9000/api/decoders"],
        capture_output=True, text=True)
    if result.returncode != 0:
        return []
    try:
        statuses = json.loads(result.stdout)
    except ValueError:
        return []
    return [s for s in statuses if isinstance(s, dict)] if isinstance(statuses, list) else []


def read_fixture(fixture_id):
    """The manifest v2 entry, read through the same accessor the shell scripts use."""
    result = subprocess.run(["node", str(REPO / "fixtures/manifest-query.mjs"), "get", fixture_id],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def chan_version(image):
    result = subprocess.run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "wavekit-chan",
                             image, "--version"], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def write_config(path, rate, decoders, center, channelizer=False, fixture_id=None):
    source = f"fixture {fixture_id} replayed by fake_rtl_tcp.py" if fixture_id else "SYNTHETIC source"
    lines = [
        f"# Generated by scripts/capacity/run_capacity.py - {source}",
        "sources:",
        "  - id: synth-iq",
        "    type: rtl_tcp",
        "    host: wkcap-fake",
        "    port: 1234",
        "    caps:",
        "      kind: iq",
        "      format: U8_IQ",
        f"      sampleRate: {rate}",
        f"      centerFreq: {center}",
        "      exclusive: false",
        "decoders:",
    ]
    for decoder_id, decoder_type, options in decoders:
        lines += [
            f"  - id: {decoder_id}",
            f"    type: {decoder_type}",
            "    enabled: true",
            "    sourceId: synth-iq",
            *(["    useChannelizer: true"] if channelizer else []),
            f"    options: {json.dumps(options)}",
        ]
    if channelizer:
        lines += ["channelizer:", "  enabled: true"]
    # Delta E12: no band suspension (N instances at spread channelHz would be band-assessed
    # at their channel centre and exit 5), digital voice pinned off (dsd-fme uses output: null).
    lines += [
        "health:", "  bandSuspension: false",
        "digitalVoice:", "  enabled: false",
        "stateDir: /tmp/wkcap-state",
    ]
    lines += [
        "api:", "  host: 0.0.0.0", "  port: 9000",
        "audio:", "  tcpPort: 8080", "  monitoring: false",
        "tunerRelay:", "  enabled: false",
        "liveDemod:", "  enabled: false",
        "resources:", "  containerMonitor:", "    enabled: true",
        "  sdrHostPoller:", "    enabled: false",
        "logging:", "  level: info",
    ]
    path.write_text("\n".join(lines) + "\n")


def wait_healthy(timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = subprocess.run(
            ["docker", "exec", "wkcap-app", "curl", "-fsS", "http://127.0.0.1:9000/health"],
            capture_output=True, text=True)
        if result.returncode == 0:
            return True
        time.sleep(2)
    return False


def cleanup(network):
    for name in ("wkcap-app", "wkcap-fake"):
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    subprocess.run(["docker", "network", "rm", network], capture_output=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--rate", type=int, required=True)
    parser.add_argument("--buffers", choices=["on", "off"], required=True)
    parser.add_argument("--decoders", default="all", help="'all' or comma-separated ids")
    parser.add_argument("--warmup", type=float, default=30)
    parser.add_argument("--window", type=float, default=180)
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--memory", default="640m", help="hard cap, e.g. 640m or 1g")
    parser.add_argument("--cpus", default="4")
    parser.add_argument("--min-available-mib", type=int, default=1024)
    parser.add_argument("--guard", type=float, default=5)
    parser.add_argument("--protect", default="wavekit-app")
    parser.add_argument("--max-protect-cpu", type=float, default=5.0,
                        help="refuse to start if --protect uses more CPU %% than this")
    parser.add_argument("--allow-live", action="store_true",
                        help="run even while --protect is busy (results then contended)")
    parser.add_argument("--center", type=int, default=446524920)
    parser.add_argument("--out", required=True)
    parser.add_argument("--channelizer", choices=["on", "off"], default="off")
    parser.add_argument("--channels", type=int, choices=[1, 4, 8], default=1,
                        help="decoder instances of the fixture's type (needs --fixture)")
    parser.add_argument("--placement", choices=["spread", "clustered"], default="spread")
    parser.add_argument("--fixture", help="replay this fixtures/manifest.yaml id instead of the synthetic signal")
    parser.add_argument("--playback", choices=["paced", "unpaced"], default="paced")
    options = parser.parse_args()
    assert options.warmup + options.window <= 300, "runs are bounded to 5 minutes"
    if options.channels != 1 and not options.fixture:
        parser.error("--channels > 1 needs --fixture")

    out = Path(options.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    network = "wkcap-net"
    center = options.center
    fixture = None
    channel_hz = None
    decoders = []
    placement_error = None
    if options.fixture:
        fixture = read_fixture(options.fixture)
        if options.rate != fixture["sample_rate"]:
            parser.error(f"--rate {options.rate} != fixture sample_rate {fixture['sample_rate']}")
        fixture_path = REPO / "fixtures" / fixture["file"]
        if not fixture_path.is_file() or sha256_file(fixture_path) != fixture["sha256"]:
            parser.error(f"{fixture_path} is missing or does not match the manifest sha256")
        decoder_type = fixture["decoder"]
        if decoder_type not in CHANNEL_OUT_RATE:
            parser.error(f"no channel output rate known for decoder type {decoder_type}")
        center = fixture["center_hz"]
        # For AIS this is the A/B pair centre (162 MHz, plan A15), never channel A.
        signal_hz = (fixture.get("channel") or {}).get("center_hz", fixture["center_hz"])
        base = next((o for _, t, o in ALL_DECODERS if t == decoder_type), {})
        extra = fixture.get("decoder_options") or {}
        try:
            channel_hz = placements(center, options.rate, USABLE_FRACTION, options.channels,
                                    options.placement, signal_hz, CHANNEL_OUT_RATE[decoder_type])
            decoders = [(f"{decoder_type}-ch{k}", decoder_type, {**base, **extra, "channelHz": hz})
                        for k, hz in enumerate(channel_hz)]
        except ValueError as error:
            placement_error = str(error)
    else:
        decoders = ALL_DECODERS if options.decoders == "all" else [
            d for d in ALL_DECODERS if d[0] in options.decoders.split(",")]
    expected_ids = [d[0] for d in decoders]

    meta = {
        "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "image": docker("image", "inspect", "--format", "{{.Id}}", options.image).strip(),
        "imageTag": options.image,
        "gitHead": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                                  cwd=HERE).stdout.strip(),
        "rate": options.rate, "buffers": options.buffers,
        "decoders": expected_ids, "warmup": options.warmup,
        "window": options.window, "interval": options.interval,
        "memoryCap": options.memory, "cpus": options.cpus,
        "source": f"fixture {fixture['id']} via fake_rtl_tcp.py" if fixture else "synthetic fake_rtl_tcp.py",
        "channelizer": options.channelizer, "channels": options.channels if fixture else None,
        "placement": options.placement if fixture else None,
        "placements": channel_hz,
        "fixture": {k: fixture[k] for k in ("id", "sha256", "sample_rate", "center_hz")} if fixture else None,
        "playback": options.playback,
        # Delta E12 pins, written by write_config
        "pinned": {"bandSuspension": False, "digitalVoiceEnabled": False, "liveDemodEnabled": False},
    }
    if placement_error:
        # Before any container starts, like the other preflight aborts.
        meta["aborted"] = placement_error
        (out / "meta.json").write_text(json.dumps(meta, indent=2))
        print(f"ABORT preflight: {placement_error}", file=sys.stderr)
        return 2
    write_config(out / "config.yaml", options.rate, decoders, center,
                 channelizer=options.channelizer == "on", fixture_id=fixture["id"] if fixture else None)

    available = vm_mem_available_mib(options.image)
    meta["wavekitChanVersion"] = chan_version(options.image)
    meta["preflight"] = {"vmMemAvailableMiB": available, "protect": protect_stats(options.protect),
                         "hostLoadAvg": [round(x, 1) for x in os.getloadavg()]}
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    # Even if both containers fill their caps, VM MemAvailable must stay above the floor.
    # A replayed fixture is held in memory whole (up to ~80 MB), so its source gets more room.
    fake_memory = 256 if fixture else 128
    required = cap_mib(options.memory) + fake_memory + options.min_available_mib
    if available < required:
        print(f"ABORT preflight: VM MemAvailable {available} MiB < {required} MiB "
              f"(cap + fake source + floor)", file=sys.stderr)
        return 2
    protect_cpu = cpu_percent(meta["preflight"]["protect"])
    if protect_cpu is not None and protect_cpu > options.max_protect_cpu and not options.allow_live:
        print(f"ABORT preflight: {options.protect} is at {protect_cpu}% CPU (> "
              f"{options.max_protect_cpu}%); likely live streaming. Use --allow-live to "
              "override.", file=sys.stderr)
        return 2

    cleanup(network)
    docker("network", "create", network)
    aborted = None
    try:
        docker("run", "-d", "--name", "wkcap-fake", "--network", network,
               "--cpus", "1", "--memory", f"{fake_memory}m", "--memory-swap", f"{fake_memory}m",
               "--entrypoint", "python3", "-v", f"{HERE}:/capacity:ro",
               *(["-v", f"{REPO / 'fixtures'}:/fixtures:ro"] if fixture else []), options.image,
               "/capacity/fake_rtl_tcp.py", "--rate", str(options.rate),
               "--duration", str(options.warmup + options.window + 90),
               "--loop", "--pacing", options.playback,
               *(["--file", f"/fixtures/{fixture['file']}"] if fixture else []))
        bounded = "true" if options.buffers == "on" else "false"
        docker("run", "-d", "--name", "wkcap-app", "--network", network,
               "--cpus", options.cpus, "--memory", options.memory,
               "--memory-swap", options.memory,
               "-e", "WAVEKIT_CONFIG=/wkcap/config.yaml",
               "-e", f"WAVEKIT_CSDR__BOUNDED_BUFFERS={bounded}",
               "-e", "WAVEKIT_CSDR__BUFFER_ELEMENTS=65536",
               "-v", f"{out}:/wkcap", "-v", f"{HERE}:/capacity:ro", options.image)
        if not wait_healthy(90):
            aborted = "app not healthy within 90s"
            return 3
        time.sleep(options.warmup)
        # Plan A10: checked with --channelizer off too, so both sides carry the same N.
        problems = decoder_problems(decoder_statuses(), expected_ids)
        meta["decoderStatus"] = {"start": problems}
        if problems:
            aborted = "decoders not all running at window start: " + "; ".join(problems)
            return 5
        docker("exec", "-d", "wkcap-app", "python3", "/capacity/sampler.py",
               "--out", "/wkcap/samples.jsonl", "--duration", str(options.window),
               "--interval", str(options.interval))
        start = time.monotonic()
        window_start_wall = time.time()
        with (out / "guard.jsonl").open("w") as guard:
            while time.monotonic() - start < options.window + 10:
                time.sleep(options.guard)
                vm = None
                samples = out / "samples.jsonl"
                if samples.exists():
                    lines = samples.read_text().splitlines()
                    if lines:
                        last = json.loads(lines[-1])
                        vm = (last.get("vmMemAvailableKiB") or 0) // 1024
                        if last.get("final"):
                            break
                row = {"t": round(time.monotonic() - start, 1), "vmMemAvailableMiB": vm,
                       "protect": protect_stats(options.protect)}
                guard.write(json.dumps(row) + "\n")
                guard.flush()
                if vm is not None and vm < options.min_available_mib:
                    aborted = f"VM MemAvailable {vm} MiB below {options.min_available_mib}"
                    break
        window_end_wall = time.time()
        # Host clock. summarize.py windows app.log by the sampler span (container clock, like pino)
        # and reports this one's offset from it as hostClockSkewS.
        meta["windowWall"] = {"start": window_start_wall, "end": window_end_wall}
        problems = decoder_problems(decoder_statuses(), expected_ids)
        meta["decoderStatus"]["end"] = problems
        fake_log = subprocess.run(["docker", "logs", "wkcap-fake"], capture_output=True,
                                  text=True).stdout
        drops = [e for e in parse_events(fake_log) if e.get("event") == "disconnected"
                 and window_start_wall <= e.get("ts", 0) <= window_end_wall]
        if drops and not aborted:
            aborted = f"source client disconnected {len(drops)}x inside the window"
        if aborted:
            return 4
        if problems:
            aborted = "decoders not all running at window end: " + "; ".join(problems)
            return 5
        return 0
    finally:
        logs = subprocess.run(["docker", "logs", "wkcap-app"], capture_output=True, text=True)
        (out / "app.log").write_text(logs.stdout + logs.stderr)
        (out / "fake.log").write_text(
            subprocess.run(["docker", "logs", "wkcap-fake"], capture_output=True, text=True).stdout)
        meta["aborted"] = aborted
        meta["endHostLoadAvg"] = [round(x, 1) for x in os.getloadavg()]
        meta["endedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out / "meta.json").write_text(json.dumps(meta, indent=2))
        cleanup(network)
        if aborted:
            print(f"ABORTED: {aborted}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
