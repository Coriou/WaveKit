#!/usr/bin/env python3
"""LoRa/Meshtastic stdin decoder for WaveKit.

Reads interleaved cu8 IQ from stdin, converts it to complex float samples,
demodulates LoRa frames with gr-lora_sdr, decrypts Meshtastic payloads, and
emits one JSON object per decoded packet on stdout.

The frame parsing, CRC gate and decryption below the flowgraph are pure Python
(stdlib, `cryptography`, the vendored `mesh_pb2`), so they are unit-testable
without gnuradio: tests/unit/decoders/test_lora_meshtastic_decode.py.
"""

from __future__ import annotations

import argparse
import base64
import binascii
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import signal
import struct
import sys
import time
from typing import Any, Callable
import warnings

# Guarded so --help and the pure header/assembler code work without it; main()
# refuses to start when it is missing.
try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:  # pragma: no cover - exercised only on hosts without it
    Cipher = None  # type: ignore[assignment,misc]

DEFAULT_CHANNEL_PSK = bytes(
    [
        0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59,
        0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01,
    ]
)

# On-air Meshtastic PacketHeader (firmware RadioInterface.h), little-endian:
# to u32, from u32, id u32, flags u8, channel hash u8, next_hop u8, relay_node u8.
ONAIR_HEADER = struct.Struct("<IIIBBBB")
ONAIR_HEADER_LEN = ONAIR_HEADER.size  # 16 bytes
FLAG_HOP_LIMIT_MASK = 0x07
FLAG_WANT_ACK = 0x08
FLAG_VIA_MQTT = 0x10
FLAG_HOP_START_SHIFT = 5

# The LoRa explicit header carries the payload length in one byte, so no frame
# exceeds 255 bytes; a frame_info tag claiming more is corrupt.
MAX_LORA_PAYLOAD_LEN = 255

# PortNum is a protobuf enum in 0..511 (256..511 are private apps); 0 is
# UNKNOWN_APP, which a real sender never transmits. A plaintext that parses
# outside 1..511 is a wrong-key or garbage decrypt.
MAX_PORTNUM = 511

# At most one drop-summary line per minute on stderr, whatever the drop rate;
# a final summary is written at exit.
DROP_SUMMARY_INTERVAL_S = 60.0


