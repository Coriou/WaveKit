// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { multimonNgOptionsSchema } from "../../../src/decoders/options/multimon-ng.js"

function build(options: Record<string, unknown>) {
	const warn: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "warn" },
		{ write: (line: string) => void warn.push(JSON.parse(line)) },
	)
	const config = {
		id: "t",
		type: "multimon-ng",
		enabled: true,
		options: { ...options },
	} as unknown as DecoderConfig
	const decoder = new MultimonDecoder(config, logger)
	const view = decoder as unknown as {
		config: DecoderConfig
		options: Record<string, unknown>
		onOptionsUpdated(): void
		getDecoderArgs(): string[]
		getArgs(): string[]
	}
	const optionWarnings = () => warn.filter(w => typeof w["key"] === "string")
	return { view, warn, optionWarnings }
}

const pipeline = (view: ReturnType<typeof build>["view"]): string =>
	view.getArgs()[1] ?? ""

const vCount = (args: string[]): number => args.filter(a => a === "-v").length

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

describe("multimon-ng verbosity (requirement 9.2)", () => {
	const cases: [unknown, number, string | null][] = [
		[0, 0, null],
		[10, 10, null],
		["3", 3, null],
		[1e9, 10, "clamped"],
		[11, 10, "clamped"],
		[-1, 0, "clamped"],
		[2.5, 2, "clamped"],
		["abc", 0, "invalid"],
		["-1", 0, "invalid"],
		[Number.NaN, 0, "invalid"],
		[Number.POSITIVE_INFINITY, 0, "invalid"],
		[null, 0, null],
	]
	it.each(cases)("%s gives %i -v flags (%s)", (value, flags, issue) => {
		const { view, optionWarnings } = build({ verbosity: value })
		expect(vCount(view.getDecoderArgs())).toBe(flags)
		expect(optionWarnings()).toEqual(
			issue === null
				? []
				: [expect.objectContaining({ key: "verbosity", issue })],
		)
	})

	it("warns once per key across option updates and never logs the value", () => {
		const { view, warn } = build({ verbosity: "424242; rm" })
		view.config.options["verbosity"] = 987654321
		view.onOptionsUpdated()
		view.onOptionsUpdated()
		const keyed = warn.filter(w => w["key"] === "verbosity")
		expect(keyed).toHaveLength(1)
		const text = JSON.stringify(warn)
		expect(text).not.toContain("424242")
		expect(text).not.toContain("987654321")
		expect(vCount(view.getDecoderArgs())).toBe(10)
	})
})

describe("multimon-ng numeric bounds", () => {
	const RULES: { key: string; min: number; max: number; flag?: string }[] = [
		{ key: "highpass", min: 0, max: 11_025, flag: "--highpass" },
		{ key: "lowpass", min: 0, max: 11_025, flag: "--lowpass" },
		{ key: "gain", min: -60, max: 60, flag: "--gain" },
	]

	it.each(RULES)("filters.$key: at and past each bound", rule => {
		const valueAfter = (value: unknown) => {
			const { view, optionWarnings } = build({
				filters: { [rule.key]: value },
			})
			const args = view.getDecoderArgs()
			const index = args.indexOf(rule.flag ?? "")
			return {
				arg: index >= 0 ? args[index + 1] : undefined,
				warnings: optionWarnings(),
			}
		}
		expect(valueAfter(rule.min)).toEqual({
			arg: String(rule.min),
			warnings: [],
		})
		expect(valueAfter(rule.max)).toEqual({
			arg: String(rule.max),
			warnings: [],
		})
		const below = valueAfter(rule.min - 1)
		expect(below.arg).toBe(String(rule.min))
		expect(below.warnings).toEqual([
			expect.objectContaining({ key: `filters.${rule.key}`, issue: "clamped" }),
		])
		expect(valueAfter(rule.max + 1).arg).toBe(String(rule.max))
		for (const g of GARBAGE) expect(valueAfter(g).arg).toBeUndefined()
	})

	it("fmGain: at and past each bound inside the csdr gain stage", () => {
		const gainOf = (value: unknown) =>
			/csdr gain (\S+)/.exec(pipeline(build({ fmGain: value }).view))?.[1]
		expect(gainOf(0)).toBe("0")
		expect(gainOf(1000)).toBe("1000")
		expect(gainOf(1001)).toBe("1000")
		expect(gainOf(-1)).toBe("0")
		expect(gainOf("4.5")).toBe("4.5")
		for (const g of GARBAGE) expect(gainOf(g)).toBe("3")
	})

	it("fmGain shell injection never reaches the shell; the default is used", () => {
		const { view, optionWarnings } = build({ fmGain: "1; rm -rf /" })
		const cmd = pipeline(view)
		expect(cmd).not.toContain("rm -rf")
		expect(cmd).not.toContain(";")
		expect(cmd).toContain("csdr gain 3 |")
		expect(optionWarnings()).toEqual([
			expect.objectContaining({ key: "fmGain", issue: "invalid" }),
		])
	})

	it("inputSampleRate: at and past the bound, garbage falls back", () => {
		const baseline = pipeline(build({}).view)
		expect(pipeline(build({ inputSampleRate: 64_000_000 }).view)).toBe(
			pipeline(build({ inputSampleRate: 1e12 }).view),
		)
		for (const g of GARBAGE)
			expect(pipeline(build({ inputSampleRate: g }).view)).toBe(baseline)
		expect(pipeline(build({ inputSampleRate: 0 }).view)).toBe(baseline)
	})

	it("schema bounds agree with the adapter clamps", () => {
		const ok = (o: Record<string, unknown>) =>
			multimonNgOptionsSchema.safeParse(o).success
		expect(ok({ verbosity: 10, fmGain: 1000, inputSampleRate: 64e6 })).toBe(
			true,
		)
		expect(ok({ verbosity: 11 })).toBe(false)
		expect(ok({ fmGain: 1001 })).toBe(false)
		expect(ok({ inputSampleRate: 64e6 + 1 })).toBe(false)
		expect(ok({ filters: { highpass: 11_026 } })).toBe(false)
		expect(ok({ filters: { gain: -61 } })).toBe(false)
		expect(ok({ frequencies: Array.from({ length: 64 }, () => 1e8) })).toBe(
			true,
		)
		expect(ok({ frequencies: Array.from({ length: 65 }, () => 1e8) })).toBe(
			false,
		)
	})
})

