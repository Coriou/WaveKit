import { describe, expect, it } from "vitest"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	JournalEntry,
	StoreObservationInput,
} from "../../../../src/core/scanner/store/discovery-store.js"
import { parseStoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import type { StoreMutation } from "../../../../src/core/scanner/store/schemas.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { ScannerClass } from "../../../../src/core/scanner/types.js"
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

function setup(
	over: Partial<ConstructorParameters<typeof DiscoveryStore>[0]> = {},
) {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
		...over,
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
	// a Hann-windowed tone: at most 2 bins at -6 dB
	if ((over.obwHz ?? 1_000) < 4_000) o.track.spectralShape = "narrow"
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

const C3 = C1 + 400_000
/** A tiling sweep: hops 785 kHz apart (no hop's window covers another hop's spur position). */
const SWEEP = [C1, C1 + 785_000, C1 + 1_570_000] as const

const ids = (rs: readonly { discoveryId: string | null }[]) => [
	...new Set(rs.map(r => r.discoveryId!)),
]
const listed = (store: DiscoveryStore, includeReceiverSpurs = false) =>
	store
		.list({
			limit: 500,
			...(includeReceiverSpurs ? { includeReceiverSpurs } : {}),
		})
		.items.map(d => d.id)
		.sort()

/** Ids of a store after a restart (never one of the first store's). */
function restartIds(): () => string {
	let n = 0
	return () => `RESTART${++n}`
}

/** An FM voice observation at `rf` placed without a tuned centre (a close after a retune, a restore). */
function fmWithoutCentre(id: string, rf: number, at: number) {
	return sighting(id, undefined, rf, at, { cls: "analog-fm", obwHz: 11_000 })
}

describe("LO-locked spurs in admission (flag, never delete)", () => {
	it("a receiver spur in a 3-hop tiling sweep: discovered as usual, then every record of it flagged, kept, hidden by default and listed on request", () => {
		const { clock, store } = setup()
		const rs = dwells(clock, store, [...SWEEP], {
			rf: c => c - 500_000 + 100_000,
		})
		for (const r of rs) expect(r.change).not.toBe("transient")
		const spurIds = ids(rs).sort()
		expect(spurIds).toHaveLength(3)
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		expect(store.loLockedOffsets("src-1")).toEqual([-400_000])
		// never deleted: every record and its observations stay
		for (const id of spurIds) expect(store.get(id)).toBeDefined()
		expect(store.snapshot().discoveries).toHaveLength(3)
		expect(listed(store)).toEqual([])
		expect(listed(store, true)).toEqual(spurIds)
		expect(store.get(spurIds[0]!)?.receiverSpur).toEqual({
			offsetHz: -400_000,
			sampleRateHz: RATE,
			centres: 3,
			lastAtMs: expect.any(Number),
		})
		// a revisit joins the flagged record; it stays flagged
		clock.now += 500
		const back = dwell(
			clock,
			store,
			sighting("rv", SWEEP[0], SWEEP[0] - 400_000, clock.now),
			5_000,
		)
		expect(back.discoveryId).toBe(rs[0]!.discoveryId)
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
	})

	it("two distinct centres (A, B, A, B) never flag", () => {
		const { clock, store } = setup()
		const rs = dwells(clock, store, [C1, C2, C1, C2], { ms: 30_000 })
		for (const r of rs) expect(r.change).not.toBe("transient")
		expect(store.receiverSpurIds()).toEqual([])
		expect(listed(store)).toHaveLength(2)
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("repro: an FM voice record placed without a tuned centre, then joined by a spur's sightings, is never flagged or deleted", () => {
		const { clock, store } = setup()
		let fm: string | null = null
		for (let k = 0; k < 20; k++) {
			clock.now = T0 + k * 1_000
			const r = store.ingest(fmWithoutCentre(`fm${k}`, C1 + SPUR, clock.now))
			fm ??= r.discoveryId
			expect(r.discoveryId).toBe(fm)
		}
		expect(store.get(fm!)?.proof).toBeUndefined()
		clock.now += 1_000
		const rs = dwells(clock, store, [C1, C2, C1, C2, C3])
		// the spur's sightings at C1 joined the FM record (one RF position)
		expect(rs[0]!.discoveryId).toBe(fm)
		const spurOnly = ids(rs).filter(id => id !== fm)
		expect(store.receiverSpurIds().sort()).toEqual(spurOnly.sort())
		expect(store.get(fm!)).toBeDefined()
		expect(store.get(fm!)?.receiverSpur).toBeUndefined()
		expect(listed(store)).toContain(fm)
		expect(store.get(fm!)?.observationCount).toBeGreaterThanOrEqual(21)
	})

	it("repro: a carrier record placed without a tuned centre is never flagged", () => {
		const { clock, store } = setup()
		let carrier: string | null = null
		for (let k = 0; k < 5; k++) {
			clock.now = T0 + k * 10_000
			const r = store.ingest(sighting(`c${k}`, undefined, C1 + SPUR, clock.now))
			carrier ??= r.discoveryId
		}
		clock.now += 1_000
		dwells(clock, store, [C1, C2, C3, C1, C2, C3])
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.get(carrier!)?.receiverSpur).toBeUndefined()
		expect(listed(store)).toContain(carrier)
	})

	it("repro: a record restored from disk is never flagged (its history is unknown)", () => {
		const first = setup()
		const r = first.store.ingest(sighting("old", C1, C1 + SPUR, T0))
		const snap = first.store.snapshot()
		let n = 0
		const { clock, store } = setup({ newId: () => `RESTART${++n}` })
		store.restore(snap)
		clock.now = T0 + 60_000
		const rs = dwells(clock, store, [C1, C2, C3])
		expect(rs[0]!.discoveryId).toBe(r.discoveryId)
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.get(r.discoveryId!)?.receiverSpur).toBeUndefined()
		expect(store.receiverSpurIds().sort()).toEqual(
			[rs[1]!.discoveryId!, rs[2]!.discoveryId!].sort(),
		)
	})

	it("an observation first placed without a tuned centre that gains one keeps its record flaggable; one that closes without loses it", () => {
		const { clock, store } = setup()
		const open = sighting("o1", undefined, C1 + SPUR, T0)
		delete open.endReason
		delete open.endedAt
		const a = store.ingest(open)
		// the next ingest of the same observation carries its epoch's tuned centre
		dwell(clock, store, sighting("o1", C1, C1 + SPUR, T0), 10_000)
		clock.now += 500
		const rs = dwells(clock, store, [C2, C3], { prefix: "n" })
		expect(store.receiverSpurIds().sort()).toEqual(
			[a.discoveryId!, ...ids(rs)].sort(),
		)
		// a new observation that closes without ever bringing a tuned centre: unknown history
		clock.now += 1_000
		store.ingest(sighting("late", undefined, C1 + SPUR, clock.now))
		expect(store.get(a.discoveryId!)?.receiverSpur).toBeUndefined()
		clock.now += 500
		dwells(clock, store, [C1, C2, C3], { prefix: "m" })
		expect(store.get(a.discoveryId!)?.receiverSpur).toBeUndefined()
	})

	it("a merge survivor is never flagged (it took on history the tracker did not see)", () => {
		const { clock, store } = setup({
			rasters: () => [{ spacingHz: 12_500, firstChannelHz: C1 + SPUR }],
		})
		const a = store.ingest(sighting("ma", C1, C1 + SPUR, T0))
		const b = store.ingest(sighting("mb", C1, C1 + SPUR + 3_500, T0))
		expect(a.discoveryId).not.toBe(b.discoveryId)
		const merged = store.rekey("src-1", 3_000).merged
		expect(merged.length).toBe(1)
		const survivor = merged[0]![0]
		clock.now = T0 + 1_000
		const rs = dwells(clock, store, [C1, C2, C3])
		expect(rs[0]!.discoveryId).toBe(survivor)
		expect(store.get(survivor)?.receiverSpur).toBeUndefined()
		expect(store.receiverSpurIds()).not.toContain(survivor)
	})

	it("a later operator mark or decode lifts the flag; their next sighting revokes the offset", () => {
		const { clock, store } = setup()
		const rs = dwells(clock, store, [...SWEEP], { rf: c => c + SPUR })
		const [first, second, third] = ids(rs)
		expect(store.receiverSpurIds().sort()).toEqual(
			[first, second, third].sort(),
		)
		store.setOperator(first!, { label: "mine" })
		expect(store.get(first!)?.receiverSpur).toBeUndefined()
		expect(listed(store)).toEqual([first])
		const ev = evidence("pocsag", clock.now, {
			identity: { kind: "pocsag-capcode", value: "1234" },
		})
		store.appendObservationEvidence("s2", ev)
		store.applyEvidence(second!, ev)
		expect(store.get(second!)?.receiverSpur).toBeUndefined()
		expect(listed(store)).toEqual([first, second].sort())
		expect(store.get(third!)?.receiverSpur).toBeDefined()
		// the labelled record seen again is a real signal at the offset: revoked, every flag lifts
		clock.now += 500
		dwell(
			clock,
			store,
			sighting("s9", SWEEP[0], SWEEP[0] + SPUR, clock.now),
			2_000,
		)
		expect(store.loLockedOffsets("src-1")).toEqual([])
		expect(store.receiverSpurIds()).toEqual([])
		expect(listed(store)).toEqual([first, second, third].sort())
	})

	it("revocation lifts the flags at that offset (a decode at the offset)", () => {
		const { clock, store } = setup()
		const rs = dwells(clock, store, [...SWEEP], { rf: c => c + SPUR })
		expect(store.receiverSpurIds()).toHaveLength(3)
		clock.now += 500
		const c4 = SWEEP[2] + 785_000
		const d = store.ingest(sighting("dx", c4, c4 + SPUR, clock.now), {
			decode: evidence("pocsag", clock.now, {
				identity: { kind: "pocsag-capcode", value: "77" },
			}),
		})
		expect(d.discoveryId).not.toBeNull()
		expect(store.loLockedOffsets("src-1")).toEqual([])
		expect(store.receiverSpurIds()).toEqual([])
		expect(listed(store)).toEqual(expect.arrayContaining(ids(rs)))
	})

	it("a bursty or modulated sighting at the offset never flags", () => {
		const { clock, store } = setup()
		const rs = dwells(clock, store, [...SWEEP], {
			rf: c => c + SPUR,
		})
		expect(store.receiverSpurIds()).toHaveLength(3)
		const other = setup()
		const keyed = []
		for (const [i, c] of SWEEP.entries()) {
			if (i > 0) other.clock.now += 500
			keyed.push(
				dwell(
					other.clock,
					other.store,
					sighting(`b${i}`, c, c + SPUR, other.clock.now, { dutyCycle: 0.5 }),
					10_000,
				),
			)
		}
		expect(other.store.receiverSpurIds()).toEqual([])
		expect(rs).toHaveLength(3)
	})

	it("a real emitter at one RF frequency seen from two centres stays one record, never flagged", () => {
		const { clock, store } = setup()
		const rf = C1 + 150_000
		const rs = dwells(clock, store, [C1, C2, C3, C1], { rf: () => rf })
		for (const r of rs) expect(r.discoveryId).toBe(rs[0]!.discoveryId)
		expect(store.receiverSpurIds()).toEqual([])
		expect(store.loLockedOffsets("src-1")).toEqual([])
	})

	it("an operator-labelled record at the offset is never flagged, and without a tuned centre nothing is", () => {
		const { clock, store } = setup()
		const a = store.ingest(sighting("o1", C1, C1 + SPUR, T0))
		store.setOperator(a.discoveryId!, { label: "mine" })
		dwell(clock, store, sighting("o1", C1, C1 + SPUR, T0), 10_000)
		clock.now += 500
		dwells(clock, store, [C2, C3, C1], { prefix: "p" })
		expect(store.receiverSpurIds()).not.toContain(a.discoveryId)
		expect(store.get(a.discoveryId!)).toBeDefined()
		const other = setup()
		for (const [i, c] of SWEEP.entries()) {
			other.clock.now = T0 + i * 10_000
			other.store.ingest(
				sighting(`u${i}`, undefined, c + SPUR, other.clock.now),
			)
		}
		expect(other.store.receiverSpurIds()).toEqual([])
	})

	it("mask lines: once the engine masks the line before tracking, the records it left are flagged from the masks", () => {
		const { clock, store } = setup()
		// tracked sightings at the first two hops only
		const rs = dwells(clock, store, [SWEEP[0], SWEEP[1]], { rf: c => c + SPUR })
		expect(store.receiverSpurIds()).toEqual([])
		// third hop: the provisional mask hides the line (no track), the block summaries carry it
		clock.now += 500
		const from = clock.now
		for (let t = from; t <= from + 10_000; t += 250) {
			clock.now = t
			store.noteReceiverLines("src-1", SWEEP[2], RATE, [
				{ startHz: SWEEP[2] + SPUR - 1_000, endHz: SWEEP[2] + SPUR + 1_000 },
			])
		}
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.receiverSpurIds().sort()).toEqual(ids(rs).sort())
		expect(listed(store)).toEqual([])
	})

	it("mask lines in the first 2 s after a retune count for nothing", () => {
		const { clock, store } = setup()
		dwells(clock, store, [SWEEP[0], SWEEP[1]], { rf: c => c + SPUR })
		clock.now += 500
		const from = clock.now
		for (let t = from; t < from + 1_999; t += 250) {
			clock.now = t
			store.noteReceiverLines("src-1", SWEEP[2], RATE, [
				{ startHz: SWEEP[2] + SPUR - 1_000, endHz: SWEEP[2] + SPUR + 1_000 },
			])
		}
		expect(store.loLockedOffsets("src-1")).toEqual([])
		expect(store.receiverSpurIds()).toEqual([])
	})
})

/** A 3-hop tiling sweep of the spur at `SPUR`: every record flagged; returns their ids. */
function flaggedSweep(clock: { now: number }, store: DiscoveryStore) {
	const rs = dwells(clock, store, [...SWEEP], { rf: c => c + SPUR })
	const spurIds = ids(rs).sort()
	expect(spurIds).toHaveLength(3)
	expect(store.receiverSpurIds().sort()).toEqual(spurIds)
	return spurIds
}

/** An observation left open (its track still on air): no close reason yet. */
function open(o: StoreObservationInput): StoreObservationInput {
	delete o.endReason
	delete o.endedAt
	return o
}

describe("LO-locked spur flags are sticky-safe (a real signal is never wrongly hidden)", () => {
	it("repro: an open FM voice observation placed without a tuned centre that later reads as a narrow line with one is never flagged", () => {
		const { clock, store } = setup()
		const fm = store.ingest(open(fmWithoutCentre("o1", SWEEP[0] + SPUR, T0)))
		expect(fm.discoveryId).not.toBeNull()
		// the same observation, now a narrow line with its tuned centre
		dwell(clock, store, sighting("o1", SWEEP[0], SWEEP[0] + SPUR, T0), 10_000)
		clock.now += 500
		const rs = dwells(clock, store, [SWEEP[1], SWEEP[2]], {
			rf: c => c + SPUR,
			prefix: "n",
		})
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.receiverSpurIds().sort()).toEqual(ids(rs).sort())
		expect(store.get(fm.discoveryId!)?.receiverSpur).toBeUndefined()
		expect(listed(store)).toContain(fm.discoveryId)
	})

	it("repro: a centre-less observation joining a flagged record unflags it for good (FM voice and a plain line alike)", () => {
		for (const late of [
			(at: number) => fmWithoutCentre("late", SWEEP[0] + SPUR, at),
			(at: number) => sighting("late", undefined, SWEEP[0] + SPUR, at),
		]) {
			const { clock, store } = setup()
			const spurIds = flaggedSweep(clock, store)
			const first = store
				.list({ limit: 500, includeReceiverSpurs: true })
				.items.find(
					d =>
						Math.abs(d.frequencyHz + d.measuredOffsetHz - (SWEEP[0] + SPUR)) <
						1_000,
				)!.id
			clock.now += 500
			const r = store.ingest(open(late(clock.now)))
			expect(r.discoveryId).toBe(first)
			expect(store.get(first)?.receiverSpur).toBeUndefined()
			expect(listed(store)).toEqual([first])
			// the offset still holds, yet the record stays unflagged
			clock.now += 500
			dwells(clock, store, [...SWEEP], { rf: c => c + SPUR, prefix: "again" })
			expect(store.get(first)?.receiverSpur).toBeUndefined()
			expect(store.receiverSpurIds().sort()).toEqual(
				spurIds.filter(id => id !== first),
			)
		}
	})

	it("repro: a Keep set then cleared, or a recording attached then removed, before the offset is learned still protects the record", () => {
		for (const protect of [
			(store: DiscoveryStore, id: string) => {
				store.setOperator(id, { keep: true })
				store.setOperator(id, { keep: false })
			},
			(store: DiscoveryStore, id: string) => {
				expect(store.attachRecordings("k1", [`${id}~a.wav`], "linked")).toBe(
					true,
				)
				expect(store.forgetRecording(`${id}~a.wav`)).toBe(true)
			},
		]) {
			const { clock, store } = setup()
			const a = dwell(
				clock,
				store,
				sighting("k1", SWEEP[0], SWEEP[0] + SPUR, clock.now),
				10_000,
			)
			protect(store, a.discoveryId!)
			expect(store.get(a.discoveryId!)?.evidence.recordings).toBe(0)
			expect(store.get(a.discoveryId!)?.operator?.keep).not.toBe(true)
			clock.now += 500
			const rs = dwells(clock, store, [SWEEP[1], SWEEP[2]], {
				rf: c => c + SPUR,
				prefix: "n",
			})
			expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
			expect(store.receiverSpurIds().sort()).toEqual(ids(rs).sort())
			expect(store.get(a.discoveryId!)?.receiverSpur).toBeUndefined()
			expect(listed(store)).toEqual([a.discoveryId])
		}
	})

	it("repro: an offset that expires lifts its flags, and an FM observation on a flagged record unflags it", () => {
		const { clock, store } = setup()
		const spurIds = flaggedSweep(clock, store)
		clock.now += 600_001
		// read with no ingest or block since: the flags already stand no more
		expect(store.loLockedOffsets("src-1")).toEqual([])
		expect(store.receiverSpurIds()).toEqual([])
		expect(listed(store)).toEqual(spurIds)
		const fm = store.ingest(
			sighting("fm", SWEEP[0], SWEEP[0] + SPUR, clock.now, {
				cls: "analog-fm",
				obwHz: 11_000,
			}),
		)
		expect(spurIds).toContain(fm.discoveryId)
		expect(store.get(fm.discoveryId!)?.receiverSpur).toBeUndefined()
		expect(listed(store)).toEqual(spurIds)
	})

	it("an FM observation on a flagged record unflags it while the offset still holds", () => {
		const { clock, store } = setup()
		const spurIds = flaggedSweep(clock, store)
		clock.now += 500
		const fm = store.ingest(
			sighting("fm", SWEEP[2], SWEEP[2] + SPUR, clock.now, {
				cls: "analog-fm",
				obwHz: 11_000,
			}),
		)
		expect(spurIds).toContain(fm.discoveryId)
		expect(store.get(fm.discoveryId!)?.receiverSpur).toBeUndefined()
		expect(listed(store)).toContain(fm.discoveryId)
	})

	it("an expiry seen by a block summary publishes the lifted flags", () => {
		const { clock, store } = setup()
		const spurIds = flaggedSweep(clock, store)
		const changed: string[] = []
		store.on("change", (id: string) => changed.push(id))
		clock.now += 600_001
		store.noteReceiverLines("src-1", SWEEP[0], RATE, [])
		expect([...new Set(changed)].sort()).toEqual(spurIds)
		expect(listed(store)).toEqual(spurIds)
	})

	it("repro: a job's discovery counts leave flagged records out", () => {
		const { clock, store } = setup()
		const carrier = store.ingest(sighting("c", SWEEP[0], SWEEP[0] + 50_000, T0))
		const total = (): number =>
			Object.values(store.countsByJob("job-1")).reduce((a, b) => a + b, 0)
		expect(total()).toBe(1)
		const spurIds = flaggedSweep(clock, store)
		expect(listed(store)).toEqual([carrier.discoveryId])
		expect(total()).toBe(1)
		// unflagged (an operator mark): counted again
		store.setOperator(spurIds[0]!, { label: "mine" })
		expect(total()).toBe(2)
		// an expiry lifts the rest: every record counts
		clock.now += 600_001
		store.noteReceiverLines("src-1", SWEEP[0], RATE, [])
		expect(total()).toBe(4)
	})

	it("a restore keeps the journaled flags pending (hidden), and they hold through a sweep that learns the offset again", () => {
		const first = setup()
		const spurIds = flaggedSweep(first.clock, first.store)
		const snap = JSON.parse(
			JSON.stringify(first.store.snapshot()),
		) as ReturnType<DiscoveryStore["snapshot"]>
		for (const d of snap.discoveries)
			expect(d.receiverSpur?.offsetHz).toBe(SPUR)
		const { clock, store } = setup({ newId: restartIds() })
		clock.now = first.clock.now + 60_000
		const restoredAt = clock.now
		store.restore(snap)
		// pending: still hidden, nothing learned yet
		expect(store.loLockedOffsets("src-1")).toEqual([])
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		expect(listed(store)).toEqual([])
		expect(store.get(spurIds[0]!)?.receiverSpur?.offsetHz).toBe(SPUR)
		// three cycles of the sweep: the sightings join the restored records and learn the offset
		for (let cycle = 0; cycle < 3; cycle++) {
			clock.now += 500
			const rs = dwells(clock, store, [...SWEEP], {
				rf: c => c + SPUR,
				prefix: `c${cycle}-`,
			})
			expect(ids(rs).sort()).toEqual(spurIds)
			expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		}
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		// past the restored deadline, kept fresh by the sweep: an ordinary flag, still hidden
		clock.now = restoredAt + 575_000
		dwells(clock, store, [...SWEEP], { rf: c => c + SPUR, prefix: "late-" })
		expect(clock.now).toBeGreaterThan(restoredAt + 600_000)
		store.noteReceiverLines("src-1", SWEEP[0], RATE, [])
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		expect(listed(store)).toEqual([])
		expect(listed(store, true)).toEqual(spurIds)
	})

	it("a restored flag reads as a possible spur (unverified) until its offset is learned again, then as a spur, published; never stored", () => {
		const first = setup()
		const spurIds = flaggedSweep(first.clock, first.store)
		// a flag the tracker set in this run is verified
		for (const id of spurIds)
			expect(first.store.get(id)?.possibleSpur).toBeUndefined()
		const snap = JSON.parse(
			JSON.stringify(first.store.snapshot()),
		) as ReturnType<DiscoveryStore["snapshot"]>
		const { clock, store } = setup({ newId: restartIds() })
		clock.now = first.clock.now + 60_000
		store.restore(snap)
		for (const id of spurIds) {
			const d = store.get(id)
			expect(d?.receiverSpur?.offsetHz).toBe(SPUR)
			expect(d?.possibleSpur).toEqual({ reason: "restored" })
		}
		const shown = store
			.list({ limit: 500, includeReceiverSpurs: true })
			.items.filter(d => d.possibleSpur !== undefined)
			.map(d => d.id)
			.sort()
		expect(shown).toEqual(spurIds)
		// computed on read: the snapshot and the journal never carry it
		for (const d of store.snapshot().discoveries)
			expect("possibleSpur" in d).toBe(false)
		// what a client reads on each published change
		const seen = new Map<string, unknown>()
		const journaled: string[] = []
		store.on("change", (id: string) =>
			seen.set(id, store.get(id)?.possibleSpur ?? null),
		)
		store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
			for (const d of (e.payload as StoreMutation).discoveries) {
				expect("possibleSpur" in d).toBe(false)
				journaled.push(d.id)
			}
		})
		// one sweep cycle (3 hops) learns the offset again: verified, an ordinary flag
		clock.now += 500
		dwells(clock, store, [...SWEEP], { rf: c => c + SPUR, prefix: "again-" })
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		for (const id of spurIds) {
			const d = store.get(id)
			expect(d?.receiverSpur?.offsetHz).toBe(SPUR)
			expect(d?.possibleSpur).toBeUndefined()
		}
		// the last change published for each record already reads verified
		for (const id of spurIds) expect(seen.get(id)).toBeNull()
		expect(journaled.length).toBeGreaterThan(0)
		expect(listed(store)).toEqual([])
	})

	it("repro: an offset learned again only after the restored deadline does not keep the restored flags", () => {
		const first = setup()
		const spurIds = flaggedSweep(first.clock, first.store)
		const snap = JSON.parse(
			JSON.stringify(first.store.snapshot()),
		) as ReturnType<DiscoveryStore["snapshot"]>
		const { clock, store } = setup({ newId: restartIds() })
		clock.now = first.clock.now + 60_000
		const restoredAt = clock.now
		store.restore(snap)
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		// two sweep cycles just before the deadline (not yet a lock), the third after it
		clock.now = restoredAt + 590_000
		for (let cycle = 0; cycle < 2; cycle++) {
			clock.now += 500
			dwells(clock, store, [...SWEEP].slice(0, 2), {
				rf: c => c + SPUR,
				prefix: `late${cycle}-`,
			})
		}
		expect(clock.now).toBeGreaterThan(restoredAt + 600_000)
		// past the deadline before any re-learning: every restored flag lifts at the next block
		store.noteReceiverLines("src-1", SWEEP[0], RATE, [])
		for (const id of spurIds)
			expect(store.get(id)?.receiverSpur).toBeUndefined()
		expect(listed(store).sort()).toEqual(spurIds)
	})

	it("a journaled flag replays like a snapshot one, and a journal line without the spur fields parses as before", () => {
		const first = setup()
		const entries: JournalEntry[] = []
		first.store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
			entries.push(
				JSON.parse(
					JSON.stringify({ ...e, seq: entries.length + 1 }),
				) as JournalEntry,
			),
		)
		const spurIds = flaggedSweep(first.clock, first.store)
		const flagged = entries.filter(e =>
			(e.payload as StoreMutation).discoveries.some(
				d => d.receiverSpur !== undefined,
			),
		)
		expect(flagged.length).toBeGreaterThan(0)
		const { clock, store } = setup({ newId: restartIds() })
		clock.now = first.clock.now
		store.restore({ discoveries: [], observations: [], corrections: [] })
		for (const e of entries) store.replay(e)
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		// an older core's line (no spur fields) is still a valid journal line
		const old = JSON.parse(JSON.stringify(flagged[0]!.payload)) as {
			discoveries: Record<string, unknown>[]
		}
		for (const d of old.discoveries) {
			delete d["receiverSpur"]
			delete d["receiverSpurSourceId"]
			delete d["receiverSpurRuledOut"]
		}
		expect(parseStoreMutation(old)).not.toBeNull()
	})

	it("repro: a restored flag whose offset is not learned again within 10 min lifts then, published (a block or a read)", async () => {
		for (const via of ["block", "read"] as const) {
			const first = setup()
			const spurIds = flaggedSweep(first.clock, first.store)
			const snap = first.store.snapshot()
			const { clock, store } = setup({ newId: restartIds() })
			clock.now = first.clock.now + 60_000
			store.restore(snap)
			const changed: string[] = []
			const journaled: string[] = []
			store.on("change", (id: string) => changed.push(id))
			store.on("mutation", (e: Omit<JournalEntry, "seq">) => {
				for (const d of (e.payload as StoreMutation).discoveries)
					if (d.receiverSpur === undefined) journaled.push(d.id)
			})
			clock.now += 600_000
			store.noteReceiverLines("src-1", SWEEP[0], RATE, [])
			expect(store.receiverSpurIds().sort()).toEqual(spurIds)
			expect(changed).toEqual([])
			clock.now += 1
			if (via === "block") store.noteReceiverLines("src-1", SWEEP[0], RATE, [])
			else {
				expect(listed(store)).toEqual(spurIds)
				await Promise.resolve()
			}
			expect([...new Set(changed)].sort()).toEqual(spurIds)
			expect([...new Set(journaled)].sort()).toEqual(spurIds)
			expect(store.receiverSpurIds()).toEqual([])
			expect(listed(store)).toEqual(spurIds)
			for (const d of store.snapshot().discoveries)
				expect(d.receiverSpur).toBeUndefined()
		}
	})

	it("a ruled-out record stays unflagged after a restore, even through a sweep that learns its offset again", () => {
		const first = setup()
		const spurIds = flaggedSweep(first.clock, first.store)
		// an operator Keep set then cleared on one flagged record: the operator's, for good
		const out = spurIds[1]!
		first.store.setOperator(out, { keep: true })
		first.store.setOperator(out, { keep: false })
		expect(first.store.receiverSpurIds().sort()).toEqual(
			spurIds.filter(id => id !== out),
		)
		const snap = first.store.snapshot()
		const stored = snap.discoveries.find(d => d.id === out) as
			| { receiverSpur?: unknown; receiverSpurRuledOut?: boolean }
			| undefined
		expect(stored?.receiverSpur).toBeUndefined()
		expect(stored?.receiverSpurRuledOut).toBe(true)
		// a ruled-out record restored with a flag (hand-edited, or written mid-change) is not flagged
		const forged = JSON.parse(JSON.stringify(snap)) as typeof snap
		const kept = forged.discoveries.find(d => d.id === spurIds[0])!
		const target = forged.discoveries.find(d => d.id === out)!
		target.receiverSpur = kept.receiverSpur!
		;(target as { receiverSpurSourceId?: string }).receiverSpurSourceId =
			"src-1"
		const { clock, store } = setup({ newId: restartIds() })
		clock.now = first.clock.now + 1_000
		store.restore(forged)
		expect(store.receiverSpurIds()).not.toContain(out)
		for (let cycle = 0; cycle < 3; cycle++) {
			clock.now += 500
			dwells(clock, store, [...SWEEP], {
				rf: c => c + SPUR,
				prefix: `c${cycle}-`,
			})
		}
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.receiverSpurIds().sort()).toEqual(
			spurIds.filter(id => id !== out),
		)
		expect(listed(store)).toEqual([out])
	})

	it("an older snapshot without the spur fields restores as before: nothing flagged, every record listed", () => {
		const first = setup()
		const spurIds = flaggedSweep(first.clock, first.store)
		const snap = JSON.parse(JSON.stringify(first.store.snapshot())) as {
			discoveries: Record<string, unknown>[]
		}
		for (const d of snap.discoveries) {
			delete d["receiverSpur"]
			delete d["receiverSpurSourceId"]
			delete d["receiverSpurRuledOut"]
		}
		const { clock, store } = setup({ newId: restartIds() })
		clock.now = first.clock.now
		store.restore(snap as unknown as ReturnType<DiscoveryStore["snapshot"]>)
		expect(store.receiverSpurIds()).toEqual([])
		expect(listed(store)).toEqual(spurIds)
	})

	it("repro: a stay at a new hop that covers the offset with nothing there revokes it and lifts its flags at once (published)", () => {
		const { clock, store } = setup()
		const spurIds = flaggedSweep(clock, store)
		const changed: string[] = []
		store.on("change", (id: string) => changed.push(id))
		const far = SWEEP[2] + 785_000
		clock.now += 500
		const until = clock.now + 10_000
		while (clock.now <= until) {
			store.noteReceiverLines("src-1", far, RATE, [])
			clock.now += 1_000
		}
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		// the tuner moves on: the stay is complete and saw nothing at the offset
		store.noteReceiverLines("src-1", SWEEP[0], RATE, [])
		expect(store.loLockedOffsets("src-1")).toEqual([])
		expect(store.receiverSpurIds()).toEqual([])
		expect([...new Set(changed)].sort()).toEqual(spurIds)
		expect(listed(store)).toEqual(spurIds)
	})

	it("an expired offset read before any block lifts its flags through the publishing path", async () => {
		const { clock, store } = setup()
		const spurIds = flaggedSweep(clock, store)
		const changed: string[] = []
		store.on("change", (id: string) => changed.push(id))
		clock.now += 600_001
		expect(store.get(spurIds[0]!)?.receiverSpur).toBeUndefined()
		expect(changed).toEqual([])
		await Promise.resolve()
		expect([...new Set(changed)].sort()).toEqual(spurIds)
		for (const d of store.snapshot().discoveries)
			expect(d.receiverSpur).toBeUndefined()
	})

	it("repro: an ambiguous 3-bin flat reading at a learned offset neither revokes it nor lifts or rules out its flags", () => {
		const { clock, store } = setup()
		const spurIds = flaggedSweep(clock, store)
		clock.now += 500
		const flat = sighting("flat", SWEEP[0], SWEEP[0] + SPUR, clock.now, {
			obwHz: 3 * 1_000,
		})
		flat.track.spectralShape = "flat"
		flat.track.obw6Hz = 3 * 1_000
		flat.track.binHz = 1_000
		const r = dwell(clock, store, flat, 5_000)
		expect(spurIds).toContain(r.discoveryId)
		expect(store.loLockedOffsets("src-1")).toEqual([SPUR])
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		// its next narrow sighting keeps it flagged (never ruled out)
		clock.now += 500
		dwell(
			clock,
			store,
			sighting("narrow", SWEEP[1], SWEEP[1] + SPUR, clock.now),
			5_000,
		)
		expect(store.receiverSpurIds().sort()).toEqual(spurIds)
		for (const d of store.snapshot().discoveries)
			expect(
				(d as { receiverSpurRuledOut?: boolean }).receiverSpurRuledOut,
			).toBeUndefined()
	})

	it("the mask-line clock is bounded like the tracker's sources (64), oldest dropped", () => {
		const { clock, store } = setup()
		const internal = store as unknown as { loMaskAt: Map<string, number> }
		for (let k = 0; k < 70; k++) {
			clock.now += 10
			store.noteReceiverLines(`src-${k}`, SWEEP[0], RATE, [
				{ startHz: SWEEP[0] + SPUR - 1_000, endHz: SWEEP[0] + SPUR + 1_000 },
			])
		}
		expect(internal.loMaskAt.size).toBe(64)
		expect(internal.loMaskAt.has("src-0")).toBe(false)
		expect(internal.loMaskAt.has("src-69")).toBe(true)
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
