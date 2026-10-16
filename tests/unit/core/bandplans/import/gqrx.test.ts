import { readFileSync } from "node:fs"
import { loadavg } from "node:os"
import { BANDPLANS_LIMITS } from "@wavekit/api-types"
import { storedBandSchema } from "@wavekit/api-types"
import type { DisplayGroup } from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { SdrppParseResult } from "../../../../../src/core/bandplans/contract.js"
import { parseGqrxBandPlan } from "../../../../../src/core/bandplans/import/gqrx.js"

const enc = new TextEncoder()
function run(
	input: string | Uint8Array,
	overrides: ReadonlyMap<string, DisplayGroup> = new Map(),
): SdrppParseResult {
	const bytes = typeof input === "string" ? enc.encode(input) : input
	return parseGqrxBandPlan(bytes, { fileName: "bandplan.csv", overrides })
}
function failure(result: SdrppParseResult) {
	if (result.ok) throw new Error("expected failure")
	return result
}
function success(result: SdrppParseResult) {
	if (!result.ok) throw new Error(`expected success, got ${result.reason}`)
	return result.value
}
function row(i: number): string {
	return `${1000 + i * 10},${1005 + i * 10},AM,5,,Band ${i}`
}
function rows(n: number): string {
	return Array.from({ length: n }, (_, i) => row(i)).join("\n")
}

