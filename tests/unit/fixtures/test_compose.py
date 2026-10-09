"""fixtures/compose.py self-test (channelizer T7a); run by compose.test.ts."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('compose', ROOT / 'fixtures' / 'compose.py')
compose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compose)
from generators import acars, pocsag  # noqa: E402  (compose.py put fixtures/ on sys.path)


def tone_source(directory, name, fs, freq_hz, seconds, fmt='cf32'):
    n = np.arange(int(fs * seconds))
    iq = 0.5 * np.exp(2j * np.pi * freq_hz * n / fs)
    path = Path(directory) / f'{name}.{fmt}'
    if fmt == 'cf32':
        values = np.empty(2 * len(iq), np.float32)
        values[0::2], values[1::2] = iq.real, iq.imag
        path.write_bytes(values.tobytes())
    else:
        values = np.empty(2 * len(iq), '<i2')
        values[0::2], values[1::2] = np.round(iq.real * 32767), np.round(iq.imag * 32767)
        header = struct.pack('<4sI4s', b'RIFF', 36 + values.nbytes, b'WAVE')
        header += struct.pack('<4sIHHIIHH', b'fmt ', 16, 1, 2, fs, fs * 4, 4, 16)
        header += struct.pack('<4sI', b'data', values.nbytes)
        path.write_bytes(header + values.tobytes())
    return {
        'id': name,
        'url': f'file://{path}',
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'format': fmt,
        'sampleRate': fs,
        'license': 'test',
        'file': path.name,
    }


def read_cu8(path):
    v = (np.fromfile(path, np.uint8).astype(np.float64) - 127.5) / 127.5
    return v[0::2] + 1j * v[1::2]


class ComposeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='wk-compose-')

    def recipe(self, **over):
        r = {
            'id': 'unit',
            'sampleRate': 2_048_000,
            'centerHz': 100_000_000,
            'durationS': 0.05,
            'seed': 1,
            'noiseDbfs': None,
            'sources': [tone_source(self.dir, 'tone', 48_000, 5_000, 0.05)],
            'components': [{'name': 't', 'source': 'tone', 'offsetHz': 300_000, 'levelDb': -10}],
        }
        r.update(over)
        path = Path(self.dir) / f"{r['id']}.json"
        path.write_text(json.dumps(r))
        return compose.load_recipe(path)

    def run_compose(self, recipe, name='out'):
        out = Path(self.dir) / f'{name}.cu8'
        side = compose.compose(recipe, out, self.dir, Path(self.dir) / f'{name}.json')
        return out, side

    def test_tone_lands_on_its_offset_bin(self):
        out, side = self.run_compose(self.recipe())
        x = read_cu8(out)
        spectrum = np.abs(np.fft.fft(x * np.hanning(len(x))))
        freqs = np.fft.fftfreq(len(x), 1 / 2_048_000)
        self.assertAlmostEqual(freqs[np.argmax(spectrum)], 305_000, delta=2_048_000 / len(x))
        self.assertEqual(side['components'][0]['absoluteHz'], 100_300_000)
        self.assertEqual(side['components'][0]['resample'], '128/3')
        # level: a constant-envelope tone at -10 dBFS (amplitude 0.316); edges excluded
        mid = np.abs(x[20_000:80_000])
        self.assertAlmostEqual(float(np.mean(mid)), 10 ** (-10 / 20), delta=0.01)

    def test_resampler_images_are_suppressed(self):
        out, _ = self.run_compose(self.recipe())
        x = read_cu8(out)[10_000:90_000]
        spectrum = 20 * np.log10(np.abs(np.fft.fft(x * np.kaiser(len(x), 12))) + 1e-12)
        freqs = np.fft.fftfreq(len(x), 1 / 2_048_000)
        peak = spectrum.max()
        # images of a +5 kHz tone at 48 kS/s would sit at 300 kHz + 5 kHz +- k * 48 kHz
        for k in (1, 2, -1, -2):
            f = 305_000 + k * 48_000
            near = np.abs(freqs - f) < 2_000
            self.assertLess(spectrum[near].max(), peak - 45, f'image at {f}')  # cu8 floor, not the filter, limits this

    def test_resampler_filter_in_float(self):
        r = compose.Resampler(240_000, 2_048_000)
        self.assertEqual((r.L, r.M), (128, 15))
        n = np.arange(48_000)
        x = np.exp(2j * np.pi * 20_000 * n / 240_000)
        y = r.render(r.pad(x), 0, 409_600)[40_000:360_000]
        self.assertAlmostEqual(float(np.mean(np.abs(y))), 1.0, delta=0.002)  # passband gain
        spectrum = 20 * np.log10(np.abs(np.fft.fft(y * np.kaiser(len(y), 14))) + 1e-15)
        freqs = np.fft.fftfreq(len(y), 1 / 2_048_000)
        outside = np.abs(freqs - 20_000) > 130_000
        self.assertLess(spectrum[outside].max(), spectrum.max() - 85)

    def test_cu8_mapping_and_clip_count(self):
        q, clipped = compose.quantise_cu8(np.array([-1 + 0j, 1 + 0.5j, 2 - 2j]))
        self.assertEqual(list(q), [0, 128, 255, 191, 255, 0])
        self.assertEqual(clipped, 2)

    def test_deterministic_and_seeded(self):
        recipe = self.recipe(noiseDbfs=-30, dcSpikeDbfs=-40, iqImage={'rejectionDb': 35, 'phaseDeg': 10})
        _, a = self.run_compose(recipe, 'a')
        _, b = self.run_compose(recipe, 'b')
        self.assertEqual(a['sha256'], b['sha256'])
        recipe['seed'] = 2
        _, c = self.run_compose(recipe, 'c')
        self.assertNotEqual(a['sha256'], c['sha256'])
        self.assertEqual(a['clippedValues'], 0)

    def test_refuses_saturation_and_bad_source_hash(self):
        with self.assertRaisesRegex(compose.RecipeError, 'saturate'):
            self.run_compose(self.recipe(noiseDbfs=0))
        recipe = self.recipe()
        recipe['_sources']['tone']['sha256'] = '0' * 64
        with self.assertRaisesRegex(compose.RecipeError, 'sha256'):
            self.run_compose(recipe)

    def test_wav_source_and_list_sources(self):
        src = tone_source(self.dir, 'wavtone', 96_000, -10_000, 0.05, fmt='wav')
        recipe = self.recipe(sources=[src], components=[{'name': 'w', 'source': 'wavtone', 'offsetHz': -200_000, 'levelDb': -12}])
        out, side = self.run_compose(recipe)
        x = read_cu8(out)
        freqs = np.fft.fftfreq(len(x), 1 / 2_048_000)
        self.assertAlmostEqual(freqs[np.argmax(np.abs(np.fft.fft(x)))], -210_000, delta=50)
        self.assertEqual(side['components'][0]['resample'], '64/3')

    def test_identity_rate_and_repeat(self):
        src = tone_source(self.dir, 'fast', 2_048_000, 0, 0.01)
        recipe = self.recipe(sources=[src], components=[{'name': 'f', 'source': 'fast', 'offsetHz': 100_000, 'levelDb': -6, 'repeatEveryS': 0.02}])
        out, side = self.run_compose(recipe)
        self.assertEqual(side['components'][0]['startsS'], [0.0, 0.02, 0.04])
        self.assertEqual(side['components'][0]['resample'], '1/1')
        env = np.abs(read_cu8(out))
        self.assertGreater(env[1_000], 0.4)
        self.assertLess(env[int(0.015 * 2_048_000)], 0.05)


class GeneratorTest(unittest.TestCase):
    def test_pocsag_bch_reproduces_the_idle_and_sync_codewords(self):
        for word in (pocsag.IDLE, pocsag.SYNC):
            self.assertEqual(pocsag.codeword(word >> 11), word)

    def test_pocsag_frame_slot_and_spectrum(self):
        bits = pocsag.page_bits({'baud': 1200, 'address': 1234565, 'function': 3, 'alpha': 'HI'})
        self.assertEqual(bits[:4], [1, 0, 1, 0])
        sync_at = pocsag.PREAMBLE_BITS
        words = [int(''.join(map(str, bits[sync_at + 32 * i : sync_at + 32 * (i + 1)])), 2) for i in range(17)]
        self.assertEqual(words[0], pocsag.SYNC)
        self.assertEqual(words[1 + 2 * (1234565 & 7)], pocsag.address_codeword(1234565, 3))
        iq, fs, expected = pocsag.generate({'pages': [{'baud': 512, 'address': 8, 'numeric': '123'}]}, 3.0)
        self.assertEqual(fs, 48_000)
        self.assertEqual(expected[0]['protocol'], 'POCSAG512')
        f = np.angle(iq[1:] * np.conj(iq[:-1])) * fs / (2 * np.pi)
        self.assertAlmostEqual(float(np.max(f[np.abs(iq[1:]) > 0.99])), 4500, delta=1)

    def test_pocsag_continuous_keying_has_no_gaps(self):
        pages = [{'baud': 1200, 'address': 8, 'numeric': '1'}, {'baud': 512, 'address': 16, 'alpha': 'A'}]
        iq, fs, expected = pocsag.generate({'continuous': True, 'startS': 0.1, 'gapS': 0.2, 'pages': pages}, 6.0)
        keyed = np.abs(iq[int(0.11 * fs) : int(5.89 * fs)])
        self.assertGreater(float(keyed.min()), 0.99)
        self.assertEqual(float(np.abs(iq[: int(0.09 * fs)]).max()), 0.0)
        self.assertEqual([e['protocol'] for e in expected], ['POCSAG1200', 'POCSAG512'])

    def test_acars_bcs_is_crc16_kermit(self):
        self.assertEqual(acars.crc16_kermit(b'123456789'), 0x2189)
        frame = acars.frame_bytes({'tail': 'N12345', 'label': 'H1', 'blockId': '2', 'msgno': 'M01A', 'flight': 'WK0001', 'text': 'X'})
        soh = frame.index(0x01)
        etx = frame.index(0x83)
        self.assertEqual(acars.crc16_kermit(frame[soh + 1 : etx + 3]), 0)
        self.assertTrue(all(bin(b).count('1') % 2 == 1 for b in frame[soh : etx + 1]))
        self.assertEqual(list(acars.msk_tones([1, 1, 0, 0, 1])), [2400, 2400, 1200, 2400, 1200])


if __name__ == '__main__':
    unittest.main(verbosity=2)
