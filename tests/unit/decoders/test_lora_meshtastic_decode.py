"""docker/scripts/lora_meshtastic_decode.py self-test; run by lora-meshtastic-wrapper.test.ts.

The header, assembler and drop-counter cases need only the stdlib. The decrypt
cases need the `cryptography` and `protobuf` modules (the image installs
python3-cryptography and python3-protobuf) and skip without them.
"""
import base64
import contextlib
import importlib.util
import io
from pathlib import Path
import random
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "docker" / "scripts" / "lora_meshtastic_decode.py"
FRAME = (ROOT / "fixtures" / "lora" / "meshtastic_onair_frame.bin").read_bytes()

spec = importlib.util.spec_from_file_location("lora_meshtastic_decode", SCRIPT)
wrapper = importlib.util.module_from_spec(spec)
# dataclasses resolve annotations through sys.modules, so register before exec.
sys.modules[spec.name] = wrapper
spec.loader.exec_module(wrapper)


def has_decrypt_modules() -> bool:
    if wrapper.Cipher is None:
        return False
    try:
        wrapper.add_proto_paths()
        import mesh_pb2  # noqa: F401
    except ImportError:
        return False
    return True


HAS_DECRYPT = has_decrypt_modules()
DEFAULT_KEY = wrapper.decode_channel_key("AQ==")
EVENT_FIELDS = {"frequency": 869525000, "bw": 250000, "sf": 11, "cr": 5}


def data_factory():
    import mesh_pb2

    return mesh_pb2.Data()


class Recorder:
    def __init__(self):
        self.drops = []

    def __call__(self, reason):
        self.drops.append(reason)


class HeaderTest(unittest.TestCase):
    def test_fixture_header(self):
        header = wrapper.parse_onair_header(FRAME)
        self.assertEqual(len(FRAME), 33)
        self.assertEqual(header.to, 0xFFFFFFFF)
        self.assertEqual(header.from_node, 169552957)
        self.assertEqual(header.packet_id, 305419896)
        self.assertEqual(header.flags, 0x63)
        self.assertEqual(header.hop_limit, 3)
        self.assertEqual(header.hop_start, 3)
        self.assertFalse(header.want_ack)
        self.assertFalse(header.via_mqtt)
        self.assertEqual(header.channel_hash, 0x08)
        self.assertEqual((header.next_hop, header.relay_node), (0, 0))

    def test_flag_bits(self):
        frame = bytearray(FRAME)
        frame[12] = 0x08 | 0x10 | 0xE0 | 0x05
        header = wrapper.parse_onair_header(bytes(frame))
        self.assertEqual((header.hop_limit, header.hop_start), (5, 7))
        self.assertTrue(header.want_ack)
        self.assertTrue(header.via_mqtt)

    def test_header_bound(self):
        # 16 bytes is the whole header: accepted; 15 is short.
        wrapper.parse_onair_header(FRAME[:16])
        with self.assertRaises(wrapper.FrameError) as ctx:
            wrapper.parse_onair_header(FRAME[:15])
        self.assertEqual(ctx.exception.reason, "short_frame")

    def test_nonce(self):
        nonce = wrapper.build_nonce(169552957, 305419896)
        self.assertEqual(nonce.hex(), "78563412000000003d2c1b0a00000000")


class AssemblerTest(unittest.TestCase):
    def test_frame_split_across_chunks(self):
        rec = Recorder()
        asm = wrapper.FrameAssembler(rec)
        self.assertEqual(asm.feed(b"\xaa\xbb" + FRAME[:10], [(2, 33, True)]), [])
        frames = asm.feed(FRAME[10:], [])
        self.assertEqual(frames, [wrapper.AssembledFrame(FRAME, True)])
        self.assertEqual(rec.drops, [])

    def test_back_to_back_frames_in_one_chunk(self):
        rec = Recorder()
        asm = wrapper.FrameAssembler(rec)
        frames = asm.feed(FRAME + b"\x01\x02", [(0, 33, True), (33, 2, False)])
        self.assertEqual(
            frames,
            [
                wrapper.AssembledFrame(FRAME, True),
                wrapper.AssembledFrame(b"\x01\x02", False),
            ],
        )

    def test_binary_bytes_survive(self):
        payload = bytes(range(256))[:255]
        frames = wrapper.FrameAssembler(Recorder()).feed(payload, [(0, 255, None)])
        self.assertEqual(frames[0].payload, payload)
        self.assertIsNone(frames[0].crc_valid)

    def test_truncated_frame_is_dropped(self):
        rec = Recorder()
        asm = wrapper.FrameAssembler(rec)
        frames = asm.feed(FRAME[:5] + FRAME, [(0, 33, True), (5, 33, True)])
        self.assertEqual(frames, [wrapper.AssembledFrame(FRAME, True)])
        self.assertEqual(rec.drops, ["truncated"])

    def test_pay_len_bounds(self):
        # 255 is the largest LoRa explicit-header length; 0, 256 and a missing value are corrupt.
        for pay_len, ok in ((1, True), (255, True), (0, False), (256, False), (None, False)):
            rec = Recorder()
            frames = wrapper.FrameAssembler(rec).feed(b"\x00" * 300, [(0, pay_len, True)])
            self.assertEqual(len(frames), 1 if ok else 0, pay_len)
            self.assertEqual(rec.drops, [] if ok else ["bad_frame_info"], pay_len)

    def test_untagged_bytes_are_ignored(self):
        rec = Recorder()
        self.assertEqual(wrapper.FrameAssembler(rec).feed(FRAME, []), [])
        self.assertEqual(rec.drops, [])