describe("parseGqrxBandPlan", () => {
	it("parses the synthetic fixture", () => {
		const bytes = readFileSync(
			new URL(
				"../../../../mocks/fixtures/bandplans/synthetic-gqrx.csv",
				import.meta.url,
			),
		)
		const value = success(run(new Uint8Array(bytes)))
		expect(value.preview.format).toBe("gqrx-csv")
		expect(value.preview.meta).toEqual({
			name: null,
			countryName: null,
			countryCode: null,
			author: null,
			version: null,
		})
		expect(value.preview.report.rowsTotal).toBe(4)
		expect(value.preview.report.skipped).toEqual([
			{ reason: "malformed-row", count: 1 },
		])
		expect(
			value.bands.map(b => [b.name, b.startHz, b.endHz, b.mode, b.stepHz]),
		).toEqual([
			["Synthetic broadcast", 87500000, 108000000, "wfm", 100000],
			["Synthetic air", 118000000, 137000000, "am", 25000],
			["Synthetic ham, with comma", 144000000, 146000000, "nfm", 12500],
		])
		expect(value.bands.map(b => b.colourHint)).toEqual([
			"#ff0000",
			"#00ff00",
			"#00ffff",
		])
	})

	it("accepts CRLF and mixed endings", () => {
		const text = "100,200,AM,5,,A\r\n300,400,AM,5,,B\n500,600,AM,5,,C\r\n"
		expect(success(run(text)).bands.map(b => b.name)).toEqual(["A", "B", "C"])
	})

	it("rejects invalid UTF-8 and UTF-16 as encoding", () => {
		expect(failure(run(Uint8Array.of(0x31, 0xff, 0xfe))).reason).toBe(
			"encoding",
		)
		const utf16 = Uint8Array.of(0xff, 0xfe, 0x31, 0x00, 0x2c, 0x00)
		expect(failure(run(utf16)).reason).toBe("encoding")
	})

	it("strips a UTF-8 BOM", () => {
		const body = enc.encode("100,200,AM,5,,A")
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body])
		expect(success(run(bytes)).bands).toHaveLength(1)
	})

	it("treats an SDR++ JSON file as empty (all rows skipped)", () => {
		const json = '{"name":"x",\n"bands":[{"name":"a","start":1,"end":2}]}'
		const result = failure(run(json))
		expect(result.reason).toBe("empty")
	})

	it("rejects empty and comment-only files as empty", () => {
		expect(failure(run("")).reason).toBe("empty")
		expect(failure(run("# a\n\n  \n# b\n")).reason).toBe("empty")
	})

	it("skips NUL text as text-invalid", () => {
		const value = success(run("100,200,AM,5,,A\n300,400,AM,5,,B\u0000C"))
		expect(value.preview.report.skipped).toEqual([
			{ reason: "text-invalid", count: 1 },
		])
	})

	it("counts malformed rows, bad modes, steps and colours", () => {
		const text = [
			"100,200,AM,5,,A",
			"1,2,3",
			"1.5,200,AM,5,,B",
			"0x10,20,AM,5,,C",
			"300,400,Strange,0,zzz,D",
			"600,500,AM,5,,E",
			"700,800,AM,5,,",
		].join("\n")
		const value = success(run(text))
		expect(value.bands.map(b => b.name)).toEqual(["A", "D"])
		expect(value.bands[1]).toMatchObject({
			mode: null,
			stepHz: null,
			colourHint: null,
		})
		expect(value.preview.report.skipped).toEqual([
			{ reason: "malformed-row", count: 3 },
			{ reason: "unnamed", count: 1 },
			{ reason: "invalid-edges", count: 1 },
		])
	})

	it("skips duplicates and honours overrides", () => {
		const value = success(
			run(
				"100,200,Odd,5,,A\n100,200,Odd,5,,A",
				new Map([["Odd", "air" as const]]),
			),
		)
		expect(value.bands).toHaveLength(1)
		expect(value.bands[0]?.group).toBe("air")
		expect(value.preview.report.skipped).toEqual([
			{ reason: "duplicate", count: 1 },
		])
	})

	describe("bounds", () => {
		it("accepts 4096 rows and rejects 4097", () => {
			const at = run(rows(BANDPLANS_LIMITS.importRows))
			expect(success(at).preview.report.rowsTotal).toBe(4096)
			expect(success(at).preview.report.accepted).toBe(512)
			expect(failure(run(rows(4097))).reason).toBe("row-limit")
		})
		it("does not count blanks and comments toward the row cap", () => {
			const filler = "# c\n\n".repeat(5000)
			expect(
				success(run(`${filler}${rows(4096)}`)).preview.report.rowsTotal,
			).toBe(4096)
		})
		it("limits accepted bands to 512 and skips the 513th", () => {
			const at = success(run(rows(512)))
			expect(at.bands).toHaveLength(512)
			const past = success(run(rows(513)))
			expect(past.bands).toHaveLength(512)
			expect(past.preview.report.skipped).toEqual([
				{ reason: "pack-band-limit", count: 1 },
			])
		})
		it("accepts 1 MiB and rejects 1 MiB + 1 before decoding", () => {
			const limit = BANDPLANS_LIMITS.importFileBytes
			const bytes = new Uint8Array(limit).fill(10)
			bytes.set(enc.encode("100,200,AM,5,,A"))
			expect(run(bytes).ok).toBe(true)
			const over = new Uint8Array(limit + 1).fill(0xff)
			expect(failure(run(over))).toMatchObject({
				code: "BANDPLANS_IMPORT_TOO_LARGE",
				reason: "too-large",
			})
		})
		it("takes a 1024-character line", () => {
			const head = "100,200,AM,5,,A"
			const ok = success(run(`${head}${" ".repeat(1024 - head.length)}\n`))
			expect(ok.bands).toHaveLength(1)
			expect(ok.preview.report.skipped).toEqual([])
		})
		it("rejects a 1025-character line as malformed-row", () => {
			const head = "100,200,AM,5,,A"
			const pad = " ".repeat(1025 - head.length)
			const value = success(run(`${head}${pad}\n300,400,AM,5,,B`))
			expect(value.bands.map(b => b.name)).toEqual(["B"])
			expect(value.preview.report.skipped).toEqual([
				{ reason: "malformed-row", count: 1 },
			])
		})
	})

	it("reports indicative timing for a 1 MiB file", () => {
		// 4096 rows (the cap) plus comment padding up to the 1 MiB limit.
		const limit = BANDPLANS_LIMITS.importFileBytes
		const body = rows(BANDPLANS_LIMITS.importRows)
		const padLine = `#${"x".repeat(100)}\n`
		const padCount = Math.floor((limit - body.length - 1) / padLine.length)
		const text = `${padLine.repeat(padCount)}${body}`
		const bytes = enc.encode(text)
		const t0 = performance.now()
		const result = run(bytes)
		const ms = performance.now() - t0
		console.info(
			`gqrx 1MiB parse: ${ms.toFixed(1)} ms (ok=${String(result.ok)}) load=${loadavg()[0]?.toFixed(2)}`,
		)
		expect(bytes.length).toBeLessThanOrEqual(BANDPLANS_LIMITS.importFileBytes)
	})
})

