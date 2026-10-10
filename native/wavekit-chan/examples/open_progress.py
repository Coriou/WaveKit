#!/usr/bin/env python3
"""Bounded synthetic Mac process probe (standard library only).

python3 native/wavekit-chan/examples/open_progress.py /tmp/wavekit-chan-open-baseline
Each observation uses a fresh process (cold open, not cold OS caches). IQ is paced
in intact 4096-sample blocks at nominal 2.048 Msps, with a draining pass-through
socket. No RF source, input dropping, gap marks, or production buffer changes.
"""
import argparse
import json
import os
import queue
import socket
import subprocess
import tempfile
import threading
import time

FS = 2_048_000
BLOCK = 4096
TIMEOUT = 15


def observe(binary, rate, scenario):
    with tempfile.TemporaryDirectory(prefix="wkop-", dir="/tmp") as directory:
        fifo = directory + "/ctl"
        os.mkfifo(fifo)
        # Open RDWR before spawn to avoid an unbounded FIFO-open handshake.
        control_fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
        env = dict(os.environ, WK_CTL=fifo)
        command = ["sh", "-c", 'exec "$0" "$@" 3<"$WK_CTL"', binary,
                   "--generation", "1", "--input-format", "cu8",
                   "--input-rate", str(FS), "--input-center", "162000000",
                   "--usable-fraction", "0.8", "--block-samples", str(BLOCK),
                   "--control-fd", "3", "--socket-dir", directory]
        proc = subprocess.Popen(command, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        events = []
        event_queue = queue.Queue()
        progress = []
        written = []
        write_times = []
        failures = []
        stop = threading.Event()
        sockets = []
        drains = []
        started = time.monotonic()

        def send(request):
            data = (json.dumps(dict(v=1, **request)) + "\n").encode()
            if os.write(control_fd, data) != len(data):
                raise RuntimeError("short control write")

        def read_events():
            try:
                for line in proc.stdout:
                    stamp = time.monotonic()
                    event = json.loads(line)
                    events.append((stamp, event))
                    event_queue.put((stamp, event))
            except Exception as error:
                failures.append(str(error))

        def next_event(deadline):
            return event_queue.get(timeout=max(0.001, deadline-time.monotonic()))

        def wait_event(kind, identity=None):
            deadline = time.monotonic() + TIMEOUT
            while time.monotonic() < deadline:
                stamp, event = next_event(deadline)
                if event["type"] == "rejected":
                    raise RuntimeError(str(event))
                if event["type"] == kind and (identity is None or event.get("id") == identity):
                    return stamp, event
            raise TimeoutError(kind)

        def connect(event, record):
            client = socket.socket(socket.AF_UNIX)
            client.settimeout(0.2)
            client.connect(event["socket"])
            sockets.append(client)

            def drain():
                try:
                    while True:
                        try:
                            data = client.recv(65536)
                        except socket.timeout:
                            if proc.poll() is not None:
                                return
                            continue
                        if not data:
                            return
                        if record:
                            progress.append((time.monotonic(), len(data)))
                except OSError as error:
                    failures.append(str(error))
            thread = threading.Thread(target=drain, daemon=True)
            drains.append(thread)
            thread.start()

        def feed():
            # Reuse the same immutable block; preserve complete sample pairs.
            block = bytes([128, 128]) * BLOCK
            due = time.monotonic()
            try:
                while not stop.is_set() and time.monotonic()-started < TIMEOUT:
                    before = time.monotonic()
                    proc.stdin.write(block)
                    proc.stdin.flush()
                    after = time.monotonic()
                    written.append(BLOCK)
                    write_times.append((before, after))
                    # No catch-up burst: lateness/backpressure lowers the actual feed rate.
                    due = max(due + BLOCK / FS, after)
                    stop.wait(max(0, due-time.monotonic()))
                proc.stdin.close()
            except (OSError, ValueError) as error:
                failures.append(str(error))

        try:
            threading.Thread(target=read_events, daemon=True).start()
            wait_event("ready")
            # Identity rate, narrower bandwidth fits the usable input span.
            send(dict(type="open", id="existing", centerHz=162e6,
                      bandwidthHz=1_400_000, transitionHz=50_000,
                      outputRateHz=FS, format="cu8", queueBytes=1 << 20))
            _, existing = wait_event("opened", "existing")
            assert existing["filterTaps"] == 0, existing
            connect(existing, True)
            feeder = threading.Thread(target=feed, daemon=True)
            feeder.start()
            time.sleep(0.15)
            if not progress:
                raise RuntimeError("existing channel made no progress before cold open")
            begin = time.monotonic()
            bytes_before = sum(size for stamp, size in progress if stamp < begin)
            def open_request(identity, output, **overrides):
                request = dict(type="open", id=identity, centerHz=162e6,
                               bandwidthHz=0.95*output, transitionHz=0.025*output,
                               outputRateHz=output, format="cu8", queueBytes=1 << 20)
                request.update(overrides)
                return request

            open_timings = []

            def open_and_close(request, label):
                sent = time.monotonic()
                send(request)
                received, opened = wait_event("opened", request["id"])
                connect(opened, False)
                send(dict(type="close", id=request["id"]))
                wait_event("closed", request["id"])
                open_timings.append(dict(label=label, id=request["id"],
                                         latency_ms=(received-sent)*1000,
                                         sent_s=sent-started, opened_s=received-started,
                                         taps=opened["filterTaps"],
                                         request=request))
                return received, opened

            if scenario == "single":
                end, cold = open_and_close(open_request("cold", rate), "cold")
            else:
                # Queue same and different keys, then cancel one immediately. On the
                # synchronous baseline cancellation cannot prevent its construction.
                requests = [open_request("cold", rate),
                            open_request("different", 1_000_000 if rate != 1_000_000 else 1_050_000),
                            open_request("cancel", rate)]
                sent_at = {}
                for request in requests:
                    sent_at[request["id"]] = time.monotonic()
                    send(request)
                send(dict(type="close", id="cancel"))
                pending = {request["id"] for request in requests}
                deadline = time.monotonic() + TIMEOUT
                cold = None
                while pending:
                    received, event = next_event(deadline)
                    identity = event.get("id")
                    if event["type"] == "rejected":
                        raise RuntimeError(str(event))
                    if event["type"] == "opened" and identity in pending:
                        open_timings.append(dict(label="burst", id=identity,
                                                 latency_ms=(received-sent_at[identity])*1000,
                                                 sent_s=sent_at[identity]-started,
                                                 opened_s=received-started,
                                                 taps=event["filterTaps"]))
                        if identity == "cold":
                            cold = event
                        if identity != "cancel":
                            connect(event, False)
                            send(dict(type="close", id=identity))
                    if event["type"] == "closed" and identity in pending:
                        pending.remove(identity)
                if cold is None:
                    raise RuntimeError("primary cold channel did not open")
                # Identical filter key, then offsets/format/gain differing only in
                # per-channel state; all are promptly drained and closed.
                for identity, overrides in [
                    ("warm", {}),
                    ("offset", dict(centerHz=162e6+10_000)),
                    ("format", dict(centerHz=162e6-10_000, format="cf32")),
                    ("gain", dict(gain=2.0)),
                ]:
                    open_and_close(open_request(identity, rate, **overrides), identity)
                end = time.monotonic()
            time.sleep(0.15)
            stop.set()
            feeder.join(TIMEOUT)
            if feeder.is_alive():
                raise TimeoutError("IQ feeder blocked")
            _, eof = wait_event("input-eof")
            proc.wait(timeout=TIMEOUT)
            for drain in drains:
                drain.join(2)
            if any(drain.is_alive() for drain in drains):
                raise TimeoutError("socket drain did not finish")
            arrivals = [stamp for stamp, _ in progress]
            pairs = list(zip(arrivals, arrivals[1:]))
            # Clip silence to the open interval. An overlapping receive gap can extend into
            # subsequent close()/writer-join work; report that full gap separately.
            intersecting = [min(b, end)-max(a, begin) for a, b in pairs if a <= end and b >= begin]
            overlapping = [b-a for a, b in pairs if a <= end and b >= begin]
            for timing in open_timings:
                left, right = started+timing["sent_s"], started+timing["opened_s"]
                timing["existing_bytes_during_open"] = sum(size for stamp, size in progress if left <= stamp <= right)
                timing["max_progress_interruption_ms"] = max(
                    (min(b, right)-max(a, left) for a, b in pairs if a <= right and b >= left), default=0)*1000
            inflight = [(stamp, size) for stamp, size in progress if begin <= stamp <= end]
            gaps = [event for _, event in events if event["type"] == "discontinuity"]
            total = sum(size for _, size in progress)
            pre_gaps = [b-a for a, b in pairs if b < begin]
            return dict(rate=rate, scenario=scenario, open_timings=open_timings,
                        open_ms=(end-begin)*1000,
                        taps=cold["filterTaps"], input_written_samples=sum(written),
                        input_eof_samples=eof["inputSamples"], discarded_input_bytes=eof["discardedBytes"],
                        existing_output_bytes=total, existing_output_samples=total//2,
                        existing_bytes_before_open=bytes_before,
                        existing_bytes_during_open=sum(size for _, size in inflight),
                        existing_recv_calls_during_open=len(inflight),
                        max_progress_interruption_ms=max(intersecting, default=0)*1000,
                        max_overlapping_recv_gap_ms=max(overlapping, default=0)*1000,
                        baseline_max_recv_gap_ms=max(pre_gaps, default=0)*1000,
                        max_recv_gap_ms=max((b-a for a, b in pairs), default=0)*1000,
                        max_stdin_write_ms=max((b-a for a, b in write_times), default=0)*1000,
                        unreceived_existing_samples=sum(written)-total//2,
                        reported_dropped_samples=sum(e["droppedSamples"] for e in gaps if e["id"] == "existing"),
                        discontinuities=gaps,
                        cancel_opened=any(e.get("id") == "cancel" and e["type"] == "opened" for _, e in events),
                        cancel_close_reasons=[e.get("reason") for _, e in events if e.get("id") == "cancel" and e["type"] == "closed"],
                        feed_samples_per_second=sum(written)/(write_times[-1][1]-write_times[0][0]) if len(write_times) > 1 else 0,
                        process_exit=proc.returncode, errors=failures)
        finally:
            stop.set()
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
            for client in sockets:
                client.close()
            os.close(control_fd)
            for pipe in [proc.stdin, proc.stdout, proc.stderr]:
                if pipe and not pipe.closed:
                    pipe.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary")
    parser.add_argument("--samples", type=int, default=12)
    parser.add_argument("--scenario", choices=["single", "mixed"], default="single",
                        help="mixed measures the complete burst/cancel/warm sequence interval")
    args = parser.parse_args()
    if not 1 <= args.samples <= 12:
        parser.error("samples must be within 1..12")
    for rate in [48_000, 384_000, 1_000_000, 1_050_000]:
        results = []
        for sample in range(args.samples):
            result = dict(sample=sample, **observe(os.path.abspath(args.binary), rate, args.scenario))
            results.append(result)
            print(json.dumps(result), flush=True)
        summary = dict(rate=rate, scenario=args.scenario, samples=args.samples)
        for field in ["open_ms", "max_progress_interruption_ms"]:
            values = sorted(result[field] for result in results)
            n = len(values)
            summary[field] = dict(min=values[0], median=(values[(n-1)//2]+values[n//2])/2,
                                  p95=values[max(0, (95*n+99)//100-1)], max=values[-1],
                                  mean=sum(values)/n)
        print(json.dumps(dict(summary=summary)), flush=True)


if __name__ == "__main__":
    main()
