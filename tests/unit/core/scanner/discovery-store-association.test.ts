import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreSnapshot,
} from "../../../../src/core/scanner/store/discovery-store.js"
import {
	compatible,
	recordsCompatible,
} from "../../../../src/core/scanner/store/compatibility.js"
import type {
	CompatibilityRecord,
	CompatibilitySide,
} from "../../../../src/core/scanner/store/compatibility.js"
import { DQ_CO_CHANNEL_MAX } from "../../../../src/core/scanner/detection-quality-contract.js"
import { gridToleranceHz } from "../../../../src/core/scanner/bandplan/index.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	DecodeEvidence,
	Discovery,
	Observation,
	ObservationInput,
	ScannerClass,
} from "../../../../src/core/scanner/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

// Grid placement (no raster): 2 kHz keys and tolerance for OBW up to 8 kHz.
const F = 446_100_000
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0)

function newStore(max = 200): {
	store: DiscoveryStore
	entries: JournalEntry[]
} {
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: max,
		now: () => T0,
		newId: counterIds(),
		rasters: () => [],
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	return { store, entries }
}

interface Spec {
	id: string
	centreHz: number
	at: number
	obwHz?: number
	peakDbfs?: number
	snrDb?: number
	overload?: boolean
	cls?: ScannerClass
	edge?: boolean
	durationMs?: number
}

function obs(s: Spec): ObservationInput {
	const o = makeObs({
		id: s.id,
		centreHz: s.centreHz,
		startedAt: s.at,
		obwHz: s.obwHz ?? 9_000,
		snrDb: s.snrDb ?? 25,
		cls: s.cls ?? "unknown",
		durationMs: s.durationMs ?? 1_000,
		edge: s.edge ?? false,
		gate: "passed",
	})
	if (s.peakDbfs !== undefined) o.track.peakDbfs = s.peakDbfs
	o.track.flags.overload = s.overload ?? false
	return o
}

function analog(
	outcome: "decoded" | "carrier-only" | "data-like",
	at: number,
): ProofAnalogInput {
	return {
		outcome,
		mode: "nfm",
		voice: outcome === "decoded",
		tone: { ctcssHz: outcome === "decoded" ? 88.5 : null, dcs: null },
		transport: "live",
		at,
	}
}

/** Seeded ambient carrier at F: OBW 3 to 4 kHz, peak -23 to -30 dBFS, class carrier. */
function ambient(store: DiscoveryStore, n = 20): string {
	let id = ""
	for (let i = 0; i < n; i++) {
		const r = store.ingest(
			obs({
				id: `amb${i}`,
				centreHz: F + ((i * 37) % 80) - 40,
				at: T0 + i * 60_000,
				obwHz: 3_000 + ((i * 131) % 1_000),
				peakDbfs: -23 - ((i * 3) % 8),
				snrDb: 20,
				cls: "carrier",
			}),
		)
		if (i === 0) id = r.discoveryId ?? ""
		expect(r.discoveryId).toBe(id)
	}
	return id
}

const centreOf = (d: Discovery): number => d.frequencyHz + d.measuredOffsetHz

function expectReplayEqual(
	store: DiscoveryStore,
	entries: JournalEntry[],
): void {
	const replica = new DiscoveryStore({
		maxDiscoveries: 200,
		now: () => T0,
		newId: counterIds(),
		rasters: () => [],
	})
	for (const e of entries) replica.replay(e)
	expect(replica.snapshot()).toEqual(store.snapshot())
}

