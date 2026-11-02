import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { StoreObservationInput } from "../../../../src/core/scanner/store/discovery-store.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { ScannerClass } from "../../../../src/core/scanner/types.js"
import {
	DQ_LO_LOCK_DWELL_MS,
	DQ_LO_LOCK_TTL_MS,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

// Quiet-band quality, synthetic frequencies only: a receiver spur at a fixed offset from the tuned
// centre, and a steady carrier whose squelch-open audio read as "heard".

const RATE = 1_024_000
const C1 = 400_000_000
const C2 = C1 + 200_000
const SPUR = -150_000
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

interface Over {
	cls?: ScannerClass
	obwHz?: number
	dutyCycle?: number
	rateHz?: number
}

function sighting(
	id: string,
	tunedHz: number | undefined,
	rfHz: number,
	at: number,
	over: Over = {},
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
	if (over.dutyCycle !== undefined) o.track.dutyCycle = over.dutyCycle
	if (tunedHz !== undefined) {
		o.tunedCentreHz = tunedHz
		o.tunedSampleRateHz = over.rateHz ?? RATE
	}
	return o
}

/** Ingests one observation once a second from `clock.now` for `ms` (the service's throttle). */
function dwell(
	clock: { now: number },
	store: DiscoveryStore,
	obs: StoreObservationInput,
	ms: number,
) {
	const until = clock.now + ms
	store.ingest(obs)
	while (clock.now + 1_000 < until) {
		clock.now += 1_000
		store.ingest(obs)
	}
	// the last ingest lands exactly at the dwell's end
	clock.now = until
	return store.ingest(obs)
}

const live = (store: DiscoveryStore) =>
	store.snapshot().discoveries.map(d => d.frequencyHz)

describe("LO-locked spurs in admission", () => {
	it("a steady line at one offset from two centres, each window seeing the other position empty for a full dwell: no record, the first retired, and it stays out", () => {
		const { clock, store } = setup()
		const first = store.ingest(sighting("s1", C1, C1 + SPUR, clock.now))
		expect(first.change).toBe("created")
		dwell(clock, store, sighting("s1", C1, C1 + SPUR, T0), 10_000)
		expect(store.takeLoLockedRetirees()).toEqual([])
		clock.now += 500
		const at2 = clock.now
		// undecided until the new centre was dwelt on for the minimum: no record yet, nothing retired
		const early = store.ingest(sighting("s2", C2, C2 + SPUR, at2))
		expect(early).toEqual({ discoveryId: null, change: "transient" })
		expect(store.takeLoLockedRetirees()).toEqual([])
		clock.now = at2 + DQ_LO_LOCK_DWELL_MS - 1
		expect(store.ingest(sighting("s2", C2, C2 + SPUR, at2)).change).toBe(
			"transient",
		)
		expect(store.takeLoLockedRetirees()).toEqual([])
		clock.now = at2 + DQ_LO_LOCK_DWELL_MS
		expect(store.ingest(sighting("s2", C2, C2 + SPUR, at2))).toEqual({
			discoveryId: null,
			change: "transient",
		})
		expect(store.takeLoLockedRetirees()).toEqual([first.discoveryId])
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.loLockedSuppressed("src-1")).toBe(1)
		// the observation's close after the retune carries no tuned centre: still no record
		clock.now += 1_000
		expect(store.ingest(sighting("s2", undefined, C2 + SPUR, at2)).change).toBe(
			"transient",
		)
		expect(store.delete(first.discoveryId!)).toBe(true)
		// back at C1 the spur does not come back once the dwell there is long enough
		clock.now += 1_000
		const at3 = clock.now
		dwell(clock, store, sighting("s3", C1, C1 + SPUR, at3), DQ_LO_LOCK_DWELL_MS)
		expect(live(store)).toEqual([])
	})

	it("repro: two real emitters at one offset, the first centre's window not covering the second: both are discovered", () => {
		// 1.024 Msps: the usable window is ±409.6 kHz. A 1 kHz line 25 dB at C + 100 kHz under
		// 400 MHz, then retuned 2 MHz up a second emitter at the same offset.
		const { clock, store } = setup()
		const a = 400_000_000
		const b = 402_000_000
		const first = store.ingest(sighting("e1", a, a + 100_000, clock.now))
		dwell(clock, store, sighting("e1", a, a + 100_000, T0), 10_000)
		clock.now += 500
		const at2 = clock.now
		const second = dwell(
			clock,
			store,
			sighting("e2", b, b + 100_000, at2),
			DQ_LO_LOCK_DWELL_MS + 2_000,
		)
		expect(second.change).not.toBe("transient")
		expect(second.discoveryId).not.toBeNull()
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.get(first.discoveryId!)).toBeDefined()
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("repro: a learned offset does not hide a real narrow emitter a day later under another centre", () => {
		const { clock, store } = setup()
		const off = 100_000
		store.ingest(sighting("l1", C1, C1 + off, clock.now))
		dwell(clock, store, sighting("l1", C1, C1 + off, T0), 10_000)
		clock.now += 500
		const at2 = clock.now
		dwell(
			clock,
			store,
			sighting("l2", C2, C2 + off, at2),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(store.loLockedOffsets("src-1")).toEqual([off])
		clock.now += 24 * 3_600_000
		const c3 = 410_000_000
		const at3 = clock.now
		const gmsk = dwell(
			clock,
			store,
			sighting("g1", c3, c3 + off, at3, { cls: "gmsk-narrow", obwHz: 5_000 }),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(gmsk.change).not.toBe("transient")
		expect(gmsk.discoveryId).not.toBeNull()
		// the learned offset expired with its evidence
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("a steady line at a learned offset is discovered again once the evidence is older than the TTL", () => {
		const { clock, store } = setup()
		store.ingest(sighting("t1", C1, C1 + SPUR, clock.now))
		dwell(clock, store, sighting("t1", C1, C1 + SPUR, T0), 10_000)
		clock.now += 500
		const at2 = clock.now
		dwell(
			clock,
			store,
			sighting("t2", C2, C2 + SPUR, at2),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		const c2End = clock.now
		// back at C1 past the TTL of the C2 dwell's evidence
		clock.now = c2End + DQ_LO_LOCK_TTL_MS + 1
		const at3 = clock.now
		const back = dwell(
			clock,
			store,
			sighting("t3", C1, C1 + SPUR, at3),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(back.change).not.toBe("transient")
	})

	it("a bursty or modulated sighting at the offset never LO-locks", () => {
		const { clock, store } = setup()
		store.ingest(sighting("b1", C1, C1 + SPUR, clock.now))
		dwell(clock, store, sighting("b1", C1, C1 + SPUR, T0), 10_000)
		clock.now += 500
		const at2 = clock.now
		const keyed = dwell(
			clock,
			store,
			sighting("b2", C2, C2 + SPUR, at2, { dutyCycle: 0.5 }),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(keyed.change).not.toBe("transient")
		expect(store.takeLoLockedRetirees()).toEqual([])
	})

	it("a real emitter at one RF frequency seen from two centres stays one record", () => {
		const { clock, store } = setup()
		const rf = C1 + 150_000
		const a = store.ingest(sighting("r1", C1, rf, T0))
		dwell(clock, store, sighting("r1", C1, rf, T0), 10_000)
		clock.now += 500
		const b = dwell(
			clock,
			store,
			sighting("r2", C2, rf, clock.now),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
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
		dwell(clock, store, sighting("d1", C1, C1 + SPUR, T0), 10_000)
		clock.now += 500
		const b = dwell(
			clock,
			store,
			sighting("d2", C2, C2 + SPUR, clock.now),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(b.change).not.toBe("transient")
		expect(store.takeLoLockedRetirees()).toEqual([])
	})

	it("an operator-labelled partner is never retired, and without a tuned centre nothing is LO-locked", () => {
		const { clock, store } = setup()
		const a = store.ingest(sighting("o1", C1, C1 + SPUR, T0))
		store.setOperator(a.discoveryId!, { label: "mine" })
		dwell(clock, store, sighting("o1", C1, C1 + SPUR, T0), 10_000)
		clock.now += 500
		dwell(
			clock,
			store,
			sighting("o2", C2, C2 + SPUR, clock.now),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.get(a.discoveryId!)).toBeDefined()
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
	it("a tone-less heard row on a carrier observation is carrier evidence; on FM voice it stays voice", () => {
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

	it("repro: an 11 kHz FM observation after five quiet carrier observations proves analog voice", () => {
		const { clock, store } = setup()
		const rf = C1 + 50_000
		let id: string | null = null
		for (let k = 0; k < 5; k++) {
			clock.now = T0 + k * 10_000
			const r = store.ingest(sighting(`q${k}`, C1, rf, clock.now))
			id ??= r.discoveryId
			expect(r.discoveryId).toBe(id)
		}
		expect(store.get(id!)?.class).toBe("carrier")
		clock.now = T0 + 60_000
		const v = store.ingest(
			sighting("fm", C1, rf, clock.now, { cls: "analog-fm", obwHz: 11_000 }),
		)
		expect(v.discoveryId).toBe(id)
		// the record keeps its carrier majority, but this observation measured FM voice
		expect(store.get(id!)?.class).toBe("carrier")
		expect(store.recordAnalog("fm", heard(clock.now + 500))).toBe(true)
		expect(store.get(id!)?.proof?.kind).toBe("analog-voice")
	})

	it("a CTCSS tone on a carrier-measuring observation is still a tone proof", () => {
		const { store } = setup()
		const c = store.ingest(sighting("t1", C1, C1 + 50_000, T0))
		expect(store.recordAnalog("t1", heard(T0 + 500, 88.5))).toBe(true)
		expect(store.get(c.discoveryId!)?.proof?.kind).toBe("analog-tone")
	})
})
