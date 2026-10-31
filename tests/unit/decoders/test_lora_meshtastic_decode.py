"""docker/scripts/lora_meshtastic_decode.py self-test; run by lora-meshtastic-wrapper.test.ts.

The header, assembler and drop-counter cases need only the stdlib. The decrypt
cases need the `cryptography` and `protobuf` modules (the image installs
python3-cryptography and python3-protobuf) and skip without them.
"""
import base64
import importlib.util
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


if __name__ == "__main__":
    unittest.main()