describe("DQ 3: ambient misattach fixtures", () => {
	it("strong transmission 15 kHz away gets its own record; ambient best and class stay", () => {
		const { store, entries } = newStore()
		const amb = ambient(store)
		const before = structuredClone(store.get(amb)?.signal.best)
		const r = store.ingest(
			obs({
				id: "strong",
				centreHz: F + 15_000,
				at: T0 + 30 * 60_000,
				obwHz: 6_000,
				peakDbfs: 0,
				snrDb: 48,
				overload: true,
				cls: "analog-fm",
			}),
		)
		expect(r.change).toBe("created")
		expect(r.discoveryId).not.toBe(amb)
		const a = store.get(amb)
		expect(a?.signal.best).toEqual(before)
		expect(a?.signal.best.peakDbfs).toBeLessThanOrEqual(-23)
		expect(a?.class).toBe("carrier")
		expectReplayEqual(store, entries)
	})

	it("strong transmission 564 Hz away: one new record holds both bursts, ambient untouched", () => {
		const { store, entries } = newStore()
		const amb = ambient(store)
		const before = structuredClone(store.get(amb)?.signal.best)
		const first = store.ingest(
			obs({
				id: "tx1",
				centreHz: F - 564,
				at: T0 + 30 * 60_000,
				obwHz: 6_000,
				peakDbfs: -0.7,
				snrDb: 48,
				overload: true,
				durationMs: 3_300,
				cls: "analog-fm",
			}),
		)
		expect(first.change).toBe("created")
		const strong = first.discoveryId ?? ""
		expect(strong).not.toBe(amb)
		const second = store.ingest(
			obs({
				id: "tx2",
				centreHz: F - 860,
				at: T0 + 30 * 60_000 + 5_000,
				obwHz: 7_000,
				peakDbfs: 0.8,
				snrDb: 48,
				overload: true,
				durationMs: 2_200,
				cls: "analog-fm",
			}),
		)
		expect(second.discoveryId).toBe(strong)
		expect(store.snapshot().discoveries).toHaveLength(2)
		expect(store.discoveryIdOf("tx1")).toBe(strong)
		expect(store.discoveryIdOf("tx2")).toBe(strong)
		const a = store.get(amb)
		expect(a?.signal.best).toEqual(before)
		expect(a?.signal.best.peakDbfs).toBeLessThanOrEqual(-23)
		expect(a?.class).toBe("carrier")
		expect(a?.observationCount).toBe(20)
		// Same key, refused settle: linked both ways instead of merged.
		expect(store.get(strong)?.frequencyKey).toBe(a?.frequencyKey)
		expect(a?.coChannel).toContain(strong)
		expect(store.get(strong)?.coChannel).toContain(amb)
		expectReplayEqual(store, entries)
	})

	it("shared key: settle keeps an established strong record apart from the ambient", () => {
		const { store, entries } = newStore()
		const amb = ambient(store)
		const before = structuredClone(store.get(amb)?.signal.best)
		const ambKey = store.get(amb)?.frequencyKey
		// A strong record born 3 kHz up (another key), then walking onto the ambient's key.
		const walk = [3_000, 3_000, 3_000, 1_500, 1_500, 1_500, 1_500, 600, 600]
		let strong = ""
		walk.forEach((offset, i) => {
			const r = store.ingest(
				obs({
					id: `s${i}`,
					centreHz: F + offset,
					at: T0 + 40 * 60_000 + i * 2_000,
					obwHz: 9_000,
					peakDbfs: -2,
					snrDb: 45,
				}),
			)
			if (i === 0) strong = r.discoveryId ?? ""
			expect(r.discoveryId).toBe(strong)
		})
		for (let i = 0; i < 12; i++)
			store.ingest(
				obs({
					id: `s2-${i}`,
					centreHz: F + 600,
					at: T0 + 50 * 60_000 + i * 2_000,
					obwHz: 9_000,
					peakDbfs: -2,
					snrDb: 45,
				}),
			)
		const s = store.get(strong)
		// refresh re-keyed the strong record onto the ambient's key; settle ran on every add
		expect(s?.frequencyKey).toBe(ambKey)
		expect(store.snapshot().discoveries).toHaveLength(2)
		expect(store.get(amb)?.signal.best).toEqual(before)
		expect(store.get(amb)?.class).toBe("carrier")
		expect(s?.coChannel).toEqual([amb])
		expect(store.get(amb)?.coChannel).toEqual([strong])
		// rekey re-runs refresh and settle on both: still apart
		store.rekey("src-1", 0)
		expect(store.snapshot().discoveries).toHaveLength(2)
		expectReplayEqual(store, entries)
	})

	it("a mobile user fading 25 dB at a fixed bandwidth stays one record", () => {
		const { store } = newStore()
		let id = ""
		for (let i = 0; i < 60; i++) {
			const r = store.ingest(
				obs({
					id: `m${i}`,
					centreHz: F + ((i * 53) % 300) - 150,
					at: T0 + i * 3_000,
					obwHz: 11_000 + ((i * 97) % 1_000),
					peakDbfs: -30 - ((i * 7) % 26),
					snrDb: 30,
				}),
			)
			if (i === 0) id = r.discoveryId ?? ""
			expect(r.discoveryId).toBe(id)
		}
		expect(store.snapshot().discoveries).toHaveLength(1)
	})

	it("an incompatible observation does not raise an established record's best", () => {
		const { store } = newStore()
		const amb = ambient(store, 5)
		const before = structuredClone(store.get(amb)?.signal.best)
		// Compatible (same OBW class) and louder by 25 dB, but overload: no raise.
		store.ingest(
			obs({
				id: "ov",
				centreHz: F,
				at: T0 + 90 * 60_000,
				obwHz: 3_500,
				peakDbfs: -1,
				snrDb: 50,
				overload: true,
			}),
		)
		expect(store.discoveryIdOf("ov")).toBe(amb)
		expect(store.get(amb)?.signal.best).toEqual(before)
		// Compatible, not overload: raises.
		store.ingest(
			obs({
				id: "up",
				centreHz: F,
				at: T0 + 91 * 60_000,
				obwHz: 3_500,
				peakDbfs: -20,
				snrDb: 30,
			}),
		)
		expect(store.get(amb)?.signal.best.snrDb).toBe(30)
	})
})

