#!/usr/bin/env python3
"""Compose a wideband cu8 fixture from narrowband IQ sources and synthetic generators.

Channelizer T7a (addendum §8, D2 as amended 2026-10-09). The output is what an RTL-SDR
tuned to the recipe's centre would have recorded: every component is resampled to the
output rate (polyphase, Kaiser window, 90 dB stopband), mixed to its offset and summed,
then seeded complex Gaussian noise, an optional IQ image and DC spike are added and the
result is quantised to cu8 as floor(127.5 * x + 128), saturated to 0..255 (the A6 cu8
mapping). The run aborts if more than 0.01 % of the I/Q values saturate.

Usage:
  compose.py RECIPE --out OUT.cu8 [--sidecar OUT.json] [--sources-dir DIR]
  compose.py RECIPE --list-sources    # id|url|sha256|file per line, for download.sh

Recipe (JSON), see fixtures/recipes/ and fixtures/README.md:
  id, sampleRate, centerHz, durationS, seed,
  noiseDbfs      total complex noise power over the whole band, dB re a full-scale
                 complex sinusoid; null for none
  dcSpikeDbfs    optional constant I/Q offset (the RTL DC spike), with dcSpikePhaseDeg
  iqImage        optional {rejectionDb, phaseDeg}: adds eps * conj(x)
  sources        [{id, url, sha256, format: cu8|cs8|cs16|cf32|wav, sampleRate,
                   centerHz?, file?, license, attribution?}]
  components     [{name, source | generator (+ params), offsetHz, levelDb,
                   startS?, repeatEveryS?, trimS?: [from, to], rampS?, expected?}]
levelDb places the component's envelope reference (99.9th percentile of |x| over its
nonzero samples) at that many dB below full scale. offsetHz is where the component's
own baseband 0 Hz lands, relative to centerHz. rampS tapers a source snippet's ends
(raised cosine) so a repeated short recording does not key on with a click.

Determinism: same recipe, seed and numpy major version give the same bytes on one
platform; libm or numpy differences can change the last bit of a float and so the sha256.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # python3 -I does not put the script directory on sys.path
from generators import acars, pocsag  # noqa: E402
from generators.common import keyed_envelope  # noqa: E402

GENERATORS = {'pocsag': pocsag.generate, 'acars': acars.generate}
FORMATS = {'cu8', 'cs8', 'cs16', 'cf32', 'wav'}
CHUNK = 1 << 20
STOPBAND_DB = 90.0
PASS_FRACTION = 0.8
MAX_CLIP_FRACTION = 1e-4


class RecipeError(ValueError):
    pass


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def _interleaved(values):
    values = values[: len(values) - len(values) % 2]
    return values[0::2] + 1j * values[1::2]


def read_wav(raw):
    """RIFF/WAVE with 2 channels (I, Q): PCM u8/s16 or IEEE float32. Returns (iq, header rate)."""
    if raw[:4] != b'RIFF' or raw[8:12] != b'WAVE':
        raise RecipeError('not a RIFF/WAVE file')
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(raw):
        tag, size = raw[pos : pos + 4], int.from_bytes(raw[pos + 4 : pos + 8], 'little')
        body = raw[pos + 8 : pos + 8 + size]
        if tag == b'fmt ':
            fmt = body
        elif tag == b'data':
            data = body
        pos += 8 + size + (size & 1)
    if fmt is None or data is None:
        raise RecipeError('WAV without fmt or data chunk')
    code = int.from_bytes(fmt[0:2], 'little')
    channels = int.from_bytes(fmt[2:4], 'little')
    rate = int.from_bytes(fmt[4:8], 'little')
    bits = int.from_bytes(fmt[14:16], 'little')
    if code == 0xFFFE:
        code = int.from_bytes(fmt[24:26], 'little')
    if channels != 2:
        raise RecipeError(f'WAV IQ needs 2 channels, got {channels}')
    if code == 1 and bits == 8:
        values = (np.frombuffer(data, np.uint8).astype(np.float64) - 127.5) / 127.5
    elif code == 1 and bits == 16:
        values = np.frombuffer(data[: len(data) // 2 * 2], '<i2').astype(np.float64) / 32768.0
    elif code == 3 and bits == 32:
        values = np.frombuffer(data[: len(data) // 4 * 4], '<f4').astype(np.float64)
    else:
        raise RecipeError(f'unsupported WAV sample format {code}/{bits} bit')
    return _interleaved(values), rate


def read_iq(path, fmt):
    raw = Path(path).read_bytes()
    if fmt == 'wav':
        return read_wav(raw)[0]
    if fmt == 'cu8':
        values = (np.frombuffer(raw, np.uint8).astype(np.float64) - 127.5) / 127.5
    elif fmt == 'cs8':
        values = np.frombuffer(raw, np.int8).astype(np.float64) / 128.0
    elif fmt == 'cs16':
        values = np.frombuffer(raw[: len(raw) // 2 * 2], '<i2').astype(np.float64) / 32768.0
    elif fmt == 'cf32':
        values = np.frombuffer(raw[: len(raw) // 4 * 4], '<f4').astype(np.float64)
    else:
        raise RecipeError(f'unknown source format {fmt}')
    return _interleaved(values)


def quantise_cu8(iq):
    """floor(127.5 * x + 128) saturated to 0..255, interleaved I/Q; returns (bytes, clipped values)."""
    values = np.empty(2 * len(iq))
    values[0::2] = iq.real
    values[1::2] = iq.imag
    q = np.floor(127.5 * values + 128.0)
    clipped = int(np.count_nonzero((q < 0) | (q > 255)))
    return np.clip(q, 0, 255).astype(np.uint8), clipped


class Resampler:
    """Rational L/M polyphase resampler with a Kaiser-windowed sinc and zero group delay."""

    def __init__(self, fs_in, fs_out):
        g = math.gcd(fs_in, fs_out)
        self.L, self.M = fs_out // g, fs_in // g
        if self.L == 1 and self.M == 1:
            self.K, self.d = 1, 0
            return
        nyquist = min(fs_in, fs_out) / 2
        f_pass = PASS_FRACTION * nyquist
        f_stop = 2 * nyquist - f_pass
        fs_up = fs_in * self.L
        beta = 0.1102 * (STOPBAND_DB - 8.7)
        taps = math.ceil((STOPBAND_DB - 7.95) / (2.285 * 2 * math.pi * (f_stop - f_pass) / fs_up)) + 1
        self.K = math.ceil(taps / self.L)
        n = self.K * self.L
        fc = (f_pass + f_stop) / 2 / fs_up
        t = np.arange(n) - (n - 1) / 2
        h = 2 * fc * np.sinc(2 * fc * t) * np.kaiser(n, beta) * self.L
        self.H = h.reshape(self.K, self.L).T.copy()  # H[p, k] = h[p + k L]
        self.d = (n - 1) // 2
        self.m_inv = pow(self.M, -1, self.L) if self.L > 1 else 0

    def pad(self, x):
        return np.concatenate([np.zeros(self.K, x.dtype), x, np.zeros(self.K + self.d // self.L + self.M + 2, x.dtype)])

    def render(self, xp, n0, n1):
        """Output samples n0..n1 from an input already passed through pad()."""
        L, M, K = self.L, self.M, self.K
        if L == 1 and M == 1:
            return xp[K + n0 : K + n1].copy()
        y = np.zeros(n1 - n0, dtype=np.complex128)
        for p in range(L):
            first = n0 + ((((p - self.d) * self.m_inv) % L - n0) % L)
            if first >= n1:
                continue
            count = (n1 - first + L - 1) // L
            base = (first * M + self.d) // L + K
            out = y[first - n0 :: L]
            for k in range(K):
                start = base - k
                out += self.H[p, k] * xp[start : start + count * M : M]
        return y


def load_recipe(path):
    recipe = json.loads(Path(path).read_text())
    for key in ('id', 'sampleRate', 'centerHz', 'durationS', 'seed', 'components'):
        if key not in recipe:
            raise RecipeError(f'recipe missing {key}')
    sources = {s['id']: s for s in recipe.get('sources', [])}
    for s in sources.values():
        if s.get('format') not in FORMATS:
            raise RecipeError(f"source {s['id']}: format must be one of {sorted(FORMATS)}")
        s.setdefault('file', f"{s['id']}.{s['format']}")
    for c in recipe['components']:
        if ('source' in c) == ('generator' in c):
            raise RecipeError(f"component {c.get('name')}: exactly one of source / generator")
        if 'source' in c and c['source'] not in sources:
            raise RecipeError(f"component {c['name']}: unknown source {c['source']}")
        if 'generator' in c and c['generator'] not in GENERATORS:
            raise RecipeError(f"component {c['name']}: unknown generator {c['generator']}")
        if int(c['offsetHz']) != c['offsetHz'] or abs(c['offsetHz']) >= recipe['sampleRate'] / 2:
            raise RecipeError(f"component {c['name']}: offsetHz must be an integer inside the capture")
    recipe['_sources'] = sources
    return recipe


def build_component(recipe, comp, sources_dir):
    duration = recipe['durationS']
    info = {
        'name': comp['name'],
        'offsetHz': comp['offsetHz'],
        'absoluteHz': recipe['centerHz'] + comp['offsetHz'],
        'levelDb': comp['levelDb'],
    }
    if 'generator' in comp:
        x, fs_in, expected = GENERATORS[comp['generator']](comp.get('params', {}), duration)
        info.update({'kind': 'generator', 'generator': comp['generator'], 'license': 'synthetic (WaveKit, AGPL-3.0-or-later)'})
    else:
        src = recipe['_sources'][comp['source']]
        path = Path(sources_dir) / src['file']
        actual = sha256_file(path)
        if actual != src['sha256']:
            raise RecipeError(f"source {src['id']}: sha256 {actual} != {src['sha256']}")
        fs_in = int(src['sampleRate'])
        x = read_iq(path, src['format'])
        if 'trimS' in comp:
            a, b = comp['trimS']
            x = x[int(round(a * fs_in)) : int(round(b * fs_in))]
        if comp.get('rampS'):
            x = x * keyed_envelope(len(x), fs_in, comp['rampS'])
        expected = comp.get('expected', [])
        info.update({'kind': 'source', 'source': src['id'], 'license': src['license'], 'url': src['url']})
        if 'centerHz' in src:
            info['sourceCenterHz'] = src['centerHz']
    total = int(math.ceil(duration * fs_in))
    placed = np.zeros(total, dtype=np.complex128)
    start = comp.get('startS', 0.0)
    starts = []
    while start < duration:
        i = int(round(start * fs_in))
        n = min(len(x), total - i)
        placed[i : i + n] += x[:n]
        starts.append(round(start, 4))
        if not comp.get('repeatEveryS'):
            break
        start += comp['repeatEveryS']
    nonzero = np.abs(placed[placed != 0])
    if nonzero.size == 0:
        raise RecipeError(f"component {comp['name']}: silent")
    gain = 10 ** (comp['levelDb'] / 20) / float(np.percentile(nonzero, 99.9))
    info.update({'inputSampleRate': fs_in, 'startsS': starts, 'expected': expected})
    resampler = Resampler(fs_in, int(recipe['sampleRate']))
    info['resample'] = f'{resampler.L}/{resampler.M}'
    return info, resampler, resampler.pad(placed * gain)


def compose(recipe, out_path, sources_dir, sidecar_path=None):
    fs = int(recipe['sampleRate'])
    n_total = int(round(recipe['durationS'] * fs))
    parts = [build_component(recipe, c, sources_dir) for c in recipe['components']]
    rng = np.random.default_rng(int(recipe['seed']))
    noise_dbfs = recipe.get('noiseDbfs')
    sigma = math.sqrt(10 ** (noise_dbfs / 10) / 2) if noise_dbfs is not None else 0.0
    image = recipe.get('iqImage')
    eps = 10 ** (-image['rejectionDb'] / 20) * np.exp(1j * math.radians(image.get('phaseDeg', 0))) if image else 0
    dc_dbfs = recipe.get('dcSpikeDbfs')
    dc = 10 ** (dc_dbfs / 20) * np.exp(1j * math.radians(recipe.get('dcSpikePhaseDeg', 45))) if dc_dbfs is not None else 0
    digest, clipped = hashlib.sha256(), 0
    with open(out_path, 'wb') as out:
        for n0 in range(0, n_total, CHUNK):
            n1 = min(n0 + CHUNK, n_total)
            acc = np.zeros(n1 - n0, dtype=np.complex128)
            n = np.arange(n0, n1, dtype=np.int64)
            for info, resampler, xp in parts:
                y = resampler.render(xp, n0, n1)
                acc += y * np.exp(2j * np.pi * ((n * int(info['offsetHz'])) % fs) / fs)
            if sigma:
                w = rng.standard_normal((n1 - n0, 2))
                acc += sigma * (w[:, 0] + 1j * w[:, 1])
            if image:
                acc = acc + eps * np.conj(acc)
            acc += dc
            q, c = quantise_cu8(acc)
            clipped += c
            digest.update(q.tobytes())
            out.write(q.tobytes())
    fraction = clipped / (2 * n_total)
    sidecar = {
        'id': recipe['id'],
        'composer': 'fixtures/compose.py',
        'numpy': np.__version__,
        'format': 'cu8',
        'sampleRate': fs,
        'centerHz': recipe['centerHz'],
        'durationS': recipe['durationS'],
        'samples': n_total,
        'bytes': 2 * n_total,
        'seed': recipe['seed'],
        'noiseDbfs': noise_dbfs,
        'dcSpikeDbfs': dc_dbfs,
        'iqImage': image,
        'clippedValues': clipped,
        'clipFraction': fraction,
        'sha256': digest.hexdigest(),
        'components': [info for info, _, _ in parts],
    }
    if sidecar_path:
        Path(sidecar_path).write_text(json.dumps(sidecar, indent=2) + '\n')
    if fraction > MAX_CLIP_FRACTION:
        raise RecipeError(f'{clipped} of {2 * n_total} I/Q values saturate ({fraction:.2e} > {MAX_CLIP_FRACTION}); lower levelDb')
    return sidecar


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('recipe')
    ap.add_argument('--out')
    ap.add_argument('--sidecar')
    ap.add_argument('--sources-dir', default=str(HERE / 'raw' / '.sources'))
    ap.add_argument('--list-sources', action='store_true')
    args = ap.parse_args(argv)
    try:
        recipe = load_recipe(args.recipe)
        if args.list_sources:
            used = {c['source'] for c in recipe['components'] if 'source' in c}
            for s in recipe['_sources'].values():
                if s['id'] in used:
                    print(f"{s['id']}|{s['url']}|{s['sha256']}|{s['file']}")
            return 0
        if not args.out:
            ap.error('--out is required unless --list-sources')
        s = compose(recipe, args.out, args.sources_dir, args.sidecar)
    except (ValueError, OSError, KeyError) as e:
        print(f'compose: {e}', file=sys.stderr)
        return 2
    print(f"{s['id']}: {s['bytes']} B, sha256 {s['sha256']}, clipped {s['clippedValues']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
