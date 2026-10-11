import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { CONFIDENCE_RANK } from "../../../../src/core/scanner/types.js"
import type {
	Discovery,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const PROTOS: ScannerProtocol[] = ["dmr", "analog-fm", "unknown", "nxdn96"]

interface IngestOp {
	kind: "ingest"
	slot: number
	jitter: number
	blocks: number
	proto: number
	sweep: boolean
	noJob: boolean
	truncated: boolean
}
interface EvidenceOp {
	kind: "evidence"
	pick: number
	cc: number
	proto: number
	encrypted: boolean
	clean: boolean
	tgBase: number
	tgCount: number
	cap: boolean
}
interface ClassifyOp {
	kind: "classify"
	pick: number
	proto: number
	cap: boolean
	channel: boolean
}
type Op =
	| IngestOp
	| EvidenceOp
	| ClassifyOp
	| { kind: "rekey"; corr: number }
	| { kind: "delete"; pick: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			kind: fc.constant("ingest" as const),
			slot: fc.integer({ min: 0, max: 7 }),
			jitter: fc.integer({ min: -400, max: 400 }),
			blocks: fc.integer({ min: 1, max: 4 }),
			proto: fc.integer({ min: 0, max: 3 }),
			sweep: fc.boolean(),
			noJob: fc.integer({ min: 0, max: 9 }).map(n => n === 0),
			truncated: fc.integer({ min: 0, max: 9 }).map(n => n === 0),
		}),
	},
	// up to 80 talkgroups per decode, so a single op can exceed the 64-entry metadata bound (P11)
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant("evidence" as const),
			pick: fc.nat(),
			cc: fc.integer({ min: 1, max: 3 }),
			proto: fc.integer({ min: 0, max: 3 }),
			encrypted: fc.boolean(),
			clean: fc.boolean(),
			tgBase: fc.integer({ min: 0, max: 200 }),
			tgCount: fc.integer({ min: 1, max: 80 }),
			cap: fc.integer({ min: 0, max: 3 }).map(n => n === 0),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("classify" as const),
			pick: fc.nat(),
			proto: fc.integer({ min: 0, max: 3 }),
			cap: fc.boolean(),
			channel: fc.boolean(),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			kind: fc.constant("rekey" as const),
			corr: fc.integer({ min: -4_000, max: 4_000 }),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			kind: fc.constant("delete" as const),
			pick: fc.nat(),
		}),
	},
)

function newStore(max = 1_000): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: max,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})
}

function pickId(store: DiscoveryStore, pick: number): string | undefined {
	const ids = store.snapshot().discoveries.map(d => d.id)
	return ids.length === 0 ? undefined : ids[pick % ids.length]
}

function apply(store: DiscoveryStore, op: Op, i: number): void {
	const proto =
		PROTOS[
			op.kind === "ingest" || op.kind === "evidence" || op.kind === "classify"
				? op.proto
				: 0
		] ?? "dmr"
	switch (op.kind) {
		case "ingest": {
			const cls =
				proto === "dmr"
					? "fsk4-12k5"
					: proto === "analog-fm"
						? "analog-fm"
						: proto === "nxdn96"
							? "fsk4-12k5"
							: "unknown"
			store.ingest(
				makeObs({
					id: `o${i}`,
					centreHz: CH + op.slot * 6_250 + op.jitter,
					startedAt: T0 + i * 1_000,
					blocks: op.blocks,
					cls,
					hypotheses: proto === "unknown" ? [] : [[proto, 0.8]],
					sweep: op.sweep,
					jobIds: op.noJob ? [] : ["job-1"],
					truncated: op.truncated,
				}),
			)
			return
		}
		case "evidence": {
			const id = pickId(store, op.pick)
			if (id === undefined || proto === "unknown" || proto === "analog-fm")
				return
			const identity =
				proto === "dmr"
					? dmrCc(op.cc)
					: { kind: "nxdn-ran" as const, value: String(op.cc) }
			const talkgroups = Array.from({ length: op.tgCount }, (_, j) =>
				String(op.tgBase + j),
			)
			const ev = evidence(proto, T0 + i * 1_000, {
				identity,
				encrypted: op.encrypted,
				crcClean: op.clean,
				talkgroups,
			})
			if (op.cap) store.applyEvidence(id, ev, { cap: "suspected-intermod" })
			else store.applyEvidence(id, ev)
			return
		}
		case "classify": {
			const id = pickId(store, op.pick)
			if (id === undefined) return
			store.applyClassification(
				id,
				classification(
					proto === "analog-fm" ? "analog-fm" : "fsk4-12k5",
					proto === "unknown" ? [] : [[proto, 0.8]],
					op.cap ? "adjacent-leak" : undefined,
					op.channel ? "channel" : "spectral",
				),
			)
			return
		}
		case "rekey":
			store.rekey("src-1", op.corr)
			return
		case "delete": {
			const id = pickId(store, op.pick)
			if (id !== undefined) store.delete(id)
			return
		}
	}
}

