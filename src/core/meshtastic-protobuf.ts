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
 * Telemetry and NeighborInfo readers (WG3 req 8.1-8.3) are at the end.
 *
 * All readers return null on any malformation and never throw. There is no
 * recursion: length-delimited unknowns are skipped as opaque bytes.
 */

const MAX_VARINT_BYTES = 10
const MAX_FIELDS = 64
/** Proto3 field numbers are 1..2^29-1. A larger number is a malformed tag. */
const MAX_FIELD_NUMBER = 2 ** 29 - 1
const MAX_TAG = 0xffffffffn
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
	/** Exclusive end of the message being walked (a nested message ends early). */
	end: number
}

type FieldAction = "handled" | "unknown" | "bad"

function asBytes(value: Uint8Array): Uint8Array | null {
	if (!(value instanceof Uint8Array)) return null
	return value
}

/**
 * Fast path: a varint of up to 4 bytes (28 bits) as a small integer, with no
 * BigInt work. Returns -1 and leaves the cursor unchanged otherwise.
 */
function readSmallVarint(cursor: Cursor): number {
	const { bytes, offset, end } = cursor
	let small = 0
	for (let i = 0; i < 4 && offset + i < end; i++) {
		const byte = bytes[offset + i] ?? 0
		small |= (byte & 0x7f) << (7 * i)
		if ((byte & 0x80) === 0) {
			cursor.offset = offset + i + 1
			return small
		}
	}
	return -1
}

function readVarint(cursor: Cursor): bigint | null {
	const small = readSmallVarint(cursor)
	if (small >= 0) return BigInt(small)
	return readVarintSlow(cursor)
}

