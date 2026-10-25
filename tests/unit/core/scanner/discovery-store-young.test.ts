// WG15 DQ requirement 9: young records and weak protocol guesses (9.10 fixtures).
import { describe, expect, it } from "vitest"
import { frequencyKey } from "../../../../src/core/scanner/bandplan/index.js"
import {
	DQ_OBW_RATIO_MAX,
	DQ_YOUNG_OBW_RATIO,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import {
	compatible,
	observationCompatible,
	recordsCompatible,
} from "../../../../src/core/scanner/store/compatibility.js"
import { inObwBand } from "../../../../src/core/scanner/store/consolidation.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Identity,
	ScannerClass,
} from "../../../../src/core/scanner/types.js"
import { evidence } from "../../../mocks/scanner/observations.js"
import { legacySnapshot } from "./consolidation-fixtures.js"
import {
	F,
	SRC,
	T0,
	carrierOnly,
	ids,
	internals,
	newStore,
	obs,
	restored,
	tone,
} from "./discovery-store-young-fixtures.js"
import type { LegacySpec } from "./discovery-store-young-fixtures.js"

/** Fixed pseudo-random sequence in [0, 1). */
function lcg(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0
		return s / 2 ** 32
	}
}

/** `n` evidence-less observations of one emitter at `f`; returns the first record id. */
function seedEmitter(
	store: DiscoveryStore,
	prefix: string,
	n: number,
	obwOf: (i: number) => number,
	centreHz = F,
): string {
	let id = ""
	for (let i = 0; i < n; i++) {
		const r = store.ingest(
			obs({
				id: `${prefix}${i}`,
				centreHz: centreHz + ((i * 37) % 200) - 100,
				at: T0 + i * 4_000,
				obwHz: obwOf(i),
				peakDbfs: -34,
				snrDb: 24,
			}),
		)
		if (i === 0) id = r.discoveryId ?? ""
		expect(r.discoveryId).toBe(id)
	}
	return id
}

describe("DQ 9.2: OBW band", () => {
	it("is [min / f, max x f], inclusive at the bound and refused past it", () => {
		const f = DQ_YOUNG_OBW_RATIO
		expect(inObwBand(39_000, 13_000, 13_000, f)).toBe(true)
		expect(inObwBand(39_001, 13_000, 13_000, f)).toBe(false)
		expect(inObwBand(13_000 / 3, 13_000, 13_000, f)).toBe(true)
		expect(inObwBand(13_000 / 3 - 1, 13_000, 13_000, f)).toBe(false)
		expect(inObwBand(16_000, 8_000, 8_000, DQ_OBW_RATIO_MAX)).toBe(true)
		expect(inObwBand(16_001, 8_000, 8_000, DQ_OBW_RATIO_MAX)).toBe(false)
		// three 13 kHz observations accept a following 39 kHz one; 16 to 39 kHz accepts 5.3 to 117
		expect(inObwBand(39_000, 13_000, 13_000, f)).toBe(true)
		expect(inObwBand(117_000, 16_000, 39_000, f)).toBe(true)
		expect(inObwBand(117_001, 16_000, 39_000, f)).toBe(false)
	})

	it("fails on non-finite or non-positive values (9.8)", () => {
		for (const bad of [Number.NaN, Infinity, -Infinity, 0, -5])
			for (const [o, lo, hi, f] of [
				[bad, 8_000, 8_000, 3],
				[8_000, bad, 8_000, 3],
				[8_000, 8_000, bad, 3],
				[8_000, 8_000, 8_000, bad],
			])
				expect(inObwBand(o ?? 0, lo ?? 0, hi ?? 0, f ?? 0)).toBe(false)
	})

	it("takes factor 2 from a decode or an identity, else 3 whatever the count or a carrier proof", () => {
		const store = restored([
			{ id: "weak", centreHz: F, count: 1, obwHz: 10_000 },
			{ id: "many", centreHz: F + 50_000, count: 40, obwHz: 10_000 },
			{
				id: "dec",
				centreHz: F + 100_000,
				obwHz: 10_000,
				family: "digital-voice",
				protocol: "dmr",
				confidence: "decoded",
			},
			{
				id: "idn",
				centreHz: F + 150_000,
				obwHz: 10_000,
				identity: { kind: "dmr-cc", value: "1" },
			},
			{ id: "car", centreHz: F + 200_000, count: 5, obwHz: 10_000 },
		])
		expect(store.recordAnalog("car-o0", carrierOnly(T0))).toBe(true)
		expect(store.get("car")?.evidenceLevel).toBe("proven")
		const i = internals(store)
		const at = (id: string, obwHz: number): boolean => {
			const d = i.discoveries.get(id)
			if (d === undefined) throw new Error(id)
			return i.bandwidthJoins(d, obwHz)
		}
		for (const id of ["weak", "many", "car"]) {
			expect(at(id, 30_000)).toBe(true)
			expect(at(id, 30_001)).toBe(false)
		}
		for (const id of ["dec", "idn"]) {
			expect(at(id, 20_000)).toBe(true)
			expect(at(id, 20_001)).toBe(false)
			expect(at(id, 5_000)).toBe(true)
			expect(at(id, 4_999)).toBe(false)
		}
		expect(at("weak", Number.NaN)).toBe(false)
	})
})

