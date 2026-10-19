import {
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
	DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
} from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { DiscoveryFilter } from "../../../../src/core/scanner/store/discovery-store.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const BASE_HZ = 150_000_000
const SLOT_HZ = 100_000

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function byDistance(hz: number) {
	return (a: Discovery, b: Discovery): number =>
		Math.abs(a.frequencyHz - hz) - Math.abs(b.frequencyHz - hz) ||
		compareText(a.id, b.id)
}

/** Brute force over the published list, not the store's index. */
function oracleNear(
	all: readonly Discovery[],
	hz: number,
	toleranceHz: number,
	sourceId: string | undefined,
): Discovery[] {
	return all
		.filter(d => Math.abs(d.frequencyHz - hz) <= toleranceHz)
		.filter(d => sourceId === undefined || d.sourceIds.includes(sourceId))
		.sort(byDistance(hz))
}

describe("discovery evidence filter and near query", () => {
	it("uses the default 6250 Hz window, inclusive, sorted by distance then id", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 20,
			now: () => T0,
			newId: counterIds(),
		})
		const centreId = store.ingest(
			makeObs({
				id: "o-centre",
				centreHz: 446_006_250,
				startedAt: T0,
				blocks: 2,
				sourceId: "s1",
			}),
		).discoveryId
		if (centreId === null) throw new Error("centre did not surface")
		const centre = store.get(centreId)
		if (centre === undefined) throw new Error("missing centre")
		const hz = centre.frequencyHz
		const placed = [
			{
				id: "o-minus",
				centreHz: hz - DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
				sourceId: "s1",
			},
			{
				id: "o-plus",
				centreHz: hz + DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
				sourceId: "s2",
			},
			{
				id: "o-out",
				centreHz: hz + DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ + 1,
				sourceId: "s3",
			},
		]
		const rows = [centre]
		for (const [index, spec] of placed.entries()) {
			const id = store.ingest(
				makeObs({
					id: spec.id,
					centreHz: spec.centreHz,
					startedAt: T0 + (index + 1) * 1_000,
					blocks: 2,
					sourceId: spec.sourceId,
				}),
			).discoveryId
			if (id === null) throw new Error(`${spec.id} did not surface`)
			const dto = store.get(id)
			if (dto === undefined) throw new Error(`missing ${spec.id}`)
			rows.push(dto)
		}
		const outside = rows.filter(
			d =>
				Math.abs(d.frequencyHz - hz) ===
				DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ + 1,
		)
		expect(outside).toHaveLength(1)
		const expected = oracleNear(
			rows,
			hz,
			DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
			undefined,
		)
		expect(
			store.near(hz, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ).map(d => d.id),
		).toEqual(expected.map(d => d.id))
		expect(
			store.near(hz, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ - 1).map(d => d.id),
		).toEqual(
			oracleNear(
				rows,
				hz,
				DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ - 1,
				undefined,
			).map(d => d.id),
		)
		expect(
			store.near(hz, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ, "s2").map(d => d.id),
		).toEqual(
			oracleNear(rows, hz, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ, "s2").map(
				d => d.id,
			),
		)
		expect(store.list({ nearHz: hz }).items.map(d => d.id)).toEqual(
			expected.map(d => d.id),
		)
		expect(
			store.list({ nearHz: hz, toleranceHz: DISCOVERY_NEAR_MAX_TOLERANCE_HZ })
				.items,
		).toEqual(
			oracleNear(
				store.list({ limit: 500 }).items,
				hz,
				DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
				undefined,
			),
		)
	})

	it("partitions proven and weak by the DTO evidence level", () => {
		// Feature: scanner-redesign, Property 9: The filter partitions
		// Validates: Requirements 3.6, 3.7, 7.6
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						slot: fc.integer({ min: 0, max: 30 }),
						source: fc.constantFrom("s1", "s2"),
						job: fc.constantFrom("j1", "j2"),
						kind: fc.constantFrom("weak", "proven", "decoded-without-proof"),
					}),
					{ minLength: 0, maxLength: 24 },
				),
				fc.integer({ min: 0, max: 30 }),
				fc.integer({ min: 0, max: 250_000 }),
				fc.option(fc.constantFrom("s1", "s2"), { nil: undefined }),
				(rows, nearSlot, toleranceHz, sourceId) => {
					const store = new DiscoveryStore({
						maxDiscoveries: 80,
						now: () => T0,
						newId: counterIds(),
					})
					rows.forEach((row, index) => {
						const obsId = `o${index}`
						const id = store.ingest(
							makeObs({
								id: obsId,
								centreHz: BASE_HZ + row.slot * SLOT_HZ,
								startedAt: T0 + index * 1_000,
								blocks: 2,
								sourceId: row.source,
								jobIds: [row.job],
							}),
						).discoveryId
						if (id === null) return
						if (row.kind === "weak") return
						const decode = evidence("dmr", T0 + index * 1_000 + 10, {
							identity: { kind: "dmr-cc", value: "1" },
						})
						if (row.kind === "proven") {
							expect(store.appendObservationEvidence(obsId, decode)).toBe(true)
						}
						// A second row on the same discovery can be a no-op. The
						// filter is judged on the published list, not this return.
						store.applyEvidence(id, decode)
					})
					const absent = store.list({ limit: 500 })
					const all = store.list({ limit: 500, evidence: "all" })
					expect(JSON.stringify(all)).toBe(JSON.stringify(absent))
					const proven = store.list({ limit: 500, evidence: "proven" }).items
					const weak = store.list({ limit: 500, evidence: "weak" }).items
					const provenIds = new Set(proven.map(d => d.id))
					const weakIds = new Set(weak.map(d => d.id))
					for (const id of provenIds) expect(weakIds.has(id)).toBe(false)
					expect(provenIds.size + weakIds.size).toBe(absent.items.length)
					for (const d of absent.items) {
						expect(
							d.evidenceLevel === "proven" || d.evidenceLevel === "weak",
						).toBe(true)
						if (d.evidenceLevel === "proven")
							expect(provenIds.has(d.id)).toBe(true)
						else expect(weakIds.has(d.id)).toBe(true)
					}
					for (const d of proven) expect(d.evidenceLevel).toBe("proven")
					for (const d of weak) expect(d.evidenceLevel).toBe("weak")
					const hz = BASE_HZ + nearSlot * SLOT_HZ
					const universe = absent.items
					const near = oracleNear(universe, hz, toleranceHz, sourceId)
					const got =
						sourceId === undefined
							? store.near(hz, toleranceHz)
							: store.near(hz, toleranceHz, sourceId)
					expect(got).toEqual(near)
					const filter: DiscoveryFilter = {
						limit: 500,
						evidence: "proven",
						nearHz: hz,
						toleranceHz,
					}
					if (sourceId !== undefined) filter.sourceId = sourceId
					expect(store.list(filter).items).toEqual(
						near.filter(d => d.evidenceLevel === "proven"),
					)
					const weakFilter: DiscoveryFilter = {
						limit: 500,
						evidence: "weak",
						nearHz: hz,
						toleranceHz,
					}
					if (sourceId !== undefined) weakFilter.sourceId = sourceId
					expect(store.list(weakFilter).items).toEqual(
						near.filter(d => d.evidenceLevel === "weak"),
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
