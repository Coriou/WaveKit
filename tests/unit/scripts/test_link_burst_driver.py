import argparse
import importlib.util
from pathlib import Path
import signal
import tempfile
from unittest.mock import Mock
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("driver", ROOT / "scripts/link-burst/run_acceptance.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class DriverTests(unittest.TestCase):
    def experiment(self, scenario):
        experiment = driver.Experiment(argparse.Namespace(
            rate=2048000, minutes=10, scenario=scenario, out=Path("unused")))
        experiment.summary["branches"] = {
            "sibling": {"sink": False, "droppedBytesTotal": 0},
            "sink": {"sink": True, "droppedBytesTotal": 0}}
        return experiment

    def test_upstream_does_not_require_core_overflow(self):
        experiment = self.experiment("upstream")
        experiment.summary["upstreamDroppedBytes"] = 100
        self.assertEqual(experiment.failures(), [])
        experiment.summary["upstreamDroppedBytes"] = 0
        self.assertIn("upstream drops were not exercised", experiment.failures())

    def test_unpaired_overflow_is_invalid(self):
        experiment = self.experiment("overflow")
        experiment.summary["overflowAttributionUnavailable"] = True
        with self.assertRaisesRegex(driver.InvalidRun, "completed interval"):
            experiment.failures()

    def test_consumer_window_excludes_link_phase(self):
        experiment = self.experiment("late-shed")
        experiment.slow_at = 100
        branches = [{"id": "sibling", "droppedBytesTotal": 500}]
        absorber = {"peakHeldMs10m": 2500, "laggardExcludeMsMax10m": None}
        experiment.record_consumer({"phase": "link-only", "mono": 99}, absorber, branches)
        self.assertIsNone(experiment.consumer_baseline)
        experiment.record_consumer({"phase": "consumer", "mono": 100}, absorber, branches)
        self.assertEqual(experiment.summary["consumerSiblingDrops"], 0)
        self.assertIsNone(experiment.consumer_peaks)
        absorber["peakHeldMs10m"] = 50
        experiment.record_consumer({"phase": "consumer", "mono": 700}, absorber, branches)
        self.assertEqual(experiment.consumer_peaks, 50)
        branches[0]["droppedBytesTotal"] += 10
        experiment.record_consumer({"phase": "consumer", "mono": 702}, absorber, branches)
        self.assertEqual(experiment.summary["consumerSiblingDrops"], 10)

    def test_interruption_tears_down(self):
        experiment = self.experiment("upstream")
        with tempfile.TemporaryDirectory() as directory:
            experiment.args.out = Path(directory)
            experiment.compose = Mock(side_effect=[driver.InvalidRun("interrupted by SIGTERM"), None])
            self.assertEqual(experiment.run(), 2)
            self.assertEqual(experiment.compose.call_args.args, ("down", "--volumes", "--remove-orphans"))
            self.assertTrue((Path(directory) / "summary.json").exists())

    def test_signals_raise_catchable_interruption(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.assertRaisesRegex(driver.InvalidRun, signal.Signals(sig).name):
                driver.interrupted(sig, None)


if __name__ == "__main__":
    unittest.main()
