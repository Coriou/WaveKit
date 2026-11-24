/**
 * Keeps the recordings catalogue current from the writers' own events, so a finalize, a delete,
 * retention or a merge changes the listing without a rescan:
 *
 * - scanner `discovery` events: a changed `evidence.recordings` count (a recording attached by a
 *   finalize, or deleted) re-indexes that discovery's folders; a merge re-indexes every id
 *   involved and announces their owner change; a deletion drops the discovery's unkept files at
 *   once (its folders are being removed) and re-checks them once the removal is done;
 * - scanner `recordings-removed` events: retention deleted files (it does not change
 *   `evidence.recordings`): those discoveries' folders are re-indexed;
 * - digital voice `call` events: a call that ended checks that decoder's dsd-fme directory for
 *   newer calls (the file settles 10 s after its last write, then a timer lists it);
 * - scanner `recording-copy-changed` events: a kept analog file's copy sidecar was written or
 *   removed (copy detection): only that sidecar is read again (copyChanged).
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
	on(event: "recordings-removed", listener: (ids: string[]) => void): unknown
	on(
		event: "recording-copy-changed",
		listener: (alias: string) => void,
	): unknown
	off(
		event: "discovery",
		listener: (d: ScannerDiscoveryEventData) => void,
	): unknown
	off(event: "recordings-removed", listener: (ids: string[]) => void): unknown
	off(
		event: "recording-copy-changed",
		listener: (alias: string) => void,
	): unknown
}

interface EndedCall {
	endedAt?: string
	decoderId?: string
}

export interface CatalogueCallSource {
	on(event: "call", listener: (call: EndedCall) => void): unknown
	off(event: "call", listener: (call: EndedCall) => void): unknown
}

export interface CatalogueWiring {
	inventory: Pick<
		RecordingInventory,
		| "touchDiscoveries"
		| "touchCallRecordings"
		| "ownersChanged"
		| "discoveriesRemoved"
		| "onChange"
		| "copyChanged"
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
		if (d.change === "deleted") {
			// The scanner removes the folders after this event: never re-index them now.
			counts.delete(id)
			inv.discoveriesRemoved?.([id])
			return
		}
		if (d.change === "merged") {
			const ids = [id, ...(d.mergedIds ?? [])]
			for (const x of ids) counts.delete(x)
			remember(id, n)
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
	const onCall = (call: EndedCall): void => {
		if (typeof call.endedAt === "string")
			void inv.touchCallRecordings?.(call.decoderId)
	}
	const onRemoved = (ids: string[]): void => {
		if (Array.isArray(ids) && ids.length > 0) void inv.touchDiscoveries?.(ids)
	}
	const onCopy = (alias: string): void => {
		if (typeof alias === "string") inv.copyChanged?.(alias)
	}
	w.scanner?.on("discovery", onDiscovery)
	w.scanner?.on("recordings-removed", onRemoved)
	w.scanner?.on("recording-copy-changed", onCopy)
	w.digitalVoice?.on("call", onCall)
	const unsubscribe =
		w.broadcast !== undefined ? inv.onChange?.(w.broadcast) : undefined
	return () => {
		w.scanner?.off("discovery", onDiscovery)
		w.scanner?.off("recordings-removed", onRemoved)
		w.scanner?.off("recording-copy-changed", onCopy)
		w.digitalVoice?.off("call", onCall)
		unsubscribe?.()
	}
}
