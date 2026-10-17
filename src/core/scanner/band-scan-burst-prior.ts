import type { Bandplan } from "./bandplan/index.js"
import type { ScannerProtocol, ScanRange } from "./types.js"

type Priors = Partial<Record<ScannerProtocol, number>>

/**
 * WG11 req 1.4 (review round 2): licence-exempt allocations where OOK/ASK short-range devices
 * (remotes, sensors, the rtl_433 corpus) transmit in some region. Inside one the fill never
 * applies, whatever the region's plans list, so a young OOK burst stays `ook-burst` (the region
 * filter alone missed 433.92 MHz in the US, where only land-mobile and amateur plans cover it).
 * Bounds inclusive, like `priorsFor`. Sources:
 * - 314-316 MHz: US/CA 47 CFR 15.231 periodic remotes at 315 MHz (no built-in plan).
 * - 433.05-434.79 MHz: ITU-R RR 5.138 ISM band, ERC/REC 70-03 annex 1; equals the built-in
 *   `ism-433` plan (bandplan/builtin.ts).
 * - 863-870 MHz: ERC/REC 70-03 SRD band; equals the built-in `ism-868` plan.
 * - 902-928 MHz: ITU-R RR 5.150 region 2 ISM band, 47 CFR 15.247/15.249 (no built-in plan).
 * Frozen: changing it changes sweep classification.
 */
export const OOK_SRD_ALLOCATIONS_HZ: readonly (readonly [number, number])[] =
	Object.freeze([
		Object.freeze([314_000_000, 316_000_000] as const),
		Object.freeze([433_050_000, 434_790_000] as const),
		Object.freeze([863_000_000, 870_000_000] as const),
		Object.freeze([902_000_000, 928_000_000] as const),
	])

/** True when `hz` lies inside an OOK/ASK short-range-device allocation (bounds inclusive). */
export function inOokSrdAllocation(hz: number): boolean {
	for (const [lo, hi] of OOK_SRD_ALLOCATIONS_HZ)
		if (hz >= lo && hz <= hi) return true
	return false
}

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
 * is unchanged, and so is the result when the band plan says nothing there or the frequency is in
 * an OOK short-range-device allocation (OOK_SRD_ALLOCATIONS_HZ). `ism` is read by the
 * burst rule and the `ook-burst` hypotheses only, so no other class or hypothesis score changes.
 */
export function withBandBurstPrior(
	ctx: {
		/** The track's centre frequency. */
		readonly hz: number
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
		ctx.priors.ism !== undefined ||
		inOokSrdAllocation(ctx.hz)
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
