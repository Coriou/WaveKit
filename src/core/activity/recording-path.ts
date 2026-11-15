/**
 * dsd-fme reports a call's recording as an absolute `wavFile` path. Activity stores and serves
 * the file name only (an id is never a path): new rows are stored that way (ingress.ts), and
 * rows stored before are returned that way. Dependency-free, so the reader worker can use it.
 */
import type { DecodeEnvelope, JsonValue } from "./types.js"

/** The file name of a recording path: never a directory (either separator). */
export function recordingBaseName(value: string): string {
	const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"))
	return cut < 0 ? value : value.slice(cut + 1)
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined
	return value as Record<string, unknown>
}

/** The envelope with `decodedData.wavFile` reduced to its file name; unchanged otherwise. */
export function withoutRecordingPath(envelope: DecodeEnvelope): DecodeEnvelope {
	const data = plainObject(envelope.decodedData)
	const file = data?.["wavFile"]
	if (data === undefined || typeof file !== "string") return envelope
	const name = recordingBaseName(file)
	if (name === file) return envelope
	return {
		...envelope,
		decodedData: { ...data, wavFile: name } as { [key: string]: JsonValue },
	}
}

/** The same on a parsed stored record of any kind (decoder-reception payloads only). */
export function recordWithoutRecordingPath<T extends Record<string, unknown>>(
	record: T,
): T {
	if (record["kind"] !== "decoder-reception") return record
	const payload = plainObject(record["payload"])
	const data = plainObject(payload?.["decodedData"])
	const file = data?.["wavFile"]
	if (payload === undefined || data === undefined || typeof file !== "string")
		return record
	const name = recordingBaseName(file)
	if (name === file) return record
	return {
		...record,
		payload: { ...payload, decodedData: { ...data, wavFile: name } },
	}
}
