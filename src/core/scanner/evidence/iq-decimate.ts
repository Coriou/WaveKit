/**
 * CU8 channel extraction in Node: NCO mix to DC, Blackman windowed-sinc FIR,
 * integer decimation to about 48 kHz. Used by burst captures (Task 34a) and
 * IQ evidence snippets (Task 42). Streaming and one-shot give identical output.
 */
import { WaveKitError } from "../../../utils/errors.js"

export interface DecimationPlan {
	decimation: number
	outputRateHz: number
	exact: boolean
}

/** Largest D giving an integer rate in [target, 4/3·target]; else floor(fs/target), rounded rate. */
export function chooseDecimation(
	inputRateHz: number,
	targetRateHz = 48_000,
): DecimationPlan {
	const maxD = Math.floor(inputRateHz / targetRateHz)
	if (maxD < 1) {
		throw new WaveKitError(
			`Input rate ${inputRateHz} Hz is below the ${targetRateHz} Hz channel rate`,
			"SCANNER_DECIMATION_RATE",
		)
	}
	for (let d = maxD; d >= 1; d--) {
		const out = inputRateHz / d
		if (out > (targetRateHz * 4) / 3) break
		if (Number.isInteger(out))
			return { decimation: d, outputRateHz: out, exact: true }
	}
	return {
		decimation: maxD,
		outputRateHz: Math.round(inputRateHz / maxD),
		exact: false,
	}
}

/** Odd-length lowpass, cutoff 0.45/D cycles per input sample, unity DC gain. */
export function designLowpass(
	decimation: number,
	tapsPerDecimation = 6,
): Float32Array {
	const n = Math.max(3, tapsPerDecimation * decimation) | 1
	const m = (n - 1) / 2
	const fc = 0.45 / decimation
	const h = new Float64Array(n)
	let sum = 0
	for (let k = 0; k < n; k++) {
		const x = k - m
		const sinc =
			x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
		const w =
			0.42 -
			0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) +
			0.08 * Math.cos((4 * Math.PI * k) / (n - 1))
		h[k] = sinc * w
		sum += h[k]!
	}
	const out = new Float32Array(n)
	for (let k = 0; k < n; k++) out[k] = h[k]! / sum
	return out
}

const RENORM_EVERY = 4096

export class ChannelDecimator {
	readonly plan: DecimationPlan
	private readonly taps: Float32Array
	private readonly re: Float32Array
	private readonly im: Float32Array
	private readonly rotRe: number
	private readonly rotIm: number
	private phRe = 1
	private phIm = 0
	private pos = 0
	private count = 0
	private sinceRenorm = 0

	constructor(opts: {
		inputRateHz: number
		offsetHz: number
		targetRateHz?: number
		tapsPerDecimation?: number
	}) {
		this.plan = chooseDecimation(opts.inputRateHz, opts.targetRateHz ?? 48_000)
		this.taps = designLowpass(this.plan.decimation, opts.tapsPerDecimation ?? 6)
		this.re = new Float32Array(this.taps.length)
		this.im = new Float32Array(this.taps.length)
		const w = (-2 * Math.PI * opts.offsetHz) / opts.inputRateHz
		this.rotRe = Math.cos(w)
		this.rotIm = Math.sin(w)
	}

	/** CU8 in (whole IQ pairs), CU8 out at plan.outputRateHz. */
	push(cu8: Uint8Array): Uint8Array {
		const n = cu8.length >> 1
		const d = this.plan.decimation
		const taps = this.taps
		const len = taps.length
		const out = new Uint8Array(2 * Math.floor((this.count + n) / d))
		let o = 0
		for (let i = 0; i < n; i++) {
			const xr = (cu8[2 * i]! - 127.5) / 127.5
			const xi = (cu8[2 * i + 1]! - 127.5) / 127.5
			this.re[this.pos] = xr * this.phRe - xi * this.phIm
			this.im[this.pos] = xr * this.phIm + xi * this.phRe
			const nr = this.phRe * this.rotRe - this.phIm * this.rotIm
			this.phIm = this.phRe * this.rotIm + this.phIm * this.rotRe
			this.phRe = nr
			if (++this.sinceRenorm === RENORM_EVERY) {
				const mag = Math.hypot(this.phRe, this.phIm)
				this.phRe /= mag
				this.phIm /= mag
				this.sinceRenorm = 0
			}
			const newest = this.pos
			this.pos = (this.pos + 1) % len
			if (++this.count < d) continue
			this.count = 0
			let ar = 0
			let ai = 0
			let idx = newest
			for (let k = 0; k < len; k++) {
				ar += taps[k]! * this.re[idx]!
				ai += taps[k]! * this.im[idx]!
				idx = idx === 0 ? len - 1 : idx - 1
			}
			out[o++] = Math.min(255, Math.max(0, Math.round(ar * 127.5 + 127.5)))
			out[o++] = Math.min(255, Math.max(0, Math.round(ai * 127.5 + 127.5)))
		}
		return out
	}
}

export function decimateToChannel(
	cu8: Uint8Array,
	opts: { inputRateHz: number; offsetHz: number; targetRateHz?: number },
): {
	bytes: Uint8Array
	sampleRateHz: number
	decimation: number
	exact: boolean
} {
	const d = new ChannelDecimator(opts)
	return {
		bytes: d.push(cu8),
		sampleRateHz: d.plan.outputRateHz,
		decimation: d.plan.decimation,
		exact: d.plan.exact,
	}
}
