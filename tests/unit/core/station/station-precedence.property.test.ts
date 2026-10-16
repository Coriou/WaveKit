// Feature: web-gaps-4, Property 10: Station precedence
// Validates: Requirements 6.1, 6.2, 6.3, 6.6
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import fc from "fast-check"
import type { StationField, StationUpdate } from "@wavekit/api-types"
import { STATION_FIELDS } from "@wavekit/api-types"
import { ConfigSchema } from "../../../../src/config.js"
import { StationUpdateError } from "../../../../src/core/station/errors.js"
import {
	pinnedFields,
	resolveStation,
} from "../../../../src/core/station/layers.js"
import type {
	StationLayers,
	StationLayerValues,
} from "../../../../src/core/station/layers.js"
import { openStationService } from "../../../../src/core/station/station-service.js"
import type * as FsPromisesModule from "node:fs/promises"
import { makeTmp, removeTmp, stubLogger } from "./helpers.js"

// fsync costs 40-90 ms per write on macOS; the model run stubs it (the atomic write itself is
// real). Durability is exercised unstubbed in station-service.test.ts.
type FsPromises = typeof FsPromisesModule

vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<FsPromises>()
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args)
			handle.sync = () => Promise.resolve()
			return handle
		},
	}
})

const valueArb: Record<StationField, fc.Arbitrary<string | number>> = {
	name: fc.constantFrom("Yard", "Roof", "Shed"),
	lat: fc.double({ min: -90, max: 90, noNaN: true }),
	lon: fc.double({ min: -180, max: 180, noNaN: true }),
	altM: fc.integer({ min: -100, max: 5000 }),
	callsign: fc.constantFrom("G0ABC", "K1XYZ"),
	country: fc.constantFrom("GB", "US", "FR"),
}

function layerArb(): fc.Arbitrary<StationLayerValues> {
	return fc.record(valueArb, { requiredKeys: [] })
}

const originsArb = fc.record(
	{
		name: fc.constantFrom("yaml" as const, "env" as const),
		lat: fc.constantFrom("yaml" as const, "env" as const),
		lon: fc.constantFrom("yaml" as const, "env" as const),
		altM: fc.constantFrom("yaml" as const, "env" as const),
		callsign: fc.constantFrom("yaml" as const, "env" as const),
		country: fc.constantFrom("yaml" as const, "env" as const),
	},
	{ requiredKeys: [] },
)

/** Naive model of requirement 6.3 with the pair rule. */
function model(layers: StationLayers) {
	const out: Record<string, { value: unknown; provenance: string }> = {}
	const configPair =
		layers.configured.lat !== undefined || layers.configured.lon !== undefined
	const uiPair = layers.ui.lat !== undefined && layers.ui.lon !== undefined
	for (const field of STATION_FIELDS) {
		const c = layers.configured[field]
		const cOrigin = layers.origins[field] ?? "yaml"
		const u = layers.ui[field]
		const isPair = field === "lat" || field === "lon"
		if (c !== undefined) out[field] = { value: c, provenance: cOrigin }
		else if (isPair && configPair)
			out[field] = { value: null, provenance: "default" }
		else if (u !== undefined && (!isPair || uiPair))
			out[field] = { value: u, provenance: "ui" }
		else out[field] = { value: null, provenance: "default" }
	}
	return out
}

describe("Property 10: station precedence (pure layers)", () => {
	it("effective identity equals the precedence model; pins and pair rule hold", () => {
		fc.assert(
			fc.property(
				layerArb(),
				originsArb,
				layerArb(),
				(configured, origins, ui) => {
					const layers: StationLayers = { configured, origins, ui }
					const effective = resolveStation(layers)
					expect(effective).toEqual(model(layers))
					const pinned = pinnedFields(layers)
					for (const field of STATION_FIELDS) {
						expect(pinned.has(field)).toBe(
							configured[field] !== undefined ||
								((field === "lat" || field === "lon") &&
									(configured.lat !== undefined ||
										configured.lon !== undefined)),
						)
					}
					// With a consistent config pair, the effective pair is both set or both null.
					if (
						(configured.lat === undefined) ===
						(configured.lon === undefined)
					) {
						expect(effective.lat.value === null).toBe(
							effective.lon.value === null,
						)
					}
				},
			),
			{ numRuns: 300 },
		)
	})
})

const patchArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
	{
		name: fc.oneof(valueArb.name, fc.constant(null), fc.constant("")),
		lat: fc.oneof(valueArb.lat, fc.constant(null), fc.constant(100)),
		lon: fc.oneof(valueArb.lon, fc.constant(null)),
		altM: fc.oneof(valueArb.altM, fc.constant(null)),
		callsign: fc.oneof(valueArb.callsign, fc.constant(null)),
		country: fc.oneof(valueArb.country, fc.constant(null), fc.constant("ZZ")),
		bogus: fc.constant(1),
	},
	{ requiredKeys: [] },
)

describe("Property 10: station precedence (service model)", () => {
	let dir: string
	beforeAll(async () => {
		dir = await makeTmp()
	})
	afterAll(async () => {
		await removeTmp(dir)
	})

	it("pinned fields never change, rejected patches change nothing, pair invariant", async () => {
		const at = "2026-10-16T10:00:00.000Z"
		await fc.assert(
			fc.asyncProperty(
				// Consistent config pair keeps today's YAML semantics out of the invariant.
				layerArb().map((c): StationLayerValues => {
					if ((c.lat === undefined) !== (c.lon === undefined)) {
						const { lat: _lat, lon: _lon, ...rest } = c
						return rest
					}
					return c
				}),
				layerArb(),
				patchArb,
				async (configured, ui, patch) => {
					await rm(join(dir, "station.json"), { force: true })
					const fields: Record<string, unknown> = {}
					for (const [key, value] of Object.entries(ui)) {
						fields[key] = { value, provenance: "ui", updatedAt: at }
					}
					await writeFile(
						join(dir, "station.json"),
						JSON.stringify({ schemaVersion: 1, revision: 4, fields }),
					)
					const service = await openStationService({
						config: ConfigSchema.parse({ station: configured }),
						region: "EU",
						stateDir: dir,
						logger: stubLogger().logger,
						writable: true,
					})
					const before = service.identity()
					let rejected = false
					try {
						const result = await service.update(patch as StationUpdate)
						expect(result.revision).toBe(5)
					} catch (error: unknown) {
						expect(error).toBeInstanceOf(StationUpdateError)
						rejected = true
					}
					const after = service.identity()
					if (rejected) expect(after).toEqual(before)
					for (const field of STATION_FIELDS) {
						if (configured[field] !== undefined) {
							expect(after[field]).toEqual(before[field])
						}
					}
					expect(after.lat.value === null).toBe(after.lon.value === null)
					expect(after.effectiveCountry).toBe(after.country.value)
					await service.close()
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000)
})
