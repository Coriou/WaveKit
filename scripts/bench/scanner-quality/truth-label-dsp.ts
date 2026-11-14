/**
 * Scanner truth labelling: the signal processing that proposes labels from a CU8 capture.
 * Offline and bounded (the whole capture is read once per pass); nothing here runs in the core.
 *
 * - occupancy(): 1 024-point power spectra averaged into 50 ms frames (`FRAME_MS`).
 * - channelsOf(): channels whose strongest frame stands CHANNEL_SNR_DB over the noise floor.
 * - segmentsOf(): one channel's on-air stretches (hysteresis ON_DB / OFF_DB, gaps of up to
 *   MERGE_GAP_MS joined, stretches under MIN_SEGMENT_MS dropped).
 * - demodulate(): one stretch of one channel shifted to 0 Hz, low-passed, decimated by 16 and
 *   FM-demodulated: instantaneous frequency (Hz) at rate / 16, then resampled to the decoders'
 *   audio rates (48 kHz for dsd-fme, 22 050 Hz for multimon-ng).
 */

export const FFT_SIZE = 1_024
export const FRAME_MS = 50
/** A channel: the strongest frame's in-channel power over the floor by at least this. */
export const CHANNEL_SNR_DB = 10
/** In-channel power band: ±4 kHz (a 12.5 kHz channel's occupied band, a 6.25 kHz one's too). */
export const CHANNEL_HALF_HZ = 4_000
export const ON_DB = 8
export const OFF_DB = 5
export const MERGE_GAP_MS = 250
export const MIN_SEGMENT_MS = 150
/**
 * Channels nearer than this are one (the stronger is kept): a 12.5 kHz signal's spectrum peaks
 * on two or three 6.25 kHz neighbours, which are one transmitter.
 */
export const CHANNEL_MERGE_HZ = 9_000
export const DECIMATION = 16

export interface Occupancy {
	rateHz: number
	centreHz: number
	/** frames × FFT_SIZE power (linear), bins in FFT order shifted so bin 0 is −rate/2. */
	frames: Float64Array[]
	/** Median bin power over all frames and bins: the noise floor per bin. */
	floor: number
	/** One frame's length (ms): a whole number of spectra, the nearest to FRAME_MS. */
	frameMs: number
}

/** In-place radix-2 complex FFT of length n (a power of 2). */
export function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1
		for (; j & bit; bit >>= 1) j ^= bit
		j ^= bit
		if (i < j) {
			const tr = re[i]!
			re[i] = re[j]!
			re[j] = tr
			const ti = im[i]!
			im[i] = im[j]!
			im[j] = ti
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len
		const wr = Math.cos(ang)
		const wi = Math.sin(ang)
		for (let i = 0; i < n; i += len) {
			let cr = 1
			let ci = 0
			for (let k = 0; k < len / 2; k++) {
				const a = i + k
				const b = a + len / 2
				const xr = re[b]! * cr - im[b]! * ci
				const xi = re[b]! * ci + im[b]! * cr
				re[b] = re[a]! - xr
				im[b] = im[a]! - xi
				re[a] = re[a]! + xr
				im[a] = im[a]! + xi
				const t = cr * wr - ci * wi
				ci = cr * wi + ci * wr
				cr = t
			}
		}
	}
}