function readVarintSlow(cursor: Cursor): bigint | null {
	let value = 0n
	let shift = 0n
	for (let i = 0; i < MAX_VARINT_BYTES; i++) {
		if (cursor.offset >= cursor.end) return null
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
	if (count < 0 || cursor.offset + count > cursor.end) return false
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
		const remaining = cursor.end - cursor.offset
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
	known: (field: number, wire: number, cursor: Cursor) => FieldAction,
	maxFields: number = MAX_FIELDS,
	start = 0,
	end: number = bytes.length,
): boolean {
	const cursor: Cursor = { bytes, offset: start, end }
	let fields = 0
	while (cursor.offset < end) {
		if (fields >= maxFields) return false
		let tagNumber = readSmallVarint(cursor)
		if (tagNumber < 0) {
			const tag = readVarintSlow(cursor)
			if (tag === null || tag > MAX_TAG) return false
			tagNumber = Number(tag)
		}
		fields += 1
		const field = Math.floor(tagNumber / 8)
		const wire = tagNumber % 8
		if (field <= 0 || field > MAX_FIELD_NUMBER) return false
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
	if (cursor.offset + 4 > cursor.end) return null
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
	const remaining = cursor.end - cursor.offset
	if (length > BigInt(remaining)) return null
	if (length > BigInt(maxBytes)) return null
	const count = Number(length)
	const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + count)
	cursor.offset += count
	try {
		// ignoreBOM keeps U+FEFF. The default decoder strips a leading BOM and
		// would make a name or a User.id fail to round-trip.
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(slice)
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
			if (field === 1) {
				const value = readFixed(cursor, wire, true)
				if (value === null) return "bad"
				latitudeI = value
				return "handled"
			}
			if (field === 2) {
				const value = readFixed(cursor, wire, true)
				if (value === null) return "bad"
				longitudeI = value
				return "handled"
			}
			if (field === 3) {
				const value = readInt32(cursor, wire)
				if (value === null) return "bad"
				altitudeM = value
				return "handled"
			}
			if (field === 4) {
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
			if (field === 1) {
				const value = readText(cursor, wire, view.length)
				if (value === null) return "bad"
				id = value
				return "handled"
			}
			if (field === 2) {
				const value = readText(cursor, wire, MAX_LONG_NAME_BYTES)
				if (value === null) return "bad"
				longName = value
				return "handled"
			}
			if (field === 3) {
				const value = readText(cursor, wire, MAX_SHORT_NAME_BYTES)
				if (value === null) return "bad"
				shortName = value
				return "handled"
			}
			if (field === 5) {
				const value = readInt32(cursor, wire)
				if (value === null) return "bad"
				hwModel = value
				return "handled"
			}
			if (field === 6) {
				const value = readBool(cursor, wire)
				if (value === null) return "bad"
				isLicensed = value
				return "handled"
			}
			if (field === 7) {
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

// --- Telemetry and NeighborInfo (WG3 req 8.1-8.3) ---------------------------
// Field numbers from the public Meshtastic telemetry.proto and mesh.proto.

/** Telemetry.time (fixed32): skipped as an unknown field. */
const TELEMETRY_TIME = 1
/** Telemetry.device_metrics (DeviceMetrics, length-delimited). */
const TELEMETRY_DEVICE_METRICS = 2
/** DeviceMetrics.battery_level (uint32 varint). */
const DEVICE_BATTERY_LEVEL = 1
/** DeviceMetrics.voltage (float, fixed32). */
const DEVICE_VOLTAGE = 2
/** DeviceMetrics.channel_utilization (float, fixed32). */
const DEVICE_CHANNEL_UTILIZATION = 3
/** DeviceMetrics.air_util_tx (float, fixed32). */
const DEVICE_AIR_UTIL_TX = 4
/** DeviceMetrics.uptime_seconds (uint32 varint). */
const DEVICE_UPTIME_SECONDS = 5
/** NeighborInfo.node_id (uint32 varint). Fields 2 and 3 are skipped. */
const NEIGHBOR_INFO_NODE_ID = 1
/** NeighborInfo.neighbors (repeated Neighbor, length-delimited). */
const NEIGHBOR_INFO_NEIGHBORS = 4
/** Neighbor.node_id (uint32 varint). */
const NEIGHBOR_NODE_ID = 1
/** Neighbor.snr (float, fixed32). */
const NEIGHBOR_SNR = 2

/** More neighbours than this in one report is a decode error (null). */
export const MAX_NEIGHBORS_PER_REPORT = 64
/** NeighborInfo field budget: the neighbour cap plus room for the scalar fields. */
const MAX_NEIGHBOR_INFO_FIELDS = MAX_NEIGHBORS_PER_REPORT + 16

export interface MeshDeviceMetricsFields {
	/** Raw uint32. Values above 100 mean externally powered (interpreted by the tracker). */
	batteryLevel: number | null
	voltage: number | null
	channelUtilization: number | null
	airUtilTx: number | null
	uptimeSeconds: number | null
}

export interface MeshTelemetryFields {
	/** Null when the packet carries another variant (environment, power, ...). */
	deviceMetrics: MeshDeviceMetricsFields | null
}

export interface MeshNeighborFields {
	nodeNum: number
	snr: number | null
}

export interface MeshNeighborInfoFields {
	/** Null when NeighborInfo.node_id is absent. */
	nodeNum: number | null
	neighbors: MeshNeighborFields[]
}

/** uint32: low 32 bits of the varint, unsigned. Wrong wire type is null. */
function readUint32(cursor: Cursor, wire: number): number | null {
	if (wire !== WIRE_VARINT) return null
	const small = readSmallVarint(cursor)
	if (small >= 0) return small
	const value = readVarintSlow(cursor)
	if (value === null) return null
	return Number(value & 0xffffffffn) >>> 0
}

/** Scratch view for float decoding: avoids a DataView allocation per field. */
const FLOAT_VIEW = new DataView(new ArrayBuffer(4))

/** float (fixed32, LE). undefined = malformed; non-finite = null (not an error). */
function readFloat(cursor: Cursor, wire: number): number | null | undefined {
	if (wire !== WIRE_FIXED32) return undefined
	if (cursor.offset + 4 > cursor.end) return undefined
	const { bytes, offset } = cursor
	FLOAT_VIEW.setUint32(
		0,
		((bytes[offset] ?? 0) |
			((bytes[offset + 1] ?? 0) << 8) |
			((bytes[offset + 2] ?? 0) << 16) |
			((bytes[offset + 3] ?? 0) << 24)) >>>
			0,
		true,
	)
	const value = FLOAT_VIEW.getFloat32(0, true)
	cursor.offset += 4
	return Number.isFinite(value) ? value : null
}

/**
 * Length prefix of a sub-message, bounded by the enclosing message. Leaves the
 * cursor at the sub-message start; the caller walks [offset, offset + length)
 * in place (no copy) and then advances past it. Null on a malformed prefix.
 */
function readSubMessageLength(cursor: Cursor, wire: number): number | null {
	if (wire !== WIRE_LENGTH) return null
	const small = readSmallVarint(cursor)
	if (small >= 0) return small > cursor.end - cursor.offset ? null : small
	const length = readVarintSlow(cursor)
	if (length === null) return null
	if (length > BigInt(cursor.end - cursor.offset)) return null
	return Number(length)
}

function readDeviceMetrics(
	bytes: Uint8Array,
	start: number,
	end: number,
): MeshDeviceMetricsFields | null {
	const out: MeshDeviceMetricsFields = {
		batteryLevel: null,
		voltage: null,
		channelUtilization: null,
		airUtilTx: null,
		uptimeSeconds: null,
	}
	const ok = walk(
		bytes,
		(field, wire, cursor) => {
			if (field === DEVICE_BATTERY_LEVEL || field === DEVICE_UPTIME_SECONDS) {
				const value = readUint32(cursor, wire)
				if (value === null) return "bad"
				if (field === DEVICE_BATTERY_LEVEL) out.batteryLevel = value
				else out.uptimeSeconds = value
				return "handled"
			}
			if (
				field === DEVICE_VOLTAGE ||
				field === DEVICE_CHANNEL_UTILIZATION ||
				field === DEVICE_AIR_UTIL_TX
			) {
				const read = readFloat(cursor, wire)
				if (read === undefined) return "bad"
				if (field === DEVICE_VOLTAGE) out.voltage = read
				else if (field === DEVICE_CHANNEL_UTILIZATION)
					out.channelUtilization = read
				else out.airUtilTx = read
				return "handled"
			}
			return "unknown"
		},
		MAX_FIELDS,
		start,
		end,
	)
	return ok ? out : null
}

/**
 * Telemetry (port 67). Only device_metrics is decoded (one nested level);
 * Telemetry.time and the other oneof variants are skipped, giving
 * `deviceMetrics: null`. Malformed input is null; never throws.
 */
export function readTelemetry(bytes: Uint8Array): MeshTelemetryFields | null {
	try {
		const view = asBytes(bytes)
		if (!view) return null
		let deviceMetrics: MeshDeviceMetricsFields | null = null
		const ok = walk(view, (field, wire, cursor) => {
			if (field === TELEMETRY_TIME) return "unknown"
			if (field === TELEMETRY_DEVICE_METRICS) {
				const length = readSubMessageLength(cursor, wire)
				if (length === null) return "bad"
				const start = cursor.offset
				cursor.offset += length
				const metrics = readDeviceMetrics(view, start, cursor.offset)
				if (metrics === null) return "bad"
				deviceMetrics = metrics
				return "handled"
			}
			return "unknown"
		})
		if (!ok) return null
		return { deviceMetrics }
	} catch {
		return null
	}
}

/** Neighbor sub-message. `undefined` = valid but no node_id (skipped by the caller). */
function readNeighbor(
	bytes: Uint8Array,
	start: number,
	end: number,
): MeshNeighborFields | null | undefined {
	let nodeNum: number | null = null
	let snr: number | null = null
	const ok = walk(
		bytes,
		(field, wire, cursor) => {
			if (field === NEIGHBOR_NODE_ID) {
				const value = readUint32(cursor, wire)
				if (value === null) return "bad"
				nodeNum = value
				return "handled"
			}
			if (field === NEIGHBOR_SNR) {
				const read = readFloat(cursor, wire)
				if (read === undefined) return "bad"
				snr = read
				return "handled"
			}
			return "unknown"
		},
		MAX_FIELDS,
		start,
		end,
	)
	if (!ok) return null
	if (nodeNum === null) return undefined
	return { nodeNum, snr }
}

/**
 * NeighborInfo (port 71). Reads node_id and up to 64 neighbours (one nested
 * level); more than 64 Neighbor entries rejects the report. A well-formed
 * Neighbor without node_id is skipped (it names no link) but still counts
 * toward the cap. last_sent_by_id and node_broadcast_interval_secs are
 * skipped. Malformed input is null; never throws.
 */
export function readNeighborInfo(
	bytes: Uint8Array,
): MeshNeighborInfoFields | null {
	try {
		const view = asBytes(bytes)
		if (!view) return null
		let nodeNum: number | null = null
		const neighbors: MeshNeighborFields[] = []
		let entries = 0
		const ok = walk(
			view,
			(field, wire, cursor) => {
				if (field === NEIGHBOR_INFO_NODE_ID) {
					const value = readUint32(cursor, wire)
					if (value === null) return "bad"
					nodeNum = value
					return "handled"
				}
				if (field === NEIGHBOR_INFO_NEIGHBORS) {
					entries += 1
					if (entries > MAX_NEIGHBORS_PER_REPORT) return "bad"
					const length = readSubMessageLength(cursor, wire)
					if (length === null) return "bad"
					const start = cursor.offset
					cursor.offset += length
					const neighbor = readNeighbor(view, start, cursor.offset)
					if (neighbor === null) return "bad"
					if (neighbor !== undefined) neighbors.push(neighbor)
					return "handled"
				}
				return "unknown"
			},
			MAX_NEIGHBOR_INFO_FIELDS,
		)
		if (!ok) return null
		return { nodeNum, neighbors }
	} catch {
		return null
	}
}
