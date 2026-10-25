/**
 * Detection quality section 9 and scanner-redesign 3.10/3.11 together: a weak record's stored
 * guess neither keeps it apart in association (DQ 9.1, association family unknown) nor reaches
 * its published view (unknown/activity plus a display hint). A decoded record keeps its family
 * for association, still splits from a decode of another protocol (DQ 9.5) and never carries a
 * hint.
 */
import { describe, expect, it } from "vitest"
import { bandplansFor } from "../../../../src/core/scanner/bandplan/index.js"
import { familyOf } from "../../../../src/core/scanner/classify/classifier.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Identity,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0)
const ISM_HZ = 433_920_000
const EU_RANGES = bandplansFor("EU").flatMap(p => p.ranges)

/** `skip` ids are burnt so a restored store never reissues a restored record's id. */
function newStore(skip = 0): DiscoveryStore {
	const newId = counterIds()
	for (let i = 0; i < skip; i++) newId()
	return new DiscoveryStore({
		maxDiscoveries: 50,
		now: () => T0,
		newId,
		hintScope: () => ({ region: "EU", ranges: EU_RANGES }),
	})
}

function ookBurst(id: string, at: number, centreHz = ISM_HZ) {
	return makeObs({
		id,
		centreHz,
		startedAt: at,
		obwHz: 12_000,
		blocks: 2,
		burst: true,
		cls: "ook-burst",
		hypotheses: [["ism", 0.6]],
		gate: "passed",
	})
}

/** An evidence-less sighting of no class. */
function sighting(id: string, centreHz: number, at: number) {
	return makeObs({
		id,
		centreHz,
		startedAt: at,
		obwHz: 12_000,
		blocks: 2,
		burst: true,
		cls: "unknown",
		gate: "passed",
	})
}

/** A store restored with one weak record whose stored label is the given guess. */
function restoredWith(
	protocol: ScannerProtocol,
	confidence: ScannerConfidence,
	identity?: Identity,
	centreHz = ISM_HZ,
): { store: DiscoveryStore; id: string } {
	const seed = newStore()
	const id = seed.ingest(ookBurst("o1", T0, centreHz)).discoveryId ?? ""
	const snap = seed.snapshot()
	const saved = snap.discoveries.find(d => d.id === id)
	if (saved === undefined) throw new Error("seed record missing")
	saved.protocol = protocol
	saved.family = familyOf(protocol)
	saved.confidence = confidence
	if (identity !== undefined) saved.identity = identity
	const store = newStore(snap.discoveries.length)
	store.restore(JSON.parse(JSON.stringify(snap)) as typeof snap)
	return { store, id }
}

describe("weak hints and association families together", () => {
	for (const [protocol, confidence] of [
		["dmr", "candidate"],
		["analog-fm", "classified"],
		["lora", "candidate"],
	] as const)
		it(`a weak ${protocol} ${confidence} guess associates as unknown and publishes unknown with the hint`, () => {
			const { store, id } = restoredWith(protocol, confidence)
			// An evidence-less sighting of another class, off the record's centre: it reaches the
			// record by the same-family (unknown) route, not the band-gated cross-family one.
			const r = store.ingest(sighting("o2", ISM_HZ + 1_500, T0 + 5_000))
			expect(r.discoveryId).toBe(id)
			expect(store.snapshot().discoveries).toHaveLength(1)
			const d = store.get(id)
			expect(d?.evidenceLevel).toBe("weak")
			expect(d?.protocol).toBe("unknown")
			expect(d?.family).toBe("unknown")
			expect(d?.confidence).toBe("activity")
			expect(d?.hint).toBe("ism-device")
			expect(store.list({ protocol }).items).toEqual([])
		})

	it("a weak record with an identity keeps its family apart yet publishes unknown with the hint", () => {
		// Both on one 2 kHz grid key but 1 800 Hz apart: beyond the 1 000 Hz cross-family route,
		// so only a shared association family could merge them.
		const { store, id } = restoredWith(
			"dmr",
			"candidate",
			dmrCc(1),
			ISM_HZ - 900,
		)
		const r = store.ingest(sighting("o2", ISM_HZ + 900, T0 + 5_000))
		expect(r.discoveryId).toBeDefined()
		expect(r.discoveryId).not.toBe(id)
		const d = store.get(id)
		expect(d?.protocol).toBe("unknown")
		expect(d?.confidence).toBe("activity")
		expect(d?.hint).toBe("ism-device")
	})

	it("a decoded record has no hint and splits from a decode of another protocol", () => {
		const store = newStore()
		const first = makeObs({
			id: "d1",
			centreHz: ISM_HZ,
			startedAt: T0,
			obwHz: 9_000,
			blocks: 8,
			cls: "fsk4-12k5",
			hypotheses: [["dmr", 0.6]],
			gate: "passed",
		})
		const dmrId = store.ingest(first).discoveryId ?? ""
		const dmr = evidence("dmr", T0 + 100, { identity: dmrCc(1) })
		expect(store.appendObservationEvidence("d1", dmr)).toBe(true)
		store.applyEvidence(dmrId, dmr)
		const decoded = store.get(dmrId)
		expect(decoded?.evidenceLevel).toBe("proven")
		expect(decoded?.protocol).toBe("dmr")
		expect(decoded?.confidence).toBe("decoded")
		expect(decoded).not.toHaveProperty("hint")

		const ysf = evidence("ysf", T0 + 5_100)
		const r = store.ingest(
			makeObs({
				id: "d2",
				centreHz: ISM_HZ + 200,
				startedAt: T0 + 5_000,
				obwHz: 9_000,
				blocks: 8,
				cls: "fsk4-12k5",
				hypotheses: [["ysf", 0.6]],
				gate: "passed",
			}),
			{ decode: ysf },
		)
		expect(r.discoveryId).toBeDefined()
		expect(r.discoveryId).not.toBe(dmrId)
		const after = store.get(dmrId)
		expect(after?.protocol).toBe("dmr")
		expect(after?.confidence).toBe("decoded")
		expect(after).not.toHaveProperty("hint")
		expect(store.discoveryIdOf("d1")).toBe(dmrId)
	})
})