class FrameError(ValueError):
    """A frame that cannot become a packet. `reason` is a fixed drop code."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def add_proto_paths() -> None:
    script_dir = Path(__file__).resolve().parent
    for path in (
        script_dir / "meshtastic_proto",
        Path("/usr/local/lib/wavekit/meshtastic_proto"),
    ):
        if path.exists():
            sys.path.insert(0, str(path))


def log_stderr(event: str, **fields: Any) -> None:
    record = {"event": event, **fields}
    print(json.dumps(record, sort_keys=True), file=sys.stderr, flush=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Decode Meshtastic LoRa packets from cu8 IQ on stdin.",
    )
    parser.add_argument("--bw", type=int, required=True, help="LoRa bandwidth in Hz")
    parser.add_argument("--sf", type=int, required=True, help="LoRa spreading factor")
    parser.add_argument("--cr", type=int, required=True, help="LoRa coding rate 5..8")
    parser.add_argument(
        "--samp-rate",
        type=float,
        required=True,
        help="Effective complex sample rate in Hz; an integer multiple of --bw",
    )
    parser.add_argument(
        "--frequency",
        type=int,
        required=True,
        help="Configured tuned frequency in Hz",
    )
    parser.add_argument(
        "--channel-key",
        required=True,
        help='Base64 channel PSK, with "AQ==" expanded to the default PSK',
    )
    parser.add_argument("--region", required=True, help="Meshtastic region label")
    return parser.parse_args(argv)


def os_factor_for(samp_rate: float, bw: int) -> int:
    """Integer oversampling factor gr-lora_sdr frame_sync needs (samp_rate = bw * os_factor).

    frame_sync takes one sample per os_factor without resampling, so a rate that is not an
    integer multiple of bw (1.024 Msps / 250 kHz = 4.096) mistimes every chip. Reject it
    rather than round. A 1e-6 relative tolerance absorbs float parsing of an exact rate.
    """
    if bw <= 0 or samp_rate <= 0:
        raise ValueError("samp_rate and bw must be positive")
    ratio = float(samp_rate) / float(bw)
    factor = int(round(ratio))
    if factor < 1 or abs(ratio - factor) > 1e-6 * ratio:
        raise ValueError(
            f"samp_rate {samp_rate:g} is not an integer multiple of bw {bw}"
        )
    return factor


def decode_channel_key(value: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error as exc:
        raise ValueError("channel key is not valid base64") from exc

    # Meshtastic shorthand (per firmware Channels.cpp):
    #   - 1 byte 0x00      = encryption disabled (not supported in v1)
    #   - 1 byte 0x01..FF  = defaultpsk with psk[15] += (idx - 1)
    #   - 16 bytes         = explicit AES-128 PSK
    #   - 32 bytes         = explicit AES-256 PSK
    if len(decoded) == 1:
        idx = decoded[0]
        if idx == 0:
            raise ValueError(
                "channel key 0x00 indicates encryption disabled; "
                "the lora-meshtastic decoder requires an encrypted channel in v1"
            )
        psk = bytearray(DEFAULT_CHANNEL_PSK)
        psk[15] = (psk[15] + idx - 1) & 0xFF
        return bytes(psk)
    if len(decoded) not in (16, 32):
        raise ValueError(
            "channel key must decode to a single shorthand byte (0x01..0xFF), "
            "16 bytes for a custom AES-128 PSK or 32 bytes for AES-256"
        )
    return decoded


def build_nonce(from_node: int, packet_id: int) -> bytes:
    return (
        int(packet_id).to_bytes(8, "little", signed=False)
        + int(from_node).to_bytes(4, "little", signed=False)
        + b"\x00\x00\x00\x00"
    )


@dataclass(frozen=True)
class OnAirHeader:
    to: int
    from_node: int
    packet_id: int
    flags: int
    channel_hash: int
    next_hop: int
    relay_node: int

    @property
    def hop_limit(self) -> int:
        return self.flags & FLAG_HOP_LIMIT_MASK

    @property
    def hop_start(self) -> int:
        return (self.flags >> FLAG_HOP_START_SHIFT) & FLAG_HOP_LIMIT_MASK

    @property
    def want_ack(self) -> bool:
        return bool(self.flags & FLAG_WANT_ACK)

    @property
    def via_mqtt(self) -> bool:
        return bool(self.flags & FLAG_VIA_MQTT)


def parse_onair_header(frame: bytes) -> OnAirHeader:
    """Unpacks the 16-byte header that precedes the encrypted Data payload.

    An on-air frame is this header plus AES-CTR ciphertext, not a serialized
    MeshPacket protobuf.
    """
    if len(frame) < ONAIR_HEADER_LEN:
        raise FrameError("short_frame")
    return OnAirHeader(*ONAIR_HEADER.unpack_from(frame, 0))


def aes_ctr(channel_key: bytes, nonce: bytes, data: bytes) -> bytes:
    if Cipher is None:
        raise FrameError("no_crypto")
    cipher = Cipher(algorithms.AES(channel_key), modes.CTR(nonce)).decryptor()
    return cipher.update(data) + cipher.finalize()


@dataclass(frozen=True)
class DecodedFrame:
    header: OnAirHeader
    portnum: int
    payload: bytes


def decode_frame(
    frame: bytes,
    channel_key: bytes,
    data_factory: Callable[[], Any],
) -> DecodedFrame:
    """Header parse, channel-PSK decrypt and Data protobuf parse of one frame.

    `data_factory` builds an empty `mesh_pb2.Data`. Raises FrameError with a
    fixed reason; never echoes frame bytes.
    """
    header = parse_onair_header(frame)
    ciphertext = frame[ONAIR_HEADER_LEN:]
    if not ciphertext:
        raise FrameError("empty_payload")
    plaintext = aes_ctr(
        channel_key, build_nonce(header.from_node, header.packet_id), ciphertext
    )
    data = data_factory()
    try:
        # Garbage plaintext can make protobuf warn (RuntimeWarning) on stderr per frame.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            data.ParseFromString(plaintext)
    except Exception as exc:  # protobuf raises DecodeError, a plain Exception
        raise FrameError("data_parse") from exc
    portnum = int(data.portnum)
    if not 1 <= portnum <= MAX_PORTNUM:
        raise FrameError("bad_portnum")
    return DecodedFrame(header=header, portnum=portnum, payload=bytes(data.payload))


def packet_event(
    decoded: DecodedFrame,
    *,
    frequency: int,
    bw: int,
    sf: int,
    cr: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The adapter's JSONL wire shape (lora-meshtastic.ts PacketWireSchema)."""
    header = decoded.header
    rx_time = (now or datetime.now(UTC)).astimezone(UTC)
    event: dict[str, Any] = {
        "from": header.from_node,
        "to": header.to,
        "id": header.packet_id,
        "channel": header.channel_hash,
        "hop_limit": header.hop_limit,
        "hop_start": header.hop_start,
        "want_ack": header.want_ack,
        "portnum": decoded.portnum,
        "payload_b64": base64.b64encode(decoded.payload).decode("ascii"),
        "payload_len": len(decoded.payload),
        # gr-lora_sdr does not report RSSI/SNR per frame: 0 means unavailable.
        "rx_rssi": 0,
        "rx_snr": 0.0,
        "rx_time": rx_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "frequency": int(frequency),
        "bw": int(bw),
        "sf": int(sf),
        "cr": int(cr),
    }
    if header.via_mqtt:
        event["via_mqtt"] = True
    return event


