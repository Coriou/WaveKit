import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "fake", pathlib.Path(__file__).resolve().parents[3] / "scripts/capacity/fake_rtl_tcp.py")
fake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fake)


class Clock:
    now = 0.0

    def sleep(self, seconds):
        self.now += seconds


class Socket:
    def __init__(self, clock):
        self.clock = clock
        self.blocks = []

    def settimeout(self, value): pass
    def setsockopt(self, *args): pass
    def close(self): pass
    def recv(self, size): return b""

    def sendall(self, data):
        if not data.startswith(b"RTL0"):
            self.blocks.append((self.clock.now, data))


class StallTests(unittest.TestCase):
    def run_stream(self, mode="catchup", deadline=6.6):
        clock = Clock()
        conn = Socket(clock)
        events = []
        stats = fake.StreamStats()
        with patch.object(fake.time, "monotonic", side_effect=lambda: clock.now), \
                patch.object(fake.time, "sleep", side_effect=clock.sleep), \
                patch.object(fake, "emit", side_effect=lambda event: events.append((clock.now, event))):
            fake.stream(conn, None, 1, bytes(range(256)) * 1024, True, False,
                        4096000, deadline, 100, fake.parse_stall_schedule("1:150,2:500"),
                        mode, stats)
        return conn, events, stats

    def test_catchup_repeats_without_drift(self):
        conn, events, stats = self.run_stream()
        stalls = [(t, e) for t, e in events if e["event"] == "stall"]
        self.assertEqual([round(t, 6) for t, _ in stalls], [1, 3, 4, 6])
        for _, event in stalls:
            self.assertLessEqual(abs(event["withheld_bytes"] - round(
                event["stall_ms"] / 1000 * 4096000)), fake.BLOCK)
        self.assertFalse(any(1 <= t < 1.15 for t, _ in conn.blocks))
        self.assertGreaterEqual(sum(abs(t - 1.15) < 1e-9 for t, _ in conn.blocks), 2)
        self.assertEqual(stats.snapshot()["totalSent"], sum(len(b) for _, b in conn.blocks))

    def test_drop_totals_and_resume_clock(self):
        conn, events, stats = self.run_stream("drop")
        stalls = [e for _, e in events if e["event"] == "stall"]
        total = 0
        for event in stalls:
            total += event["withheld_bytes"]
            self.assertEqual(event["dropped_bytes_total"], total)
        self.assertEqual(stats.snapshot()["clients"], [{"bytesDropped": total}])
        self.assertLessEqual(sum(abs(t - 1.15) < 1e-9 for t, _ in conn.blocks), 1)

    def test_stats_endpoint_without_network(self):
        stats = fake.StreamStats()
        stats.add(sent=1024, dropped=512)
        with patch.object(fake, "ThreadingHTTPServer") as server, \
                patch.object(fake.threading, "Thread"):
            fake.stats_server(12345, stats)
            handler_type = server.call_args.args[1]
            handler = object.__new__(handler_type)
            handler.wfile = io.BytesIO()
            handler.send_response = lambda status: self.assertEqual(status, 200)
            handler.send_header = lambda *args: None
            handler.end_headers = lambda: None
            handler.do_GET()
            self.assertEqual(json.loads(handler.wfile.getvalue()),
                             {"clients": [{"bytesDropped": 512}], "totalSent": 1024})

    def test_schedule_validation(self):
        self.assertEqual(fake.parse_stall_schedule(""), [])
        for value in ["0:150", "-1:10", "1:-1", "nan:1", "1:inf", "bad"]:
            with self.assertRaises(ValueError):
                fake.parse_stall_schedule(value)


if __name__ == "__main__":
    unittest.main()
