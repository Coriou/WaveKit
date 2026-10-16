// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.3, 9.5
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { ReadsbDecoder } from "../../../src/decoders/builtin/readsb.js"

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
		type: "readsb",
		enabled: true,
		...top,
		options: { rtlTcpHost: "10.0.0.2", ...options },
	} as unknown as DecoderConfig
	const decoder = new ReadsbDecoder(config, logger)
	const view = decoder as unknown as {
		options: Record<string, unknown>
		onOptionsUpdated(): void
		getArgs(): string[]
	}
	return { decoder, view, warn }
}

type View = ReturnType<typeof build>["view"]

function argv(view: View): string[] {
	return view.getArgs()
}

/** Bounds by meaning; the same numbers as the adapter's option schema. */
const RULES: Rule[] = [
	{ key: "gain", min: -10, max: 60, integer: false },
	{ key: "ppm", min: -1000, max: 1000, integer: false },
	{ key: "inputSampleRate", min: 1000, max: 10000000, integer: false },
	{ key: "rtlTcpPort", min: 1, max: 65535, integer: true },
	{ key: "outputPort", min: 1, max: 65535, integer: true },
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

describe("ReadsbDecoder numeric option bounds", () => {
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

	it("clamps gain and ppm in argv and keeps the auto keyword", () => {
		const high = argv(build({ gain: 999, ppm: 5000 }).view)
		expect(arg(high, "--gain")).toBe("60")
		expect(arg(high, "--ppm")).toBe("1000")
		const low = argv(build({ gain: -50, ppm: "-5000" }).view)
		expect(arg(low, "--gain")).toBe("-10")
		expect(arg(low, "--ppm")).toBe("-1000")
		expect(arg(argv(build({ gain: "auto" }).view), "--gain")).toBe("auto")
	})

	it("garbage gain and ppm leave the flags out of argv, text keywords other than auto too", () => {
		for (const gain of ["evil; id", "auto-verbose", Number.NaN]) {
			const tokens = argv(build({ gain, ppm: "evil" }).view)
			expect(tokens).not.toContain("--gain")
			expect(tokens).not.toContain("--ppm")
		}
	})

	it("puts a bounded port in the net-connector, the default for garbage", () => {
		expect(arg(argv(build({ rtlTcpPort: 1e9 }).view), "--net-connector")).toBe(
			"10.0.0.2,65535,beast_in",
		)
		expect(arg(argv(build({ rtlTcpPort: "x" }).view), "--net-connector")).toBe(
			"10.0.0.2,1234,beast_in",
		)
	})

	it("bounds the stdin-mode input rate in the resample command", () => {
		const { view } = build({ rtlTcpHost: null, inputSampleRate: 1e99 })
		const command = argv(view)[1] ?? ""
		expect(command).toContain("10000000")
		expect(command).not.toMatch(/e\+|Infinity|NaN/)
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
				if (tokens.includes("--gain")) {
					const raw = arg(tokens, "--gain")
					if (raw !== "auto") {
						const gain = Number(raw)
						expect(Number.isFinite(gain)).toBe(true)
						expect(gain).toBeGreaterThanOrEqual(-10)
						expect(gain).toBeLessThanOrEqual(60)
					}
				}
				if (tokens.includes("--ppm"))
					expect(Math.abs(Number(arg(tokens, "--ppm")))).toBeLessThanOrEqual(
						1000,
					)
				const port = Number(arg(tokens, "--net-connector")?.split(",")[1])
				expect(Number.isInteger(port)).toBe(true)
				expect(port).toBeGreaterThanOrEqual(1)
				expect(port).toBeLessThanOrEqual(65535)
				for (const token of tokens)
					expect(token).not.toMatch(/NaN|Infinity|e\+/)
			}),
			{ numRuns: 150 },
		)
	})
})