/** Averaged power spectra of a CU8 buffer in FRAME_MS frames (Hann window). */
export function occupancy(
	cu8: Uint8Array,
	rateHz: number,
	centreHz: number,
): Occupancy {
	const samples = cu8.length >> 1
	const perFrame = Math.max(
		1,
		Math.round((rateHz * FRAME_MS) / 1000 / FFT_SIZE),
	)
	const win = new Float64Array(FFT_SIZE)
	for (let i = 0; i < FFT_SIZE; i++)
		win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
	const re = new Float64Array(FFT_SIZE)
	const im = new Float64Array(FFT_SIZE)
	const frames: Float64Array[] = []
	let acc = new Float64Array(FFT_SIZE)
	let count = 0
	for (let s = 0; s + FFT_SIZE <= samples; s += FFT_SIZE) {
		for (let i = 0; i < FFT_SIZE; i++) {
			re[i] = ((cu8[2 * (s + i)]! - 127.5) / 127.5) * win[i]!
			im[i] = ((cu8[2 * (s + i) + 1]! - 127.5) / 127.5) * win[i]!
		}
		fft(re, im)
		for (let k = 0; k < FFT_SIZE; k++) {
			const b = (k + FFT_SIZE / 2) % FFT_SIZE
			acc[b] = acc[b]! + re[k]! * re[k]! + im[k]! * im[k]!
		}
		if (++count === perFrame) {
			for (let k = 0; k < FFT_SIZE; k++) acc[k] = acc[k]! / count
			frames.push(acc)
			acc = new Float64Array(FFT_SIZE)
			count = 0
		}
	}
	const all: number[] = []
	for (const f of frames) for (let k = 0; k < FFT_SIZE; k += 7) all.push(f[k]!)
	all.sort((a, b) => a - b)
	const floor = all[all.length >> 1] ?? 1e-12
	return {
		rateHz,
		centreHz,
		frames,
		floor,
		frameMs: (perFrame * FFT_SIZE * 1000) / rateHz,
	}
}

const binOf = (o: Occupancy, hz: number): number =>
	Math.round(((hz - o.centreHz) / o.rateHz) * FFT_SIZE + FFT_SIZE / 2)

/** Power in ±CHANNEL_HALF_HZ of `hz` per frame, over the floor of as many bins (dB). */
export function channelSnr(o: Occupancy, hz: number): Float64Array {
	const half = Math.max(1, Math.round((CHANNEL_HALF_HZ / o.rateHz) * FFT_SIZE))
	const c = binOf(o, hz)
	const lo = Math.max(1, c - half)
	const hi = Math.min(FFT_SIZE - 2, c + half)
	const out = new Float64Array(o.frames.length)
	const floor = o.floor * (hi - lo + 1)
	for (let f = 0; f < o.frames.length; f++) {
		let p = 0
		for (let k = lo; k <= hi; k++) p += o.frames[f]![k]!
		out[f] = 10 * Math.log10(Math.max(p, 1e-30) / floor)
	}
	return out
}

/**
 * Channel candidates: `hints` (known frequencies) plus every spectral peak whose strongest
 * frame reaches CHANNEL_SNR_DB, snapped to `rasterHz` (offset `rasterOffsetHz`), inside the
 * usable span (80 % of the rate) and not within 2 kHz of the centre (the DC spike).
 */
export function channelsOf(
	o: Occupancy,
	hints: readonly number[],
	rasterHz: number,
	rasterOffsetHz: number,
): number[] {
	const maxHold = new Float64Array(FFT_SIZE)
	for (const f of o.frames)
		for (let k = 0; k < FFT_SIZE; k++)
			if (f[k]! > maxHold[k]!) maxHold[k] = f[k]!
	const snap = (hz: number): number =>
		Math.round((hz - rasterOffsetHz) / rasterHz) * rasterHz + rasterOffsetHz
	const span = o.rateHz * 0.4
	const found: { hz: number; peak: number }[] = []
	const consider = (hz: number): void => {
		if (Math.abs(hz - o.centreHz) > span || Math.abs(hz - o.centreHz) < 2_000)
			return
		const snr = channelSnr(o, hz)
		let peak = -Infinity
		for (const v of snr) if (v > peak) peak = v
		if (peak < CHANNEL_SNR_DB) return
		found.push({ hz, peak })
	}
	for (const h of hints) consider(snap(h))
	const binHz = o.rateHz / FFT_SIZE
	const half = Math.max(1, Math.round(CHANNEL_HALF_HZ / binHz))
	for (let k = half; k < FFT_SIZE - half; k++) {
		const v = maxHold[k]!
		if (v < o.floor * 10 ** (CHANNEL_SNR_DB / 10)) continue
		if (v < maxHold[k - 1]! || v < maxHold[k + 1]!) continue
		// The power centroid of ±CHANNEL_HALF_HZ around the peak: the carrier of a wide signal,
		// not whichever of its sidebands peaked.
		let p = 0
		let pk = 0
		for (let j = k - half; j <= k + half; j++) {
			const x = Math.max(0, maxHold[j]! - o.floor)
			p += x
			pk += x * j
		}
		const centroid = p > 0 ? pk / p : k
		consider(snap(o.centreHz + (centroid - FFT_SIZE / 2) * binHz))
	}
	found.sort((a, b) => b.peak - a.peak)
	const kept: { hz: number; peak: number }[] = []
	for (const f of found)
		if (!kept.some(k => Math.abs(k.hz - f.hz) < CHANNEL_MERGE_HZ)) kept.push(f)
	return kept.map(k => k.hz).sort((a, b) => a - b)
}

