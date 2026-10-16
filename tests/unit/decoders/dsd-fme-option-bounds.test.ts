// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { dsdFmeOptionsSchema } from "../../../src/decoders/options/dsd-fme.js"

function build(options: Record<string, unknown>) {
	const warn: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "warn" },
		{ write: (line: string) => void warn.push(JSON.parse(line)) },
	)
	const config = {
		id: "t",
		type: "dsd-fme",
		enabled: true,
		options: { ...options },
	} as unknown as DecoderConfig
	const decoder = new DsdFmeDecoder(config, logger)
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

const DAY_MS = 86_400_000

describe("dsd-fme numeric bounds", () => {
	const RULES: {
		key: string
		min: number
		max: number
		fallback: number
		belowMin: number
	}[] = [
		{
			key: "minCallDurationMs",
			min: 0,
			max: DAY_MS,
			fallback: 250,
			belowMin: 0,
		},
		{
			key: "callStartDelayMs",
			min: 0,
			max: DAY_MS,
			fallback: 100,
			belowMin: 0,
		},
		// Positive keys: 0 and below fall back to the default.
		{
			key: "callTimeoutMs",
			min: 1,
			max: DAY_MS,
			fallback: 4000,
			belowMin: 4000,
		},
		{
			key: "perCallRecordingMaxTotalMb",
			min: 1,
			max: 1_048_576,
			fallback: 512,
			belowMin: 512,
		},
		{
			key: "perCallRecordingMaxAgeHours",
			min: 1,
			max: 8760,
			fallback: 168,
			belowMin: 168,
		},
	]

	it.each(RULES)("$key: at and past each bound", rule => {
		const read = (value: unknown) => build({ [rule.key]: value })
		for (const v of [rule.min, rule.max]) {
			const { view, optionWarnings } = read(v)
			expect(view.options[rule.key]).toBe(v)
			expect(optionWarnings()).toEqual([])
		}
		const past = read(rule.max + 1)
		expect(past.view.options[rule.key]).toBe(rule.max)
		expect(past.optionWarnings()).toEqual([
			expect.objectContaining({ key: rule.key, issue: "clamped" }),
		])
		expect(read(-1).view.options[rule.key]).toBe(rule.belowMin)
		for (const g of GARBAGE)
			expect(read(g).view.options[rule.key]).toBe(rule.fallback)
	})

	it("udpPort: in range passes, out of range or garbage is dropped (no clamp)", () => {
		const out = (port: unknown) => {
			const args = build({
				output: "udp",
				udpHost: "127.0.0.1",
				udpPort: port,
			}).view.getDecoderArgs()
			return args[args.indexOf("-o") + 1]
		}
		expect(out(1)).toBe("udp:127.0.0.1:1")
		expect(out(65535)).toBe("udp:127.0.0.1:65535")
		expect(out("7355")).toBe("udp:127.0.0.1:7355")
		for (const bad of [0, -1, 65536, 7355.5, ...GARBAGE])
			expect(out(bad)).toBe("null")
	})

	it("fmGain: at and past each bound inside the csdr gain stage", () => {
		const gainOf = (value: unknown) =>
			/csdr gain (\S+)/.exec(
				build({ fmGain: value }).view.getArgs()[1] ?? "",
			)?.[1]
		expect(gainOf(0)).toBe("0")
		expect(gainOf(1000)).toBe("1000")
		expect(gainOf(1001)).toBe("1000")
		expect(gainOf(-1)).toBe("0")
		for (const g of GARBAGE) expect(gainOf(g)).toBe("2")
	})

	it("fmGain shell injection never reaches the shell; the default is used", () => {
		const { view, optionWarnings } = build({ fmGain: "1; rm -rf /" })
		const cmd = view.getArgs()[1] ?? ""
		expect(cmd).not.toContain("rm -rf")
		expect(cmd).toContain("csdr gain 2 |")
		expect(optionWarnings()).toEqual([
			expect.objectContaining({ key: "fmGain", issue: "invalid" }),
		])
	})

	it("inputSampleRate: past the bound clamps, garbage falls back", () => {
		const baseline = build({}).view.getArgs()
		for (const g of GARBAGE)
			expect(build({ inputSampleRate: g }).view.getArgs()).toEqual(baseline)
		expect(build({ inputSampleRate: 1e15 }).view.getArgs()).toEqual(
			build({ inputSampleRate: 64_000_000 }).view.getArgs(),
		)
	})

	it("warns once per key across option updates and never logs the value", () => {
		const { view, warn } = build({ callTimeoutMs: "424242; x" })
		view.config.options["callTimeoutMs"] = 987654321
		view.onOptionsUpdated()
		expect(warn.filter(w => w["key"] === "callTimeoutMs")).toHaveLength(1)
		expect(JSON.stringify(warn)).not.toMatch(/424242|987654321/)
	})

	it("schema bounds agree with the adapter clamps", () => {
		const ok = (o: Record<string, unknown>) =>
			dsdFmeOptionsSchema.safeParse(o).success
		expect(
			ok({
				callTimeoutMs: DAY_MS,
				callStartDelayMs: DAY_MS,
				minCallDurationMs: DAY_MS,
				fmGain: 1000,
				inputSampleRate: 64e6,
				perCallRecordingMaxAgeHours: 8760,
				perCallRecordingMaxTotalMb: 1_048_576,
			}),
		).toBe(true)
		for (const [key, value] of [
			["callTimeoutMs", DAY_MS + 1],
			["callStartDelayMs", DAY_MS + 1],
			["minCallDurationMs", DAY_MS + 1],
			["fmGain", 1001],
			["fmGain", -1],
			["inputSampleRate", 64e6 + 1],
			["perCallRecordingMaxAgeHours", 8761],
			["perCallRecordingMaxTotalMb", 1_048_577],
		] as const)
			expect(ok({ [key]: value }), key).toBe(false)
		expect(ok({ frequencies: Array.from({ length: 65 }, () => 1e8) })).toBe(
			false,
		)
	})
})

