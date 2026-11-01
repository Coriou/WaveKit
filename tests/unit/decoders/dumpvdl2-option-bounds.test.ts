// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { Dumpvdl2Decoder } from "../../../src/decoders/builtin/dumpvdl2.js"

interface Rule {
	extra?: Record<string, unknown>
	key: string
	min: number
	max: number
	integer: boolean
}

function build(
	options: Record<string, unknown>,
	top: Record<string, unknown> = {},
) {
	const warn: Record<string, unknown>[] = []
	const logger = pino(
		{ level: "warn" },
		{ write: (line: string) => void warn.push(JSON.parse(line)) },
	)
	const config = {
		id: "t",
		type: "dumpvdl2",
		enabled: true,
		...top,
		options: { ...options },
	} as unknown as DecoderConfig
	const decoder = new Dumpvdl2Decoder(config, logger)
	const view = decoder as unknown as {
		options: Record<string, unknown>
		onOptionsUpdated(): void
		getDecoderArgs(): string[]
	}
	return { decoder, view, warn }
}

type View = ReturnType<typeof build>["view"]

function argv(view: View): string[] {
	return view.getDecoderArgs()
}

/** Bounds by meaning; the same numbers as the adapter's option schema. */
const RULES: Rule[] = [
	{ key: "inputSampleRate", min: 1000, max: 10000000, integer: false },
	{ key: "targetSampleRate", min: 105000, max: 2100000, integer: true },
	{ key: "inputCenterFreq", min: 1, max: 6000000000, integer: true },
	{ key: "ppm", min: -1000, max: 1000, integer: false },
	{ key: "rtlTcpPort", min: 1, max: 65535, integer: true },
]

const GARBAGE: unknown[] = [
	"abc",
	"",
	"1e999",
	"--evil; rm -rf /",
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	true,
	{},
	[],
]

const PINO_FIELDS = ["level", "time", "pid", "hostname", "component", "msg"]

const finite = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n)

