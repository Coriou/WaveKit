/**
 * WG10 req 1.8: maps the keep store's state and totals to the storage report's `kept` field.
 * Pure; imports types and two constants only, so Main can import it at startup without pulling
 * runtime modules in.
 */
import type { StorageKeptSummary } from "@wavekit/api-types"
import {
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
} from "@wavekit/api-types"
import type { RecordingKeepTotalsSource } from "./contract.js"

/** null without a source (legacy mode); counts only in `ready` with valid totals. */
export function keptSummaryOf(
	source: RecordingKeepTotalsSource | null,
): StorageKeptSummary | null {
	if (!source) return null
	try {
		const state = source.state()
		if (state !== "ready")
			return state === "failed" ? { state } : { state: "loading" }
		const t = source.totals()
		if (
			!t ||
			!Number.isSafeInteger(t.recordings) ||
			!Number.isSafeInteger(t.bytes) ||
			t.recordings < 0 ||
			t.bytes < 0
		)
			return { state: "loading" }
		return {
			state: "ready",
			recordings: t.recordings,
			bytes: t.bytes,
			maxRecordings: RECORDING_KEEPS_MAX_ENTRIES,
			maxBytes: RECORDING_KEEPS_MAX_BYTES,
		}
	} catch {
		return { state: "failed" }
	}
}