@dataclass(frozen=True)
class AssembledFrame:
    payload: bytes
    # crc_verif's verdict from the frame_info tag; None when the tag lacked it.
    crc_valid: bool | None


class FrameAssembler:
    """Cuts crc_verif's byte stream into frames using its frame_info tags.

    crc_verif writes each frame's payload (CRC bytes stripped) to its output
    stream and tags the first byte with frame_info {pay_len, crc_valid, ...}.
    Reading bytes off the stream is binary-safe, unlike its `msg` port, whose
    pmt symbol UTF-8-decodes in Python and fails on any byte >= 0x80.
    """

    def __init__(self, on_drop: Callable[[str], None]) -> None:
        self._on_drop = on_drop
        self._buffer = bytearray()
        self._expected = 0
        self._crc_valid: bool | None = None
        self._active = False

    def feed(
        self,
        data: bytes,
        tags: list[tuple[int, int | None, bool | None]],
    ) -> list[AssembledFrame]:
        """`tags` holds (relative offset, pay_len, crc_valid), offsets in 0..len(data)."""
        frames: list[AssembledFrame] = []
        cursor = 0
        for offset, pay_len, crc_valid in sorted(tags, key=lambda t: t[0]):
            offset = max(cursor, min(offset, len(data)))
            self._take(data[cursor:offset], frames)
            cursor = offset
            if self._active:
                self._on_drop("truncated")
            self._start(pay_len, crc_valid)
        self._take(data[cursor:], frames)
        return frames

    def _start(self, pay_len: int | None, crc_valid: bool | None) -> None:
        self._buffer.clear()
        if pay_len is None or not 1 <= pay_len <= MAX_LORA_PAYLOAD_LEN:
            self._active = False
            self._on_drop("bad_frame_info")
            return
        self._expected = pay_len
        self._crc_valid = crc_valid
        self._active = True

    def _take(self, chunk: bytes, frames: list[AssembledFrame]) -> None:
        # Bytes outside an active frame (before the first tag, after a bad
        # frame_info) are skipped, never parsed.
        if not self._active or not chunk:
            return
        need = self._expected - len(self._buffer)
        self._buffer.extend(chunk[:need])
        if len(self._buffer) == self._expected:
            frames.append(AssembledFrame(bytes(self._buffer), self._crc_valid))
            self._buffer.clear()
            self._active = False


class DropCounter:
    """Counts dropped frames by fixed reason and writes rate-limited summaries."""

    def __init__(
        self,
        log: Callable[..., None] = log_stderr,
        clock: Callable[[], float] = time.monotonic,
        interval_s: float = DROP_SUMMARY_INTERVAL_S,
    ) -> None:
        self._log = log
        self._clock = clock
        self._interval_s = interval_s
        self._last_log = clock()
        self.total: Counter[str] = Counter()
        self._since_log: Counter[str] = Counter()
        self.decoded = 0

    def drop(self, reason: str) -> None:
        self.total[reason] += 1
        self._since_log[reason] += 1
        self.maybe_log()

    def maybe_log(self) -> None:
        now = self._clock()
        if not self._since_log or now - self._last_log < self._interval_s:
            return
        self._log(
            "frame_drops",
            drops=dict(sorted(self._since_log.items())),
            decoded_total=self.decoded,
            interval_s=round(now - self._last_log, 1),
        )
        self._since_log.clear()
        self._last_log = now

    def final_summary(self) -> None:
        self._log(
            "frame_drop_summary",
            drops=dict(sorted(self.total.items())),
            decoded_total=self.decoded,
        )