describe("DQ 2: one emitter, one discovery fixtures", () => {
	it("one DMR emitter seen as analog-fm and fsk4 by two classifiers stays one discovery", () => {
		const { store, entries } = newStore()
		// Straddles the 2 kHz grid key boundary at F + 1 000 so the key path alone would split.
		const centre = F + 1_000
		let first = ""
		for (let i = 0; i < 40; i++) {
			const analogFm = i % 2 === 0
			const id = `d${i}`
			const at = T0 + i * 1_300
			const r = store.ingest(
				obs({
					id,
					centreHz: centre - 220 + ((i * 173) % 440),
					at,
					obwHz: 9_000 + ((i * 311) % 3_000),
					snrDb: 20 + (i % 6),
					cls: analogFm ? "analog-fm" : "fsk4-12k5",
				}),
			)
			if (i === 0) first = r.discoveryId ?? ""
			// the analog classifier's sightings bring analog evidence (effective family analog)
			if (analogFm) store.recordAnalog(id, analog("decoded", at + 500))
		}
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.discoveryIdOf("d39")).toBe(first)
		expectReplayEqual(store, entries)
	})

	it("a steady carrier with repeated unknown sightings stays one record with no partners", () => {
		const { store, entries } = newStore()
		let at = T0
		const gaps = [13, 98, 41, 27, 66, 15, 80, 33, 52, 19, 90]
		const ids: string[] = []
		for (let i = 0; i < 12; i++) {
			const id = `c${i}`
			const r = store.ingest(
				obs({
					id,
					centreHz: F + 575 + ((i * 17) % 50),
					at,
					obwHz: 4_000 + ((i * 1_337) % 4_000),
					snrDb: 21 + ((i * 5) % 12),
					cls: "carrier",
				}),
			)
			ids.push(r.discoveryId ?? "")
			store.recordAnalog(id, analog("carrier-only", at + 500))
			at += (gaps[i] ?? 13) * 60_000
		}
		expect(new Set(ids).size).toBe(1)
		const [d] = store.snapshot().discoveries
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(d?.coChannel).toEqual([])
		expect(store.get(ids[0] ?? "")?.family).toBe("carrier")
		expectReplayEqual(store, entries)
	})

	it("cross-family sticky refuses a bandwidth ratio outside [0.5, 2]", () => {
		const { store } = newStore()
		const a = store.ingest(obs({ id: "a", centreHz: F, at: T0, obwHz: 4_000 }))
		store.recordAnalog("a", analog("carrier-only", T0 + 1))
		const wide = store.ingest(
			obs({ id: "w", centreHz: F + 3_100, at: T0 + 1_000, obwHz: 12_000 }),
		)
		expect(wide.discoveryId).not.toBe(a.discoveryId)
	})
})

