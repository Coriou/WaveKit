/**
 * AIS payload encoder for tests. Produces 6-bit armored payloads and NMEA
 * sentences. Not a decoder fixture downloaded from anywhere: every sentence
 * is built from the field values below.
 */

const TEXT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 "

export interface ArmoredPayload {
	payload: string
	fillBits: number
}

export interface Type1Fields {
	mmsi: number
	navStatus: number
	sogTenths: number
	lonRaw: number
	latRaw: number
	cogTenths: number
	heading: number
}

export interface Type18Fields {
	mmsi: number
	sogTenths: number
	lonRaw: number
	latRaw: number
	cogTenths: number
	heading: number
}

export interface Type5Fields {
	mmsi: number
	imo: number
	callsign: string
	name: string
	shipType: number
	month: number
	day: number
	hour: number
	minute: number
	draughtTenths: number
	destination: string
}

export interface Type19Fields {
	mmsi: number
	sogTenths: number
	lonRaw: number
	latRaw: number
	cogTenths: number
	heading: number
	name: string
	shipType: number
}

export interface Type24AFields {
	mmsi: number
	name: string
}

export interface Type24BFields {
	mmsi: number
	shipType: number
	callsign: string
}

class BitWriter {
	private bits = ""

	u(value: number, width: number): this {
		if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) {
			throw new Error(`unsigned ${value} does not fit in ${width} bits`)
		}
		this.bits += value.toString(2).padStart(width, "0")
		return this
	}

	s(value: number, width: number): this {
		const limit = 2 ** (width - 1)
		if (!Number.isInteger(value) || value < -limit || value >= limit) {
			throw new Error(`signed ${value} does not fit in ${width} bits`)
		}
		const unsigned = value < 0 ? value + 2 ** width : value
		return this.u(unsigned, width)
	}

	text(value: string, chars: number): this {
		const padded = value.padEnd(chars, "@").slice(0, chars)
		for (const char of padded) this.u(charToSixBit(char), 6)
		return this
	}

	finish(): ArmoredPayload {
		const fillBits = (6 - (this.bits.length % 6)) % 6
		const padded = this.bits + "0".repeat(fillBits)
		let payload = ""
		for (let i = 0; i < padded.length; i += 6) {
			payload += sixBitChar(Number.parseInt(padded.slice(i, i + 6), 2))
		}
		return { payload, fillBits }
	}
}

/** ITU six-bit text character (not the NMEA armor alphabet). */
function charToSixBit(char: string): number {
	const code = char.charCodeAt(0)
	if (code >= 64 && code <= 95) return code - 64
	if (code >= 32 && code <= 63) return code
	throw new Error(`character ${char} is not AIS text`)
}

/** Armor an already-built bit string. Fill bits are the unused low bits. */
export function armorBitString(bits: string): ArmoredPayload {
	if (!/^[01]+$/.test(bits)) throw new Error("bit string must be 0 and 1")
	const fillBits = (6 - (bits.length % 6)) % 6
	const padded = bits + "0".repeat(fillBits)
	let payload = ""
	for (let i = 0; i < padded.length; i += 6) {
		payload += sixBitChar(Number.parseInt(padded.slice(i, i + 6), 2))
	}
	return { payload, fillBits }
}

/** Inverse of the NMEA armor, with fill bits removed. */
export function unarmorBits(payload: string, fillBits: number): string {
	let bits = ""
	for (const char of payload) {
		const code = char.charCodeAt(0)
		let value = code - 48
		if (value > 40) value -= 8
		if (value < 0 || value > 63) {
			throw new Error(`invalid armor character ${char}`)
		}
		bits += value.toString(2).padStart(6, "0")
	}
	if (fillBits < 0 || fillBits > bits.length) {
		throw new Error("fill bits out of range")
	}
	return bits.slice(0, bits.length - fillBits)
}

/** NMEA armor character. Values 40–63 are shifted up by 8, matching the decoder. */
export function sixBitChar(value: number): string {
	if (!Number.isInteger(value) || value < 0 || value > 63) {
		throw new Error(`armor value ${value} out of range`)
	}
	return String.fromCharCode(value + (value >= 40 ? 56 : 48))
}

export function nmeaChecksum(body: string): string {
	let checksum = 0
	for (let i = 0; i < body.length; i++) {
		checksum ^= body.charCodeAt(i)
	}
	return checksum.toString(16).toUpperCase().padStart(2, "0")
}

export function toNmeaSentence(
	payload: string,
	fillBits: number,
	options?: { channel?: "A" | "B"; talker?: "AIVDM" | "AIVDO" },
): string {
	const channel = options?.channel ?? "A"
	const talker = options?.talker ?? "AIVDM"
	const body = `${talker},1,1,,${channel},${payload},${fillBits}`
	return `!${body}*${nmeaChecksum(body)}`
}

/** Split a payload into NMEA sentences. Fill bits apply only to the last one. */
export function toNmeaFragments(
	payload: string,
	fillBits: number,
	options?: {
		channel?: "A" | "B"
		seqId?: number
		maxPayloadChars?: number
	},
): string[] {
	const maxChars = options?.maxPayloadChars ?? 48
	const channel = options?.channel ?? "A"
	const seqId = options?.seqId ?? 0
	if (payload.length <= maxChars) {
		return [toNmeaSentence(payload, fillBits, { channel })]
	}
	const parts: string[] = []
	for (let i = 0; i < payload.length; i += maxChars) {
		parts.push(payload.slice(i, i + maxChars))
	}
	return parts.map((part, index) => {
		const fragment = index + 1
		const fill = fragment === parts.length ? fillBits : 0
		const body = `AIVDM,${parts.length},${fragment},${seqId},${channel},${part},${fill}`
		return `!${body}*${nmeaChecksum(body)}`
	})
}

