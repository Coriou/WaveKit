/**
 * Voice frame meter for the evidence squelch (design, VoiceFrameMeter; requirements 1.3, 5.1,
 * 5.2). Consumes 8 kHz mono samples in PCM full-scale units and emits one frame every
 * `VOICE_METER_FRAME_SAMPLES` (50 ms) with the analog trial's `audioDb`, `syllabic` and
 * `cluster` statistics, computed as the textbook algorithms the IQ analyzer documents
 * (RBJ biquads, a one-pole syllabic high-pass, histogram k-means). Not a port of that code.
 *
 * Scale: the analyzer demodulates with gain 2, so samples are divided by `gain / 2` first; a
 * full-deviation sine (amplitude 0.8 at gain 2) reads 0 dB.
 *
 * All state is allocated in the constructor; `push` allocates nothing. A non-finite input
 * marks the frame non-finite (its statistics become NaN, the envelope ring is not fed) and is
 * fed to the filters as 0, so the next all-finite frame is finite again.
 */
import {
	LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS,
	LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES,
} from "@wavekit/api-types"
import { WaveKitError } from "../../utils/errors.js"
import { AUDIO_TONE_RATE_HZ } from "../audio-tones/tone-detector.js"

/** 8 000 Hz × 50 ms / 1 000 = 400 samples per frame. */
export const VOICE_METER_FRAME_SAMPLES =
	(AUDIO_TONE_RATE_HZ * LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS) / 1_000

export interface VoiceFrame {
	audioDb: number
	syllabic: number
	cluster: number
	finite: boolean
}

/** Mean square of a full-deviation sine at gain 2 (0.8² / 2). */
const FULL_DEVIATION_MEAN_SQUARE = 0.32
const SILENCE_DB = -160
const SYLLABIC_MAX = 160
const HIST_BINS = 256
const KMEANS_ITERS = 6
const CLUSTER_FRACTION = 0.15
const MIN_CENTROID_SPAN = 0.15
/** PCM (gain-2 scale) to discriminator radians at the analyzer's 48 kHz rate. */
const RAD_PER_UNIT = (2 * Math.PI * 5_000) / 48_000 / 0.8
/** One-pole 2 Hz high-pass at the 20 Hz envelope rate. */
const SYLLABIC_ALPHA = Math.exp((-2 * Math.PI * 2) / 20)

class Biquad {
	private readonly b0: number
	private readonly b1: number
	private readonly b2: number
	private readonly a1: number
	private readonly a2: number
	private x1 = 0
	private x2 = 0
	private y1 = 0
	private y2 = 0

	/** RBJ cookbook, Q = 1/√2. */
	constructor(high: boolean, rate: number, hz: number) {
		const w0 = (2 * Math.PI * hz) / rate
		const cos = Math.cos(w0)
		const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
		const a0 = 1 + alpha
		if (high) {
			this.b0 = (1 + cos) / 2 / a0
			this.b1 = -(1 + cos) / a0
		} else {
			this.b0 = (1 - cos) / 2 / a0
			this.b1 = (1 - cos) / a0
		}
		this.b2 = this.b0
		this.a1 = (-2 * cos) / a0
		this.a2 = (1 - alpha) / a0
	}

	step(x: number): number {
		const y =
			this.b0 * x +
			this.b1 * this.x1 +
			this.b2 * this.x2 -
			this.a1 * this.y1 -
			this.a2 * this.y2
		this.x2 = this.x1
		this.x1 = x
		this.y2 = this.y1
		this.y1 = y
		return y
	}

	/** True while the state is finite (huge finite input can overflow it). */
	finite(): boolean {
		return Number.isFinite(this.y1) && Number.isFinite(this.y2)
	}

	reset(): void {
		this.x1 = 0
		this.x2 = 0
		this.y1 = 0
		this.y2 = 0
	}
}

