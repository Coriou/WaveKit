// WG15 DQ requirement 9: young records and weak protocol guesses (design Properties 19 to 22).
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { DQ_YOUNG_OBW_RATIO } from "../../../../src/core/scanner/detection-quality-contract.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	ProtocolFamily,
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	F,
	SRC,
	T0,
	carrierOnly,
	ids,
	newStore,
	obs,
	restored,
	tone,
} from "./discovery-store-young-fixtures.js"
import type { LegacySpec } from "./discovery-store-young-fixtures.js"

const CLASSES: ScannerClass[] = [
	"analog-fm",
	"wideband",
	"carrier",
	"unknown",
	"fsk4-12k5",
]

/** Candidate guesses a record may carry with no decode, identity or proof. */
const GUESSES: [ScannerProtocol, ProtocolFamily][] = [
	["pocsag", "pager"],
	["dmr", "digital-voice"],
	["analog-fm", "analog"],
	["dpmr", "digital-voice"],
	["carrier", "carrier"],
	["unknown", "unknown"],
	["flex", "pager"],
]
const WEAK_CONFIDENCE: ScannerConfidence[] = [
	"activity",
	"candidate",
	"classified",
]

/** Every merge path a stored pair can meet: plan, settle (rekey), sticky + lazy, key match. */
function everyPath(store: DiscoveryStore, centreHz: number): void {
	const plan = store.consolidationPlan()
	store.applyConsolidation(plan)
	store.rekey(SRC, 0)
	store.ingest(
		obs({
			id: "probe",
			centreHz,
			at: T0 + 500_000,
			obwHz: 8_000,
			peakDbfs: -50,
		}),
	)
	store.rekey(SRC, 0)
}

