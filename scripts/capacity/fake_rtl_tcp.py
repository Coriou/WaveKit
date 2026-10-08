#!/usr/bin/env python3
"""Deterministic SYNTHETIC rtl_tcp server for software capacity runs.

This is not an RF recording. One second of CU8 is generated from a fixed seed
and looped in real time: low-level noise, an NFM carrier at +100 kHz (1 kHz
tone, 2.5 kHz deviation), and a CW carrier at -300 kHz. It is meant to drive
WaveKit's stream delivery path (source -> fanout -> CSDR -> decoders) at an exact
byte rate. It does not test decode correctness.

The server sends the 12-byte rtl_tcp header ("RTL0", R820T, 29 gains), ignores
5-byte client commands, and writes 262144-byte blocks (rtl_tcp's default
buffer) on an absolute schedule. Every --report seconds it prints one JSON line
to stdout with bytes sent and the largest delay behind schedule. A blocked
socket shows up as growing lag, which means the consumer read side did not keep
up.
"""

import argparse
import json
import math
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


def drain_commands(conn: socket.socket) -> None:
    try:
        while conn.recv(5):
            pass
    except OSError:
        pass


def serve(args: argparse.Namespace) -> None:
    period = synthesize(args.rate, args.seed)
    looped = period + period[:BLOCK]  # lets any block cross the loop seam
    bytes_per_second = args.rate * 2
    listener = socket.create_server(("0.0.0.0", args.port), reuse_port=False)
    print(json.dumps({"event": "listening", "port": args.port, "rate": args.rate,
                      "synthetic": True, "seed": args.seed}), flush=True)
    conn, peer = listener.accept()
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    conn.sendall(b"RTL0" + struct.pack(">II", 5, 29))
    threading.Thread(target=drain_commands, args=(conn,), daemon=True).start()
    print(json.dumps({"event": "connected", "peer": str(peer)}), flush=True)

    start = time.monotonic()
    sent = 0
    offset = 0
    max_lag = 0.0
    next_report = start + args.report
    deadline = start + args.duration
    try:
        while True:
            now = time.monotonic()
            if now >= deadline:
                break
            due = start + sent / bytes_per_second
            if due > now:
                time.sleep(due - now)
            else:
                max_lag = max(max_lag, now - due)
            conn.sendall(looped[offset:offset + BLOCK])
            sent += BLOCK
            offset = (offset + BLOCK) % len(period)
            if time.monotonic() >= next_report:
                elapsed = time.monotonic() - start
                print(json.dumps({"event": "progress", "t": round(elapsed, 1), "bytes": sent,
                                  "expectedBytes": int(elapsed * bytes_per_second),
                                  "maxLagSeconds": round(max_lag, 3)}), flush=True)
                next_report += args.report
    except (BrokenPipeError, ConnectionResetError) as error:
        print(json.dumps({"event": "disconnected", "error": str(error)}), flush=True)
    finally:
        elapsed = time.monotonic() - start
        print(json.dumps({"event": "done", "t": round(elapsed, 1), "bytes": sent,
                          "expectedBytes": int(elapsed * bytes_per_second),
                          "maxLagSeconds": round(max_lag, 3)}), flush=True)
        conn.close()
        listener.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rate", type=int, required=True)
    parser.add_argument("--port", type=int, default=1234)
    parser.add_argument("--duration", type=float, default=300)
    parser.add_argument("--seed", type=int, default=0x5EED1234)
    parser.add_argument("--report", type=float, default=5)
    serve(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
