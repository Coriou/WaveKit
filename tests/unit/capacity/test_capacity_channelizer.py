import importlib.util, os, pathlib, sys, tempfile, unittest
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

if __name__ == "__main__":
    unittest.main()
