import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { parseRiffDurationMs } from "../../../../src/core/recordings/riff.js"

interface Opts {
	format?: number
	channels?: number
	rate?: number
	bits?: number
	byteRate?: number
	blockAlign?: number
	dataSize?: number
	list?: number
	extensible?: { cb?: number; sub?: number; tail?: number[] }
	dataFirst?: boolean
	/** RIFF container size override (default: header bytes after offset 8 plus the data size). */
	riffSize?: number
}

const KS_TAIL = [0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]

function build(o: Opts = {}): Uint8Array {
	const channels = o.channels ?? 1
	const rate = o.rate ?? 8000
	const bits = o.bits ?? 16
	const parts: number[] = []
	const u16 = (v: number) => parts.push(v & 255, (v >> 8) & 255)
	const u32 = (v: number) => {
		u16(v & 0xffff)
		u16(Math.floor(v / 65536) & 0xffff)
	}
	const str = (s: string) => {
		for (const c of s) parts.push(c.charCodeAt(0))
	}
	str("RIFF")
	u32(0)
	str("WAVE")
	const data = () => {
		str("data")
		u32(o.dataSize ?? 16000)
	}
	if (o.dataFirst) data()
	if (o.list) {
		str("LIST")
		u32(o.list)
		for (let i = 0; i < o.list; i++) parts.push(0x41)
		if (o.list & 1) parts.push(0)
	}
	str("fmt ")
	const ext = o.extensible
	u32(ext ? 40 : 16)
	u16(o.format ?? (ext ? 0xfffe : 1))
	u16(channels)
	u32(rate)
	u32(o.byteRate ?? (rate * channels * bits) / 8)
	u16(o.blockAlign ?? (channels * bits) / 8)
	u16(bits)
	if (ext) {
		u16(ext.cb ?? 22)
		u16(bits)
		u32(0)
		u16(ext.sub ?? 1)
		for (const t of ext.tail ?? KS_TAIL) parts.push(t)
	}
	if (!o.dataFirst) data()
	const out = Uint8Array.from(parts)
	const riff =
		o.riffSize ?? Math.min(0xffffffff, out.length - 8 + (o.dataSize ?? 16000))
	new DataView(out.buffer).setUint32(4, riff, true)
	return out
}

