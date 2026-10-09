"""Plain-old ACARS downlinks as AM baseband (ARINC 618 air-ground character framing).

Characters are 7-bit ASCII with odd parity in bit 7, sent LSB first at 2400 bps on an
MSK audio subcarrier (1200 / 2400 Hz) that amplitude-modulates the carrier. The tone is
differentially coded: 2400 Hz when a bit equals the previous one, 1200 Hz when it
differs, which is what a coherent MSK demodulator (acarsdec msk.c) turns back into bits.
Frame: pre-key (all ones), '+', '*', SYN, SYN, SOH, mode, address (7), ack, label (2),
block id, STX, text, ETX, BCS (CRC-16/KERMIT over mode..ETX, low byte first), DEL.
A downlink block id is a digit; its text starts with the message number (4) and the
flight id (6).

params:
  sampleRate        native rate (default 48000)
  modulationIndex   AM depth (default 0.7)
  prekeyBytes       0xFF bytes before '+' (default 24)
  startS / gapS     as for pocsag
  messages          [{mode, tail, ack, label, blockId, msgno, flight, text}]
"""
import numpy as np

from .common import bit_index, bits_lsb_first, cpfsk_phase, keyed_envelope, schedule

BAUD = 2400
MARK_HZ = 2400
SPACE_HZ = 1200
SYN, SOH, STX, ETX, NAK, DEL = 0x16, 0x01, 0x02, 0x03, 0x15, 0x7F


def odd_parity(c):
    c &= 0x7F
    return c | (0x80 if bin(c).count('1') % 2 == 0 else 0)


def crc16_kermit(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc


def frame_bytes(msg, prekey_bytes=24):
    tail = msg['tail'].rjust(7, '.')[:7]
    text = msg.get('msgno', '') + msg.get('flight', '').ljust(6)[:6] + msg.get('text', '')
    head = msg.get('mode', '2') + tail
    block = [odd_parity(ord(c)) for c in head]
    block.append(odd_parity(ord(msg['ack'])) if 'ack' in msg else odd_parity(NAK))
    block += [odd_parity(ord(c)) for c in msg['label'] + msg.get('blockId', '1')]
    block.append(odd_parity(STX))
    block += [odd_parity(ord(c)) for c in text]
    block.append(odd_parity(ETX))
    crc = crc16_kermit(block)
    framing = [odd_parity(ord('+')), odd_parity(ord('*')), odd_parity(SYN), odd_parity(SYN), odd_parity(SOH)]
    return [0xFF] * prekey_bytes + framing + block + [crc & 0xFF, crc >> 8, DEL, 0xFF, 0xFF]


def msk_tones(bits):
    prev, tones = 1, []
    for b in bits:
        tones.append(MARK_HZ if b == prev else SPACE_HZ)
        prev = b
    return np.asarray(tones, dtype=np.float64)


def modulate(byte_values, fs, depth):
    bits = bits_lsb_first(byte_values)
    idx = bit_index(len(bits), BAUD, fs)
    audio = np.sin(cpfsk_phase(msk_tones(bits)[idx], fs))
    return keyed_envelope(len(idx), fs) * (1.0 + depth * audio) / (1.0 + depth) + 0j


def generate(params, duration_s):
    fs = int(params.get('sampleRate', 48000))
    depth = float(params.get('modulationIndex', 0.7))
    prekey = int(params.get('prekeyBytes', 24))
    bursts, expected = [], []
    for msg in params['messages']:
        bursts.append(modulate(frame_bytes(msg, prekey), fs, depth))
        expected.append(
            {k: msg[k] for k in ('mode', 'tail', 'label', 'blockId', 'msgno', 'flight', 'text') if k in msg}
        )
    iq, starts = schedule(bursts, fs, duration_s, params.get('startS', 0.5), params.get('gapS', 1.0))
    for decode, t in zip(expected, starts):
        decode['startS'] = round(t, 4)
    return iq, fs, expected