/** On-air stretches of one channel (ms from the capture start); frames `frameMs` long. */
export function segmentsOf(
	snr: Float64Array,
	frameMs: number = FRAME_MS,
): { startMs: number; endMs: number }[] {
	const raw: { startMs: number; endMs: number }[] = []
	let on = -1
	for (let f = 0; f < snr.length; f++) {
		const v = snr[f]!
		if (on < 0 && v >= ON_DB) on = f
		else if (on >= 0 && v < OFF_DB) {
			raw.push({ startMs: on * frameMs, endMs: f * frameMs })
			on = -1
		}
	}
	if (on >= 0) raw.push({ startMs: on * frameMs, endMs: snr.length * frameMs })
	const merged: { startMs: number; endMs: number }[] = []
	for (const s of raw) {
		const last = merged.at(-1)
		if (last && s.startMs - last.endMs <= MERGE_GAP_MS) last.endMs = s.endMs
		else merged.push({ ...s })
	}
	return merged.filter(s => s.endMs - s.startMs >= MIN_SEGMENT_MS)
}

/** Windowed-sinc low-pass taps (Hamming), cutoff `cutoff` as a fraction of the rate. */
function lowPass(taps: number, cutoff: number): Float64Array {
	const h = new Float64Array(taps)
	const m = (taps - 1) / 2
	let sum = 0
	for (let i = 0; i < taps; i++) {
		const x = i - m
		const sinc =
			x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
		h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)))
		sum += h[i]!
	}
	for (let i = 0; i < taps; i++) h[i] = h[i]! / sum
	return h
}

/** Instantaneous frequency (Hz) of `hz` over [startMs, endMs) at rate / DECIMATION. */
export function demodulate(
	cu8: Uint8Array,
	rateHz: number,
	centreHz: number,
	hz: number,
	startMs: number,
	endMs: number,
): { rateHz: number; freq: Float64Array } {
	const taps = lowPass(127, 9_000 / rateHz)
	const from = Math.max(0, Math.floor((startMs * rateHz) / 1000))
	const to = Math.min(cu8.length >> 1, Math.ceil((endMs * rateHz) / 1000))
	const n = Math.max(0, Math.floor((to - from - taps.length) / DECIMATION))
	const outRate = rateHz / DECIMATION
	const freq = new Float64Array(n)
	const w = (-2 * Math.PI * (hz - centreHz)) / rateHz
	const len = to - from
	const br = new Float64Array(len)
	const bi = new Float64Array(len)
	for (let i = 0; i < len; i++) {
		const x = (cu8[2 * (from + i)]! - 127.5) / 127.5
		const y = (cu8[2 * (from + i) + 1]! - 127.5) / 127.5
		const c = Math.cos(w * (from + i))
		const s = Math.sin(w * (from + i))
		br[i] = x * c - y * s
		bi[i] = x * s + y * c
	}
	let pr = 0
	let pi = 0
	for (let k = 0; k < n; k++) {
		let r = 0
		let q = 0
		const base = k * DECIMATION
		for (let t = 0; t < taps.length; t++) {
			r += br[base + t]! * taps[t]!
			q += bi[base + t]! * taps[t]!
		}
		// arg(z · conj(prev)): the phase step, in Hz at the output rate.
		const dr = r * pr + q * pi
		const di = q * pr - r * pi
		freq[k] = k === 0 ? 0 : (Math.atan2(di, dr) * outRate) / (2 * Math.PI)
		pr = r
		pi = q
	}
	return { rateHz: outRate, freq }
}

