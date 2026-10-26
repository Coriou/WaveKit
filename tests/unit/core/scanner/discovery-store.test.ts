import { describe, expect, it } from "vitest"
import {
	DiscoveryStore,
	estimateFrequencyError,
} from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import type { StoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import type {
	Discovery,
	ScannerConfidence,
} from "../../../../src/core/scanner/types.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import {
	classification,
	counterIds,
	dmrCc,
	evidence as baseEvidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

/** The stored record (scanner-redesign 3.10: a weak record's published label is unknown/activity). */
function storedOf(store: DiscoveryStore, id: string) {
	return store.snapshot().discoveries.find(d => d.id === id)
}

// These replay-equality scenarios model checked decoder content, with current provenance.
const evidence: typeof baseEvidence = (...args) => ({
	...baseEvidence(...args),
	contentVerified: true,
})

const CH = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function newStore(opts: { max?: number; rasters?: Raster[] } = {}): {
	store: DiscoveryStore
	entries: JournalEntry[]
} {
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: opts.max ?? 100,
		now: () => T0,
		newId: counterIds(),
		...(opts.rasters !== undefined
			? { rasters: () => opts.rasters ?? [] }
			: {}),
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	return { store, entries }
}

const dmrObs = (
	id: string,
	centreHz: number,
	startedAt: number,
	extra: Partial<Parameters<typeof makeObs>[0]> = {},
) =>
	makeObs({
		id,
		centreHz,
		startedAt,
		cls: "fsk4-12k5",
		hypotheses: [["dmr", 0.8]],
		...extra,
	})

describe("DiscoveryStore surfacing filter (§ 7.2)", () => {
	it("keeps a one-block unclassified observation as a transient and stores nothing", () => {
		const { store, entries } = newStore()
		expect(
			store.ingest(
				makeObs({ id: "o1", centreHz: CH, startedAt: T0, blocks: 1 }),
			),
		).toEqual({ discoveryId: null, change: "transient" })
		expect(store.snapshot().discoveries).toHaveLength(0)
		expect(entries).toHaveLength(0)
	})

	it("(a) creates an activity discovery from minSurfaceBlocks blocks", () => {
		const { store } = newStore()
		const r = store.ingest(
			makeObs({ id: "o1", centreHz: CH, startedAt: T0, blocks: 2 }),
		)
		expect(r.change).toBe("created")
		const d = store.get(r.discoveryId ?? "")
		expect(d?.confidence).toBe("activity")
		expect(d?.observationCount).toBe(1)
		expect(d?.airtimeMs).toBe(1000)
	})

	it("(b) surfaces a single sweep block only at k + 6 dB or more", () => {
		const { store } = newStore()
		const strong = makeObs({
			id: "o1",
			centreHz: CH,
			startedAt: T0,
			blocks: 1,
			sweep: true,
			thresholdDb: 9,
			maxBlockSnrDb: 15,
		})
		const weak = makeObs({
			id: "o2",
			centreHz: CH + 100_000,
			startedAt: T0,
			blocks: 1,
			sweep: true,
			thresholdDb: 9,
			maxBlockSnrDb: 14.9,
		})
		const inWindow = makeObs({
			id: "o3",
			centreHz: CH + 200_000,
			startedAt: T0,
			blocks: 1,
			sweep: false,
			thresholdDb: 9,
			maxBlockSnrDb: 30,
		})
		expect(store.ingest(strong).change).toBe("created")
		expect(store.ingest(weak).change).toBe("transient")
		expect(store.ingest(inWindow).change).toBe("transient")
	})

	it("(c) surfaces a single block that carries a channel-tier classification", () => {
		const { store } = newStore()
		const r = store.ingest(dmrObs("o1", CH, T0, { blocks: 1, tier: "channel" }))
		expect(r.change).toBe("created")
		expect(store.get(r.discoveryId ?? "")?.confidence).toBe("activity")
		expect(store.get(r.discoveryId ?? "")?.protocol).toBe("unknown")
	})

	it("(c) never surfaces a single block on a spectral-tier classification alone", () => {
		// the spectral class is derived from the same single block of energy, so it cannot vouch for it
		const { store, entries } = newStore()
		for (const [i, cls] of (
			["fsk4-12k5", "ook-burst", "analog-fm"] as const
		).entries()) {
			const r = store.ingest(
				makeObs({
					id: `o${i}`,
					centreHz: CH + i * 100_000,
					startedAt: T0,
					blocks: 1,
					cls,
					hypotheses: [["dmr", 0.8]],
				}),
			)
			expect(r).toEqual({ discoveryId: null, change: "transient" })
		}
		expect(store.snapshot().discoveries).toHaveLength(0)
		expect(entries).toHaveLength(0)
	})

	it("does not create a discovery from repeated single-block tracks unless a gate has passed", () => {
		const { store } = newStore()
		const hit = (id: string, t: number, hz = CH) =>
			makeObs({ id, centreHz: hz, startedAt: t, blocks: 1, gate: "absent" })
		expect(store.ingest(hit("a1", T0)).change).toBe("transient")
		expect(store.ingest(hit("a2", T0 + 120_000)).change).toBe("transient")
		expect(store.ingest(hit("a3", T0 + 590_000)).change).toBe("transient")
		const far = CH + 500_000
		expect(store.ingest(hit("b1", T0, far)).change).toBe("transient")
		expect(store.ingest(hit("b2", T0 + 610_000, far)).change).toBe("transient")
		expect(store.ingest(hit("b3", T0 + 1_300_000, far)).change).toBe(
			"transient",
		)
		const passed = store.ingest(
			makeObs({
				id: "a4",
				centreHz: CH,
				startedAt: T0 + 600_000,
				blocks: 1,
				gate: "passed",
			}),
		)
		expect(passed.change).toBe("created")
		expect(store.get(passed.discoveryId ?? "")?.observationCount).toBe(1)
		expect(store.snapshot().observations.map(o => o.id)).toEqual(["a4"])
	})

	it("never stores an observation that no job covers or that is truncated (P3, store part)", () => {
		const { store } = newStore()
		expect(store.ingest(dmrObs("o1", CH, T0, { jobIds: [] })).change).toBe(
			"transient",
		)
		expect(store.ingest(dmrObs("o2", CH, T0, { truncated: true })).change).toBe(
			"transient",
		)
		expect(store.snapshot()).toEqual({
			discoveries: [],
			observations: [],
			corrections: [],
		})
	})

	it("unlinks an observation whose re-ingest carries truncated or iqImage, deleting an emptied discovery in one entry (P3, § 4.9)", () => {
		const { store, entries } = newStore()
		const lone =
			store.ingest(dmrObs("o1", CH, T0, { open: true })).discoveryId ?? ""
		const before = entries.length
		expect(store.ingest(dmrObs("o1", CH, T0, { iqImage: true }))).toEqual({
			discoveryId: null,
			change: "transient",
		})
		expect(store.get(lone)).toBeUndefined()
		expect(entries).toHaveLength(before + 1)
		const payload = entries.at(-1)?.payload as StoreMutation
		expect(entries.at(-1)?.op).toBe("observation")
		expect(payload.deleted).toEqual([lone])
		expect(payload.removedObservations).toEqual(["o1"])

		const shared =
			store.ingest(dmrObs("o2", CH + 100_000, T0, { durationMs: 2_000 }))
				.discoveryId ?? ""
		store.ingest(dmrObs("o3", CH + 100_000, T0 + 5_000, { open: true }))
		expect(
			store.ingest(dmrObs("o3", CH + 100_000, T0 + 5_000, { truncated: true }))
				.change,
		).toBe("transient")
		expect(store.get(shared)?.observationCount).toBe(1)
		expect(store.get(shared)?.airtimeMs).toBe(2_000)
		expect(store.discoveryIdOf("o3")).toBeUndefined()

		const decoded =
			store.ingest(dmrObs("o4", CH + 200_000, T0, { open: true }))
				.discoveryId ?? ""
		store.applyEvidence(
			decoded,
			evidence("dmr", T0 + 10, { identity: dmrCc(1) }),
		)
		store.ingest(dmrObs("o4", CH + 200_000, T0, { truncated: true }))
		expect(store.get(decoded)?.observationCount).toBe(0)
		expect(storedOf(store, decoded)?.confidence).toBe("decoded")
		expect(store.snapshot().observations.map(o => o.id)).toEqual(["o2"])

		const replica = newStore().store
		for (const e of entries) replica.replay(e)
		// Memory-only identities without retained checked observations are downgraded
		// identically by snapshot restore and journal replay.
		const normalized = newStore().store
		normalized.restore(store.snapshot())
		expect(replica.snapshot()).toEqual(normalized.snapshot())
	})

	it("leaves stored job credits unchanged when a re-ingest has no passed gate", () => {
		const { store } = newStore()
		const id =
			store.ingest(dmrObs("o1", CH, T0, { open: true, jobIds: ["job-1"] }))
				.discoveryId ?? ""
		// A placed observation re-ingests without a passed gate; its credits stay.
		const again = store.ingest(dmrObs("o1", CH, T0, { jobIds: [] }))
		expect(again.change).not.toBe("transient")
		expect(again.discoveryId).toBe(id)
		expect(store.discoveryIdOf("o1")).toBe(id)
		expect(store.observations(id, null, 10).items[0]?.jobIds).toEqual(["job-1"])
	})

	it("a flagged track stays transient, and a later passed gate creates one observation", () => {
		const { store } = newStore()
		const hit = (
			id: string,
			t: number,
			extra: { iqImage?: boolean; gate?: "passed" | "absent" } = {},
		) =>
			makeObs({
				id,
				centreHz: CH,
				startedAt: t,
				blocks: 1,
				gate: "absent",
				...extra,
			})
		expect(store.ingest(hit("a1", T0)).change).toBe("transient")
		expect(store.ingest(hit("a2", T0 + 1_000)).change).toBe("transient")
		expect(store.ingest(hit("a2", T0 + 1_000, { iqImage: true })).change).toBe(
			"transient",
		)
		expect(store.ingest(hit("a2", T0 + 1_500, { gate: "passed" })).change).toBe(
			"transient",
		)
		expect(store.ingest(hit("a3", T0 + 2_000)).change).toBe("transient")
		const created = store.ingest(hit("a4", T0 + 3_000, { gate: "passed" }))
		expect(created.change).toBe("created")
		expect(store.get(created.discoveryId ?? "")?.observationCount).toBe(1)
		expect(store.snapshot().observations.map(o => o.id)).toEqual(["a4"])
	})

	it("treats IQ-image tracks as transient and surfaces a burst only when its gate passed", () => {
		const { store } = newStore()
		expect(store.ingest(dmrObs("img", CH, T0, { iqImage: true })).change).toBe(
			"transient",
		)
		expect(
			store.ingest(
				makeObs({
					id: "bw",
					centreHz: CH + 50_000,
					startedAt: T0,
					burst: true,
					blocks: 3,
					thresholdDb: 8.5,
					maxBlockSnrDb: 11,
				}),
			).change,
		).toBe("transient")
		const strong = store.ingest(
			makeObs({
				id: "bs",
				centreHz: CH + 75_000,
				startedAt: T0,
				burst: true,
				blocks: 1,
				thresholdDb: 8.5,
				maxBlockSnrDb: 11.5,
			}),
		)
		expect(strong.change).toBe("created")
		expect(store.get(strong.discoveryId ?? "")?.protocol).toBe("unknown")
		expect(store.get(strong.discoveryId ?? "")?.confidence).toBe("activity")
	})

	it("keeps truncated, iqImage and spur sticky per observation id: a later snapshot without the flag stays a transient (P3)", () => {
		const { store } = newStore()
		store.ingest(dmrObs("o1", CH, T0, { open: true }))
		store.ingest(dmrObs("o1", CH, T0, { spur: true }))
		expect(store.ingest(dmrObs("o1", CH, T0))).toEqual({
			discoveryId: null,
			change: "transient",
		})
		expect(
			store.ingest(dmrObs("o2", CH + 100_000, T0, { iqImage: true })).change,
		).toBe("transient")
		expect(store.ingest(dmrObs("o2", CH + 100_000, T0)).change).toBe(
			"transient",
		)
		expect(store.snapshot().discoveries).toEqual([])
	})

	it("creates a burst only from a passed gate, including after a weak snapshot of the same id", () => {
		const { store } = newStore()
		const snap = (burst: boolean, maxBlockSnrDb: number, blocks = 1) =>
			makeObs({
				id: "b1",
				centreHz: CH,
				startedAt: T0,
				burst,
				blocks,
				thresholdDb: 8.5,
				maxBlockSnrDb,
			})
		expect(store.ingest(snap(true, 9)).change).toBe("transient")
		expect(store.ingest(snap(false, 9)).change).toBe("transient")
		expect(store.ingest(snap(true, 30)).change).toBe("created")
		expect(store.ingest(snap(false, 9, 2)).change).toBe("updated")
		expect(store.snapshot().observations).toHaveLength(1)
	})

	it("treats in-window edge tracks as activity only", () => {
		const { store } = newStore()
		const r = store.ingest(dmrObs("o1", CH, T0, { edge: true }))
		expect(store.get(r.discoveryId ?? "")?.confidence).toBe("activity")
		expect(store.get(r.discoveryId ?? "")?.protocol).toBe("unknown")
	})
})

describe("DiscoveryStore association and keys (§ 5.2, § 7.2)", () => {
	it("keeps one emitter as one discovery across a snap threshold (sticky)", () => {
		const { store } = newStore({ rasters: PMR })
		const a = store.ingest(dmrObs("o1", CH + 3_000, T0)) // snaps (tol 3125)
		const b = store.ingest(dmrObs("o2", CH + 3_300, T0 + 5_000)) // off-raster on its own
		expect(b.discoveryId).toBe(a.discoveryId)
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.get(a.discoveryId ?? "")?.observationCount).toBe(2)
	})

	it("snaps to the raster channel and reports the measured offset", () => {
		const { store } = newStore({ rasters: PMR })
		const r = store.ingest(dmrObs("o1", CH + 400, T0))
		const d = store.get(r.discoveryId ?? "")
		expect(d?.frequencyHz).toBe(CH)
		expect(d?.frequencyKey).toBe(`r:${CH}`)
		expect(d?.measuredOffsetHz).toBe(400)
	})

	it("stores a canonical zero offset when the median centre is 0.5 Hz below the raster (S1-B final re-review R3)", () => {
		const { store } = newStore({ rasters: PMR })
		const a = store.ingest(dmrObs("o1", CH - 1, T0))
		const b = store.ingest(dmrObs("o2", CH, T0 + 5_000))
		expect(b.discoveryId).toBe(a.discoveryId)
		const d = store.get(a.discoveryId ?? "")!
		expect(d.frequencyHz).toBe(CH)
		// median(CH − 1, CH) = CH − 0.5; Math.round(−0.5) is −0
		expect(Object.is(d.measuredOffsetHz, 0)).toBe(true)
		// The persisted copy (JSON) equals the live store.
		const replica = newStore({ rasters: PMR }).store
		replica.restore(JSON.parse(JSON.stringify(store.snapshot())))
		const r = replica.get(d.id)!
		expect(Object.is(r.measuredOffsetHz, 0)).toBe(true)
		expect(replica.snapshot()).toEqual(store.snapshot())
	})

	it("merges unlabeled analog-FM and DMR hypotheses at one key into one discovery", () => {
		const { store } = newStore({ rasters: PMR })
		const fm = store.ingest(
			makeObs({
				id: "o1",
				centreHz: CH,
				startedAt: T0,
				cls: "analog-fm",
				hypotheses: [["analog-fm", 0.8]],
			}),
		)
		const dmr = store.ingest(dmrObs("o2", CH + 200, T0 + 1_000))
		expect(dmr.discoveryId).toBe(fm.discoveryId)
		const d = store.get(fm.discoveryId ?? "")
		expect(d?.protocol).toBe("unknown")
		expect(d?.confidence).toBe("activity")
		expect(d?.observationCount).toBe(2)
		expect(d?.coChannel).toEqual([])
	})

	it("merges an unknown-family observation into the single non-carrier discovery at the key (rule 4)", () => {
		const { store } = newStore({ rasters: PMR })
		const dmr = store.ingest(dmrObs("o1", CH, T0))
		const unk = store.ingest(
			makeObs({ id: "o2", centreHz: CH + 1_500, startedAt: T0 + 1_000 }),
		)
		expect(unk.discoveryId).toBe(dmr.discoveryId)
		expect(store.get(dmr.discoveryId ?? "")?.observationCount).toBe(2)
	})

	it("splits co-channel networks by identity and cross-links them (rule 2)", () => {
		const { store } = newStore({ rasters: PMR })
		const r = store.ingest(dmrObs("o1", CH, T0))
		const id = r.discoveryId ?? ""
		expect(
			store.applyEvidence(
				id,
				evidence("dmr", T0 + 500, { identity: dmrCc(1) }),
			),
		).toBe("upgraded")
		expect(
			store.applyEvidence(
				id,
				evidence("dmr", T0 + 900, { identity: dmrCc(5) }),
			),
		).toBe("created")
		const all = store.snapshot().discoveries
		expect(all).toHaveLength(2)
		const cc5 = all.find(d => d.identity?.value === "5")
		expect(cc5?.coChannel).toEqual([id])
		expect(store.get(id)?.coChannel).toEqual([cc5?.id])
		expect(store.get(id)?.identity).toEqual(dmrCc(1))
	})

	it("is idempotent on a repeated observation id", () => {
		const { store, entries } = newStore()
		const obs = dmrObs("o1", CH, T0)
		store.ingest(obs)
		const before = store.snapshot()
		const count = entries.length
		expect(store.ingest(obs).change).toBe("updated")
		expect(store.snapshot()).toEqual(before)
		expect(entries).toHaveLength(count)
	})

	it("updates an open observation in place when it finishes", () => {
		const { store } = newStore()
		const r = store.ingest(dmrObs("o1", CH, T0, { open: true }))
		expect(store.get(r.discoveryId ?? "")?.airtimeMs).toBe(0)
		store.ingest(dmrObs("o1", CH, T0, { durationMs: 4_000 }))
		const d = store.get(r.discoveryId ?? "")
		expect(d?.observationCount).toBe(1)
		expect(d?.airtimeMs).toBe(4_000)
		expect(
			store.observations(r.discoveryId ?? "", null, 10).items[0]?.endedAt,
		).toBe(new Date(T0 + 4_000).toISOString())
	})
})