describe("review repros", () => {
	it("a young record's best rises from a stronger non-overload observation (3.3, 3.5)", () => {
		const { store } = newStore()
		const id = store.ingest(
			obs({ id: "a", centreHz: F, at: T0, snrDb: 20 }),
		).discoveryId
		store.ingest(obs({ id: "b", centreHz: F, at: T0 + 2_000, snrDb: 40 }))
		expect(store.get(id ?? "")?.signal.best.snrDb).toBe(40)
	})

	it("a young record's best does not rise from an overload observation", () => {
		const { store } = newStore()
		const id = store.ingest(
			obs({ id: "a", centreHz: F, at: T0, snrDb: 20 }),
		).discoveryId
		store.ingest(
			obs({ id: "b", centreHz: F, at: T0 + 2_000, snrDb: 40, overload: true }),
		)
		expect(store.discoveryIdOf("b")).toBe(id)
		expect(store.get(id ?? "")?.signal.best.snrDb).toBe(20)
	})

	it("recomputes and journals the majority class after a merge", () => {
		const { store, entries } = newStore()
		for (let i = 0; i < 3; i++)
			store.ingest(
				obs({ id: `c${i}`, centreHz: F, at: T0 + i * 1_000, cls: "carrier" }),
			)
		const carrier = store.discoveryIdOf("c0") ?? ""
		const fm = (i: number, centreHz: number): ObservationInput =>
			obs({
				id: `f${i}`,
				centreHz,
				at: T0 + 10_000 + i * 1_000,
				cls: "analog-fm",
			})
		for (let i = 0; i < 5; i++) store.ingest(fm(i, F + 10_000))
		expect(store.discoveryIdOf("f0")).not.toBe(carrier)
		for (let i = 0; i < 5; i++) store.ingest(fm(i, F))
		const survivor = store.discoveryIdOf("f0") ?? ""
		expect(store.discoveryIdOf("c0")).toBe(survivor)
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.get(survivor)?.observationCount).toBe(8)
		expect(store.get(survivor)?.class).toBe("analog-fm")
		expectReplayEqual(store, entries)
	})

	it("keeps the class history across snapshot/restore and journal replay", () => {
		const { store, entries } = newStore()
		for (let i = 0; i < 10; i++)
			store.ingest(
				obs({ id: `c${i}`, centreHz: F, at: T0 + i * 2_000, cls: "carrier" }),
			)
		const id = store.discoveryIdOf("c0") ?? ""
		const snap = store.snapshot()
		expect(
			(snap.observations[0] as { classVote?: string } | undefined)?.classVote,
		).toBe("carrier")
		// the DTO does not carry the vote
		expect(
			"classVote" in (store.observations(id, null, 10).items[0] ?? {}),
		).toBe(false)
		const restored = newStore().store
		restored.restore(JSON.parse(JSON.stringify(snap)) as StoreSnapshot)
		const replayed = newStore().store
		for (const e of entries)
			replayed.replay(JSON.parse(JSON.stringify(e)) as JournalEntry)
		for (const s of [restored, replayed]) {
			s.ingest(
				obs({ id: "fm", centreHz: F, at: T0 + 60_000, cls: "analog-fm" }),
			)
			expect(s.discoveryIdOf("fm")).toBe(id)
			expect(s.get(id)?.class).toBe("carrier")
		}
	})

	it("treats an old snapshot without votes as no votes", () => {
		const { store } = newStore()
		for (let i = 0; i < 3; i++)
			store.ingest(
				obs({ id: `c${i}`, centreHz: F, at: T0 + i * 2_000, cls: "carrier" }),
			)
		const snap = JSON.parse(JSON.stringify(store.snapshot())) as StoreSnapshot
		for (const o of snap.observations)
			delete (o as { classVote?: string }).classVote
		const restored = newStore().store
		restored.restore(snap)
		restored.ingest(
			obs({ id: "fm", centreHz: F, at: T0 + 60_000, cls: "analog-fm" }),
		)
		expect(restored.get(restored.discoveryIdOf("fm") ?? "")?.class).toBe(
			"analog-fm",
		)
	})

	it("recomputes and journals the class when a re-ingest changes only the vote", () => {
		const { store, entries } = newStore()
		const first = obs({ id: "x", centreHz: F, at: T0, cls: "carrier" })
		const id = store.ingest(first).discoveryId ?? ""
		expect(store.get(id)?.class).toBe("carrier")
		const again = obs({ id: "x", centreHz: F, at: T0, cls: "analog-fm" })
		store.ingest(again)
		expect(store.get(id)?.class).toBe("analog-fm")
		expectReplayEqual(store, entries)
	})

	it("an unknown observation with a failed decode still joins the carrier record", () => {
		const { store } = newStore()
		const id = store.ingest(
			obs({ id: "c", centreHz: F, at: T0, obwHz: 5_000 }),
		).discoveryId
		store.recordAnalog("c", analog("carrier-only", T0 + 1))
		const failed: DecodeEvidence = {
			protocol: "dmr",
			metadata: {},
			crcClean: false,
			at: T0 + 10_100,
			epoch: 1,
			origin: "probe",
		}
		// 600 Hz away: inside the 1 kHz cross-family radius; the failed decode proves nothing
		const r = store.ingest(
			obs({ id: "u", centreHz: F + 600, at: T0 + 10_000, obwHz: 5_000 }),
			{ decode: failed },
		)
		expect(r.discoveryId).toBe(id)
		expect(store.snapshot().discoveries).toHaveLength(1)
	})

	it("two young records are split by level, observation by observation (9.4)", () => {
		const { store } = newStore()
		const loud = store.ingest(
			obs({
				id: "l",
				centreHz: F,
				at: T0,
				obwHz: 4_000,
				peakDbfs: -10,
				snrDb: 45,
			}),
		).discoveryId
		const quiet = store.ingest(
			obs({
				id: "q",
				centreHz: F + 300,
				at: T0 + 1_000,
				obwHz: 9_000,
				peakDbfs: -45,
				snrDb: 25,
			}),
		).discoveryId
		expect(quiet).not.toBe(loud)
		expect(store.snapshot().discoveries).toHaveLength(2)
		expect(
			recordsCompatible(
				{
					medians: { peakDbfs: -10, obwHz: 4_000, count: 1 },
					observations: [{ peakDbfs: -10, obwHz: 4_000 }],
				},
				{
					medians: { peakDbfs: -45, obwHz: 9_000, count: 1 },
					observations: [{ peakDbfs: -45, obwHz: 9_000 }],
				},
			),
		).toBe(false)
	})
})

