#!/usr/bin/env python3
"""readsb stand-in for scratch-core profiling (profile-spectrum-main --load).

Reads and discards the IQ on stdin (the core still writes the full-rate branch),
listens on 127.0.0.1 at the `--net-sbs-port` the adapter passes, and sends
synthetic SBS lines to every client at PROFILE_SBS_RATE lines/s (default 30)
across PROFILE_SBS_AIRCRAFT aircraft (default 20). All data is synthetic:
addresses 0F00xx, callsigns TESTxx, positions near 0 N 0 E.
"""
import math
import os
import socket
import sys
import threading
import time
from datetime import datetime, timezone

args = sys.argv[1:]
port = None
for i, a in enumerate(args):
	if a == "--net-sbs-port" and i + 1 < len(args):
		port = int(args[i + 1])
if port is None:
	sys.stderr.write("profile-stub-readsb: --net-sbs-port required\n")
	sys.exit(2)

rate = float(os.environ.get("PROFILE_SBS_RATE", "30"))
count = int(os.environ.get("PROFILE_SBS_AIRCRAFT", "20"))
clients = []
lock = threading.Lock()


def drain() -> None:
	stdin = sys.stdin.buffer
	try:
		while stdin.read1(1 << 16):
			pass
	finally:
		os._exit(0)


def accept(server: socket.socket) -> None:
	while True:
		conn, _ = server.accept()
		with lock:
			clients.append(conn)


def line(n: int) -> str:
	k = n % count
	icao = f"0F00{k:02X}"
	now = datetime.now(timezone.utc)
	d = now.strftime("%Y/%m/%d")
	t = now.strftime("%H:%M:%S.") + f"{now.microsecond // 1000:03d}"
	# callsign, altitude, speed, track, lat, lon, vrate, squawk, alert, emergency, spi, ground
	f = [""] * 12
	f[11] = "0"
	kind = (n // count) % 3
	if kind == 0:
		msg = 1
		f[0] = f"TEST{k:02d}"
	elif kind == 1:
		msg = 3
		a = (n / 50.0 + k) % (2 * math.pi)
		f[1] = str(20000 + 100 * k)
		f[4] = f"{0.5 * math.sin(a) + k * 0.01:.5f}"
		f[5] = f"{0.5 * math.cos(a) + k * 0.01:.5f}"
	else:
		msg = 4
		f[2] = str(400 + k)
		f[3] = str((n * 3) % 360)
		f[6] = str(64 * (k % 5))
	return ",".join([f"MSG,{msg},1,1,{icao},1,{d},{t},{d},{t}", *f])


server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", port))
server.listen(4)
threading.Thread(target=drain, daemon=True).start()
threading.Thread(target=accept, args=(server,), daemon=True).start()

n = 0
period = 1.0 / rate
next_at = time.monotonic()
while True:
	payload = (line(n) + "\r\n").encode()
	n += 1
	with lock:
		for c in list(clients):
			try:
				c.sendall(payload)
			except OSError:
				clients.remove(c)
	next_at += period
	time.sleep(max(0.0, next_at - time.monotonic()))