describe("parseRiffDurationMs", () => {
	it("parses mono 16-bit 8 kHz", () => {
		const h = build()
		expect(parseRiffDurationMs(h, h.length + 16000)).toBe(1000)
	})
	it("parses stereo", () => {
		const h = build({ channels: 2, rate: 48000, dataSize: 192000 })
		expect(parseRiffDurationMs(h, h.length + 192000)).toBe(1000)
	})
	it("null for a truncated header", () => {
		const h = build()
		expect(parseRiffDurationMs(h.subarray(0, 30), 5000)).toBeNull()
		expect(parseRiffDurationMs(new Uint8Array(0), 0)).toBeNull()
	})
	it("null when data precedes fmt", () => {
		const h = build({ dataFirst: true })
		expect(parseRiffDurationMs(h, 100000)).toBeNull()
	})
	it("clamps an oversized data size by file size", () => {
		const h = build({ dataSize: 0xffffffff })
		expect(parseRiffDurationMs(h, h.length + 8000)).toBe(500)
	})
	it("null for zero or inconsistent byte rate", () => {
		expect(parseRiffDurationMs(build({ byteRate: 0 }), 99999)).toBeNull()
		expect(parseRiffDurationMs(build({ byteRate: 15999 }), 99999)).toBeNull()
		expect(parseRiffDurationMs(build({ blockAlign: 4 }), 99999)).toBeNull()
	})
	it("null for non-PCM formats", () => {
		expect(parseRiffDurationMs(build({ format: 3 }), 99999)).toBeNull()
		expect(parseRiffDurationMs(build({ format: 6 }), 99999)).toBeNull()
	})
	it("accepts extensible PCM", () => {
		const h = build({ extensible: {} })
		expect(parseRiffDurationMs(h, h.length + 16000)).toBe(1000)
	})
	it("rejects extensible non-PCM, bad GUID, small cbSize and truncation", () => {
		expect(
			parseRiffDurationMs(build({ extensible: { sub: 3 } }), 99999),
		).toBeNull()
		const bad = [...KS_TAIL]
		bad[4] = 0x11
		expect(
			parseRiffDurationMs(build({ extensible: { tail: bad } }), 99999),
		).toBeNull()
		expect(
			parseRiffDurationMs(build({ extensible: { cb: 0 } }), 99999),
		).toBeNull()
		const h = build({ extensible: {} })
		expect(parseRiffDurationMs(h.subarray(0, 50), 99999)).toBeNull()
	})
	it("null when the data chunk lies past 4 KiB", () => {
		const h = build({ list: 5000 })
		expect(parseRiffDurationMs(h, h.length + 16000)).toBeNull()
	})
	it("skips a LIST chunk before data", () => {
		const h = build({ list: 31 })
		expect(parseRiffDurationMs(h, h.length + 16000)).toBe(1000)
	})
	it("null when fileSize is below the data offset or not an integer", () => {
		const h = build()
		expect(parseRiffDurationMs(h, h.length - 1)).toBeNull()
		expect(parseRiffDurationMs(h, Number.NaN)).toBeNull()
		expect(parseRiffDurationMs(h, 1.5)).toBeNull()
	})

	it("honours the RIFF container size", () => {
		const h = build()
		expect(parseRiffDurationMs(h, h.length + 16000)).toBe(1000)
		expect(
			parseRiffDurationMs(build({ riffSize: 0 }), h.length + 16000),
		).toBeNull()
		expect(
			parseRiffDurationMs(build({ riffSize: 3 }), h.length + 16000),
		).toBeNull()
		// fmt body ends at 36: a container ending at 35 cuts it
		expect(
			parseRiffDurationMs(build({ riffSize: 27 }), h.length + 16000),
		).toBeNull()
		// data header at 36..44: ending the container at 43 leaves it just past the end
		expect(
			parseRiffDurationMs(build({ riffSize: 35 }), h.length + 16000),
		).toBeNull()
		// the data chunk header exactly at the container end is still inside
		expect(parseRiffDurationMs(build({ riffSize: 36 }), h.length + 16000)).toBe(
			1000,
		)
	})

	// Feature: web-gaps-8, Property 10: RIFF duration
	// Validates: Requirements 4.3, 4.6
	it("property: formula for valid PCM, null for corrupted, never throws", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 8 }),
				fc.integer({ min: 1, max: 384000 }),
				fc.constantFrom(8, 16, 24, 32),
				fc.integer({ min: 0, max: 0xffffffff }),
				fc.integer({ min: 0, max: 5_000_000 }),
				fc.integer({ min: 0, max: 40 }),
				(channels, rate, bits, dataSize, extra, list) => {
					const h = build({ channels, rate, bits, dataSize, list })
					const fileSize = h.length + extra
					const br = (rate * channels * bits) / 8
					const expected = Math.round((Math.min(dataSize, extra) / br) * 1000)
					expect(parseRiffDurationMs(h, fileSize)).toBe(expected)
					expect(
						parseRiffDurationMs(
							build({ channels, rate, bits, byteRate: br + 1 }),
							fileSize,
						),
					).toBeNull()
					expect(
						parseRiffDurationMs(
							build({ channels, rate, bits, format: 3 }),
							fileSize,
						),
					).toBeNull()
				},
			),
			{ numRuns: 100 },
		)
		fc.assert(
			fc.property(
				fc.uint8Array({ minLength: 0, maxLength: 80 }),
				fc.integer({ min: -5, max: 100000 }),
				fc.array(
					fc.tuple(
						fc.integer({ min: 0, max: 60 }),
						fc.integer({ min: 0, max: 255 }),
					),
					{ maxLength: 6 },
				),
				(noise, size, muts) => {
					const h = build()
					for (const [i, v] of muts) h[i] = v
					const r1 = parseRiffDurationMs(h, size)
					expect(r1 === null || Number.isFinite(r1)).toBe(true)
					// Cheaply decidable invalid headers must be refused.
					const dv = new DataView(h.buffer)
					const ascii = (o: number) =>
						String.fromCharCode(
							h[o] ?? 0,
							h[o + 1] ?? 0,
							h[o + 2] ?? 0,
							h[o + 3] ?? 0,
						)
					const fmtIntact =
						ascii(12) === "fmt " && dv.getUint32(16, true) === 16
					const channels = dv.getUint16(22, true)
					const bits = dv.getUint16(34, true)
					if (
						ascii(0) !== "RIFF" ||
						ascii(8) !== "WAVE" ||
						dv.getUint32(4, true) < 4 ||
						(fmtIntact &&
							(dv.getUint16(20, true) !== 1 ||
								channels < 1 ||
								channels > 8 ||
								![8, 16, 24, 32].includes(bits)))
					)
						expect(r1).toBeNull()
					const r2 = parseRiffDurationMs(noise, size)
					expect(r2 === null || Number.isFinite(r2)).toBe(true)
				},
			),
			{ numRuns: 200 },
		)
	})
})
