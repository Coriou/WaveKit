"""POCSAG pages as 2-FSK NFM baseband (ITU-R M.584-2).

A codeword is 32 bits sent MSB first: a flag bit (0 address, 1 message), 20 data bits,
10 BCH(31,21) check bits and one even-parity bit. A batch is the sync codeword plus
8 frames of 2 codewords; an address sits in frame (address & 7). Binary 1 is sent as
-deviation, binary 0 as +deviation.

params:
  sampleRate   native rate (default 48000)
  deviationHz  default 4500
  startS       first key-up (default 0.5)
  gapS         silence between pages (default 1.0)
  continuous   keep the transmitter keyed from startS to duration - startS: gaps carry
               a longer preamble and the tail carries idle batches, so an FM decoder
               never sees a noise-only stretch (where multimon-ng invents pages)
  pages        [{baud: 512|1200|2400, address, function, alpha | numeric}]
"""
import numpy as np

from .common import bit_index, bits_msb_first, cpfsk_phase, keyed_envelope, schedule

SYNC = 0x7CD215D8
IDLE = 0x7A89C197
BCH_GENERATOR = 0b11101101001  # x^10 + x^9 + x^8 + x^6 + x^5 + x^3 + 1
PREAMBLE_BITS = 576
NUMERIC = '0123456789*U -)('


def bch_check(data21):
    reg = data21 << 10
    for bit in range(30, 9, -1):
        if reg & (1 << bit):
            reg ^= BCH_GENERATOR << (bit - 10)
    return reg & 0x3FF


def codeword(data21):
    cw31 = (data21 << 10) | bch_check(data21)
    return (cw31 << 1) | (bin(cw31).count('1') & 1)


def address_codeword(address, function):
    if not 0 <= address < 1 << 21 or not 0 <= function <= 3:
        raise ValueError(f'POCSAG address {address} / function {function} out of range')
    return codeword(((address >> 3) << 2) | function)


def _pack(bits):
    bits = list(bits)
    words = []
    for i in range(0, len(bits), 20):
        chunk = bits[i : i + 20]
        data20 = 0
        for k, b in enumerate(chunk):
            data20 |= b << (19 - k)
        words.append(codeword((1 << 20) | data20))
    return words


def numeric_codewords(text):
    digits = [NUMERIC.index(c) for c in text]
    while len(digits) % 5:
        digits.append(NUMERIC.index(' '))
    return _pack((d >> i) & 1 for d in digits for i in range(4))


def alpha_codewords(text):
    bits = [(ord(c) >> i) & 1 for c in text for i in range(7)]
    eot = 0x04
    bits += [(eot >> i) & 1 for i in range(7)]
    bits += [0] * (-len(bits) % 20)
    return _pack(bits)


def page_bits(page):
    if 'alpha' in page:
        message = alpha_codewords(page['alpha'])
    elif 'numeric' in page:
        message = numeric_codewords(page['numeric'])
    else:
        message = []
    words = []
    while len(words) % 16 != 2 * (page['address'] & 7):
        words.append(IDLE)
    words.append(address_codeword(page['address'], page.get('function', 0)))
    words.extend(message)
    words.append(IDLE)
    while len(words) % 16:
        words.append(IDLE)
    bits = [(i + 1) & 1 for i in range(PREAMBLE_BITS)]
    for b in range(0, len(words), 16):
        bits += bits_msb_first(SYNC, 32)
        for w in words[b : b + 16]:
            bits += bits_msb_first(w, 32)
    return bits


def fsk_freq(bits, baud, fs, deviation_hz):
    return np.where(np.asarray(bits, dtype=bool)[bit_index(len(bits), baud, fs)], -deviation_hz, deviation_hz)


def modulate(bits, baud, fs, deviation_hz):
    freq = fsk_freq(bits, baud, fs, deviation_hz)
    return keyed_envelope(len(freq), fs, 0.001) * np.exp(1j * cpfsk_phase(freq, fs))


def continuous(pages, fs, deviation_hz, duration_s, start_s, gap_s):
    total = int(round(duration_s * fs))
    start, end = int(round(start_s * fs)), total - int(round(start_s * fs))
    freqs, starts, pos = [], [], start
    for i, page in enumerate(pages):
        page_baud = int(page['baud'])
        extra = [1, 0] * int(round(gap_s * page_baud / 2)) if i else []
        starts.append(pos / fs)
        freqs.append(fsk_freq(extra + page_bits(page), page_baud, fs, deviation_hz))
        pos += len(freqs[-1])
    if pos > end:
        raise ValueError(f'pages end at {pos / fs:.3f} s, past {end / fs:.3f} s')
    tail_baud = int(pages[-1]['baud'])  # the idle batches continue at the last page's rate
    idle = (bits_msb_first(SYNC, 32) + bits_msb_first(IDLE, 32) * 16) * (1 + (end - pos) * tail_baud // (fs * 544))
    freqs.append(fsk_freq(idle, tail_baud, fs, deviation_hz)[: end - pos])
    freq = np.concatenate(freqs)
    iq = np.zeros(total, dtype=np.complex128)
    iq[start:end] = keyed_envelope(len(freq), fs, 0.001) * np.exp(1j * cpfsk_phase(freq, fs))
    return iq, starts


def generate(params, duration_s):
    fs = int(params.get('sampleRate', 48000))
    deviation = float(params.get('deviationHz', 4500))
    if not params.get('pages'):
        raise ValueError('pocsag: pages is empty (nothing to transmit)')
    bursts, expected = [], []
    for page in params['pages']:
        baud = int(page['baud'])
        if not params.get('continuous'):
            bursts.append(modulate(page_bits(page), baud, fs, deviation))
        decode = {'protocol': f'POCSAG{baud}', 'address': page['address'], 'function': page.get('function', 0)}
        for kind in ('alpha', 'numeric'):
            if kind in page:
                decode[kind] = page[kind]
        expected.append(decode)
    start_s, gap_s = params.get('startS', 0.5), params.get('gapS', 1.0)
    if params.get('continuous'):
        iq, starts = continuous(params['pages'], fs, deviation, duration_s, start_s, gap_s)
    else:
        iq, starts = schedule(bursts, fs, duration_s, start_s, gap_s)
    for decode, t in zip(expected, starts):
        decode['startS'] = round(t, 4)
    return iq, fs, expected