class DropCounterTest(unittest.TestCase):
    def test_summary_rate_limit(self):
        now = [0.0]
        lines = []
        drops = wrapper.DropCounter(
            log=lambda event, **f: lines.append((event, f)), clock=lambda: now[0]
        )
        for _ in range(500):
            drops.drop("crc_bad")
        now[0] = 59.9
        drops.drop("data_parse")
        self.assertEqual(lines, [])
        now[0] = 60.0
        drops.maybe_log()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0][0], "frame_drops")
        self.assertEqual(lines[0][1]["drops"], {"crc_bad": 500, "data_parse": 1})
        now[0] = 200.0
        drops.maybe_log()  # nothing new since the last line
        self.assertEqual(len(lines), 1)
        drops.final_summary()
        self.assertEqual(lines[-1][0], "frame_drop_summary")
        self.assertEqual(lines[-1][1]["drops"], {"crc_bad": 500, "data_parse": 1})


class ChannelKeyTest(unittest.TestCase):
    def test_accepted_sizes(self):
        self.assertEqual(len(DEFAULT_KEY), 16)
        self.assertEqual(wrapper.decode_channel_key("Ag==")[15], (DEFAULT_KEY[15] + 1) & 0xFF)
        for n in (16, 32):
            key = bytes(range(n))
            self.assertEqual(wrapper.decode_channel_key(base64.b64encode(key).decode()), key)

    def test_rejected_sizes(self):
        for n in (0, 2, 15, 17, 24, 31, 33, 64):
            with self.assertRaises(ValueError, msg=n):
                wrapper.decode_channel_key(base64.b64encode(bytes(n)).decode())
        with self.assertRaises(ValueError):
            wrapper.decode_channel_key("AA==")
        with self.assertRaises(ValueError):
            wrapper.decode_channel_key("not base64!")


def encrypt_frame(frame, key):
    """Re-encrypts `frame`'s Data payload under `key` (AES-CTR, same nonce)."""
    header = wrapper.parse_onair_header(frame)
    nonce = wrapper.build_nonce(header.from_node, header.packet_id)
    plaintext = wrapper.aes_ctr(DEFAULT_KEY, nonce, frame[wrapper.ONAIR_HEADER_LEN :])
    encryptor = wrapper.Cipher(wrapper.algorithms.AES(key), wrapper.modes.CTR(nonce)).encryptor()
    ciphertext = encryptor.update(plaintext) + encryptor.finalize()
    return frame[: wrapper.ONAIR_HEADER_LEN] + ciphertext


@unittest.skipUnless(HAS_DECRYPT, "cryptography or protobuf missing")
class DecryptTest(unittest.TestCase):
    def process(self, payload, crc_valid=True, key=DEFAULT_KEY):
        drops = wrapper.DropCounter(log=lambda *a, **k: None)
        event = wrapper.process_frame(
            wrapper.AssembledFrame(payload, crc_valid), key, data_factory, drops, EVENT_FIELDS
        )
        return event, drops

    def test_fixture_frame_decodes(self):
        event, drops = self.process(FRAME)
        self.assertIsNotNone(event)
        self.assertEqual(event["portnum"], 1)
        self.assertEqual(base64.b64decode(event["payload_b64"]), b"hello wavekit")
        self.assertEqual(event["payload_b64"], "aGVsbG8gd2F2ZWtpdA==")
        self.assertEqual(event["payload_len"], 13)
        self.assertEqual(event["from"], 169552957)
        self.assertEqual(event["id"], 305419896)
        self.assertEqual(event["to"], 0xFFFFFFFF)
        self.assertEqual(event["channel"], 8)
        self.assertEqual((event["hop_limit"], event["hop_start"]), (3, 3))
        self.assertIs(event["want_ack"], False)
        self.assertNotIn("via_mqtt", event)
        self.assertEqual(drops.decoded, 1)

    def test_aes256_key_round_trip(self):
        key_b64 = base64.b64encode(bytes(range(100, 132))).decode()
        key = wrapper.decode_channel_key(key_b64)
        self.assertEqual(len(key), 32)
        frame = encrypt_frame(FRAME, key)
        self.assertNotEqual(frame, FRAME)
        event, drops = self.process(frame, key=key)
        self.assertIsNotNone(event)
        self.assertEqual(base64.b64decode(event["payload_b64"]), b"hello wavekit")
        self.assertEqual(drops.decoded, 1)
        # The default key cannot read it.
        self.assertIsNone(self.process(frame)[0])

    def test_bad_crc_is_dropped(self):
        event, drops = self.process(FRAME, crc_valid=False)
        self.assertIsNone(event)
        self.assertEqual(dict(drops.total), {"crc_bad": 1})

    def test_unverified_crc_is_dropped(self):
        event, drops = self.process(FRAME, crc_valid=None)
        self.assertIsNone(event)
        self.assertEqual(dict(drops.total), {"crc_unverified": 1})

    def test_corrupt_ciphertext_is_dropped(self):
        # CTR flips the same plaintext bit: 0x08 (field 1, varint) becomes 0xf7, wire type 7.
        frame = bytearray(FRAME)
        frame[16] ^= 0xFF
        event, drops = self.process(bytes(frame))
        self.assertIsNone(event)
        self.assertEqual(dict(drops.total), {"data_parse": 1})

    def test_header_only_and_short_frames_are_dropped(self):
        self.assertEqual(dict(self.process(FRAME[:16])[1].total), {"empty_payload": 1})
        self.assertEqual(dict(self.process(FRAME[:7])[1].total), {"short_frame": 1})

    def test_garbage_with_bad_crc_never_emits(self):
        rng = random.Random(1234)
        for _ in range(200):
            garbage = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 80)))
            event, drops = self.process(garbage, crc_valid=False)
            self.assertIsNone(event)
            self.assertEqual(dict(drops.total), {"crc_bad": 1})

    def test_garbage_with_valid_crc_never_raises(self):
        rng = random.Random(5678)
        for _ in range(200):
            garbage = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 80)))
            event, drops = self.process(garbage)
            if event is None:
                self.assertEqual(sum(drops.total.values()), 1)
            else:
                self.assertTrue(1 <= event["portnum"] <= wrapper.MAX_PORTNUM)