describe("DQ 9.4: compatibility, observation by observation", () => {
	const young = (...o: [number, number][]) => ({
		medians: {
			peakDbfs: o[0]?.[0] ?? 0,
			obwHz: o[0]?.[1] ?? 0,
			count: o.length,
		},
		observations: o.map(([peakDbfs, obwHz]) => ({ peakDbfs, obwHz })),
	})

	it("an observation against a young record is refused by any of its observations", () => {
		expect(
			observationCompatible(young([-60, 4_000]), {
				peakDbfs: -30,
				obwHz: 12_000,
			}),
		).toBe(false)
		expect(
			observationCompatible(young([-60, 4_000]), {
				peakDbfs: -45,
				obwHz: 12_000,
			}),
		).toBe(true)
		expect(
			observationCompatible(young([-45, 4_000], [-60, 4_000]), {
				peakDbfs: -30,
				obwHz: 12_000,
			}),
		).toBe(false)
		// only non-finite values make it undecided, which does not refuse
		expect(
			observationCompatible(young([Number.NaN, 4_000]), {
				peakDbfs: -30,
				obwHz: 12_000,
			}),
		).toBeNull()
		expect(
			observationCompatible(young([-60, 4_000]), {
				peakDbfs: -30,
				obwHz: Number.NaN,
			}),
		).toBeNull()
		// an established record still uses its medians
		expect(
			observationCompatible(
				{
					medians: { peakDbfs: -60, obwHz: 4_000, count: 3 },
					observations: [],
				},
				{ peakDbfs: -30, obwHz: 12_000 },
			),
		).toBe(false)
	})

	it("two young records test every pair (at most 2 x 2); the last pair alone can refuse", () => {
		const a = young([-50, 8_000], [-60, 4_000])
		const b = young([-50, 8_000], [-30, 12_000])
		expect(recordsCompatible(a, b)).toBe(false)
		expect(recordsCompatible(b, a)).toBe(false)
		expect(
			recordsCompatible(young([-50, 8_000], [-55, 8_000]), young([-52, 9_000])),
		).toBe(true)
		expect(
			recordsCompatible(young([Number.NaN, 8_000]), young([-30, Number.NaN])),
		).toBeNull()
		// `compatible` keeps its signature and 3.5 history rule
		expect(
			compatible(
				{ peakDbfs: -60, obwHz: 4_000, count: 1 },
				{ peakDbfs: -30, obwHz: 12_000, count: 1 },
			),
		).toBeNull()
	})
})