function acceptedAreValid(result: SdrppParseResult): void {
	if (!result.ok) return
	for (const band of result.value.bands) {
		expect(storedBandSchema.safeParse(band).success).toBe(true)
	}
}

describe("Gqrx import properties", () => {
	// Feature: web-gaps-5, Property 11: Import totality
	// Validates: Requirements 7.3, 7.4, 7.5
	it("never throws on random bytes", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 2048 }), bytes => {
				acceptedAreValid(run(bytes))
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-5, Property 11: Import totality
	// Validates: Requirements 7.3, 7.4, 7.5
	it("never throws on mutations of a valid file", () => {
		const base = enc.encode(
			readFileSync(
				new URL(
					"../../../../mocks/fixtures/bandplans/synthetic-gqrx.csv",
					import.meta.url,
				),
				"utf8",
			),
		)
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						at: fc.nat(base.length),
						byte: fc.integer({ min: 0, max: 255 }),
						cut: fc.boolean(),
					}),
					{ maxLength: 8 },
				),
				edits => {
					let bytes = new Uint8Array(base)
					for (const e of edits) {
						if (e.cut) bytes = bytes.slice(0, e.at)
						else if (e.at < bytes.length) bytes[e.at] = e.byte
					}
					acceptedAreValid(run(bytes))
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-5, Property 12: Import round trip
	// Validates: Requirements 7.2, 7.4, 7.6
	it("round-trips generated rows", () => {
		const modes = [
			["AM", "am"],
			["NFM", "nfm"],
			["WFM (Stereo)", "wfm"],
			["USB", "usb"],
			["CW-U", "cw"],
			["Other", null],
		] as const
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						start: fc.integer({ min: 1, max: 1_000_000_000 }),
						width: fc.integer({ min: 1, max: 1_000_000 }),
						mode: fc.constantFrom(...modes),
						step: fc.integer({ min: 1, max: 10_000_000 }),
						colour: fc.integer({ min: 0, max: 0xffffff }),
						alpha: fc.integer({ min: 0, max: 255 }),
						crlf: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 20 },
				),
				generated => {
					const hex = (n: number, w: number) => n.toString(16).padStart(w, "0")
					const text = generated
						.map(
							(r, i) =>
								`${r.start},${r.start + r.width},${r.mode[0]},${r.step},#${hex(r.alpha, 2)}${hex(r.colour, 6)},Band ${i}${r.crlf ? "\r" : ""}`,
						)
						.join("\n")
					const value = success(run(text))
					expect(
						value.bands.map(b => [
							b.name,
							b.startHz,
							b.endHz,
							b.mode,
							b.stepHz,
							b.colourHint,
						]),
					).toEqual(
						generated.map((r, i) => [
							`Band ${i}`,
							r.start,
							r.start + r.width,
							r.mode[1],
							r.step,
							`#${hex(r.colour, 6)}`,
						]),
					)
					const again = success(run(text))
					expect(again.preview.sha256).toBe(value.preview.sha256)
				},
			),
			{ numRuns: 100 },
		)
	})
})
