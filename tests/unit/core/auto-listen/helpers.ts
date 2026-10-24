import type { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"

export interface Fed {
	samples: number[]
	flags: number[]
}

/**
 * Feeds `input` through `res` in spans cut at `cuts` (sorted, inside the input), each span with
 * its flag from `flagOf(spanStart)`, and with an output window of at most `outWindow` samples per
 * call.
 */
export function feed(
	res: PolyphaseResampler,
	input: Int16Array | Float32Array,
	cuts: readonly number[],
	outWindow: number,
	flagOf: (at: number) => number = () => 0,
): Fed {
	const samples: number[] = []
	const flags: number[] = []
	const out = new Int16Array(Math.max(1, outWindow))
	const outFlags = new Uint8Array(out.length)
	const bounds = [0, ...cuts, input.length]
	for (let s = 0; s + 1 < bounds.length; s++) {
		let i = bounds[s] ?? 0
		const end = bounds[s + 1] ?? 0
		const flag = flagOf(i)
		for (;;) {
			res.process(input, i, end, out, 0, out.length, flag, outFlags)
			for (let k = 0; k < res.produced; k++) {
				samples.push(out[k] ?? 0)
				flags.push(outFlags[k] ?? 0)
			}
			i += res.consumed
			if (i >= end && res.produced < out.length) break
		}
	}
	return { samples, flags }
}

/** Least-squares amplitude of a tone at `f` cycles per sample, and the residual RMS. */
export function fitTone(
	y: readonly number[],
	from: number,
	to: number,
	f: number,
): { amplitude: number; residualRms: number; rms: number } {
	let cc = 0
	let ss = 0
	let cs = 0
	let yc = 0
	let ys = 0
	let yy = 0
	for (let n = from; n < to; n++) {
		const c = Math.cos(2 * Math.PI * f * n)
		const s = Math.sin(2 * Math.PI * f * n)
		const v = y[n] ?? 0
		cc += c * c
		ss += s * s
		cs += c * s
		yc += v * c
		ys += v * s
		yy += v * v
	}
	const det = cc * ss - cs * cs
	const a = (yc * ss - ys * cs) / det
	const b = (ys * cc - yc * cs) / det
	let r = 0
	for (let n = from; n < to; n++) {
		const v =
			(y[n] ?? 0) -
			a * Math.cos(2 * Math.PI * f * n) -
			b * Math.sin(2 * Math.PI * f * n)
		r += v * v
	}
	const len = to - from
	return {
		amplitude: Math.hypot(a, b),
		residualRms: Math.sqrt(r / len),
		rms: Math.sqrt(yy / len),
	}
}

/** Deterministic pseudo-random generator for fixtures. */
export function lcg(seed: number): () => number {
	let s = seed >>> 0 || 1
	return () => {
		s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0
		return s / 4_294_967_296
	}
}
