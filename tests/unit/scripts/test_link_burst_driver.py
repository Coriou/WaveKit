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
        absorber = {"peakHeldMs10m": 2500, "peakHeldBytes10m": 0, "laggardExcludeMsMax10m": None}
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

    def test_host_consumer_share_at_and_past_its_bound(self):
        experiment = self.experiment("host")
        experiment.summary["overflowBytes"] = 100
        experiment.attributions["host"] = 1
        # 1 consumer of 10 judged = 10 %: at the bound passes.
        experiment.monitor_counts.update(host=9, consumer=1)
        self.assertEqual(experiment.failures(), [])
        # 2 of 11 = 18 %, and the recorded 143 of 235, fail.
        experiment.monitor_counts.update(consumer=1)
        self.assertIn("host overload was attributed consumer beyond its share", experiment.failures())
        experiment.monitor_counts.clear()
        experiment.monitor_counts.update(host=92, consumer=143)
        self.assertIn("host overload was attributed consumer beyond its share", experiment.failures())
        # The recorded 2.4 Msps residual, 9 of 280, passes.
        experiment.monitor_counts.clear()
        experiment.monitor_counts.update(host=271, consumer=9)
        self.assertEqual(experiment.failures(), [])

    def test_upstream_host_scenario_uses_drop_mode_and_host_throttling(self):
        experiment = self.experiment("upstream-host")
        self.assertEqual(experiment.env["LINK_BURST_MODE"], "drop")
        self.assertEqual(experiment.env["LINK_BURST_SCHEDULE"], driver.stall_schedule("upstream"))
        self.assertIn("upstream-host", driver.HOST_SCENARIOS)
        self.assertIn("upstream-host", driver.UPSTREAM_SCENARIOS)

    def poll(self, experiment, overflow, sink, upstream, unknown, link=0, period=2.1):
        experiment.polls += 1
        experiment.poll_mono[experiment.polls] = experiment.poll_mono.get(experiment.polls - 1, 0) + period
        experiment.record_attribution(dict(link=link, consumer=0, host=0, unknown=unknown))
        branches = [dict(id="sink", droppedBytesTotal=sink), dict(id="sibling", droppedBytesTotal=0)]
        experiment.record_coincidence(overflow, branches, dict(bytesDroppedUpstream=upstream))

    def test_upstream_host_requires_coinciding_loss_attributed_unknown(self):
        experiment = self.experiment("upstream-host")
        experiment.summary["upstreamDroppedBytes"] = 100
        self.poll(experiment, 0, 0, 0, 0)
        # Upstream loss alone, then core loss alone: never coinciding.
        self.poll(experiment, 0, 0, 50, 0)
        self.poll(experiment, 0, 10, 50, 0)
        self.assertIn("core loss never coincided with upstream loss", experiment.failures())
        # Both rise in poll 4; no unknown in polls 4..7 fails.
        self.poll(experiment, 0, 20, 60, 0)
        self.assertEqual(experiment.coincident_polls, [4])
        for _ in range(4):
            self.poll(experiment, 0, 20, 60, 0)
        self.assertIn("coinciding core and upstream loss was not attributed unknown",
                      experiment.failures())

    def test_upstream_host_pairing_window_follows_the_monitor_pending_wait(self):
        # Pending wait 12.2 s plus one tick, one 4 s stall and one tick.
        self.assertAlmostEqual(driver.UPSTREAM_UNKNOWN_PAIRING_S, 20.2)
        # With 2.1 s polls the poll before the unknown must be under 20.2 s
        # after the coinciding poll: an unknown ten polls later pairs (the poll
        # before is 9 * 2.1 = 18.9 s on), eleven does not (10 * 2.1 = 21 s).
        for delay, paired in ((0, True), (3, True), (10, True), (11, False)):
            experiment = self.experiment("upstream-host")
            experiment.summary["upstreamDroppedBytes"] = 100
            self.poll(experiment, 0, 0, 0, 0)
            # Absorber overflow is core loss too.
            self.poll(experiment, 5, 0, 1, 1 if delay == 0 else 0)
            for i in range(1, 12):
                # Overflow keeps rising (core loss), upstream stays flat.
                self.poll(experiment, 5 + i, 0, 1, 1 if i >= delay and delay else 0)
            failures = experiment.failures()
            self.assertEqual("coinciding core and upstream loss was not attributed unknown" in failures,
                             not paired, delay)

    def test_upstream_host_pairs_the_recorded_2400000_held_loss(self):
        # Recorded 2.4 Msps run, polls 63-69: the upstream counter rose with core
        # loss in poll 64; the held stall loss resolved unknown (+2) in poll 69,
        # 10.8 s later, with core loss in every poll. The former three-poll
        # window rejected it.
        mono = (140.0, 142.1, 144.3, 146.5, 148.6, 150.8, 152.9)
        core = (983, 458, 1899, 1245, 2227, 4259, 1702)
        experiment = self.experiment("upstream-host")
        experiment.summary["upstreamDroppedBytes"] = 12058624
        upstream, unknown, total = 0, 0, 0
        for index, (at, loss) in enumerate(zip(mono, core)):
            total += loss * 1000
            upstream += 12058624 if index == 1 else 0
            unknown += 2 if index == 6 else 0
            experiment.polls += 1
            experiment.poll_mono[experiment.polls] = at
            experiment.record_attribution(dict(link=0, consumer=0, host=0, unknown=unknown))
            experiment.record_coincidence(0, [dict(id="sink", droppedBytesTotal=total)],
                                          dict(bytesDroppedUpstream=upstream))
        self.assertEqual(experiment.coincident_polls, [2])
        self.assertEqual(experiment.unknown_polls, [7])
        self.assertEqual(experiment.failures(), [])
        self.assertEqual(experiment.result([]), "pass")

    def test_upstream_host_without_coincidence_is_not_applicable(self):
        experiment = self.experiment("upstream-host")
        experiment.summary["upstreamDroppedBytes"] = 100
        self.poll(experiment, 0, 0, 0, 0)
        # Host loss, then a stall poll without core loss: never coinciding.
        self.poll(experiment, 0, 10, 0, 0)
        self.poll(experiment, 0, 10, 100, 0)
        failures = experiment.failures()
        self.assertEqual(failures, ["core loss never coincided with upstream loss"])
        self.assertEqual(experiment.result(failures), "not-applicable")
        self.assertEqual(driver.RESULT_EXIT["not-applicable"], 3)
        # Any other failure still fails the row.
        self.poll(experiment, 0, 20, 100, 0, link=1)
        self.assertEqual(experiment.result(experiment.failures()), "fail")

    def test_upstream_host_without_core_loss_is_not_not_applicable(self):
        experiment = self.experiment("upstream-host")
        experiment.summary["upstreamDroppedBytes"] = 100
        self.poll(experiment, 0, 0, 0, 0)
        self.poll(experiment, 0, 0, 100, 0)
        failures = experiment.failures()
        self.assertIn("core loss never coincided with upstream loss", failures)
        self.assertEqual(experiment.result(failures), "fail")

    def test_upstream_host_rejects_a_drop_free_unknown(self):
        experiment = self.experiment("upstream-host")
        experiment.summary["upstreamDroppedBytes"] = 100
        self.poll(experiment, 0, 0, 0, 0)
        self.poll(experiment, 0, 10, 100, 0)
        # Loss counters unchanged; unknown rises in a drop-free interval.
        self.poll(experiment, 0, 10, 100, 1)
        self.assertEqual(experiment.coincident_polls, [2])
        self.assertEqual(experiment.unknown_polls, [3])
        self.assertIn("coinciding core and upstream loss was not attributed unknown",
                      experiment.failures())
        # A later unknown whose own poll bears core loss pairs.
        self.poll(experiment, 0, 20, 100, 2)
        self.assertEqual(experiment.failures(), [])

    def test_upstream_host_link_increase_fails(self):
        experiment = self.experiment("upstream-host")
        experiment.summary["upstreamDroppedBytes"] = 100
        self.poll(experiment, 0, 0, 0, 0)
        self.poll(experiment, 0, 10, 5, 1, link=1)
        self.assertEqual(experiment.failures(),
                         ["aggregate link classifications increased with upstream loss"])

    def test_exclusion_bound_rounds_loop_delay_up_to_meter_resolution(self):
        experiment = self.experiment("consumer")
        experiment.summary["oneChunkMs"] = 16
        self.assertEqual(experiment.exclusion_bound(14.8), 500 + 16 + 20)
        self.assertEqual(experiment.exclusion_bound(20), 500 + 16 + 20)
        with self.assertRaises(driver.InvalidRun):
            experiment.exclusion_bound(None)

    def test_amended_latency_criterion(self):
        experiment = self.experiment("consumer")
        experiment.summary["oneChunkMs"] = 16
        experiment.exclusion = {"ms": 531, "loopMs": 15}
        # 1966080 B at 4096000 B/s and an assumed 1x excess drain in 480 ms.
        experiment.drain = {"ms": 900, "bytes": 1966080, "exclusionMs": 500, "loopMs": 15}
        self.assertEqual(experiment.latency_failures(), [])
        self.assertEqual(experiment.summary["consumerDrainBoundMs"], 536 + 480)
        experiment.exclusion["ms"] = 537
        self.assertIn("laggard exclusion exceeded laggard plus one chunk plus loop delay",
                      experiment.latency_failures())
        experiment.exclusion["ms"] = 500
        experiment.drain["ms"] = 1017
        failures = experiment.latency_failures()
        self.assertIn("post-exclusion drain exceeded its bound", failures)
        self.assertIn("implied sibling excess rate is below the assumption", failures)

    def test_host_scenario_reserves_a_cpu_for_the_fake(self):
        self.assertEqual(driver.cpu_split(6), ("0-1", "5"))
        self.assertEqual(driver.cpu_split(3), ("0-1", "2"))
        with self.assertRaises(driver.InvalidRun):
            driver.cpu_split(2)
        self.assertEqual(driver.HOST_CORE_QUOTA, "0.75")

    def test_upstream_waits_for_upstream_statistics(self):
        experiment = self.experiment("upstream")
        reports = [dict(sourceId=driver.SOURCE, transport="network")]
        fanout = {"branches": [dict(sourceId=driver.SOURCE, id="decoder-" + driver.SINK),
                               dict(sourceId=driver.SOURCE, id="decoder-" + driver.SIBLING)]}
        backpressure = [dict(sourceId=driver.SOURCE, available=False)]
        experiment.get = Mock(side_effect=lambda path: {
            "/api/resources/link-quality": reports, "/api/telemetry/fanout": fanout,
            "/api/resources/backpressure": backpressure}[path])
        self.assertFalse(experiment.ready())
        backpressure[0]["available"] = True
        self.assertTrue(experiment.ready())
        experiment.args.scenario = "lossless"
        backpressure[0]["available"] = False
        self.assertTrue(experiment.ready())

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