describe("DQ 2.3: co-channel cap and pruning", () => {
	/** Twelve records within one window, every one listing all others (pre-DQ state). */
	function crowded(): { store: DiscoveryStore; ids: string[] } {
		const { store: seed } = newStore()
		for (let i = 0; i < 12; i++)
			seed.ingest(
				obs({ id: `o${i}`, centreHz: F + i * 100_000, at: T0 + i * 1_000 }),
			)
		const snap: StoreSnapshot = seed.snapshot()
		const ids = snap.discoveries.map(d => d.id)
		const centre = (i: number): number => F - 1_100 + i * 200
		snap.discoveries.forEach((d, i) => {
			// distinct identities, so settle never merges them
			d.identity = { kind: "dmr-cc", value: String(i + 1) }
			d.protocol = "dmr"
			d.family = "digital-voice"
			d.confidence = "decoded"
			d.frequencyHz = centre(i)
			d.measuredOffsetHz = 0
			d.frequencyKey = `g:${Math.round(centre(i) / 2_500) * 2_500}`
			d.coChannel = ids.filter(x => x !== d.id)
		})
		snap.observations.forEach((o: Observation) => {
			o.centerHz = centre(ids.indexOf(o.discoveryId))
		})
		const { store } = newStore()
		store.restore(snap)
		store.rekey("src-1", 0)
		return { store, ids }
	}

	it("keeps at most 8 nearest partners, reciprocal, after an overflow of 12", () => {
		const { store, ids } = crowded()
		const all = store.snapshot().discoveries
		expect(all).toHaveLength(12)
		for (const d of all) {
			expect(d.coChannel.length).toBeLessThanOrEqual(DQ_CO_CHANNEL_MAX)
			const dist = (id: string): number =>
				Math.abs(centreOf(store.get(id) as Discovery) - centreOf(d))
			const nearest = ids
				.filter(x => x !== d.id)
				.sort((a, b) => dist(a) - dist(b))
				.slice(0, DQ_CO_CHANNEL_MAX)
				.map(dist)
			const worst = Math.max(...nearest)
			for (const p of d.coChannel) {
				expect(store.get(p)?.coChannel).toContain(d.id)
				expect(dist(p)).toBeLessThanOrEqual(worst)
			}
			const ordered = d.coChannel.map(dist)
			expect(ordered).toEqual([...ordered].sort((a, b) => a - b))
		}
		// the middle records keep a full list
		expect(all.some(d => d.coChannel.length === DQ_CO_CHANNEL_MAX)).toBe(true)
	})

	it("drops a partner that moved out of tolerance and re-links it when it returns", () => {
		const { store, entries } = newStore()
		// Q: weak narrow ambient; P: strong wide user (incompatible, so never merged).
		for (let i = 0; i < 4; i++)
			store.ingest(
				obs({
					id: `q${i}`,
					centreHz: F,
					at: T0 + i * 1_000,
					obwHz: 4_000,
					peakDbfs: -50,
					snrDb: 20,
				}),
			)
		const q = store.discoveryIdOf("q0") ?? ""
		// P's median walks 800 -> 2 600 Hz (Q's tolerance is 2 000, P's 2 500)
		const path = [
			800, 800, 800, 2_000, 2_000, 2_000, 3_200, 3_200, 3_200, 3_200, 3_200,
			3_200,
		]
		path.forEach((off, i) =>
			store.ingest(
				obs({
					id: `p${i}`,
					centreHz: F + off,
					at: T0 + 10_000 + i * 1_000,
					obwHz: 9_000,
					peakDbfs: -20,
					snrDb: 40,
				}),
			),
		)
		const p = store.discoveryIdOf("p0") ?? ""
		expect(p).not.toBe(q)
		expect(store.discoveryIdOf("p11")).toBe(p)
		expect(store.get(p)?.coChannel).not.toContain(q)
		expect(store.get(q)?.coChannel).not.toContain(p)
		const back = Array.from({ length: 12 }, () => 1_200)
		back.forEach((off, i) =>
			store.ingest(
				obs({
					id: `r${i}`,
					centreHz: F + off,
					at: T0 + 30_000 + i * 1_000,
					obwHz: 9_000,
					peakDbfs: -20,
					snrDb: 40,
				}),
			),
		)
		expect(store.discoveryIdOf("r11")).toBe(p)
		expect(store.get(p)?.coChannel).toContain(q)
		expect(store.get(q)?.coChannel).toContain(p)
		expectReplayEqual(store, entries)
	})
})

