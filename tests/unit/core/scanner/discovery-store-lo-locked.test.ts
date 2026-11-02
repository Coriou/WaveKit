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

/** One dwell per centre (a new observation each, 500 ms apart) of the line at `rf(centre)`. */
function dwells(
	clock: { now: number },
	store: DiscoveryStore,
	centres: readonly number[],
	opts: { rf?: (c: number) => number; ms?: number; prefix?: string } = {},
) {
	const out: { discoveryId: string | null; change: string }[] = []
	for (const [i, c] of centres.entries()) {
		if (i > 0) clock.now += 500
		const rf = opts.rf?.(c) ?? c + SPUR
		const obs = sighting(`${opts.prefix ?? "s"}${i + 1}`, c, rf, clock.now)
		out.push(dwell(clock, store, obs, opts.ms ?? 10_000))
	}
	return out
}

describe("LO-locked spurs in admission", () => {
	it("a steady line following the LO through three retunes (A, B, A, B): discovered until then, then no record, the earlier records retired, and it stays out", () => {
		const { clock, store } = setup()
		const [r1, r2, r3] = dwells(clock, store, [C1, C2, C1])
		// before the lock every sighting is discovered as usual
		for (const r of [r1!, r2!, r3!]) {
			expect(r.change).not.toBe("transient")
			expect(r.discoveryId).not.toBeNull()
		}
		expect(r3!.discoveryId).toBe(r1!.discoveryId)
		expect(r2!.discoveryId).not.toBe(r1!.discoveryId)
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([])
		clock.now += 500
		const at4 = clock.now
		// the third transition is undecided until the new dwell reaches the minimum: held back
		const early = store.ingest(sighting("s4", C2, C2 + SPUR, at4))
		expect(early).toEqual({ discoveryId: null, change: "transient" })
		expect(store.takeLoLockedRetirees()).toEqual([])
		clock.now = at4 + DQ_LO_LOCK_DWELL_MS - 1
		expect(store.ingest(sighting("s4", C2, C2 + SPUR, at4)).change).toBe(
			"transient",
		)
		expect(store.takeLoLockedRetirees()).toEqual([])
		clock.now = at4 + DQ_LO_LOCK_DWELL_MS
		expect(store.ingest(sighting("s4", C2, C2 + SPUR, at4))).toEqual({
			discoveryId: null,
			change: "transient",
		})
		expect(store.takeLoLockedRetirees().sort()).toEqual(
			[r1!.discoveryId!, r2!.discoveryId!].sort(),
		)
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.loLockedSuppressed("src-1")).toBe(1)
		// the observation's close after the retune carries no tuned centre: still no record
		clock.now += 1_000
		expect(store.ingest(sighting("s4", undefined, C2 + SPUR, at4)).change).toBe(
			"transient",
		)
		expect(store.delete(r1!.discoveryId!)).toBe(true)
		expect(store.delete(r2!.discoveryId!)).toBe(true)
		// back at C1 the spur does not come back once the dwell there is long enough
		clock.now += 1_000
		const at5 = clock.now
		dwell(clock, store, sighting("s5", C1, C1 + SPUR, at5), DQ_LO_LOCK_DWELL_MS)
		expect(live(store)).toEqual([])
	})

	it("repro: two real transmitters taking turns at one offset across one retune: both discovered, nothing retired", () => {
		// centres 25 kHz apart, each transmitter 100 kHz above its centre, both positions inside
		// both windows: TX-A keys only while tuned at A, TX-B only after the retune to B
		const { clock, store } = setup()
		const a = C1
		const b = C1 + 25_000
		const txA = dwell(clock, store, sighting("ta", a, a + 100_000, T0), 5_000)
		clock.now += 500
		const txB = dwell(
			clock,
			store,
			sighting("tb", b, b + 100_000, clock.now),
			60_000,
		)
		expect(txB.change).not.toBe("transient")
		expect(txB.discoveryId).not.toBeNull()
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(live(store).sort()).toEqual([a + 100_000, b + 100_000])
		expect(txA.discoveryId).not.toBeNull()
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("two transitions (A, B, A) are not enough: every record stays, nothing retired", () => {
		const { clock, store } = setup()
		const rs = dwells(clock, store, [C1, C2, C1], { ms: 30_000 })
		for (const r of rs) expect(r.change).not.toBe("transient")
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(live(store).sort()).toEqual([C1 + SPUR, C2 + SPUR])
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("repro: two real emitters at one offset, the first centre's window not covering the second: both are discovered", () => {
		// 1.024 Msps: the usable window is ±409.6 kHz. A 1 kHz line 25 dB at C + 100 kHz under
		// 400 MHz, then retuned 2 MHz up a second emitter at the same offset, back and forth.
		const { clock, store } = setup()
		const a = 400_000_000
		const b = 402_000_000
		const rs = dwells(clock, store, [a, b, a, b], {
			rf: c => c + 100_000,
		})
		for (const r of rs) {
			expect(r.change).not.toBe("transient")
			expect(r.discoveryId).not.toBeNull()
		}
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("repro: a learned offset does not hide a real narrow emitter a day later under another centre", () => {
		const { clock, store } = setup()
		const off = 100_000
		dwells(clock, store, [C1, C2, C1, C2], { rf: c => c + off })
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
		dwells(clock, store, [C1, C2, C1, C2])
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		for (const id of store.takeLoLockedRetirees()) store.delete(id)
		const end = clock.now
		// back at C1 past the TTL of every dwell's evidence
		clock.now = end + DQ_LO_LOCK_TTL_MS + 1
		const back = dwell(
			clock,
			store,
			sighting("t5", C1, C1 + SPUR, clock.now),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(back.change).not.toBe("transient")
		expect(back.discoveryId).not.toBeNull()
	})

	it("a bursty or modulated sighting at the offset never LO-locks", () => {
		const { clock, store } = setup()
		dwells(clock, store, [C1, C2, C1])
		clock.now += 500
		const keyed = dwell(
			clock,
			store,
			sighting("b4", C2, C2 + SPUR, clock.now, { dutyCycle: 0.5 }),
			DQ_LO_LOCK_DWELL_MS + 1_000,
		)
		expect(keyed.change).not.toBe("transient")
		expect(store.takeLoLockedRetirees()).toEqual([])
	})

	it("a real emitter at one RF frequency seen from two centres stays one record", () => {
		const { clock, store } = setup()
		const rf = C1 + 150_000
		const rs = dwells(clock, store, [C1, C2, C1, C2], { rf: () => rf })
		for (const r of rs) expect(r.discoveryId).toBe(rs[0]!.discoveryId)
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("a decoded record at the offset is a real emitter: the chain breaks and every centre's sighting is admitted", () => {
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
		const rs = dwells(clock, store, [C1, C2, C1, C2], { prefix: "x" }).slice(1)
		for (const r of rs) expect(r.change).not.toBe("transient")
		expect(store.takeLoLockedRetirees()).toEqual([])
		expect(store.get(a.discoveryId!)).toBeDefined()
	})

	it("an operator-labelled partner is never retired, and without a tuned centre nothing is LO-locked", () => {
		const { clock, store } = setup()
		const a = store.ingest(sighting("o1", C1, C1 + SPUR, T0))
		store.setOperator(a.discoveryId!, { label: "mine" })
		dwell(clock, store, sighting("o1", C1, C1 + SPUR, T0), 10_000)
		dwells(clock, store, [C1, C2, C1, C2], { prefix: "p" })
		expect(store.takeLoLockedRetirees()).not.toContain(a.discoveryId)
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