describe("DiscoveryStore ladder and sticky flags (§ 7.3)", () => {
	it("makes the protocol more specific from evidence but never changes a decoded protocol", () => {
		const { store } = newStore()
		const r = store.ingest(
			makeObs({ id: "o1", centreHz: CH, startedAt: T0, cls: "fsk4-12k5" }),
		)
		const id = r.discoveryId ?? ""
		expect(storedOf(store, id)?.protocol).toBe("unknown")
		expect(storedOf(store, id)?.confidence).toBe("activity")
		store.applyClassification(id, classification("fsk4-12k5", [["dmr", 0.7]]))
		store.applyClassification(
			id,
			classification("fsk4-12k5", [["nxdn96", 0.9]]),
		)
		expect(storedOf(store, id)?.protocol).toBe("unknown")
		expect(storedOf(store, id)?.confidence).toBe("activity")
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 10, { identity: dmrCc(1) })),
		).toBe("upgraded")
		expect(store.applyEvidence(id, evidence("nxdn96", T0 + 20))).toBeNull()
		expect(storedOf(store, id)?.protocol).toBe("dmr")
		expect(storedOf(store, id)?.confidence).toBe("decoded")
	})

	it("keeps encrypted once accepted", () => {
		const { store } = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		store.applyEvidence(
			id,
			evidence("dmr", T0 + 10, { identity: dmrCc(1), encrypted: true }),
		)
		store.applyEvidence(
			id,
			evidence("dmr", T0 + 20, { identity: dmrCc(1), encrypted: false }),
		)
		expect(store.get(id)?.encrypted).toBe(true)
	})

	it("applies evidence without an identity but does not count it as a confirm (§ 6.6: a confirm is the first accepted identity)", () => {
		const { store } = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(
			store.applyEvidence(
				id,
				evidence("dmr", T0 + 10, { talkgroups: ["9"], encrypted: true }),
			),
		).toBe("updated")
		const d = storedOf(store, id)
		expect(d?.protocol).toBe("dmr")
		expect(d?.confidence).toBe("activity")
		expect(d?.identity).toBeUndefined()
		expect(d?.metadata.talkgroups).toEqual(["9"])
		expect(d?.encrypted).toBe(true)
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 20, { identity: dmrCc(1) })),
		).toBe("upgraded")
		expect(storedOf(store, id)?.confidence).toBe("decoded")
	})

	it("lets evidence without an identity only refine the protocol: an analog discovery keeps its family", () => {
		const { store } = newStore({ rasters: PMR })
		const fm =
			store.ingest(
				makeObs({
					id: "o1",
					centreHz: CH,
					startedAt: T0,
				}),
			).discoveryId ?? ""
		expect(store.applyEvidence(fm, evidence("analog-fm", T0 + 100))).toBe(
			"updated",
		)
		expect(storedOf(store, fm)?.protocol).toBe("analog-fm")
		expect(storedOf(store, fm)?.family).toBe("analog")
		expect(storedOf(store, fm)?.confidence).toBe("activity")
		expect(
			store.applyEvidence(
				fm,
				evidence("dmr", T0 + 2_000, { talkgroups: ["9"] }),
			),
		).toBeNull()
		expect(storedOf(store, fm)?.protocol).toBe("analog-fm")
		expect(storedOf(store, fm)?.family).toBe("analog")
		expect(store.discoveryIdOf("o1")).toBe(fm)

		const unk =
			store.ingest(
				makeObs({
					id: "o3",
					centreHz: CH + 1_000_000,
					startedAt: T0,
					cls: "fsk4-12k5",
				}),
			).discoveryId ?? ""
		store.applyEvidence(unk, evidence("dmr", T0 + 2_000, { talkgroups: ["9"] }))
		expect(storedOf(store, unk)?.protocol).toBe("dmr")
		expect(storedOf(store, unk)?.confidence).toBe("activity")
	})

	it("applies nothing from identity-less evidence of another family: no metadata, no encrypted flag", () => {
		const { store } = newStore()
		const fm =
			store.ingest(
				makeObs({
					id: "o1",
					centreHz: CH,
					startedAt: T0,
				}),
			).discoveryId ?? ""
		expect(store.applyEvidence(fm, evidence("analog-fm", T0 + 100))).toBe(
			"updated",
		)
		const before = store.get(fm)
		expect(
			store.applyEvidence(
				fm,
				evidence("dmr", T0 + 2_000, { talkgroups: ["9"], encrypted: true }),
			),
		).toBeNull()
		expect(store.get(fm)).toEqual(before)
	})

	it("still applies identity-less evidence it does not adopt within the same family, or onto an unknown family", () => {
		const { store } = newStore()
		const dmr = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(store.applyEvidence(dmr, evidence("dmr", T0 + 100))).toBe("updated")
		expect(
			store.applyEvidence(
				dmr,
				evidence("nxdn48", T0 + 2_000, { talkgroups: ["9"], encrypted: true }),
			),
		).toBe("updated")
		expect(storedOf(store, dmr)?.protocol).toBe("dmr")
		expect(storedOf(store, dmr)?.confidence).toBe("activity")
		expect(store.get(dmr)?.metadata.talkgroups).toEqual(["9"])
		expect(store.get(dmr)?.encrypted).toBe(true)

		const unk =
			store.ingest(
				makeObs({
					id: "o2",
					centreHz: CH + 1_000_000,
					startedAt: T0,
					hypotheses: [["digital-unknown", 0.8]],
				}),
			).discoveryId ?? ""
		expect(storedOf(store, unk)?.protocol).toBe("unknown")
		expect(
			store.applyEvidence(unk, evidence("digital-unknown", T0 + 100)),
		).toBe("updated")
		expect(storedOf(store, unk)?.protocol).toBe("digital-unknown")
		expect(storedOf(store, unk)?.family).toBe("unknown")
		expect(
			store.applyEvidence(
				unk,
				evidence("pocsag", T0 + 2_000, { talkgroups: ["7"] }),
			),
		).toBe("updated")
		expect(storedOf(store, unk)?.protocol).toBe("digital-unknown")
		expect(store.get(unk)?.metadata.talkgroups).toEqual(["7"])
	})

	it("ignores evidence that is not CRC-clean", () => {
		const { store } = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(
			store.applyEvidence(
				id,
				evidence("dmr", T0 + 10, { identity: dmrCc(1), crcClean: false }),
			),
		).toBeNull()
		expect(store.get(id)?.identity).toBeUndefined()
	})

	it("classifies on the channel tier and caps a leak at candidate before a decode only", () => {
		const { store } = newStore()
		const a = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		store.applyClassification(
			a,
			classification("fsk4-12k5", [["dmr", 0.8]], undefined, "channel"),
		)
		expect(storedOf(store, a)?.protocol).toBe("unknown")
		expect(storedOf(store, a)?.confidence).toBe("activity")
		store.applyClassification(
			a,
			classification("fsk4-12k5", [["dmr", 0.8]], "adjacent-leak", "channel"),
		)
		expect(storedOf(store, a)?.confidence).toBe("activity")
		expect(store.get(a)?.confidenceCap).toBe("adjacent-leak")
		store.applyEvidence(a, evidence("dmr", T0 + 10, { identity: dmrCc(1) }))
		expect(storedOf(store, a)?.confidence).toBe("candidate")
		expect(store.get(a)?.identity).toEqual(dmrCc(1))

		const b = store.ingest(dmrObs("o2", CH + 1_000_000, T0)).discoveryId ?? ""
		store.applyEvidence(b, evidence("dmr", T0 + 10, { identity: dmrCc(2) }))
		store.applyClassification(
			b,
			classification("fsk4-12k5", [["dmr", 0.8]], "suspected-intermod"),
		)
		expect(storedOf(store, b)?.confidence).toBe("decoded")
		expect(store.get(b)?.confidenceCap).toBeUndefined()
	})

	it("applies a cap passed with the decode before the decode: the discovery stays candidate (§ 6.2, P18)", () => {
		const { store } = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(
			store.applyEvidence(
				id,
				evidence("dmr", T0 + 10, { identity: dmrCc(1), talkgroups: ["9"] }),
				{ cap: "suspected-intermod" },
			),
		).toBe("upgraded")
		const d = storedOf(store, id)
		expect(d?.confidence).toBe("candidate")
		expect(d?.confidenceCap).toBe("suspected-intermod")
		expect(d?.identity).toEqual(dmrCc(1))
		expect(d?.metadata.talkgroups).toEqual(["9"])
		store.applyEvidence(id, evidence("dmr", T0 + 20, { identity: dmrCc(1) }))
		expect(storedOf(store, id)?.confidence).toBe("candidate")

		const twin =
			store.ingest(dmrObs("o2", CH + 1_000_000, T0)).discoveryId ?? ""
		store.applyEvidence(twin, evidence("dmr", T0 + 10, { identity: dmrCc(2) }))
		store.applyEvidence(
			twin,
			evidence("dmr", T0 + 20, { identity: dmrCc(2) }),
			{ cap: "adjacent-leak" },
		)
		expect(storedOf(store, twin)?.confidence).toBe("decoded")
		expect(store.get(twin)?.confidenceCap).toBeUndefined()
	})

	it("caps a co-channel twin created by a capped decode with a new identity", () => {
		const { store } = newStore({ rasters: PMR })
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		store.applyEvidence(id, evidence("dmr", T0 + 10, { identity: dmrCc(1) }))
		expect(
			store.applyEvidence(
				id,
				evidence("dmr", T0 + 20, { identity: dmrCc(5) }),
				{ cap: "adjacent-leak" },
			),
		).toBe("created")
		const cc5 = store
			.snapshot()
			.discoveries.find(d => d.identity?.value === "5")
		expect(cc5?.confidence).toBe("candidate")
		expect(cc5?.confidenceCap).toBe("adjacent-leak")
	})

	it("bounds metadata lists to 64 entries, most recent kept", () => {
		const { store } = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		for (let tg = 0; tg < 100; tg++)
			store.applyEvidence(
				id,
				evidence("dmr", T0 + tg, {
					identity: dmrCc(1),
					talkgroups: [String(tg)],
				}),
			)
		const tgs = store.get(id)?.metadata.talkgroups ?? []
		expect(tgs).toHaveLength(64)
		expect(tgs[0]).toBe("36")
		expect(tgs[63]).toBe("99")
	})

	it("bounds in-memory observations per discovery to 256 while counting all", () => {
		const { store } = newStore()
		let id = ""
		for (let i = 0; i < 300; i++)
			id = store.ingest(dmrObs(`o${i}`, CH, T0 + i * 2_000)).discoveryId ?? id
		expect(store.get(id)?.observationCount).toBe(300)
		expect(store.snapshot().observations).toHaveLength(256)
	})
})