describe("DQ 9.10: new emitter fan-out", () => {
	it("40 observations, +-300 Hz, OBW 13/17/33/39 kHz, three classes and a carrier proof give one record", () => {
		const { store } = newStore()
		const rnd = lcg(7)
		const obws = [13_000, 17_000, 33_000, 39_000]
		const classes: ScannerClass[] = ["analog-fm", "wideband", "carrier"]
		let at = T0
		let id = ""
		for (let i = 0; i < 40; i++) {
			at += 3_000 + Math.floor(rnd() * 2_001)
			const r = store.ingest(
				obs({
					id: `e${i}`,
					centreHz: F + Math.round(rnd() * 600) - 300,
					at,
					obwHz: obws[i % 4] ?? 13_000,
					peakDbfs: -34 + Math.round(rnd() * 2) - 1,
					snrDb: 24 + rnd(),
					cls: classes[i % 3] ?? "unknown",
				}),
			)
			if (i === 0) {
				id = r.discoveryId ?? ""
				expect(store.recordAnalog("e0", carrierOnly(at))).toBe(true)
				expect(store.get(id)?.family).toBe("carrier")
			}
			expect(r.discoveryId).toBe(id)
		}
		expect(ids(store)).toEqual([id])
		expect(store.get(id)?.observationCount).toBe(40)
	})

	it("narrow first: three 13 kHz then a 39 kHz one 300 Hz away on another grid key give one record", () => {
		const { store } = newStore()
		const c = F + 1_000
		expect(frequencyKey(c, false, 13_000)).not.toBe(
			frequencyKey(c + 300, false, 39_000),
		)
		let id = ""
		for (let i = 0; i < 3; i++) {
			const r = store.ingest(
				obs({
					id: `n${i}`,
					centreHz: c,
					at: T0 + i * 4_000,
					obwHz: 13_000,
					peakDbfs: -34,
				}),
			)
			if (i === 0) {
				id = r.discoveryId ?? ""
				expect(store.recordAnalog("n0", carrierOnly(T0))).toBe(true)
			}
			expect(r.discoveryId).toBe(id)
		}
		const wide = store.ingest(
			obs({
				id: "w",
				centreHz: c + 300,
				at: T0 + 20_000,
				obwHz: 39_000,
				peakDbfs: -34,
			}),
		)
		expect(wide.discoveryId).toBe(id)
		expect(ids(store)).toEqual([id])
	})

	it("established neighbour: a 13 kHz burst 700 Hz from a 64-observation carrier record joins it", () => {
		const { store } = newStore()
		// one narrow (16 to 17 kHz) to two wide (25 to 39 kHz): median about 29 kHz
		const id = seedEmitter(store, "c", 64, i =>
			i % 3 === 0 ? 16_000 + (i % 2) * 1_000 : 25_000 + ((i * 7) % 15) * 1_000,
		)
		expect(store.recordAnalog("c0", carrierOnly(T0))).toBe(true)
		const d = store.get(id)
		expect(d?.family).toBe("carrier")
		expect(d?.evidenceLevel).toBe("proven")
		// 13 / 29 is below today's 0.5 median ratio: only the 9.2 band admits it
		expect(d?.bandwidthHz).toBeGreaterThanOrEqual(26_000)
		const r = store.ingest(
			obs({
				id: "burst",
				centreHz: F + 700,
				at: T0 + 400_000,
				obwHz: 13_000,
				peakDbfs: -34,
			}),
		)
		expect(r.discoveryId).toBe(id)
		expect(ids(store)).toEqual([id])
	})

	it("same-family precedence: an unknown record takes a 30 kHz observation 1 500 Hz away, a carrier record does not", () => {
		const plain = newStore().store
		const a = seedEmitter(plain, "u", 64, () => 8_000)
		expect(
			plain.ingest(
				obs({
					id: "x",
					centreHz: F + 1_500,
					at: T0 + 400_000,
					obwHz: 30_000,
					peakDbfs: -34,
				}),
			).discoveryId,
		).toBe(a)
		const proven = newStore().store
		const b = seedEmitter(proven, "u", 64, () => 8_000)
		expect(proven.recordAnalog("u0", carrierOnly(T0))).toBe(true)
		const r = proven.ingest(
			obs({
				id: "x",
				centreHz: F + 1_500,
				at: T0 + 400_000,
				obwHz: 30_000,
				peakDbfs: -34,
			}),
		)
		expect(r.discoveryId).not.toBe(b)
		expect(ids(proven)).toHaveLength(2)
	})
})

