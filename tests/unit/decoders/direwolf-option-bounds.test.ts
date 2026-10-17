// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"

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
		type: "direwolf",
		enabled: true,
		...top,
		options: { ...options },
	} as unknown as DecoderConfig
	const decoder = new DirewolfDecoder(config, logger)
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
	{ key: "kissPort", min: 1, max: 65535, integer: true },
	{ key: "agwPort", min: 1, max: 65535, integer: true },
	{ key: "inputSampleRate", min: 1000, max: 10000000, integer: false },
	{ key: "sampleRate", min: 8000, max: 192000, integer: false },
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

describe("DirewolfDecoder numeric option bounds", () => {
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

	it("clamps the KISS and AGW ports in argv", () => {
		const high = argv(build({ kissPort: 99999, agwPort: "70000" }).view)
		expect(arg(high, "-p")).toBe("65535")
		expect(arg(high, "-a")).toBe("65535")
		const low = argv(build({ kissPort: 0, agwPort: -4 }).view)
		expect(arg(low, "-p")).toBe("1")
		expect(arg(low, "-a")).toBe("1")
	})

	it("garbage ports fall to the default ports in argv", () => {
		const tokens = argv(
			build({ kissPort: "evil; id", agwPort: Number.NaN }).view,
		)
		expect(arg(tokens, "-p")).toBe("8001")
		expect(arg(tokens, "-a")).toBe("8000")
	})

	it("the KISS port the adapter connects to is bounded too", () => {
		const { decoder } = build({ kissPort: 1e9 })
		expect((decoder as unknown as { outputPort: number }).outputPort).toBe(
			65535,
		)
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
				for (const flag of ["-p", "-a", "-r"]) {
					const n = Number(arg(tokens, flag))
					expect(Number.isInteger(n)).toBe(true)
					expect(n).toBeGreaterThanOrEqual(1)
					expect(n).toBeLessThanOrEqual(65535)
				}
				for (const token of tokens)
					expect(token).not.toMatch(/NaN|Infinity|e\+/)
			}),
			{ numRuns: 150 },
		)
	})
})
