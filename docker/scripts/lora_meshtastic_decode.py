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
from collections import Counter, deque
from dataclasses import dataclass
from datetime import UTC, datetime
import json
import math
import os
from pathlib import Path
import signal
import struct
import sys
import threading
import time
from typing import Any, Callable, TextIO
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

# Carrier offset (CFO). gr-lora_sdr frame_sync estimates any CFO within +-bw/4,
# but then assumes the offset comes from the transmitter's crystal and corrects a
# matching sample-clock drift of cfo / centre_freq (frame_sync_impl.cc,
# QUARTER_DOWN: sfo_hat). That holds for a crystal error. It is wrong for a pure
# frequency shift: a channel off the capture centre (centre placement allows it)
# or a mistuned centre. There the false drift (5 kHz: 41 bins x 250 kHz /
# 869.525 MHz = 0.0118 chip per symbol) moves the payload windows by half a chip
# within a 38-symbol frame, and CR 4/5 corrects no symbol error.
#
# The placement offset is known: the adapter passes slot - capture centre as
# --shift-hz, and a C++ rotator (blocks.rotator_cc) moves the slot to baseband
# before the one "direct" path, so frame_sync sees only the crystal error and
# corrects its true drift. That is the default.
#
# An unknown mistune (the adapter does not know the capture centre) can opt in to
# a second path with --cfo-search-hz: "recentred" runs the same chain on the
# stream rotated by each preamble's CfoSearch estimate (frame_sync then sees ~0
# CFO and corrects no drift, so it suits a shift, not a crystal error), and a
# frame both paths decode is emitted once (FrameDeduper). Its rotation stays in
# the source block: the estimate is known 24 symbols after the rotation must
# start, so one block must see the search input a delay line ahead of the
# rotated output. A C++ delay and rotator run on their own threads and give no
# such ordering.

# Meshtastic transmits 16 preamble upchirps (firmware RadioInterface
# preambleLength). The direct path needs the true length: frame_sync moves its
# timing estimate across preamble_len symbols at the crystal drift rate, and
# 8 instead of 16 leaves it 8 x 0.059 = 0.47 chip off at a 25 kHz crystal offset.
MESHTASTIC_PREAMBLE_LEN = 16
# The recentred path runs frame_sync at 8: it needs 8 - 3 = 5 consecutive
# upchirps, so it locks onto 8- and 16-symbol preambles alike, and its drift
# correction is ~0 there, so the length never scales an error.
RECENTRED_PREAMBLE_LEN = 8

