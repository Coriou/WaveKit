import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { z } from "zod"
import {
	CONFIG_EXPORT_OPTION_ALLOWLIST,
	CONFIG_EXPORT_REDACTED,
} from "@wavekit/api-types"
import { ConfigSchema } from "../../../../src/config.js"
import type { Config } from "../../../../src/config.js"
import {
	BUILTIN_OPTION_KEYS,
	CONFIG_EXPORT_NUMERIC_OPTION_KEYS,
	CONFIG_EXPORT_UNKNOWN_OPTIONS_KEY,
	POSITION_OPTION_KEY_PATTERN,
	exportConfig,
	redactConfig,
} from "../../../../src/core/config-export/export.js"
import {
	DECODER_OPTION_SCHEMAS,
	decoderOptionDescriptors,
} from "../../../../src/decoders/options/index.js"

const R = CONFIG_EXPORT_REDACTED
const META = { version: "1.2.3", generatedAt: "2026-10-16T00:00:00.000Z" }
const TYPES = Object.keys(DECODER_OPTION_SCHEMAS)

function baseConfig(): Config {
	return ConfigSchema.parse({
		sources: [
			{
				id: "src0",
				type: "rtl_tcp",
				host: "127.0.0.1",
				caps: { kind: "iq", sampleRate: 2_048_000, format: "U8_IQ" },
			},
		],
		decoders: [{ id: "d0", type: "readsb", enabled: true, options: {} }],
	})
}

function withOptions(type: string, options: Record<string, unknown>): Config {
	const config = baseConfig()
	config.decoders[0]!.type = type
	config.decoders[0]!.options = options
	return config
}

function optionsOf(config: Config): Record<string, unknown> {
	const r = redactConfig(config) as {
		decoders: { options: Record<string, unknown> }[]
	}
	return r.decoders[0]!.options
}

/** Shape of an option schema, through optional/nullable/default wrappers. */
function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
	let s: z.ZodTypeAny = schema
	for (;;) {
		if (
			s instanceof z.ZodOptional ||
			s instanceof z.ZodNullable ||
			s instanceof z.ZodDefault
		)
			s = (s._def as { innerType: z.ZodTypeAny }).innerType
		else if (s instanceof z.ZodEffects)
			s = (s as z.ZodEffects<z.ZodTypeAny>).innerType()
		else break
	}
	return s instanceof z.ZodObject
		? ((s as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>)
		: {}
}

