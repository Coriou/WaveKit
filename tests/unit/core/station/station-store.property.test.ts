// Feature: web-gaps-4, Property 11: Station store
// Validates: Requirements 6.4, 6.7
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import fc from "fast-check"
import type { StationField } from "@wavekit/api-types"
import type { StationStoredValue } from "../../../../src/core/station/contract.js"
import {
	loadStationStore,
	parseStationStore,
	serializeStationStore,
	validateStationValue,
} from "../../../../src/core/station/store.js"
import { makeTmp, removeTmp, stubLogger } from "./helpers.js"

const updatedAt = fc
	.integer({ min: 0, max: 4_102_444_800_000 })
	.map(ms => new Date(ms).toISOString())
const stored = <T extends string | number>(value: fc.Arbitrary<T>) =>
	fc.record({ value, provenance: fc.constant("ui" as const), updatedAt })

const fieldsArb = fc
	.record(
		{
			name: stored(
				fc
					.string({ minLength: 1, maxLength: 256 })
					.filter(s => s.trim() === s && s.length > 0),
			),
			altM: stored(
				fc.double({ min: -1e6, max: 1e6, noNaN: true }).map(v => v + 0),
			),
			callsign: stored(
				fc
					.string({ minLength: 1, maxLength: 128 })
					.filter(s => s.trim() === s && s.length > 0),
			),
			country: stored(fc.constantFrom("GB", "US", "DE")),
			pair: fc.tuple(
				stored(fc.double({ min: -90, max: 90, noNaN: true }).map(v => v + 0)),
				stored(fc.double({ min: -180, max: 180, noNaN: true }).map(v => v + 0)),
			),
		},
		{ requiredKeys: [] },
	)
	.map(({ pair, ...rest }) => {
		const out: Partial<Record<StationField, StationStoredValue>> = { ...rest }
		if (pair) {
			out.lat = pair[0]
			out.lon = pair[1]
		}
		return out
	})

describe("Property 11: station store", () => {
	let dir: string
	beforeAll(async () => {
		dir = await makeTmp()
	})
	afterAll(async () => {
		await removeTmp(dir)
	})
	beforeEach(async () => {
		for (const name of await readdir(dir))
			await rm(join(dir, name), { force: true })
	})

	it("any valid layer round-trips through the file", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1_000_000 }),
				fieldsArb,
				(revision, fields) => {
					const state = { revision, fields }
					const bytes = new TextEncoder().encode(serializeStationStore(state))
					expect(bytes.length).toBeLessThanOrEqual(4096)
					expect(parseStationStore(bytes)).toEqual(state)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("any byte string loads empty or valid, never throws, at most one corrupt copy", async () => {
		let tick = 0
		const bytesArb = fc.oneof(
			fc.uint8Array({ maxLength: 5000 }),
			fc.json().map(s => new TextEncoder().encode(s)),
			fc
				.record({
					schemaVersion: fc.oneof(fc.constant(1), fc.integer()),
					revision: fc.oneof(fc.nat(), fc.integer()),
					fields: fc.dictionary(
						fc.constantFrom(
							"name",
							"lat",
							"lon",
							"altM",
							"callsign",
							"country",
							"x",
						),
						fc.record({
							value: fc.oneof(fc.string(), fc.double(), fc.constant(null)),
							provenance: fc.constantFrom("ui", "yaml"),
							updatedAt: fc.constantFrom("2026-10-16T10:00:00.000Z", "nope"),
						}),
					),
				})
				.map(o => new TextEncoder().encode(JSON.stringify(o))),
		)
		await fc.assert(
			fc.asyncProperty(bytesArb, async bytes => {
				await writeFile(join(dir, "station.json"), bytes)
				const state = await loadStationStore(
					dir,
					stubLogger().logger,
					() => ++tick,
				)
				expect(Number.isInteger(state.revision)).toBe(true)
				for (const [field, entry] of Object.entries(state.fields)) {
					expect(validateStationValue(field as StationField, entry.value)).toBe(
						entry.value,
					)
					expect(entry.provenance).toBe("ui")
				}
				expect(state.fields.lat === undefined).toBe(
					state.fields.lon === undefined,
				)
				const corrupt = (await readdir(dir)).filter(n =>
					n.startsWith("station.json.corrupt-"),
				)
				expect(corrupt.length).toBeLessThanOrEqual(1)
				if (state.revision === 0 && Object.keys(state.fields).length === 0)
					return
				expect(corrupt.length === 0 || state.revision >= 0).toBe(true)
			}),
			{ numRuns: 100 },
		)
	}, 20_000)
})
