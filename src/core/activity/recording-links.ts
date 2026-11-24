/**
 * Recording links between Activity rows and the recordings catalogue, both directions on one
 * id, the recording's stable key (`dsd~<call name>`, `scan:<discoveryId>~<file>`):
 *
 * - row → recording: the row's summary `recording` (and its `recordingId` ref). A dsd-fme call's
 *   `call_end` row gets it at call end or when its file is found late (ingress.ts); a scanner
 *   analog recording gets one `recording-change` row when the scanner keeps the file for good
 *   (`recording-kept`, after any provisional hold: a discarded file never gets a row);
 * - recording → row: the catalogue item's `activityEventId`, read from the store's link index
 *   (memory), and `GET /api/activity?refs=recordingId:<key>`.
 *
 * A link goes when its file goes. Every deleter (the dsd-fme pruner, Delete, scanner retention,
 * discovery removal, a file removed by hand) shows up as a key the catalogue no longer indexes;
 * the catalogue also drops and re-adds files while it refreshes a folder, so a key is unlinked
 * only after a complete catalogue (hasKey not null) lacked it on two sweeps at least
 * RECORDING_LINK_MISSING_MS apart.
 */
import { scannerKeepKey } from "../recordings/contract.js"
import { isTxId } from "../transmissions/types.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import type { ActivityRecordingLinks } from "./runtime.js"
import type { RecordingChangePayload } from "./storage/contract.js"
import { activityChannelOf } from "./storage/row.js"
import { RECORDINGS_IN_PROGRESS_MS } from "@wavekit/api-types"

/** Between two sweeps of the linked keys (at most ACTIVITY_LINKS_MAX map reads each). */
export const RECORDING_LINK_SWEEP_MS = 60_000

/**
 * How long a key must be missing from a complete catalogue before its link goes: one sweep
 * plus 30 s, and past the catalogue's own delay for a new file (RECORDINGS_IN_PROGRESS_MS, the
 * 10 s a file must be quiet before it is listed). A file that is only being re-indexed comes
 * back within its folder's refresh, long before.
 */
export const RECORDING_LINK_MISSING_MS = Math.max(
	RECORDING_LINK_SWEEP_MS + 30_000,
	3 * RECORDINGS_IN_PROGRESS_MS,
)

/** Keys per unlink change (one writer transaction; about 2 ms per key at most). */
export const RECORDING_LINK_UNLINK_CHUNK = 256

export interface RecordingKeptSource {
	on(
		event: "recording-kept",
		listener: (kept: RecordingKeptEvent) => void,
	): unknown
	off(
		event: "recording-kept",
		listener: (kept: RecordingKeptEvent) => void,
	): unknown
}

/** ScannerRecordingKept, structurally (no scanner import here). */
export interface RecordingKeptEvent {
	recordingId: string
	discoveryId: string
	observationId: string
	sourceId: string | null
	frequencyHz: number | null
	observationStartedAt: string
	durationMs: number
	at: number
	/**
	 * The channel the file was kept on: the discovery owning it at the commit (through merge
	 * aliases) and that discovery's frequency. Absent or malformed: the row has no channel and
	 * keeps the older title.
	 */
	channel?: { discoveryId: string | null; frequencyHz: number } | null
	/** The file's transmission (start) and the others it spans (at most 7); malformed: dropped. */
	txId?: string
	moreTxIds?: readonly string[]
	/** The file's own first-sample wall time (ISO); malformed: dropped. */
	startedAt?: string | null
}

export interface RecordingLinkWiringOptions {
	/** The store's links (ActivityRuntime.recordingLinks()); null when Activity is off. */
	links: ActivityRecordingLinks | null
	/** The recordings catalogue (memory only): null answers mean "cannot tell". */
	catalogue?: { hasKey?(key: string): boolean | null } | null
	scanner?: RecordingKeptSource | null
	logger: Logger
	now?: () => number
	/** Test seam: RECORDING_LINK_SWEEP_MS. */
	sweepMs?: number
	/** Test seam: RECORDING_LINK_MISSING_MS. */
	missingMs?: number
}

export interface RecordingLinkWiring {
	/** The catalogue's `activityEventId` lookup (memory). */
	activityEventId(key: string): string | null
	/** One sweep now (tests; the timer runs it every sweepMs). */
	sweep(): void
	close(): void
}