describe("config export classifies decoder options by meaning", () => {
	it("redacts non-member strings and drops unknown keys (Sol repro 1)", () => {
		const config = withOptions("dsd-fme", {
			mode: "private.example",
			format: "F4PRIVATE",
			protocol: "sk_live_private1234",
			band: "47.123456789",
		})
		const body = exportConfig(config, META)
		for (const leak of [
			"private.example",
			"F4PRIVATE",
			"sk_live_private1234",
			"47.123456789",
			"protocol",
			"band",
		])
			expect(body).not.toContain(leak)
		expect(optionsOf(config)).toEqual({
			mode: R,
			[CONFIG_EXPORT_UNKNOWN_OPTIONS_KEY]: 3,
		})
	})

	it("redacts numbers outside the numeric allowlist and drops unknown keys with their values (Sol repro 2)", () => {
		const readsb = withOptions("readsb", { device: 55667788, gain: 42.1 })
		expect(exportConfig(readsb, META)).not.toContain("55667788")
		expect(optionsOf(readsb)).toEqual({ device: R, gain: 42.1 })

		const unknown = withOptions("readsb", {
			pin: 918273645,
			lat_deg: 47.123456789,
			alt_m: 431.517,
			telemetry: [{ gps: [47.12, 8.98, 431.5] }],
		})
		const body = exportConfig(unknown, META)
		for (const leak of [
			"918273645",
			"47.12",
			"8.98",
			"431.5",
			"pin",
			"lat_deg",
			"alt_m",
			"telemetry",
			"gps",
		])
			expect(body).not.toContain(leak)
		expect(optionsOf(unknown)).toEqual({
			[CONFIG_EXPORT_UNKNOWN_OPTIONS_KEY]: 4,
		})
	})

	it("drops every option of a decoder type without an option schema", () => {
		const config = withOptions("no-such-type", { frequency: 1e8, mode: "x" })
		expect(optionsOf(config)).toEqual({
			[CONFIG_EXPORT_UNKNOWN_OPTIONS_KEY]: 2,
		})
	})

	it("keeps allowlisted numbers only when the option schema accepts them, and nested arrays only where declared", () => {
		const config = withOptions("dsd-fme", {
			frequencies: [446_000_000, [47.12], -5],
			voiceSlot: 2,
			udpPort: 99_999_999,
			fmGain: 3,
		})
		expect(optionsOf(config)).toEqual({
			frequencies: [446_000_000, R, R],
			voiceSlot: 2,
			udpPort: R,
			fmGain: 3,
		})
	})

	it("redacts top-level values the schema does not classify, numbers included", () => {
		const config = baseConfig() as unknown as Record<string, unknown>
		config["future"] = { lat: 47.123456789, list: [8.987654321, 1234567] }
		const api = config["api"] as Record<string, unknown>
		api["host"] = 918273645
		const station = (config["station"] ?? {}) as Record<string, unknown>
		config["station"] = { ...station, name: 55667788 }
		const body = exportConfig(config as unknown as Config, META)
		for (const leak of [
			"47.123456789",
			"8.987654321",
			"1234567",
			"918273645",
			"55667788",
			"future",
		])
			expect(body).not.toContain(leak)
		const r = redactConfig(config as unknown as Config) as Record<
			string,
			unknown
		>
		expect(r["api"]).toMatchObject({ host: R, port: 9000 })
	})
})

describe("config export option tables cannot drift", () => {
	it("BUILTIN_OPTION_KEYS is the union of the described option keys", () => {
		const described = new Set(
			TYPES.flatMap(t => (decoderOptionDescriptors(t) ?? []).map(d => d.key)),
		)
		expect([...BUILTIN_OPTION_KEYS].sort()).toEqual([...described].sort())
	})

	it("numeric allowlist names declared, described, non-position options of known types", () => {
		expect(Object.keys(CONFIG_EXPORT_NUMERIC_OPTION_KEYS).sort()).toEqual(
			[...TYPES].sort(),
		)
		for (const [type, keys] of Object.entries(
			CONFIG_EXPORT_NUMERIC_OPTION_KEYS,
		)) {
			const described = new Set(
				(decoderOptionDescriptors(type) ?? []).map(d => d.key),
			)
			for (const keyPath of keys) {
				const segments = keyPath.split(".")
				expect(described.has(segments[0]!)).toBe(true)
				let shape = shapeOf(DECODER_OPTION_SCHEMAS[type]!)
				for (const segment of segments) {
					expect(Object.hasOwn(shape, segment)).toBe(true)
					expect(segment).not.toMatch(POSITION_OPTION_KEY_PATTERN)
					expect(segment).not.toMatch(/device|serial|index|pin|host/i)
					shape = shapeOf(shape[segment]!)
				}
			}
		}
	})
})

// --- Property -----------------------------------------------------------------

const hex = fc
	.uint8Array({ minLength: 6, maxLength: 6 })
	.map(b => Buffer.from(b).toString("hex"))
