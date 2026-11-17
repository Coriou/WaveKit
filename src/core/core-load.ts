import type { CoreLoadReading } from "@wavekit/api-types"
import { LINK_GAP_MS } from "./link-burst/contract.js"
import type { EventLoopMeter, TakeUtilization } from "./link-burst/contract.js"

export type { CoreLoadReading }

/**
 * THE core load signal's reading as the core reads it: the shared reading plus the per-take
 * utilisation of the same meter (`EventLoopMeter.utilizationMaxSince`, see `TakeUtilization`).
 * The window mean `elu` dilutes a stressed 2 s take with the healthy time around it; the worst
 * take does not, so one saturated take in the window shows. Not on the wire.
 */
export interface CoreLoadEvidence extends CoreLoadReading {
	/** Worst take's utilisation (0..1) over the window and its guard take; null without a take. */
	eluMax: number | null
	/** Every take over the window and its guard take was read (`TakeUtilization.complete`). */
	eluComplete: boolean
	/** Utilisation of the in-progress take, when at least 500 ms long; else null. */
	eluLive: number | null
}

/**
 * Event-loop utilisation at or above this over a window means the core itself is saturated:
 * at 90 % busy the loop is idle about 1 s in 10, so socket reads queue behind other work and a
 * shortfall is the core's, whatever the link does.
 */
export const CORE_BUSY_ELU = 0.9
/**
 * A worst loop delay at or above this over a window means the core stalled long enough to lose
 * bytes: a `LINK_GAP_MS` (200 ms) stall at 2.4 MS/s U8 IQ is 2.4e6 * 2 B * 0.2 s = 960 kB, more
 * than typical kernel socket receive buffers hold.
 */
export const CORE_BUSY_LOOP_DELAY_MS = LINK_GAP_MS
/**
 * Below this utilisation (with loop delay under `HOST_LOOP_DELAY_MS`) the core had headroom to
 * read every byte offered: 30 % idle is roughly 3 s free per 10 s window. Between this and
 * `CORE_BUSY_ELU` the evidence is ambiguous. A stall under `HOST_LOOP_DELAY_MS` (50 ms, 240 kB
 * at 2.4 MS/s U8 IQ) fits the socket buffers and cannot lose bytes.
 */
export const SOURCE_ELU_MAX = 0.7

/** THE core main-thread load signal (see `CoreLoadReading`); one per process. */
export interface CoreLoadSignal {
	/** Load over the window from `sinceMono` (the link-burst monotonic clock) to now. */
	read(sinceMono: number): CoreLoadEvidence
}

function usable(value: number | null): number | null {
	return value !== null && Number.isFinite(value) && value >= 0 ? value : null
}

/** The signal over the process's one event-loop meter; an unreadable meter reads nulls. */
export function createCoreLoadSignal(deps: {
	loopMeter: Pick<
		EventLoopMeter,
		"utilizationSince" | "utilizationMaxSince" | "maxSince"
	>
}): CoreLoadSignal {
	const { loopMeter } = deps
	const safe = (read: () => number | null): number | null => {
		try {
			return usable(read())
		} catch {
			return null
		}
	}
	const fraction = (read: () => number | null): number | null => {
		const value = safe(read)
		return value !== null && value <= 1 ? value : null
	}
	return {
		read(sinceMono) {
			let takes: TakeUtilization | null = null
			try {
				takes = loopMeter.utilizationMaxSince(sinceMono)
			} catch {
				/* Per-take utilisation is unavailable. */
			}
			const eluMax = fraction(() => takes?.max ?? null)
			return {
				elu: fraction(() => loopMeter.utilizationSince(sinceMono)),
				eluMax,
				eluComplete: takes?.complete === true && eluMax !== null,
				eluLive: fraction(() => takes?.live ?? null),
				loopDelayMaxMs: safe(() => loopMeter.maxSince(sinceMono)),
			}
		},
	}
}

/**
 * Whether a reading shows the core saturated on its own evidence: utilisation at or above
 * `CORE_BUSY_ELU`, or a worst loop delay at or above `CORE_BUSY_LOOP_DELAY_MS`. Missing evidence
 * is never busy, and either rule stands without the other's input. The link advisor's cause
 * ladder applies the same thresholds to the worst take's utilisation (`eluMax`) and the worst
 * loop delay, each rule likewise standing without the other's input.
 */
export function coreBusy(reading: CoreLoadReading): boolean {
	const elu = usable(reading.elu)
	const loop = usable(reading.loopDelayMaxMs)
	return (
		(elu !== null && elu <= 1 && elu >= CORE_BUSY_ELU) ||
		(loop !== null && loop >= CORE_BUSY_LOOP_DELAY_MS)
	)
}
