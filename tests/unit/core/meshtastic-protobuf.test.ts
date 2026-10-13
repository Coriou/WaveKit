/**
 * Meshtastic protobuf reader: known bytes, bounds and malformed payloads.
 */

import { describe, expect, it } from "vitest"
import {
	readPosition,
	readUser,
} from "../../../src/core/meshtastic-protobuf.js"
import {
	encodePosition,
	encodeUser,
} from "../../mocks/fixtures/meshtastic/encode.js"

function varint(value: number): number[] {
	const out: number[] = []
	let rest = value
	for (;;) {
		const byte = rest & 0x7f
		rest = Math.floor(rest / 128)
		if (rest === 0) {
			out.push(byte)
			return out
		}
		out.push(byte | 0x80)
	}
}

describe("readPosition", () => {
	it("decodes a hand-built 10 degree latitude and skips unknown fields", () => {
		// field 1, wire 5, sfixed32 100_000_000 = 10 degrees: 0d 00 e1 f5 05
		// field 20, wire 1 (fixed64) then 8 bytes, then field 9 length-delimited
		const bytes = Uint8Array.from([
			0x0d, 0x00, 0xe1, 0xf5, 0x05, 0xa1, 0x01, 1, 2, 3, 4, 5, 6, 7, 8, 0x4a,
			0x03, 0x01, 0x02, 0x03,
		])
		expect(readPosition(bytes)).toEqual({
			lat: 10,
			lon: 0,
			altitudeM: null,
			timeS: null,
		})
	})

	it("round-trips altitude 0, a negative altitude and time 0", () => {
		const encoded = encodePosition({
			latitudeI: -10_000_000,
			longitudeI: 1_800_000_000,
			altitudeM: 0,
			timeS: 0,
		})
		const read = readPosition(encoded)
		expect(read?.lat).toBeCloseTo(-1, 6)
		expect(read?.lon).toBeCloseTo(180, 6)
		expect(read?.altitudeM).toBe(0)
		expect(read?.timeS).toBe(0)
		const below = encodePosition({ altitudeM: -5 })
		expect(below.length).toBe(11)
		expect(readPosition(below)?.altitudeM).toBe(-5)
	})

	it("treats an empty payload as a default position, not an error", () => {
		expect(readPosition(new Uint8Array())).toEqual({
			lat: 0,
			lon: 0,
			altitudeM: null,
			timeS: null,
		})
	})

	it("reads a view that does not start at byte 0", () => {
		const encoded = encodePosition({ latitudeI: 100_000_000 })
		const padded = new Uint8Array(encoded.length + 5)
		padded.set(encoded, 2)
		expect(readPosition(padded.subarray(2, 2 + encoded.length))?.lat).toBe(10)
	})

	it("accepts 64 fields and rejects a 65th, groups and wire types 6 and 7", () => {
		const ok: number[] = []
		for (let field = 10; field < 73; field++) {
			ok.push(...varint(field << 3), 0)
		}
		ok.push(0x0d, 0x00, 0xe1, 0xf5, 0x05)
		expect(readPosition(Uint8Array.from(ok))?.lat).toBe(10)
		const tooMany = [...ok]
		tooMany.push(...varint(80 << 3), 0)
		expect(readPosition(Uint8Array.from(tooMany))).toBeNull()
		expect(readPosition(Uint8Array.from([0x0b]))).toBeNull()
		expect(readPosition(Uint8Array.from([0x0e]))).toBeNull()
		expect(readPosition(Uint8Array.from([0x0f]))).toBeNull()
	})

	it("rejects a truncated fixed32, an over-long varint and a length past the end", () => {
		expect(readPosition(Uint8Array.from([0x25, 0x01, 0x02]))).toBeNull()
		const eleven = new Uint8Array(11).fill(0x80)
		eleven[10] = 0x01
		expect(readPosition(eleven)).toBeNull()
		expect(readPosition(Uint8Array.from([0x1a, 0x05, 0x01]))).toBeNull()
		expect(readPosition(Uint8Array.from([0x08, 0x01]))).toBeNull()
		// Field number 536870912 is above the proto3 maximum of 2^29-1.
		const hugeField = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x10, 0x00])
		expect(readPosition(hugeField)).toBeNull()
		expect(readUser(hugeField)).toBeNull()
	})

	it("returns null for a non-Uint8Array and never throws", () => {
		expect(readPosition(undefined as unknown as Uint8Array)).toBeNull()
		expect(readPosition("nope" as unknown as Uint8Array)).toBeNull()
	})
})

describe("readUser", () => {
	it("decodes a hand-built user and keeps false licensed distinct from absent", () => {
		const hand = Uint8Array.from([
			0x0a, 0x09, 0x21, 0x61, 0x62, 0x31, 0x32, 0x63, 0x64, 0x33, 0x34, 0x12,
			0x03, 0x41, 0x64, 0x61, 0x28, 0x2b, 0x30, 0x00, 0x38, 0x02,
		])
		expect(readUser(hand)).toEqual({
			id: "!ab12cd34",
			longName: "Ada",
			shortName: null,
			hwModel: 43,
			isLicensed: false,
			role: 2,
		})
		expect(readUser(new Uint8Array())?.isLicensed).toBeNull()
	})

	it("accepts names at the byte cap and rejects one byte over, bad UTF-8 and controls", () => {
		const longOk = "é".repeat(20)
		expect(Buffer.byteLength(longOk)).toBe(40)
		expect(readUser(encodeUser({ longName: longOk }))?.longName).toBe(longOk)
		expect(readUser(encodeUser({ longName: `${longOk}!` }))).toBeNull()
		expect(readUser(encodeUser({ shortName: "12345678" }))?.shortName).toBe(
			"12345678",
		)
		expect(readUser(encodeUser({ shortName: "123456789" }))).toBeNull()
		expect(readUser(encodeUser({ shortName: "😀😀" }))?.shortName).toBe("😀😀")
		expect(readUser(encodeUser({ shortName: "😀😀😀" }))).toBeNull()
		expect(readUser(Uint8Array.from([0x12, 0x01, 0xff]))).toBeNull()
		expect(readUser(Uint8Array.from([0x12, 0x01, 0xc3]))).toBeNull()
		expect(readUser(Uint8Array.from([0x12, 0x01, 0x0a]))).toBeNull()
		expect(readUser(Uint8Array.from([0x12, 0x01, 0x7f]))).toBeNull()
		expect(readUser(Uint8Array.from([0x30, 0x02]))).toBeNull()
		const bomName = "\uFEFFAda"
		expect(readUser(encodeUser({ longName: bomName }))?.longName).toBe(bomName)
		expect(readUser(encodeUser({ id: "\uFEFF!00000001" }))?.id).toBe(
			"\uFEFF!00000001",
		)
	})

	it("returns null for a length that runs past the buffer", () => {
		expect(readUser(Uint8Array.from([0x12, 0x28]))).toBeNull()
		expect(readUser(undefined as unknown as Uint8Array)).toBeNull()
	})
})