# A dechirped window's peak bin power over its mean bin power. A LoRa symbol at
# its SF's sensitivity floor gives 1 + N x SNR on average: SF11 at -17.5 dB
# 1 + 2048 x 0.018 = 37, SF7 at -7.5 dB 1 + 128 x 0.178 = 23.8, 2.9 to 4.6 x the 8
# a run must start with; single windows scatter well below that mean, so the run
# goes on at half of it while it stays on its bin, past one stray window. Noise
# alone starts a run with probability p = N x e^-8 (SF11 0.69, SF7 0.043) and
# lands its next 3 windows on the same bin +-1 with (3/N)^3, x 4 for the stray:
# SF11 0.69 x 4 x 3.1e-9 = 8.7e-9 per window (one in 11 days at 122 windows/s),
# SF7 0.043 x 4 x 1.3e-5 = 2.2e-6 (one in 4 minutes at 1953 windows/s, then a
# downchirp-like window among 5 in about 1 of 5). A false preamble moves only the
# recentred path's shift.
CFO_PEAK_RATIO = 8.0
# Consecutive upchirp windows that make a preamble. Windows sit at a stride of N
# chips, so an 8-upchirp preamble fills at least 7 whole windows; 4 leaves room
# for a damaged window at either end.
CFO_MIN_RUN = 4
# Windows searched for the downchirp from the first window after the run. The
# last run window ends between one symbol before and one symbol after the
# preamble end; the two sync-word symbols and 2.25 downchirps follow, so a window
# wholly inside the downchirps starts 1 to 4 windows later: 5 windows cover it.
CFO_SFD_WINDOWS = 5
# The run's first window may straddle the preamble start, so the preamble starts
# within one symbol before it; the correction starts 2 symbols before that window
# so frame_sync's first detection window is already recentred.
CFO_LEAD_SYMBOLS = 2
# Delay of the recentred path, in symbols. The search knows the offset once it
# has seen the downchirp: at most preamble + 1 straddling window + CFO_SFD_WINDOWS
# + CFO_LEAD_SYMBOLS = 16 + 1 + 5 + 2 = 24 symbols after the correction must start
# (Meshtastic). 32 leaves 8 symbols for longer preambles.
CFO_DELAY_SYMBOLS = 32
# Run windows kept for the run's most common bin. The delay line corrects a
# preamble of at most 32 - (1 + 5 + 2) = 24 upchirps from its start, which fills
# at most 24 + 1 straddling window = 25 windows; 32 keeps all of them, and a
# longer run (an unmodulated carrier) keeps only its last 32.
CFO_RUN_HISTORY = CFO_DELAY_SYMBOLS
# Each frame is placed by the input sample where frame_sync locked on it
# (lock_position), the recentred path's less its delay line, and the two paths'
# copies of one frame pair when these agree within this many symbols. The
# positions differ by at most: 1 symbol of read race (frame_sync consumes a
# symbol before it publishes the output for it), 1 symbol when frame_sync finds
# the sync word one symbol late (one_symbol_off: the lock call outputs a symbol
# itself), 0.25 symbol of integer CFO the lock call consumes (up to N/4 bins on
# the direct path, ~0 recentred), 2 chips of sync-word offset and one sample of
# drift per header symbol: under 2.5 symbols, so 4. A second reception on the
# channel starts after the first ends: 8 preamble + 4.25 sync + 8 header symbols
# = 20.25 symbols later at the least (LongFast 4 symbols = 33 ms; a resend
# 0.4 s later is 49 symbols away).
DEDUPE_TOLERANCE_SYMBOLS = 4
# Receptions the deduper holds for a pair. One path's copy of a frame reaches
# the deduper at most the delay line (32 symbols) plus a few block buffers
# after the other's, and frames are at least 20 symbols apart, so a handful
# wait at once; older entries fall off.
DEDUPE_KEEP = 64
# Locks a path has confirmed (valid header) that its sink has not reached yet.
# A lock is confirmed 8 header symbols after frame_sync locks, and the frame
# reaches the sink once its payload is decoded; frames are at least 20.25
# symbols apart (above), so the 64 entries cover a sink at least 64 x 20.25 =
# 1296 symbols behind its probe (10.6 s at SF11/250 kHz). Only a stalled sink
# gets that far behind; an evicted lock leaves its frame unmatched
# (FramePositions), so it is never deduped.
LOCKS_KEEP = 64


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
    parser.add_argument(
        "--shift-hz",
        type=int,
        default=0,
        help="Known offset of the channel from the capture centre in Hz (channel "
        "minus centre: positive when the channel sits above the centre); the "
        "stream is rotated by -shift before the direct path",
    )
    parser.add_argument(
        "--cfo-search-hz",
        type=int,
        default=0,
        help="Opt-in search for an unknown offset: the largest carrier offset in Hz "
        "(placement offset plus crystal error) the recentred path corrects, below "
        "bw/4; 0 (default) runs the direct path alone",
    )
    parser.add_argument(
        "--preamble-len",
        type=int,
        default=MESHTASTIC_PREAMBLE_LEN,
        help=f"Preamble upchirps the direct path expects (default "
        f"{MESHTASTIC_PREAMBLE_LEN}, Meshtastic)",
    )
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


def shift_phase_inc(shift_hz: float, samp_rate: float) -> float:
    """blocks.rotator_cc phase increment that moves a tone at +shift_hz to 0 Hz.

    rotator_cc multiplies sample n by exp(j x phase_inc x n); a channel at
    +shift (above the capture centre) is exp(j 2 pi shift n / fs), so
    phase_inc = -2 pi shift / fs.
    """
    return -2.0 * math.pi * float(shift_hz) / float(samp_rate)


def shift_in_passband(shift_hz: int, bw: int, samp_rate: float) -> bool:
    """The shifted channel lies inside the delivered band: |shift| + bw/2 <= fs/2.

    Past it the channel was cut (or aliased) before the wrapper, so nothing
    decodes; the wrapper still runs and says so once on stderr.
    """
    return 2 * abs(shift_hz) + bw <= samp_rate


def demod_paths(cfo_search_hz: int) -> list[str]:
    """The demodulator paths: "direct" always, "recentred" when the search is on."""
    return ["direct", "recentred"] if cfo_search_hz > 0 else ["direct"]


