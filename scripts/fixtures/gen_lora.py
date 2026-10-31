#!/usr/bin/env python3
"""Generate a synthetic Meshtastic LongFast frame as cu8 IQ at 1.024 Msps.

Writes meshtastic_onair_frame.bin (the 33 on-air bytes) and six lora_longfast_*.cu8
captures to OUTDIR; fixtures/lora/README.md lists them. Needs the core image's
python3 + gnuradio + gr-lora_sdr (TX blocks), numpy, scipy and python3-cryptography.
Fixed node ids, packet id, payload and noise seeds (100 + variant index), so a rerun
with the same gr-lora_sdr / numpy / scipy reproduces fixtures/lora/SHA256SUMS.

Usage: python3 gen_lora.py OUTDIR
"""
import struct
import sys
import time

import numpy as np
import pmt
from gnuradio import blocks, gr
import gnuradio.lora_sdr as lora_sdr
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from scipy.signal import resample_poly

sys.path.insert(0, "/usr/local/lib/wavekit/meshtastic_proto")
import mesh_pb2  # noqa: E402

OUT = sys.argv[1]
BW = 250_000
SF = 11
OS = 8
TX_RATE = BW * OS  # 2 Msps
OUT_RATE = 1_024_000
PSK = bytes([0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59,
             0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01])
DEST = 0xFFFFFFFF
SENDER = 0x0A1B2C3D
PKT_ID = 0x12345678
HOP_LIMIT = 3
HOP_START = 3
CHANNEL_HASH = 0x08  # LongFast + default key


def meshtastic_onair() -> bytes:
    data = mesh_pb2.Data()
    data.portnum = 1  # TEXT_MESSAGE_APP
    data.payload = b"hello wavekit"
    plain = data.SerializeToString()
    nonce = PKT_ID.to_bytes(8, "little") + SENDER.to_bytes(4, "little") + b"\0" * 4
    enc = Cipher(algorithms.AES(PSK), modes.CTR(nonce)).encryptor()
    cipher = enc.update(plain) + enc.finalize()
    flags = (HOP_LIMIT & 7) | ((HOP_START & 7) << 5)
    header = struct.pack("<IIIBBBB", DEST, SENDER, PKT_ID, flags, CHANNEL_HASH, 0, 0)
    return header + cipher


def lora_modulate(payload: bytes) -> np.ndarray:
    # Same block chain as lora_sdr_lora_tx, but whitening(is_hex=True) so
    # binary bytes survive the Python str -> std::string conversion.
    tb2 = gr.top_block()
    whit = lora_sdr.whitening(True, False, ",", "packet_len")
    hdr = lora_sdr.header(False, True, 1)
    crc = lora_sdr.add_crc(True)
    ham = lora_sdr.hamming_enc(1, SF)
    inter = lora_sdr.interleaver(1, SF, 2, BW)
    gd = lora_sdr.gray_demap(SF)
    mod = lora_sdr.modulate(SF, TX_RATE, BW, [0x2B], 2 ** 7, 8)
    sink = blocks.vector_sink_c()
    tb2.connect(whit, hdr, crc, ham, inter, gd, mod, sink)
    tb2.start()
    time.sleep(0.5)
    whit.to_basic_block()._post(pmt.intern("msg"), pmt.intern(payload.hex()))
    deadline = time.time() + 30
    last = -1
    while time.time() < deadline:
        time.sleep(1.0)
        n = len(sink.data())
        if n > 0 and n == last:
            break
        last = n
    tb2.stop()
    tb2.wait()
    return np.array(sink.data(), dtype=np.complex64)


def to_cu8(x: np.ndarray) -> bytes:
    iq = np.empty(2 * len(x), dtype=np.float32)
    iq[0::2] = x.real
    iq[1::2] = x.imag
    u = np.clip(np.round(iq * 127.5 + 127.5), 0, 255).astype(np.uint8)
    return u.tobytes()


def build(sig_1024: np.ndarray, offset_hz: float, snr_db: float | None,
          dc: complex, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    pad = int(0.25 * OUT_RATE)
    x = np.concatenate([np.zeros(pad, np.complex64), sig_1024, np.zeros(pad, np.complex64)])
    n = np.arange(len(x))
    x = x * np.exp(2j * np.pi * offset_hz * n / OUT_RATE)
    amp = 0.35  # signal envelope as fraction of full scale
    x = x * amp
    if snr_db is not None:
        ps = amp ** 2
        # SNR defined in the 250 kHz LoRa bandwidth; noise is white over 1.024 MHz.
        pn_inband = ps / (10 ** (snr_db / 10))
        pn_total = pn_inband * OUT_RATE / BW
        sigma = np.sqrt(pn_total / 2)
        x = x + sigma * (rng.standard_normal(len(x)) + 1j * rng.standard_normal(len(x)))
    x = x + dc
    return x.astype(np.complex64)


def main() -> None:
    frame = meshtastic_onair()
    open(f"{OUT}/meshtastic_onair_frame.bin", "wb").write(frame)
    print("onair frame", len(frame), frame.hex(), flush=True)
    sig = lora_modulate(frame)
    print("tx samples @2M", len(sig), "rms", float(np.sqrt(np.mean(np.abs(sig) ** 2))), flush=True)
    if len(sig) == 0:
        raise SystemExit("modulator produced nothing")
    peak = np.max(np.abs(sig))
    sig = sig / peak
    sig1024 = resample_poly(sig, 64, 125).astype(np.complex64)  # 2.0M -> 1.024M
    print("samples @1.024M", len(sig1024), flush=True)
    variants = {
        "lora_longfast_dc_clean": (0.0, None, 0j),
        "lora_longfast_dc_snr10": (0.0, 10.0, 0j),
        "lora_longfast_dc_snrm5": (0.0, -5.0, 0j),
        "lora_longfast_dc_snr10_dcspike": (0.0, 10.0, 0.15 + 0.10j),
        "lora_longfast_off200k_snr10": (200_000.0, 10.0, 0j),
        "lora_longfast_off200k_snrm5": (200_000.0, -5.0, 0j),
    }
    for i, (name, (off, snr, dc)) in enumerate(variants.items()):
        x = build(sig1024, off, snr, dc, seed=100 + i)
        open(f"{OUT}/{name}.cu8", "wb").write(to_cu8(x))
        print("wrote", name, len(x), flush=True)


main()
