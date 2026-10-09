import importlib.util, json, os, pathlib, sys, tempfile, types, unittest
from unittest import mock
ROOT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "capacity"
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

class FakeRtlTcpFile(unittest.TestCase):
    def test_file_period_is_even_and_exact(self):
        fake = load("fake_rtl_tcp")
        with tempfile.NamedTemporaryFile(suffix=".cu8", delete=False) as f:
            f.write(bytes(range(7)))
        self.addCleanup(os.unlink, f.name)
        self.assertEqual(fake.load_period(f.name, 2048000, 0), bytes(range(6)))
    def test_non_loop_ends_after_the_file(self):
        fake = load("fake_rtl_tcp")
        period = bytes(fake.BLOCK + 10)
        block, offset, done = fake.next_block(period, 0, False)
        self.assertEqual((len(block), done), (fake.BLOCK, False))
        block, offset, done = fake.next_block(period, offset, False)
        self.assertEqual((len(block), done), (10, True))
    def test_loop_wraps(self):
        fake = load("fake_rtl_tcp")
        period = bytes(fake.BLOCK + 10)
        _, offset, _ = fake.next_block(period, 0, True)
        block, offset, done = fake.next_block(period, offset, True)
        self.assertEqual((len(block), offset, done), (fake.BLOCK, (2 * fake.BLOCK) % len(period), False))
    def test_loop_seam_content(self):
        # Consecutive blocks are the period repeated, across the seam, also for a period shorter than BLOCK.
        fake = load("fake_rtl_tcp")
        for size in (fake.BLOCK + 10, fake.BLOCK // 3 + 2):
            period = bytes(i % 251 for i in range(size))
            first, offset, _ = fake.next_block(period, 0, True)
            second, _, _ = fake.next_block(period, offset, True)
            want = (period * (2 * fake.BLOCK // size + 2))[:2 * fake.BLOCK]
            if size > fake.BLOCK:
                self.assertEqual(want, (period * 3)[:2 * fake.BLOCK])
            self.assertEqual(first + second, want, size)

def admissible(x, center, rate, usable, half):
    """Addendum §6 with the 1e-6 Hz tolerance of both admission implementations (Review Focus 1)."""
    return abs(x - center) + half <= rate * usable / 2 + 1e-6

class Placements(unittest.TestCase):
    # Capture tuned 100 kHz above the AIS pair; the signal channel is the A/B pair centre 162.000 MHz,
    # because AIS-catcher demodulates A and B at ±25 kHz from its input centre.
    CENTER, SIGNAL, AIS_OUT = 162_100_000, 162_000_000, 384_000

    def test_every_placement_is_admissible(self):
        # Plan A10. Applied literally, the §9 formula puts AIS at ±716.8 kHz (N=8, 2.048 Msps): channel-outside-capture.
        run = load("run_capacity")
        for rate in (2_048_000, 2_400_000):
            for n in (1, 4, 8):
                for mode in ("spread", "clustered"):
                    p = run.placements(self.CENTER, rate, 0.8, n, mode, self.SIGNAL, self.AIS_OUT)
                    self.assertEqual(len(p), n, (rate, n, mode))
                    self.assertIn(self.SIGNAL, p)
                    self.assertTrue(all(isinstance(x, int) for x in p))
                    bad = [x for x in p if not admissible(x, self.CENTER, rate, 0.8, self.AIS_OUT / 2)]
                    self.assertEqual(bad, [], (rate, n, mode))

    def test_spread_spans_the_admissible_range(self):
        run = load("run_capacity")
        p = sorted(run.placements(self.CENTER, 2_048_000, 0.8, 8, "spread", self.CENTER, self.AIS_OUT))
        # admissible half-range L = 819 200 - 192 000 = 627 200; outer spread points at ±L·7/8
        self.assertEqual((p[0] - self.CENTER, p[-1] - self.CENTER), (-548_800, 548_800))

    def test_clustered_spacing_and_single(self):
        run = load("run_capacity")
        p = run.placements(self.CENTER, 2_048_000, 0.8, 8, "clustered", self.CENTER, 48_000)
        self.assertEqual(sorted(p)[1] - sorted(p)[0], 60_000)  # 1.25 × out fits, so the step is unchanged
        self.assertEqual(run.placements(self.CENTER, 2_048_000, 0.8, 1, "spread", self.SIGNAL, self.AIS_OUT), [self.SIGNAL])

    def test_clustered_shrinks_and_shifts_to_fit(self):
        run = load("run_capacity")
        p = sorted(run.placements(self.CENTER, 2_048_000, 0.8, 8, "clustered", self.SIGNAL, self.AIS_OUT))
        self.assertEqual((p[0] - self.CENTER, p[-1] - self.CENTER), (-627_200, 627_200))  # step ⌊2L/7⌋ = 179 200
        self.assertEqual(len(set(p)), 8)

    def test_inadmissible_signal_is_an_error(self):
        run = load("run_capacity")
        with self.assertRaises(ValueError):
            run.placements(self.CENTER, 2_048_000, 0.8, 4, "spread", self.CENTER + 700_000, self.AIS_OUT)

class DecoderReadiness(unittest.TestCase):
    def test_flags_suspended_stopped_and_missing(self):
        run = load("run_capacity")
        statuses = [
            {"id": "ais-catcher-ch0", "running": True, "suspended": False, "health": "running"},
            {"id": "ais-catcher-ch1", "running": False, "suspended": True, "health": "running"},
            {"id": "ais-catcher-ch2", "running": False, "suspended": False, "health": "faulted"},
        ]
        ids = [f"ais-catcher-ch{k}" for k in range(4)]
        self.assertEqual(run.decoder_problems(statuses, ids), [
            "ais-catcher-ch1: suspended",
            "ais-catcher-ch2: not running (faulted)",
            "ais-catcher-ch3: missing",
        ])

    def test_all_running_passes(self):
        run = load("run_capacity")
        self.assertEqual(run.decoder_problems([{"id": "a", "running": True, "suspended": False}], ["a"]), [])

class DecoderStatuses(unittest.TestCase):
    def statuses(self, returncode, stdout):
        run = load("run_capacity")
        reply = types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr="")
        with mock.patch.object(run.subprocess, "run", return_value=reply):
            return run.decoder_statuses()

    def test_non_json_reply_is_no_statuses(self):
        # Fail-safe: every instance then reads as missing, so the run exits 5 with meta.aborted set.
        self.assertEqual(self.statuses(0, "<html>502 Bad Gateway</html>"), [])
        self.assertEqual(self.statuses(0, ""), [])
        self.assertEqual(self.statuses(0, '{"error": "not a list"}'), [])
        self.assertEqual(self.statuses(7, ""), [])

    def test_json_list_passes_through(self):
        self.assertEqual(self.statuses(0, '[{"id": "a", "running": true}]'), [{"id": "a", "running": True}])

class RepoRoot(unittest.TestCase):
    def test_repo_points_at_the_manifest_accessor(self):
        run = load("run_capacity")
        self.assertTrue((run.REPO / "fixtures" / "manifest-query.mjs").is_file())

class WriteConfig(unittest.TestCase):
    def write(self, **kwargs):
        run = load("run_capacity")
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / "config.yaml"
            run.write_config(path, 2_048_000, [("ais-catcher-ch0", "ais-catcher", {"channelHz": 162_000_000})],
                             162_000_000, **kwargs)
            return path.read_text()

    def test_pins_band_suspension_digital_voice_and_state_dir(self):
        # Delta E12: without bandSuspension: false, N AIS instances at spread channelHz exit 5.
        for channelizer in (False, True):
            text = self.write(channelizer=channelizer)
            self.assertIn("health:\n  bandSuspension: false\n", text)
            self.assertIn("digitalVoice:\n  enabled: false\n", text)
            self.assertIn("stateDir: /tmp/wkcap-state\n", text)
            self.assertIn("liveDemod:\n  enabled: false\n", text)

    def test_channelizer_flag(self):
        on, off = self.write(channelizer=True), self.write()
        self.assertIn("channelizer:\n  enabled: true\n", on)
        self.assertIn("    useChannelizer: true\n", on)
        self.assertNotIn("useChannelizer", off)
        self.assertNotIn("channelizer:", off)
        self.assertIn('"channelHz": 162000000', off)

    def test_header_names_the_source(self):
        self.assertTrue(self.write().startswith("# Generated by scripts/capacity/run_capacity.py - SYNTHETIC source\n"))
        fixture = self.write(fixture_id="ais_162m_2048k")
        self.assertTrue(fixture.startswith("# Generated by scripts/capacity/run_capacity.py - fixture "
                                           "ais_162m_2048k replayed by fake_rtl_tcp.py\n"), fixture)
        self.assertNotIn("SYNTHETIC", fixture)

class ChannelizerSummary(unittest.TestCase):
    def test_parses_stats_lines(self):
        s = load("summarize")
        log = "\n".join([
            '{"msg":"channelizer stats","channels":[{"id":"a-g1","queueHighWaterBytes":1000,"droppedSamples":0,"saturatedSamples":2}]}',
            '{"msg":"channelizer stats","channels":[{"id":"a-g1","queueHighWaterBytes":4000,"droppedSamples":5,"saturatedSamples":3}]}',
            '{"msg":"Channel discontinuity","cause":"queue-overflow","channelId":"a-g1"}',
            'not json',
        ])
        r = s.channelizer_stats(log)
        self.assertEqual(r["queueHighWaterBytes"], {"a-g1": 4000})
        self.assertEqual(r["droppedSamples"], {"a-g1": 5})
        self.assertEqual(r["queueOverflowEvents"], 1)
    def test_sampler_labels_the_channelizer(self):
        sampler = load("sampler")
        self.assertTrue(hasattr(sampler, "label"))
        sampler.read = lambda path: "/usr/local/bin/wavekit-chan\0--socket\0/var/run/wavekit/chan/rtl.sock\0"
        self.assertEqual(sampler.label(1), "wavekit-chan")

    def test_stats_ignore_other_lines(self):
        s = load("summarize")
        log = "\n".join([
            '{"msg":"Channel discontinuity","cause":"input-gap","channelId":"a-g1"}',
            '{"msg":"something else","channels":[{"id":"x","queueHighWaterBytes":9}]}',
            '{"msg":"channelizer stats","channels":[{"id":"b-g2","queueHighWaterBytes":7,"droppedSamples":1,"saturatedSamples":0}]}',
            '{"msg":"channelizer stats","channels":[{"id":"b-g2","queueHighWaterBytes":3,"droppedSamples":2,"saturatedSamples":4}]}',
        ])
        self.assertEqual(s.channelizer_stats(log), {
            "queueHighWaterBytes": {"b-g2": 7}, "queueHighWaterBytesAtWindowStart": {},
            "droppedSamples": {"b-g2": 2}, "saturatedSamples": {"b-g2": 4}, "queueOverflowEvents": 0})

    def test_summarize_reports_channelizer_and_its_cpu(self):
        s = load("summarize")

        def proc(pid, cmd, cpu):
            return {"pid": pid, "cmd": cmd, "rssKiB": 2048, "pssKiB": 1024, "pssAnonKiB": 512,
                    "pssShmemKiB": 0, "utime": cpu, "stime": 0.0}

        def sample(t, usage, chan_cpu):
            return {"ts": 1000.0 + t, "t": t, "cpu": {"usage_usec": usage, "user_usec": usage,
                                                     "system_usec": 0, "throttled_usec": 0},
                    "mem": {"current": 2**20, "peak": 2**20, "anon": 0, "shmem": 0},
                    "memEvents": {}, "decoders": [], "branches": [],
                    "procs": [proc(7, "wavekit-chan", chan_cpu), proc(9, "python sampler.py", 0.0)]}

        with tempfile.TemporaryDirectory() as d:
            run = pathlib.Path(d)
            (run / "meta.json").write_text('{"rate": 2048000, "buffers": "on", "decoders": ["a"], '
                                           '"channelizer": "on", "channels": 4}')
            (run / "samples.jsonl").write_text(
                json.dumps(sample(0, 0, 1.0)) + "\n" + json.dumps(sample(10, 5_000_000, 3.0)) + "\n")
            (run / "app.log").write_text(
                # No windowWall in meta: the window is the sampler's ts span, 1000-1010 s.
                '{"time":"1970-01-01T00:16:45.000Z","msg":"channelizer stats","channels":[{"id":"a-g1","queueHighWaterBytes":64,'
                '"droppedSamples":0,"saturatedSamples":0}]}\n')
            r = s.summarize(run)
        self.assertEqual(r["cpuCores"]["wavekitChan"], 0.2)  # 2 CPU-seconds over a 10 s window
        self.assertEqual(r["channelizer"]["queueHighWaterBytes"], {"a-g1": 64})
        self.assertEqual((r["matrix"]["channelizer"], r["matrix"]["channels"]), ("on", 4))

    def test_summarize_without_app_log(self):
        s = load("summarize")
        self.assertEqual(s.channelizer_stats(""), {"queueHighWaterBytes": {}, "queueHighWaterBytesAtWindowStart": {},
                                                   "droppedSamples": {}, "saturatedSamples": {},
                                                   "queueOverflowEvents": 0})

    # Window 1000-1010 s (meta windowWall); pino isoTime stamps. 2001-09-09T01:46:40Z is epoch 1e9.
    WARMUP_AND_TEARDOWN_LOG = "\n".join([
        # warm-up: drops and an overflow before the window must not count
        '{"time":"2001-09-09T01:46:35.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":500,"droppedSamples":10,"saturatedSamples":1}]}',
        '{"time":"2001-09-09T01:46:38.000Z","msg":"Channel discontinuity","cause":"queue-overflow","channelId":"a"}',
        '{"time":"2001-09-09T01:46:39.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":800,"droppedSamples":40,"saturatedSamples":2}]}',
        # window
        '{"time":"2001-09-09T01:46:42.000Z","msg":"Channel discontinuity","cause":"queue-overflow","channelId":"a"}',
        '{"time":"2001-09-09T01:46:44.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":900,"droppedSamples":45,"saturatedSamples":2},{"id":"b","queueHighWaterBytes":64,"droppedSamples":3,"saturatedSamples":0}]}',
        '{"time":"2001-09-09T01:46:49.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":900,"droppedSamples":47,"saturatedSamples":5},{"id":"b","queueHighWaterBytes":64,"droppedSamples":3,"saturatedSamples":0}]}',
        # teardown: after the window end
        '{"time":"2001-09-09T01:46:52.000Z","msg":"Channel discontinuity","cause":"queue-overflow","channelId":"a"}',
        '{"time":"2001-09-09T01:46:54.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":99999,"droppedSamples":9000,"saturatedSamples":900}]}',
    ])

    def test_stats_are_restricted_to_the_window(self):
        s = load("summarize")
        r = s.channelizer_stats(self.WARMUP_AND_TEARDOWN_LOG, (1_000_000_000.0, 1_000_000_010.0))
        self.assertEqual(r, {
            "queueHighWaterBytes": {"a": 900, "b": 64},
            "queueHighWaterBytesAtWindowStart": {"a": 800},
            "droppedSamples": {"a": 7, "b": 3},  # 47 - 40; b opened inside the window
            "saturatedSamples": {"a": 3, "b": 0},
            "queueOverflowEvents": 1,
        })

    def test_counter_restart_inside_the_window(self):
        # A new wavekit-chan generation restarts the cumulative counters from zero.
        s = load("summarize")
        log = "\n".join([
            '{"time":"2001-09-09T01:46:39.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":8,"droppedSamples":40,"saturatedSamples":0}]}',
            '{"time":"2001-09-09T01:46:44.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":8,"droppedSamples":50,"saturatedSamples":0}]}',
            '{"time":"2001-09-09T01:46:49.000Z","msg":"channelizer stats","channels":[{"id":"a","queueHighWaterBytes":8,"droppedSamples":4,"saturatedSamples":0}]}',
        ])
        r = s.channelizer_stats(log, (1_000_000_000.0, 1_000_000_010.0))
        self.assertEqual(r["droppedSamples"], {"a": 14})

    def test_summarize_uses_the_window_in_meta(self):
        s = load("summarize")
        with tempfile.TemporaryDirectory() as d:
            run = pathlib.Path(d)
            (run / "meta.json").write_text(json.dumps({
                "rate": 2048000, "buffers": "on", "decoders": ["a"],
                "windowWall": {"start": 1_000_000_000.0, "end": 1_000_000_010.0}}))
            sample = {"ts": 0, "t": 0, "cpu": {"usage_usec": 0, "user_usec": 0, "system_usec": 0,
                                               "throttled_usec": 0},
                      "mem": {"current": 1, "peak": 1, "anon": 0, "shmem": 0}, "memEvents": {},
                      "decoders": [], "branches": []}
            (run / "samples.jsonl").write_text(json.dumps(sample) + "\n" + json.dumps({**sample, "ts": 10, "t": 10}) + "\n")
            (run / "app.log").write_text(self.WARMUP_AND_TEARDOWN_LOG + "\n")
            r = s.summarize(run)
        self.assertEqual((r["channelizer"]["droppedSamples"], r["channelizer"]["queueOverflowEvents"]),
                         ({"a": 7, "b": 3}, 1))

if __name__ == "__main__":
    unittest.main()