/** Three weak-guess records on one key within 200 Hz, OBW 15 kHz, 20 observations each. */
const TRIO: LegacySpec[] = [
	{
		id: "d_a",
		centreHz: F,
		obwHz: 15_000,
		count: 20,
		family: "pager",
		protocol: "pocsag",
		confidence: "candidate",
	},
	{
		id: "d_b",
		centreHz: F + 100,
		obwHz: 15_000,
		count: 20,
		family: "digital-voice",
		protocol: "dmr",
		confidence: "candidate",
		firstSeenMs: T0 + 1,
	},
	{
		id: "d_c",
		centreHz: F + 200,
		obwHz: 15_000,
		count: 20,
		family: "analog",
		protocol: "analog-fm",
		confidence: "candidate",
		firstSeenMs: T0 + 2,
	},
]

describe("DQ 9.10: weak trio", () => {
	it("folds into one record through the load plan", () => {
		const store = restored(TRIO)
		const plan = store.consolidationPlan()
		expect(plan.groups).toEqual([{ survivor: "d_a", members: ["d_b", "d_c"] }])
		store.applyConsolidation(plan)
		expect(ids(store)).toEqual(["d_a"])
		expect(store.get("d_a")?.observationCount).toBe(60)
	})

	it("folds into one record through settle on the shared key (ingest)", () => {
		const store = restored(TRIO)
		store.rekey(SRC, 0)
		expect(ids(store)).toEqual(["d_a"])
		const again = restored(TRIO)
		const r = again.ingest(
			obs({
				id: "x",
				centreHz: F + 100,
				at: T0 + 100_000,
				obwHz: 15_000,
				peakDbfs: -50,
			}),
		)
		expect(r.discoveryId).toBe("d_a")
		expect(ids(again)).toEqual(["d_a"])
	})
})

describe("DQ 9.10: kept apart", () => {
	const decodedDmr = (
		id: string,
		centreHz: number,
		cc: string,
		first = 0,
	): LegacySpec => ({
		id,
		centreHz,
		family: "digital-voice",
		protocol: "dmr",
		confidence: "decoded",
		identity: { kind: "dmr-cc", value: cc },
		firstSeenMs: T0 + first,
	})
	const cases: [string, LegacySpec[], ((s: DiscoveryStore) => void)?][] = [
		[
			"DMR colour codes 1 and 2, 150 Hz apart",
			[decodedDmr("d_a", F, "1"), decodedDmr("d_b", F + 150, "2", 1)],
		],
		[
			"decoded DMR beside decoded POCSAG",
			[
				decodedDmr("d_a", F, "1"),
				{
					id: "d_b",
					centreHz: F + 150,
					family: "pager",
					protocol: "pocsag",
					confidence: "decoded",
					identity: { kind: "pocsag-capcode", value: "1234" },
					firstSeenMs: T0 + 1,
				},
			],
		],
		[
			"proven analog beside a decoded pager record",
			[
				{ id: "d_a", centreHz: F, family: "analog", protocol: "analog-fm" },
				{
					id: "d_b",
					centreHz: F + 150,
					family: "pager",
					protocol: "pocsag",
					confidence: "decoded",
					firstSeenMs: T0 + 1,
				},
			],
			s => expect(s.recordAnalog("d_a-o0", tone(T0))).toBe(true),
		],
	]

	it.each(cases)("%s: two by consolidation", (_n, specs, prep) => {
		const store = restored(specs)
		prep?.(store)
		const plan = store.consolidationPlan()
		expect(plan.groups).toEqual([])
		store.applyConsolidation(plan)
		expect(ids(store)).toEqual(["d_a", "d_b"])
	})

	it.each(cases)(
		"%s: two by ingest (settle, sticky and lazy)",
		(_n, specs, prep) => {
			const store = restored(specs)
			prep?.(store)
			store.rekey(SRC, 0)
			expect(ids(store)).toEqual(["d_a", "d_b"])
			store.ingest(
				obs({
					id: "x",
					centreHz: F + 70,
					at: T0 + 100_000,
					obwHz: 8_000,
					peakDbfs: -50,
				}),
			)
			expect(ids(store)).toEqual(expect.arrayContaining(["d_a", "d_b"]))
		},
	)
})

