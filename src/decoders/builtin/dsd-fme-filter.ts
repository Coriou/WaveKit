/**
 * Receive filter for dsd-fme's 4FSK input, on the FM discriminator output.
 *
 * dsd-fme decides each symbol from the mean of a few samples around its
 * centre and filters its input only after a DMR, YSF, NXDN or dPMR sync, with
 * filters wider than the signal (dsd_symbol.c, dsd_filters.c). The FM
 * discriminator's noise power density rises with the square of the frequency
 * up to the channel edge, so most of the noise at that decision lies above
 * the 4FSK band. Removing it is most of the gain. Per mode:
 *
 * - 4800 symbols/s (auto, dmr, p25, ysf, dstar): a linear-phase low-pass,
 *   flat to 2.5 kHz and stopped from 3.5 kHz (sox `sinc`). It passes the
 *   pulse of every transmit filter in use (P25 raised cosine 0.2 with or
 *   without x / sin x, DMR and YSF root raised cosine 0.2, D-STAR GMSK)
 *   nearly unchanged. A matched root raised cosine cuts more noise, but its
 *   narrower pulse made dsd-fme lose YSF frame sync on strong signals (2.5 to
 *   11 % of frames at 30 to 40 dB CNR, measured), so auto does not use it.
 * - NXDN (nxdn48, nxdn): the NXDN receive filter, root raised cosine 0.2
 *   times sin x / x at the symbol rate. NXDN transmitters add x / sin x, whose
 *   intersymbol interference a plain low-pass leaves: without this filter
 *   dsd-fme decoded almost no standard-shaped NXDN48 frame at any CNR.
 * - dPMR: the root raised cosine 0.2 (ETSI TS 102 490) at 2400 symbols/s.
 * - ProVoice: none (9600 bit/s two-level FSK, wider than these filters).
 *
 * tests/integration/dsd-fme-margin.test.ts measures each per protocol and
 * CNR. It runs as an effect in the sox WAV wrapper the pipeline already has.
 * sox runs effects before its rate conversion, so FIR taps are designed at
 * the sox input rate (sox's own `sinc` designs itself at that rate).
 * Formulas: the textbook raised-cosine family (e.g. Proakis, Digital
 * Communications, 9.2), as an inverse Fourier integral.
 */
import type { DsdFmeMode } from "./dsd-fme.js"

/** Roll-off of the NXDN and dPMR filters. */
export const RECEIVE_FILTER_ROLL_OFF = 0.2
/** FIR span +-8 symbols: the 0.2 tails are below 1 % of the peak there. */
export const RECEIVE_FILTER_SPAN_SYMBOLS = 8
/** The 4800 symbols/s low-pass: sox `sinc`, -6 dB at 3 kHz, 1 kHz wide edge. */
export const RECEIVE_LOWPASS_EFFECT = "sinc -t 1000 -3000"

export type ReceiveFilterPlan =
	| { kind: "lowpass" }
	| { kind: "rrc"; symbolRate: number; sinc: boolean }

/** The filter for a mode, or undefined (ProVoice). */
export function receiveFilterPlan(
	mode: DsdFmeMode,
): ReceiveFilterPlan | undefined {
	switch (mode) {
		case "auto":
		case "dmr":
		case "p25":
		case "ysf":
		case "dstar":
			return { kind: "lowpass" }
		case "nxdn":
			return { kind: "rrc", symbolRate: 4800, sinc: true }
		case "nxdn48":
			return { kind: "rrc", symbolRate: 2400, sinc: true }
		case "dpmr":
			return { kind: "rrc", symbolRate: 2400, sinc: false }
		case "provoice":
			return undefined
	}
}

/**
 * One-sided receive spectrum at x = f / symbol rate: the root of the raised
 * cosine of roll-off `alpha`, times sin(pi x) / (pi x) when `sinc`.
 */
export function receiveSpectrum(
	x: number,
	alpha: number,
	sinc: boolean,
): number {
	const a = Math.abs(x)
	const lo = (1 - alpha) / 2
	const hi = (1 + alpha) / 2
	let rc = 0
	if (a <= lo) rc = 1
	else if (a <= hi) rc = 0.5 * (1 + Math.cos((Math.PI / alpha) * (a - lo)))
	const v = Math.sqrt(rc)
	return sinc && a > 1e-12 ? (v * Math.sin(Math.PI * a)) / (Math.PI * a) : v
}

/**
 * Impulse response h(t), t in symbols: 2 * integral over [0, (1 + alpha) / 2]
 * of the spectrum times cos(2 pi x t) (Simpson, 600 steps; exact to about
 * 1e-9 for these smooth spectra).
 */
export function receiveImpulse(
	t: number,
	alpha: number,
	sinc: boolean,
	steps = 600,
): number {
	const top = (1 + alpha) / 2
	const h = top / steps
	let sum = 0
	for (let i = 0; i <= steps; i++) {
		const w = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2
		sum +=
			w *
			receiveSpectrum(i * h, alpha, sinc) *
			Math.cos(2 * Math.PI * i * h * t)
	}
	return (2 * sum * h) / 3
}

/**
 * FIR taps at `rateHz`, symmetric, unit DC gain (dsd-fme measures levels per
 * frame from the sync). 2 * floor(span * rate / symbolRate) + 1 taps: 321 at
 * 2400 symbols/s and 48 kHz.
 */
export function receiveFilterTaps(
	symbolRate: number,
	rateHz: number,
	{
		alpha = RECEIVE_FILTER_ROLL_OFF,
		sinc = false,
		span = RECEIVE_FILTER_SPAN_SYMBOLS,
	}: { alpha?: number; sinc?: boolean; span?: number } = {},
): number[] {
	const sps = rateHz / symbolRate
	const half = Math.floor(span * sps)
	const taps: number[] = []
	for (let n = -half; n <= half; n++)
		taps.push(receiveImpulse(n / sps, alpha, sinc))
	const sum = taps.reduce((a, b) => a + b, 0)
	return taps.map(t => t / sum)
}

/**
 * The sox effect for a mode at the sox input rate `rateHz`, or undefined.
 * FIR taps with seven decimals: about 1e-6 of the largest tap, far below
 * 16-bit audio.
 */
export function receiveFilterEffect(
	mode: DsdFmeMode,
	rateHz: number,
): string | undefined {
	const plan = receiveFilterPlan(mode)
	if (plan === undefined) return undefined
	if (plan.kind === "lowpass") return RECEIVE_LOWPASS_EFFECT
	return `fir ${receiveFilterTaps(plan.symbolRate, rateHz, { sinc: plan.sinc })
		.map(t => t.toFixed(7))
		.join(" ")}`
}
