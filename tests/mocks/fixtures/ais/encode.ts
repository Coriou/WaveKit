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
		talker?: "AIVDM" | "AIVDO"
	},
): string[] {
	const maxChars = options?.maxPayloadChars ?? 48
	const channel = options?.channel ?? "A"
	const seqId = options?.seqId ?? 0
	if (payload.length <= maxChars) {
		return [
			toNmeaSentence(payload, fillBits, {
				channel,
				...(options?.talker ? { talker: options.talker } : {}),
			}),
		]
	}
	const parts: string[] = []
	for (let i = 0; i < payload.length; i += maxChars) {
		parts.push(payload.slice(i, i + maxChars))
	}
	return parts.map((part, index) => {
		const fragment = index + 1
		const fill = fragment === parts.length ? fillBits : 0
		const body = `${options?.talker ?? "AIVDM"},${parts.length},${fragment},${seqId},${channel},${part},${fill}`
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

export interface Type4Fields {
	mmsi: number
	lonRaw: number
	latRaw: number
}

export interface Type9Fields {
	mmsi: number
	/** 0–4095 (4095 not available). */
	altitude: number
	/** Whole knots 0–1023 (1023 not available). */
	sogKnots: number
	lonRaw: number
	latRaw: number
	cogTenths: number
}

export interface Type21Fields {
	mmsi: number
	aidType: number
	/** Up to 34 AIS text characters; above 20 they go to the name extension. */
	name: string
	lonRaw: number
	latRaw: number
	/** UTC second 0–63 (60–63 not available). */
	second: number
	offPosition: boolean
	virtualAid: boolean
	/** Extra bits appended after the extension (0–5), to test partial characters. */
	trailingBits?: string
}

/** Type 4 base station report. 168 bits. */
export function encodeType4(fields: Type4Fields): ArmoredPayload {
	return header(4, fields.mmsi)
		.u(2026, 14)
		.u(1, 4)
		.u(1, 5)
		.u(0, 5)
		.u(0, 6)
		.u(0, 6)
		.u(0, 1)
		.s(fields.lonRaw, 28)
		.s(fields.latRaw, 27)
		.u(1, 4)
		.u(0, 10)
		.u(0, 1)
		.u(0, 19)
		.finish()
}

/** Type 9 SAR aircraft position. 168 bits. */
export function encodeType9(fields: Type9Fields): ArmoredPayload {
	return header(9, fields.mmsi)
		.u(fields.altitude, 12)
		.u(fields.sogKnots, 10)
		.u(0, 1)
		.s(fields.lonRaw, 28)
		.s(fields.latRaw, 27)
		.u(fields.cogTenths, 12)
		.u(60, 6)
		.u(0, 8)
		.u(0, 1)
		.u(0, 3)
		.u(0, 1)
		.u(0, 1)
		.u(0, 20)
		.finish()
}

/** Type 21 aid to navigation. 272 bits plus the name extension. */
export function encodeType21(fields: Type21Fields): ArmoredPayload {
	if (fields.name.length > 34) throw new Error("type 21 name is at most 34")
	const writer = header(21, fields.mmsi)
		.u(fields.aidType, 5)
		.text(fields.name.slice(0, 20), 20)
		.u(0, 1)
		.s(fields.lonRaw, 28)
		.s(fields.latRaw, 27)
		.u(0, 9)
		.u(0, 9)
		.u(0, 6)
		.u(0, 6)
		.u(1, 4)
		.u(fields.second, 6)
		.u(fields.offPosition ? 1 : 0, 1)
		.u(0, 8)
		.u(0, 1)
		.u(fields.virtualAid ? 1 : 0, 1)
		.u(0, 1)
		.u(0, 1)
	const extension = fields.name.slice(20)
	if (extension.length > 0) writer.text(extension, extension.length)
	if (fields.trailingBits) {
		for (const bit of fields.trailingBits) writer.u(bit === "1" ? 1 : 0, 1)
	}
	return writer.finish()
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

/**
 * `nmea-sample.txt`. Every sentence is encoded here and carries a valid
 * NMEA XOR checksum. The previous hand-written file did not.
 */
export function renderNmeaSampleFixture(): string {
	const lines: string[] = [
		"# AIS NMEA sample. Generated by tests/mocks/fixtures/ais/encode.ts.",
		"# Checksums are the NMEA XOR of the characters between ! and *.",
		"# Do not hand-edit the sentences.",
		"",
	]
	const push = (
		comment: string,
		armored: ArmoredPayload,
		options?: {
			channel?: "A" | "B"
			seqId?: number
			talker?: "AIVDM" | "AIVDO"
		},
	) => {
		lines.push(`# ${comment}`)
		lines.push(
			...toNmeaFragments(armored.payload, armored.fillBits, {
				channel: options?.channel ?? "A",
				seqId: options?.seqId ?? 1,
				maxPayloadChars: 48,
				...(options?.talker ? { talker: options.talker } : {}),
			}),
		)
	}
	push(
		"Type 1 class A cargo under way (channel A)",
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
		"Type 1 class A tanker at anchor (channel B)",
		encodeType1({
			mmsi: 234567890,
			navStatus: 1,
			sogTenths: 0,
			lonRaw: 2_680_260,
			latRaw: 31_143_240,
			cogTenths: 0,
			heading: 45,
		}),
		{ channel: "B" },
	)
	push(
		"Type 2 class A passenger under way (channel A)",
		encodeType1(
			{
				mmsi: 345678901,
				navStatus: 0,
				sogTenths: 185,
				lonRaw: -48_115_080,
				latRaw: 15_457_020,
				cogTenths: 2702,
				heading: 268,
			},
			2,
		),
	)
	push(
		"Type 3 class A fishing (channel B)",
		encodeType1(
			{
				mmsi: 456789012,
				navStatus: 7,
				sogTenths: 52,
				lonRaw: -1_977_000,
				latRaw: 35_381_400,
				cogTenths: 458,
				heading: 50,
			},
			3,
		),
		{ channel: "B" },
	)
	push(
		"Type 18 class B pleasure craft (channel A)",
		encodeType18({
			mmsi: 567890123,
			sogTenths: 68,
			lonRaw: 3_221_880,
			latRaw: 25_977_900,
			cogTenths: 1350,
			heading: 140,
		}),
	)
	push(
		"Type 18 class B sailing (channel B)",
		encodeType18({
			mmsi: 678901234,
			sogTenths: 41,
			lonRaw: 2_100_000,
			latRaw: 34_200_000,
			cogTenths: 900,
			heading: 90,
		}),
		{ channel: "B" },
	)
	push(
		"Type 19 extended class B (channel A)",
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
		{ seqId: 2 },
	)
	push(
		"Type 5 static and voyage, two fragments (channel B)",
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
		{ channel: "B", seqId: 3 },
	)
	push(
		"Type 24A class B name",
		encodeType24A({ mmsi: 333456789, name: "FISHING KING" }),
		{ seqId: 4 },
	)
	push(
		"Type 24B class B ship type and callsign",
		encodeType24B({
			mmsi: 333456789,
			shipType: 30,
			callsign: "KC1234",
		}),
		{ seqId: 5 },
	)
	push(
		"Type 1 own-ship AIVDO",
		encodeType1({
			mmsi: 111234567,
			navStatus: 0,
			sogTenths: 10,
			lonRaw: -44_000_000,
			latRaw: 24_000_000,
			cogTenths: 100,
			heading: 10,
		}),
		{ talker: "AIVDO" },
	)
	lines.push("")
	return lines.join("\n")
}

/** Replace a valid checksum with `00`, or `01` when it already is `00`. */
function corruptChecksum(sentence: string): string {
	const star = sentence.indexOf("*")
	const hex = sentence.slice(star + 1)
	return `${sentence.slice(0, star + 1)}${hex === "00" ? "01" : "00"}`
}

/**
 * `nmea-bad-checksum.txt`. Every sentence is intentionally rejected.
 * Built from the encoder, then broken. Not loaded by `loadNmeaSample`.
 */
export function renderBadChecksumFixture(): string {
	const position = encodeType1({
		mmsi: 123456789,
		navStatus: 0,
		sogTenths: 123,
		lonRaw: -44_403_600,
		latRaw: 24_427_680,
		cogTenths: 1805,
		heading: 179,
	})
	const valid = toNmeaSentence(position.payload, position.fillBits)
	const lines = [
		"# Intentionally invalid AIS NMEA. Generated by encode.ts.",
		"# Every sentence below must be rejected. Do not correct the checksums.",
		"",
		"# Wrong checksum on an otherwise valid type 1 sentence",
		corruptChecksum(valid),
		"# Checksum delimiter missing",
		valid.slice(0, valid.indexOf("*")),
		"# Space inside the checksum span; the hex is the checksum of the unspaced body",
		`${valid.slice(0, valid.indexOf("*"))} ${valid.slice(valid.indexOf("*"))}`,
		"# Lowercase hex that is not the correct checksum",
		`${valid.slice(0, valid.indexOf("*") + 1)}ab`,
		"",
	]
	return lines.join("\n")
}