describe("DQ 9.5: same family, different decoded protocol", () => {
	const PAIR: LegacySpec[] = [
		{
			id: "d_a",
			centreHz: F,
			family: "digital-voice",
			protocol: "dmr",
			confidence: "decoded",
		},
		{
			id: "d_b",
			centreHz: F + 200,
			family: "digital-voice",
			protocol: "p25p1",
			confidence: "decoded",
			firstSeenMs: T0 + 1,
		},
	]

	it("stays two after settle", () => {
		const store = restored(PAIR)
		store.rekey(SRC, 0)
		expect(store.get("d_a")?.frequencyKey).toBe(store.get("d_b")?.frequencyKey)
		expect(ids(store)).toEqual(["d_a", "d_b"])
		expect(store.get("d_a")?.coChannel).toContain("d_b")
	})

	it("stays two after the load plan", () => {
		const store = restored(PAIR)
		expect(store.consolidationPlan().groups).toEqual([])
	})

	it("stays two after the lazy path", () => {
		const store = restored(PAIR)
		const r = store.ingest(
			obs({
				id: "x",
				centreHz: F + 20,
				at: T0 + 100_000,
				obwHz: 8_000,
				peakDbfs: -50,
			}),
		)
		expect(r.discoveryId).toBe("d_a")
		expect(ids(store)).toEqual(["d_a", "d_b"])
	})

	it("an observation decoded as P25 at the shared key goes to the P25 record", () => {
		const store = restored(PAIR)
		store.rekey(SRC, 0)
		const ev = evidence("p25p1", T0 + 100_000, {
			identity: { kind: "p25-nac", value: "293" },
		})
		const r = store.ingest(
			obs({
				id: "x",
				centreHz: F + 20,
				at: T0 + 100_000,
				obwHz: 8_000,
				peakDbfs: -50,
			}),
			{ decode: ev },
		)
		expect(r.discoveryId).toBe("d_b")
		expect(ids(store)).toEqual(["d_a", "d_b"])
		// the key match alone also refuses the DMR record
		const target = internals(store).keyTarget(
			SRC,
			store.get("d_a")?.frequencyKey ?? "",
			"unknown",
			"unknown",
			obs({
				id: "y",
				centreHz: F,
				at: T0 + 101_000,
				obwHz: 8_000,
				peakDbfs: -50,
			}),
			"p25p1",
		)
		expect(target.merge?.id).toBe("d_b")
	})
})

