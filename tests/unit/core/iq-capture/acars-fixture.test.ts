import { describe, expect, it } from "vitest"
import {
	acarsAudio,
	acarsBytes,
	acarsCrc,
	oddParity,
} from "../../../../scripts/fixtures/acars-msk.mjs"

const ascii = (s: string) => [...s].map(c => c.charCodeAt(0))

describe("synthetic ACARS fixture", () => {
	it("CRC-16 matches the KERMIT check value (0x2189 for '123456789')", () => {
		expect(acarsCrc(ascii("123456789"))).toBe(0x2189)
		expect(acarsCrc([])).toBe(0)
	})

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

	it("downlink layout: mode, address, ack, label, block id, STX, message number, flight id, text, ETX", () => {
		const bytes = acarsBytes({
			mode: "2",
			address: "N12345",
			label: "H1",
			blockId: "3",
			msgno: "M07B",
			flight: "XX0042",
			text: "HELLO",
		})
		const soh = bytes.indexOf(0x01)
		const block = bytes
			.slice(soh + 1, bytes.lastIndexOf(0x7f) - 2)
			.map(b => b & 0x7f)
		const s = String.fromCharCode(...block)
		expect(s[0]).toBe("2") // mode
		expect(s.slice(1, 8)).toBe(".N12345") // address, dot-padded on the left
		expect(block[8]).toBe(0x15) // technical ack: NAK
		expect(s.slice(9, 11)).toBe("H1") // label
		expect(s[11]).toBe("3") // block id (digit: downlink)
		expect(block[12]).toBe(0x02) // STX
		expect(s.slice(13, 17)).toBe("M07B") // message number
		expect(s.slice(17, 23)).toBe("XX0042") // flight id
		expect(s.slice(23, -1)).toBe("HELLO")
		expect(block.at(-1)).toBe(0x03) // ETX
	})

	it("the waveform carries the bits: per-bit tone (2 400 Hz = same bit, 1 200 Hz = changed) recovers every byte", () => {
		const rate = 48_000
		const spb = rate / 2_400
		const audio = acarsAudio({}, rate, 0)
		const expected = acarsBytes()
		expect(audio.length).toBe(expected.length * 8 * spb)
		// Independent read-back: the stronger of the two tones over each bit window.
		const power = (start: number, f: number) => {
			let re = 0
			let im = 0
			for (let k = 0; k < spb; k++) {
				const ph = (2 * Math.PI * f * k) / rate
				re += audio[start + k]! * Math.cos(ph)
				im += audio[start + k]! * Math.sin(ph)
			}
			return re * re + im * im
		}
		const bits: number[] = []
		let prev = 1
		for (let b = 0; b < expected.length * 8; b++) {
			const same = power(b * spb, 2_400) > power(b * spb, 1_200)
			prev = same ? prev : 1 - prev
			bits.push(prev)
		}
		const bytes: number[] = []
		for (let i = 0; i < bits.length; i += 8) {
			let v = 0
			for (let k = 0; k < 8; k++) v |= bits[i + k]! << k
			bytes.push(v)
		}
		expect(bytes).toEqual(expected)
	})
})