/** Values for a numeric key: numbers, numeric text, garbage and marked text. */
const anyValue = fc.oneof(
	fc.double(),
	fc.integer({ min: -1e12, max: 1e12 }),
	fc.integer({ min: -20, max: 20 }).map(String),
	fc.constantFrom(...GARBAGE, null, undefined),
	fc.string().map(s => `ZZ${s}`),
)

describe("Property 14: multimon-ng bounded numeric options", () => {
	it("every numeric argv/shell token is finite and within bounds; no option text reaches the shell", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						verbosity: anyValue,
						fmGain: anyValue,
						inputSampleRate: anyValue,
						filters: fc.record(
							{ highpass: anyValue, lowpass: anyValue, gain: anyValue },
							{ requiredKeys: [] },
						),
					},
					{ requiredKeys: [] },
				),
				options => {
					const { view } = build(options)
					const args = view.getDecoderArgs()
					expect(vCount(args)).toBeLessThanOrEqual(10)
					const bounds: Record<string, [number, number]> = {
						"--highpass": [0, 11_025],
						"--lowpass": [0, 11_025],
						"--gain": [-60, 60],
					}
					args.forEach((a, i) => {
						const b = bounds[a]
						if (!b) return
						const n = Number(args[i + 1])
						expect(Number.isFinite(n)).toBe(true)
						expect(n).toBeGreaterThanOrEqual(b[0])
						expect(n).toBeLessThanOrEqual(b[1])
					})
					const cmd = pipeline(view)
					expect(cmd).not.toContain("ZZ")
					expect(cmd).not.toMatch(/NaN|Infinity|e\+|rm -rf/)
					const gain = Number(/csdr gain (\S+)/.exec(cmd)?.[1])
					expect(gain).toBeGreaterThanOrEqual(0)
					expect(gain).toBeLessThanOrEqual(1000)
					for (const m of cmd.matchAll(/-r (\S+)/g)) {
						const rate = Number(m[1])
						expect(Number.isFinite(rate)).toBe(true)
						expect(rate).toBeGreaterThan(0)
						expect(rate).toBeLessThanOrEqual(64_000_000)
					}
					const dec = Number(/csdr firdecimate (\S+)/.exec(cmd)?.[1])
					expect(Number.isInteger(dec)).toBe(true)
					expect(dec).toBeGreaterThanOrEqual(1)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("multimon-ng warnings never echo option values", () => {
	const SECRET = "SECRET-424242; rm -rf /"
	it("offsetHz and modes warn key-only, once per key", () => {
		const { view, warn } = build({
			offsetHz: SECRET,
			modes: ["POCSAG1200", SECRET],
		})
		view.getArgs()
		view.getArgs()
		view.onOptionsUpdated()
		view.getArgs()
		expect(JSON.stringify(warn)).not.toContain("SECRET-424242")
		expect(warn.filter(w => w["key"] === "offsetHz")).toEqual([
			expect.objectContaining({ key: "offsetHz", issue: "invalid" }),
		])
		expect(warn.some(w => w["key"] === "modes")).toBe(true)
	})
})

describe("multimon-ng inputSampleRate bound agrees in schema and argv", () => {
	const ok = (v: number) =>
		multimonNgOptionsSchema.safeParse({ inputSampleRate: v }).success
	const cmd = (v: unknown) => pipeline(build({ inputSampleRate: v }).view)
	it("999 / 1000 / max / max+1", () => {
		expect(ok(999)).toBe(false)
		expect(ok(1000)).toBe(true)
		expect(ok(64_000_000)).toBe(true)
		expect(ok(64_000_001)).toBe(false)
		expect(cmd(999)).toBe(cmd(1000))
		expect(cmd(64_000_001)).toBe(cmd(64_000_000))
		const below = build({ inputSampleRate: 999 })
		below.view.getArgs()
		expect(below.optionWarnings()).toEqual([
			expect.objectContaining({ key: "inputSampleRate", issue: "clamped" }),
		])
		expect(cmd(0)).toBe(pipeline(build({}).view))
	})
})
