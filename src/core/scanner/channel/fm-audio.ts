import { WaveKitError } from "../../../utils/errors.js"

export const ANALOG_AUDIO_RATE_HZ = 8000
const INPUT_RATE_HZ = 48_000
const TAPS = 127

function lowpass(): Float64Array {
	const h = new Float64Array(TAPS)
	let sum = 0
	for (let k = 0; k < TAPS; k++) {
		const t = k - (TAPS - 1) / 2
		const x = ((2 * 3000) / INPUT_RATE_HZ) * t
		const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
		const window =
			0.42 -
			0.5 * Math.cos((2 * Math.PI * k) / (TAPS - 1)) +
			0.08 * Math.cos((4 * Math.PI * k) / (TAPS - 1))
		h[k] = sinc * window
		sum += h[k]!
	}
	return h.map(value => value / sum)
}

/** Stateful 48 kHz interleaved cf32 discriminator to 8 kHz mono s16. */
export class FmAudioDemod {
	private readonly scale: number
	private readonly alpha: number | null
	private readonly taps = lowpass()
	private readonly history = new Float64Array(TAPS)
	private head = 0
	private phase = 0
	private lastI = 0
	private lastQ = 0
	private deemph = 0
	private pendingI: number | null = null

	constructor(
		opts: {
			inputRateHz?: number
			maxDeviationHz?: number
			deemphasisUs?: number | null
		} = {},
	) {
		const rate = opts.inputRateHz ?? INPUT_RATE_HZ
		const deviation = opts.maxDeviationHz ?? 5000
		const tau = opts.deemphasisUs === undefined ? 750 : opts.deemphasisUs
		if (
			rate !== INPUT_RATE_HZ ||
			!Number.isFinite(deviation) ||
			deviation <= 0 ||
			deviation >= rate / 2 ||
			(tau !== null && (!Number.isFinite(tau) || tau <= 0))
		) {
			throw new WaveKitError(
				"Invalid 48 kHz FM demodulator options",
				"SCANNER_AUDIO_OPTIONS",
			)
		}
		this.scale = rate / (2 * Math.PI * deviation)
		this.alpha = tau === null ? null : 1 - Math.exp(-1 / (rate * tau * 1e-6))
	}

	reset(): void {
		this.history.fill(0)
		this.head = this.phase = this.lastI = this.lastQ = this.deemph = 0
		this.pendingI = null
	}

	process(cf32: Float32Array): Int16Array {
		// Validate before changing state, including a retained odd interleaved float.
		for (const value of cf32) {
			if (!Number.isFinite(value))
				throw new WaveKitError("Nonfinite cf32 input", "SCANNER_AUDIO_INPUT")
		}
		const n = Math.floor((cf32.length + (this.pendingI === null ? 0 : 1)) / 2)
		const out = new Int16Array(Math.floor((this.phase + n) / 6))
		let offset = 0
		let written = 0
		for (let sample = 0; sample < n; sample++) {
			const re = this.pendingI === null ? cf32[offset++]! : this.pendingI
			this.pendingI = null
			const im = cf32[offset++]!
			let x =
				Math.atan2(
					im * this.lastI - re * this.lastQ,
					re * this.lastI + im * this.lastQ,
				) * this.scale
			this.lastI = re
			this.lastQ = im
			if (this.alpha !== null) {
				this.deemph += this.alpha * (x - this.deemph)
				x = this.deemph * 4 // Historical +12 dB makeup (approximately 4x).
			}
			this.history[this.head] = x
			this.phase++
			if (this.phase === 6) {
				this.phase = 0
				let acc = 0
				for (let k = 0; k < TAPS; k++)
					acc += this.taps[k]! * this.history[(this.head - k + TAPS) % TAPS]!
				out[written++] = Math.max(
					-32768,
					Math.min(32767, Math.round(acc * 32767)),
				)
			}
			this.head = (this.head + 1) % TAPS
		}
		if (offset < cf32.length) this.pendingI = cf32[offset]!
		return out
	}
}