/** Linear resampling of `x` from `fromHz` to `toHz`. */
export function resample(
	x: Float64Array,
	fromHz: number,
	toHz: number,
): Float64Array {
	const n = Math.floor((x.length * toHz) / fromHz)
	const out = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		const pos = (i * fromHz) / toHz
		const k = Math.floor(pos)
		const a = x[k] ?? 0
		const b = x[k + 1] ?? a
		out[i] = a + (b - a) * (pos - k)
	}
	return out
}

/** Hz of deviation to s16 (±5 kHz to about ±16 000, the scale of an FM discriminator's output). */
export function toS16(freqHz: Float64Array): Int16Array {
	const out = new Int16Array(freqHz.length)
	for (let i = 0; i < freqHz.length; i++)
		out[i] = Math.max(-32_767, Math.min(32_767, Math.round(freqHz[i]! * 3.2)))
	return out
}

/** A mono 16-bit WAV. */
export function wav(pcm: Int16Array, rateHz: number): Buffer {
	const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
	const h = Buffer.alloc(44)
	h.write("RIFF", 0)
	h.writeUInt32LE(36 + data.length, 4)
	h.write("WAVE", 8)
	h.write("fmt ", 12)
	h.writeUInt32LE(16, 16)
	h.writeUInt16LE(1, 20)
	h.writeUInt16LE(1, 22)
	h.writeUInt32LE(rateHz, 24)
	h.writeUInt32LE(rateHz * 2, 28)
	h.writeUInt16LE(2, 32)
	h.writeUInt16LE(16, 34)
	h.write("data", 36)
	h.writeUInt32LE(data.length, 40)
	return Buffer.concat([h, data])
}

/** RMS of the deviation around its mean (Hz): a carrier's is near 0, speech's about 1 kHz. */
export function deviationRms(freqHz: Float64Array): number {
	if (freqHz.length === 0) return 0
	let s = 0
	for (const v of freqHz) s += v
	const m = s / freqHz.length
	let q = 0
	for (const v of freqHz) q += (v - m) ** 2
	return Math.sqrt(q / freqHz.length)
}

/** POCSAG addresses multimon-ng decoded (its BCH check passed). */
export function parseMultimon(text: string): string[] {
	const out: string[] = []
	for (const m of text.matchAll(/POCSAG\d+:\s+Address:\s+(\d+)/g))
		out.push(m[1]!)
	return out
}

/** dsd-fme frames with the same colour code that make a stretch DMR (3: one in 120 ms of a call). */
export const DSD_MIN_FRAMES = 3

/**
 * DMR frames dsd-fme decoded: its `Sync: +DMR … Color Code=NN` lines without a CRC error, as the
 * colour code most of them carry and how many do. A colour code that varies from frame to frame
 * (`XX`, or one frame each) is a sync match on noise, not a decode: count 0.
 */
export function parseDsdFme(text: string): {
	cc: string | null
	frames: number
} {
	const counts = new Map<string, number>()
	for (const line of text.split("\n")) {
		if (!/Sync:\s*[+-]DMR/.test(line) || /CRC ERR/.test(line)) continue
		const m = /Color Code=(\d{1,2})\b/.exec(line)
		if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1)
	}
	let cc: string | null = null
	let frames = 0
	for (const [k, v] of counts)
		if (v > frames) {
			cc = k
			frames = v
		}
	return frames >= DSD_MIN_FRAMES ? { cc, frames } : { cc: null, frames: 0 }
}
