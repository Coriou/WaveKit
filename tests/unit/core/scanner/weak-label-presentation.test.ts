import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import { familyOf } from "../../../../src/core/scanner/classify/classifier.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Discovery,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const ISM_HZ = 433_920_000
const EU_RANGES = bandplansFor("EU").flatMap(p => p.ranges)

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 50,
		now: () => T0,
		newId: counterIds(),
		hintScope: () => ({ region: "EU", ranges: EU_RANGES }),
	})
}

function ookBurst(id: string, at: number) {
	return makeObs({
		id,
		centreHz: ISM_HZ,
		startedAt: at,
		obwHz: 12_000,
		blocks: 2,
		burst: true,
		cls: "ook-burst",
		hypotheses: [["ism", 0.6]],
		gate: "passed",
	})
}

/** A store restored with one weak record whose stored label is the given guess. */
function restoredWith(guess: {
	protocol: ScannerProtocol
	confidence: ScannerConfidence
}): { store: DiscoveryStore; id: string; stored: Discovery } {
	const seed = newStore()
	const id = seed.ingest(ookBurst("o1", T0)).discoveryId ?? ""
	const snap = seed.snapshot()
	const saved = snap.discoveries.find(d => d.id === id)
	if (saved === undefined) throw new Error("seed record missing")
	saved.protocol = guess.protocol
	saved.family = familyOf(guess.protocol)
	saved.confidence = guess.confidence
	const raw = JSON.parse(JSON.stringify(snap)) as typeof snap
	const store = newStore()
	store.restore(raw)
	return { store, id, stored: structuredClone(saved) }
}

function storedOf(store: DiscoveryStore, id: string): Discovery | undefined {
	return store.snapshot().discoveries.find(d => d.id === id)
}

describe("weak records publish unknown/activity", () => {
	it("a stored dmr/candidate weak record reads as unknown on get, list, near and identityOf", () => {
		const { store, id, stored } = restoredWith({
			protocol: "dmr",
			confidence: "candidate",
		})
		const got = store.get(id)
		expect(got?.protocol).toBe("unknown")
		expect(got?.family).toBe("unknown")
		expect(got?.confidence).toBe("activity")
		expect(got?.evidenceLevel).toBe("weak")
		const listed = store.list({}).items.find(d => d.id === id)
		expect(listed?.protocol).toBe("unknown")
		expect(listed?.confidence).toBe("activity")
		expect(store.list({ protocol: "dmr" }).items).toEqual([])
		expect(store.list({ minConfidence: "candidate" }).items).toEqual([])
		expect(store.near(ISM_HZ, 1000)[0]?.protocol).toBe("unknown")
		expect(store.identityOf(id)).toEqual({
			id,
			protocol: "unknown",
			confidence: "activity",
		})
		expect(storedOf(store, id)).toEqual(stored)
	})

	it("a new observation merging in keeps it unknown, adds the ISM hint and leaves the stored guess", () => {
		const { store, id } = restoredWith({
			protocol: "dmr",
			confidence: "candidate",
		})
		const events: Discovery[] = []
		store.on("change", (changed: string) => {
			const d = store.get(changed)
			if (d !== undefined) events.push(d)
		})
		const r = store.ingest(ookBurst("o2", T0 + 5_000))
		expect(r.discoveryId).toBe(id)
		expect(events.length).toBeGreaterThan(0)
		for (const e of events) {
			expect(e.protocol).toBe("unknown")
			expect(e.confidence).toBe("activity")
			expect(e.hint).toBe("ism-device")
		}
		expect(store.get(id)?.hint).toBe("ism-device")
		expect(storedOf(store, id)?.protocol).toBe("dmr")
		expect(storedOf(store, id)?.confidence).toBe("candidate")
		expect(storedOf(store, id)).not.toHaveProperty("hint")
	})

	it("observation views carry no protocol", () => {
		const { store, id } = restoredWith({
			protocol: "dmr",
			confidence: "classified",
		})
		store.ingest(ookBurst("o2", T0 + 5_000))
		const items = store.observations(id, null, 10).items
		expect(items.length).toBeGreaterThan(0)
		for (const o of items) {
			expect(o).not.toHaveProperty("protocol")
			expect(o).not.toHaveProperty("confidence")
			expect(o.hypotheses.map(h => h.protocol)).not.toContain("dmr")
		}
	})

	it("a decoded proof decides the label and drops the hint", () => {
		const { store, id } = restoredWith({
			protocol: "analog-fm",
			confidence: "candidate",
		})
		store.ingest(
			makeObs({
				id: "o3",
				centreHz: ISM_HZ,
				startedAt: T0 + 9_000,
				obwHz: 9000,
				blocks: 8,
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.6]],
				gate: "passed",
				open: true,
			}),
		)
		const target = store.discoveryIdOf("o3") ?? ""
		const ev = evidence("dmr", T0 + 9_100, {
			identity: { kind: "dmr-cc", value: "1" },
		})
		// The scanner's order: the observation's decode first, then the discovery's ladder.
		expect(store.appendObservationEvidence("o3", ev)).toBe(true)
		store.applyEvidence(target, ev)
		const d = store.get(target)
		expect(d?.evidenceLevel).toBe("proven")
		expect(d?.protocol).toBe("dmr")
		expect(d).not.toHaveProperty("hint")
		expect(target).toBe(id)
		expect(d?.confidence).toBe("decoded")
	})

	it("no hint without a hint scope", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 5,
			now: () => T0,
			newId: counterIds(),
		})
		const id = store.ingest(ookBurst("o1", T0)).discoveryId ?? ""
		expect(store.get(id)?.protocol).toBe("unknown")
		expect(store.get(id)).not.toHaveProperty("hint")
	})
})

