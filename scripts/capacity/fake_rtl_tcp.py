#!/usr/bin/env python3
"""Deterministic SYNTHETIC rtl_tcp server for software capacity runs.

This is not an RF recording. One second of CU8 is generated from a fixed seed
and looped in real time: low-level noise, an NFM carrier at +100 kHz (1 kHz
tone, 2.5 kHz deviation), and a CW carrier at -300 kHz. It is meant to drive
WaveKit's stream delivery path (source -> fanout -> CSDR -> decoders) at an exact
byte rate. It does not test decode correctness.

The server sends the 12-byte rtl_tcp header ("RTL0", R820T, 29 gains), ignores
5-byte client commands, and keeps accepting reconnects until --duration
expires. It writes 262144-byte blocks (rtl_tcp's default
buffer) on an absolute schedule. Every --report seconds it prints one JSON line
to stdout with bytes sent and the largest delay behind schedule. A blocked
socket shows up as growing lag, which means the consumer read side did not keep
up.

With --file the server replays a CU8 recording instead (trimmed to an even
byte count), once by default or forever with --loop. --pacing unpaced sends
as fast as the consumer reads, which measures throughput rather than real-time
delivery.
"""

import argparse
import json
import math
import pathlib
import socket
import struct
import sys
import threading
import time

BLOCK = 262144


def synthesize(rate: int, seed: int) -> bytes:
    """One second of interleaved CU8 at `rate` samples/s (period-exact)."""
    state = seed & 0xFFFFFFFF
    out = bytearray(rate * 2)
    nfm_phase = 0.0
    two_pi = 2 * math.pi
    nfm_step = two_pi * 100_000 / rate
    dev = 2_500 / rate * two_pi
    tone = two_pi * 1_000 / rate
    cw_step = two_pi * -300_000 / rate
    for n in range(rate):
        # xorshift32 noise, two approximately uniform values in [-1, 1)
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        a = (state & 0xFFFF) / 32768.0 - 1.0
        b = (state >> 16) / 32768.0 - 1.0
        nfm_phase += nfm_step + dev * math.sin(tone * n)
        cw = cw_step * n
        i = 0.08 * a + 0.25 * math.cos(nfm_phase) + 0.15 * math.cos(cw)
        q = 0.08 * b + 0.25 * math.sin(nfm_phase) + 0.15 * math.sin(cw)
        out[2 * n] = max(0, min(255, int(round(127.5 + 127 * i))))
        out[2 * n + 1] = max(0, min(255, int(round(127.5 + 127 * q))))
    return bytes(out)


def load_period(file: str | None, rate: int, seed: int) -> bytes:
    """The bytes one connection replays: the file trimmed to whole I/Q pairs, or one synthetic second."""
    if not file:
        return synthesize(rate, seed)
    path = pathlib.Path(file)
    with path.open("rb") as f:  # one allocation: fixtures are up to ~80 MB and the container cap is small
        return f.read(path.stat().st_size // 2 * 2)


def next_block(period: bytes, offset: int, loop: bool) -> tuple[bytes, int, bool]:
    """The next block from `offset`, the new offset, and whether a non-looping replay is done."""
    if loop:
        block = period[offset:offset + BLOCK]
        while len(block) < BLOCK:  # cross the loop seam without copying the whole period
            block += period[:BLOCK - len(block)]
        return block, (offset + BLOCK) % len(period), False
    block = period[offset:offset + BLOCK]
    end = offset + len(block)
    return block, end, end >= len(period)


def drain_commands(conn: socket.socket) -> None:
    try:
        while conn.recv(5):
            pass
    except OSError:
        pass


def serve(args: argparse.Namespace) -> None:
    period = load_period(args.file, args.rate, args.seed)
    if not period:
        raise SystemExit(f"{args.file}: no complete I/Q pair to replay")
    bytes_per_second = args.rate * 2
    listener = socket.create_server(("0.0.0.0", args.port), reuse_port=False)
    print(json.dumps({"event": "listening", "port": args.port, "rate": args.rate,
                      "synthetic": not args.file, "seed": args.seed, "file": args.file,
                      "loop": args.loop, "pacing": args.pacing}), flush=True)
    server_deadline = time.monotonic() + args.duration
    listener.settimeout(1.0)
    connection = 0
    # Keep accepting until the deadline, so a reconnecting client gets data again.
    # Every disconnect is logged with a wall-clock "ts"; the driver marks a run
    # aborted if one falls inside the measurement window.
    while time.monotonic() < server_deadline:
        try:
            conn, peer = listener.accept()
        except socket.timeout:
            continue
        connection += 1
        stream(conn, peer, connection, period, args.loop, args.pacing == "unpaced",
               bytes_per_second, server_deadline, args.report)
    listener.close()


def emit(event: dict) -> None:
    event["ts"] = round(time.time(), 3)
    print(json.dumps(event), flush=True)


def stream(conn, peer, connection, period, loop, unpaced, bytes_per_second, deadline, report):
    conn.settimeout(None)
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    start = time.monotonic()
    sent = 0
    offset = 0
    max_lag = 0.0
    next_report = start + report
    try:
        conn.sendall(b"RTL0" + struct.pack(">II", 5, 29))
        threading.Thread(target=drain_commands, args=(conn,), daemon=True).start()
        emit({"event": "connected", "connection": connection, "peer": str(peer)})
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            due = start + sent / bytes_per_second
            if due > now:
                if not unpaced:  # unpaced sends as fast as the client reads
                    time.sleep(min(due, deadline) - now)
                    if time.monotonic() >= deadline:
                        break
            else:
                max_lag = max(max_lag, now - due)
            block, offset, done = next_block(period, offset, loop)
            conn.sendall(block)
            sent += len(block)
            if time.monotonic() >= next_report:
                elapsed = time.monotonic() - start
                emit({"event": "progress", "connection": connection, "t": round(elapsed, 1),
                      "bytes": sent, "expectedBytes": int(elapsed * bytes_per_second),
                      "maxLagSeconds": round(max_lag, 3)})
                next_report += report
            if done:
                break
    except (BrokenPipeError, ConnectionResetError, OSError) as error:
        emit({"event": "disconnected", "connection": connection, "error": str(error)})
    finally:
        elapsed = time.monotonic() - start
        emit({"event": "done", "connection": connection, "t": round(elapsed, 1), "bytes": sent,
              "expectedBytes": int(elapsed * bytes_per_second),
              "maxLagSeconds": round(max_lag, 3)})
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rate", type=int, required=True)
    parser.add_argument("--port", type=int, default=1234)
    parser.add_argument("--duration", type=float, default=300)
    parser.add_argument("--seed", type=int, default=0x5EED1234)
    parser.add_argument("--report", type=float, default=5)
    parser.add_argument("--file", help="replay this CU8 file instead of the synthetic signal")
    parser.add_argument("--loop", action="store_true", help="replay the period forever")
    parser.add_argument("--pacing", choices=["paced", "unpaced"], default="paced",
                        help="paced = real time at --rate; unpaced = as fast as the client reads")
    serve(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
