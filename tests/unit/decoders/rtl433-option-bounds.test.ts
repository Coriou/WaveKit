// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { rtl433OptionsSchema } from "../../../src/decoders/options/rtl433.js"

function build(options: Record<string, unknown>) {
	const warn: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "warn" },
		{ write: (line: string) => void warn.push(JSON.parse(line)) },
	)
	const config = {
		id: "t",
		type: "rtl433",
		enabled: true,
		options: { ...options },
	} as unknown as DecoderConfig
	const decoder = new Rtl433Decoder(config, logger)
	const view = decoder as unknown as {
		config: DecoderConfig
		onOptionsUpdated(): void
		getDecoderArgs(): string[]
		getArgs(): string[]
	}
	const optionWarnings = () => warn.filter(w => typeof w["key"] === "string")
	return { view, warn, optionWarnings }
}

const after = (args: string[], flag: string): string[] =>
	args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ""] : []))

const GARBAGE: unknown[] = [
	"abc",
	"",
	"1e999",
	"1; rm -rf /",
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	true,
	{},
	[],
]

describe("rtl433 protocols (requirement 9.3)", () => {
	it("keeps 256 entries and drops the 257th with one warning", () => {
		const ids = Array.from({ length: 257 }, (_, i) => i)
		const at = build({ protocols: ids.slice(0, 256) })
		expect(after(at.view.getDecoderArgs(), "-R")).toHaveLength(256)
		expect(at.optionWarnings()).toEqual([])
		const past = build({ protocols: ids })
		const kept = after(past.view.getDecoderArgs(), "-R")
		expect(kept).toHaveLength(256)
		expect(kept.at(-1)).toBe("255")
		expect(past.optionWarnings()).toEqual([
			expect.objectContaining({ key: "protocols", issue: "clamped" }),
		])
	})

	it("ids at and past each bound; garbage entries dropped", () => {
		const { view, optionWarnings } = build({
			protocols: [0, 999, 1000, -1, "40", "abc", Number.NaN, "-3", 2.5],
		})
		expect(after(view.getDecoderArgs(), "-R")).toEqual([
			"0",
			"999",
			"999",
			"0",
			"40",
			"2",
		])
		expect(optionWarnings()).toHaveLength(1)
	})

	it("a non-array never iterates characters into argv", () => {
		const { view, optionWarnings } = build({ protocols: "1; rm -rf /" })
		const args = view.getDecoderArgs()
		expect(args).not.toContain("-R")
		expect(args).not.toContain("-G")
		expect(optionWarnings()).toEqual([
			expect.objectContaining({ key: "protocols", issue: "invalid" }),
		])
	})
})

describe("rtl433 sample rates", () => {
	const rate = (o: Record<string, unknown>) =>
		after(build(o).view.getDecoderArgs(), "-s")[0]

	it("targetSampleRate at and past each bound", () => {
		expect(rate({ inputSampleRate: 250_000, targetSampleRate: 250_000 })).toBe(
			"250000",
		)
		expect(
			rate({ inputSampleRate: 3_200_000, targetSampleRate: 3_200_000 }),
		).toBe("3200000")
		expect(
			rate({ inputSampleRate: 3_200_000, targetSampleRate: 3_200_001 }),
		).toBe("3200000")
		expect(rate({ inputSampleRate: 250_000, targetSampleRate: 1 })).toBe(
			"250000",
		)
		// 0 used to divide by zero: an Infinity decimation in the pipeline.
		const zero = build({ targetSampleRate: 0 })
		expect(zero.view.getArgs()[1]).not.toMatch(/Infinity|NaN/)
		expect(zero.optionWarnings()).toEqual([
			expect.objectContaining({ key: "targetSampleRate", issue: "clamped" }),
		])
	})

	it("garbage falls back to the defaults (byte-identical to absent)", () => {
		const baseline = build({}).view.getArgs()
		for (const g of GARBAGE) {
			expect(build({ targetSampleRate: g }).view.getArgs()).toEqual(baseline)
			expect(build({ inputSampleRate: g }).view.getArgs()).toEqual(baseline)
		}
	})

	it("inputSampleRate past the bound clamps to 64 Msps", () => {
		expect(build({ inputSampleRate: 1e15 }).view.getArgs()).toEqual(
			build({ inputSampleRate: 64_000_000 }).view.getArgs(),
		)
	})

	it("warns once per key across option updates and never logs the value", () => {
		const { view, warn } = build({ targetSampleRate: "424242; x" })
		view.config.options["targetSampleRate"] = 987654321
		view.onOptionsUpdated()
		expect(warn.filter(w => w["key"] === "targetSampleRate")).toHaveLength(1)
		expect(JSON.stringify(warn)).not.toMatch(/424242|987654321/)
	})

	it("schema bounds agree with the adapter clamps", () => {
		const ok = (o: Record<string, unknown>) =>
			rtl433OptionsSchema.safeParse(o).success
		expect(
			ok({
				protocols: Array.from({ length: 256 }, () => 999),
				targetSampleRate: 250_000,
				inputSampleRate: 64e6,
			}),
		).toBe(true)
		expect(ok({ protocols: Array.from({ length: 257 }, () => 1) })).toBe(false)
		expect(ok({ protocols: [1000] })).toBe(false)
		expect(ok({ targetSampleRate: 249_999 })).toBe(false)
		expect(ok({ targetSampleRate: 3_200_001 })).toBe(false)
		expect(ok({ inputSampleRate: 64e6 + 1 })).toBe(false)
		expect(ok({ frequencies: Array.from({ length: 65 }, () => 1e8) })).toBe(
			false,
		)
	})
})