describe("DQ 9.4: young refusal on every path", () => {
	// A: one observation at -60 dBFS, 4 kHz. B: 300 Hz away; -30 dBFS, 12 kHz (refused: 30 dB and
	// 3x) or the control at -45 dBFS (15 dB, not refused).
	const youngA = (centreHz = F): LegacySpec => ({
		id: "d_a",
		centreHz,
		count: 1,
		obwHz: 4_000,
		peakDbfs: -60,
	})
	const youngB = (peakDbfs: number, centreHz = F + 300): LegacySpec => ({
		id: "d_b",
		centreHz,
		count: 1,
		obwHz: 12_000,
		peakDbfs,
		firstSeenMs: T0 + 1,
	})
	const signal = (peakDbfs: number) =>
		obs({
			id: "sig",
			centreHz: F + 300,
			at: T0 + 100_000,
			obwHz: 12_000,
			peakDbfs,
			snrDb: 30,
		})

	it.each([
		[-30, 2],
		[-45, 1],
	])("sticky route: signal at %i dBFS gives %i record(s)", (peak, n) => {
		const { store } = newStore()
		const a = store.ingest(
			obs({ id: "a", centreHz: F, at: T0, obwHz: 4_000, peakDbfs: -60 }),
		).discoveryId
		expect(store.get(a ?? "")?.frequencyKey).toBe(
			frequencyKey(F + 300, false, 12_000),
		)
		const r = store.ingest(signal(peak))
		expect(ids(store)).toHaveLength(n)
		if (n === 1) expect(r.discoveryId).toBe(a)
	})

	it.each([
		[-30, false],
		[-45, true],
	])("key match: signal at %i dBFS merges: %s", (peak, merges) => {
		const { store } = newStore()
		const a =
			store.ingest(
				obs({ id: "a", centreHz: F, at: T0, obwHz: 4_000, peakDbfs: -60 }),
			).discoveryId ?? ""
		const target = internals(store).keyTarget(
			SRC,
			store.get(a)?.frequencyKey ?? "",
			"unknown",
			"unknown",
			signal(peak),
		)
		expect(target.merge?.id).toBe(merges ? a : undefined)
		if (!merges) expect(target.coChannel).toEqual([a])
	})

	it.each([
		[-30, ["d_a", "d_b"]],
		[-45, ["d_a"]],
	])(
		"settle: a second young record at %i dBFS on the key gives %j",
		(peak, left) => {
			const store = restored([youngA(), youngB(peak)])
			store.rekey(SRC, 0)
			expect(ids(store)).toEqual(left)
			if (left.length === 2)
				expect(store.get("d_a")?.coChannel).toContain("d_b")
		},
	)

	it.each([
		[-30, 0],
		[-45, 1],
	])(
		"load plan: both stored young, B at %i dBFS gives %i group(s)",
		(peak, groups) => {
			const store = restored([youngA(), youngB(peak)])
			expect(store.consolidationPlan().groups).toHaveLength(groups)
		},
	)

	it.each([
		[-30, ["d_a", "d_b"]],
		[-45, ["d_a"]],
	])("lazy path: B at %i dBFS on another key gives %j", (peak, left) => {
		// A keys on g:F (2 kHz grid), B on g:F+3000 (3 kHz grid): settle never sees them together.
		const store = restored([youngA(F + 900), youngB(peak, F + 1_600)])
		store.rekey(SRC, 0)
		expect(store.get("d_a")?.frequencyKey).not.toBe(
			store.get("d_b")?.frequencyKey,
		)
		expect(ids(store)).toEqual(["d_a", "d_b"])
		const r = store.ingest(
			obs({
				id: "x",
				centreHz: F + 900,
				at: T0 + 100_000,
				obwHz: 4_000,
				peakDbfs: -60,
			}),
		)
		expect(r.discoveryId).toBe("d_a")
		expect(ids(store)).toEqual(left)
	})
})

describe("DQ 9.8: malformed identity", () => {
	it("counts as present and different from every other identity", () => {
		const bad = { kind: 7, value: null } as unknown as Identity
		const store = restored([
			{ id: "d_a", centreHz: F, identity: bad },
			{ id: "d_b", centreHz: F + 100, identity: bad, firstSeenMs: T0 + 1 },
		])
		expect(store.consolidationPlan().groups).toEqual([])
		store.rekey(SRC, 0)
		expect(ids(store)).toEqual(["d_a", "d_b"])
	})
})

