import { describe, expect, it } from "vitest"
import {
	acarsAudio,
	acarsBytes,
	acarsCrc,
	oddParity,
} from "../../../../scripts/fixtures/acars-msk.mjs"

describe("synthetic ACARS fixture", () => {
	it("every block character has odd parity and the CRC leaves a zero residue", () => {
		const bytes = acarsBytes()
		const soh = bytes.indexOf(0x01)
		const del = bytes.lastIndexOf(0x7f)
		const block = bytes.slice(soh + 1, del - 2)
		for (const b of block) {
			let ones = 0
			for (let i = 0; i < 8; i++) ones += (b >> i) & 1
			expect(ones % 2).toBe(1)
		}
		expect(block.at(-1)).toBe(0x83) // ETX with parity
		expect(acarsCrc(bytes.slice(soh + 1, del))).toBe(0)
		expect(oddParity(0x2b)).toBe(0xab)
	})

	it("MSK at 2 400 bit/s: 5 audio samples per bit at 12 kHz, 20 at 48 kHz", () => {
		const bits = acarsBytes().length * 8
		expect(acarsAudio({}, 12_000, 0).length).toBe(bits * 5)
		expect(acarsAudio({}, 48_000, 0).length).toBe(bits * 20)
	})
})