const anyValue = fc.oneof(
	fc.double(),
	fc.integer({ min: -1e12, max: 1e12 }),
	fc.integer({ min: -20, max: 2000 }).map(String),
	fc.constantFrom(...GARBAGE, null, undefined),
	fc.string().map(s => `ZZ${s}`),
)

describe("Property 14: rtl433 bounded numeric options", () => {
	it("every numeric argv/shell token is finite and within bounds; no option text reaches the shell", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						inputSampleRate: anyValue,
						targetSampleRate: anyValue,
						protocols: fc.oneof(
							anyValue,
							fc.array(anyValue, { maxLength: 300 }),
						),
					},
					{ requiredKeys: [] },
				),
				options => {
					const { view } = build(options)
					const args = view.getDecoderArgs()
					const ids = after(args, "-R")
					expect(ids.length).toBeLessThanOrEqual(256)
					for (const id of ids) {
						const n = Number(id)
						expect(Number.isInteger(n)).toBe(true)
						expect(n).toBeGreaterThanOrEqual(0)
						expect(n).toBeLessThanOrEqual(999)
					}
					const s = Number(after(args, "-s")[0])
					expect(Number.isFinite(s)).toBe(true)
					expect(s).toBeGreaterThan(0)
					expect(s).toBeLessThanOrEqual(64_000_000)
					const cmd = view.getArgs()[1] ?? ""
					expect(cmd).not.toContain("ZZ")
					expect(cmd).not.toMatch(/NaN|Infinity|e\+|rm -rf/)
					const dec = /csdr firdecimate (\S+)/.exec(cmd)?.[1]
					if (dec !== undefined) {
						expect(Number.isInteger(Number(dec))).toBe(true)
						expect(Number(dec)).toBeGreaterThanOrEqual(2)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("rtl433 inputSampleRate bound agrees in schema and argv", () => {
	const ok = (v: number) =>
		rtl433OptionsSchema.safeParse({ inputSampleRate: v }).success
	const args = (v: unknown) => build({ inputSampleRate: v }).view.getArgs()
	it("999 / 1000 / max / max+1", () => {
		expect(ok(999)).toBe(false)
		expect(ok(1000)).toBe(true)
		expect(ok(64_000_000)).toBe(true)
		expect(ok(64_000_001)).toBe(false)
		expect(args(999)).toEqual(args(1000))
		expect(args(64_000_001)).toEqual(args(64_000_000))
		expect(args(0)).toEqual(build({}).view.getArgs())
	})
})

describe("rtl433 logs at every level carry no option text", () => {
	it("extraArgs and garbage numbers never appear in any log", () => {
		const MARK = "MARK-777"
		const lines: string[] = []
		const logger = pino(
			{ level: "trace" },
			{ write: (line: string) => void lines.push(line) },
		)
		const decoder = new Rtl433Decoder(
			{
				id: "t",
				type: "rtl433",
				enabled: true,
				options: {
					extraArgs: [MARK],
					targetSampleRate: MARK,
					protocols: [MARK],
				},
			} as unknown as DecoderConfig,
			logger,
		) as unknown as { getArgs(): string[]; onOptionsUpdated(): void }
		decoder.getArgs()
		decoder.onOptionsUpdated()
		decoder.getArgs()
		expect(lines.length).toBeGreaterThan(0)
		expect(lines.join("\n")).not.toContain(MARK)
	})
})
