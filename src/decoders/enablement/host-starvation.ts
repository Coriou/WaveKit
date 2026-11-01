import type { DecoderLossCause } from "@wavekit/api-types"
import type { ChargedDrop } from "./contract.js"
import { EFFICIENCY_DROP_WINDOW_MS, EFFICIENCY_SAMPLE_MS } from "./contract.js"

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
 * Probation judges with probationLoss (below).
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
 * Adjacent samples: two drops this close are one sustained run. One sample
 * period plus one for a late sample, 4000 ms.
 */
export const SUSTAINED_DROP_GAP_MS = 2 * EFFICIENCY_SAMPLE_MS

/**
 * A probationer's own loss within [from, to] (see ownLoss), judged on the
 * evidence known at `sampledAt`, the latest sample: "own" once a drop on its
 * branch that host starvation does not explain is settled (HOST_STARVATION_
 * WINDOW_MS, 10 000 ms, after it, so a sibling's congestion in the samples
 * just after it is known), or at once when its branch drops in two adjacent
 * samples (within SUSTAINED_DROP_GAP_MS) while every sibling flowed and the
 * host stayed healthy: sustained loss of its own. "pending" while such a
 * drop is neither, so graduation waits for it; null without one.
 *
 * One sample cannot tell its own loss from a host episode that reaches a
 * sibling in the next sample: a lone drop always waits for its window.
 */
export function probationLoss(
	drops: readonly ChargedDrop[],
	branch: string | undefined,
	from: number,
	to: number,
	sampledAt: number,
): "own" | "pending" | null {
	const own = drops
		.filter(
			d =>
				d.atMono >= from &&
				d.atMono <= to &&
				d.branches !== "source" &&
				(branch === undefined || d.branches.includes(branch)) &&
				!hostExplained(drops, d),
		)
		.map(d => d.atMono)
		.sort((a, b) => a - b)
	if (own.length === 0) return null
	if (own[0]! + HOST_STARVATION_WINDOW_MS <= sampledAt) return "own"
	for (let i = 1; i < own.length; i++) {
		const gap = own[i]! - own[i - 1]!
		if (gap > 0 && gap <= SUSTAINED_DROP_GAP_MS) return "own"
	}
	return "pending"
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

/**
 * How long CPU over the guard alone may excuse a tuned probationer's own
 * loss: 3 attribution windows, 3 × 10 000 ms = 30 000 ms. Host CPU within a
 * drop's window explains it (hostExplained), and each CPU sample restarts
 * probation, so intermittent spikes (one every 10 000 ms) could otherwise
 * excuse a branch dropping on every other sample forever. Sibling-branch
 * drops and `host` samples (loop lag) are real host episodes: never bounded.
 */
export const CPU_ONLY_EXCUSE_MS = 3 * HOST_STARVATION_WINDOW_MS

/**
 * The run of drops on `branch` open at `limit`: drops in [from, limit] that no
 * sibling-branch drop or `host` sample explains (hostExplained over `drops`,
 * which carry no CPU evidence), each within HOST_STARVATION_WINDOW_MS of the
 * previous. A drop real host evidence explains, or a gap longer than one
 * window (10 000 ms) up to `limit`, ends a run. Null without an open run.
 */
function openRun(
	drops: readonly ChargedDrop[],
	branch: string,
	from: number,
	limit: number,
): { start: number; last: number } | null {
	const mine = drops
		.filter(
			d =>
				d.atMono >= from &&
				d.atMono <= limit &&
				d.branches !== "source" &&
				d.branches.includes(branch),
		)
		.sort((a, b) => a.atMono - b.atMono)
	let run: { start: number; last: number } | null = null
	for (const d of mine) {
		if (hostExplained(drops, d)) run = null
		else if (run === null || d.atMono - run.last > HOST_STARVATION_WINDOW_MS)
			run = { start: d.atMono, last: d.atMono }
		else run.last = d.atMono
	}
	return run !== null && limit - run.last <= HOST_STARVATION_WINDOW_MS
		? run
		: null
}

/**
 * A tuned probationer's own-branch run that only host CPU could excuse (see
 * openRun), judged at `sampledAt`, the latest sample. `start` is the first
 * drop of the run open at min(to, sampledAt), settled or not: a CPU probation
 * reset carries it. `own` once that excuse is spent: the run's first drop is
 * CPU_ONLY_EXCUSE_MS (30 000 ms) before `sampledAt`, the run is still open
 * there, and its settled part (drops HOST_STARVATION_WINDOW_MS old, so
 * siblings in the samples after each are known) is the same run and still
 * drops at that horizon (latest drop within SUSTAINED_DROP_GAP_MS, 4000 ms:
 * one CPU sample between): 30 000 - 10 000 = 20 000 ms of settled own loss
 * plus one window settling. A branch dropping on every sample but the CPU
 * ones is its own loss 30 000 ms after its first drop; a run that stopped
 * (no own drop in the latest 10 000 ms) is never judged by this bound.
 */
export function cpuOnlyLoss(
	drops: readonly ChargedDrop[],
	branch: string,
	from: number,
	to: number,
	sampledAt: number,
): { start: number | null; own: boolean } {
	const open = openRun(drops, branch, from, Math.min(to, sampledAt))
	const horizon = Math.min(to, sampledAt - HOST_STARVATION_WINDOW_MS)
	const settled = openRun(drops, branch, from, horizon)
	return {
		start: open?.start ?? null,
		own:
			settled !== null &&
			open?.start === settled.start &&
			sampledAt - settled.start >= CPU_ONLY_EXCUSE_MS &&
			horizon - settled.last <= SUSTAINED_DROP_GAP_MS,
	}
}
