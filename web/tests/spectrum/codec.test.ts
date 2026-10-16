import { describe, expect, it } from "vitest"
import {
	byteToDb,
	dbToByte,
	decodeBase64Into,
	decodedLength,
	levelsToLinear,
} from "../../src/spectrum/codec.ts"

function randomBytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n)
	let x = seed
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) >>> 0
		out[i] = x >>> 24
	}
	return out
}

describe("decodeBase64Into", () => {
	it("matches Buffer for every length 0–64 and a 2048-bin row", () => {
		const buf = new Uint8Array(4096)
		for (const n of [...Array.from({ length: 65 }, (_, i) => i), 410, 2048]) {
			const bytes = randomBytes(n, n + 1)
			const b64 = Buffer.from(bytes).toString("base64")
			expect(decodedLength(b64)).toBe(n)
			const written = decodeBase64Into(b64, buf)
			expect(written).toBe(n)
			expect(Array.from(buf.subarray(0, n))).toEqual(Array.from(bytes))
		}
	})

	it("reuses the caller's buffer without touching bytes past the row", () => {
		const buf = new Uint8Array(8).fill(9)
		expect(
			decodeBase64Into(Buffer.from([1, 2, 3]).toString("base64"), buf),
		).toBe(3)
		expect(Array.from(buf)).toEqual([1, 2, 3, 9, 9, 9, 9, 9])
		expect(decodeBase64Into(Buffer.from([7]).toString("base64"), buf)).toBe(1)
		expect(buf[0]).toBe(7)
		expect(buf[1]).toBe(2)
	})

	it("accepts unpadded input", () => {
		const buf = new Uint8Array(4)
		expect(decodeBase64Into("AQID", buf)).toBe(3)
		expect(decodeBase64Into("AQI", buf)).toBe(2)
		expect(Array.from(buf.subarray(0, 2))).toEqual([1, 2])
	})

	it("rejects bad characters, impossible lengths and a short buffer", () => {
		const buf = new Uint8Array(16)
		expect(decodeBase64Into("AQ*D", buf)).toBe(-1)
		expect(decodeBase64Into("AQIDB", buf)).toBe(-1)
		expect(decodeBase64Into("é===", buf)).toBe(-1)
		expect(decodeBase64Into("AQIDBAUG", new Uint8Array(5))).toBe(-1)
	})
})

describe("dB ↔ byte (u8-halfdb-127.5)", () => {
	it("maps the encoding's ends and steps", () => {
		expect(byteToDb(0)).toBe(-127.5)
		expect(byteToDb(255)).toBe(0)
		expect(byteToDb(1)).toBe(-127)
		expect(dbToByte(-127.5)).toBe(0)
		expect(dbToByte(0)).toBe(255)
		expect(dbToByte(-92.5)).toBe(70)
	})

	it("round-trips every byte and clamps out-of-range dB", () => {
		for (let v = 0; v < 256; v++) expect(dbToByte(byteToDb(v))).toBe(v)
		expect(dbToByte(-200)).toBe(0)
		expect(dbToByte(10)).toBe(255)
		expect(dbToByte(Number.NaN)).toBe(0)
	})

	it("levelsToLinear puts minDb at 0 and maxDb at 1 of the colour ramp", () => {
		const { scale, offset } = levelsToLinear(-110, -30)
		const t = (db: number) => (dbToByte(db) / 255) * scale + offset
		expect(t(-110)).toBeCloseTo(0, 6)
		expect(t(-30)).toBeCloseTo(1, 6)
		expect(t(-70)).toBeCloseTo(0.5, 6)
	})

	it("levelsToLinear never divides by zero", () => {
		const { scale, offset } = levelsToLinear(-50, -50)
		expect(Number.isFinite(scale)).toBe(true)
		expect(Number.isFinite(offset)).toBe(true)
	})
})
