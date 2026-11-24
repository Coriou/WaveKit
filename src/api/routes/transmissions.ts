/**
 * GET /api/transmissions/:ref: one transmission, read only. `ref` is `tx_<ULID>`, `rec:<key>`,
 * `evt:<event id>` or `obs:<observation id>` (TransmissionRefSchema); anything else is 400.
 *
 * Bounded resolution, never a folder walk nor an Activity scan: one registry read (an alias
 * retried once by the id its stored record names), one Activity search on the `txId` ref
 * (TRANSMISSION_ROWS_MAX rows), at most TRANSMISSION_RECORDS_MAX record reads by event id, and the
 * catalogue's memory indexes (keysOfTx, itemsOfKeys). The id and the start time come from the
 * stored record (record_json), never from an Activity summary alone. Audio is listed only where
 * the recordings route serves it, and for a digital call only the file the decoder linked; a
 * `rec:dsd~` ref resolves only to a clear call whose decoder link names it (else the unknown 404).
 * Bodies and logs carry fixed text: the ref is never echoed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type {
	ActivityRecord,
	ActivitySummary,
	RecordingInventoryItem,
	TransmissionErrorBody,
	TransmissionErrorCode,
} from "@wavekit/api-types"
import type { DeniedAdmission } from "../../access/types.js"
import { withActivityClient } from "../../core/activity/query/service.js"
import type { ActivityQueryService } from "../../core/activity/storage/contract.js"
import type { RecordingInventory } from "../../core/recordings/inventory.js"
import {
	buildTransmissionDto,
	type TransmissionDtoSources,
	TRANSMISSION_COPIES_MAX,
	TRANSMISSION_GROUP_MEMBERS_MAX,
} from "../../core/transmissions/dto.js"
import { TransmissionRefSchema } from "../../core/transmissions/ref.js"
import { isTxId } from "../../core/transmissions/types.js"
import type { TxReadPort, TxView } from "../../core/transmissions/types.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"

/** The route as mounted: a wildcard, so a long `rec:` key is not cut by the router's 100-character param bound. */
export const TRANSMISSIONS_ROUTE_MOUNT = "/api/transmissions/*"

/**
 * Activity rows read on the txId ref: a transmission's rows are its live-demod parts (≤ 3 at
 * 600 s), its recording-change rows (≤ 15 file parts) or a call's start and end: 16 holds a
 * call or the first file parts; past it the catalogue index still names every file.
 */
export const TRANSMISSION_ROWS_MAX = 16

/** Stored records read by event id (record_json): enough for the call or file and the live row. */
export const TRANSMISSION_RECORDS_MAX = 4

export interface TransmissionRoutesOptions {
	transmissions: TxReadPort
	/** Present only while Activity is ready. */
	activity?: ActivityQueryService
	/** The Activity admission key of a request (activityClientKey); absent: the request IP. */
	activityClientKey?: (request: FastifyRequest) => string
	/** Present only where the recordings routes are mounted (the recordings serve gate). */
	inventory?: RecordingInventory
	authorize?: (request: FastifyRequest) => DeniedAdmission | undefined
}

const MESSAGES: Record<TransmissionErrorCode, string> = {
	TRANSMISSION_REF_INVALID: "The transmission reference is invalid",
	TRANSMISSION_NOT_FOUND: "Transmission not found",
	TRANSMISSIONS_UNAVAILABLE: "Transmissions are unavailable",
}
const ERRORS: Record<number, string> = {
	400: "Bad Request",
	404: "Not Found",
	503: "Service Unavailable",
}

function sendError(
	reply: FastifyReply,
	status: 400 | 404 | 503,
	code: TransmissionErrorCode,
) {
	const body: TransmissionErrorBody = {
		error: ERRORS[status] ?? "Error",
		code,
		message: MESSAGES[code],
	}
	return reply.code(status).header("Cache-Control", "no-store").send(body)
}

function sendDenial(reply: FastifyReply, denied: DeniedAdmission) {
	for (const [name, value] of Object.entries(denied.headers))
		reply.header(name, value)
	return reply
		.status(denied.status)
		.type("application/json")
		.send(JSON.stringify({ code: denied.code }))
}

/** The id a stored record names: its own payload field (record_json), never a summary. */
export function txIdOfRecord(record: ActivityRecord): string | null {
	let id: string | undefined
	if (record.kind === "decoder-reception") id = record.payload.refs?.txId
	else if (record.kind !== "ingestion-gap") id = record.payload.txId
	return isTxId(id) ? id : null
}

/** Whether a stored record belongs to `txId` (a recording-change names several). */
function recordNames(record: ActivityRecord, txId: string): boolean {
	if (txIdOfRecord(record) === txId) return true
	return (
		record.kind === "recording-change" &&
		(record.payload.moreTxIds ?? []).includes(txId)
	)
}