describe("weak label property", () => {
	const PROTOCOLS: ScannerProtocol[] = [
		"analog-fm",
		"dmr",
		"ysf",
		"p25p1",
		"nxdn48",
		"dstar",
		"pocsag",
		"aprs",
		"ism",
		"lora",
		"carrier",
		"digital-unknown",
		"unknown",
	]
	const CONFIDENCES: ScannerConfidence[] = [
		"activity",
		"candidate",
		"classified",
		"decoded",
	]

	// Feature: scanner-redesign, Property 17: Weak records publish no guess
	// Validates: Requirements 3.10, 3.11
	it("every published view of a proof-less record is unknown/activity and the stored record is untouched", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...PROTOCOLS),
				fc.constantFrom(...CONFIDENCES),
				fc.boolean(),
				(protocol, confidence, merge) => {
					const { store, id } = restoredWith({ protocol, confidence })
					const events: Discovery[] = []
					store.on("change", (changed: string) => {
						const d = store.get(changed)
						if (d !== undefined) events.push(d)
					})
					if (merge) store.ingest(ookBurst("o2", T0 + 5_000))
					const before = storedOf(store, id)
					const views = [
						store.get(id),
						...store.list({}).items,
						...store.near(ISM_HZ, 50_000),
						...events,
					]
					for (const v of views) {
						expect(v?.protocol).toBe("unknown")
						expect(v?.family).toBe("unknown")
						expect(v?.confidence).toBe("activity")
					}
					expect(store.identityOf(id)?.protocol).toBe("unknown")
					for (const o of store.observations(id, null, 50).items)
						expect(o).not.toHaveProperty("protocol")
					expect(storedOf(store, id)).toEqual(before)
					expect(before?.protocol).toBe(protocol)
					expect(before?.confidence).toBe(confidence)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("hint inputs across restore", () => {
	const voice = (id: string, at: number, blocks: number) =>
		makeObs({
			id,
			centreHz: 434_450_000,
			startedAt: at,
			obwHz: 12_000,
			blocks,
			cls: "analog-fm",
			hypotheses: [["analog-fm", 0.6]],
			gate: "passed",
		})

	it("a restored long analog-fm record on the LPD raster keeps the analog-voice hint", () => {
		const store = newStore()
		const id = store.ingest(voice("o1", T0, 8)).discoveryId ?? ""
		expect(store.get(id)?.hint).toBe("analog-voice")
		const replica = newStore()
		replica.restore(JSON.parse(JSON.stringify(store.snapshot())))
		expect(replica.get(id)?.hint).toBe("analog-voice")
		for (const o of replica.observations(id, null, 10).items)
			expect(o).not.toHaveProperty("short")
	})

	it("restore replaces the short input with the restored observations", () => {
		const long = newStore()
		const id = long.ingest(voice("o1", T0, 8)).discoveryId ?? ""
		const snap = JSON.parse(JSON.stringify(long.snapshot())) as ReturnType<
			DiscoveryStore["snapshot"]
		>
		const store = newStore()
		expect(store.ingest(voice("o1", T0, 2)).discoveryId).toBe(id)
		expect(store.get(id)?.hint).toBe("ism-device")
		store.restore(snap)
		expect(store.get(id)?.hint).toBe("analog-voice")
	})

	it("a record whose observations predate the short input has no hint", () => {
		const store = newStore()
		const id = store.ingest(voice("o1", T0, 8)).discoveryId ?? ""
		const snap = JSON.parse(JSON.stringify(store.snapshot())) as ReturnType<
			DiscoveryStore["snapshot"]
		>
		for (const o of snap.observations) delete (o as { short?: boolean }).short
		const replica = newStore()
		replica.restore(snap)
		expect(replica.get(id)?.protocol).toBe("unknown")
		expect(replica.get(id)).not.toHaveProperty("hint")
	})
})