def check_cfo_args(cfo_search_hz: int, bw: int, preamble_len: int) -> None:
    """Rejects a search range the up/down-chirp estimate cannot resolve.

    The estimate reads 2 x CFO modulo N bins, so it is unambiguous only within
    +-N/4 bins = +-bw/4 Hz (frame_sync's own integer CFO has the same bound).
    """
    if cfo_search_hz < 0 or 4 * cfo_search_hz >= bw:
        raise ValueError(f"cfo-search-hz must be in 0..{(bw - 1) // 4} (below bw/4)")
    if preamble_len < RECENTRED_PREAMBLE_LEN:
        raise ValueError(f"preamble-len must be at least {RECENTRED_PREAMBLE_LEN}")


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
    # Input sample where frame_sync locked on the frame (FramePositions); None
    # when unknown.
    position: int | None = None


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
        self._position: int | None = None
        self._active = False

    def feed(
        self,
        data: bytes,
        tags: list[tuple[Any, ...]],
    ) -> list[AssembledFrame]:
        """`tags` holds (relative offset, pay_len, crc_valid[, position]), offsets in 0..len(data)."""
        frames: list[AssembledFrame] = []
        cursor = 0
        for offset, pay_len, crc_valid, *rest in sorted(tags, key=lambda t: t[0]):
            offset = max(cursor, min(offset, len(data)))
            self._take(data[cursor:offset], frames)
            cursor = offset
            if self._active:
                self._on_drop("truncated")
            self._start(pay_len, crc_valid, rest[0] if rest else None)
        self._take(data[cursor:], frames)
        return frames

    def _start(
        self, pay_len: int | None, crc_valid: bool | None, position: int | None
    ) -> None:
        self._buffer.clear()
        if pay_len is None or not 1 <= pay_len <= MAX_LORA_PAYLOAD_LEN:
            self._active = False
            self._on_drop("bad_frame_info")
            return
        self._expected = pay_len
        self._crc_valid = crc_valid
        self._position = position
        self._active = True

    def _take(self, chunk: bytes, frames: list[AssembledFrame]) -> None:
        # Bytes outside an active frame (before the first tag, after a bad
        # frame_info) are skipped, never parsed.
        if not self._active or not chunk:
            return
        need = self._expected - len(self._buffer)
        self._buffer.extend(chunk[:need])
        if len(self._buffer) == self._expected:
            frames.append(
                AssembledFrame(bytes(self._buffer), self._crc_valid, self._position)
            )
            self._buffer.clear()
            self._active = False