// ── properties ──────────────────────────────────────────────────────────

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b)
	const mid = s.length >> 1
	const upper = s[mid] ?? 0
	return s.length % 2 === 1 ? upper : ((s[mid - 1] ?? upper) + upper) / 2
}

type Sample = { peakDbfs: number; obwHz: number }

/** Oracle: each record's last 64 observations (by start time) as level samples. */
function oracleSamples(snap: StoreSnapshot): Map<string, Sample[]> {
	const by = new Map<string, Observation[]>()
	for (const o of snap.observations) {
		const list = by.get(o.discoveryId) ?? []
		list.push(o)
		by.set(o.discoveryId, list)
	}
	const out = new Map<string, Sample[]>()
	for (const [id, list] of by) {
		list.sort((a, b) =>
			a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
		)
		out.set(
			id,
			list.slice(-64).map(o => ({ peakDbfs: o.peakDbfs, obwHz: o.obwHz })),
		)
	}
	return out
}

/** The record the store judges: medians when established, its observations when young. */
function recordOf(samples: readonly Sample[]): CompatibilityRecord {
	const recent = samples.slice(-64)
	return {
		medians: {
			peakDbfs: median(recent.map(o => o.peakDbfs)),
			obwHz: median(recent.map(o => o.obwHz)),
			count: recent.length,
		},
		observations: recent.length < 3 ? recent : [],
	}
}

const levelObs = fc.record({
	offset: fc.integer({ min: -1_500, max: 1_500 }),
	loud: fc.boolean(),
	wide: fc.boolean(),
	jitterDb: fc.integer({ min: -3, max: 3 }),
	overload: fc.boolean(),
	rekey: fc.boolean(),
})

