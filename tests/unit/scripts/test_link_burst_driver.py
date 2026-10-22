import argparse
import importlib.util
from pathlib import Path
import signal
import tempfile
from unittest.mock import Mock, patch
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

    def test_aggregate_overflow_attribution(self):
        for scenario in ("overflow", "upstream"):
            experiment = self.experiment(scenario)
            experiment.summary["overflowBytes"] = 100
            experiment.summary["upstreamDroppedBytes"] = 100
            experiment.record_attribution(dict(link=5, consumer=2, host=1, unknown=0))
            self.assertIn("aggregate link classifications did not increase", experiment.failures())
            experiment.record_attribution(dict(link=6, consumer=2, host=1, unknown=0))
            self.assertEqual(experiment.failures(), [])
            self.assertEqual(experiment.summary["attributionCheck"], "aggregate")
            experiment.record_attribution(dict(link=7, consumer=3, host=1, unknown=0))
            self.assertIn("aggregate consumer or host classifications increased", experiment.failures())
        experiment = self.experiment("overflow")
        experiment.monitor_counts["link"] = 1
        self.assertIn("overflow was not exercised", experiment.failures())

    def test_host_increase_fails_and_window_expiry_is_not_an_increase(self):
        experiment = self.experiment("overflow")
        experiment.summary["overflowBytes"] = 10
        experiment.record_attribution(dict(link=10, consumer=4, host=2))
        experiment.record_attribution(dict(link=9, consumer=3, host=1))
        self.assertEqual(experiment.monitor_counts["consumer"], 0)
        experiment.record_attribution(dict(link=10, consumer=3, host=2))
        self.assertIn("aggregate consumer or host classifications increased", experiment.failures())

    def test_smooth_link_recreates_only_fake_and_waits_for_traffic(self):
        experiment = self.experiment("late-shed")
        original_command = list(experiment.command)
        experiment.compose = Mock()
        experiment.get = Mock(side_effect=[
            [dict(id=driver.SOURCE, connected=False, bytesReceived=100)],
            [dict(id=driver.SOURCE, connected=True, bytesReceived=100)],
            [dict(id=driver.SOURCE, connected=True, bytesReceived=200)]])
        with patch.object(driver.time, "sleep"):
            experiment.smooth_link()
        self.assertEqual(experiment.command, original_command)
        self.assertEqual(experiment.env["LINK_BURST_SCHEDULE"], "")
        experiment.compose.assert_called_once_with(
            "up", "-d", "--no-deps", "--force-recreate", "--no-build", "--pull", "never", "fake")
        self.assertEqual(experiment.get.call_count, 3)
        self.assertEqual(experiment.phase, "reconnecting")
        self.assertIsNone(experiment.slow_at)
        self.assertIsNone(experiment.consumer_baseline)

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

    def test_host_accepts_absorber_overflow_as_exercised_loss(self):
        experiment = self.experiment("host")
        experiment.attributions["host"] = 1
        self.assertIn("host drops were not exercised", experiment.failures())
        experiment.summary["overflowBytes"] = 100
        self.assertEqual(experiment.failures(), [])

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