describe("DiscoveryStore eviction, operator, re-key", () => {
	it("evicts activity before candidate, never decoded or keep, and refuses when nothing is evictable", () => {
		const { store } = newStore({ max: 3 })
		const cand = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		store.applyEvidence(cand, evidence("dmr", T0, { identity: dmrCc(1) }), {
			cap: "adjacent-leak",
		})
		const act =
			store.ingest(
				makeObs({ id: "o2", centreHz: CH + 100_000, startedAt: T0 + 1_000 }),
			).discoveryId ?? ""
		const dec =
			store.ingest(dmrObs("o3", CH + 200_000, T0 + 2_000)).discoveryId ?? ""
		store.applyEvidence(
			dec,
			evidence("dmr", T0 + 2_500, { identity: dmrCc(1) }),
		)
		const next = store.ingest(
			makeObs({ id: "o4", centreHz: CH + 300_000, startedAt: T0 + 3_000 }),
		)
		expect(next.change).toBe("created")
		// Scanner-redesign 3.10: without a proof every record ranks as published activity, so the
		// oldest goes first; the stored ladder no longer protects a record from eviction.
		expect(store.get(cand)).toBeUndefined()
		expect(store.get(act)).toBeDefined()

		const small = newStore({ max: 2 })
		const k = small.store.ingest(dmrObs("p1", CH, T0)).discoveryId ?? ""
		small.store.setOperator(k, { keep: true })
		const d =
			small.store.ingest(dmrObs("p2", CH + 100_000, T0)).discoveryId ?? ""
		small.store.applyEvidence(d, evidence("dmr", T0, { identity: dmrCc(1) }))
		small.store.setOperator(d, { keep: true })
		expect(small.store.ingest(dmrObs("p3", CH + 200_000, T0)).change).toBe(
			"transient",
		)
		expect(small.store.snapshot().discoveries).toHaveLength(2)
	})

	it("never evicts a locked-out discovery (WG2)", () => {
		const { store } = newStore({ max: 2 })
		const locked =
			store.ingest(
				makeObs({ id: "l1", centreHz: CH, startedAt: T0, blocks: 2 }),
			).discoveryId ?? ""
		store.setOperator(locked, { lockout: true })
		const other =
			store.ingest(
				makeObs({
					id: "l2",
					centreHz: CH + 100_000,
					startedAt: T0 + 1000,
					blocks: 2,
				}),
			).discoveryId ?? ""
		expect(
			store.ingest(
				makeObs({
					id: "l3",
					centreHz: CH + 200_000,
					startedAt: T0 + 2000,
					blocks: 2,
				}),
			).change,
		).toBe("created")
		expect(store.get(locked)).toBeDefined()
		expect(store.get(other)).toBeUndefined()
	})

	it("never prunes a locked-out discovery by age (WG2 R2)", () => {
		let now = T0
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => now,
			newId: counterIds(),
		})
		const locked =
			store.ingest(
				makeObs({ id: "a1", centreHz: CH, startedAt: T0, blocks: 2 }),
			).discoveryId ?? ""
		const plain =
			store.ingest(
				makeObs({ id: "a2", centreHz: CH + 100_000, startedAt: T0, blocks: 2 }),
			).discoveryId ?? ""
		store.setOperator(locked, { lockout: true })
		now = T0 + 200 * 24 * 3_600_000
		expect(store.pruneInactive(180)).toEqual([plain])
		expect(store.get(locked)).toBeDefined()
	})

	it("patches operator fields and rejects an unknown id", () => {
		const { store } = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(store.setOperator(id, { label: "Site A" }).operator).toEqual({
			label: "Site A",
		})
		expect(store.setOperator(id, { lockout: true }).operator).toEqual({
			label: "Site A",
			lockout: true,
		})
		expect(() => store.setOperator("d_missing", { label: "x" })).toThrow(
			WaveKitError,
		)
	})

	it("merges discoveries that collide after a correction change, in one journal entry", () => {
		const { store, entries } = newStore({ rasters: PMR })
		const a = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		const b =
			store.ingest(dmrObs("o2", CH + 3_500, T0 + 1_000)).discoveryId ?? ""
		expect(a).not.toBe(b)
		const before = entries.length
		expect(store.rekey("src-1", 3_000)).toEqual({ merged: [[a, b]] })
		expect(entries).toHaveLength(before + 1)
		expect(entries.at(-1)?.op).toBe("rekey")
		const d = store.get(a)
		expect(store.get(b)).toBeUndefined()
		expect(d?.observationCount).toBe(2)
		expect(d?.frequencyKey).toBe(`r:${CH}`)
		expect(store.correction("src-1")).toBe(3_000)
		expect(store.discoveryIdOf("o2")).toBe(a)
		expect(store.discoveryIdOf("o1")).toBe(a)
		expect(store.discoveryIdOf("missing")).toBeUndefined()
	})

	it("applies a lower maxDiscoveries on the next creation; minSurfaceBlocks does not gate a passed track", () => {
		const { store, entries } = newStore({ max: 10 })
		for (let i = 0; i < 4; i++)
			store.ingest(
				makeObs({
					id: `o${i}`,
					centreHz: CH + i * 100_000,
					startedAt: T0 + i * 1_000,
				}),
			)
		store.setLimits({ maxDiscoveries: 2, minSurfaceBlocks: 2 })
		const before = entries.length
		expect(
			store.ingest(
				makeObs({ id: "o9", centreHz: CH + 900_000, startedAt: T0 + 9_000 }),
			).change,
		).toBe("created")
		expect(store.snapshot().discoveries).toHaveLength(2)
		expect(entries.slice(before).map(e => e.op)).toEqual([
			"evict",
			"observation",
		])
		store.setLimits({ maxDiscoveries: 10, minSurfaceBlocks: 3 })
		expect(
			store.ingest(
				makeObs({
					id: "p1",
					centreHz: CH + 2_000_000,
					startedAt: T0,
					blocks: 2,
				}),
			).change,
		).toBe("created")
		expect(
			store.ingest(
				makeObs({
					id: "p2",
					centreHz: CH + 3_000_000,
					startedAt: T0,
					blocks: 3,
				}),
			).change,
		).toBe("created")
	})

	it("deletes a co-channel twin and clears the link on the original", () => {
		const { store } = newStore({ rasters: PMR })
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		store.applyEvidence(id, evidence("dmr", T0 + 10, { identity: dmrCc(1) }))
		expect(
			store.applyEvidence(id, evidence("dmr", T0 + 20, { identity: dmrCc(5) })),
		).toBe("created")
		const twin = store
			.snapshot()
			.discoveries.find(d => d.identity?.value === "5")
		expect(twin).toBeDefined()
		expect(store.delete(twin?.id ?? "")).toBe(true)
		expect(store.delete(twin?.id ?? "")).toBe(false)
		expect(store.get(id)?.coChannel).toEqual([])
		expect(store.get(id)?.identity).toEqual(dmrCc(1))
		expect(store.snapshot().observations.map(o => o.id)).toEqual(["o1"])
	})

	it("links probe recordings to an observation and counts them on the discovery", () => {
		const { store } = newStore()
		const id = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		expect(store.attachRecordings("o1", [`${id}~a.wav`], "linked")).toBe(true)
		expect(
			store.attachRecordings("o1", [`${id}~a.wav`, `${id}~b.wav`], "linked"),
		).toBe(true)
		expect(store.get(id)?.evidence.recordings).toBe(2)
		expect(store.attachRecordings("missing", [], "none")).toBe(false)
	})
})

