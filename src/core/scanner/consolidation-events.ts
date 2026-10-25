/**
 * Band inspection UX req 3.2: WebSocket events for startup consolidation. At most
 * SCANNER_CONSOLIDATION_EVENT_GROUPS_MAX `merged` discovery events per start, each with at most
 * DISCOVERY_MERGED_IDS_MAX `mergedIds` (`mergedTruncated` past that); above the group bound one
 * `discoveries-resync` event instead. Events raised before anyone listens are queued (bounded by
 * the same group cap, or one resync) and flushed when the first listener attaches.
 */
import type { EventEmitter } from "node:events"
import {
	DISCOVERY_MERGED_IDS_MAX,
	SCANNER_CONSOLIDATION_EVENT_GROUPS_MAX,
} from "@wavekit/api-types"
import type {
	Discovery,
	ScannerDiscoveriesResyncEventData,
	ScannerDiscoveryEventData,
} from "@wavekit/api-types"

export interface ConsolidationMerge {
	survivor: string
	mergedIds: readonly string[]
}

/** The `merged` event of one applied group; undefined when the survivor is gone. */
export function mergedEventOf(
	merge: ConsolidationMerge,
	survivor: Discovery | undefined,
): ScannerDiscoveryEventData | undefined {
	if (survivor === undefined) return undefined
	const ids = [...merge.mergedIds]
	const truncated = ids.length > DISCOVERY_MERGED_IDS_MAX
	if (truncated) ids.length = DISCOVERY_MERGED_IDS_MAX
	return {
		change: "merged",
		discovery: survivor,
		mergedIds: ids,
		...(truncated ? { mergedTruncated: true as const } : {}),
	}
}

/** Per-start mode: per-group events when the plan fits the bound, else one resync. */
export function consolidationEventMode(
	plannedGroups: number,
): "merged" | "resync" {
	return plannedGroups > SCANNER_CONSOLIDATION_EVENT_GROUPS_MAX
		? "resync"
		: "merged"
}

export type ConsolidationEvent =
	| { event: "discovery"; data: ScannerDiscoveryEventData }
	| { event: "discoveries-resync"; data: ScannerDiscoveriesResyncEventData }

/** Holds events until a listener exists; bounded (merged events past the cap become one resync). */
export class ConsolidationEventQueue {
	private readonly pending: ConsolidationEvent[] = []
	private merged = 0
	private resync: ScannerDiscoveriesResyncEventData | undefined

	constructor(
		private readonly max: number = SCANNER_CONSOLIDATION_EVENT_GROUPS_MAX,
	) {}

	get size(): number {
		return this.pending.length + (this.resync ? 1 : 0)
	}

	push(e: ConsolidationEvent): void {
		if (e.event === "discoveries-resync") {
			this.resync = {
				reason: "consolidation",
				groups: (this.resync?.groups ?? 0) + e.data.groups,
			}
			return
		}
		if (this.merged >= this.max) {
			// Past the bound: a resync replaces every queued group (and counts them).
			this.resync = {
				reason: "consolidation",
				groups: (this.resync?.groups ?? this.merged) + 1,
			}
			return
		}
		this.merged++
		this.pending.push(e)
	}

	/**
	 * The queued events in order, emptying the queue. A queued resync supersedes every merged
	 * event (clients refetch the whole list), so it is then the only event.
	 */
	drain(): ConsolidationEvent[] {
		const out = this.pending.splice(0)
		const resync = this.resync
		this.resync = undefined
		this.merged = 0
		return resync ? [{ event: "discoveries-resync", data: resync }] : out
	}
}

export interface ConsolidationSliceResult {
	groups: number
	absorbed: number
	merges: readonly ConsolidationMerge[]
}

/**
 * Applies `groups` in slices of `sliceGroups`, yielding between slices. In "merged" mode (the plan
 * has at most SCANNER_CONSOLIDATION_EVENT_GROUPS_MAX groups) one `merged` event per applied group
 * is emitted after its slice; otherwise one resync after the last slice (when any group applied).
 */
export async function applyConsolidationSlices<G>(opts: {
	groups: readonly G[]
	sliceGroups: number
	apply: (slice: readonly G[]) => ConsolidationSliceResult
	survivor: (id: string) => Discovery | undefined
	emit: (e: ConsolidationEvent) => void
	yieldTurn: () => Promise<void>
}): Promise<{ groups: number; absorbed: number }> {
	const { groups, sliceGroups } = opts
	const step = Math.max(1, Math.floor(sliceGroups))
	const mode = consolidationEventMode(groups.length)
	const applied = { groups: 0, absorbed: 0 }
	for (let i = 0; i < groups.length; i += step) {
		const part = opts.apply(groups.slice(i, i + step))
		applied.groups += part.groups
		applied.absorbed += part.absorbed
		if (mode === "merged")
			for (const merge of part.merges) {
				const data = mergedEventOf(merge, opts.survivor(merge.survivor))
				if (data) opts.emit({ event: "discovery", data })
			}
		if (i + step < groups.length) await opts.yieldTurn()
	}
	if (mode === "resync" && applied.groups > 0)
		opts.emit({
			event: "discoveries-resync",
			data: { reason: "consolidation", groups: applied.groups },
		})
	return applied
}

/**
 * Emits `e` on `emitter` when it has a listener for it, else queues it; the first queued event
 * arms a one-shot `newListener` hook that drains the queue on the next turn after a `discovery`
 * or `discoveries-resync` listener attaches (so the whole wiring is attached first).
 */
export function emitWhenListened(
	emitter: EventEmitter,
	queue: ConsolidationEventQueue,
	e: ConsolidationEvent,
): void {
	if (emitter.listenerCount(e.event) > 0) {
		emitter.emit(e.event, e.data)
		return
	}
	const first = queue.size === 0
	queue.push(e)
	if (!first) return
	const onListener = (event: string | symbol): void => {
		if (event !== "discovery" && event !== "discoveries-resync") return
		emitter.off("newListener", onListener)
		setImmediate(() => {
			for (const queued of queue.drain())
				emitter.emit(queued.event, queued.data)
		})
	}
	emitter.on("newListener", onListener)
}