def process_frame(
    frame: AssembledFrame,
    channel_key: bytes,
    data_factory: Callable[[], Any],
    drops: DropCounter,
    event_fields: dict[str, int],
) -> dict[str, Any] | None:
    """CRC gate then decode; returns the JSON event or None (counted as a drop)."""
    if frame.crc_valid is None:
        drops.drop("crc_unverified")
        return None
    if not frame.crc_valid:
        drops.drop("crc_bad")
        return None
    try:
        decoded = decode_frame(frame.payload, channel_key, data_factory)
    except FrameError as exc:
        drops.drop(exc.reason)
        return None
    drops.decoded += 1
    return packet_event(decoded, **event_fields)


def frame_info_fields(pmt: Any, value: Any) -> tuple[int | None, bool | None]:
    """Reads pay_len and crc_valid from a frame_info pmt dict, tolerating gaps."""
    if not pmt.is_dict(value):
        return None, None
    pay_len_pmt = pmt.dict_ref(value, pmt.intern("pay_len"), pmt.PMT_NIL)
    crc_pmt = pmt.dict_ref(value, pmt.intern("crc_valid"), pmt.PMT_NIL)
    pay_len = int(pmt.to_long(pay_len_pmt)) if pmt.is_integer(pay_len_pmt) else None
    crc_valid = bool(pmt.to_bool(crc_pmt)) if pmt.is_bool(crc_pmt) else None
    return pay_len, crc_valid