const identityKey = (d: Discovery): string =>
	`${d.sourceIds.join(",")}|${d.frequencyKey}|${d.family}|${d.identity ? `${d.identity.kind}:${d.identity.value}` : "-"}`

describe("DiscoveryStore properties", () => {
	// Feature: signal-discovery-scanner, Property 7: Identity and dedupe
	// Validates: spec § 5.2, § 7.2
	it("never holds two discoveries with the same (key, family, identity), including after re-key", () => {
		fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), ops => {
				const store = newStore()
				ops.forEach((op, i) => {
					apply(store, op, i)
					const keys = store.snapshot().discoveries.map(identityKey)
					expect(new Set(keys).size).toBe(keys.length)
				})
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: signal-discovery-scanner, Property 7: Identity and dedupe
	// Validates: spec § 5.2, § 7.2
	it("yields the same keys and counts for any arrival order that preserves per-key order, for emitters more than tol + 2·J apart", () => {
		// Precondition (spec P7, § 7.2): sticky association compares with a discovery's median centre, so order
		// independence holds only for emitters whose centres are more than tol + 2·J apart (J = largest centre
		// jitter). Clusters sit at exactly that minimum separation (+1 Hz); the random base offset makes the
		// jitter cross grid-key boundaries, and the two orders permute observations across clusters.
		const TOL = 2_500 // gridToleranceHz(9 kHz): no rasters, makeObs' default OBW
		const clusterObs = fc.array(
			fc.record({
				jitter: fc.integer({ min: -1_000, max: 1_000 }),
				blocks: fc.integer({ min: 1, max: 3 }),
			}),
			{ minLength: 1, maxLength: 12 },
		)
		fc.assert(
			fc.property(
				fc.array(clusterObs, { minLength: 1, maxLength: 5 }),
				fc.integer({ min: 0, max: TOL / 2 }),
				fc.integer({ min: 0, max: TOL - 1 }),
				fc.array(fc.nat(), { minLength: 60, maxLength: 60 }),
				fc.array(fc.nat(), { minLength: 5, maxLength: 5 }),
				(clusters, maxJitter, base, choices, rankKeys) => {
					const separation = TOL + 2 * maxJitter + 1
					const obsFor = (
						c: number,
						k: number,
						spec: { jitter: number; blocks: number },
					) =>
						makeObs({
							id: `c${c}-${k}`,
							centreHz:
								446_000_000 +
								base +
								c * separation +
								Math.round((spec.jitter * maxJitter) / 1_000),
							startedAt: T0 + k * 1_000 + c,
							blocks: spec.blocks,
						})
					const run = (order: [number, number][]) => {
						const store = new DiscoveryStore({
							maxDiscoveries: 1_000,
							now: () => T0,
							newId: counterIds(),
						})
						for (const [c, k] of order) {
							const spec = clusters[c]?.[k]
							if (spec !== undefined) store.ingest(obsFor(c, k, spec))
						}
						return store
							.snapshot()
							.discoveries.map(d => `${d.frequencyKey}|${d.observationCount}`)
							.sort()
					}
					const permuted = clusters
						.map((_, c) => c)
						.sort((a, b) => (rankKeys[a] ?? 0) - (rankKeys[b] ?? 0) || a - b)
					const clusterMajor: [number, number][] = permuted.flatMap(c =>
						(clusters[c] ?? []).map((_, k): [number, number] => [c, k]),
					)
					const next = clusters.map(() => 0)
					const interleaved: [number, number][] = []
					let step = 0
					while (interleaved.length < clusterMajor.length) {
						const open = clusters
							.map((_, c) => c)
							.filter(c => (next[c] ?? 0) < (clusters[c]?.length ?? 0))
						const c =
							open[(choices[step % choices.length] ?? 0) % open.length] ?? 0
						interleaved.push([c, next[c] ?? 0])
						next[c] = (next[c] ?? 0) + 1
						step++
					}
					expect(run(interleaved)).toEqual(run(clusterMajor))
				},
			),
			{ numRuns: 100 },
		)
	})

	// Regression pin, not a property: the reviewed counterexample to the P7 precondition (spec § 7.2).
	// Emitters closer than tol + 2·J associate order-dependently; this pins the two known outputs.
	it("associates order-dependently for emitters closer than tol + 2·J (reviewed counterexample)", () => {
		const at: Record<string, [number, number]> = {
			x: [446_000_000, T0],
			y1: [446_002_200, T0 + 1_000],
			y2: [446_004_000, T0 + 2_000],
		}
		const run = (order: string[]) => {
			const store = new DiscoveryStore({
				maxDiscoveries: 1_000,
				now: () => T0,
				newId: counterIds(),
			})
			for (const id of order) {
				const [centreHz, startedAt] = at[id] ?? [0, T0]
				store.ingest(makeObs({ id, centreHz, startedAt, blocks: 4 })) // OBW 9 kHz, grid tol 2.5 kHz
			}
			return store
				.snapshot()
				.discoveries.map(d => `${d.frequencyKey}|${d.observationCount}`)
				.sort()
		}
		expect(run(["x", "y1", "y2"])).toEqual(["g:446000000|2", "g:446005000|1"])
		expect(run(["y2", "y1", "x"])).toEqual(["g:446000000|1", "g:446002500|2"])
	})

	// Feature: signal-discovery-scanner, Property 7: Identity and dedupe
	// Validates: spec § 7.2
	it("is idempotent on repeated observation ids (ingesting each observation twice equals once)", () => {
		fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), ops => {
				const once = newStore()
				const twice = newStore()
				ops.forEach((op, i) => {
					apply(once, op, i)
					apply(twice, op, i)
					if (op.kind === "ingest") apply(twice, op, i)
				})
				expect(twice.snapshot()).toEqual(once.snapshot())
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: signal-discovery-scanner, Property 8: Monotone confidence, sticky flags
	// Validates: spec § 7.3, H1
	it("never lowers confidence except to a pre-decode cap, never clears encrypted, never changes a decoded protocol", () => {
		fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), ops => {
				const store = newStore()
				const prev = new Map<string, Discovery>()
				ops.forEach((op, i) => {
					apply(store, op, i)
					for (const d of store.snapshot().discoveries) {
						const p = prev.get(d.id)
						if (p !== undefined) {
							const now = CONFIDENCE_RANK[d.confidence]
							const was = CONFIDENCE_RANK[p.confidence]
							if (now < was) {
								expect(p.confidence).not.toBe("decoded")
								expect(d.confidence).toBe("candidate")
								expect(d.confidenceCap).toBeDefined()
							}
							if (p.encrypted) expect(d.encrypted).toBe(true)
							if (p.confidence === "decoded")
								expect(d.protocol).toBe(p.protocol)
						}
						prev.set(d.id, d)
					}
				})
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: signal-discovery-scanner, Property 11: Bounded state
	// Validates: spec § 9
	it("keeps discoveries ≤ maxDiscoveries and metadata lists ≤ 64 for any event stream", () => {
		fc.assert(
			fc.property(fc.array(opArb, { minLength: 1, maxLength: 120 }), ops => {
				const store = newStore(5)
				ops.forEach((op, i) => {
					apply(store, op, i)
					const all = store.snapshot().discoveries
					expect(all.length).toBeLessThanOrEqual(5)
					for (const d of all) {
						for (const list of [
							d.metadata.talkgroups,
							d.metadata.sources,
							d.metadata.callsigns,
							d.metadata.capcodes,
							d.metadata.slots,
							d.metadata.ismModels,
						])
							expect(list.length).toBeLessThanOrEqual(64)
						expect(d.coChannel.length).toBeLessThanOrEqual(64)
					}
				})
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: signal-discovery-scanner, Property 3: Exclusions and truncation
	// Validates: spec § 4.9, § 5.1, § 6.2
	it("never stores an observation without a covering job or with a truncated, IQ-image or spur track", () => {
		fc.assert(
			fc.property(
				fc.array(opArb, { minLength: 0, maxLength: 30 }),
				fc.integer({ min: 0, max: 7 }),
				fc.constantFrom("noJob", "truncated", "iqImage", "spur"),
				(ops, slot, reason) => {
					const store = newStore()
					ops.forEach((op, i) => apply(store, op, i))
					const before = store.snapshot()
					const r = store.ingest(
						makeObs({
							id: "probe-obs",
							centreHz: CH + slot * 6_250,
							startedAt: T0 + 1e6,
							cls: "fsk4-12k5",
							hypotheses: [["dmr", 0.9]],
							jobIds: reason === "noJob" ? [] : ["job-1"],
							truncated: reason === "truncated",
							iqImage: reason === "iqImage",
							spur: reason === "spur",
						}),
					)
					expect(r).toEqual({ discoveryId: null, change: "transient" })
					expect(store.snapshot()).toEqual(before)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: signal-discovery-scanner, Property 3: Exclusions and truncation
	// Validates: spec § 4.9, § 6.2
	it("unlinks an observation whose second ingest carries truncated, iqImage or spur, whatever came before", () => {
		fc.assert(
			fc.property(
				fc.array(opArb, { minLength: 0, maxLength: 30 }),
				fc.integer({ min: 0, max: 7 }),
				fc.constantFrom("truncated", "iqImage", "spur"),
				fc.boolean(),
				(ops, slot, late, open) => {
					const store = newStore()
					ops.forEach((op, i) => apply(store, op, i))
					const spec = {
						id: "late-flag",
						centreHz: CH + slot * 6_250,
						startedAt: T0 + 1e6,
						cls: "fsk4-12k5" as const,
						hypotheses: [["dmr", 0.9]] as [ScannerProtocol, number][],
					}
					const first = store.ingest(makeObs({ ...spec, open }))
					const idsAfterFirst = new Set(
						store.snapshot().discoveries.map(d => d.id),
					)
					const r = store.ingest(
						makeObs({
							...spec,
							truncated: late === "truncated",
							iqImage: late === "iqImage",
							spur: late === "spur",
						}),
					)
					expect(r).toEqual({ discoveryId: null, change: "transient" })
					const after = store.snapshot()
					expect(after.observations.some(o => o.id === "late-flag")).toBe(false)
					expect(store.discoveryIdOf("late-flag")).toBeUndefined()
					for (const d of after.discoveries)
						expect(idsAfterFirst.has(d.id)).toBe(true)
					if (first.change === "created")
						expect(store.get(first.discoveryId ?? "")).toBeUndefined()
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: signal-discovery-scanner, Property 24: Comb masking
	// Validates: spec § 4.9, § 7.1 (store level: once the teeth are spur-flagged, no discovery remains for them)
	it("leaves no discovery for any comb tooth once its track is spur-flagged", () => {
		fc.assert(
			fc.property(
				fc.array(opArb, { minLength: 0, maxLength: 30 }),
				fc.integer({ min: 3, max: 7 }),
				fc.integer({ min: 8, max: 40 }),
				fc.boolean(),
				(ops, teeth, spacingSlots, open) => {
					const store = newStore()
					ops.forEach((op, i) => apply(store, op, i))
					const before = new Set(store.snapshot().discoveries.map(d => d.id))
					// 2 MHz above the ops' slots: the teeth never associate with an earlier discovery
					const tooth = (k: number) => ({
						id: `tooth-${k}`,
						centreHz: CH + 2_000_000 + k * spacingSlots * 6_250,
						startedAt: T0 + 1e6,
						cls: "carrier" as const,
						hypotheses: [["carrier", 1]] as [ScannerProtocol, number][],
					})
					for (let k = 0; k < teeth; k++)
						store.ingest(makeObs({ ...tooth(k), open }))
					for (let k = 0; k < teeth; k++) {
						expect(store.ingest(makeObs({ ...tooth(k), spur: true }))).toEqual({
							discoveryId: null,
							change: "transient",
						})
					}
					for (let k = 0; k < teeth; k++)
						expect(store.discoveryIdOf(`tooth-${k}`)).toBeUndefined()
					expect(
						store.snapshot().discoveries.filter(d => !before.has(d.id)),
					).toEqual([])
				},
			),
			{ numRuns: 100 },
		)
	})
})
