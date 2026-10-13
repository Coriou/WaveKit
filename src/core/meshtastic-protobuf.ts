/**
 * Bounded proto3 reader for Meshtastic Position and User payloads (WG2 req 5.2, 5.3).
 *
 * The vendored `docker/scripts/meshtastic_proto/mesh_pb2.py` compiles only
 * `Data` and `MeshPacket` (lora-decoder req 3.8). Position and User field
 * numbers are the lane brief's, which are the Meshtastic `mesh.proto` numbers:
 *
 * Position: 1 latitude_i sfixed32, 2 longitude_i sfixed32, 3 altitude int32
 * (metres), 4 time fixed32 (unix seconds). Other fields are skipped.
 * User: 1 id, 2 long_name, 3 short_name, 5 hw_model, 6 is_licensed, 7 role.
 *
 * Both readers return null on any malformation and never throw. There is no
 * recursion: length-delimited unknowns are skipped as opaque bytes.
 */

const MAX_VARINT_BYTES = 10
const MAX_FIELDS = 64
/** Meshtastic long-name limit, in UTF-8 bytes. Longer names reject the message. */
const MAX_LONG_NAME_BYTES = 40
/** Meshtastic short-name limit, in UTF-8 bytes. */
const MAX_SHORT_NAME_BYTES = 8
const DEGREE_DIVISOR = 10_000_000

const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

export interface MeshPositionFields {
	/** Degrees. 0 when the sfixed32 field is absent (proto3 default). */
	lat: number
	lon: number
	/** Metres. Null when field 3 is absent. 0 is a reported sea-level altitude. */
	altitudeM: number | null
	/** Unix seconds from Position.time. Null when field 4 is absent. */
	timeS: number | null
}

export interface MeshUserFields {
	/** Raw User.id. Empty string when the field is absent. */
	id: string
	/** Null when the field is absent. Empty string when it is present and empty. */
	longName: string | null
	shortName: string | null
	hwModel: number | null
	isLicensed: boolean | null
	role: number | null
}

interface Cursor {
	bytes: Uint8Array
	offset: number
}

type FieldAction = "handled" | "unknown" | "bad"

function asBytes(value: Uint8Array): Uint8Array | null {
	if (!(value instanceof Uint8Array)) return null
	return value
}

function readVarint(cursor: Cursor): bigint | null {
	let value = 0n
	let shift = 0n
	for (let i = 0; i < MAX_VARINT_BYTES; i++) {
		if (cursor.offset >= cursor.bytes.length) return null
		const byte = cursor.bytes[cursor.offset]
		if (byte === undefined) return null
		cursor.offset += 1
		const data = byte & 0x7f
		// The 10th byte holds bit 63 only. Anything above that is not a uint64.
		if (shift === 63n && data > 1) return null
		value |= BigInt(data) << shift
		if ((byte & 0x80) === 0) return value
		shift += 7n
	}
	return null
}

function advance(cursor: Cursor, count: number): boolean {
	if (count < 0 || cursor.offset + count > cursor.bytes.length) return false
	cursor.offset += count
	return true
}

/** Skip one unknown value. Wire types 3, 4, 6 and 7 are rejected. */
function skip(cursor: Cursor, wire: number): boolean {
	if (wire === WIRE_VARINT) return readVarint(cursor) !== null
	if (wire === WIRE_FIXED64) return advance(cursor, 8)
	if (wire === WIRE_FIXED32) return advance(cursor, 4)
	if (wire === WIRE_LENGTH) {
		const length = readVarint(cursor)
		if (length === null) return false
		const remaining = cursor.bytes.length - cursor.offset
		if (length > BigInt(remaining)) return false
		return advance(cursor, Number(length))
	}
	return false
}

/**
 * Walk a message of at most 64 fields. `known` must consume a field it handles
 * and must not consume a field it reports as unknown.
 */
function walk(
	bytes: Uint8Array,
	known: (field: bigint, wire: number, cursor: Cursor) => FieldAction,
): boolean {
	const cursor: Cursor = { bytes, offset: 0 }
	let fields = 0
	while (cursor.offset < bytes.length) {
		if (fields >= MAX_FIELDS) return false
		const tag = readVarint(cursor)
		if (tag === null) return false
		fields += 1
		const field = tag >> 3n
		const wire = Number(tag & 7n)
		if (field <= 0n) return false
		const action = known(field, wire, cursor)
		if (action === "bad") return false
		if (action === "unknown" && !skip(cursor, wire)) return false
	}
	return true
}

