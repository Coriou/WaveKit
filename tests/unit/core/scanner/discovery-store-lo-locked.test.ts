import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { StoreObservationInput } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { ScannerClass } from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

// Quiet-band quality, synthetic frequencies only: a receiver spur at a fixed offset from the tuned
// centre, and a steady carrier whose squelch-open audio read as "heard".

const C1 = 400_000_000
const C2 = C1 + 200_000
const SPUR = -250_000
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)

function setup() {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
	})
	return { clock, store }
}

function sighting(
	id: string,
	tunedHz: number | undefined,
	rfHz: number,
	at: number,
	over: { cls?: ScannerClass; obwHz?: number } = {},
): StoreObservationInput {
	const o: StoreObservationInput = makeObs({
		id,
		centreHz: rfHz,
		startedAt: at,
		snrDb: 25,
		blocks: 40,
		obwHz: over.obwHz ?? 1_000,
		gate: "passed",
		cls: over.cls ?? "carrier",
		hypotheses: [["carrier", 0.8]],
	})
	o.track.channelSnrDb = 25
	if (tunedHz !== undefined) o.tunedCentreHz = tunedHz
	return o
}

const live = (store: DiscoveryStore) =>
	store.snapshot().discoveries.map(d => d.frequencyHz)

describe("LO-locked spurs in admission", () => {
	it("a spur at one offset from two centres: the second is refused, the first retired, and it stays out", () => {
		const { clock, store } = setup()
		const first = store.ingest(sighting("s1", C1, C1 + SPUR, T0))
		expect(first.change).toBe("created")
		expect(store.takeLoLockedRetirees()).toEqual([])
		clock.now = T0 + 10_000
		const second = store.ingest(sighting("s2", C2, C2 + SPUR, clock.now))
		expect(second).toEqual({ discoveryId: null, change: "transient" })
		expect(store.takeLoLockedRetirees()).toEqual([first.discoveryId])
		// drained once
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		// the owner deletes it; back at C1 the spur does not come back
		expect(store.delete(first.discoveryId!)).toBe(true)
		clock.now = T0 + 20_000
		expect(store.ingest(sighting("s3", C1, C1 + SPUR, clock.now)).change).toBe(
			"transient",
		)
		expect(live(store)).toEqual([])
	})

	it("a real emitter at one RF frequency seen from two centres stays one record", () => {
		const { clock, store } = setup()
		const rf = C1 + 150_000
		const a = store.ingest(sighting("r1", C1, rf, T0))
		clock.now = T0 + 10_000
		const b = store.ingest(sighting("r2", C2, rf, clock.now))
		expect(b.discoveryId).toBe(a.discoveryId)
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("a decoded record at the offset is a real emitter: the second centre's sighting is admitted", () => {
		const { clock, store } = setup()
		const a = store.ingest(
			sighting("d1", C1, C1 + SPUR, T0, { cls: "unknown" }),
		)
		const ev = evidence("pocsag", T0 + 500, {
			identity: { kind: "pocsag-capcode", value: "1234" },
		})
		store.appendObservationEvidence("d1", ev)
		store.applyEvidence(a.discoveryId!, ev)
		expect(store.get(a.discoveryId!)?.confidence).toBe("decoded")
		clock.now = T0 + 10_000
		const b = store.ingest(sighting("d2", C2, C2 + SPUR, clock.now))
		expect(b.change).toBe("created")
		expect(store.takeLoLockedRetirees()).toEqual([])
	})

	it("an operator-labelled record is never retired, and without a tuned centre nothing is LO-locked", () => {
		const { clock, store } = setup()
		const a = store.ingest(sighting("o1", C1, C1 + SPUR, T0))
		store.setOperator(a.discoveryId!, { label: "mine" })
		clock.now = T0 + 10_000
		expect(store.ingest(sighting("o2", C2, C2 + SPUR, clock.now)).change).toBe(
			"created",
		)
		expect(store.takeLoLockedRetirees()).toEqual([])
		const other = setup()
		other.store.ingest(sighting("u1", undefined, C1 + SPUR, T0))
		other.clock.now = T0 + 10_000
		expect(
			other.store.ingest(sighting("u2", undefined, C2 + SPUR, other.clock.now))
				.change,
		).toBe("created")
	})
})

const heard = (
	at: number,
	ctcssHz: number | null = null,
): ProofAnalogInput => ({
	outcome: ctcssHz === null ? "heard" : "decoded",
	mode: "nfm",
	voice: true,
	tone: { ctcssHz, dcs: null },
	transport: "live",
	at,
})

describe("a steady carrier is not FM voice", () => {
	it("a tone-less heard row on a carrier record is carrier evidence; on FM voice it stays voice", () => {
		const { store } = setup()
		const c = store.ingest(sighting("c1", C1, C1 + 50_000, T0))
		expect(store.get(c.discoveryId!)?.class).toBe("carrier")
		expect(store.recordAnalog("c1", heard(T0 + 500))).toBe(true)
		const carrier = store.get(c.discoveryId!)!
		expect(carrier.protocol).not.toBe("analog-fm")
		expect(carrier.proof?.kind).toBe("carrier-only")

		const v = store.ingest(
			sighting("v1", C1, C1 - 100_000, T0, { cls: "analog-fm", obwHz: 11_000 }),
		)
		expect(store.recordAnalog("v1", heard(T0 + 500))).toBe(true)
		expect(store.get(v.discoveryId!)?.proof?.kind).toBe("analog-voice")
		expect(store.get(v.discoveryId!)?.protocol).toBe("analog-fm")
	})

	it("a CTCSS tone on a carrier-measuring record is still a tone proof", () => {
		const { store } = setup()
		const c = store.ingest(sighting("t1", C1, C1 + 50_000, T0))
		expect(store.recordAnalog("t1", heard(T0 + 500, 88.5))).toBe(true)
		expect(store.get(c.discoveryId!)?.proof?.kind).toBe("analog-tone")
	})
})
