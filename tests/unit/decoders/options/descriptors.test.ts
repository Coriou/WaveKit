import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
	DECODER_OPTION_SCHEMAS,
	decoderOptionDescriptors,
} from "../../../../src/decoders/options/index.js"

/** Strips optional/default/nullable/catch/effects wrappers down to the core schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
	let current = schema
	for (;;) {
		if (current instanceof z.ZodOptional || current instanceof z.ZodNullable)
			current = current.unwrap()
		else if (current instanceof z.ZodDefault) current = current.removeDefault()
		else if (current instanceof z.ZodCatch) current = current.removeCatch()
		else if (current instanceof z.ZodEffects) current = current.innerType()
		else return current
	}
}

function shapeOf(schema: z.ZodTypeAny): z.ZodRawShape {
	const core = unwrap(schema)
	if (!(core instanceof z.ZodObject)) throw new Error("schema is not an object")
	return core.shape as z.ZodRawShape
}

function inclusiveBound(
	schema: z.ZodNumber,
	kind: "min" | "max",
): number | undefined {
	for (const check of schema._def.checks)
		if (check.kind === kind && check.inclusive) return check.value
	return undefined
}

const TYPES = Object.keys(DECODER_OPTION_SCHEMAS)

describe("decoder option descriptors", () => {
	it.each(TYPES)("%s: keys match the schema shape and are sorted", type => {
		const schema = DECODER_OPTION_SCHEMAS[type]
		const descriptors = decoderOptionDescriptors(type)
		expect(schema).toBeDefined()
		expect(descriptors).toBeDefined()
		const keys = (descriptors ?? []).map(d => d.key)
		expect(keys).toEqual([...keys].sort())
		expect(new Set(keys).size).toBe(keys.length)
		expect(keys).toEqual(Object.keys(shapeOf(schema as z.ZodTypeAny)).sort())
		for (const d of descriptors ?? []) {
			expect(d.effect).toBe("restart")
			expect(d.description.length).toBeGreaterThan(0)
		}
	})

	it.each(TYPES)("%s: enum values and ranges agree with the schema", type => {
		const shape = shapeOf(DECODER_OPTION_SCHEMAS[type] as z.ZodTypeAny)
		for (const d of decoderOptionDescriptors(type) ?? []) {
			const field = shape[d.key]
			expect(field, d.key).toBeDefined()
			let core = unwrap(field as z.ZodTypeAny)
			if (d.type === "enum" || d.enumValues) {
				if (core instanceof z.ZodArray) core = unwrap(core.element)
				if (core instanceof z.ZodUnion)
					core = (core.options as z.ZodTypeAny[]).find(
						o => o instanceof z.ZodEnum,
					) as z.ZodTypeAny
				expect(core, d.key).toBeInstanceOf(z.ZodEnum)
				expect(d.enumValues, d.key).toEqual(
					(core as z.ZodEnum<[string, ...string[]]>).options,
				)
			}
			if (core instanceof z.ZodArray) core = unwrap(core.element)
			// Number-or-numeric-text keys: the range lives on the number form.
			if (
				core instanceof z.ZodUnion &&
				(d.type === "number" ||
					d.type === "integer" ||
					d.type === "number-list")
			) {
				const numeric = (core.options as z.ZodTypeAny[])
					.map(unwrap)
					.find(o => o instanceof z.ZodNumber)
				if (numeric) core = numeric
			}
			if (core instanceof z.ZodNumber) {
				expect(d.min, `${d.key} min`).toBe(inclusiveBound(core, "min"))
				expect(d.max, `${d.key} max`).toBe(inclusiveBound(core, "max"))
			}
		}
	})

	it("marks the Meshtastic channelKey secret and nothing else", () => {
		const lora = decoderOptionDescriptors("lora-meshtastic") ?? []
		expect(lora.find(d => d.key === "channelKey")?.secret).toBe(true)
		expect(lora.filter(d => d.secret).map(d => d.key)).toEqual(["channelKey"])
	})

	it("returns a copy and undefined for unknown types", () => {
		const first = decoderOptionDescriptors("rtl433")
		first?.pop()
		expect(decoderOptionDescriptors("rtl433")?.length).toBeGreaterThan(
			first?.length ?? 0,
		)
		expect(decoderOptionDescriptors("nope")).toBeUndefined()
		expect(decoderOptionDescriptors("constructor")).toBeUndefined()
		expect(decoderOptionDescriptors("__proto__")).toBeUndefined()
	})
})
