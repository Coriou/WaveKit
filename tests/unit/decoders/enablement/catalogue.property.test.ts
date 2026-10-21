import { expect, it } from "vitest"
import fc from "fast-check"
import type { DecoderConfig } from "../../../../src/config.js"
import { CATALOGUE_TYPES } from "../../../../src/decoders/enablement/contract.js"
import { buildDecoderCatalogue } from "../../../../src/decoders/enablement/catalogue.js"

// Feature: decoder-enablement, Property 1: Catalogue completeness
// Validates: Requirements 1.1, 1.2, 1.5
it("preserves YAML order and adds exactly the unclaimed catalogue types without duplicate ids", () => {
	const name = fc.oneof(
		fc.constantFrom(...CATALOGUE_TYPES),
		fc.string({ minLength: 1 }),
	)
	fc.assert(
		fc.property(
			fc.uniqueArray(fc.record({ id: name, type: name }), {
				selector: c => c.id,
			}),
			fc.boolean(),
			(entries, enabled) => {
				const configs: DecoderConfig[] = entries.map(c => ({
					...c,
					enabled: true,
					options: {},
					useChannelizer: false,
				}))
				const result = buildDecoderCatalogue(configs, { enabled, region: "EU" })
				configs.forEach((config, index) => expect(result[index]).toBe(config))
				const expected = enabled
					? CATALOGUE_TYPES.filter(
							type => !configs.some(c => c.id === type || c.type === type),
						)
					: []
				expect(result.slice(configs.length).map(c => c.type)).toEqual(expected)
				expect(new Set(result.map(c => c.id)).size).toBe(result.length)
			},
		),
		{ numRuns: 200 },
	)
})
