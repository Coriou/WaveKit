#!/usr/bin/env python3
"""LoRa/Meshtastic stdin decoder for WaveKit.

Reads interleaved cu8 IQ from stdin, converts it to complex float samples,
demodulates LoRa frames with gr-lora_sdr, decrypts Meshtastic payloads, and
emits one JSON object per decoded packet on stdout.
"""

from __future__ import annotations

import argparse
import base64
import binascii
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import signal
import sys
from typing import Any

# Hoisted module-top so decrypt_payload doesn't re-resolve symbols per packet.
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

DEFAULT_CHANNEL_PSK = bytes(
    [
        0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59,
        0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01,
    ]
)


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
        help="Effective complex sample rate in Hz",
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


def decode_channel_key(value: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error as exc:
        raise ValueError("channel key is not valid base64") from exc

    # Meshtastic shorthand (per firmware Channels.cpp):
    #   - 1 byte 0x00      = encryption disabled (not supported in v1)
    #   - 1 byte 0x01..FF  = defaultpsk with psk[15] += (idx - 1)
    #   - 16 bytes         = explicit AES-128 PSK
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
    if len(decoded) != 16:
        raise ValueError(
            "channel key must decode to a single shorthand byte (0x01..0xFF) "
            "or exactly 16 bytes for a custom AES-128 PSK"
        )
    return decoded


def build_nonce(from_node: int, packet_id: int) -> bytes:
    return (
        int(packet_id).to_bytes(8, "little", signed=False)
        + int(from_node).to_bytes(4, "little", signed=False)
        + b"\x00\x00\x00\x00"
    )


def packet_from_node(packet: Any) -> int:
    # protoc renames `from` to `from_` in Python output to avoid the keyword
    # clash. Fall back to getattr for older generators that kept `from`.
    if hasattr(packet, "from_"):
        return int(packet.from_)
    return int(getattr(packet, "from"))


def decrypt_payload(mesh_pb2: Any, packet: Any, channel_key: bytes) -> Any:
    payload_variant = packet.WhichOneof("payload_variant")
    if payload_variant == "decoded":
        return packet.decoded
    if payload_variant != "encrypted":
        raise ValueError("packet has no decoded or encrypted payload")
    if packet.pki_encrypted:
        raise ValueError("PKI encrypted packets are not supported")

    nonce = build_nonce(packet_from_node(packet), packet.id)
    decryptor = Cipher(algorithms.AES(channel_key), modes.CTR(nonce)).decryptor()
    plaintext = decryptor.update(bytes(packet.encrypted)) + decryptor.finalize()
    data = mesh_pb2.Data()
    data.ParseFromString(plaintext)
    return data


def emit_packet(
    mesh_pb2: Any,
    frame: bytes,
    args: argparse.Namespace,
    channel_key: bytes,
) -> None:
    packet = mesh_pb2.MeshPacket()
    packet.ParseFromString(frame)
    data = decrypt_payload(mesh_pb2, packet, channel_key)
    payload = bytes(data.payload)

    event: dict[str, Any] = {
        "from": packet_from_node(packet),
        "to": int(packet.to),
        "id": int(packet.id),
        "channel": int(packet.channel),
        "hop_limit": int(packet.hop_limit),
        "hop_start": int(packet.hop_start),
        "want_ack": bool(packet.want_ack),
        "portnum": int(data.portnum),
        "payload_b64": base64.b64encode(payload).decode("ascii"),
        "payload_len": len(payload),
        "rx_rssi": int(packet.rx_rssi),
        "rx_snr": float(packet.rx_snr),
        "rx_time": datetime.now(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "frequency": int(args.frequency),
        "bw": int(args.bw),
        "sf": int(args.sf),
        "cr": int(args.cr),
    }
    if packet.via_mqtt:
        event["via_mqtt"] = True
    if packet.priority:
        event["priority"] = int(packet.priority)

    print(json.dumps(event, separators=(",", ":")), flush=True)


def pmt_to_bytes(pmt: Any, message: Any) -> bytes:
    value = pmt.to_python(message)
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, (tuple, list)):
        return bytes(value)
    if isinstance(value, str):
        # crc_verif (gr-lora_sdr) publishes payloads as pmt::mp(message_str)
        # built from raw u8 bytes; on the Python side this lands as a str.
        # latin-1 round-trips 0..255 cleanly, restoring the original bytes.
        return value.encode("latin-1")
    raise ValueError(f"unsupported PMT message type: {type(value).__name__}")


def build_flowgraph(args: argparse.Namespace, channel_key: bytes) -> Any:
    # gnuradio and numpy are heavy imports; defer to keep --help fast.
    import numpy
    import pmt
    from gnuradio import blocks, gr
    import gnuradio.lora_sdr as lora_sdr

    add_proto_paths()
    import mesh_pb2

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
            if not raw and not self.pending:
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

    class MeshtasticSink(gr.basic_block):
        def __init__(self) -> None:
            gr.basic_block.__init__(
                self,
                name="meshtastic_packet_sink",
                in_sig=None,
                out_sig=None,
            )
            self.message_port_register_in(pmt.intern("in"))
            self.set_msg_handler(pmt.intern("in"), self.handle_message)

        def handle_message(self, message: Any) -> None:
            try:
                frame = pmt_to_bytes(pmt, message)
                emit_packet(mesh_pb2, frame, args, channel_key)
            except Exception as exc:
                log_stderr("frame_drop", error=str(exc), error_type=type(exc).__name__)

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
    os_factor = max(1, int(round(float(args.samp_rate) / float(args.bw))))
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
    crc_verif = lora_sdr.crc_verif(print_payload, False)
    packet_sink = MeshtasticSink()
    null_sink = blocks.null_sink(gr.sizeof_char)

    top.msg_connect((header_decoder, "frame_info"), (frame_sync, "frame_info"))
    top.msg_connect((crc_verif, "msg"), (packet_sink, "in"))
    top.connect((source, 0), (frame_sync, 0))
    top.connect((frame_sync, 0), (fft_demod, 0))
    top.connect((fft_demod, 0), (gray_mapping, 0))
    top.connect((gray_mapping, 0), (deinterleaver, 0))
    top.connect((deinterleaver, 0), (hamming_dec, 0))
    top.connect((hamming_dec, 0), (header_decoder, 0))
    top.connect((header_decoder, 0), (dewhitening, 0))
    top.connect((dewhitening, 0), (crc_verif, 0))
    top.connect((crc_verif, 0), (null_sink, 0))

    log_stderr(
        "flowgraph_start",
        bw=int(args.bw),
        sf=int(args.sf),
        cr=int(args.cr),
        samp_rate=float(args.samp_rate),
        os_factor=os_factor,
        region=args.region,
    )
    return top


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        channel_key = decode_channel_key(args.channel_key)
    except ValueError as exc:
        log_stderr("invalid_channel_key", error=str(exc))
        return 2

    try:
        top = build_flowgraph(args, channel_key)
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
