import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import fc from "fast-check"
import { parse } from "yaml"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../../../src/config.js"
import {
	DECODER_OPTION_SCHEMAS,
	validateDecoderOptions,
} from "../../../../src/decoders/options/index.js"

const CONFIG_DIR = join(process.cwd(), "config")

interface RealDecoder {
	file: string
	id: string
	type: string
	options: Record<string, unknown>
}

/**
 * Every decoder of every shipped config/*.yaml. Goes through ConfigSchema (so
 * defaults apply); a partial file that fails it falls back to the raw `decoders`
 * array. No test fixture file (tests/**.yaml|json) configures these types; the
 * shipped YAML is the whole corpus.
 */
function loadDecoders(): RealDecoder[] {
	const out: RealDecoder[] = []
	for (const file of readdirSync(CONFIG_DIR).filter(f => f.endsWith(".yaml"))) {
		const raw: unknown = parse(readFileSync(join(CONFIG_DIR, file), "utf8"))
		if (typeof raw !== "object" || raw === null) continue
		const parsed = ConfigSchema.safeParse(raw)
		const list: unknown = parsed.success
			? parsed.data.decoders
			: (raw as { decoders?: unknown }).decoders
		if (!Array.isArray(list)) continue
		for (const entry of list as Array<Record<string, unknown>>) {
			out.push({
				file,
				id: String(entry["id"]),
				type: String(entry["type"]),
				options: (entry["options"] ?? {}) as Record<string, unknown>,
			})
		}
	}
	return out
}

const DECODERS = loadDecoders()

describe("shipped configs against the option schemas", () => {
	it("finds decoders to check", () => {
		expect(DECODERS.length).toBeGreaterThan(0)
	})

	it.each(DECODERS.map(d => [`${d.file} ${d.id} (${d.type})`, d] as const))(
		"%s",
		(_name, d) => {
			const issues = validateDecoderOptions(d.type, d.options)
			if (issues === undefined) {
				// Only types without a schema may skip validation.
				expect(Object.hasOwn(DECODER_OPTION_SCHEMAS, d.type)).toBe(false)
				return
			}
			expect(issues).toEqual([])
		},
	)

	// Feature: web-gaps-6, Property 6: Option schemas accept real configs
	// Validates: Requirements 3.1, 3.2, 3.3, 3.6
	it("property: any extra unknown key is reported as unknown-key", () => {
		const schemaDecoders = DECODERS.filter(d =>
			Object.hasOwn(DECODER_OPTION_SCHEMAS, d.type),
		)
		expect(schemaDecoders.length).toBeGreaterThan(0)
		fc.assert(
			fc.property(
				fc.constantFrom(...schemaDecoders),
				fc.string({ minLength: 1, maxLength: 40 }),
				fc.jsonValue(),
				(d, rawKey, value) => {
					const key = `x-${rawKey}`
					const options = { ...d.options }
					// Defined, not assigned: "__proto__" style keys stay own keys.
					Object.defineProperty(options, key, {
						value,
						enumerable: true,
						configurable: true,
						writable: true,
					})
					expect(validateDecoderOptions(d.type, options)).toEqual([
						{ path: key, code: "unknown-key", message: "unknown option" },
					])
				},
			),
			{ numRuns: 100 },
		)
	})
})