function header(type: number, mmsi: number): BitWriter {
	return new BitWriter().u(type, 6).u(0, 2).u(mmsi, 30)
}

/** Type 1/2/3 class A position. `type` defaults to 1. 168 bits. */
export function encodeType1(
	fields: Type1Fields,
	type: 1 | 2 | 3 = 1,
): ArmoredPayload {
	return header(type, fields.mmsi)
		.u(fields.navStatus, 4)
		.u(128, 8)
		.u(fields.sogTenths, 10)
		.u(0, 1)
		.s(fields.lonRaw, 28)
		.s(fields.latRaw, 27)
		.u(fields.cogTenths, 12)
		.u(fields.heading, 9)
		.u(60, 6)
		.u(0, 2)
		.u(0, 1)
		.u(0, 1)
		.u(0, 21)
		.finish()
}

/** Type 18 class B position. 168 bits. */
export function encodeType18(fields: Type18Fields): ArmoredPayload {
	return header(18, fields.mmsi)
		.u(0, 8)
		.u(fields.sogTenths, 10)
		.u(0, 1)
		.s(fields.lonRaw, 28)
		.s(fields.latRaw, 27)
		.u(fields.cogTenths, 12)
		.u(fields.heading, 9)
		.u(60, 6)
		.u(0, 29)
		.finish()
}

/** Type 19 extended class B position. 312 bits. */
export function encodeType19(fields: Type19Fields): ArmoredPayload {
	return header(19, fields.mmsi)
		.u(0, 8)
		.u(fields.sogTenths, 10)
		.u(0, 1)
		.s(fields.lonRaw, 28)
		.s(fields.latRaw, 27)
		.u(fields.cogTenths, 12)
		.u(fields.heading, 9)
		.u(60, 6)
		.u(0, 4)
		.text(fields.name, 20)
		.u(fields.shipType, 8)
		.u(0, 41)
		.finish()
}

/** Type 5 static and voyage. 424 bits, so the NMEA form is two fragments. */
export function encodeType5(fields: Type5Fields): ArmoredPayload {
	return header(5, fields.mmsi)
		.u(0, 2)
		.u(fields.imo, 30)
		.text(fields.callsign, 7)
		.text(fields.name, 20)
		.u(fields.shipType, 8)
		.u(0, 9)
		.u(0, 9)
		.u(0, 6)
		.u(0, 6)
		.u(0, 4)
		.u(fields.month, 4)
		.u(fields.day, 5)
		.u(fields.hour, 5)
		.u(fields.minute, 6)
		.u(fields.draughtTenths, 8)
		.text(fields.destination, 20)
		.u(0, 1)
		.u(0, 1)
		.finish()
}

/** Type 24 part A (name). 160 bits. */
export function encodeType24A(fields: Type24AFields): ArmoredPayload {
	return header(24, fields.mmsi).u(0, 2).text(fields.name, 20).finish()
}

/** Type 24 part B (ship type and callsign). Bits through the callsign. */
export function encodeType24B(fields: Type24BFields): ArmoredPayload {
	return header(24, fields.mmsi)
		.u(1, 2)
		.u(fields.shipType, 8)
		.text("", 7)
		.text(fields.callsign, 7)
		.finish()
}

export const AIS_TEXT_ALPHABET = TEXT_ALPHABET

/** Fixed vessels encoded into generated-nmea.txt. */
export function renderGeneratedNmeaFixture(): string {
	const lines: string[] = [
		"# Generated by tests/mocks/fixtures/ais/encode.ts",
		"# Field values are encoded here. Do not hand-edit the sentences.",
		"",
	]
	const push = (comment: string, armored: ArmoredPayload, seqId = 1) => {
		lines.push(`# ${comment}`)
		lines.push(
			...toNmeaFragments(armored.payload, armored.fillBits, {
				channel: "A",
				seqId,
				maxPayloadChars: 48,
			}),
		)
	}
	push(
		"type 1 mmsi 123456789",
		encodeType1({
			mmsi: 123456789,
			navStatus: 0,
			sogTenths: 123,
			lonRaw: -44_403_600,
			latRaw: 24_427_680,
			cogTenths: 1805,
			heading: 179,
		}),
	)
	push(
		"type 18 mmsi 567890123",
		encodeType18({
			mmsi: 567890123,
			sogTenths: 68,
			lonRaw: 3_221_880,
			latRaw: 25_977_900,
			cogTenths: 1350,
			heading: 140,
		}),
		2,
	)
	push(
		"type 5 mmsi 555678901",
		encodeType5({
			mmsi: 555678901,
			imo: 9056789,
			callsign: "GBTT",
			name: "ATLANTIC VOYAGER",
			shipType: 70,
			month: 1,
			day: 15,
			hour: 14,
			minute: 0,
			draughtTenths: 128,
			destination: "SOUTHAMPTON",
		}),
		3,
	)
	push(
		"type 24A mmsi 333456789",
		encodeType24A({ mmsi: 333456789, name: "FISHING KING" }),
		4,
	)
	push(
		"type 24B mmsi 333456789",
		encodeType24B({
			mmsi: 333456789,
			shipType: 30,
			callsign: "KC1234",
		}),
		5,
	)
	push(
		"type 19 mmsi 246801357",
		encodeType19({
			mmsi: 246801357,
			sogTenths: 45,
			lonRaw: 2_940_600,
			latRaw: 31_420_560,
			cogTenths: 900,
			heading: 88,
			name: "WIND DANCER",
			shipType: 36,
		}),
		6,
	)
	lines.push("")
	return lines.join("\n")
}
