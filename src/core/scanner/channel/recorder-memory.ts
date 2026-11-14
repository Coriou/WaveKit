/**
 * The analog recorder's (WidebandAnalogRecorder) small pure helpers: its bounded remembered sets,
 * the keys it groups by, and the end of the trusted run a session started in. Nothing here holds
 * state of its own.
 */
import type { RecordingBinding } from "../store/recording-operation.js"
import type { WidebandEngineView } from "./wideband-analog-recorder.js"

/** Observations remembered as refused, and as retried once, per manager. */
export const MAX_REMEMBERED = 1024

/**
 * The first sample past the trusted run a session started in (`from`, its trustedFromSample),
 * within the current epoch: the end of the newest ended run when that run is the session's, the
 * start of a later ended run when the session's own end is no longer named (it ended before
 * that one, so no later than its start), and in any case no later than the current run's start
 * when that is past `from`. +Infinity: no bound known (a view without runs, or the run goes on).
 * A doubt shorter than one drain, re-proven before the recorder saw it, still ends the file at
 * the doubt instead of at the drain's read position.
 */
export function trustedRunEnd(
	epoch: ReturnType<WidebandEngineView["currentEpoch"]>,
	from: number | null | undefined,
): number {
	if (typeof from !== "number") return Number.POSITIVE_INFINITY
	let end = Number.POSITIVE_INFINITY
	const r = epoch.runEnd
	if (r)
		end =
			r.from === from
				? r.end
				: r.from > from
					? r.from
					: Number.POSITIVE_INFINITY
	const current = epoch.trustedFromSample
	if (typeof current === "number" && current > from)
		end = Math.min(end, current)
	return end
}

/**
 * Grants `id` a waiver with its class provenance (`toneOnly`) in one bounded map: a grant is the
 * newest entry, and past `limit` (MAX_REMEMBERED) the oldest waiver goes with its provenance.
 */
export function rememberWaiver(
	map: Map<string, boolean>,
	id: string,
	toneOnly: boolean,
	limit = MAX_REMEMBERED,
): void {
	map.delete(id)
	map.set(id, toneOnly)
	if (map.size > limit) {
		const oldest = map.keys().next()
		if (oldest.done !== true) map.delete(oldest.value)
	}
}

/** Adds `id` to a bounded remembered set (the oldest entry goes past MAX_REMEMBERED). */
export function remember(set: Set<string>, id: string): void {
	set.add(id)
	if (set.size > MAX_REMEMBERED) {
		const oldest = set.values().next()
		if (oldest.done !== true) set.delete(oldest.value)
	}
}

/** One exact binding's key (its entries, sorted by name). */
export function bindingKey(binding: RecordingBinding): string {
	return JSON.stringify(
		Object.entries(binding).sort(([a], [b]) => (a < b ? -1 : 1)),
	)
}

/** A visit of a channel: the engine stream and epoch (a retune or stream change is a new one). */
export function visitKey(at: {
	readonly stream: number
	readonly epoch: number
}): string {
	return `${at.stream}:${at.epoch}`
}