class OsFactorTest(unittest.TestCase):
    def test_integer_multiples(self):
        self.assertEqual(wrapper.os_factor_for(1_000_000.0, 250_000), 4)
        self.assertEqual(wrapper.os_factor_for(2_000_000.0, 250_000), 8)
        self.assertEqual(wrapper.os_factor_for(500_000.0, 250_000), 2)
        self.assertEqual(wrapper.os_factor_for(250_000.0, 62_500), 4)

    def test_non_integer_ratio_is_rejected(self):
        # A 1.024 Msps capture fed directly: 1.024e6 / 250e3 = 4.096.
        for samp_rate, bw in [(1_024_000.0, 250_000), (100_000.0, 250_000), (0.0, 250_000)]:
            with self.assertRaises(ValueError):
                wrapper.os_factor_for(samp_rate, bw)

    def test_main_exits_2_on_non_integer_ratio(self):
        argv = ["--bw", "250000", "--sf", "11", "--cr", "5", "--samp-rate", "1024000",
                "--frequency", "869525000", "--channel-key", "AQ==", "--region", "EU_868"]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(wrapper.main(argv), 2)
        self.assertIn("invalid_sample_rate", err.getvalue())


class CfoArgsTest(unittest.TestCase):
    ARGV = ["--bw", "250000", "--sf", "11", "--cr", "5", "--samp-rate", "500000",
            "--frequency", "869525000", "--channel-key", "AQ==", "--region", "EU_868"]

    def test_search_range_is_below_bw_over_4(self):
        # 2 x offset is read modulo bw: 250 kHz / 4 = 62.5 kHz is ambiguous.
        wrapper.check_cfo_args(0, 250_000, 16)
        wrapper.check_cfo_args(62_499, 250_000, 16)
        for bad in (62_500, -1):
            with self.assertRaises(ValueError):
                wrapper.check_cfo_args(bad, 250_000, 16)

    def test_preamble_len_floor_is_the_recentred_length(self):
        self.assertEqual(wrapper.RECENTRED_PREAMBLE_LEN, 8)
        wrapper.check_cfo_args(50_000, 250_000, 8)
        with self.assertRaises(ValueError):
            wrapper.check_cfo_args(50_000, 250_000, 7)

    def test_defaults(self):
        args = wrapper.parse_args(self.ARGV)
        self.assertEqual(args.cfo_search_hz, 0)
        self.assertEqual(args.preamble_len, wrapper.MESHTASTIC_PREAMBLE_LEN)
        self.assertEqual(wrapper.MESHTASTIC_PREAMBLE_LEN, 16)

    def test_main_exits_2_on_ambiguous_range(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(wrapper.main(self.ARGV + ["--cfo-search-hz", "62500"]), 2)
        self.assertIn("invalid_cfo_search", err.getvalue())

    def test_delay_budget(self):
        # The search knows a Meshtastic offset 16 + 1 + 5 + 2 = 24 symbols after the
        # correction must start; the delay line holds 32.
        lag = (wrapper.MESHTASTIC_PREAMBLE_LEN + 1 + wrapper.CFO_SFD_WINDOWS
               + wrapper.CFO_LEAD_SYMBOLS)
        self.assertEqual(lag, 24)
        self.assertEqual(wrapper.CFO_DELAY_SYMBOLS, 32)


# LongFast at os 2: 4096 input samples per symbol, 2048 bins.
SPS = 4096
TOLERANCE = wrapper.DEDUPE_TOLERANCE_SYMBOLS * SPS


class FrameDeduperTest(unittest.TestCase):
    def test_pairs_one_copy_per_path(self):
        dedupe = wrapper.FrameDeduper(TOLERANCE)
        self.assertTrue(dedupe.admit("direct", FRAME, 1_000_000))
        self.assertFalse(dedupe.admit("recentred", FRAME, 1_000_000 + 2 * SPS))
        # The pair is used up: the next copy is a new reception.
        self.assertTrue(dedupe.admit("recentred", FRAME, 1_000_000 + 2 * SPS))

    def test_same_path_never_pairs(self):
        dedupe = wrapper.FrameDeduper(TOLERANCE)
        self.assertTrue(dedupe.admit("direct", FRAME, 1_000_000))
        self.assertTrue(dedupe.admit("direct", FRAME, 1_000_000))

    def test_tolerance_bound(self):
        dedupe = wrapper.FrameDeduper(TOLERANCE)
        self.assertTrue(dedupe.admit("direct", FRAME, 1_000_000))
        self.assertFalse(dedupe.admit("recentred", FRAME, 1_000_000 - TOLERANCE))
        self.assertTrue(dedupe.admit("direct", FRAME, 2_000_000))
        self.assertTrue(dedupe.admit("recentred", FRAME, 2_000_000 + TOLERANCE + 1))

    def test_tolerance_arithmetic(self):
        # Worst position gap between the paths' copies of one frame, in symbols:
        # read race 1 + late sync word 1 + integer CFO 0.25 + 2 chips + 8 samples.
        worst = 1 + 1 + 0.25 + 2 / 2048 + 8 / SPS
        self.assertLess(worst, 2.5)
        self.assertLess(2.5, wrapper.DEDUPE_TOLERANCE_SYMBOLS)
        # Closest a second reception can start: 8 preamble + 4.25 + 8 header symbols.
        self.assertLess(wrapper.DEDUPE_TOLERANCE_SYMBOLS, 8 + 4.25 + 8)

    def test_relayed_copy_is_not_paired(self):
        dedupe = wrapper.FrameDeduper(TOLERANCE)
        relayed = bytearray(FRAME)
        relayed[12] = (relayed[12] & ~wrapper.FLAG_HOP_LIMIT_MASK) | 2
        self.assertTrue(dedupe.admit("direct", FRAME, 1_000_000))
        self.assertTrue(dedupe.admit("recentred", bytes(relayed), 1_000_000))

    def test_unknown_position_is_let_through(self):
        dedupe = wrapper.FrameDeduper(TOLERANCE)
        self.assertTrue(dedupe.admit("direct", FRAME, None))
        self.assertTrue(dedupe.admit("recentred", FRAME, None))
        self.assertTrue(dedupe.admit("recentred", FRAME, 5))

    def test_held_receptions_are_bounded(self):
        dedupe = wrapper.FrameDeduper(TOLERANCE, keep=8)
        for i in range(10_000):
            dedupe.admit("direct", FRAME, i * 100 * SPS)
        self.assertEqual(len(dedupe._seen), 8)

    def test_arrival_order_and_time_do_not_matter(self):
        # Two resends of identical bytes 0.4 s (49 symbols) apart, each decoded by
        # one path or by both, reach the deduper in every order: one packet per
        # reception, whatever the gap between callbacks (the old clock paired by
        # callback time, so a late recentred copy got through and a resend 0.4 s
        # later decoded by the other path was swallowed).
        rng = random.Random(42)
        resend = int(0.4 * 500_000)
        for decoded_by in (("direct", "recentred"), ("both", "both"), ("direct", "both"),
                           ("recentred", "direct"), ("both", "recentred")):
            for _ in range(50):
                copies = []
                for k, who in enumerate(decoded_by):
                    at = 3_000_000 + k * resend
                    paths = ("direct", "recentred") if who == "both" else (who,)
                    for path in paths:
                        jitter = rng.randint(-2 * SPS, 2 * SPS) if path == "recentred" else 0
                        copies.append((path, at + jitter))
                rng.shuffle(copies)
                dedupe = wrapper.FrameDeduper(TOLERANCE)
                emitted = sum(dedupe.admit(path, FRAME, at) for path, at in copies)
                self.assertEqual(emitted, len(decoded_by), (decoded_by, copies))


class FakeFrameSync:
    """frame_sync's counters across a lock: the lock call, then 8 header symbols
    (consume one symbol, +-1 sample, before publishing its output), then a stall
    until the header decoder answers. Each read lets 0..2 half-steps run first."""

    def __init__(self, rng, consumed_at_lock, written_at_lock, lock_consumes, bins, sps):
        self.rng = rng
        self.steps = [(consumed_at_lock + lock_consumes, written_at_lock)]
        consumed, written = self.steps[0]
        for _ in range(8):
            consumed += sps + rng.choice((-1, 0, 1))
            self.steps.append((consumed, written))  # consumed, output not yet published
            written += bins
            self.steps.append((consumed, written))
        # The probe holds the tagged item, so the first header symbol is published.
        self.i = 2

    def advance(self):
        self.i = min(len(self.steps) - 1, self.i + self.rng.randint(0, 2))

    def written(self):
        self.advance()
        return self.steps[self.i][1]

    def consumed(self):
        self.advance()
        return self.steps[self.i][0]


class LockPositionTest(unittest.TestCase):
    def test_bounded_whatever_the_probe_timing(self):
        rng = random.Random(7)
        bins = 2048
        for _ in range(2000):
            lock_consumes = rng.randint(-8, SPS // 2)
            fake = FakeFrameSync(rng, 9_000_000, 77 * bins, lock_consumes, bins, SPS)
            position = wrapper.lock_position(77 * bins, fake.written, fake.consumed, bins, SPS)
            truth = 9_000_000 + lock_consumes
            # Up to one symbol consumed before its output is published, plus drift.
            self.assertGreaterEqual(position, truth - 8)
            self.assertLessEqual(position, truth + SPS + 8)

    def test_exact_when_quiet(self):
        position = wrapper.lock_position(
            10 * 2048, lambda: 13 * 2048, lambda: 5_000_000, 2048, SPS)
        self.assertEqual(position, 5_000_000 - 3 * SPS)


class FramePositionsTest(unittest.TestCase):
    def test_sink_takes_confirmed_locks_in_order(self):
        positions = wrapper.FramePositions()
        positions.locked(100)
        positions.confirmed(33)
        positions.locked(200)  # invalid header: never confirmed
        positions.locked(300)
        positions.confirmed(40)
        self.assertEqual(positions.take(33), 100)
        self.assertEqual(positions.take(40), 300)
        self.assertIsNone(positions.take(40))

    def test_evicted_lock_leaves_its_frame_unmatched_not_misaligned(self):
        # 65 frames confirmed before the sink reaches the first: the first
        # lock falls off a 64-entry queue. Its frame must stay unmatched (so
        # it is never deduped), not take the second frame's position.
        reasons = Recorder()
        positions = wrapper.FramePositions(on_unmatched=reasons)
        for i in range(65):
            positions.locked(i * 409_600)
            positions.confirmed(33)
        self.assertIsNone(positions.take(33))
        self.assertEqual(reasons.drops, ["position_evicted"])
        for i in range(1, 65):
            self.assertEqual(positions.take(33), i * 409_600)
        self.assertEqual(reasons.drops, ["position_evicted"])

    def test_evicted_frame_is_never_deduped_against_a_retransmission(self):
        positions = wrapper.FramePositions()
        for i in range(65):
            positions.locked(i * 409_600)
            positions.confirmed(33)
        deduper = wrapper.FrameDeduper(tolerance=2048)
        self.assertTrue(deduper.admit("direct", FRAME, 409_600))
        self.assertTrue(deduper.admit("recentred", FRAME, positions.take(33)))

    def test_pay_len_mismatch_unmatches_until_two_clean_takes(self):
        reasons = Recorder()
        positions = wrapper.FramePositions(on_unmatched=reasons)
        for at, pay_len in ((100, 10), (200, 20), (300, 30)):
            positions.locked(at)
            positions.confirmed(pay_len)
        self.assertIsNone(positions.take(20))  # sink's first frame is not 10
        positions.locked(400)
        positions.confirmed(40)
        self.assertIsNone(positions.take(30))  # one lock queued, but not its length
        self.assertIsNone(positions.take(40))  # nothing confirmed since
        positions.locked(500)
        positions.confirmed(50)
        positions.locked(600)
        positions.confirmed(60)
        self.assertIsNone(positions.take(50))  # two locks queued
        for at in (700, 800):  # two clean takes: one new lock each, same length
            positions.locked(at)
            positions.confirmed(33)
            self.assertIsNone(positions.take(33))
        positions.locked(900)
        positions.confirmed(33)
        self.assertEqual(positions.take(33), 900)
        self.assertEqual(reasons.drops, ["position_unaligned"] * 6)

    def test_frame_without_a_confirmed_lock_unaligns(self):
        reasons = Recorder()
        positions = wrapper.FramePositions(on_unmatched=reasons)
        self.assertIsNone(positions.take(33))
        for at in (100, 200):
            positions.locked(at)
            positions.confirmed(33)
            self.assertIsNone(positions.take(33))
        positions.locked(300)
        positions.confirmed(33)
        self.assertEqual(positions.take(33), 300)
        self.assertEqual(reasons.drops, ["position_unaligned"] * 3)

    def test_confirm_without_lock_keeps_the_count(self):
        reasons = Recorder()
        positions = wrapper.FramePositions(on_unmatched=reasons)
        positions.confirmed(33)  # header tag missed: no position, still a frame
        positions.locked(100)
        positions.confirmed(40)
        self.assertIsNone(positions.take(33))
        self.assertEqual(positions.take(40), 100)
        self.assertEqual(reasons.drops, [])

    def test_queue_stays_bounded(self):
        positions = wrapper.FramePositions(keep=4)
        for i in range(100):
            positions.locked(i)
            positions.confirmed(33)
        self.assertEqual(len(positions._confirmed), 4)
        for _ in range(96):
            self.assertIsNone(positions.take(33))
        self.assertEqual([positions.take(33) for _ in range(4)], [96, 97, 98, 99])

    def test_assembler_carries_the_position(self):
        asm = wrapper.FrameAssembler(Recorder())
        frames = asm.feed(FRAME[:20], [(0, 33, True, 4242)])
        frames += asm.feed(FRAME[20:], [])
        self.assertEqual(frames, [wrapper.AssembledFrame(FRAME, True, 4242)])


try:
    import numpy as np
except ImportError:  # pragma: no cover - CI installs numpy
    np = None

SYNC_WORD_SYMBOLS = (16, 88)  # 0x2B: (0x2 << 3, 0xB << 3), as frame_sync maps it


def chirp(n, os_factor, symbol=0, down=False):
    """gr-lora_sdr build_upchirp(symbol, sf, os_factor), or the base downchirp."""
    k = np.arange(n * os_factor, dtype=np.float64)
    fold = n * os_factor - symbol * os_factor
    offset = np.where(k < fold, symbol / n - 0.5, symbol / n - 1.5)
    x = np.exp(2j * np.pi * (k * k / (2 * n) / os_factor ** 2 + offset * k / os_factor))
    return np.conj(x) if down else x


def lora_frame(sf, os_factor, preamble, rng, payload=24):
    n = 1 << sf
    parts = [chirp(n, os_factor)] * preamble
    parts += [chirp(n, os_factor, s) for s in SYNC_WORD_SYMBOLS]
    down = chirp(n, os_factor, down=True)
    parts += [down, down, down[: n * os_factor // 4]]
    parts += [chirp(n, os_factor, int(s)) for s in rng.integers(0, n, payload)]
    return np.concatenate(parts)


def capture(sf, os_factor, bw, cfo_hz, lead, preamble=8, snr_db=-10.0, seed=7):
    """Noise, then one frame starting at sample `lead` with a carrier offset of cfo_hz.

    snr_db is in the LoRa bandwidth: noise spreads over os_factor x bw.
    """
    rng = np.random.default_rng(seed)
    frame = lora_frame(sf, os_factor, preamble, rng)
    x = np.concatenate([np.zeros(lead), frame, np.zeros(4 * (os_factor << sf))])
    x = x * np.exp(2j * np.pi * cfo_hz * np.arange(len(x)) / (os_factor * bw))
    sigma = np.sqrt(os_factor / 10 ** (snr_db / 10) / 2)
    x = x + sigma * (rng.standard_normal(len(x)) + 1j * rng.standard_normal(len(x)))
    return x.astype(np.complex64)


def search_all(x, sf, os_factor, bw, max_hz, chunk=32768):
    search = wrapper.CfoSearch(sf, bw, os_factor, max_hz)
    found = []
    for i in range(0, len(x), chunk):
        found += search.feed(x[i:i + chunk])
    return found


@unittest.skipIf(np is None, "numpy missing")
class CfoSearchTest(unittest.TestCase):
    """// Feature: lora-cfo, coarse CFO search on synthetic preambles."""

    BW = 250_000
    BIN_HZ = BW / 2048

    def test_offsets_within_one_bin(self):
        # LongFast at os 2; +-bw/5 = +-50 kHz is the range the adapter asks for.
        sf, os_factor = 11, 2
        for preamble in (8, 16):
            for cfo_hz in (0, 2_000, -5_000, 10_000, -15_000, 20_000, -25_000, 30_000, -45_000, 50_000):
                with self.subTest(preamble=preamble, cfo_hz=cfo_hz):
                    lead = 40_000 + 777  # off the window grid by a fraction of a chip
                    found = search_all(capture(sf, os_factor, self.BW, cfo_hz, lead, preamble),
                                       sf, os_factor, self.BW, 50_000)
                    self.assertEqual(len(found), 1)
                    start, est = found[0]
                    self.assertLessEqual(abs(est - cfo_hz), 1.0 * self.BIN_HZ)
                    # The correction starts 1 to 3 symbols before the preamble, or 2 more
                    # when a noise window happens to land on the preamble's bin and the
                    # next one is forgiven as a stray.
                    symbol = os_factor << sf
                    self.assertGreaterEqual(start, lead - 5 * symbol)
                    self.assertLessEqual(start, lead - symbol)

    def test_unambiguous_to_bw_over_4(self):
        # 2c is read modulo N bins, so c resolves within [-N/4, N/4): +-62.5 kHz here.
        sf, os_factor = 11, 2
        for cfo_hz in (62_000, -62_000):
            found = search_all(capture(sf, os_factor, self.BW, cfo_hz, 30_000),
                               sf, os_factor, self.BW, 62_499)
            self.assertLessEqual(abs(found[0][1] - cfo_hz), self.BIN_HZ)
        # Just past bw/4 the estimate wraps by bw/2 to the other side.
        found = search_all(capture(sf, os_factor, self.BW, 63_000, 30_000),
                           sf, os_factor, self.BW, 62_499)
        self.assertLessEqual(abs(found[0][1] - (63_000 - self.BW / 2)), self.BIN_HZ)

    def test_max_cfo_bound(self):
        sf, os_factor = 11, 2
        x = capture(sf, os_factor, self.BW, 30_000, 30_000)
        self.assertEqual(len(search_all(x, sf, os_factor, self.BW, 30_000 + self.BIN_HZ)), 1)
        self.assertEqual(search_all(x, sf, os_factor, self.BW, 30_000 - 2 * self.BIN_HZ), [])

    def test_offsets_at_the_limit_are_found(self):
        # The estimate lands on half bins, so a true offset of exactly the limit
        # (50 kHz = 409.6 bins) reads 409.5 or 410 bins; 410 bins = 50 048.8 Hz is
        # above the limit and was rejected. The limit admits one more bin.
        sf, os_factor, limit = 11, 2, 50_000
        for seed in range(12):
            for sign in (1, -1):
                with self.subTest(seed=seed, sign=sign):
                    x = capture(sf, os_factor, self.BW, sign * limit, 40_000 + 137 * seed,
                                preamble=16, snr_db=10, seed=seed)
                    found = search_all(x, sf, os_factor, self.BW, limit)
                    self.assertEqual(len(found), 1)
                    self.assertLessEqual(abs(found[0][1] - sign * limit), self.BIN_HZ / 2)
        # The reviewed case: 50 048.83 Hz at a 50 kHz limit.
        x = capture(11, 2, self.BW, 50_000, 40_000, preamble=16, snr_db=10, seed=0)
        self.assertEqual(len(search_all(x, sf, os_factor, self.BW, limit)), 1)

    def test_offsets_past_the_limit_are_rejected(self):
        # 2.5 bins past the limit reads at least 2 bins past it (half-bin error),
        # beyond the one bin of slack.
        sf, os_factor, limit = 11, 2, 50_000
        for seed in range(10):
            for sign in (1, -1):
                with self.subTest(seed=seed, sign=sign):
                    cfo_hz = sign * (limit + 2.5 * self.BIN_HZ)
                    x = capture(sf, os_factor, self.BW, cfo_hz, 40_000 + 211 * seed,
                                preamble=16, snr_db=10, seed=seed)
                    self.assertEqual(search_all(x, sf, os_factor, self.BW, limit), [])
                    # The same capture is found once the limit covers it.
                    self.assertEqual(len(search_all(x, sf, os_factor, self.BW, limit + 3 * self.BIN_HZ)), 1)

    def test_slack_never_reaches_the_ambiguous_quarter(self):
        # -N/4 bins is also +N/4 (2c = N/2 mod N): rejected even when the limit
        # plus one bin passes bw/4.
        search = wrapper.CfoSearch(11, self.BW, 2, 62_499)
        search._sfd_u, search._sfd_best = 0, (100.0, 1024)  # (u + v) / 2 = 512 bins
        self.assertIsNone(search._finish())
        search._sfd_u, search._sfd_best = 0, (100.0, 1022)  # 511 bins = 62 377 Hz
        self.assertEqual(search._finish()[1], 511 * self.BIN_HZ)

    def test_run_history_is_bounded(self):
        # An unmodulated carrier keeps one bin forever: the run must not grow with it.
        search = wrapper.CfoSearch(11, self.BW, 2, 50_000)
        for _ in range(100_000):
            search._step(5, 100.0, 7, 1.0)
        self.assertLessEqual(len(search._run), wrapper.CFO_RUN_HISTORY)
        self.assertGreaterEqual(len(search._run), wrapper.CFO_MIN_RUN)
        # 24 upchirps (the longest preamble the delay line corrects) + 1 straddling window.
        self.assertGreaterEqual(wrapper.CFO_RUN_HISTORY, 25)

    def test_other_spreading_factors_and_os(self):
        # Each at its SF's sensitivity floor (SX127x datasheet: -7.5 dB at SF7,
        # 2.5 dB lower per SF step).
        for sf, os_factor, bw, cfo_hz in ((7, 2, 250_000, -40_000), (9, 4, 125_000, 20_000),
                                          (12, 2, 62_500, 10_000)):
            with self.subTest(sf=sf, os_factor=os_factor):
                snr_db = -7.5 - 2.5 * (sf - 7)
                x = capture(sf, os_factor, bw, cfo_hz, 5 * (os_factor << sf) + 3, snr_db=snr_db)
                found = search_all(x, sf, os_factor, bw, bw // 5)
                self.assertEqual(len(found), 1)
                self.assertLessEqual(abs(found[0][1] - cfo_hz), bw / (1 << sf))

    def test_chunking_does_not_matter(self):
        sf, os_factor = 11, 2
        x = capture(sf, os_factor, self.BW, -12_345, 50_001)
        whole = search_all(x, sf, os_factor, self.BW, 50_000, chunk=len(x))
        for chunk in (1, 777, 4096, 65_537):
            if chunk == 1:
                x_short = x[:200_000]
                self.assertEqual(search_all(x_short, sf, os_factor, self.BW, 50_000, chunk=997),
                                 search_all(x_short, sf, os_factor, self.BW, 50_000, chunk=len(x_short)))
                continue
            self.assertEqual(search_all(x, sf, os_factor, self.BW, 50_000, chunk=chunk), whole)

    def test_noise_alone_finds_nothing(self):
        rng = np.random.default_rng(3)
        x = (rng.standard_normal(2_000_000) + 1j * rng.standard_normal(2_000_000)).astype(np.complex64)
        self.assertEqual(search_all(x, 11, 2, self.BW, 50_000), [])
        self.assertEqual(search_all(x, 7, 2, self.BW, 50_000), [])

    def test_peak_ratio_floor(self):
        # A symbol at the SF11 floor (-17.5 dB) reaches 1 + 2048 x 10^-1.75 = 37, at
        # the SF7 floor (-7.5 dB) 1 + 128 x 10^-0.75 = 24; a chance SF11 run of 4
        # windows on one bin +-1 has probability p (3p / N)^3, p = N e^-8.
        self.assertEqual(wrapper.CFO_PEAK_RATIO, 8.0)
        self.assertGreater(1 + 2048 * 10 ** -1.75, 4.6 * wrapper.CFO_PEAK_RATIO)
        self.assertGreater(1 + 128 * 10 ** -0.75, 2.9 * wrapper.CFO_PEAK_RATIO)
        p = 2048 * np.exp(-8.0)
        self.assertLess(p * (3 * p / 2048) ** 3, 1e-9)
        # At the SF11 sensitivity floor the search still finds the preamble.
        found = search_all(capture(11, 2, self.BW, 17_000, 30_000, snr_db=-17.5),
                           11, 2, self.BW, 50_000)
        self.assertEqual(len(found), 1)
        self.assertLessEqual(abs(found[0][1] - 17_000), self.BIN_HZ)


@unittest.skipIf(np is None, "numpy missing")
class DelayedRotatorTest(unittest.TestCase):
    def test_delay_then_scheduled_shift(self):
        fs, delay = 500_000.0, 1000
        rot = wrapper.DelayedRotator(fs, delay)
        rot.schedule(1500, 10_000.0)
        x = np.ones(5000, dtype=np.complex64)
        y = np.concatenate([rot.process(x[:1234]), rot.process(x[1234:])])
        np.testing.assert_array_equal(y[:delay], 0)
        np.testing.assert_allclose(y[delay:delay + 1500], 1, atol=1e-6)
        n = np.arange(len(y) - delay - 1500)
        np.testing.assert_allclose(y[delay + 1500:], np.exp(-2j * np.pi * 10_000.0 * n / fs), atol=1e-4)

    def test_phase_is_continuous_across_switches(self):
        fs = 500_000.0
        rot = wrapper.DelayedRotator(fs, 0)
        rot.schedule(100, 5_000.0)
        rot.schedule(300, -7_000.0)
        y = rot.process(np.ones(600, dtype=np.complex64))
        step = np.angle(y[1:] * np.conj(y[:-1]))
        np.testing.assert_allclose(step[100:299], -2 * np.pi * 5_000.0 / fs, atol=1e-5)
        np.testing.assert_allclose(step[300:], 2 * np.pi * 7_000.0 / fs, atol=1e-5)
        np.testing.assert_allclose(np.abs(y), 1, atol=1e-6)

    def test_zero_frequency_keeps_the_phase(self):
        # 5 kHz for 123 samples turns the phase by -2pi x 5000 x 123 / 500 kHz;
        # switching to 0 Hz holds it there instead of snapping back to 1.
        fs = 500_000.0
        rot = wrapper.DelayedRotator(fs, 0)
        rot.schedule(0, 5_000.0)
        rot.schedule(123, 0.0)
        y = np.concatenate([rot.process(np.ones(100, dtype=np.complex64)),
                            rot.process(np.ones(200, dtype=np.complex64))])
        held = np.exp(-2j * np.pi * 5_000.0 * 123 / fs)
        self.assertAlmostEqual(held.real, 0.125333, places=5)
        self.assertAlmostEqual(held.imag, -0.992115, places=5)
        np.testing.assert_allclose(y[123:], held, atol=1e-5)
        # And a later switch continues from it.
        rot.schedule(300, 5_000.0)
        z = rot.process(np.ones(2, dtype=np.complex64))
        np.testing.assert_allclose(z, held * np.exp(-2j * np.pi * 5_000.0 * np.arange(2) / fs), atol=1e-5)

    def test_late_switch_applies_at_the_next_sample(self):
        rot = wrapper.DelayedRotator(500_000.0, 0)
        rot.process(np.ones(100, dtype=np.complex64))
        rot.schedule(10, 125_000.0)  # already emitted: quarter-turn steps from sample 100
        y = rot.process(np.ones(3, dtype=np.complex64))
        np.testing.assert_allclose(y, [1, -1j, -1], atol=1e-6)

    def test_correction_meets_the_preamble_within_the_delay_budget(self):
        # The search knows a P-upchirp preamble's offset at most P + 8 symbols after
        # the correction must start (CfoSearchTest constants), so the 32-symbol delay
        # line takes it in time up to P = 24 (Meshtastic sends 16) and late past it.
        # One-symbol blocks: the source block holding the detection starts at most
        # one symbol before it.
        sf, os_factor, bw = 11, 2, 250_000
        symbol = os_factor << sf
        delay = wrapper.CFO_DELAY_SYMBOLS * symbol
        for preamble, in_time in ((16, True), (24, True), (28, False)):
            with self.subTest(preamble=preamble):
                x = capture(sf, os_factor, bw, 20_000, 20 * symbol + 333, preamble)
                search = wrapper.CfoSearch(sf, bw, os_factor, 50_000)
                rot = wrapper.DelayedRotator(float(os_factor * bw), delay)
                lags = []
                for i in range(0, len(x), symbol):
                    block = x[i:i + symbol]
                    for at, cfo_hz in search.feed(block):
                        # The rotator's next output sample is input sample i - delay.
                        lags.append(i - at)
                        rot.schedule(at, cfo_hz)
                    rot.process(block)
                self.assertEqual(len(lags), 1)
                self.assertLessEqual(lags[0], (preamble + 8) * symbol)
                self.assertEqual(lags[0] <= delay, in_time)


if __name__ == "__main__":
    unittest.main()