describe("DiscoveryStore queries and replay", () => {
	it("filters, sorts and paginates with an opaque cursor", () => {
		const { store } = newStore()
		store.ingest(makeObs({ id: "o1", centreHz: CH + 200_000, startedAt: T0 }))
		const o2 = store.ingest(dmrObs("o2", CH, T0 + 1_000)).discoveryId ?? ""
		const o3 =
			store.ingest(dmrObs("o3", CH + 100_000, T0 + 2_000)).discoveryId ?? ""
		store.applyEvidence(o2, evidence("dmr", T0 + 1_000, { identity: dmrCc(1) }))
		store.applyEvidence(o3, evidence("dmr", T0 + 2_000, { identity: dmrCc(2) }))
		// Scanner-redesign 3.10: these decodes leave no proof, so no record publishes above activity.
		expect(store.list({ minConfidence: "candidate" }).items).toEqual([])
		const page1 = store.list({ sort: "frequency", limit: 2 })
		expect(page1.items.map(d => d.frequencyHz)).toEqual([CH, CH + 100_000])
		const page2 = store.list({
			sort: "frequency",
			limit: 2,
			cursor: page1.nextCursor,
		})
		expect(page2.items.map(d => d.frequencyHz)).toEqual([CH + 200_000])
		expect(page2.nextCursor).toBeNull()
		expect(store.list({}).items.map(d => d.frequencyHz)).toEqual([
			CH + 100_000,
			CH,
			CH + 200_000,
		])
		expect(() => store.list({ cursor: "abc" })).toThrow(WaveKitError)
	})

	it("reproduces the store from a snapshot plus later journal entries, idempotently", () => {
		const { store, entries } = newStore({ rasters: PMR })
		const a = store.ingest(dmrObs("o1", CH, T0)).discoveryId ?? ""
		store.ingest(
			makeObs({
				id: "o2",
				centreHz: CH,
				startedAt: T0,
				cls: "analog-fm",
				hypotheses: [["analog-fm", 0.8]],
			}),
		)
		const snap = store.snapshot()
		const cut = entries.length
		store.applyEvidence(
			a,
			evidence("dmr", T0 + 10, { identity: dmrCc(1), encrypted: true }),
		)
		store.ingest(dmrObs("o3", CH + 3_500, T0 + 20))
		store.rekey("src-1", 3_000)
		store.setOperator(a, { keep: true })

		const replica = newStore({ rasters: PMR }).store
		replica.restore(snap)
		for (const e of entries.slice(cut)) replica.replay(e)
		// Memory-only identities without retained checked observations are downgraded
		// identically by snapshot restore and journal replay.
		const normalized = newStore().store
		normalized.restore(store.snapshot())
		expect(replica.snapshot()).toEqual(normalized.snapshot())
		for (const e of entries) replica.replay(e)
		expect(replica.snapshot()).toEqual(normalized.snapshot())
		expect(replica.correction("src-1")).toBe(3_000)
	})

	it("carries per-source corrections in the snapshot, so a restart after journal pruning keeps snapping corrected (P13)", () => {
		const { store } = newStore({ rasters: PMR })
		store.ingest(dmrObs("o1", CH + 3_200, T0))
		store.rekey("src-1", 3_000)
		const snap = store.snapshot()
		expect(snap.corrections).toEqual([{ sourceId: "src-1", hz: 3_000 }])
		// ids from another generator: a restarted process never reuses ids (ULIDs in production)
		const replica = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => T0,
			newId: () => "REPLICA",
			rasters: () => PMR,
		})
		replica.restore(snap) // no journal: the rekey entry was pruned
		expect(replica.snapshot()).toEqual(snap)
		expect(replica.correction("src-1")).toBe(3_000)
		const late = dmrObs("o2", CH + 3_300 + 12_500, T0 + 60_000) // snaps only with the correction applied
		const original = store.get(store.ingest(late).discoveryId ?? "")
		const restored = replica.get(replica.ingest(late).discoveryId ?? "")
		expect(restored?.frequencyKey).toBe(`r:${CH + 12_500}`)
		expect(restored?.frequencyKey).toBe(original?.frequencyKey)
		expect(restored?.observationCount).toBe(1)
	})

	it("fills Observation.decode with accepted evidence of the observation's epoch, deduped and bounded (§ 7.1, P17)", () => {
		const { store, entries } = newStore()
		const id =
			store.ingest(dmrObs("o1", CH, T0, { open: true })).discoveryId ?? ""
		const ev = evidence("dmr", T0 + 100, { identity: dmrCc(1) })
		const before = entries.length
		expect(store.appendObservationEvidence("o1", ev)).toBe(true)
		expect(entries).toHaveLength(before + 1)
		expect(entries.at(-1)?.op).toBe("evidence")
		expect(store.appendObservationEvidence("o1", ev)).toBe(false) // duplicate
		expect(
			store.appendObservationEvidence(
				"o1",
				evidence("dmr", T0 + 200, { crcClean: false }),
			),
		).toBe(false)
		expect(
			store.appendObservationEvidence("o1", {
				...evidence("dmr", T0 + 300),
				epoch: 2,
			}),
		).toBe(false)
		expect(store.appendObservationEvidence("missing", ev)).toBe(false)
		expect(entries).toHaveLength(before + 1)
		store.ingest(dmrObs("o1", CH, T0, { durationMs: 2_000 })) // finishes; the list survives the re-ingest
		const decodeOf = () =>
			store.observations(id, null, 10).items[0]?.decode ?? []
		expect(decodeOf()).toEqual([ev])
		for (let i = 1; i <= 20; i++)
			store.appendObservationEvidence(
				"o1",
				evidence("dmr", T0 + 1_000 + i, { identity: dmrCc(1) }),
			)
		expect(decodeOf()).toHaveLength(16)
		expect(decodeOf()[0]?.at).toBe(T0 + 1_005)
		expect(decodeOf()[15]?.at).toBe(T0 + 1_020)
		const replica = newStore().store
		for (const e of entries) replica.replay(e)
		expect(replica.snapshot()).toEqual(store.snapshot())
	})

	it("rejects evidence stamped after a retune ended the observation's epoch", () => {
		const { store } = newStore()
		store.ingest({
			...dmrObs("o1", CH, T0, { durationMs: 1_000 }),
			endReason: "retune",
		})
		expect(
			store.appendObservationEvidence("o1", evidence("dmr", T0 + 1_500)),
		).toBe(false)
		expect(
			store.appendObservationEvidence("o1", evidence("dmr", T0 + 900)),
		).toBe(true)
		store.ingest(dmrObs("o2", CH + 100_000, T0, { durationMs: 1_000 })) // endReason "quiet": the epoch did not end
		expect(
			store.appendObservationEvidence("o2", evidence("dmr", T0 + 5_000)),
		).toBe(true)
	})

	it("rejects a journal entry whose payload is not a store mutation", () => {
		const replica = newStore().store
		expect(() =>
			replica.replay({
				seq: 1,
				at: new Date(T0).toISOString(),
				op: "observation",
				payload: { nope: true },
			}),
		).toThrow(WaveKitError)
	})
})

