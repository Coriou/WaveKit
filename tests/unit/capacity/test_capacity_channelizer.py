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

if __name__ == "__main__":
    unittest.main()
