import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { JournalEntry } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	ProofAnalogInput,
	ProofTrialInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import type {
	Identity,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const PMR: Raster[] = [{ spacingHz: 12_500, firstChannelHz: CH }]
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

function newStore(): { store: DiscoveryStore; entries: JournalEntry[] } {
	const entries: JournalEntry[] = []
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => T0,
		newId: counterIds(),
		rasters: () => PMR,
	})
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	return { store, entries }
}

function tone(at = T0): ProofAnalogInput {
	return {
		outcome: "decoded",
		mode: "nfm",
		voice: true,
		tone: { ctcssHz: 88.5, dcs: null },
		transport: "live",
		at,
	}
}

function dataLike(at = T0): ProofAnalogInput {
	return {
		outcome: "data-like",
		mode: "nfm",
		voice: false,
		tone: { ctcssHz: null, dcs: null },
		transport: "live",
		at,
	}
}

function trial(at: number): ProofTrialInput {
	return {
		protocol: "dmr",
		decoder: "dsd-fme",
		outcome: "no-sync",
		order: 1,
		at,
	}
}

interface LinkedPair {
	analogId: string
	dmrId: string
}

/** The analog card and the DMR card after a split, linked both ways. */
function expectLinked(
	store: DiscoveryStore,
	analogObs: string,
	dmrObs: string,
): LinkedPair {
	const analogId = store.discoveryIdOf(analogObs) ?? ""
	const dmrId = store.discoveryIdOf(dmrObs) ?? ""
	expect(analogId).not.toBe("")
	expect(dmrId).not.toBe("")
	expect(analogId).not.toBe(dmrId)
	expect(store.snapshot().discoveries).toHaveLength(2)

	const analog = store.get(analogId)
	expect(analog?.protocol).toBe("analog-fm")
	expect(analog?.family).toBe("analog")
	expect(analog?.confidence).toBe("classified")
	expect(analog?.evidenceLevel).toBe("proven")
	expect(analog?.proof?.kind).toBe("analog-tone")
	expect(analog?.proof?.summary).toBe("Analog FM voice, CTCSS 88.5")
	expect(analog?.identity).toBeUndefined()
	expect(analog?.coChannel).toEqual([dmrId])

	const dmr = store.get(dmrId)
	expect(dmr?.protocol).toBe("dmr")
	expect(dmr?.family).toBe("digital-voice")
	expect(dmr?.confidence).toBe("decoded")
	expect(dmr?.evidenceLevel).toBe("proven")
	expect(dmr?.proof?.kind).toBe("decoded")
	expect(dmr?.proof?.summary).toBe("DMR decoded (CC1)")
	expect(dmr?.identity).toEqual(dmrCc(1))
	expect(dmr?.coChannel).toEqual([analogId])

	const analogSnap = store.snapshot().discoveries.find(d => d.id === analogId)
	expect(analogSnap?.protocol).toBe("unknown")
	expect(analogSnap?.family).toBe("unknown")
	expect(analogSnap?.confidence).toBe("activity")
	expect(analogSnap?.proof).toBeUndefined()
	const dmrSnap = store.snapshot().discoveries.find(d => d.id === dmrId)
	expect(dmrSnap?.protocol).toBe("dmr")
	expect(dmrSnap?.family).toBe("digital-voice")
	expect(dmrSnap?.confidence).toBe("decoded")
	expect(dmrSnap?.proof).toBeUndefined()
	return { analogId, dmrId }
}

