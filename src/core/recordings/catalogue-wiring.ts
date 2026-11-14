/**
 * Keeps the recordings catalogue current from the writers' own events, so a finalize, a delete,
 * retention or a merge changes the listing without a rescan:
 *
 * - scanner `discovery` events: a changed `evidence.recordings` count (a recording attached by a
 *   finalize, deleted, or removed by retention) re-indexes that discovery's folders; a merge or
 *   a deletion re-indexes every id involved and announces their owner change;
 * - digital voice `call` events: a call that ended re-indexes the dsd-fme directories (the file
 *   settles 10 s after its last write, then a timer lists it).
 *
 * Keep, unkeep and delete reach the catalogue through `invalidate(id)` (the keep service). The
 * catalogue's slow reconcile catches anything else (a file removed by hand).
 */

import type {
	RecordingsChangedEventData,
	ScannerDiscoveryEventData,
} from "@wavekit/api-types"
import type { RecordingInventory } from "./inventory.js"

export interface CatalogueDiscoverySource {
	on(
		event: "discovery",
		listener: (d: ScannerDiscoveryEventData) => void,
	): unknown
	off(
		event: "discovery",
		listener: (d: ScannerDiscoveryEventData) => void,
	): unknown
}

export interface CatalogueCallSource {
	on(event: "call", listener: (call: { endedAt?: string }) => void): unknown
	off(event: "call", listener: (call: { endedAt?: string }) => void): unknown
}

export interface CatalogueWiring {
	inventory: Pick<
		RecordingInventory,
		"touchDiscoveries" | "touchCallRecordings" | "ownersChanged" | "onChange"
	>
	scanner?: CatalogueDiscoverySource | null
	digitalVoice?: CatalogueCallSource | null
	/** Sends one `recordings:changed` (protected mode only; omitted otherwise). */
	broadcast?: (data: RecordingsChangedEventData) => void
}

/** Discovery ids remembered with their last recordings count (oldest forgotten first). */
export const CATALOGUE_WIRING_COUNTS_MAX = 20_000

/** Wires the writers to the catalogue; returns the unwiring. */
export function wireRecordingCatalogue(w: CatalogueWiring): () => void {
	const inv = w.inventory
	const counts = new Map<string, number>()
	const remember = (id: string, n: number): void => {
		counts.delete(id)
		counts.set(id, n)
		while (counts.size > CATALOGUE_WIRING_COUNTS_MAX) {
			const oldest = counts.keys().next()
			if (oldest.done === true) break
			counts.delete(oldest.value)
		}
	}
	const onDiscovery = (d: ScannerDiscoveryEventData): void => {
		const id = d.discovery.id
		const n = d.discovery.evidence.recordings
		if (d.change === "merged" || d.change === "deleted") {
			const ids = [id, ...(d.mergedIds ?? [])]
			for (const x of ids) counts.delete(x)
			if (d.change === "merged") remember(id, n)
			inv.ownersChanged?.(ids)
			void inv.touchDiscoveries?.(ids)
			return
		}
		const before = counts.get(id)
		remember(id, n)
		// First sight of a discovery with recordings (made before this wiring saw it) or a change.
		if (before === undefined ? n > 0 : before !== n)
			void inv.touchDiscoveries?.([id])
	}
	const onCall = (call: { endedAt?: string }): void => {
		if (typeof call.endedAt === "string") void inv.touchCallRecordings?.()
	}
	w.scanner?.on("discovery", onDiscovery)
	w.digitalVoice?.on("call", onCall)
	const unsubscribe =
		w.broadcast !== undefined ? inv.onChange?.(w.broadcast) : undefined
	return () => {
		w.scanner?.off("discovery", onDiscovery)
		w.digitalVoice?.off("call", onCall)
		unsubscribe?.()
	}
}