describe("Dumpvdl2Decoder numeric option bounds", () => {
	describe.each(RULES)("$key", rule => {
		const extra = rule.extra ?? {}
		it("passes values at both bounds untouched and silently", () => {
			for (const value of [rule.min, rule.max]) {
				const { view, warn } = build({ [rule.key]: value, ...extra })
				expect(view.options[rule.key]).toBe(value)
				expect(warn).toHaveLength(0)
			}
		})

		it("clamps just past each bound and warns once with the key only", () => {
			for (const [value, expected] of [
				[rule.min - 1, rule.min],
				[rule.min - 1e9, rule.min],
				[rule.max + 1, rule.max],
				[rule.max * 1000 + 7, rule.max],
			] as const) {
				const { view, warn } = build({ [rule.key]: value, ...extra })
				expect(view.options[rule.key]).toBe(expected)
				expect(warn).toHaveLength(1)
				expect(warn[0]).toMatchObject({ key: rule.key, issue: "clamped" })
				expect(
					Object.keys(warn[0] ?? {})
						.filter(k => !PINO_FIELDS.includes(k))
						.sort(),
				).toEqual(["issue", "key"])
			}
		})

		it("reads numeric text like the number", () => {
			const { view } = build({ [rule.key]: String(rule.max), ...extra })
			expect(view.options[rule.key]).toBe(rule.max)
		})

		it("falls back to the default for garbage and never passes it as text", () => {
			for (const garbage of GARBAGE) {
				const { view, warn } = build({ [rule.key]: garbage, ...extra })
				expect(view.options[rule.key], String(garbage)).toBeUndefined()
				expect(warn).toHaveLength(1)
				expect(warn[0]).toMatchObject({ key: rule.key, issue: "invalid" })
			}
		})

		it("warns once per key across option updates", () => {
			const { view, warn } = build({ [rule.key]: rule.max + 1, ...extra })
			view.onOptionsUpdated()
			view.onOptionsUpdated()
			expect(warn).toHaveLength(1)
		})

		it("treats absent and null as the default without a warning", () => {
			const { view, warn } = build({ [rule.key]: null, ...extra })
			expect(view.options[rule.key]).toBeUndefined()
			expect(warn).toHaveLength(0)
		})
	})

	describe("frequencies array", () => {
		const LIMIT = 8
		const where = [
			(freqs: unknown[]) => build({ frequencies: freqs }),
			(freqs: unknown[]) => build({}, { frequencies: freqs }),
		]
		it.each(where)(
			"keeps up to the limit and drops the rest with one warning",
			make => {
				const atLimit = Array.from(
					{ length: LIMIT },
					(_, i) => 136_650_000 + i * 25_000,
				)
				const ok = make(atLimit)
				expect(ok.view.options["frequencies"]).toEqual(atLimit)
				expect(ok.warn).toHaveLength(0)
				const past = make([...atLimit, 136_650_000 + 1_000_000])
				expect(past.view.options["frequencies"]).toEqual(atLimit)
				expect(past.warn).toHaveLength(1)
				expect(past.warn[0]).toMatchObject({
					key: "frequencies",
					issue: "clamped",
				})
				const huge = make(Array.from({ length: 10_000 }, () => 136_650_000))
				expect((huge.view.options["frequencies"] as number[]).length).toBe(
					LIMIT,
				)
			},
		)

		it.each(where)(
			"clamps entries to the tunable range and drops garbage entries",
			make => {
				const { view, warn } = make([
					0,
					7_000_000_000,
					"abc",
					Number.NaN,
					136_650_000,
				])
				expect(view.options["frequencies"]).toEqual([
					1, 6_000_000_000, 136_650_000,
				])
				expect(warn).toHaveLength(1)
			},
		)

		it("falls back to the default list for a non-array or an all-garbage array", () => {
			const defaults = build({}).view.options["frequencies"]
			expect(
				build({ frequencies: "131550000" }).view.options["frequencies"],
			).toEqual(defaults)
			expect(
				build({ frequencies: ["x", Number.NaN] }).view.options["frequencies"],
			).toEqual(defaults)
		})
	})

	const arg = (tokens: string[], flag: string) =>
		tokens[tokens.indexOf(flag) + 1]

	it("clamps the oversample factor and the centre frequency in argv", () => {
		const high = argv(
			build({ targetSampleRate: 1e99, inputCenterFreq: 1e99 }).view,
		)
		expect(arg(high, "--oversample")).toBe("20")
		expect(arg(high, "--centerfreq")).toBe("6000000000")
		const low = argv(build({ targetSampleRate: 1, inputCenterFreq: -5 }).view)
		expect(arg(low, "--oversample")).toBe("1")
		expect(arg(low, "--centerfreq")).toBe("1")
	})

	it("garbage rate and centre fall to the defaults in argv", () => {
		const tokens = argv(
			build({ targetSampleRate: "1e999", inputCenterFreq: "evil; id" }).view,
		)
		expect(arg(tokens, "--oversample")).toBe("10")
		expect(arg(tokens, "--centerfreq")).toBe("136650000")
	})

	// Feature: web-gaps-7, Property 14: Bounded numeric options
	// Validates: Requirements 9.1, 9.3, 9.5
	it("Property 14: every numeric option is finite and within bounds for any option object", () => {
		const value = fc.oneof(
			fc.double({ noNaN: false }),
			fc.integer(),
			fc.constantFrom(...GARBAGE),
			fc.string(),
			fc.integer().map(String),
			fc.constant(null),
			fc.constant(undefined),
		)
		const options = fc.record(
			Object.fromEntries(RULES.map(rule => [rule.key, value])),
			{ requiredKeys: [] },
		)
		fc.assert(
			fc.property(options, generated => {
				const { view } = build({ ...(generated as object) })
				for (const rule of RULES) {
					const read = view.options[rule.key]
					if (read === undefined) continue
					expect(finite(read), rule.key).toBe(true)
					expect(read as number).toBeGreaterThanOrEqual(rule.min)
					expect(read as number).toBeLessThanOrEqual(rule.max)
					if (rule.integer) expect(Number.isInteger(read)).toBe(true)
				}
				const frequencies = view.options["frequencies"] as number[]
				expect(frequencies.length).toBeLessThanOrEqual(8)
				let tokens: string[]
				try {
					tokens = argv(view)
				} catch {
					// A rate that is not a multiple of 105 kHz is refused outright.
					return
				}
				for (const flag of ["--oversample", "--centerfreq"]) {
					const n = Number(arg(tokens, flag))
					expect(Number.isFinite(n)).toBe(true)
					expect(n).toBeGreaterThanOrEqual(1)
					expect(n).toBeLessThanOrEqual(
						flag === "--oversample" ? 20 : 6_000_000_000,
					)
				}
				for (const token of tokens)
					expect(token).not.toMatch(/NaN|Infinity|e\+/)
			}),
			{ numRuns: 150 },
		)
	})
})