describe("DQ 9.5: an incoming decode on the lazy path", () => {
	it("a DMR-decoded observation joining an unknown record never pulls in a decoded P25 neighbour", () => {
		const store = restored([
			{ id: "d_u", centreHz: F },
			{
				id: "d_p",
				centreHz: F + 500,
				family: "digital-voice",
				protocol: "p25p1",
				confidence: "decoded",
				firstSeenMs: T0 + 1,
			},
		])
		const r = store.ingest(
			obs({
				id: "x",
				centreHz: F,
				at: T0 + 100_000,
				obwHz: 8_000,
				peakDbfs: -50,
			}),
			{
				decode: evidence("dmr", T0 + 100_000, {
					identity: { kind: "dmr-cc", value: "1" },
				}),
			},
		)
		expect(r.discoveryId).toBe("d_u")
		expect(store.get("d_p")?.observationCount).toBe(5)
		expect(ids(store)).toEqual(["d_p", "d_u"])
	})

	it("control: an evidence-less observation still folds the pair", () => {
		const store = restored([
			{ id: "d_u", centreHz: F },
			{
				id: "d_p",
				centreHz: F + 500,
				family: "digital-voice",
				protocol: "p25p1",
				confidence: "decoded",
				firstSeenMs: T0 + 1,
			},
		])
		store.ingest(
			obs({
				id: "x",
				centreHz: F,
				at: T0 + 100_000,
				obwHz: 8_000,
				peakDbfs: -50,
			}),
		)
		expect(ids(store)).toHaveLength(1)
	})
})

describe("DQ 9.3: decoded records reached by an evidence-less observation", () => {
	const DMR: LegacySpec = {
		id: "d_a",
		centreHz: F,
		obwHz: 4_000,
		family: "digital-voice",
		protocol: "dmr",
		confidence: "decoded",
	}

	it("is the cross-family route: takes the band: a 30 kHz sighting 3 800 Hz from a 4 kHz decoded record stays apart", () => {
		const far = restored([DMR])
		expect(
			far.ingest(
				obs({
					id: "x",
					centreHz: F + 3_800,
					at: T0 + 100_000,
					obwHz: 30_000,
					peakDbfs: -50,
				}),
			).discoveryId,
		).not.toBe("d_a")
		const near = restored([DMR])
		expect(
			near.ingest(
				obs({
					id: "x",
					centreHz: F + 500,
					at: T0 + 100_000,
					obwHz: 8_000,
					peakDbfs: -50,
				}),
			).discoveryId,
		).toBe("d_a")
	})
})

describe("DQ 9.8: one-sided malformed identity", () => {
	const bad = { kind: 7, value: null } as unknown as Identity
	const specs = (): LegacySpec[] => [
		{ id: "d_a", centreHz: F, identity: bad },
		{ id: "d_b", centreHz: F + 100, firstSeenMs: T0 + 1 },
	]

	it("never merges with an unidentified record: plan, settle and lazy path", () => {
		const store = restored(specs())
		expect(store.consolidationPlan().groups).toEqual([])
		store.rekey(SRC, 0)
		expect(ids(store)).toEqual(["d_a", "d_b"])
		store.ingest(
			obs({
				id: "x",
				centreHz: F + 50,
				at: T0 + 100_000,
				obwHz: 8_000,
				peakDbfs: -50,
			}),
		)
		expect(ids(store)).toEqual(expect.arrayContaining(["d_a", "d_b"]))
		const reversed = restored(specs().reverse())
		expect(reversed.consolidationPlan().groups).toEqual([])
	})
})

describe("DQ 9.2, 9.8: non-finite widths in the window", () => {
	it("are left out of the band; a window with none finite has no band", () => {
		const snap = legacySnapshot([
			{ id: "d_a", centreHz: F, count: 5, obwHz: 10_000 },
			{ id: "d_b", centreHz: F + 50_000, count: 2, obwHz: 10_000 },
		])
		for (const o of snap.observations)
			if (o.id === "d_a-o2" || o.discoveryId === "d_b") o.obwHz = Number.NaN
		const { store } = newStore()
		store.restore(snap)
		const i = internals(store)
		const a = i.discoveries.get("d_a")
		const b = i.discoveries.get("d_b")
		if (a === undefined || b === undefined) throw new Error("missing")
		expect(i.bandwidthJoins(a, 30_000)).toBe(true)
		expect(i.bandwidthJoins(a, 30_001)).toBe(false)
		expect(i.bandwidthJoins(b, 10_000)).toBe(false)
	})
})
