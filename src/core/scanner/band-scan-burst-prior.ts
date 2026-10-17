import type { Bandplan } from "./bandplan/index.js"
import type { ScannerProtocol, ScanRange } from "./types.js"

type Priors = Partial<Record<ScannerProtocol, number>>

/**
 * WG11 req 1.4: the ISM prior of the live classifier context at a sweep's dwell decision.
 *
 * `classifySpectral` calls a track of at most 4 blocks an ISM burst (`ook-burst`, no probe mode)
 * unless the `ism` prior is below 1. A sweep decides at the end of its dwell, 3 blocks after the
 * settle at the defaults, so every track it can probe is that young. A sweep whose ranges list no
 * protocols at the frequency (an operator range no built-in plan encloses, such as 135-174 MHz)
 * and that names no protocols left `ism` unset (= 1): every land-mobile track of such a sweep was
 * an ISM burst and was never probed.
 *
 * Only then, and only when a covering job is a sweep (`sweep`), does the band plan's `ism` prior
 * at the frequency (the priors identify uses) fill it. A context with no sweep covering the
 * frequency (passive, in-window, identify, nothing) keeps today's priors, so an OOK burst there
 * stays `ook-burst` whatever the region's plans list. Every other prior and every job-set prior
 * is unchanged, and so is the result when the band plan says nothing there. `ism` is read by the
 * burst rule and the `ook-burst` hypotheses only, so no other class or hypothesis score changes.
 */
export function withBandBurstPrior(
	ctx: {
		readonly priors: Priors
		/** The job's effective protocols at the frequency (empty: every protocol). */
		readonly protocols: readonly ScannerProtocol[]
		/** True when an enabled job range at the frequency lists protocols. */
		readonly rangesListProtocols: boolean
		/** True when a sweep job covers the frequency (the dwell decision is a sweep's). */
		readonly sweep: boolean
	},
	bandPriorsAt: () => Priors,
): Priors {
	if (
		!ctx.sweep ||
		ctx.rangesListProtocols ||
		ctx.protocols.length > 0 ||
		ctx.priors.ism !== undefined
	)
		return ctx.priors
	const ism = bandPriorsAt().ism
	if (ism === undefined || !Number.isFinite(ism) || ism < 0) return ctx.priors
	return { ...ctx.priors, ism }
}

/**
 * WG11 req 1.4 (review m3): the band-plan ranges for the fill, computed once per plan set. The
 * plan stack hands out a fresh array per read (`bandplansFor` filters the built-ins), so the cache
 * keys on the plans' identities: O(plans) reference compares per call, no allocation, and the
 * ranges are rebuilt only when a plan object is added, removed or replaced. Ranges listing no
 * protocols are dropped: `priorsFor` ignores them, so its answer is the same.
 */
export function createBandRangeCache(): (
	plans: readonly Bandplan[],
) => ScanRange[] {
	let key: readonly Bandplan[] = []
	let ranges: ScanRange[] = []
	let filled = false
	return plans => {
		if (
			filled &&
			plans.length === key.length &&
			plans.every((p, i) => p === key[i])
		)
			return ranges
		key = [...plans]
		ranges = plans
			.flatMap(b => b.ranges)
			.filter(r => (r.protocols ?? []).length > 0)
		filled = true
		return ranges
	}
}