/** A generated secret: its text must never appear in the export. */
const secretString = fc.oneof(
	hex.map(h => `h${h}.example`),
	hex.map(h => `F4${h.toUpperCase()}`),
	hex.map(h => `sk_live_${h}`),
	fc
		.double({ min: -179, max: 179, noNaN: true })
		.filter(n => String(n).length >= 9)
		.map(n => String(n)),
)
const secretNumber = fc.oneof(
	fc.integer({ min: 10_000_000, max: 2_147_483_647 }),
	fc
		.double({ min: -179, max: 179, noNaN: true })
		.filter(n => !Number.isInteger(n) && String(n).length >= 9),
)
const secretScalar = fc.oneof(secretString, secretNumber)
const nested = fc.oneof(
	secretScalar.map(v => [[v]]),
	secretScalar.map(v => [{ gps: [v] }]),
	fc.tuple(hex, secretScalar).map(([k, v]) => ({ [`k${k}`]: { inner: v } })),
)
/** Values allowed under a numeric-allowlisted key: never a bare number or flat number list. */
const nonNumericValue = fc.oneof(
	secretString,
	nested,
	secretString.map(v => [v]),
)
const anyValue = fc.oneof(
	secretScalar,
	nonNumericValue,
	secretNumber.map(n => [n]),
)

function collectLeaves(value: unknown, out: string[]): void {
	if (typeof value === "string" || typeof value === "number")
		out.push(String(value))
	else if (Array.isArray(value)) for (const v of value) collectLeaves(v, out)
	else if (value !== null && typeof value === "object")
		for (const [k, v] of Object.entries(value)) {
			if (/^k[0-9a-f]{12}$/.test(k)) out.push(k)
			collectLeaves(v, out)
		}
}

describe("config export property", () => {
	// Feature: web-gaps-6, Property 14: No secret in export
	// Validates: Requirements 7.3, 7.4
	it("property: no generated decoder option value appears in the export, for every decoder type", () => {
		const entry = fc
			.tuple(
				fc.constantFrom(...TYPES),
				fc.array(
					fc.oneof(
						fc.constantFrom(...BUILTIN_OPTION_KEYS),
						fc.constantFrom("lat", "lon", "alt", "pin", "lat_deg", "band"),
						hex.map(h => `k${h}`),
					),
					{ minLength: 1, maxLength: 8 },
				),
			)
			.chain(([type, keys]) => {
				const numeric = new Set(
					(CONFIG_EXPORT_NUMERIC_OPTION_KEYS[type] ?? []).map(
						k => k.split(".")[0]!,
					),
				)
				return fc
					.tuple(
						...keys.map(k =>
							(numeric.has(k) ? nonNumericValue : anyValue).map(
								v => [k, v] as const,
							),
						),
					)
					.map(pairs => ({ type, options: Object.fromEntries(pairs) }))
			})
		fc.assert(
			fc.property(entry, ({ type, options }) => {
				const config = withOptions(type, options)
				const body = exportConfig(config, META)
				const generated: string[] = []
				collectLeaves(options, generated)
				for (const g of generated) {
					expect(body).not.toContain(g)
					expect(body).not.toContain(JSON.stringify(g).slice(1, -1))
				}
			}),
			{ numRuns: 300 },
		)
	})

	it("property: every kept decoder option string is an allowlisted enum member", () => {
		const allowlist = new Set(CONFIG_EXPORT_OPTION_ALLOWLIST)
		const entry = fc.constantFrom(...TYPES).chain(type => {
			const descriptors = decoderOptionDescriptors(type) ?? []
			return fc
				.tuple(
					...descriptors.map(d =>
						fc
							.oneof(
								fc.constantFrom(...(d.enumValues ?? ["free-text"])),
								secretString,
							)
							.map(v => [d.key, v] as const),
					),
				)
				.map(pairs => ({ type, options: Object.fromEntries(pairs) }))
		})
		fc.assert(
			fc.property(entry, ({ type, options }) => {
				const out = optionsOf(withOptions(type, options))
				const descriptors = decoderOptionDescriptors(type) ?? []
				for (const [key, value] of Object.entries(out)) {
					const strings = [value].flat().filter(v => typeof v === "string")
					for (const kept of strings.filter(v => v !== R)) {
						const d = descriptors.find(x => x.key === key)
						expect(allowlist.has(key)).toBe(true)
						expect(d?.enumValues ?? []).toContain(kept)
					}
				}
			}),
			{ numRuns: 200 },
		)
	})
})