describe("estimateFrequencyError (§ 7.4)", () => {
	let seq = 0
	const disc = (
		offsetHz: number,
		extra: {
			sourceId?: string
			confidence?: ScannerConfidence
			key?: "r" | "g"
			hz?: number
		} = {},
	): Discovery => {
		seq += 1
		const hz = extra.hz ?? CH + seq * 12_500
		const stats = { peakDbfs: -50, meanDbfs: -55, snrDb: 25, floorDbfs: -80 }
		return {
			id: `d_${seq}`,
			frequencyHz: hz,
			frequencyKey: `${extra.key ?? "r"}:${hz}`,
			measuredOffsetHz: offsetHz,
			bandwidthHz: 9_000,
			protocol: "dmr",
			family: "digital-voice",
			class: "fsk4-12k5",
			confidence: extra.confidence ?? "decoded",
			encrypted: false,
			coChannel: [],
			firstSeenAt: new Date(T0).toISOString(),
			lastSeenAt: new Date(T0).toISOString(),
			observationCount: 1,
			airtimeMs: 1_000,
			signal: { best: stats, last: { ...stats } },
			metadata: {
				talkgroups: [],
				sources: [],
				slots: [],
				callsigns: [],
				capcodes: [],
				ismModels: [],
			},
			sourceIds: [extra.sourceId ?? "src-1"],
			jobIds: ["job-1"],
			tuningTrust: "commanded",
			evidence: { recordings: 0, psd: false, iq: false },
		}
	}

	it("returns null with fewer than 5 agreeing decoded discoveries", () => {
		expect(
			estimateFrequencyError(
				[disc(400), disc(420), disc(380), disc(410)],
				"src-1",
			),
		).toBeNull()
		expect(estimateFrequencyError([], "src-1")).toBeNull()
	})

	it("returns the median offset, ppm and count of 5 agreeing discoveries", () => {
		const ds = [
			disc(400, { hz: 446_000_000 }),
			disc(450, { hz: 446_000_000 }),
			disc(300, { hz: 446_000_000 }),
			disc(500, { hz: 446_000_000 }),
			disc(420, { hz: 446_000_000 }),
		]
		const est = estimateFrequencyError(ds, "src-1")
		expect(est?.hz).toBe(420)
		expect(est?.n).toBe(5)
		expect(est?.ppm).toBeCloseTo((420 / 446_000_000) * 1e6, 9)
	})

	it("takes the largest cluster agreeing within 300 Hz and returns null when the offsets are scattered", () => {
		const cluster = [
			disc(-200),
			disc(-150),
			disc(-100),
			disc(-50),
			disc(0),
			disc(50),
		]
		const est = estimateFrequencyError(
			[...cluster, disc(2_000), disc(-3_000)],
			"src-1",
		)
		expect(est?.n).toBe(6)
		expect(est?.hz).toBe(-75)
		expect(
			estimateFrequencyError(
				[disc(0), disc(400), disc(800), disc(1_200), disc(1_600), disc(2_000)],
				"src-1",
			),
		).toBeNull()
	})

	it("ignores other sources, non-decoded and grid-keyed discoveries", () => {
		const four = [disc(100), disc(110), disc(120), disc(130)]
		expect(
			estimateFrequencyError(
				[...four, disc(105, { sourceId: "src-2" })],
				"src-1",
			),
		).toBeNull()
		expect(
			estimateFrequencyError(
				[...four, disc(105, { confidence: "classified" })],
				"src-1",
			),
		).toBeNull()
		expect(
			estimateFrequencyError([...four, disc(105, { key: "g" })], "src-1"),
		).toBeNull()
		expect(estimateFrequencyError([...four, disc(105)], "src-1")?.n).toBe(5)
		expect(
			estimateFrequencyError(
				[...four, disc(105, { sourceId: "src-2" })],
				"src-2",
			),
		).toBeNull()
	})
})
