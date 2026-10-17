// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"

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
		type: "ais-catcher",
		enabled: true,
		...top,
		options: { ...options },
	} as unknown as DecoderConfig
	const decoder = new AisCatcherDecoder(config, logger)
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
	{ key: "gain", min: 0, max: 60, integer: false },
	{ key: "ppm", min: -1000, max: 1000, integer: false },
	{ key: "inputSampleRate", min: 1000, max: 10000000, integer: false },
	{ key: "outputPort", min: 1, max: 65535, integer: true },
	{ key: "rtlTcpPort", min: 1, max: 65535, integer: true },
	{ key: "spyServerPort", min: 1, max: 65535, integer: true },
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

describe("AisCatcherDecoder numeric option bounds", () => {
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

	const arg = (tokens: string[], flag: string) =>
		tokens[tokens.indexOf(flag) + 1]

	it("clamps gain and ppm in argv", () => {
		const high = argv(build({ gain: 999, ppm: 5000 }).view)
		expect(arg(high, "-gr")).toBe("tuner=60")
		expect(arg(high, "-p")).toBe("1000")
		const low = argv(build({ gain: -3, ppm: "-5000" }).view)
		expect(arg(low, "-gr")).toBe("tuner=0")
		expect(arg(low, "-p")).toBe("-1000")
	})

	it("garbage gain and ppm leave the flags out of argv", () => {
		const tokens = argv(build({ gain: "evil; id", ppm: Number.NaN }).view)
		expect(tokens).not.toContain("-gr")
		expect(tokens).not.toContain("-p")
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
				const tokens = argv(view)
				if (tokens.includes("-gr")) {
					const gain = Number(arg(tokens, "-gr")?.replace("tuner=", ""))
					expect(Number.isFinite(gain)).toBe(true)
					expect(gain).toBeGreaterThanOrEqual(0)
					expect(gain).toBeLessThanOrEqual(60)
				}
				if (tokens.includes("-p")) {
					const ppm = Number(arg(tokens, "-p"))
					expect(Number.isFinite(ppm)).toBe(true)
					expect(Math.abs(ppm)).toBeLessThanOrEqual(1000)
				}
				for (const token of tokens)
					expect(token).not.toMatch(/NaN|Infinity|e\+/)
			}),
			{ numRuns: 150 },
		)
	})
})