def build_flowgraph(
    args: argparse.Namespace,
    channel_key: bytes,
    drops: DropCounter,
) -> Any:
    # gnuradio and numpy are heavy imports; defer to keep --help fast.
    import numpy
    import pmt
    from gnuradio import gr
    import gnuradio.lora_sdr as lora_sdr

    add_proto_paths()
    import mesh_pb2

    event_fields = {
        "frequency": int(args.frequency),
        "bw": int(args.bw),
        "sf": int(args.sf),
        "cr": int(args.cr),
    }

    class Cu8StdinSource(gr.sync_block):
        def __init__(self, fd: int, chunk_bytes: int = 65536) -> None:
            gr.sync_block.__init__(
                self,
                name="cu8_stdin_source",
                in_sig=None,
                out_sig=[numpy.complex64],
            )
            self.fd = fd
            self.chunk_bytes = chunk_bytes
            # Leftover < 2 bytes from a partial IQ pair held across work() calls.
            self.pending = b""

        def work(self, input_items: list[Any], output_items: list[Any]) -> int:
            del input_items
            out = output_items[0]
            max_bytes = max(2, min(self.chunk_bytes, len(out) * 2))
            # os.read returns whatever's available rather than blocking for
            # the full request, which matches GR's streaming-source contract.
            raw = os.read(self.fd, max_bytes)
            if not raw:
                return -1

            data = self.pending + raw if self.pending else raw
            sample_count = min(len(out), len(data) // 2)
            if sample_count == 0:
                self.pending = data
                return 0

            used = sample_count * 2
            # Single allocation; in-place arithmetic; reinterpret IQIQ float
            # pairs as complex64 to skip the i + 1j*q construction.
            pairs = numpy.frombuffer(data, dtype=numpy.uint8, count=used)
            floats = pairs.astype(numpy.float32)
            floats -= 127.5
            floats *= 1.0 / 127.5
            out[:sample_count] = floats.view(numpy.complex64)
            self.pending = data[used:] if used < len(data) else b""
            return sample_count

    class MeshtasticFrameSink(gr.sync_block):
        """Consumes crc_verif's payload stream; CRC-valid frames become JSON."""

        def __init__(self) -> None:
            gr.sync_block.__init__(
                self,
                name="meshtastic_frame_sink",
                in_sig=[numpy.uint8],
                out_sig=None,
            )
            self.assembler = FrameAssembler(drops.drop)
            self.frame_info = pmt.intern("frame_info")

        def work(self, input_items: list[Any], output_items: list[Any]) -> int:
            del output_items
            data = input_items[0]
            count = len(data)
            base = self.nitems_read(0)
            tags = []
            for tag in self.get_tags_in_window(0, 0, count):
                if not pmt.eq(tag.key, self.frame_info):
                    continue
                pay_len, crc_valid = frame_info_fields(pmt, tag.value)
                tags.append((int(tag.offset - base), pay_len, crc_valid))
            for frame in self.assembler.feed(data.tobytes(), tags):
                event = process_frame(
                    frame, channel_key, mesh_pb2.Data, drops, event_fields
                )
                if event is not None:
                    print(json.dumps(event, separators=(",", ":")), flush=True)
            drops.maybe_log()
            return count

    top = gr.top_block("wavekit_lora_meshtastic", catch_exceptions=True)
    source = Cu8StdinSource(sys.stdin.buffer.fileno())

    soft_decoding = True
    implicit_header = False
    has_crc = True
    payload_len = 255
    ldro_mode = 2
    print_header = False
    print_payload = 0
    max_log_approx = True
    preamble_len = 8
    sync_word = [0x2B]
    os_factor = os_factor_for(args.samp_rate, int(args.bw))
    # frame_sync forecasts one oversampled symbol plus two samples of lookahead.
    source.set_min_output_buffer(os_factor * ((1 << int(args.sf)) + 2))
    gr_cr = max(1, min(4, int(args.cr) - 4))

    frame_sync = lora_sdr.frame_sync(
        int(args.frequency),
        int(args.bw),
        int(args.sf),
        implicit_header,
        sync_word,
        os_factor,
        preamble_len,
    )
    fft_demod = lora_sdr.fft_demod(soft_decoding, max_log_approx)
    gray_mapping = lora_sdr.gray_mapping(soft_decoding)
    deinterleaver = lora_sdr.deinterleaver(soft_decoding)
    hamming_dec = lora_sdr.hamming_dec(soft_decoding)
    header_decoder = lora_sdr.header_decoder(
        implicit_header,
        gr_cr,
        payload_len,
        has_crc,
        ldro_mode,
        print_header,
    )
    dewhitening = lora_sdr.dewhitening()
    # Output 0 carries each frame's payload, its first byte tagged frame_info
    # with crc_valid; the bool output (output_crc_check) is not needed and the
    # `msg` port is left unconnected (its str payload is not binary-safe).
    crc_verif = lora_sdr.crc_verif(print_payload, False)
    frame_sink = MeshtasticFrameSink()

    top.msg_connect((header_decoder, "frame_info"), (frame_sync, "frame_info"))
    top.connect((source, 0), (frame_sync, 0))
    top.connect((frame_sync, 0), (fft_demod, 0))
    top.connect((fft_demod, 0), (gray_mapping, 0))
    top.connect((gray_mapping, 0), (deinterleaver, 0))
    top.connect((deinterleaver, 0), (hamming_dec, 0))
    top.connect((hamming_dec, 0), (header_decoder, 0))
    top.connect((header_decoder, 0), (dewhitening, 0))
    top.connect((dewhitening, 0), (crc_verif, 0))
    top.connect((crc_verif, 0), (frame_sink, 0))

    log_stderr(
        "flowgraph_start",
        bw=int(args.bw),
        sf=int(args.sf),
        cr=int(args.cr),
        samp_rate=float(args.samp_rate),
        os_factor=os_factor,
        region=args.region,
    )
    # Retain Python block wrappers while the scheduler uses their C++ trampolines.
    top._wavekit_blocks = (source, frame_sync, fft_demod, gray_mapping,
                           deinterleaver, hamming_dec, header_decoder,
                           dewhitening, crc_verif, frame_sink)
    return top


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        channel_key = decode_channel_key(args.channel_key)
    except ValueError as exc:
        log_stderr("invalid_channel_key", error=str(exc))
        return 2

    try:
        os_factor_for(args.samp_rate, args.bw)
    except ValueError as exc:
        log_stderr("invalid_sample_rate", error=str(exc))
        return 2

    if Cipher is None:
        log_stderr("startup_error", error="python3 cryptography module is missing")
        return 1

    drops = DropCounter()
    try:
        top = build_flowgraph(args, channel_key, drops)
    except Exception as exc:
        log_stderr("startup_error", error=str(exc), error_type=type(exc).__name__)
        return 1

    stopping = False

    def stop(_signum: int, _frame: Any) -> None:
        nonlocal stopping
        if stopping:
            return
        stopping = True
        log_stderr("signal_stop")
        top.stop()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    try:
        top.start()
        top.wait()
    except KeyboardInterrupt:
        stop(signal.SIGINT, None)
        top.wait()
    finally:
        if not stopping:
            top.stop()
            top.wait()
        drops.final_summary()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
