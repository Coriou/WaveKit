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
 * - NXDN48: the NXDN receive filter, root raised cosine 0.2 times sin x / x
 *   at 2400 symbols/s. NXDN transmitters add x / sin x, whose intersymbol
 *   interference a plain low-pass leaves: without this filter dsd-fme decoded
 *   almost no standard-shaped NXDN48 frame at any CNR.
 * - NXDN96 (nxdn): none yet. The synthetic NXDN96 transmission decoded on
 *   the host's dsd-fme build only with a roll-off of 0.5, which the 3 kHz
 *   low-pass cuts, so no filter is measured for it.
 * - dPMR (2400 symbols/s): the same kind of low-pass, flat to 1.05 kHz and
 *   stopped from 1.55 kHz. Its matched root raised cosine 0.2 (ETSI TS 102
 *   490) did as well without carrier error but lost 72 % of control channels
 *   at 30 dB CNR with a 600 Hz error (19 % unfiltered), measured.
 * - ProVoice: none (9600 bit/s two-level FSK, wider than these filters).
 *   P25 phase 2 (6000 symbols/s) is wider than the low-pass too; dsd-fme's
 *   auto mode searches for it at the 4800 symbols/s timing and switches only
 *   on a trunking grant, so it is not measured here.
 *
 * tests/integration/dsd-fme-margin.test.ts measures each per protocol and
 * CNR. It runs as an effect in the sox WAV wrapper the pipeline already has.
 * sox runs effects before its rate conversion, so FIR taps are designed at
 * the sox input rate (sox's own `sinc` designs itself at that rate).
 * Formulas: the textbook raised-cosine family (e.g. Proakis, Digital
 * Communications, 9.2), as an inverse Fourier integral.
 */
import type { DsdFmeMode } from "./dsd-fme.js"

/** Roll-off of the NXDN filter. */
export const RECEIVE_FILTER_ROLL_OFF = 0.2
/** FIR span +-8 symbols: the 0.2 tails are below 1 % of the peak there. */
export const RECEIVE_FILTER_SPAN_SYMBOLS = 8
/** The 4800 symbols/s low-pass: sox `sinc`, -6 dB at 3 kHz, 1 kHz wide edge. */
export const RECEIVE_LOWPASS_EFFECT = "sinc -t 1000 -3000"
/** The dPMR low-pass: -6 dB at 1.3 kHz, 500 Hz wide edge. */
export const RECEIVE_LOWPASS_2400_EFFECT = "sinc -t 500 -1300"

export type ReceiveFilterPlan =
	| { kind: "lowpass"; effect: string }
	| { kind: "rrc"; symbolRate: number; sinc: boolean }

/** The filter for a mode, or undefined (NXDN96, ProVoice). */
export function receiveFilterPlan(
	mode: DsdFmeMode,
): ReceiveFilterPlan | undefined {
	switch (mode) {
		case "auto":
		case "dmr":
		case "p25":
		case "ysf":
		case "dstar":
			return { kind: "lowpass", effect: RECEIVE_LOWPASS_EFFECT }
		case "nxdn48":
			return { kind: "rrc", symbolRate: 2400, sinc: true }
		case "dpmr":
			return { kind: "lowpass", effect: RECEIVE_LOWPASS_2400_EFFECT }
		case "nxdn":
		case "provoice":
			return undefined
	}
}

/** Root raised cosine h(t), t in symbols, roll-off `alpha` (closed form). */
export function rootRaisedCosine(t: number, alpha: number): number {
	if (Math.abs(t) < 1e-12) return 1 - alpha + (4 * alpha) / Math.PI
	if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-9)
		return (
			(alpha / Math.SQRT2) *
			((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) +
				(1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)))
		)
	const num =
		Math.sin(Math.PI * t * (1 - alpha)) +
		4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha))
	return num / (Math.PI * t * (1 - (4 * alpha * t) ** 2))
}

/**
 * Receive impulse response h(t), t in symbols: the root raised cosine, or
 * with `sinc` the root raised cosine times sin x / x in frequency, which in
 * time is its mean over one symbol around t (integrate and dump; Simpson,
 * `steps` even, within about 1e-8 at 32).
 */
export function receiveImpulse(
	t: number,
	alpha: number,
	sinc: boolean,
	steps = 32,
): number {
	if (!sinc) return rootRaisedCosine(t, alpha)
	const h = 1 / steps
	let sum = 0
	for (let i = 0; i <= steps; i++) {
		const w = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2
		sum += w * rootRaisedCosine(t - 0.5 + i * h, alpha)
	}
	return (sum * h) / 3
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
	// Even response: compute one side only.
	const side: number[] = []
	for (let n = 0; n <= half; n++)
		side.push(receiveImpulse(n / sps, alpha, sinc))
	const taps = [...side.slice(1).reverse(), ...side]
	const sum = taps.reduce((a, b) => a + b, 0)
	return taps.map(t => t / sum)
}

/**
 * Effects already built, by mode and sox input rate: a decoder rebuilds its
 * command on every start and scanner probes start often, so the FIR design
 * runs once per mode and rate. A decoder sees one or two rates; the cache is
 * cleared past EFFECTS_MAX entries.
 */
const effects = new Map<string, string>()
const EFFECTS_MAX = 32

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
	if (plan.kind === "lowpass") return plan.effect
	const key = `${mode}|${rateHz}`
	const cached = effects.get(key)
	if (cached !== undefined) return cached
	const taps = receiveFilterTaps(plan.symbolRate, rateHz, { sinc: plan.sinc })
	const effect = `fir ${taps.map(t => t.toFixed(7)).join(" ")}`
	if (effects.size >= EFFECTS_MAX) effects.clear()
	effects.set(key, effect)
	return effect
}
