/**
 * Rule six for a stored call row read back (GET /api/transmissions/:ref raw block and
 * GET /api/activity/:eventId): a digital call's recording file is named only when the call is
 * proven clear, so an unproven or encrypted call shows no file name, key or link on any route.
 */
import type { ActivityRecord, JsonValue } from "@wavekit/api-types"
import {
	callTrustAdmits,
	dsdFmeCallRecordable,
} from "../../decoders/builtin/dmr-recording-gate.js"

/** The dsd-fme keep key of a call file name (`dsd~<name>`), as the catalogue and links name it. */
export const dsdKeyOf = (name: string): string => `dsd~${name}`

/** A field key or value that names a recording file (a dsd-fme `.wav` call file or its key). */
const RECORDING_FIELD_KEY = /wav|recording|^file(name)?$|path/i
const namesRecording = (v: unknown): boolean =>
	typeof v === "string" && (/\.wav$/i.test(v) || v.startsWith("dsd~"))

/**
 * A call row's stored record names its dsd-fme file (`decodedData.wavFile`). That name is the
 * key without its `dsd~` prefix, so it stays only when `keep` admits that key; otherwise every
 * file reference goes: the wavFile, a field naming a recording and a `recording` link on the
 * record. Other record kinds pass unchanged.
 */
export function redactCallRecordingRefs(
	record: ActivityRecord,
	keep: (key: string) => boolean,
): ActivityRecord {
	if (record.kind !== "decoder-reception") return record
	const payload = record.payload
	const fields = payload.fields.filter(
		f =>
			!(
				(RECORDING_FIELD_KEY.test(f.key) || namesRecording(f.value)) &&
				!(typeof f.value === "string" && keep(dsdKeyOf(f.value)))
			),
	)
	let decodedData = payload.decodedData
	if (
		typeof decodedData === "object" &&
		decodedData !== null &&
		!Array.isArray(decodedData)
	) {
		const rest: { [key: string]: JsonValue } = {}
		for (const [field, value] of Object.entries(decodedData)) {
			if (field === "wavFile") {
				if (typeof value === "string" && keep(dsdKeyOf(value)))
					rest[field] = value
				continue
			}
			if (
				(RECORDING_FIELD_KEY.test(field) || namesRecording(value)) &&
				!(typeof value === "string" && keep(dsdKeyOf(value)))
			)
				continue
			rest[field] = value
		}
		decodedData = rest
	}
	const out: Record<string, unknown> = { ...payload, fields, decodedData }
	const link = (payload as { recording?: { id?: unknown } }).recording
	if (link !== undefined && !(typeof link.id === "string" && keep(link.id)))
		delete out["recording"]
	return { ...record, payload: out as unknown as typeof payload }
}

/** A dsd-fme call row: a decoder reception of a call_start or call_end output. */
function isCallRow(record: ActivityRecord): boolean {
	return (
		record.kind === "decoder-reception" &&
		(record.payload.outputType === "call_start" ||
			record.payload.outputType === "call_end")
	)
}

/**
 * Whether a call row's own trust fields admit its recording: the stored call output proves the
 * call clear (callTrustAdmits, as the ingress links) and the key names a call file the
 * recordings route may serve (dsdFmeCallRecordable). Anything unknown or malformed: false.
 */
export function callRowKeepsRecording(
	record: ActivityRecord,
	key: string,
): boolean {
	if (!isCallRow(record) || record.kind !== "decoder-reception") return false
	const decoded = record.payload.decodedData
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
		return false
	if (!key.startsWith("dsd~")) return false
	const data = decoded as { readonly [key: string]: JsonValue | undefined }
	const protocol = data["protocol"] ?? record.payload.protocol
	return (
		callTrustAdmits(protocol, data) &&
		dsdFmeCallRecordable(key.slice("dsd~".length))
	)
}

/**
 * The Activity detail of a record: a call row names its file (wavFile, a field, a link) only
 * when its own trust admits the recording; every other record passes unchanged.
 */
export function redactActivityDetail(record: ActivityRecord): ActivityRecord {
	if (!isCallRow(record)) return record
	return redactCallRecordingRefs(record, key =>
		callRowKeepsRecording(record, key),
	)
}