export class VoiceFrameMeter {
	private readonly record: VoiceFrame = {
		audioDb: SILENCE_DB,
		syllabic: 0,
		cluster: 0,
		finite: true,
	}
	private readonly scale: number
	private readonly hp = new Biquad(true, AUDIO_TONE_RATE_HZ, 300)
	private readonly lp = new Biquad(false, AUDIO_TONE_RATE_HZ, 3_000)
	private readonly lo = new Biquad(false, AUDIO_TONE_RATE_HZ, 2_400)
	private readonly rawView = new Float32Array(VOICE_METER_FRAME_SAMPLES)
	private readonly loView = new Float32Array(VOICE_METER_FRAME_SAMPLES)
	private readonly envelope = new Float64Array(
		LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES,
	)
	private readonly hist = new Uint32Array(HIST_BINS)
	private readonly cents = new Float64Array(4)
	private readonly sums = new Float64Array(4)
	private readonly counts = new Float64Array(4)
	private envHead = 0
	private envLen = 0
	private fill = 0
	private power = 0
	private frameFinite = true
	private frames = 0

	constructor(options: { gain: number }) {
		const gain = options.gain
		if (typeof gain !== "number" || !Number.isFinite(gain) || gain <= 0)
			throw new WaveKitError(
				"Evidence squelch gain must be finite and positive",
				"EVIDENCE_GAIN",
			)
		this.scale = 2 / gain
	}

	/** The last completed frame (a reused record). */
	get frame(): Readonly<VoiceFrame> {
		return this.record
	}

	get frameCount(): number {
		return this.frames
	}

	/** One 8 kHz sample in PCM full-scale units. True when a frame completed (read `frame`). */
	push(sample: number): boolean {
		let x = sample * this.scale
		if (!Number.isFinite(x)) {
			this.frameFinite = false
			x = 0
		}
		const y = this.lp.step(this.hp.step(x))
		this.power += y * y
		const index = this.fill
		this.rawView[index] = x * RAD_PER_UNIT
		this.loView[index] = this.lo.step(x) * RAD_PER_UNIT
		this.fill = index + 1
		if (this.fill < VOICE_METER_FRAME_SAMPLES) return false
		this.completeFrame()
		return true
	}

	reset(): void {
		this.hp.reset()
		this.lp.reset()
		this.lo.reset()
		this.rawView.fill(0)
		this.loView.fill(0)
		this.envelope.fill(0)
		this.envHead = 0
		this.envLen = 0
		this.fill = 0
		this.power = 0
		this.frameFinite = true
		this.frames = 0
		this.record.audioDb = SILENCE_DB
		this.record.syllabic = 0
		this.record.cluster = 0
		this.record.finite = true
	}

	private completeFrame(): void {
		const power = this.power / VOICE_METER_FRAME_SAMPLES
		let finite =
			this.frameFinite &&
			Number.isFinite(power) &&
			this.hp.finite() &&
			this.lp.finite() &&
			this.lo.finite()
		let cluster = 0
		if (finite) {
			cluster = Math.max(
				this.clusterScore(this.loView),
				this.clusterScore(this.rawView),
			)
			if (!Number.isFinite(cluster)) finite = false
		}
		const record = this.record
		if (finite) {
			this.envelope[this.envHead] = power
			this.envHead = (this.envHead + 1) % this.envelope.length
			if (this.envLen < this.envelope.length) this.envLen += 1
			record.audioDb =
				power <= 0
					? SILENCE_DB
					: 10 * Math.log10(power / FULL_DEVIATION_MEAN_SQUARE)
			record.syllabic = this.syllabic()
			record.cluster = cluster
			record.finite = Number.isFinite(record.syllabic)
		} else {
			record.audioDb = NaN
			record.syllabic = NaN
			record.cluster = NaN
			record.finite = false
			// Recover from an overflowed filter state on the next frame.
			if (!this.hp.finite() || !this.lp.finite() || !this.lo.finite()) {
				this.hp.reset()
				this.lp.reset()
				this.lo.reset()
			}
		}
		this.fill = 0
		this.power = 0
		this.frameFinite = true
		this.frames += 1
	}

	/** RMS of a 2 Hz high-pass over the envelope ring (oldest first, at rest) / ring mean. */
	private syllabic(): number {
		const len = this.envLen
		if (len < 2) return 0
		const ring = this.envelope
		const size = ring.length
		const first = (this.envHead - len + size) % size
		let prev = ring[first] ?? 0
		let y = 0
		let acc = 0
		let mean = 0
		for (let i = 0; i < len; i++) {
			const x = ring[(first + i) % size] ?? 0
			y = SYLLABIC_ALPHA * (y + x - prev)
			prev = x
			acc += y * y
			mean += x
		}
		mean /= len
		if (!Number.isFinite(mean) || !Number.isFinite(acc)) return NaN
		if (mean <= 1e-12) return 0
		const index = Math.sqrt(acc / len) / mean
		return index < 0 ? 0 : index > SYLLABIC_MAX ? SYLLABIC_MAX : index
	}

