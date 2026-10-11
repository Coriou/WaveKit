#!/usr/bin/env python3
"""Bounded direct-protocol saturation/reclamation and RSS probe; no RF or production fanout.

python3 native/wavekit-chan/examples/open_saturation.py <release-binary>
Sixteen rapid cold opens each reserve 16 MiB (the candidate permits 64 MiB pending).
Every accepted channel is immediately canceled/closed. A fresh request then proves
reclamation, followed by pending shutdown. RSS snapshots are observations, not peaks.
"""
import argparse
import json
import os
import queue
import subprocess
import threading
import time
import tempfile


def run(binary):
    with tempfile.TemporaryDirectory(prefix="wk-bounds-", dir="/tmp") as directory:
        ctl_read, ctl_write = os.pipe()
        proc = subprocess.Popen([
            os.path.abspath(binary), "--generation", "51", "--input-format", "cu8",
            "--input-rate", "2048000", "--input-center", "162000000",
            "--usable-fraction", "0.8", "--block-samples", "4096",
            "--control-fd", str(ctl_read), "--socket-dir", directory,
        ], pass_fds=(ctl_read,), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        os.close(ctl_read)
        received = queue.Queue()
        deadline = time.monotonic() + 30
        rss = []
        events = []
        def reader():
            for line in proc.stdout:
                received.put(json.loads(line))
            received.put(None)
        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        def next_event():
            event = received.get(timeout=max(.001, deadline-time.monotonic()))
            if event is None:
                raise RuntimeError("premature event EOF")
            assert event["v"] == 1 and event["generation"] == 51, event
            events.append(event)
            return event
        def send(**fields):
            data = (json.dumps(dict(v=1, **fields))+"\n").encode()
            assert os.write(ctl_write, data) == len(data)
        def open_channel(identity, capacity=16 << 20):
            send(type="open", id=identity, centerHz=162000000,
                 bandwidthHz=997500, transitionHz=26250, outputRateHz=1050000,
                 format="cu8", queueBytes=capacity)
        def snapshot(label):
            result = subprocess.run(["ps", "-o", "rss=", "-p", str(proc.pid)],
                                    capture_output=True, text=True, timeout=2)
            if result.returncode == 0 and result.stdout.strip():
                rss.append(dict(label=label, rss_kib=int(result.stdout.strip())))
        try:
            assert next_event()["type"] == "ready"
            snapshot("ready")
            ids = {f"burst-{n}" for n in range(16)}
            begin = time.monotonic()
            for identity in sorted(ids):
                open_channel(identity)
            snapshot("after-burst")
            replies = {}
            while len(replies) < len(ids):
                e = next_event()
                identity = e.get("id")
                if e["type"] in ["opened", "rejected"] and identity in ids:
                    assert identity not in replies, e
                    replies[identity] = e
                    if e["type"] == "opened":
                        send(type="close", id=identity)
                    else:
                        assert e["reasonCode"] == "channel-request-invalid" and e["detail"] == "planner busy", e
            accepted = {identity for identity, e in replies.items() if e["type"] == "opened"}
            closed = {e["id"] for e in events if e["type"] == "closed"}
            while not accepted <= closed:
                e = next_event()
                if e["type"] == "closed":
                    closed.add(e["id"])
            snapshot("closed-burst")
            # Busy requests were rejected without reserving their IDs; recovery uses a fresh ID.
            recovery_retries = 0
            while True:
                open_channel("recovery", 4096)
                while True:
                    e = next_event()
                    if e.get("id") == "recovery" and e["type"] in ["opened", "rejected"]:
                        break
                if e["type"] == "opened":
                    break
                assert e["detail"] == "planner busy", e
                recovery_retries += 1
                assert recovery_retries <= 20
                time.sleep(.005)
            send(type="close", id="recovery")
            while next_event()["type"] != "closed":
                pass
            snapshot("recovered")
            open_channel("shutdown-pending", 4096)
            send(type="shutdown")
            proc.wait(timeout=max(.001, deadline-time.monotonic()))
            thread.join(2)
            assert not thread.is_alive()
            seen_closed = set()
            tail = []
            while not received.empty():
                e = received.get_nowait()
                if e is not None:
                    tail.append(e)
            for e in events+tail:
                if e["type"] == "closed":
                    seen_closed.add(e["id"])
                if e["type"] == "opened":
                    assert e["id"] not in seen_closed, e
            assert proc.returncode == 0
            assert not any(name.endswith(".sock") for name in os.listdir(directory))
            return dict(burst=16, accepted=len(accepted), busy=16-len(accepted),
                        recovery_retries=recovery_retries, elapsed_ms=(time.monotonic()-begin)*1000,
                        rss_snapshots=rss, exit=proc.returncode, sockets_remaining=0,
                        requested_pending_queue_bound_bytes=64 << 20,
                        note="RSS snapshots are not a peak; active channels have no aggregate CPU/count cap")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
            os.close(ctl_write)
            for pipe in [proc.stdin, proc.stdout, proc.stderr]:
                pipe.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary")
    args = parser.parse_args()
    print(json.dumps(run(args.binary)))
