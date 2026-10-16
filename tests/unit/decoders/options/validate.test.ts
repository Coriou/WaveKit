import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DECODER_OPTION_ISSUES_MAX,
	DECODER_OPTION_ISSUE_TEXT_MAX,
} from "@wavekit/api-types"
import {
	DECODER_OPTION_SCHEMAS,
	validateDecoderOptions,
} from "../../../../src/decoders/options/index.js"

const TYPES = Object.keys(DECODER_OPTION_SCHEMAS)

describe("validateDecoderOptions", () => {
	it("covers all nine types", () => {
		expect(TYPES.sort()).toEqual(
			[
				"acarsdec",
				"ais-catcher",
				"direwolf",
				"dsd-fme",
				"dumpvdl2",
				"lora-meshtastic",
				"multimon-ng",
				"readsb",
				"rtl433",
			].sort(),
		)
	})

	it("accepts valid options", () => {
		expect(validateDecoderOptions("rtl433", {})).toEqual([])
		expect(
			validateDecoderOptions("rtl433", {
				outputFormat: "json",
				protocols: [1],
			}),
		).toEqual([])
	})

	it("reports an unknown key", () => {
		expect(validateDecoderOptions("rtl433", { nope: 1 })).toEqual([
			{ path: "nope", code: "unknown-key", message: "unknown option" },
		])
	})

	it("reports a wrong type", () => {
		const issues = validateDecoderOptions("rtl433", { analyze: "yes" })
		expect(issues).toEqual([
			{ path: "analyze", code: "invalid-value", message: "expected boolean" },
		])
	})

	it("reports out-of-range values", () => {
		const issues = validateDecoderOptions("direwolf", { kissPort: 70000 })
		expect(issues).toEqual([
			{
				path: "kissPort",
				code: "invalid-value",
				message: "expected at most 65535",
			},
		])
	})

	it("reports an enum miss without echoing the value", () => {
		const issues = validateDecoderOptions("rtl433", {
			outputFormat: "xml-secret",
		})
		expect(issues).toHaveLength(1)
		expect(issues?.[0]?.message).toBe("expected one of json, csv")
	})

	it("uses a dotted path for list items", () => {
		const issues = validateDecoderOptions("acarsdec", {
			frequencies: [131550000, 131725000, "x"],
		})
		expect(issues?.map(i => i.path)).toEqual(["frequencies.2"])
	})

	it("prefixes nested unknown keys with the parent path", () => {
		const issues = validateDecoderOptions("multimon-ng", {
			filters: { bad: 1 },
		})
		expect(issues).toEqual([
			{ path: "filters.bad", code: "unknown-key", message: "unknown option" },
		])
	})

	it("keeps 31 issues and counts the rest in a truncated issue", () => {
		const options: Record<string, number> = {}
		for (let i = 0; i < 40; i++) options[`k${String(i).padStart(2, "0")}`] = i
		const issues = validateDecoderOptions("rtl433", options)
		expect(issues).toHaveLength(DECODER_OPTION_ISSUES_MAX)
		expect(issues?.at(-1)).toEqual({
			path: "",
			code: "truncated",
			message: "9 more",
		})
		expect(issues?.slice(0, 31).every(i => i.code === "unknown-key")).toBe(true)
	})

	it("does not truncate at exactly 32 issues", () => {
		const options: Record<string, number> = {}
		for (let i = 0; i < 32; i++) options[`k${String(i).padStart(2, "0")}`] = i
		const issues = validateDecoderOptions("rtl433", options)
		expect(issues).toHaveLength(32)
		expect(issues?.some(i => i.code === "truncated")).toBe(false)
	})

	it("cuts a long unknown key path to 256 code units", () => {
		const issues = validateDecoderOptions("rtl433", { ["a".repeat(300)]: 1 })
		expect(issues?.[0]?.path).toHaveLength(DECODER_OPTION_ISSUE_TEXT_MAX)
	})

	it("returns undefined for unknown and prototype type names", () => {
		expect(validateDecoderOptions("nope", {})).toBeUndefined()
		expect(validateDecoderOptions("constructor", {})).toBeUndefined()
		expect(validateDecoderOptions("__proto__", {})).toBeUndefined()
		expect(validateDecoderOptions("toString", {})).toBeUndefined()
	})

	it("reports non-object options at the root", () => {
		expect(validateDecoderOptions("rtl433", null)).toEqual([
			{ path: "", code: "invalid-value", message: "expected object" },
		])
		expect(validateDecoderOptions("rtl433", [])?.[0]?.path).toBe("")
	})

	it("reports missing required lora keys", () => {
		const issues = validateDecoderOptions("lora-meshtastic", {})
		expect(issues?.map(i => i.path)).toEqual([
			"channelKey",
			"frequency",
			"preset",
			"region",
		])
	})

	// Feature: web-gaps-6, Property 7: Issue bounds and secrecy
	// Validates: Requirements 3.3
	it("property: issues are bounded and never contain option values", () => {
		const SECRET = "ZQ9#secret-marker-"
		const secretArb = fc
			.string({ minLength: 8, maxLength: 40 })
			.map(s => `${SECRET}${s}`)
		const keyArb = fc.oneof(
			fc.string({ minLength: 1, maxLength: 12 }),
			fc.string({ minLength: 200, maxLength: 400 }),
			fc.constantFrom(
				"frequencies",
				"channelKey",
				"outputFormat",
				"modes",
				"filters",
				"extraArgs",
				"kissPort",
				"region",
				"device",
			),
		)
		const valueArb: fc.Arbitrary<unknown> = fc.oneof(
			secretArb,
			secretArb.map(s => [s, s]),
			secretArb.map(s => ({ nested: s })),
			secretArb.map(s => ({ bad: s, highpass: s })),
			fc.integer(),
			fc.constant(null),
		)
		fc.assert(
			fc.property(
				fc.constantFrom(...TYPES),
				fc.array(fc.tuple(keyArb, valueArb), { maxLength: 60 }),
				(type, entries) => {
					const options: Record<string, unknown> = {}
					for (const [k, v] of entries) options[k] = v
					const issues = validateDecoderOptions(type, options)
					expect(issues).toBeDefined()
					expect(issues?.length).toBeLessThanOrEqual(DECODER_OPTION_ISSUES_MAX)
					for (const issue of issues ?? []) {
						expect(issue.path.length).toBeLessThanOrEqual(
							DECODER_OPTION_ISSUE_TEXT_MAX,
						)
						expect(issue.message.length).toBeLessThanOrEqual(
							DECODER_OPTION_ISSUE_TEXT_MAX,
						)
						expect(issue.message).not.toContain(SECRET)
						expect(issue.path).not.toContain(SECRET)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