	/** Histogram k-means score: the larger of k = 2 and k = 4 (0 for a span below 0.15 rad). */
	private clusterScore(samples: Float32Array): number {
		let min = Infinity
		let max = -Infinity
		for (let i = 0; i < samples.length; i++) {
			const v = samples[i] ?? 0
			if (v < min) min = v
			if (v > max) max = v
		}
		const span = max - min
		if (!Number.isFinite(span)) return NaN
		if (span < MIN_CENTROID_SPAN) return 0
		const hist = this.hist
		hist.fill(0)
		const scale = HIST_BINS / span
		for (let i = 0; i < samples.length; i++) {
			let bin = Math.floor(((samples[i] ?? 0) - min) * scale)
			if (bin >= HIST_BINS) bin = HIST_BINS - 1
			hist[bin] = (hist[bin] ?? 0) + 1
		}
		const binW = span / HIST_BINS
		const two = this.kmeans(min, binW, samples.length, 2)
		const four = this.kmeans(min, binW, samples.length, 4)
		return two > four ? two : four
	}

	private kmeans(origin: number, binW: number, n: number, k: number): number {
		const hist = this.hist
		const cents = this.cents
		const sums = this.sums
		const counts = this.counts
		// Seed at the (q + 0.5) / k quantiles.
		let cum = 0
		let q = 0
		for (let bin = 0; bin < HIST_BINS; bin++) {
			cum += hist[bin] ?? 0
			const center = origin + (bin + 0.5) * binW
			while (q < k && cum >= ((q + 0.5) / k) * n) {
				cents[q] = center
				q += 1
			}
		}
		while (q < k) {
			cents[q] = origin + (HIST_BINS - 0.5) * binW
			q += 1
		}
		for (let iter = 0; iter < KMEANS_ITERS; iter++) {
			sums.fill(0)
			counts.fill(0)
			for (let bin = 0; bin < HIST_BINS; bin++) {
				const weight = hist[bin] ?? 0
				if (weight === 0) continue
				const x = origin + (bin + 0.5) * binW
				let best = 0
				let bestD = Infinity
				for (let i = 0; i < k; i++) {
					const d = Math.abs(x - (cents[i] ?? 0))
					if (d < bestD) {
						bestD = d
						best = i
					}
				}
				sums[best] = (sums[best] ?? 0) + x * weight
				counts[best] = (counts[best] ?? 0) + weight
			}
			for (let i = 0; i < k; i++) {
				const c = counts[i] ?? 0
				if (c > 0) cents[i] = (sums[i] ?? 0) / c
			}
		}
		// Insertion sort of the first k centroids (k ≤ 4).
		for (let i = 1; i < k; i++) {
			const v = cents[i] ?? 0
			let j = i - 1
			while (j >= 0 && (cents[j] ?? 0) > v) {
				cents[j + 1] = cents[j] ?? 0
				j -= 1
			}
			cents[j + 1] = v
		}
		const span = (cents[k - 1] ?? 0) - (cents[0] ?? 0)
		if (!Number.isFinite(span)) return NaN
		if (span < MIN_CENTROID_SPAN) return 0
		let spacing = Infinity
		for (let i = 1; i < k; i++) {
			const d = (cents[i] ?? 0) - (cents[i - 1] ?? 0)
			if (d > 0 && d < spacing) spacing = d
		}
		if (!Number.isFinite(spacing)) return 0
		const tolerance = CLUSTER_FRACTION * spacing
		let hit = 0
		for (let bin = 0; bin < HIST_BINS; bin++) {
			const weight = hist[bin] ?? 0
			if (weight === 0) continue
			const left = origin + bin * binW
			const mid = left + 0.5 * binW
			let nearest = cents[0] ?? 0
			let bestD = Math.abs(mid - nearest)
			for (let i = 1; i < k; i++) {
				const c = cents[i] ?? 0
				const d = Math.abs(mid - c)
				if (d < bestD) {
					bestD = d
					nearest = c
				}
			}
			const lo = Math.max(left, nearest - tolerance)
			const hi = Math.min(left + binW, nearest + tolerance)
			if (hi > lo) hit += (weight * (hi - lo)) / binW
		}
		return hit / n
	}
}