/** The `recording-change` payload of a kept scanner file, or null when it is not one. */
export function recordingChangeOf(
	kept: RecordingKeptEvent,
): RecordingChangePayload | null {
	const cut = kept.recordingId.indexOf("~")
	if (cut <= 0) return null
	const folder = kept.recordingId.slice(0, cut)
	const name = kept.recordingId.slice(cut + 1)
	if (folder !== kept.discoveryId) return null
	const key = scannerKeepKey(folder, name)
	if (key === null) return null
	const short = (v: unknown): v is string =>
		typeof v === "string" && v.length > 0 && v.length <= 128
	if (!short(kept.observationId)) return null
	const started = Date.parse(kept.observationStartedAt)
	const duration = Math.round(kept.durationMs)
	if (
		!Number.isFinite(kept.at) ||
		!Number.isSafeInteger(duration) ||
		duration < 0
	)
		return null
	const channel =
		kept.channel === undefined || kept.channel === null
			? null
			: activityChannelOf(kept.channel)
	return {
		change: "finalized",
		recordingId: key,
		recordingKind: "scanner-analog",
		discoveryId: folder,
		observationId: kept.observationId,
		sourceId: short(kept.sourceId) ? kept.sourceId : null,
		frequencyHz:
			typeof kept.frequencyHz === "number" &&
			Number.isFinite(kept.frequencyHz) &&
			kept.frequencyHz >= 0
				? kept.frequencyHz
				: null,
		observationStartedAt: Number.isFinite(started)
			? new Date(started).toISOString()
			: null,
		durationMs: duration,
		finalizedAt: new Date(kept.at).toISOString(),
		...(channel === null ? {} : { channel }),
		...txMembersOf(kept),
	}
}

/** At most 7 more transmissions beside the start one (a file names at most 8). */
export const RECORDING_CHANGE_MORE_TX_MAX = 7

/** The payload's transmission and file-start members of a kept event; malformed ones dropped. */
function txMembersOf(
	kept: RecordingKeptEvent,
): Pick<RecordingChangePayload, "txId" | "moreTxIds" | "startedAt"> {
	const out: { txId?: string; moreTxIds?: string[]; startedAt?: string } = {}
	if (isTxId(kept.txId)) {
		out.txId = kept.txId
		const more: string[] = []
		for (const id of kept.moreTxIds ?? []) {
			if (more.length >= RECORDING_CHANGE_MORE_TX_MAX) break
			if (isTxId(id) && id !== kept.txId && !more.includes(id)) more.push(id)
		}
		if (more.length > 0) out.moreTxIds = more
	}
	const started =
		typeof kept.startedAt === "string" ? Date.parse(kept.startedAt) : Number.NaN
	if (Number.isFinite(started)) out.startedAt = new Date(started).toISOString()
	return out
}

export function wireRecordingLinks(
	options: RecordingLinkWiringOptions,
): RecordingLinkWiring {
	const log = createComponentLogger(options.logger, "RecordingLinks")
	const links = options.links
	const now = options.now ?? Date.now
	const sweepMs = options.sweepMs ?? RECORDING_LINK_SWEEP_MS
	const missingMs = options.missingMs ?? RECORDING_LINK_MISSING_MS
	/** Key → when a complete catalogue first lacked it. */
	const missing = new Map<string, number>()
	let closed = false

	const onKept = (kept: RecordingKeptEvent): void => {
		if (closed || links === null) return
		let payload: RecordingChangePayload | null = null
		try {
			payload = recordingChangeOf(kept)
		} catch {
			payload = null
		}
		if (payload === null) {
			log.debug("A kept scanner recording was not linked (malformed event)")
			return
		}
		links.admitRecording(payload)
	}

	const sweep = (): void => {
		if (closed || links === null) return
		const has = options.catalogue?.hasKey
		if (has === undefined) return
		const at = now()
		const keys = links.linkedRecordings()
		const linked = new Set(keys)
		for (const key of missing.keys()) if (!linked.has(key)) missing.delete(key)
		const gone: string[] = []
		for (const key of keys) {
			let present: boolean | null
			try {
				present = has(key)
			} catch {
				present = null
			}
			// The catalogue cannot tell for this key now (building, re-indexing, an error, a bound, a
			// dsd-fme directory not created yet): this sweep proves nothing about it, and its
			// `missing` entry stays as it was. Other keys are still judged.
			if (present === null) continue
			if (present) {
				missing.delete(key)
				continue
			}
			const since = missing.get(key)
			if (since === undefined) missing.set(key, at)
			else if (at - since >= missingMs) gone.push(key)
		}
		for (let i = 0; i < gone.length; i += RECORDING_LINK_UNLINK_CHUNK) {
			const ids = gone.slice(i, i + RECORDING_LINK_UNLINK_CHUNK)
			for (const id of ids) missing.delete(id)
			links.link({ type: "unlink", recordingIds: ids })
		}
		if (gone.length > 0)
			log.info(
				{ unlinked: gone.length },
				"Recording links of deleted files removed",
			)
	}

	options.scanner?.on("recording-kept", onKept)
	const timer = setInterval(sweep, sweepMs)
	timer.unref()

	return {
		activityEventId: key => {
			if (closed || links === null) return null
			return links.recordingEventId(key)
		},
		sweep,
		close() {
			if (closed) return
			closed = true
			clearInterval(timer)
			options.scanner?.off("recording-kept", onKept)
			missing.clear()
		},
	}
}