describe("detection-quality amendment 9 properties", () => {
	it("young convergence", () => {
		// Feature: detection-quality, Property 19: Young convergence
		// Validates: Requirements 9.2, 9.3
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						dHz: fc.integer({ min: -300, max: 300 }),
						obwHz: fc.integer({ min: 13_000, max: 39_000 }),
						peakDbfs: fc.double({ min: -37, max: -34, noNaN: true }),
						snrDb: fc.double({ min: 18, max: 30, noNaN: true }),
						cls: fc.constantFrom(...CLASSES),
						carrier: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 30 },
				),
				fc.integer({ min: 0, max: 30 }),
				(seq, narrowRun) => {
					const { store } = newStore()
					// any run of narrow observations before the first wide one
					const all = [
						...Array.from({ length: Math.min(narrowRun, 5) }, (_, i) => ({
							dHz: (i * 97) % 300,
							obwHz: 13_000,
							peakDbfs: -34,
							snrDb: 24,
							cls: "carrier" as ScannerClass,
							carrier: i === 0,
						})),
						...seq,
					]
					all.forEach((s, i) => {
						const id = `o${i}`
						store.ingest(
							obs({
								id,
								centreHz: F + s.dHz,
								at: T0 + i * 4_000,
								obwHz: s.obwHz,
								peakDbfs: s.peakDbfs,
								snrDb: s.snrDb,
								cls: s.cls,
							}),
						)
						if (s.carrier) store.recordAnalog(id, carrierOnly(T0 + i * 4_000))
					})
					expect(ids(store)).toHaveLength(1)
					expect(store.recordCounts().observations).toBe(all.length)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("weak guesses do not split", () => {
		// Feature: detection-quality, Property 20: Weak guesses do not split
		// Validates: Requirements 9.1, 9.6
		const recordArb = fc.record({
			dHz: fc.integer({ min: -500, max: 500 }),
			obwHz: fc.integer({ min: 8_000, max: 12_000 }),
			peakDbfs: fc.integer({ min: -52, max: -49 }),
			count: fc.integer({ min: 1, max: 8 }),
			guess: fc.constantFrom(...GUESSES),
			confidence: fc.constantFrom(...WEAK_CONFIDENCE),
			first: fc.integer({ min: 0, max: 30 }),
		})
		fc.assert(
			fc.property(
				fc.array(recordArb, { minLength: 1, maxLength: 16 }),
				records => {
					const specs: LegacySpec[] = records.map((r, i) => ({
						id: `d_${String(i).padStart(2, "0")}`,
						centreHz: F + r.dHz,
						obwHz: r.obwHz,
						peakDbfs: r.peakDbfs,
						count: r.count,
						protocol: r.guess[0],
						family: r.guess[1],
						confidence: r.confidence,
						firstSeenMs: T0 + r.first * 1000,
					}))
					const planned = restored(specs)
					const plan = planned.consolidationPlan()
					if (specs.length === 1) expect(plan.groups).toEqual([])
					else {
						expect(plan.groups).toHaveLength(1)
						expect(plan.groups[0]?.members).toHaveLength(specs.length - 1)
					}
					planned.applyConsolidation(plan)
					expect(ids(planned)).toHaveLength(1)
					// settle on the shared key (every centre keys on g:F)
					const settled = restored(specs)
					settled.rekey(SRC, 0)
					expect(ids(settled)).toHaveLength(1)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("proof, protocol and identity still split", () => {
		// Feature: detection-quality, Property 21: Proof, protocol and identity still split
		// Validates: Requirements 9.1, 9.5, 9.6, 9.8
		type Kind = "identity" | "protocol" | "proof"
		fc.assert(
			fc.property(
				fc.constantFrom<Kind>("identity", "protocol", "proof"),
				fc.integer({ min: 0, max: 900 }),
				fc.integer({ min: 0, max: 900 }),
				fc.constantFrom(...GUESSES),
				fc.constantFrom(...GUESSES),
				fc.boolean(),
				(kind, da, db, ga, gb, decodedIdentity) => {
					const a: LegacySpec = {
						id: "d_a",
						centreHz: F - 450 + da,
						protocol: ga[0],
						family: ga[1],
						confidence: "candidate",
					}
					const b: LegacySpec = {
						id: "d_b",
						centreHz: F - 450 + db,
						protocol: gb[0],
						family: gb[1],
						confidence: "candidate",
						firstSeenMs: T0 + 1,
					}
					let prep: ((s: DiscoveryStore) => void) | undefined
					if (kind === "identity") {
						a.identity = { kind: "dmr-cc", value: "1" }
						b.identity = { kind: "dmr-cc", value: "2" }
						if (decodedIdentity) {
							a.confidence = "decoded"
							a.protocol = "dmr"
							a.family = "digital-voice"
						}
					} else if (kind === "protocol") {
						Object.assign(a, {
							protocol: "dmr",
							family: "digital-voice",
							confidence: "decoded",
						})
						Object.assign(b, {
							protocol: decodedIdentity ? "p25p1" : "pocsag",
							family: decodedIdentity ? "digital-voice" : "pager",
							confidence: "decoded",
						})
					} else {
						Object.assign(b, {
							protocol: "dmr",
							family: "digital-voice",
							confidence: "decoded",
						})
						prep = s => {
							expect(s.recordAnalog("d_a-o0", tone(T0))).toBe(true)
						}
					}
					const store = restored([a, b])
					prep?.(store)
					everyPath(store, F)
					expect(store.get("d_a")).toBeDefined()
					expect(store.get("d_b")).toBeDefined()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("refusal wins", () => {
		// Feature: detection-quality, Property 22: Refusal wins
		// Validates: Requirements 9.3, 9.4, 9.8
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: 2_000, max: 8_000 }),
				fc.double({ min: 1.5, max: 4, noNaN: true }),
				fc.integer({ min: 20, max: 40 }),
				fc.integer({ min: -600, max: 600 }),
				fc.boolean(),
				(count, narrow, ratio, levelDb, dHz, loudIsWide) => {
					const wide = Math.ceil(narrow * ratio)
					const quiet = -70
					const loud = quiet + levelDb
					const rec = loudIsWide
						? { obwHz: narrow, peakDbfs: quiet }
						: { obwHz: wide, peakDbfs: loud }
					const other = loudIsWide
						? { obwHz: wide, peakDbfs: loud }
						: { obwHz: narrow, peakDbfs: quiet }
					// record against observation: every path
					const { store } = newStore()
					let id = ""
					for (let i = 0; i < count; i++) {
						const r = store.ingest(
							obs({ id: `r${i}`, centreHz: F, at: T0 + i * 1000, ...rec }),
						)
						if (i === 0) id = r.discoveryId ?? ""
					}
					const before = store.get(id)?.observationCount
					const r = store.ingest(
						obs({
							id: "x",
							centreHz: F + dHz,
							at: T0 + 60_000,
							snrDb: 30,
							...other,
						}),
					)
					expect(r.discoveryId).not.toBe(id)
					expect(store.get(id)?.observationCount).toBe(before)
					// record against record: plan, settle and lazy
					const pair = restored([
						{ id: "d_a", centreHz: F, count, ...rec },
						{
							id: "d_b",
							centreHz: F + dHz,
							count: Math.max(1, 7 - count),
							firstSeenMs: T0 + 1,
							...other,
						},
					])
					expect(pair.consolidationPlan().groups).toEqual([])
					pair.rekey(SRC, 0)
					pair.ingest(obs({ id: "y", centreHz: F, at: T0 + 90_000, ...rec }))
					expect(pair.get("d_a")).toBeDefined()
					expect(pair.get("d_b")).toBeDefined()
				},
			),
			{ numRuns: 100 },
		)
	})

	it("an observation outside the band joins only by the same-family route", () => {
		// Feature: detection-quality, Property 22: Refusal wins
		// Validates: Requirements 9.3, 9.8
		fc.assert(
			fc.property(
				fc.integer({ min: 4_000, max: 8_000 }),
				fc.double({ min: 1.01, max: 3, noNaN: true }),
				fc.integer({ min: -900, max: 900 }),
				fc.boolean(),
				(obwHz, past, dHz, proven) => {
					const { store } = newStore()
					let id = ""
					for (let i = 0; i < 4; i++) {
						const r = store.ingest(
							obs({
								id: `r${i}`,
								centreHz: F,
								at: T0 + i * 1000,
								obwHz,
								peakDbfs: -50,
							}),
						)
						if (i === 0) id = r.discoveryId ?? ""
					}
					if (proven) store.recordAnalog("r0", carrierOnly(T0))
					const outside = Math.ceil(obwHz * DQ_YOUNG_OBW_RATIO * past) + 1
					const r = store.ingest(
						obs({
							id: "x",
							centreHz: F + dHz,
							at: T0 + 60_000,
							obwHz: outside,
							peakDbfs: -50,
						}),
					)
					// cross-family route (carrier proof): never; same-family route: within tolerance
					if (proven) expect(r.discoveryId).not.toBe(id)
					else expect(r.discoveryId).toBe(id)
				},
			),
			{ numRuns: 100 },
		)
	})
})