const anyValue = fc.oneof(
	fc.double(),
	fc.integer({ min: -1e12, max: 1e12 }),
	fc.integer({ min: -20, max: 70_000 }).map(String),
	fc.constantFrom(...GARBAGE, null, undefined),
	fc.string().map(s => `ZZ${s}`),
)

describe("Property 14: dsd-fme bounded numeric options", () => {
	it("every numeric argv/shell token and timer is finite and within bounds; no option text reaches the shell", () => {
		fc.assert(
			fc.property(
				fc.record(
					{
						fmGain: anyValue,
						inputSampleRate: anyValue,
						udpPort: anyValue,
						minCallDurationMs: anyValue,
						callStartDelayMs: anyValue,
						callTimeoutMs: anyValue,
						perCallRecordingMaxTotalMb: anyValue,
						perCallRecordingMaxAgeHours: anyValue,
					},
					{ requiredKeys: [] },
				),
				options => {
					const { view } = build({
						...options,
						output: "udp",
						udpHost: "127.0.0.1",
					})
					const args = view.getDecoderArgs()
					const o = args[args.indexOf("-o") + 1] ?? ""
					if (o !== "null") {
						const port = Number(/^udp:127\.0\.0\.1:(\d+)$/.exec(o)?.[1])
						expect(Number.isInteger(port)).toBe(true)
						expect(port).toBeGreaterThanOrEqual(1)
						expect(port).toBeLessThanOrEqual(65535)
					}
					// [max, positive]: positive keys are > 0, the others >= 0.
					const bounds: Record<string, [number, boolean]> = {
						minCallDurationMs: [DAY_MS, false],
						callStartDelayMs: [DAY_MS, false],
						callTimeoutMs: [DAY_MS, true],
						perCallRecordingMaxTotalMb: [1_048_576, true],
						perCallRecordingMaxAgeHours: [8760, true],
					}
					for (const [key, [hi, positive]] of Object.entries(bounds)) {
						const n = view.options[key] as number
						expect(Number.isFinite(n), key).toBe(true)
						if (positive) expect(n).toBeGreaterThan(0)
						else expect(n).toBeGreaterThanOrEqual(0)
						expect(n).toBeLessThanOrEqual(hi)
					}
					const cmd = view.getArgs()[1] ?? ""
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
				},
			),
			{ numRuns: 200 },
		)
	})
})