/**
 * The Activity ref of a digital call an id-less alias names: a dsd-fme file's `recordingId`
 * (`dsd~<call name>`), or the `callId` of the call row an `evt:` alias read. Null otherwise.
 */
function dvCallRefOf(
	ref: string,
	records: ReadonlyMap<string, ActivityRecord>,
): { type: "callId" | "recordingId"; value: string } | null {
	if (ref.startsWith("rec:dsd~"))
		return { type: "recordingId", value: ref.slice("rec:".length) }
	if (!ref.startsWith("evt:")) return null
	const record = records.get(ref.slice("evt:".length))
	if (record?.kind !== "decoder-reception") return null
	const callId = record.payload.refs?.callId
	return typeof callId === "string" && callId.length > 0
		? { type: "callId", value: callId }
		: null
}

export async function transmissionRoutes(
	fastify: FastifyInstance,
	options: TransmissionRoutesOptions,
): Promise<void> {
	const { transmissions, activity, inventory, authorize } = options
	const clientKey =
		options.activityClientKey ??
		((request: FastifyRequest) => `ip:${request.ip}`)

	fastify.get(
		TRANSMISSIONS_ROUTE_MOUNT,
		{
			schema: {
				tags: ["transmissions"],
				summary:
					"One transmission by its id or an artefact's alias (rec:, evt:, obs:)",
			},
		},
		async (request, reply) => {
			const denied = authorize?.(request)
			if (denied) return sendDenial(reply, denied)
			const parsed = TransmissionRefSchema.safeParse(
				(request.params as { "*"?: unknown } | undefined)?.["*"],
			)
			if (!parsed.success)
				return sendError(reply, 400, "TRANSMISSION_REF_INVALID")
			const ref = parsed.data
			const key = clientKey(request)
			let activityFailed = false
			const onActivity = async <T>(
				run: () => Promise<T>,
			): Promise<T | null> => {
				if (activity === undefined) return null
				try {
					return await withActivityClient(key, run)
				} catch (err) {
					activityFailed = true
					request.log.debug(
						{ err: safeErrorFields(err) },
						"Transmission Activity read failed",
					)
					return null
				}
			}
			const itemsOf = (keys: readonly string[]): RecordingInventoryItem[] => {
				if (inventory?.itemsOfKeys === undefined || keys.length === 0) return []
				try {
					return [...inventory.itemsOfKeys(keys)]
				} catch {
					return []
				}
			}

			try {
				const recordingKeys: string[] = []
				const eventIds: string[] = []
				const records = new Map<string, ActivityRecord>()
				let missingEventIds = 0
				let items: RecordingInventoryItem[] = []
				let storedTxId: string | null = null

				// 1. The registry: the id, or the first transmission an alias names.
				let view: TxView | null = isTxId(ref)
					? transmissions.get(ref)
					: transmissions.byAlias(ref)
				// 2. A registry miss on an alias: the id its stored artefact names, retried once.
				if (view === null && ref.startsWith("rec:")) {
					const recKey = ref.slice("rec:".length)
					recordingKeys.push(recKey)
					items = itemsOf([recKey])
					const named = items[0]?.txId
					if (isTxId(named)) storedTxId = named
				} else if (view === null && ref.startsWith("evt:")) {
					const eventId = ref.slice("evt:".length)
					eventIds.push(eventId)
					const record = await onActivity(() => activity!.detail(eventId))
					if (record) {
						records.set(eventId, record)
						storedTxId = txIdOfRecord(record)
					} else if (!activityFailed) missingEventIds++
				}
				if (view === null && storedTxId !== null)
					view = transmissions.get(storedTxId)
				const txId = view?.id ?? storedTxId ?? (isTxId(ref) ? ref : null)
				if (view !== null) {
					for (const a of view.aliases.rec)
						recordingKeys.push(a.slice("rec:".length))
					for (const a of view.aliases.evt)
						eventIds.push(a.slice("evt:".length))
				}

				// 3. The stores, by the id: the Activity rows on its ref and the catalogue index.
				const linkedRecordingKeys: string[] = []
				let summaries: readonly ActivitySummary[] = []
				// A call row's `recording` is the decoder's link (it links only a recordingLinkable file).
				const readRows = async (rowRef: {
					type: "txId" | "callId" | "recordingId"
					value: string
				}): Promise<void> => {
					const page = await onActivity(() =>
						activity!.search({
							query: { refs: [rowRef] },
							limit: TRANSMISSION_ROWS_MAX,
						}),
					)
					summaries = page?.items ?? []
					for (const s of summaries) {
						if (!eventIds.includes(s.eventId)) eventIds.push(s.eventId)
						if (s.recording !== undefined) {
							recordingKeys.push(s.recording.id)
							if (s.kind === "decoder-reception")
								linkedRecordingKeys.push(s.recording.id)
						}
					}
				}
				if (txId !== null) {
					await readRows({ type: "txId", value: txId })
					try {
						for (const k of inventory?.keysOfTx?.(txId) ?? [])
							recordingKeys.push(k)
					} catch {
						// The catalogue index never fails the read.
					}
				} else {
					// A digital call reached by its alias with no id (a pre-id row): the rows on the
					// call's own ref give its decoder link, as the txId rows do (one search).
					const callRef = dvCallRefOf(ref, records)
					if (callRef !== null) await readRows(callRef)
				}

				// 4. The stored records (record_json) of the rows found: linked rows first.
				const toRead = [
					...summaries.filter(s => s.recording !== undefined),
					...summaries.filter(s => s.recording === undefined),
				]
					.map(s => s.eventId)
					.filter(id => !records.has(id))
				if (view !== null)
					for (const id of eventIds) if (!toRead.includes(id)) toRead.push(id)
				for (const id of toRead) {
					if (records.size >= TRANSMISSION_RECORDS_MAX) break
					const record = await onActivity(() => activity!.detail(id))
					if (record) records.set(id, record)
					else if (!activityFailed && activity !== undefined) missingEventIds++
				}
				const named = [...records.values()].filter(
					r => txId === null || recordNames(r, txId),
				)
				for (const r of named)
					if (r.kind === "recording-change")
						recordingKeys.push(r.payload.recordingId)

				// 5. The catalogue items the recordings route serves now.
				const known = new Set(items.map(i => i.key ?? i.id))
				const more = [...new Set(recordingKeys)].filter(k => !known.has(k))
				items = [...items, ...itemsOf(more)]

				if (
					view === null &&
					items.length === 0 &&
					records.size === 0 &&
					summaries.length === 0
				)
					// Nothing resolved: a failed Activity read cannot prove the ref unknown.
					return activityFailed
						? sendError(reply, 503, "TRANSMISSIONS_UNAVAILABLE")
						: sendError(reply, 404, "TRANSMISSION_NOT_FOUND")

				// 6. Copy links (bounded: the root its copyOf names, at most TRANSMISSION_COPIES_MAX
				// of its own copies), from the catalogue's memory index only.
				// The item the ref names (a `rec:` key: that roll-over part, not the first one), else
				// the first analog item.
				const refKey = ref.startsWith("rec:") ? ref.slice("rec:".length) : null
				const analogItem =
					items.find(
						i => i.kind === "scanner-analog" && (i.key ?? i.id) === refKey,
					) ?? items.find(i => i.kind === "scanner-analog")
				let copy: TransmissionDtoSources["copy"]
				if (analogItem !== undefined && inventory !== undefined) {
					const rootKey = analogItem.copyOf?.key ?? null
					let copyKeys: readonly string[] = []
					try {
						copyKeys =
							inventory.keysOfCopyRoot?.(analogItem.key ?? analogItem.id) ?? []
					} catch {
						copyKeys = []
					}
					copy = {
						item: analogItem,
						root: rootKey === null ? null : (itemsOf([rootKey])[0] ?? null),
						copies: itemsOf(copyKeys.slice(0, TRANSMISSION_COPIES_MAX)),
						copiesTotal: copyKeys.length,
					}
				}
				const dto = buildTransmissionDto({
					view,
					storedTxId: txId,
					recordingKeys,
					items,
					eventIds,
					// A record read by its alias stays even when it names no id (a pre-id row).
					records: txId === null ? [...records.values()] : named,
					missingEventIds,
					linkedRecordingKeys,
					members:
						view === null
							? []
							: transmissions.groupMembers(
									view.groupId,
									TRANSMISSION_GROUP_MEMBERS_MAX,
								),
					audioServed: inventory !== undefined,
					...(copy === undefined ? {} : { copy }),
				})
				// Rule six: a dsd-fme file is reached by its key only while a clear call's decoder link
				// names it. An unlisted file (unproven, encrypted, never linked) answers exactly as an
				// unknown ref, so the alias is no oracle of what the catalogue holds.
				if (
					ref.startsWith("rec:dsd~") &&
					!(
						dto.privacy === "clear" &&
						linkedRecordingKeys.includes(ref.slice("rec:".length))
					)
				)
					return activityFailed
						? sendError(reply, 503, "TRANSMISSIONS_UNAVAILABLE")
						: sendError(reply, 404, "TRANSMISSION_NOT_FOUND")
				return await reply.header("Cache-Control", "no-store").send(dto)
			} catch (err) {
				request.log.warn(
					{ err: safeErrorFields(err) },
					"Transmission read failed",
				)
				return sendError(reply, 503, "TRANSMISSIONS_UNAVAILABLE")
			}
		},
	)
}
