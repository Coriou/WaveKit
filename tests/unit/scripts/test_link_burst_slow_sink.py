import importlib.machinery
import importlib.util
import io
import argparse
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
loader = importlib.machinery.SourceFileLoader("slow_sink", str(ROOT / "scripts/link-burst/slow-sink/rtl_433"))
spec = importlib.util.spec_from_loader(loader.name, loader)
shim = importlib.util.module_from_spec(spec)
loader.exec_module(shim)


class SinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "sentinel"
        self.now = 0
        self.sleeps = []

    def sleep(self, seconds):
        self.now += seconds
        self.sleeps.append(seconds)

    def run_sink(self, size, sleep=None):
        stream = io.BytesIO(b"x" * size)
        self.assertEqual(shim.sink(stream, self.path, lambda: self.now, sleep or self.sleep), 0)
        self.assertEqual(stream.tell(), size)

    def test_marker(self):
        self.assertFalse(shim.should_throttle(["-V"]))
        self.assertTrue(shim.should_throttle(["link-burst-slow-sink"]))

    def test_fast(self):
        self.assertIsNone(shim.read_rate(self.path))
        self.run_sink(1024 * 1024)
        self.assertEqual(self.sleeps, [])

    def test_rate(self):
        self.path.write_text("65536")
        self.run_sink(256 * 1024)
        self.assertGreaterEqual(self.now, 3.9)

    def test_removed(self):
        self.path.write_text("65536")
        def sleep(seconds):
            self.sleep(seconds)
            self.path.unlink(missing_ok=True)
        self.run_sink(1024 * 1024, sleep)
        self.assertLessEqual(self.now, 1)

    def test_invalid(self):
        for text in ("oops", "-1", "inf", ""):
            self.path.write_text(text)
            self.assertEqual(shim.read_rate(self.path), 131072)
        self.path.unlink()
        self.path.mkdir()
        self.assertEqual(shim.read_rate(self.path), 131072)

    def test_pause(self):
        self.path.write_text("0")
        stream = io.BytesIO(b"x" * 65536)
        def sleep(seconds):
            self.sleep(seconds)
            self.assertEqual(stream.tell(), 0)
            if self.now >= 10:
                self.path.unlink()
        self.assertEqual(shim.sink(stream, self.path, lambda: self.now, sleep), 0)
        self.assertGreaterEqual(self.now, 10)
        self.assertEqual(stream.tell(), 65536)


run_spec = importlib.util.spec_from_file_location("acceptance", ROOT / "scripts/link-burst/run_acceptance.py")
run = importlib.util.module_from_spec(run_spec)
run_spec.loader.exec_module(run)


class AcceptanceTests(unittest.TestCase):
    def experiment(self, scenario="overflow"):
        return run.Experiment(argparse.Namespace(rate=2048000, scenario=scenario, minutes=10, out=Path("unused")))

    def sample(self, drops=0, attribution="none", overflow=0):
        return {
            "mono": 100, "phase": "measuring", "backpressure": [],
            "linkQuality": [{"sourceId": run.SOURCE, "transport": "network",
                "absorber": {"enabled": True, "peakHeldBytes10m": 0, "peakHeldMs10m": 0,
                    "laggardExcludeMsMax10m": None, "overflowBytesTotal": overflow},
                "histograms": {"chunkSizeBucketUpperBytes": [65536], "chunkSizeCounts": [1]},
                "attribution": {"last": attribution, "counts10m": {key: int(key == attribution) for key in ("none", "link", "consumer", "host", "unknown")}}}],
            "fanout": {"branches": [
                {"id": run.SINK, "sourceId": run.SOURCE, "droppedBytesTotal": 0, "totalBytesWritten": 1000},
                {"id": "decoder-" + run.SIBLING, "sourceId": run.SOURCE, "droppedBytesTotal": drops, "totalBytesWritten": 1000}]},
            "decoders": [{"id": run.SINK, "restartCount": 0, "running": True,
                "health": "idle", "pid": 20, "uptime": 100}],
            "efficiency": {"sources": [{"sourceId": run.SOURCE, "admitted": [], "blocked": []}]}}

    def test_schedule_joint_cycle(self):
        schedule = run.stall_schedule("lossless").split(",")
        self.assertEqual(len(schedule), 28)
        self.assertEqual([int(p.split(":")[0]) for p in schedule[:7]], list(run.INTERVALS))
        self.assertEqual([int(p.split(":")[1]) for p in schedule[:4]], [150, 500, 1000, 1800])
        self.assertEqual(run.stall_schedule("consumer"), "")

    def test_drop_percent(self):
        self.assertEqual(run.branch_percent({"droppedBytesTotal": 25, "totalBytesWritten": 100}), 25)

    def test_live_overflow_cannot_use_latest_attribution(self):
        experiment = self.experiment()
        experiment.record(self.sample(attribution="link", overflow=1))
        experiment.record(self.sample(attribution="consumer", overflow=2))
        self.assertEqual(experiment.interval_failures, set())
        self.assertEqual(experiment.summary["overflowBytes"], 1)
        self.assertIn("aggregate consumer or host classifications increased", experiment.failures())

    def test_upstream_counter_rises_without_core_overflow(self):
        experiment = self.experiment("upstream")
        sample = self.sample()
        sample["backpressure"] = [{"sourceId": run.SOURCE, "available": True,
                                   "bytesDroppedUpstream": 0}]
        experiment.record(sample)
        sample["backpressure"][0]["bytesDroppedUpstream"] = 1000
        experiment.record(sample)
        self.assertEqual(experiment.summary["upstreamDroppedBytes"], 1000)
        self.assertEqual(experiment.failures(), [])

    def test_sink_pid_change_invalidates(self):
        experiment = self.experiment()
        experiment.record(self.sample())
        sample = self.sample()
        sample["decoders"][0]["pid"] = 21
        with self.assertRaises(run.InvalidRun):
            experiment.record(sample)

    def test_initial_budget_denial_is_not_suspension(self):
        experiment = self.experiment()
        sample = self.sample()
        sample["efficiency"]["sources"][0]["blocked"] = [{
            "decoderId": "catalogue", "sourceId": run.SOURCE, "channelHz": None,
            "detail": "budget", "probation": False}]
        experiment.record(sample)
        self.assertEqual(experiment.summary["suspensions"], [])

    def test_missing_sibling_invalidates(self):
        experiment = self.experiment()
        sample = self.sample()
        sample["fanout"]["branches"] = sample["fanout"]["branches"][:1]
        with self.assertRaisesRegex(run.InvalidRun, "sibling"):
            experiment.record(sample)

    def test_missing_histogram_invalidates(self):
        experiment = self.experiment()
        sample = self.sample()
        sample["linkQuality"][0]["histograms"]["chunkSizeCounts"] = [0]
        with self.assertRaises(run.InvalidRun):
            experiment.record(sample)


if __name__ == "__main__":
    unittest.main()
