/**
 * Hand-written Meshtastic Position and User fixtures (WG2 lane N).
 *
 * Field numbers match src/core/meshtastic-protobuf.ts. No downloads.
 * A provided 0 / false / "" is written; an omitted field is left off the wire
 * so a reader can tell "absent" from "present and zero".
 */

import type { MeshtasticPacket } from "../../../../src/decoders/builtin/lora-meshtastic.js"

export interface PositionFixture {
	/** sfixed32 degrees × 1e7. */
	latitudeI?: number | undefined
	longitudeI?: number | undefined
	/** int32 metres. */
	altitudeM?: number | undefined
	/** fixed32 unix seconds. */
	timeS?: number | undefined
}

export interface UserFixture {
	id?: string | undefined
	longName?: string | undefined
	shortName?: string | undefined
	hwModel?: number | undefined
	isLicensed?: boolean | undefined
	role?: number | undefined
}

export interface MeshPacketFixture {
	from?: number | undefined
	to?: number | undefined
	id?: number | undefined
	channel?: number | undefined
	hopLimit?: number | undefined
	hopStart?: number | undefined
	wantAck?: boolean | undefined
	viaMqtt?: boolean | undefined
	priority?: number | undefined
	portnum?: number | undefined
	payload?: Uint8Array | undefined
	rxRssi?: number | undefined
	rxSnr?: number | undefined
	rxTime?: string | undefined
	frequency?: number | undefined
	bw?: number | undefined
	sf?: number | undefined
	cr?: number | undefined
}

function pushVarint(out: number[], value: bigint): void {
	let rest = value
	if (rest < 0n) rest += 1n << 64n
	for (;;) {
		const byte = Number(rest & 0x7fn)
		rest >>= 7n
		if (rest === 0n) {
			out.push(byte)
			return
		}
		out.push(byte | 0x80)
	}
}

function pushTag(out: number[], field: number, wire: number): void {
	pushVarint(out, BigInt((field << 3) | wire))
}

function pushInt32(out: number[], value: number): void {
	if (value < 0) pushVarint(out, (1n << 64n) + BigInt(value))
	else pushVarint(out, BigInt(value))
}

function pushFixed32(out: number[], value: number, signed: boolean): void {
	const bytes = new Uint8Array(4)
	const view = new DataView(bytes.buffer)
	if (signed) view.setInt32(0, value, true)
	else view.setUint32(0, value, true)
	for (const byte of bytes) out.push(byte)
}

function pushString(out: number[], field: number, value: string): void {
	const bytes = new TextEncoder().encode(value)
	pushTag(out, field, 2)
	pushVarint(out, BigInt(bytes.length))
	for (const byte of bytes) out.push(byte)
}

export function encodePosition(fields: PositionFixture = {}): Uint8Array {
	const out: number[] = []
	if (fields.latitudeI !== undefined) {
		pushTag(out, 1, 5)
		pushFixed32(out, fields.latitudeI, true)
	}
	if (fields.longitudeI !== undefined) {
		pushTag(out, 2, 5)
		pushFixed32(out, fields.longitudeI, true)
	}
	if (fields.altitudeM !== undefined) {
		pushTag(out, 3, 0)
		pushInt32(out, fields.altitudeM)
	}
	if (fields.timeS !== undefined) {
		pushTag(out, 4, 5)
		pushFixed32(out, fields.timeS, false)
	}
	return Uint8Array.from(out)
}

export function encodeUser(fields: UserFixture = {}): Uint8Array {
	const out: number[] = []
	if (fields.id !== undefined) pushString(out, 1, fields.id)
	if (fields.longName !== undefined) pushString(out, 2, fields.longName)
	if (fields.shortName !== undefined) pushString(out, 3, fields.shortName)
	if (fields.hwModel !== undefined) {
		pushTag(out, 5, 0)
		pushInt32(out, fields.hwModel)
	}
	if (fields.isLicensed !== undefined) {
		pushTag(out, 6, 0)
		pushVarint(out, fields.isLicensed ? 1n : 0n)
	}
	if (fields.role !== undefined) {
		pushTag(out, 7, 0)
		pushInt32(out, fields.role)
	}
	return Uint8Array.from(out)
}

/** Adapter-shaped packet. `payload` is base64-encoded into `payloadB64`. */
export function meshPacket(fields: MeshPacketFixture = {}): MeshtasticPacket {
	const payload = fields.payload ?? new Uint8Array()
	const packet: MeshtasticPacket = {
		from: fields.from ?? 0xab12cd34,
		to: fields.to ?? 0xffffffff,
		id: fields.id ?? 1,
		channel: fields.channel ?? 0,
		hopLimit: fields.hopLimit ?? 3,
		hopStart: fields.hopStart ?? 3,
		wantAck: fields.wantAck ?? false,
		portnum: fields.portnum ?? 1,
		payloadB64: Buffer.from(payload).toString("base64"),
		payloadLen: payload.byteLength,
		rxRssi: fields.rxRssi ?? -90,
		rxSnr: fields.rxSnr ?? 5,
		rxTime: fields.rxTime ?? "2026-06-15T12:00:00.000Z",
		frequency: fields.frequency ?? 906_875_000,
		bw: fields.bw ?? 250_000,
		sf: fields.sf ?? 11,
		cr: fields.cr ?? 5,
	}
	if (fields.viaMqtt !== undefined) packet.viaMqtt = fields.viaMqtt
	if (fields.priority !== undefined) packet.priority = fields.priority
	return packet
}