function readFixed(
	cursor: Cursor,
	wire: number,
	signed: boolean,
): number | null {
	if (wire !== WIRE_FIXED32) return null
	if (cursor.offset + 4 > cursor.bytes.length) return null
	const view = new DataView(
		cursor.bytes.buffer,
		cursor.bytes.byteOffset + cursor.offset,
		4,
	)
	const value = signed ? view.getInt32(0, true) : view.getUint32(0, true)
	cursor.offset += 4
	return value
}

/** int32: low 32 bits of the varint, sign-extended. Wrong wire type is null. */
function readInt32(cursor: Cursor, wire: number): number | null {
	if (wire !== WIRE_VARINT) return null
	const value = readVarint(cursor)
	if (value === null) return null
	const low = value & 0xffffffffn
	if (low > 0x7fffffffn) return Number(low - 0x100000000n)
	return Number(low)
}

function readBool(cursor: Cursor, wire: number): boolean | null {
	if (wire !== WIRE_VARINT) return null
	const value = readVarint(cursor)
	if (value === 0n) return false
	if (value === 1n) return true
	return null
}

function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

/**
 * Length-delimited UTF-8. Over the byte cap, past the end, invalid UTF-8 or
 * containing a control character rejects the field (null).
 */
function readText(
	cursor: Cursor,
	wire: number,
	maxBytes: number,
): string | null {
	if (wire !== WIRE_LENGTH) return null
	const length = readVarint(cursor)
	if (length === null) return null
	const remaining = cursor.bytes.length - cursor.offset
	if (length > BigInt(remaining)) return null
	if (length > BigInt(maxBytes)) return null
	const count = Number(length)
	const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + count)
	cursor.offset += count
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(slice)
		if (hasControl(text)) return null
		return text
	} catch {
		return null
	}
}

/** Position (port 3). Empty bytes are a valid all-default message, not an error. */
export function readPosition(bytes: Uint8Array): MeshPositionFields | null {
	try {
		const view = asBytes(bytes)
		if (!view) return null
		let latitudeI: number | null = null
		let longitudeI: number | null = null
		let altitudeM: number | null = null
		let timeS: number | null = null
		const ok = walk(view, (field, wire, cursor) => {
			if (field === 1n) {
				const value = readFixed(cursor, wire, true)
				if (value === null) return "bad"
				latitudeI = value
				return "handled"
			}
			if (field === 2n) {
				const value = readFixed(cursor, wire, true)
				if (value === null) return "bad"
				longitudeI = value
				return "handled"
			}
			if (field === 3n) {
				const value = readInt32(cursor, wire)
				if (value === null) return "bad"
				altitudeM = value
				return "handled"
			}
			if (field === 4n) {
				const value = readFixed(cursor, wire, false)
				if (value === null) return "bad"
				timeS = value
				return "handled"
			}
			return "unknown"
		})
		if (!ok) return null
		return {
			lat: (latitudeI ?? 0) / DEGREE_DIVISOR,
			lon: (longitudeI ?? 0) / DEGREE_DIVISOR,
			altitudeM,
			timeS,
		}
	} catch {
		return null
	}
}

/** User (port 4). Empty bytes are a valid all-default message, not an error. */
export function readUser(bytes: Uint8Array): MeshUserFields | null {
	try {
		const view = asBytes(bytes)
		if (!view) return null
		let id = ""
		let longName: string | null = null
		let shortName: string | null = null
		let hwModel: number | null = null
		let isLicensed: boolean | null = null
		let role: number | null = null
		const ok = walk(view, (field, wire, cursor) => {
			if (field === 1n) {
				const value = readText(cursor, wire, view.length)
				if (value === null) return "bad"
				id = value
				return "handled"
			}
			if (field === 2n) {
				const value = readText(cursor, wire, MAX_LONG_NAME_BYTES)
				if (value === null) return "bad"
				longName = value
				return "handled"
			}
			if (field === 3n) {
				const value = readText(cursor, wire, MAX_SHORT_NAME_BYTES)
				if (value === null) return "bad"
				shortName = value
				return "handled"
			}
			if (field === 5n) {
				const value = readInt32(cursor, wire)
				if (value === null) return "bad"
				hwModel = value
				return "handled"
			}
			if (field === 6n) {
				const value = readBool(cursor, wire)
				if (value === null) return "bad"
				isLicensed = value
				return "handled"
			}
			if (field === 7n) {
				const value = readInt32(cursor, wire)
				if (value === null) return "bad"
				role = value
				return "handled"
			}
			return "unknown"
		})
		if (!ok) return null
		return { id, longName, shortName, hwModel, isLicensed, role }
	} catch {
		return null
	}
}
