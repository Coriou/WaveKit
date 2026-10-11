#!/usr/bin/env python3
"""Compare exact encoded bytes/metadata against a saved pre-change binary, bounded to 28 cases.

python3 native/wavekit-chan/examples/open_equivalence.py <baseline-binary> <candidate-binary>
Synthetic IQ only. SHA256 and FNV64 are output regression checks, not RF decode gates.
"""
import argparse
import hashlib
import json
import os
import queue
import socket
import subprocess
import tempfile
import threading

INPUT = bytes((k*31) % 256 for k in range(65537))


def capture(binary, fs, out, fmt):
    with tempfile.TemporaryDirectory(prefix="wk-eq-", dir="/tmp") as directory:
        ctl_read, ctl_write = os.pipe()
        proc = subprocess.Popen([
            os.path.abspath(binary), "--generation", "41", "--input-format", "cu8",
            "--input-rate", str(fs), "--input-center", "162000000",
            "--usable-fraction", "0.8", "--block-samples", "4096",
            "--control-fd", str(ctl_read), "--socket-dir", directory,
        ], pass_fds=(ctl_read,), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        os.close(ctl_read)
        received = queue.Queue()
        def events():
            for line in proc.stdout:
                received.put(json.loads(line))
            received.put(None)
        reader = threading.Thread(target=events, daemon=True)
        reader.start()
        def event(kind):
            while True:
                e = received.get(timeout=10)
                assert e is not None, "premature event EOF"
                assert e["v"] == 1 and e["generation"] == 41, e
                assert e["type"] not in ["rejected", "discontinuity"], e
                if e["type"] == kind:
                    return e
        try:
            event("ready")
            request = dict(v=1, type="open", id="exact", centerHz=162031250,
                           bandwidthHz=.95*out if out != fs else 1400000,
                           transitionHz=.025*out if out != fs else 50000,
                           outputRateHz=out, format=fmt, queueBytes=1 << 20)
            if fmt == "cu8":
                request["gain"] = 1.7
            data = (json.dumps(request)+"\n").encode()
            assert os.write(ctl_write, data) == len(data)
            opened = event("opened")
            client = socket.socket(socket.AF_UNIX)
            client.settimeout(10)
            client.connect(opened["socket"])
            output = []
            failures = []
            def drain():
                try:
                    while True:
                        chunk = client.recv(65536)
                        if not chunk:
                            return
                        output.append(chunk)
                except Exception as error:
                    failures.append(str(error))
            draining = threading.Thread(target=drain, daemon=True)
            draining.start()
            # Irregular byte chunks include splits inside CU8 pairs.
            for first in range(0, len(INPUT), 333):
                proc.stdin.write(INPUT[first:first+333])
            proc.stdin.close()
            eof = event("input-eof")
            proc.wait(timeout=10)
            draining.join(10)
            client.close()
            assert not draining.is_alive() and not failures, failures
            assert proc.returncode == 0
            assert eof["inputSamples"] == len(INPUT)//2 and eof["discardedBytes"] == 1
            raw = b"".join(output)
            assert len(raw) == (len(INPUT)//2*out//fs)*(2 if fmt == "cu8" else 8)
            fnv = 0xcbf29ce484222325
            for byte in raw:
                fnv = ((fnv ^ byte)*0x100000001b3) & ((1 << 64)-1)
            return dict(fs=fs, out=out, format=fmt, bytes=len(raw),
                        filter_taps=opened["filterTaps"],
                        group_delay_samples=opened["groupDelaySamples"],
                        sha256=hashlib.sha256(raw).hexdigest(), fnv64=f"{fnv:016x}")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
            os.close(ctl_write)
            for pipe in [proc.stdin, proc.stdout, proc.stderr]:
                pipe.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    args = parser.parse_args()
    for fs in [2048000, 2400000]:
        for out in [24000, 48000, 250000, 384000, 1000000, 1050000, fs]:
            for fmt in ["cu8", "cf32"]:
                baseline = capture(args.baseline, fs, out, fmt)
                candidate = capture(args.candidate, fs, out, fmt)
                assert baseline == candidate, (baseline, candidate)
                print(json.dumps(dict(equal=True, **baseline)), flush=True)