describe("DQ properties", () => {
	// Feature: detection-quality, Property 5: Cross-family convergence
	// Validates: Requirements 2.1, 2.2
	it("compatible observations within 1 kHz converge on one discovery whatever their family", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						offset: fc.integer({ min: -400, max: 400 }),
						obwHz: fc.integer({ min: 6_000, max: 11_000 }),
						peakDb: fc.integer({ min: -45, max: -40 }),
						evidence: fc.constantFrom(
							"none",
							"decoded",
							"carrier-only",
							"data-like",
						),
						cls: fc.constantFrom<ScannerClass>(
							"analog-fm",
							"fsk4-12k5",
							"carrier",
							"unknown",
						),
					}),
					{ minLength: 1, maxLength: 30 },
				),
				fc.integer({ min: -1_500, max: 1_500 }),
				(steps, base) => {
					const { store } = newStore()
					steps.forEach((s, i) => {
						const id = `x${i}`
						const at = T0 + i * 2_000
						store.ingest(
							obs({
								id,
								centreHz: F + base + s.offset,
								at,
								obwHz: s.obwHz,
								peakDbfs: s.peakDb,
								snrDb: 30,
								cls: s.cls,
							}),
						)
						if (s.evidence !== "none")
							store.recordAnalog(id, analog(s.evidence, at + 500))
					})
					expect(store.snapshot().discoveries).toHaveLength(1)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: detection-quality, Property 6: Co-channel bound
	// Validates: Requirements 2.3
	it("after any sequence and refresh every co-channel list is bounded, existing, within tolerance and reciprocal", () => {
		fc.assert(
			fc.property(
				fc.array(levelObs, { minLength: 1, maxLength: 40 }),
				steps => {
					const { store, entries } = newStore()
					steps.forEach((s, i) => {
						store.ingest(
							obs({
								id: `y${i}`,
								centreHz: F + s.offset * 2,
								at: T0 + i * 1_500,
								obwHz: s.wide ? 9_000 : 4_000,
								peakDbfs: (s.loud ? -10 : -45) + s.jitterDb,
								snrDb: s.loud ? 45 : 20,
								overload: s.overload && s.loud,
							}),
						)
						if (s.rekey) store.rekey("src-1", 0)
					})
					store.rekey("src-1", 0)
					const snap = store.snapshot()
					const byId = new Map(snap.discoveries.map(d => [d.id, d]))
					for (const d of snap.discoveries) {
						expect(d.coChannel.length).toBeLessThanOrEqual(DQ_CO_CHANNEL_MAX)
						expect(new Set(d.coChannel).size).toBe(d.coChannel.length)
						for (const id of d.coChannel) {
							const p = byId.get(id)
							expect(p).toBeDefined()
							expect(p?.coChannel).toContain(d.id)
							const dist = Math.abs(centreOf(p as Discovery) - centreOf(d))
							expect(dist).toBeLessThanOrEqual(
								gridToleranceHz(d.bandwidthHz) + 1,
							)
						}
					}
					expectReplayEqual(store, entries)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: detection-quality, Property 8: Ambient best is stable
	// Validates: Requirements 3.1, 3.3, 3.5
	it("a refused or overload-flagged observation never changes an ambient record's best", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 12 }),
				fc.array(
					fc.record({
						offset: fc.integer({ min: -900, max: 900 }),
						kind: fc.constantFrom("refused", "overload"),
						louderDb: fc.integer({ min: 20, max: 40 }),
						ratio: fc.double({ min: 1.5, max: 3, noNaN: true }),
						snrDb: fc.integer({ min: 5, max: 60 }),
					}),
					{ minLength: 1, maxLength: 10 },
				),
				(history, probes) => {
					const { store } = newStore()
					const amb = ambient(store, history)
					const before = structuredClone(store.get(amb)?.signal.best)
					probes.forEach((p, i) => {
						const refused = p.kind === "refused"
						store.ingest(
							obs({
								id: `p${i}`,
								centreHz: F + p.offset,
								at: T0 + 100 * 60_000 + i * 2_000,
								obwHz: refused ? Math.round(4_000 * p.ratio) : 3_500,
								peakDbfs: refused ? -23 + p.louderDb : -26,
								snrDb: p.snrDb,
								overload: !refused,
							}),
						)
					})
					expect(store.get(amb)?.signal.best).toEqual(before)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: detection-quality, Property 9: No incompatible merge
	// Validates: Requirements 3.1, 3.2, 3.5
	it("no observation joins, and no settle merges, a record its medians refuse", () => {
		fc.assert(
			fc.property(
				fc.array(levelObs, { minLength: 1, maxLength: 40 }),
				steps => {
					const { store } = newStore()
					// Every merge is judged when it happens, on the survivor that absorbs: the
					// survivor's and the absorbed record's observations at that moment must not be
					// incompatible (the store re-checks each absorb against the survivor's medians
					// as earlier members already moved them).
					type Absorb = (
						op: unknown,
						keep: Discovery,
						drop: Discovery,
						planned?: boolean,
					) => void
					const hooked = store as unknown as { absorb: Absorb }
					const absorb = hooked.absorb.bind(store)
					let judged: {
						keep: string
						drop: string
						verdict: boolean | null
					}[] = []
					hooked.absorb = (op, keep, drop, planned) => {
						const samples = oracleSamples(store.snapshot())
						const a = samples.get(keep.id) ?? []
						const b = samples.get(drop.id) ?? []
						const verdict =
							a.length > 0 && b.length > 0
								? recordsCompatible(recordOf(a), recordOf(b))
								: null
						absorb(op, keep, drop, planned)
						expect(planned ?? false).toBe(false)
						const gone = !store
							.snapshot()
							.discoveries.some(d => d.id === drop.id)
						if (gone) judged.push({ keep: keep.id, drop: drop.id, verdict })
					}
					steps.forEach((s, i) => {
						judged = []
						const pre = oracleSamples(store.snapshot())
						const before = new Set(store.snapshot().discoveries.map(d => d.id))
						const merges: [string, string[]][] = []
						const onChange = (
							id: string,
							change: string,
							absorbed: string[],
						): void => {
							if (change === "merged") merges.push([id, absorbed])
						}
						store.on("change", onChange)
						const input = obs({
							id: `z${i}`,
							centreHz: F + s.offset,
							at: T0 + i * 1_500,
							obwHz: s.wide ? 9_000 : 4_000,
							peakDbfs: (s.loud ? -10 : -45) + s.jitterDb,
							snrDb: s.loud ? 45 : 20,
							overload: s.overload && s.loud,
						})
						const r = store.ingest(input)
						if (s.rekey) store.rekey("src-1", 0)
						store.off("change", onChange)
						const self: CompatibilitySide = {
							peakDbfs: input.track.peakDbfs,
							obwHz: input.track.obwHz,
							count: Number.POSITIVE_INFINITY,
						}
						if (
							r.discoveryId !== null &&
							before.has(r.discoveryId) &&
							merges.length === 0
						) {
							const rec = pre.get(r.discoveryId)
							if (rec !== undefined)
								expect(compatible(recordOf(rec).medians, self)).not.toBe(false)
						}
						// The merge events name the actual survivor; each absorbed id was absorbed by
						// it (directly or through a member it absorbed in the same operation), and no
						// absorb merged a pair its observations refuse.
						for (const j of judged)
							expect(j.verdict, JSON.stringify(j)).not.toBe(false)
						const parent = new Map(judged.map(j => [j.drop, j.keep]))
						const rootOf = (id: string): string => {
							let at = id
							for (let n = 0; n < 64 && parent.has(at); n++)
								at = parent.get(at) ?? at
							return at
						}
						const reported = merges.flatMap(([keep, absorbed]) =>
							absorbed.map(dropId => [keep, dropId] as const),
						)
						for (const [keep, dropId] of reported) {
							expect(parent.has(dropId), dropId).toBe(true)
							expect(rootOf(dropId)).toBe(keep)
						}
						expect(reported.length).toBe(judged.length)
					})
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: detection-quality, Property 10: Majority class
	// Validates: Requirements 3.4
	it("class is the majority of the last 64 voting observations, ties to the most recent", () => {
		const classes: ScannerClass[] = [
			"analog-fm",
			"fsk4-12k5",
			"carrier",
			"unknown",
		]
		fc.assert(
			fc.property(
				fc.array(
					fc.record({ cls: fc.constantFrom(...classes), edge: fc.boolean() }),
					{ minLength: 1, maxLength: 90 },
				),
				steps => {
					const { store } = newStore()
					let id = ""
					let expected: ScannerClass | undefined
					steps.forEach((s, i) => {
						const r = store.ingest(
							obs({
								id: `k${i}`,
								centreHz: F,
								at: T0 + i * 1_000,
								cls: s.cls,
								edge: s.edge,
							}),
						)
						if (i === 0) {
							id = r.discoveryId ?? ""
							expected = s.edge ? "unknown" : s.cls
						}
						const window = steps.slice(Math.max(0, i + 1 - 64), i + 1)
						const tally = new Map<ScannerClass, { n: number; last: number }>()
						window.forEach((w, j) => {
							if (w.edge || w.cls === "unknown") return
							const t = tally.get(w.cls) ?? { n: 0, last: -1 }
							tally.set(w.cls, { n: t.n + 1, last: j })
						})
						let best: { cls: ScannerClass; n: number; last: number } | undefined
						for (const [cls, t] of tally)
							if (
								best === undefined ||
								t.n > best.n ||
								(t.n === best.n && t.last > best.last)
							)
								best = { cls, ...t }
						if (best !== undefined) expected = best.cls
						expect(store.get(id)?.class).toBe(expected)
					})
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: detection-quality, Property 9: No incompatible merge
	// Validates: Requirements 3.1, 3.5
	it("compatible is false iff both 3.1 conditions hold on finite inputs with history of 3 or more", () => {
		const num = fc.oneof(
			fc.double({ min: -120, max: 20, noNaN: true }),
			fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
		)
		const side = fc.record({
			peakDbfs: num,
			obwHz: fc.oneof(
				fc.double({ min: 100, max: 50_000, noNaN: true }),
				fc.constant(Number.NaN),
			),
			count: fc.oneof(
				fc.integer({ min: 0, max: 64 }),
				fc.constant(Number.POSITIVE_INFINITY),
			),
		})
		fc.assert(
			fc.property(side, side, (a, b) => {
				const finite =
					Number.isFinite(a.peakDbfs) &&
					Number.isFinite(b.peakDbfs) &&
					Number.isFinite(a.obwHz) &&
					Number.isFinite(b.obwHz)
				const history = a.count >= 3 && b.count >= 3
				const got = compatible(a, b)
				if (!finite || !history) {
					expect(got).toBeNull()
					return
				}
				const both =
					Math.abs(a.peakDbfs - b.peakDbfs) >= 20 &&
					Math.max(a.obwHz, b.obwHz) >= 1.5 * Math.min(a.obwHz, b.obwHz)
				expect(got).toBe(!both)
				expect(compatible(b, a)).toBe(got)
			}),
			{ numRuns: 200 },
		)
	})
})