describe("effective family association", () => {
	it("splits a CTCSS proof and a nearby DMR decode into linked discoveries", () => {
		const { store, entries } = newStore()
		const analogId =
			store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
				.discoveryId ?? ""
		expect(store.recordAnalog("a", tone())).toBe(true)
		expect(store.get(analogId)?.proof?.summary).toBe(
			"Analog FM voice, CTCSS 88.5",
		)
		const joined = store.ingest(
			makeObs({ id: "b", centreHz: CH + 200, startedAt: T0 + 1_000 }),
		)
		expect(joined.discoveryId).toBe(analogId)
		expect(joined.change).not.toBe("created")
		const decoded = evidence("dmr", T0 + 1_001, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("b", decoded)).toBe(true)
		const before = entries.length
		expect(store.applyEvidence(analogId, decoded)).toBe("created")
		const added = entries.slice(before)
		expect(added.map(entry => entry.op)).toEqual(["evidence"])
		expect(JSON.stringify(added[0]?.payload)).not.toContain("88.5")

		const pair = expectLinked(store, "a", "b")
		expect(pair.analogId).toBe(analogId)
		const payload = added[0]?.payload as {
			discoveries?: { id: string; coChannel: string[] }[]
			observations?: { id: string; discoveryId: string }[]
		}
		const analogRow = payload.discoveries?.find(d => d.id === pair.analogId)
		const dmrRow = payload.discoveries?.find(d => d.id === pair.dmrId)
		expect(analogRow?.coChannel).toEqual([pair.dmrId])
		expect(dmrRow?.coChannel).toEqual([pair.analogId])
		expect(payload.observations?.find(o => o.id === "b")?.discoveryId).toBe(
			pair.dmrId,
		)
	})

	it("does not merge a digital-undecoded neighbour into an analog tone proof on rekey", () => {
		const { store } = newStore()
		const a =
			store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
				.discoveryId ?? ""
		const b =
			store.ingest(
				makeObs({ id: "b", centreHz: CH + 3_500, startedAt: T0 + 1_000 }),
			).discoveryId ?? ""
		expect(a).not.toBe(b)
		expect(store.recordAnalog("a", tone())).toBe(true)
		expect(store.recordAnalog("b", dataLike(T0 + 1_000))).toBe(true)
		expect(store.recordTrial("b", trial(T0 + 1_001))).toBe(true)
		expect(store.get(b)?.proof?.kind).toBe("digital-undecoded")
		expect(store.rekey("src-1", 3_000)).toEqual({ merged: [] })
		expect(
			store
				.snapshot()
				.discoveries.map(d => d.id)
				.sort(),
		).toEqual([a, b].sort())
		expect(store.discoveryIdOf("a")).toBe(a)
		expect(store.discoveryIdOf("b")).toBe(b)
		expect(store.get(a)?.protocol).toBe("analog-fm")
		expect(store.get(a)?.family).toBe("analog")
		expect(store.get(a)?.proof?.summary).toBe("Analog FM voice, CTCSS 88.5")
		expect(store.get(b)?.protocol).toBe("digital-unknown")
		expect(store.get(b)?.family).toBe("unknown")
		expect(store.get(b)?.proof?.kind).toBe("digital-undecoded")
		expect(store.get(b)?.confidence).toBe("candidate")
	})

	it("splits a later DMR decode on the same channel and keeps the analog card", () => {
		const { store } = newStore()
		const analogId =
			store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
				.discoveryId ?? ""
		expect(store.recordAnalog("a", tone())).toBe(true)
		const joined = store.ingest(
			makeObs({ id: "b", centreHz: CH, startedAt: T0 + 1_000 }),
		)
		expect(joined.discoveryId).toBe(analogId)
		const decoded = evidence("dmr", T0 + 1_001, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("b", decoded)).toBe(true)
		expect(store.applyEvidence(analogId, decoded)).toBe("created")
		const pair = expectLinked(store, "a", "b")
		expect(pair.analogId).toBe(analogId)
		expect(store.get(analogId)?.protocol).toBe("analog-fm")
		expect(store.get(analogId)?.proof?.summary).toBe(
			"Analog FM voice, CTCSS 88.5",
		)
	})

	it("sticky-matches evidence-less observations onto a decoded discovery across a key edge", () => {
		const { store } = newStore()
		const id =
			store.ingest(makeObs({ id: "a", centreHz: CH + 3_000, startedAt: T0 }))
				.discoveryId ?? ""
		const decoded = evidence("dmr", T0 + 1, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("a", decoded)).toBe(true)
		expect(store.applyEvidence(id, decoded)).toBe("upgraded")
		expect(store.get(id)?.protocol).toBe("dmr")
		expect(store.get(id)?.confidence).toBe("decoded")
		expect(store.get(id)?.frequencyKey).toBe(`r:${CH}`)

		const same = store.ingest(
			makeObs({ id: "b", centreHz: CH + 3_000, startedAt: T0 + 1_000 }),
		)
		expect(same.change).not.toBe("created")
		expect(same.discoveryId).toBe(id)

		const edge = store.ingest(
			makeObs({ id: "c", centreHz: CH + 6_000, startedAt: T0 + 2_000 }),
		)
		expect(edge.change).not.toBe("created")
		expect(edge.discoveryId).toBe(id)
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.get(id)?.frequencyKey).toBe(`r:${CH}`)

		expect(store.rekey("src-1", 3_000)).toEqual({ merged: [] })
		expect(store.snapshot().discoveries).toHaveLength(1)
		expect(store.discoveryIdOf("a")).toBe(id)
		expect(store.discoveryIdOf("b")).toBe(id)
		expect(store.discoveryIdOf("c")).toBe(id)
		expect(store.get(id)?.protocol).toBe("dmr")
		expect(store.get(id)?.confidence).toBe("decoded")
		expect(store.get(id)?.proof?.summary).toBe("DMR decoded (CC1)")

		const again = store.ingest(
			makeObs({ id: "d", centreHz: CH + 6_000, startedAt: T0 + 3_000 }),
		)
		expect(again.change).not.toBe("created")
		expect(again.discoveryId).toBe(id)
		expect(store.snapshot().discoveries).toHaveLength(1)
	})

	// Feature: scanner-redesign, Property: analog and digital proofs stay apart
	// Validates: Requirements 3.1, 3.5
	it("never leaves an analog proof and a digital decode on one discovery", () => {
		const offsets = [0, 200, 1_500, 2_800, 3_500, 6_000]
		const digitals: {
			protocol: ScannerProtocol
			identity: (n: number) => Identity
		}[] = [
			{ protocol: "dmr", identity: n => dmrCc((n % 15) + 1) },
			{
				protocol: "p25p1",
				identity: n => ({
					kind: "p25-nac",
					value: n.toString(16).toUpperCase().padStart(2, "0"),
				}),
			},
			{
				protocol: "pocsag",
				identity: n => ({
					kind: "pocsag-capcode",
					value: String(1_000 + n),
				}),
			},
		]
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						offset: fc.constantFrom(...offsets),
						digital: fc.boolean(),
						which: fc.integer({ min: 0, max: digitals.length - 1 }),
						salt: fc.integer({ min: 0, max: 40 }),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				steps => {
					const { store } = newStore()
					const analog = new Set<string>()
					const digital = new Set<string>()
					steps.forEach((step, index) => {
						const obsId = `o${index}`
						const ingested = store.ingest(
							makeObs({
								id: obsId,
								centreHz: CH + step.offset,
								startedAt: T0 + index * 1_000,
							}),
						)
						if (ingested.discoveryId === null)
							throw new Error(`observation ${obsId} did not surface`)
						if (!step.digital) {
							if (!store.recordAnalog(obsId, tone(T0 + index * 1_000)))
								throw new Error(`tone was refused for ${obsId}`)
							analog.add(obsId)
							return
						}
						const kind = digitals[step.which]
						if (kind === undefined) throw new Error("missing digital kind")
						const ev = evidence(kind.protocol, T0 + index * 1_000 + 1, {
							identity: kind.identity(step.salt),
						})
						const host = store.discoveryIdOf(obsId)
						if (host === undefined) throw new Error(`no discovery for ${obsId}`)
						if (!store.appendObservationEvidence(obsId, ev))
							throw new Error(`decode was refused for ${obsId}`)
						store.applyEvidence(host, ev)
						digital.add(obsId)
					})
					const byDiscovery = new Map<string, string[]>()
					for (const obs of store.snapshot().observations) {
						const list = byDiscovery.get(obs.discoveryId) ?? []
						list.push(obs.id)
						byDiscovery.set(obs.discoveryId, list)
					}
					for (const [discoveryId, ids] of byDiscovery) {
						const hasAnalog = ids.some(id => analog.has(id))
						const hasDigital = ids.some(id => digital.has(id))
						if (hasAnalog && hasDigital)
							throw new Error(
								`${discoveryId} holds analog ${ids.filter(id => analog.has(id)).join(",")} and digital ${ids.filter(id => digital.has(id)).join(",")}`,
							)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

const DAY = 86_400_000

interface Clocked {
	store: DiscoveryStore
	entries: JournalEntry[]
	clock: { now: number }
	replica: () => DiscoveryStore
}

function clockedStore(maxDiscoveries = 100): Clocked {
	const entries: JournalEntry[] = []
	const clock = { now: T0 }
	const opts = {
		maxDiscoveries,
		now: () => clock.now,
		newId: counterIds(),
		rasters: () => PMR,
	}
	const store = new DiscoveryStore(opts)
	store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
		entries.push({ ...e, seq: entries.length + 1 }),
	)
	const replica = (): DiscoveryStore => {
		const copy = new DiscoveryStore({ ...opts, newId: counterIds() })
		for (const e of entries) copy.replay(JSON.parse(JSON.stringify(e)))
		return copy
	}
	return { store, entries, clock, replica }
}

/** Ingests `id` and applies an accepted decode to its discovery, as the service does. */
function decodeOn(
	store: DiscoveryStore,
	id: string,
	ev: ReturnType<typeof evidence>,
): ReturnType<DiscoveryStore["applyEvidence"]> {
	expect(store.appendObservationEvidence(id, ev)).toBe(true)
	const host = store.discoveryIdOf(id) ?? ""
	return store.applyEvidence(host, ev)
}

function expectReplayEqual(c: Clocked): void {
	expect(c.replica().snapshot()).toEqual(c.store.snapshot())
}

describe("observation moves between co-channel discoveries", () => {
	it("refreshes the destination sighting when a fresh observation moves onto an older twin", () => {
		const c = clockedStore()
		const { store } = c
		store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
		decodeOn(store, "a", evidence("dmr", T0 + 1, { identity: dmrCc(1) }))
		const dmrId = store.discoveryIdOf("a") ?? ""
		store.ingest(makeObs({ id: "b", centreHz: CH, startedAt: T0 + 1_000 }))
		expect(store.recordAnalog("b", tone(T0 + 1_000))).toBe(true)
		const twinId = store.discoveryIdOf("b") ?? ""
		expect(twinId).not.toBe(dmrId)
		const later = T0 + 3 * DAY
		c.clock.now = later
		store.ingest(
			makeObs({ id: "c", centreHz: CH, startedAt: later, snrDb: 30 }),
		)
		expect(store.recordAnalog("c", tone(later))).toBe(true)
		expect(store.discoveryIdOf("c")).toBe(twinId)
		const twin = store.get(twinId)
		expect(twin?.lastSeenAt).toBe(new Date(later + 1_000).toISOString())
		expect(twin?.observationCount).toBe(2)
		expect(twin?.airtimeMs).toBe(2_000)
		expect(twin?.signal.last.snrDb).toBe(30)
		expect(twin?.signal.best.snrDb).toBe(30)
		const dmr = store.get(dmrId)
		expect(dmr?.observationCount).toBe(1)
		expect(dmr?.lastSeenAt).toBe(new Date(T0 + 1_000).toISOString())
		expect(dmr?.signal.last.snrDb).toBe(20)
		expect(store.pruneInactive(1)).toEqual([dmrId])
		expect(store.get(twinId)).toBeDefined()
		expectReplayEqual(c)
	})

	it("keeps a second co-channel identity proven while evidence-less traffic fills the window", () => {
		const c = clockedStore()
		const { store } = c
		store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
		decodeOn(store, "a", evidence("dmr", T0 + 1, { identity: dmrCc(1) }))
		const cc1 = store.discoveryIdOf("a") ?? ""
		store.ingest(makeObs({ id: "b", centreHz: CH, startedAt: T0 + 1_000 }))
		decodeOn(store, "b", evidence("dmr", T0 + 1_001, { identity: dmrCc(2) }))
		const cc2 = store.discoveryIdOf("b") ?? ""
		expect(cc2).not.toBe(cc1)
		store.ingest(makeObs({ id: "r", centreHz: CH, startedAt: T0 + 2_000 }))
		decodeOn(store, "r", evidence("dmr", T0 + 2_001, { identity: dmrCc(1) }))
		for (let i = 0; i < 300; i++)
			store.ingest(
				makeObs({ id: `q${i}`, centreHz: CH, startedAt: T0 + 3_000 + i * 10 }),
			)
		for (const id of [cc1, cc2]) {
			expect(store.get(id)?.confidence).toBe("decoded")
			expect(store.get(id)?.evidenceLevel).toBe("proven")
			expect(store.get(id)?.proof?.kind).toBe("decoded")
		}
		expect(store.get(cc2)?.proof?.summary).toBe("DMR decoded (CC2)")
		expect(store.list({ evidence: "proven" }).items).toHaveLength(2)
		expectReplayEqual(c)
	})

	it("keeps a foreign decoded pin when the partner gains a weaker memory-only proof", () => {
		const c = clockedStore()
		const { store } = c
		store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
		decodeOn(store, "a", evidence("dmr", T0 + 1, { identity: dmrCc(1) }))
		const cc1 = store.discoveryIdOf("a") ?? ""
		store.ingest(makeObs({ id: "b", centreHz: CH, startedAt: T0 + 1_000 }))
		decodeOn(store, "b", evidence("dmr", T0 + 1_001, { identity: dmrCc(1) }))
		const cc2Ev = evidence("dmr", T0 + 1_002, { identity: dmrCc(2) })
		expect(store.appendObservationEvidence("b", cc2Ev)).toBe(true)
		store.applyEvidence(store.discoveryIdOf("b") ?? "", cc2Ev)
		const cc2 =
			store.list({}).items.find(d => d.identity?.value === "2" && d.id !== cc1)
				?.id ?? ""
		expect(cc2).not.toBe("")
		store.applyEvidence(
			cc2,
			evidence("dmr", T0 + 50_000, { identity: dmrCc(2) }),
		)
		store.ingest(makeObs({ id: "z", centreHz: CH, startedAt: T0 + 60_000 }))
		const zHost = store.discoveryIdOf("z")
		if (zHost === cc2) {
			store.recordTrial("z", {
				protocol: "dmr",
				decoder: "dsd-fme",
				outcome: "no-sync",
				order: store.nextTrialOrder(),
				at: T0 + 60_001,
			})
			store.recordAnalog("z", dataLike(T0 + 60_002))
		}
		store.ingest(makeObs({ id: "r", centreHz: CH, startedAt: T0 + 70_000 }))
		decodeOn(store, "r", evidence("dmr", T0 + 70_001, { identity: dmrCc(1) }))
		for (let i = 0; i < 300; i++)
			store.ingest(
				makeObs({ id: `q${i}`, centreHz: CH, startedAt: T0 + 80_000 + i * 10 }),
			)
		expect(store.get(cc2)?.confidence).toBe("decoded")
		expect(store.get(cc2)?.proof?.kind).toBe("decoded")
		expectReplayEqual(c)
	})

	it("moves a conflicting identity decode off a card onto its matching twin", () => {
		const c = clockedStore()
		const { store } = c
		store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
		decodeOn(store, "a", evidence("dmr", T0 + 1, { identity: dmrCc(1) }))
		const cc1 = store.discoveryIdOf("a") ?? ""
		store.ingest(makeObs({ id: "b", centreHz: CH, startedAt: T0 + 1_000 }))
		decodeOn(store, "b", evidence("dmr", T0 + 1_001, { identity: dmrCc(2) }))
		const cc2 = store.discoveryIdOf("b") ?? ""
		store.ingest(makeObs({ id: "r", centreHz: CH, startedAt: T0 + 2_000 }))
		decodeOn(store, "r", evidence("dmr", T0 + 2_001, { identity: dmrCc(1) }))
		// A later CC2 decode lands on an observation sticky-joined to CC1.
		store.ingest(makeObs({ id: "x", centreHz: CH, startedAt: T0 + 4_000 }))
		expect(store.discoveryIdOf("x")).toBe(cc1)
		decodeOn(store, "x", evidence("dmr", T0 + 4_001, { identity: dmrCc(2) }))
		expect(store.discoveryIdOf("x")).toBe(cc2)
		expect(store.get(cc2)?.observationCount).toBe(2)
		expect(store.get(cc2)?.lastSeenAt).toBe(new Date(T0 + 5_000).toISOString())
		expect(store.get(cc1)?.observationCount).toBe(2)
		expect(store.get(cc1)?.lastSeenAt).toBe(new Date(T0 + 3_000).toISOString())
		expectReplayEqual(c)
	})

	it("does not evict the card it splits, and keeps the decode in place when no room is left", () => {
		const c = clockedStore(1)
		const { store } = c
		const analogId =
			store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
				.discoveryId ?? ""
		expect(store.recordAnalog("a", tone())).toBe(true)
		store.ingest(
			makeObs({ id: "b", centreHz: CH + 200, startedAt: T0 + 1_000 }),
		)
		expect(store.discoveryIdOf("b")).toBe(analogId)
		const ev = evidence("dmr", T0 + 1_001, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("b", ev)).toBe(true)
		expect(store.applyEvidence(analogId, ev)).toBeNull()
		expect(store.discoveryIdOf("a")).toBe(analogId)
		expect(store.discoveryIdOf("b")).toBe(analogId)
		expect(store.get(analogId)?.observationCount).toBe(2)
		expect(
			store.snapshot().observations.find(o => o.id === "b")?.decode,
		).toEqual([ev])
		expectReplayEqual(c)
	})

	it("splits at capacity by evicting another card, never the source", () => {
		const c = clockedStore(2)
		const { store } = c
		const analogId =
			store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
				.discoveryId ?? ""
		expect(store.recordAnalog("a", tone())).toBe(true)
		store.ingest(
			makeObs({ id: "b", centreHz: CH + 200, startedAt: T0 + 1_000 }),
		)
		const other =
			store.ingest(
				makeObs({ id: "z", centreHz: CH + 1_000_000, startedAt: T0 + 2_000 }),
			).discoveryId ?? ""
		const ev = evidence("dmr", T0 + 2_001, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("b", ev)).toBe(true)
		expect(store.applyEvidence(analogId, ev)).toBe("created")
		expect(store.get(other)).toBeUndefined()
		const dmrId = store.discoveryIdOf("b") ?? ""
		expect(dmrId).not.toBe(analogId)
		expect(store.get(dmrId)?.observationCount).toBe(1)
		expect(store.get(dmrId)?.evidenceLevel).toBe("proven")
		expect(store.get(analogId)?.observationCount).toBe(1)
		expectReplayEqual(c)
	})

	it("journals a move the destination trims at once", () => {
		const c = clockedStore()
		const { store } = c
		store.ingest(makeObs({ id: "a", centreHz: CH, startedAt: T0 }))
		decodeOn(store, "a", evidence("dmr", T0 + 1, { identity: dmrCc(1) }))
		const dmrId = store.discoveryIdOf("a") ?? ""
		store.ingest(makeObs({ id: "old", centreHz: CH, startedAt: T0 + 1_000 }))
		expect(store.discoveryIdOf("old")).toBe(dmrId)
		for (let i = 0; i < 257; i++) {
			const at = T0 + 10_000 + i * 2_000
			store.ingest(makeObs({ id: `t${i}`, centreHz: CH, startedAt: at }))
			expect(store.recordAnalog(`t${i}`, tone(at))).toBe(true)
		}
		const twinId = store.discoveryIdOf("t256") ?? ""
		expect(twinId).not.toBe(dmrId)
		expect(
			store.snapshot().observations.filter(o => o.discoveryId === twinId),
		).toHaveLength(256)
		expect(store.recordAnalog("old", tone(T0 + 1_000))).toBe(true)
		expect(store.discoveryIdOf("old")).toBeUndefined()
		expect(store.get(twinId)?.observationCount).toBe(258)
		expect(store.get(dmrId)?.observationCount).toBe(1)
		expectReplayEqual(c)
	})
	function linkedPartners(partners: number): {
		c: Clocked
		mainId: string
		twins: string[]
	} {
		const c = clockedStore(200)
		const { store } = c
		store.ingest(makeObs({ id: "m", centreHz: CH, startedAt: T0 }))
		decodeOn(store, "m", evidence("dmr", T0 + 1, { identity: dmrCc(1) }))
		const mainId = store.discoveryIdOf("m") ?? ""
		const twins: string[] = []
		for (let k = 0; k < partners; k++) {
			const at = T0 + 1_000 + k * 2_000
			const id = `p${k}`
			store.ingest(makeObs({ id, centreHz: CH, startedAt: at }))
			expect(store.discoveryIdOf(id)).toBe(mainId)
			// The same observation confirms the main card and names a partner,
			// so it stays here and the partner's only proof is this row.
			decodeOn(store, id, evidence("dmr", at + 1, { identity: dmrCc(1) }))
			const before = new Set(store.snapshot().discoveries.map(d => d.id))
			decodeOn(store, id, evidence("dmr", at + 2, { identity: dmrCc(100 + k) }))
			expect(store.discoveryIdOf(id)).toBe(mainId)
			const twin = store.snapshot().discoveries.find(d => !before.has(d.id))?.id
			expect(twin).toBeDefined()
			twins.push(twin ?? "")
		}
		for (let i = 0; i < 300; i++) {
			const at = T0 + 1_000_000 + i * 2_000
			store.ingest(makeObs({ id: `q${i}`, centreHz: CH, startedAt: at }))
		}
		return { c, mainId, twins }
	}

	it("pins one proof per linked partner at the 64-link bound and keeps the window at 256", () => {
		const { c, mainId, twins } = linkedPartners(64)
		const { store } = c
		expect(store.get(mainId)?.coChannel).toHaveLength(64)
		expect(
			store.snapshot().observations.filter(o => o.discoveryId === mainId),
		).toHaveLength(256)
		for (const twin of twins)
			expect(store.get(twin)?.evidenceLevel).toBe("proven")
		expect(store.get(mainId)?.proof?.summary).toBe("DMR decoded (CC1)")
		expectReplayEqual(c)
	}, 60_000)

	it("stops pinning a partner whose link fell off one past the bound", () => {
		const { c, mainId, twins } = linkedPartners(65)
		const { store } = c
		const links = store.get(mainId)?.coChannel ?? []
		expect(links).toHaveLength(64)
		expect(links).not.toContain(twins[0])
		expect(
			store.snapshot().observations.filter(o => o.discoveryId === mainId),
		).toHaveLength(256)
		expect(store.discoveryIdOf("p0")).toBeUndefined()
		expect(store.get(twins[0] ?? "")?.evidenceLevel).toBe("weak")
		for (const twin of twins.slice(1))
			expect(store.get(twin)?.evidenceLevel).toBe("proven")
		expectReplayEqual(c)
	}, 60_000)
})

describe("journal replay across splits and trims", () => {
	// Feature: scanner-redesign, journal replay equals live state
	// Validates: Requirements 3.3, 3.5
	it("replays to the live snapshot after random splits, moves and trims", () => {
		const offsets = [0, 200, 3_500, 12_500]
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.array(
					fc.record({
						kind: fc.constantFrom("plain", "tone", "decode", "late-tone"),
						offset: fc.constantFrom(...offsets),
						cc: fc.integer({ min: 1, max: 3 }),
						pick: fc.nat(),
					}),
					{ minLength: 1, maxLength: 24 },
				),
				(capacity, steps) => {
					const c = clockedStore(capacity)
					const { store } = c
					const ids: string[] = []
					const at = (n: number): number => T0 + n * 1_500
					store.ingest(makeObs({ id: "s", centreHz: CH, startedAt: at(0) }))
					ids.push("s")
					const first = evidence("dmr", at(0) + 1, { identity: dmrCc(1) })
					if (store.appendObservationEvidence("s", first))
						store.applyEvidence(store.discoveryIdOf("s") ?? "", first)
					// Fill the decoded card close to its window so later steps trim.
					for (let i = 1; i <= 254; i++) {
						const id = `f${i}`
						store.ingest(makeObs({ id, centreHz: CH, startedAt: at(i) }))
						ids.push(id)
					}
					steps.forEach((step, index) => {
						const n = 300 + index
						const id = `o${index}`
						if (step.kind === "late-tone") {
							const target = ids[step.pick % ids.length] ?? "s"
							store.recordAnalog(target, tone(at(n)))
							return
						}
						store.ingest(
							makeObs({ id, centreHz: CH + step.offset, startedAt: at(n) }),
						)
						ids.push(id)
						if (step.kind === "tone") store.recordAnalog(id, tone(at(n)))
						if (step.kind === "decode") {
							const ev = evidence("dmr", at(n) + 1, {
								identity: dmrCc(step.cc),
							})
							const host = store.discoveryIdOf(id)
							if (host !== undefined && store.appendObservationEvidence(id, ev))
								store.applyEvidence(store.discoveryIdOf(id) ?? host, ev)
						}
					})
					const live = store.snapshot()
					const replayed = c.replica().snapshot()
					if (JSON.stringify(replayed) !== JSON.stringify(live))
						expect(replayed).toEqual(live)
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)
})
