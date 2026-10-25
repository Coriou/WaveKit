/**
 * Synthetic OOK PWM remote frames as cu8 IQ, for rtl_433 end-to-end tests.
 *
 * The frame is a 24-bit PT2262-style code word sent six times: each bit is a
 * 1T/3T (0) or 3T/1T (1) on/off pair with T = 350 us, each word ends in a 1T
 * sync pulse and a 31T gap. Code 0x555555 is one rtl_433 25.12 decodes with
 * its default protocols (model "Waveman-Switch", id "P", channel 4,
 * button 4, state "OFF").
 */
import { gaussian, mulberry32 } from "./scanner/signals.js"

export const OOK_PWM_CODE = 0x555555
export const OOK_PWM_T_S = 350e-6
const REPEATS = 6

/** On/off segments in seconds from the frame start. */
function segments(code: number): [number, number][] {
	const T = OOK_PWM_T_S
	const out: [number, number][] = []
	let t = 0
	const pulse = (on: number, off: number) => {
		out.push([t, t + on])
		t += on + off
	}
	for (let r = 0; r < REPEATS; r++) {
		pulse(T, 31 * T)
		for (let b = 23; b >= 0; b--)
			if ((code >> b) & 1) pulse(3 * T, T)
			else pulse(T, 3 * T)
	}
	pulse(T, 31 * T)
	return out
}

/** Frame length in seconds, last gap included. */
export function ookPwmFrameSeconds(code = OOK_PWM_CODE): number {
	const segs = segments(code)
	return (segs.at(-1)?.[1] ?? 0) + 31 * OOK_PWM_T_S
}

/**
 * cu8 IQ at `fs` with `leadS` of noise, one frame of a carrier at
 * `offsetHz` from the capture centre (complex amplitude `amp`, full scale 1)
 * and `tailS` of noise. Noise is complex Gaussian with RMS `noise` per
 * component; values are rounded around 127.5 and clamped to 0..255.
 */
export function ookPwmCu8(opts: {
	fs: number
	offsetHz: number
	amp: number
	noise: number
	leadS: number
	tailS: number
	seed: number
	code?: number
}): Buffer {
	const rng = mulberry32(opts.seed)
	const segs = segments(opts.code ?? OOK_PWM_CODE).map(
		([a, b]) => [a + opts.leadS, b + opts.leadS] as const,
	)
	const total =
		opts.leadS + ookPwmFrameSeconds(opts.code ?? OOK_PWM_CODE) + opts.tailS
	const n = Math.floor(total * opts.fs)
	const out = Buffer.alloc(2 * n)
	const w = (2 * Math.PI * opts.offsetHz) / opts.fs
	let s = 0
	for (let i = 0; i < n; i++) {
		const t = i / opts.fs
		while (s < segs.length && t >= segs[s]![1]) s++
		const on = s < segs.length && t >= segs[s]![0]
		const a = on ? opts.amp : 0
		const re = a * Math.cos(w * i) + opts.noise * gaussian(rng)
		const im = a * Math.sin(w * i) + opts.noise * gaussian(rng)
		out[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * re)))
		out[2 * i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * im)))
	}
	return out
}