class DropCounter:
    """Counts dropped frames by fixed reason and writes rate-limited summaries."""

    def __init__(
        self,
        log: Callable[..., None] = log_stderr,
        clock: Callable[[], float] = time.monotonic,
        interval_s: float = DROP_SUMMARY_INTERVAL_S,
        fields: dict[str, Any] | None = None,
    ) -> None:
        # Fixed fields added to every summary, e.g. the demodulator path.
        self._fields = dict(fields or {})
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
            **self._fields,
        )
        self._since_log.clear()
        self._last_log = now

    def final_summary(self) -> None:
        self._log(
            "frame_drop_summary",
            drops=dict(sorted(self.total.items())),
            decoded_total=self.decoded,
            **self._fields,
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


def lock_fields(pmt: Any, value: Any) -> tuple[bool | None, int | None]:
    """Reads is_header and pay_len from a frame_sync frame_info pmt dict."""
    if not pmt.is_dict(value):
        return None, None
    header_pmt = pmt.dict_ref(value, pmt.intern("is_header"), pmt.PMT_NIL)
    pay_len_pmt = pmt.dict_ref(value, pmt.intern("pay_len"), pmt.PMT_NIL)
    is_header = bool(pmt.to_bool(header_pmt)) if pmt.is_bool(header_pmt) else None
    pay_len = int(pmt.to_long(pay_len_pmt)) if pmt.is_integer(pay_len_pmt) else None
    return is_header, pay_len


def lock_position(
    tag_offset: int,
    written: Callable[[], int],
    consumed: Callable[[], int],
    bins: int,
    samples_per_symbol: int,
) -> int:
    """Input sample where frame_sync locked on the frame whose header tag sits at `tag_offset`.

    `written` and `consumed` read frame_sync's output and input item counts. Read
    while the tagged item is still before the probe, they are bounded: after a lock
    frame_sync outputs the 8 header symbols, then consumes nothing until the
    header decoder answers (frame_sync_impl.cc SFO_COMPENSATION, m_received_head),
    and the decoder cannot see the header before the probe passes it on. Each
    symbol output since the tag consumed one oversampled symbol (+-1 sample of
    drift correction), so the lock sat that many symbols before the consumed count,
    whenever the probe thread runs. The output count is read before and after the
    input count so both come from the same frame_sync call, up to the one symbol a
    call consumes before it publishes its output.
    """
    for _ in range(8):
        before = written()
        read = consumed()
        if written() == before:
            break
    return read - (before - tag_offset) // bins * samples_per_symbol


class FramePositions:
    """One path's lock positions, handed to its sink in frame order.

    The lock probe records each frame_sync lock (header tag) and confirms it when
    frame_sync tags the decoded header (is_header false), which it does only for
    a valid header. header_decoder tags the same valid headers in the same order
    and crc_verif copies those tags to the sink, so the sink's n-th frame_info tag
    is the n-th confirmation; pay_len, in both tags, checks the pairing.

    A frame whose position is unknown or doubtful gets None, so the deduper lets
    it through: a duplicate packet is acceptable, a lost one is not. Each such
    frame is reported to `on_unmatched` from the sink thread:

    - position_evicted: its lock fell off the bounded queue. Confirmations are
      numbered, so the frames after it still get their own locks.
    - position_unaligned: the pairing broke (pay_len differs, or the sink has a
      frame with no confirmation). Every frame is then unmatched and the queue is
      emptied at each take, until two takes in a row each find exactly one lock,
      confirmed since the previous take, with their pay_len: the sink is then on
      the frame the probe last confirmed, and numbering restarts from there.
    """

    def __init__(
        self,
        keep: int = LOCKS_KEEP,
        on_unmatched: Callable[[str], None] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._keep = keep
        self._on_unmatched = on_unmatched
        self._pending: int | None = None
        # (confirmation number, pay_len, position or None when no lock was seen)
        self._confirmed: deque[tuple[int, int | None, int | None]] = deque()
        self._confirms = 0  # confirmations so far; the next one's number
        self._takes = 0  # aligned: the confirmation number of the sink's next frame
        self._aligned = True
        self._since_take = 0  # confirmations since the sink's last take
        self._clean_takes = 0

    def locked(self, position: int) -> None:
        with self._lock:
            self._pending = position

    def confirmed(self, pay_len: int | None) -> None:
        # A confirmation without a recorded lock is still a frame the sink will
        # see, so it keeps its number.
        with self._lock:
            if len(self._confirmed) >= self._keep:
                self._confirmed.popleft()
            self._confirmed.append((self._confirms, pay_len, self._pending))
            self._confirms += 1
            self._since_take += 1
            self._pending = None

    def take(self, pay_len: int | None) -> int | None:
        """The lock of the sink's next frame, None when unknown or not trusted."""
        with self._lock:
            position, reason = self._take(pay_len)
            self._since_take = 0
        if reason is not None and self._on_unmatched is not None:
            self._on_unmatched(reason)
        return position

    def _take(self, pay_len: int | None) -> tuple[int | None, str | None]:
        if not self._aligned:
            clean = (
                len(self._confirmed) == 1
                and self._since_take == 1
                and self._confirmed[0][1] == pay_len
            )
            self._clean_takes = self._clean_takes + 1 if clean else 0
            self._confirmed.clear()
            if self._clean_takes >= 2:
                self._aligned = True
                self._takes = self._confirms
            return None, "position_unaligned"
        number = self._takes
        self._takes += 1
        while self._confirmed and self._confirmed[0][0] < number:
            self._confirmed.popleft()
        if self._confirmed and self._confirmed[0][0] > number:
            return None, "position_evicted"
        if not self._confirmed or self._confirmed[0][1] != pay_len:
            self._aligned = False
            self._clean_takes = 0
            self._confirmed.clear()
            return None, "position_unaligned"
        return self._confirmed.popleft()[2], None


def base_upchirp(n: int) -> Any:
    """gr-lora_sdr build_upchirp(id 0) at one sample per chip: phase 2pi(k^2/2N - k/2)."""
    import numpy as np

    k = np.arange(n, dtype=np.float64)
    return np.exp(1j * np.pi * (k * k / n - k)).astype(np.complex64)


def near_bin(a: int, b: int, n: int) -> bool:
    """a and b within one bin of each other, modulo n (frame_sync's DETECT test)."""
    return abs((a - b + 1) % n - 1) <= 1


class CfoSearch:
    """Coarse carrier offset of each LoRa preamble, from the preamble and its downchirps.

    Averages each os_factor samples into one chip (frame_sync instead keeps one of
    them, folding all out-of-band noise in; the average folds os_factor x less)
    and cuts windows of N = 2^sf chips at a stride of N, whose start lags the
    symbol grid by d chips.
    Dechirping an upchirp with the base downchirp peaks at bin u = c + d, where c
    is the offset in bins (bw / N Hz each); dechirping a downchirp with the base
    upchirp peaks at v = c - d. A run of CFO_MIN_RUN upchirp windows, then a
    downchirp window, gives 2c = u + v modulo N, so c is unambiguous in
    [-N/4, N/4) bins (+-bw/4 Hz) and within about a bin. frame_sync refines it.
    """

    def __init__(self, sf: int, bw: int, os_factor: int, max_cfo_hz: float) -> None:
        import numpy as np

        self._np = np
        self.n = 1 << sf
        self.bw = bw
        self.os_factor = os_factor
        self.max_cfo_hz = max_cfo_hz
        self._up = base_upchirp(self.n)
        self._down = np.conj(self._up)
        self._pending = np.zeros(0, dtype=np.complex64)
        self._pending_samples = np.zeros(0, dtype=np.complex64)
        self._window = 0
        self._run: deque[int] = deque(maxlen=CFO_RUN_HISTORY)
        self._run_start = 0
        # A window that left the run's bin (one is forgiven):
        # (window, u, u_ratio, v_ratio, v).
        self._stray: tuple[int, int, float, float, int] | None = None
        self._sfd_left = 0
        self._sfd_best = (0.0, 0)
        self._sfd_u = 0
        self._sfd_run_start = 0
        self.detections = 0
        self.last_cfo_hz: float | None = None

    def feed(self, samples: Any) -> list[tuple[int, float]]:
        """(correction start sample, CFO in Hz) per preamble found; sample indices count from the first fed."""
        np = self._np
        raw = np.concatenate((self._pending_samples, samples))
        whole = len(raw) // self.os_factor * self.os_factor
        self._pending_samples = raw[whole:]
        chips = raw[:whole].reshape(-1, self.os_factor).mean(axis=1, dtype=np.complex64)
        buf = np.concatenate((self._pending, chips)) if len(self._pending) else chips
        count = len(buf) // self.n
        self._pending = np.array(buf[count * self.n :], dtype=np.complex64)
        if count == 0:
            return []
        windows = buf[: count * self.n].reshape(count, self.n)
        up = np.abs(np.fft.fft(windows * self._down, axis=1)) ** 2
        down = np.abs(np.fft.fft(windows * self._up, axis=1)) ** 2
        u, v = up.argmax(axis=1), down.argmax(axis=1)
        u_ratio = up.max(axis=1) / np.maximum(up.mean(axis=1), 1e-30)
        v_ratio = down.max(axis=1) / np.maximum(down.mean(axis=1), 1e-30)
        found = []
        for i in range(count):
            hit = self._step(int(u[i]), float(u_ratio[i]), int(v[i]), float(v_ratio[i]))
            self._window += 1
            if hit is not None:
                found.append(hit)
        return found

    def _step(self, u: int, u_ratio: float, v: int, v_ratio: float) -> tuple[int, float] | None:
        if self._sfd_left:
            if v_ratio > self._sfd_best[0]:
                self._sfd_best = (v_ratio, v)
            self._sfd_left -= 1
            return None if self._sfd_left else self._finish()
        if (
            self._run
            and u_ratio >= CFO_PEAK_RATIO / 2
            and near_bin(u, self._run[-1], self.n)
        ):
            self._run.append(u)
            self._stray = None
            return None
        stray = self._stray
        if self._run and stray is None:
            self._stray = (self._window, u, u_ratio, v_ratio, v)
            return None
        self._stray = None
        if stray is not None and len(self._run) >= CFO_MIN_RUN:
            # The stray window was the first after the run and this one the second:
            # both are downchirp candidates.
            self._sfd_u = Counter(self._run).most_common(1)[0][0]
            self._sfd_run_start = self._run_start
            self._sfd_best = max(stray[3:], (v_ratio, v))
            self._sfd_left = CFO_SFD_WINDOWS - 2
            self._run.clear()
            return None
        if (
            stray is not None
            and stray[2] >= CFO_PEAK_RATIO
            and u_ratio >= CFO_PEAK_RATIO / 2
            and near_bin(u, stray[1], self.n)
        ):
            # A short run gave way to a preamble that started at the stray window.
            self._run.clear()
            self._run.extend((stray[1], u))
            self._run_start = stray[0]
            return None
        self._run.clear()
        if u_ratio >= CFO_PEAK_RATIO:
            self._run.append(u)
        self._run_start = self._window
        return None

    def _finish(self) -> tuple[int, float] | None:
        ratio, v = self._sfd_best
        if ratio < CFO_PEAK_RATIO:
            return None
        bins = ((self._sfd_u + v) % self.n) / 2
        if bins >= self.n / 4:
            bins -= self.n / 2
        cfo_hz = bins * self.bw / self.n
        # u and v are whole bins, each within half a bin of c + d and c - d on a
        # clean peak, so (u + v) / 2 is within (0.5 + 0.5) / 2 = 0.5 bin of c: a
        # true offset of exactly the limit (50 kHz = 409.6 bins) reads 409.5 or
        # 410 bins (50 048.8 Hz). The limit therefore admits one more bin, bw / N
        # (122 Hz LongFast). -N/4 bins is also +N/4 (2c = N/2 modulo N), so the
        # slack never admits the ambiguous quarter, whatever the limit.
        if abs(cfo_hz) > self.max_cfo_hz + self.bw / self.n or 4 * abs(bins) >= self.n:
            return None
        start_window = max(0, self._sfd_run_start - CFO_LEAD_SYMBOLS)
        self.detections += 1
        self.last_cfo_hz = cfo_hz
        return start_window * self.n * self.os_factor, cfo_hz


class DelayedRotator:
    """The stream delayed by `delay` samples and shifted by -f, f switching at scheduled samples.

    Phase stays continuous across a switch. A switch scheduled before the next
    output sample takes effect at that sample.
    """

    def __init__(self, samp_rate: float, delay: int) -> None:
        import numpy as np

        self._np = np
        self._samp_rate = float(samp_rate)
        self._buf = np.zeros(delay, dtype=np.complex64)
        self._out_pos = -delay
        self._freq = 0.0
        self._phase = 0.0
        self._switches: list[tuple[int, float]] = []
        # exp(-j 2 pi f k / fs) for k = 0..len-1 at the current f, grown on demand:
        # a block then costs two multiplies instead of one complex exp per sample.
        self._ramp = np.ones(0, dtype=np.complex128)

    def schedule(self, at_sample: int, freq_hz: float) -> None:
        self._switches.append((at_sample, freq_hz))
        self._switches.sort(key=lambda s: s[0])

    def process(self, samples: Any) -> Any:
        np = self._np
        n, held = len(samples), len(self._buf)
        delayed = np.empty(n, dtype=np.complex64)
        if n >= held:
            # One copy of the block, no concatenation of the held line with it.
            delayed[:held] = self._buf
            delayed[held:] = samples[: n - held]
            self._buf = np.array(samples[n - held :], dtype=np.complex64)
        else:
            delayed[:] = self._buf[:n]
            self._buf = np.concatenate((self._buf[n:], samples))
        return self._rotate(delayed)

    def _rotate(self, block: Any) -> Any:
        np = self._np
        out = np.empty(len(block), dtype=np.complex64)
        pos = 0
        while pos < len(block):
            while self._switches and self._switches[0][0] <= self._out_pos + pos:
                freq = self._switches.pop(0)[1]
                if freq != self._freq:
                    self._freq = freq
                    self._ramp = np.ones(0, dtype=np.complex128)
            end = len(block)
            if self._switches:
                end = min(end, self._switches[0][0] - self._out_pos)
            if self._freq == 0.0:
                # The phase holds at its last value: 0 Hz after a shift keeps
                # the accumulated turn instead of snapping back to 1.
                out[pos:end] = block[pos:end] * np.complex64(np.exp(1j * self._phase))
            else:
                step = -2.0 * np.pi * self._freq / self._samp_rate
                if len(self._ramp) < end - pos:
                    self._ramp = np.exp(1j * step * np.arange(end - pos, dtype=np.float64))
                out[pos:end] = block[pos:end] * (np.exp(1j * self._phase) * self._ramp[: end - pos])
                self._phase = (self._phase + step * (end - pos)) % (2.0 * np.pi)
            pos = end
        self._out_pos += len(block)
        return out


class FrameDeduper:
    """Lets one copy of a frame through when both paths decode it.

    A frame decoded by one path pairs with the first identical frame from the
    other path whose input position (FramePositions) is within `tolerance`
    samples; the pair yields one packet. Arrival order and time do not matter,
    so block scheduling cannot split or merge pairs. Identical frames from one
    path are separate receptions and never pair. A relayed copy differs in its
    hop bytes, so it is never paired. A frame without a position is let through.
    """

    def __init__(self, tolerance: int, keep: int = DEDUPE_KEEP) -> None:
        self._tolerance = tolerance
        self._seen: deque[tuple[str, bytes, int]] = deque(maxlen=keep)
        self._lock = threading.Lock()

    def admit(self, path: str, payload: bytes, position: int | None) -> bool:
        if position is None:
            return True
        with self._lock:
            for i, (other, seen, at) in enumerate(self._seen):
                if (
                    other != path
                    and seen == payload
                    and abs(at - position) <= self._tolerance
                ):
                    del self._seen[i]
                    return False
            self._seen.append((path, payload, position))
            return True


# stdout lines come from both paths' sink threads; one write per line under a lock.
_STDOUT_LOCK = threading.Lock()
# Where JSON events go; isolate_stdout() points it at a private copy of fd 1.
_EVENTS: TextIO | None = None


def write_event(event: dict[str, Any]) -> None:
    line = json.dumps(event, separators=(",", ":")) + "\n"
    out = _EVENTS or sys.stdout
    with _STDOUT_LOCK:
        out.write(line)
        out.flush()


def isolate_stdout() -> None:
    """Keeps stdout for JSON events alone.

    Events go to a duplicate of fd 1, and fd 1 itself becomes stderr, so a line
    native code prints (a gnuradio `:info:` log, a library's printf) lands on
    stderr instead of in the adapter's JSONL stream.
    """
    global _EVENTS
    sys.stdout.flush()
    _EVENTS = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)


def quiet_gnuradio_logs(gr: Any) -> None:
    """gnuradio logs at warn and above only (3.10 logging singleton)."""
    try:
        gr.logging().set_default_level(gr.log_levels.warn)
    except (AttributeError, TypeError) as exc:
        log_stderr("gr_log_level_unset", error=str(exc))


def build_flowgraph(
    args: argparse.Namespace,
    channel_key: bytes,
    drops: dict[str, DropCounter],
) -> tuple[Any, CfoSearch | None]:
    """The top block and, when the recentred path runs, its CfoSearch.

    `drops` holds one counter per path (demod_paths): "direct", plus
    "recentred" when --cfo-search-hz is above 0.
    """
    # gnuradio and numpy are heavy imports; defer to keep --help fast.
    import numpy
    import pmt
    from gnuradio import blocks, gr
    import gnuradio.lora_sdr as lora_sdr

    quiet_gnuradio_logs(gr)

    add_proto_paths()
    import mesh_pb2

    event_fields = {
        "frequency": int(args.frequency),
        "bw": int(args.bw),
        "sf": int(args.sf),
        "cr": int(args.cr),
    }
    os_factor = os_factor_for(args.samp_rate, int(args.bw))
    samples_per_symbol = os_factor * (1 << int(args.sf))
    recentre = "recentred" in drops
    search = (
        CfoSearch(int(args.sf), int(args.bw), os_factor, float(args.cfo_search_hz))
        if recentre
        else None
    )
    rotator = (
        DelayedRotator(args.samp_rate, CFO_DELAY_SYMBOLS * samples_per_symbol)
        if recentre
        else None
    )
    deduper = FrameDeduper(DEDUPE_TOLERANCE_SYMBOLS * samples_per_symbol)
    positions = {
        path: FramePositions(on_unmatched=drops[path].drop) for path in drops
    }

    class Cu8StdinSource(gr.sync_block):
        """cu8 stdin as complex samples on output 0; output 1, when recentring, carries
        the same samples delayed and shifted by each preamble's CfoSearch estimate."""

        def __init__(self, fd: int, chunk_bytes: int = 65536) -> None:
            gr.sync_block.__init__(
                self,
                name="cu8_stdin_source",
                in_sig=None,
                out_sig=[numpy.complex64] * (2 if recentre else 1),
            )
            self.fd = fd
            self.chunk_bytes = chunk_bytes
            # Leftover < 2 bytes from a partial IQ pair held across work() calls.
            self.pending = b""
            # After EOF the delayed output still holds this many samples.
            self.flush_left = CFO_DELAY_SYMBOLS * samples_per_symbol if recentre else 0
            self.eof = False

        def work(self, input_items: list[Any], output_items: list[Any]) -> int:
            del input_items
            out = output_items[0]
            if self.eof:
                return self.flush(output_items)
            max_bytes = max(2, min(self.chunk_bytes, len(out) * 2))
            # os.read returns whatever's available rather than blocking for
            # the full request, which matches GR's streaming-source contract.
            raw = os.read(self.fd, max_bytes)
            if not raw:
                self.eof = True
                return self.flush(output_items)

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
            samples = floats.view(numpy.complex64)
            out[:sample_count] = samples
            if search is not None and rotator is not None:
                # Search first: a correction found in this block can start in the
                # delayed output this block writes.
                for at_sample, cfo_hz in search.feed(samples):
                    rotator.schedule(at_sample, cfo_hz)
                output_items[1][:sample_count] = rotator.process(samples)
            self.pending = data[used:] if used < len(data) else b""
            return sample_count

        def flush(self, output_items: list[Any]) -> int:
            """Zeros on output 0 while output 1 drains its delay line, then end of stream."""
            count = min(len(output_items[0]), self.flush_left)
            if count == 0 or rotator is None:
                return -1
            zeros = numpy.zeros(count, dtype=numpy.complex64)
            output_items[0][:count] = zeros
            output_items[1][:count] = rotator.process(zeros)
            self.flush_left -= count
            return count

    class FrameLockProbe(gr.sync_block):
        """Passes frame_sync's output on unchanged (tags too) and records where in
        the input each lock sat (lock_position), less the path's delay line."""

        def __init__(self, path: str, frame_sync: Any, delay: int) -> None:
            gr.sync_block.__init__(
                self,
                name=f"frame_lock_probe_{path}",
                in_sig=[numpy.complex64],
                out_sig=[numpy.complex64],
            )
            self.frame_sync = frame_sync
            self.delay = delay
            self.positions = positions[path]
            self.frame_info = pmt.intern("frame_info")

        def work(self, input_items: list[Any], output_items: list[Any]) -> int:
            count = len(input_items[0])
            output_items[0][:count] = input_items[0]
            tags = [
                tag
                for tag in self.get_tags_in_window(0, 0, count)
                if pmt.eq(tag.key, self.frame_info)
            ]
            for tag in sorted(tags, key=lambda t: t.offset):
                is_header, pay_len = lock_fields(pmt, tag.value)
                if is_header:
                    position = lock_position(
                        int(tag.offset),
                        lambda: int(self.frame_sync.nitems_written(0)),
                        lambda: int(self.frame_sync.nitems_read(0)),
                        1 << int(args.sf),
                        samples_per_symbol,
                    )
                    self.positions.locked(position - self.delay)
                elif is_header is False:
                    self.positions.confirmed(pay_len)
            return count

    class MeshtasticFrameSink(gr.sync_block):
        """Consumes crc_verif's payload stream; CRC-valid frames become JSON."""

        def __init__(self, path: str) -> None:
            gr.sync_block.__init__(
                self,
                name=f"meshtastic_frame_sink_{path}",
                in_sig=[numpy.uint8],
                out_sig=None,
            )
            self.path = path
            self.drops = drops[path]
            self.positions = positions[path]
            self.assembler = FrameAssembler(self.drops.drop)
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
                position = self.positions.take(pay_len)
                tags.append((int(tag.offset - base), pay_len, crc_valid, position))
            for frame in self.assembler.feed(data.tobytes(), tags):
                event = process_frame(
                    frame, channel_key, mesh_pb2.Data, self.drops, event_fields
                )
                if event is None:
                    continue
                if deduper.admit(self.path, frame.payload, frame.position):
                    write_event(event)
                else:
                    self.drops.drop("duplicate")
            self.drops.maybe_log()
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
    sync_word = [0x2B]
    # frame_sync forecasts one oversampled symbol plus two samples of lookahead
    # (2 x (2048 + 2) = 4100 items at SF11, os 2, past the 4096-item default), so
    # every block feeding a frame_sync gets this buffer.
    frame_sync_buffer = os_factor * ((1 << int(args.sf)) + 2)
    source.set_min_output_buffer(frame_sync_buffer)
    gr_cr = max(1, min(4, int(args.cr) - 4))

    def demod_chain(
        upstream: tuple[Any, int], path: str, preamble_len: int, delay: int
    ) -> tuple[Any, ...]:
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
        lock_probe = FrameLockProbe(path, frame_sync, delay)
        frame_sink = MeshtasticFrameSink(path)

        top.msg_connect((header_decoder, "frame_info"), (frame_sync, "frame_info"))
        top.connect(upstream, (frame_sync, 0))
        top.connect((frame_sync, 0), (lock_probe, 0))
        top.connect((lock_probe, 0), (fft_demod, 0))
        top.connect((fft_demod, 0), (gray_mapping, 0))
        top.connect((gray_mapping, 0), (deinterleaver, 0))
        top.connect((deinterleaver, 0), (hamming_dec, 0))
        top.connect((hamming_dec, 0), (header_decoder, 0))
        top.connect((header_decoder, 0), (dewhitening, 0))
        top.connect((dewhitening, 0), (crc_verif, 0))
        top.connect((crc_verif, 0), (frame_sink, 0))
        return (frame_sync, lock_probe, fft_demod, gray_mapping, deinterleaver,
                hamming_dec, header_decoder, dewhitening, crc_verif, frame_sink)

    # The direct path sees the slot at baseband: the known shift is removed in
    # C++ (no per-sample Python work) and the rotator is skipped at shift 0.
    shift_hz = int(args.shift_hz)
    direct_in: tuple[Any, int] = (source, 0)
    kept: tuple[Any, ...] = ()
    if shift_hz:
        rotator_block = blocks.rotator_cc(shift_phase_inc(shift_hz, args.samp_rate))
        rotator_block.set_min_output_buffer(frame_sync_buffer)
        top.connect((source, 0), (rotator_block, 0))
        direct_in = (rotator_block, 0)
        kept = (rotator_block,)
    chain = kept + demod_chain(direct_in, "direct", int(args.preamble_len), 0)
    if recentre:
        # The search measures the whole offset (shift plus crystal) itself.
        chain += demod_chain(
            (source, 1), "recentred", RECENTRED_PREAMBLE_LEN,
            CFO_DELAY_SYMBOLS * samples_per_symbol,
        )
    if not shift_in_passband(shift_hz, int(args.bw), float(args.samp_rate)):
        log_stderr(
            "shift_outside_passband",
            shift_hz=shift_hz,
            bw=int(args.bw),
            samp_rate=float(args.samp_rate),
        )

    log_stderr(
        "flowgraph_start",
        bw=int(args.bw),
        sf=int(args.sf),
        cr=int(args.cr),
        samp_rate=float(args.samp_rate),
        os_factor=os_factor,
        region=args.region,
        preamble_len=int(args.preamble_len),
        shift_hz=shift_hz,
        cfo_search_hz=int(args.cfo_search_hz),
        paths=sorted(drops),
    )
    # Retain Python block wrappers while the scheduler uses their C++ trampolines.
    top._wavekit_blocks = (source, *chain)
    return top, search


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

    try:
        check_cfo_args(args.cfo_search_hz, args.bw, args.preamble_len)
    except ValueError as exc:
        log_stderr("invalid_cfo_search", error=str(exc))
        return 2

    if Cipher is None:
        log_stderr("startup_error", error="python3 cryptography module is missing")
        return 1

    drops = {
        path: DropCounter(fields={"path": path})
        for path in demod_paths(args.cfo_search_hz)
    }
    isolate_stdout()
    try:
        top, search = build_flowgraph(args, channel_key, drops)
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
        for counter in drops.values():
            counter.final_summary()
        if search is not None:
            log_stderr(
                "cfo_search_summary",
                detections=search.detections,
                last_cfo_hz=search.last_cfo_hz,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
