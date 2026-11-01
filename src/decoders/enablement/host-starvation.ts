import type { DecoderLossCause } from "@wavekit/api-types"
import type { ChargedDrop } from "./contract.js"
import { EFFICIENCY_DROP_WINDOW_MS } from "./contract.js"

/**
 * Loss attribution for the tuned decoder: whose loss a drop on its branch was.
 *
 * A drop is host loss (the process or host is starved, so every consumer
 * suffers) when, within HOST_STARVATION_WINDOW_MS either side of it:
 * - a sample was attributed `host` (event-loop delay max >= HOST_LOOP_DELAY_MS,
 *   50 ms, or host CPU at the guard; see attribution.ts), or
 * - at least HOST_STARVATION_BRANCHES_MIN distinct fanout branches dropped
 *   (several consumers, live audio included, congested together).
 * Otherwise it is the decoder's own loss: its branch congested while the other
 * branches of its source flowed. Loss charged to the source as a whole (no
 * holder known) is not host evidence by itself: on a healthy host it says
 * nothing about whose consumer was slow, and the gate already treats it as
 * loss elsewhere for the tuned decoder.
 *
 * The window is the late-drop window, 10 000 ms = 5 efficiency samples of
 * 2 000 ms, so congestion split across adjacent samples (one branch in one
 * sample, a sibling in the next) still reads as one host episode. Only the
 * drop history the efficiency monitor already keeps is read: no hot-path cost.
 */
export const HOST_STARVATION_WINDOW_MS = EFFICIENCY_DROP_WINDOW_MS
/** Two branches congested together are no single slow consumer. */
export const HOST_STARVATION_BRANCHES_MIN = 2

/** The attribution of loss as the logs and status report it (safe fields only). */
export interface LossAttribution {
	cause: DecoderLossCause
	/** Distinct fanout branches that dropped in the window. */
	congestedBranches: number
	/** Latest event-loop delay p99 and max (ms); null when unmeasured. */
	loopLagP99Ms: number | null
	loopLagMaxMs: number | null
}

const near = (d: ChargedDrop, at: number) =>
	Math.abs(d.atMono - at) <= HOST_STARVATION_WINDOW_MS

/** Distinct branches charged in `drops`; `"source"` counts as none. */
function branchCount(drops: readonly ChargedDrop[]): number {
	const branches = new Set<string>()
	for (const d of drops)
		if (d.branches !== "source") for (const b of d.branches) branches.add(b)
	return branches.size
}

/** Whether the drops around `at` show host or process starvation. */
export function hostStarvedAt(
	drops: readonly ChargedDrop[],
	at: number,
): boolean {
	const around = drops.filter(d => near(d, at))
	return (
		around.some(d => d.code === "host") ||
		branchCount(around) >= HOST_STARVATION_BRANCHES_MIN
	)
}

/**
 * Whether one drop in `drops` is explained by host starvation (see above).
 * `drops` should span HOST_STARVATION_WINDOW_MS either side of it.
 */
export function hostExplained(
	drops: readonly ChargedDrop[],
	d: ChargedDrop,
): boolean {
	return hostStarvedAt(drops, d.atMono)
}

/**
 * Whether a placement reading `branch` lost samples of its own within
 * [from, to]: a drop charged to its branch that host starvation does not
 * explain. Without a branch, any branch drop host starvation does not explain.
 *
 * `sampledAt` (the latest sample) settles drops: with it, a drop is judged
 * only once that sample is at least HOST_STARVATION_WINDOW_MS after it, so a
 * sibling's congestion in the samples just after it is known (10 000 ms = 5
 * samples later, inclusive). The late-drop path of a graduated decoder passes
 * it: that shed already needs sustained windows, so waiting costs nothing.
 * Probation does not: a newcomer's drop on its own branch while its siblings
 * flowed and the host was healthy is its own loss at once (the evidence known
 * then; a sibling or host sample already in the window still explains it).
 */
export function ownLoss(
	drops: readonly ChargedDrop[],
	branch: string | undefined,
	from: number,
	to: number,
	sampledAt = Infinity,
): boolean {
	return drops.some(
		d =>
			d.atMono >= from &&
			d.atMono <= to &&
			d.atMono + HOST_STARVATION_WINDOW_MS <= sampledAt &&
			d.branches !== "source" &&
			(branch === undefined || d.branches.includes(branch)) &&
			!hostExplained(drops, d),
	)
}

/**
 * The cause of the loss in the window ending at `at`: host when it shows host
 * starvation, decoder when some drop in it does not, null without drops.
 */
export function lossCause(
	drops: readonly ChargedDrop[],
	at: number,
): { cause: DecoderLossCause; congestedBranches: number } | null {
	const recent = drops.filter(
		d => d.atMono <= at && at - d.atMono <= HOST_STARVATION_WINDOW_MS,
	)
	if (recent.length === 0) return null
	return {
		cause: hostStarvedAt(recent, at) ? "host" : "decoder",
		congestedBranches: branchCount(recent),
	}
}
