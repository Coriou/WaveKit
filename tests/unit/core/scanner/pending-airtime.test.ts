import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DQ_CREATE_SNR_DB,
	DQ_CREATE_TRACK_SNR_DB,
	DQ_PENDING_BUCKET_HZ,
	DQ_PTT_IDS_MAX,
	DQ_PTT_PER_SOURCE,
	DQ_PTT_WINDOW_MS,
	DQ_SHORT_BURST_BLOCKS,
	DQ_SUSTAIN_MEDIAN_SNR_DB,
	DQ_SUSTAIN_MIN_SAMPLES,
	DQ_SUSTAIN_MS,
	DQ_SUSTAIN_SAMPLES,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	PendingAdmission,
	eligibleMs,
} from "../../../../src/core/scanner/store/pending-admission.js"
import type { ObservationInput } from "../../../../src/core/scanner/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

// Detection-quality 1.4c (short weak bursts need corroboration) and 1.4d (push-to-talk airtime).

const CH = 124_008_333
const T0 = Date.UTC(2026, 9, 26, 12, 0, 0)

/**
 * One snapshot of transmission `id` that started at `startedAt` (ms after T0): channel and track
 * SNR `snr`, 40 blocks unless given, closing when `closing`.
 */
function tx(
	id: string,
	startedAt: number,
	snr: number,
	over: {
		closing?: boolean
		centreHz?: number
		sourceId?: string
		blocks?: number
		trackSnr?: number
		peak?: number
		epoch?: number
	} = {},
): ObservationInput {
	const o = makeObs({
		id,
		centreHz: over.centreHz ?? CH,
		startedAt: T0 + startedAt,
		snrDb: over.trackSnr ?? snr,
		blocks: over.blocks ?? 40,
		gate: "passed",
		obwHz: 7_000,
		open: over.closing !== true,
		...(over.sourceId !== undefined ? { sourceId: over.sourceId } : {}),
	})
	o.track.channelSnrDb = snr
	if (over.peak !== undefined) o.track.peakChannelSnrDb = over.peak
	if (over.epoch !== undefined) o.track.epoch = over.epoch
	return o
}

function holder() {
	const clock = { now: T0 }
	return { clock, p: new PendingAdmission(() => clock.now) }
}

/**
 * One transmission through `PendingAdmission.sustained` at the store's cadence: the gate-pass
 * sample at its start, one at start + 1 000 ms (when it lasts longer) and the closing sample at
 * start + `durMs`, all accepted, so it credits `durMs`. True when any promoted.
 */
function key(
	h: ReturnType<typeof holder>,
	id: string,
	startMs: number,
	durMs: number,
	snr: number,
	over: { centreHz?: number; sourceId?: string } = {},
): boolean {
	h.clock.now = T0 + startMs
	if (h.p.sustained(tx(id, startMs, snr, over))) return true
	if (durMs > 1_000) {
		h.clock.now = T0 + startMs + 1_000
		if (h.p.sustained(tx(id, startMs, snr, over))) return true
	}
	h.clock.now = T0 + startMs + durMs
	return h.p.sustained(tx(id, startMs, snr, { ...over, closing: true }))
}

function setupStore() {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
	})
	return { clock, store }
}

/** The store's banked airtime entries for src-1. */
const airtimeOf = (store: DiscoveryStore): number =>
	(store as unknown as { pending: PendingAdmission }).pending.airtimeEntries(
		"src-1",
	).length

const count = (store: DiscoveryStore): number =>
	store.snapshot().discoveries.length

describe("push-to-talk airtime (DQ 1.4d)", () => {
	it("boundary: banked plus live airtime of exactly 3 000 ms promotes, 2 999 ms does not", () => {
		const a = holder()
		expect(key(a, "t1", 0, 1_500, 13)).toBe(false)
		expect(key(a, "t2", 10_000, DQ_SUSTAIN_MS - 1_500, 13)).toBe(true)
		const b = holder()
		expect(key(b, "t1", 0, 1_500, 13)).toBe(false)
		expect(key(b, "t2", 10_000, DQ_SUSTAIN_MS - 1_500 - 1, 13)).toBe(false)
	})

	it("boundary: a combined median of exactly 12 dB promotes, 11.99 dB does not", () => {
		const a = holder()
		key(a, "t1", 0, 1_500, DQ_SUSTAIN_MEDIAN_SNR_DB)
		expect(key(a, "t2", 5_000, 1_500, DQ_SUSTAIN_MEDIAN_SNR_DB)).toBe(true)
		const b = holder()
		key(b, "t1", 0, 1_500, DQ_SUSTAIN_MEDIAN_SNR_DB - 0.01)
		expect(key(b, "t2", 5_000, 1_500, DQ_SUSTAIN_MEDIAN_SNR_DB - 0.01)).toBe(
			false,
		)
	})

	it("boundary: banked airtime counts 59 999 ms after it was banked, not 60 000 ms", () => {
		// t1 banks 2 000 ms at 2 000 ms; t2 accepted at atMs - 1 000 and atMs makes 3 000 ms.
		const sample = (atMs: number): [boolean, number] => {
			const h = holder()
			key(h, "t1", 0, 2_000, 13)
			h.clock.now = T0 + atMs - 1_000
			h.p.sustained(tx("t2", atMs - 1_000, 13))
			h.clock.now = T0 + atMs
			const promoted = h.p.sustained(tx("t2", atMs - 1_000, 13))
			return [promoted, h.p.airtimeEntries("src-1").length]
		}
		expect(sample(2_000 + DQ_PTT_WINDOW_MS - 1)[0]).toBe(true)
		expect(sample(2_000 + DQ_PTT_WINDOW_MS)).toEqual([false, 0])
	})

	it("a transmission sampled once (closed inside its first second) banks nothing", () => {
		const h = holder()
		for (let i = 0; i < 10; i++) {
			h.clock.now = T0 + i * 5_000 + 900
			expect(h.p.sustained(tx(`f${i}`, i * 5_000, 14, { closing: true }))).toBe(
				false,
			)
		}
		expect(h.p.airtimeEntries("src-1")).toHaveLength(0)
	})

	it("adjacent 8.33 kHz channels bank apart; 2.5 kHz buckets b - 1 and b + 1 share", () => {
		const h = holder()
		key(h, "a", 0, 2_000, 13)
		expect(key(h, "b", 3_000, 1_500, 13, { centreHz: CH + 25_000 / 3 })).toBe(
			false,
		)
		expect(h.p.airtimeEntries("src-1")).toHaveLength(2)
		expect(
			key(h, "c", 6_000, 1_500, 13, { centreHz: CH + DQ_PENDING_BUCKET_HZ }),
		).toBe(true)
	})

	it("retraction, a create and a retune drop banked airtime", () => {
		const a = holder()
		key(a, "t1", 0, 2_000, 13)
		a.p.forget("src-1", "t1")
		expect(a.p.airtimeEntries("src-1")).toHaveLength(0)
		const b = holder()
		key(b, "t1", 0, 2_000, 13)
		b.p.consume(tx("x", 0, 30))
		expect(b.p.airtimeEntries("src-1")).toHaveLength(0)
		const c = holder()
		key(c, "t1", 0, 2_000, 13)
		c.clock.now = T0 + 5_000
		c.p.sustained(tx("t2", 4_000, 13, { epoch: 2 }))
		expect(c.p.airtimeEntries("src-1")).toHaveLength(0)
	})

	it("a three-observation promotion clears the channel's banked airtime", () => {
		// 2 000 ms banked at 13 dB, then two distinct 16 dB sightings make three ids with a 16 dB
		// median: the repeat rule promotes. With the record deleted, a 13 dB transmission 1 000 ms
		// long would reach 3 000 ms on the old credit; it must not create.
		const { clock, store } = setupStore()
		for (const [at, closing] of [
			[0, false],
			[1_000, false],
			[2_000, true],
		] as const) {
			clock.now = T0 + at
			store.ingest(tx("t1", 0, 13, { closing }))
		}
		expect(count(store)).toBe(0)
		expect(airtimeOf(store)).toBe(1)
		clock.now = T0 + 5_000
		store.ingest(tx("a", 5_000, 16, { closing: true }))
		expect(count(store)).toBe(0)
		clock.now = T0 + 8_000
		store.ingest(tx("b", 8_000, 16, { closing: true }))
		const [made] = store.snapshot().discoveries
		expect(made).toBeDefined()
		expect(airtimeOf(store)).toBe(0)
		expect(store.delete(made!.id)).toBe(true)
		for (const [at, closing] of [
			[20_000, false],
			[21_000, true],
		] as const) {
			clock.now = T0 + at
			store.ingest(tx("t2", 20_000, 13, { closing }))
		}
		expect(count(store)).toBe(0)
	})

	it("bounds: entries per source; samples per entry", () => {
		const h = holder()
		for (let i = 0; i <= DQ_PTT_PER_SOURCE; i++)
			key(h, `e${i}`, i * 10, 1_200, 10, { centreHz: CH + i * 10_000 })
		expect(h.p.airtimeEntries("src-1")).toHaveLength(DQ_PTT_PER_SOURCE)
		const g = holder()
		for (let i = 0; i < DQ_PTT_IDS_MAX; i++)
			key(g, `i${i}`, i * 2_000, 1_100, 9)
		expect(g.p.airtimeEntries("src-1")[0]?.snrs.length).toBe(DQ_SUSTAIN_SAMPLES)
	})

	it("boundary: 8 banked ids stay retractable; a 9th restarts the entry empty, then holds only itself", () => {
		const at = holder()
		for (let i = 0; i < DQ_PTT_IDS_MAX; i++)
			key(at, `i${i}`, i * 2_000, 1_100, 9)
		const [full] = at.p.airtimeEntries("src-1")
		expect(full?.ids.size).toBe(DQ_PTT_IDS_MAX)
		expect(full?.onMs).toBe(DQ_PTT_IDS_MAX * 1_100)
		at.p.forget("src-1", "i0")
		expect(at.p.airtimeEntries("src-1")).toHaveLength(0)
		const past = holder()
		for (let i = 0; i <= DQ_PTT_IDS_MAX; i++)
			key(past, `i${i}`, i * 2_000, 1_100, 9)
		const [fresh] = past.p.airtimeEntries("src-1")
		expect([...(fresh?.ids ?? [])]).toEqual([`i${DQ_PTT_IDS_MAX}`])
		expect(fresh?.onMs).toBe(1_100)
		expect(fresh?.snrs).toEqual([9, 9, 9])
		// The first id's credit went with the restart; forgetting it changes nothing.
		past.p.forget("src-1", "i0")
		expect(past.p.airtimeEntries("src-1")).toHaveLength(1)
		past.p.forget("src-1", `i${DQ_PTT_IDS_MAX}`)
		expect(past.p.airtimeEntries("src-1")).toHaveLength(0)
	})

	it("a run reset by a gap over 2 500 ms claims airtime only from its first sample after the reset", () => {
		const h = holder()
		key(h, "t1", 0, 1_500, 13) // banks 1 500 ms
		const at = (ms: number) => {
			h.clock.now = T0 + ms
			return h.p.sustained(tx("t2", 5_000, 13))
		}
		expect(at(6_000)).toBe(false)
		// A 3 000 ms gap resets the run: neither the gap nor the time since t2 started counts.
		expect(at(9_000)).toBe(false)
		expect(at(10_499)).toBe(false) // 1 500 + 1 499
		expect(at(10_500)).toBe(true) // 1 500 + 1 500
	})

	it("a run reset by a sample under 9 dB claims airtime only from the next accepted sample", () => {
		const h = holder()
		key(h, "t1", 0, 1_500, 13)
		const at = (ms: number, snr: number) => {
			h.clock.now = T0 + ms
			return h.p.sustained(tx("t2", 5_000, snr))
		}
		expect(at(6_000, 13)).toBe(false)
		expect(at(7_000, 8.99)).toBe(false)
		expect(at(8_000, 13)).toBe(false) // eligible 0 ms, not 3 000
		expect(at(9_499, 13)).toBe(false) // 1 500 + 1 499
		expect(at(9_500, 13)).toBe(true) // 1 500 + 1 500
	})

	it("a below-floor first sample starts nothing: counting starts at the first accepted sample", () => {
		const h = holder()
		key(h, "t1", 0, 1_500, 13) // banks 1 500 ms
		const at = (ms: number, snr: number) => {
			h.clock.now = T0 + ms
			return h.p.sustained(tx("t2", 5_000, snr))
		}
		expect(at(6_000, 8)).toBe(false)
		expect(at(7_000, 13)).toBe(false) // eligible 0 ms, not 2 000 since t2 started
		expect(at(8_499, 13)).toBe(false) // 1 500 + 1 499
		expect(at(8_500, 13)).toBe(true) // 1 500 + 1 500
	})

	it("a below-floor close banks only through the last accepted sample, never a gap", () => {
		const h = holder()
		const at = (ms: number, snr: number, closing = false) => {
			h.clock.now = T0 + ms
			return h.p.sustained(tx("t1", 0, snr, { closing }))
		}
		expect(at(1_000, 13)).toBe(false)
		expect(at(2_000, 13)).toBe(false)
		expect(at(5_000, 8, true)).toBe(false) // 3 000 ms gap, under the floor
		const [e] = h.p.airtimeEntries("src-1")
		expect(e?.onMs).toBe(1_000) // 1 000 to 2 000 ms, not 5 000
		expect(e?.snrs).toEqual([13, 13])
	})

	it("eligibleMs: first to latest accepted sample; malformed or out-of-window gives 0", () => {
		const run = (firstAt: number, lastAt: number) => ({
			firstAt,
			lastAt,
			snrs: [13],
		})
		expect(eligibleMs(run(T0, T0 + 1_000))).toBe(1_000)
		expect(eligibleMs(run(T0, T0 - 1))).toBe(0)
		expect(eligibleMs(run(T0, T0 + DQ_PTT_WINDOW_MS))).toBe(DQ_PTT_WINDOW_MS)
		expect(eligibleMs(run(T0, T0 + DQ_PTT_WINDOW_MS + 1))).toBe(0)
		expect(eligibleMs(run(Number.NaN, T0))).toBe(0)
	})

	// Feature: detection-quality, Property 27: Push-to-talk airtime promotion
	// Validates: Requirements 1.4d
	it("transmissions on one channel create a record iff banked plus live airtime reaches the sustained rule", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						gap: fc.integer({ min: 0, max: 40_000 }),
						dur: fc.integer({ min: 500, max: 2_500 }),
						// Under the 15 dB repeat median and the 18 dB threshold: only 1.4d can create.
						snr: fc.oneof(
							fc.constantFrom(11.99, 12),
							fc.double({ min: 9, max: 14.99, noNaN: true }),
						),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				txs => {
					expect(airtimeCreates(txs)).toBe(airtimeModel(txs))
				},
			),
			{ numRuns: 200 },
		)
	})

	it("Property 27 model: a 9th banked id restarts the entry (eight 9 dB then three 14 dB, no gaps)", () => {
		const txs = [
			...Array.from({ length: 8 }, () => ({ gap: 0, dur: 500, snr: 9 })),
			...Array.from({ length: 3 }, () => ({ gap: 0, dur: 500, snr: 14 })),
		]
		expect(airtimeModel(txs)).toBe(false)
		expect(airtimeCreates(txs)).toBe(false)
	})
})

interface Tx {
	gap: number
	dur: number
	snr: number
}

/** The store's cadence: the gate-pass ingest, one at 1 000 ms (when longer), the close. */
function samplesOf(start: number, dur: number): number[] {
	return dur > 1_000
		? [start, start + 1_000, start + dur]
		: [start, start + dur]
}

/** Feeds `txs` through a store; true when any record was created. */
function airtimeCreates(txs: readonly Tx[]): boolean {
	const { clock, store } = setupStore()
	let t = 0
	txs.forEach((x, i) => {
		const start = t + x.gap
		t = start + x.dur
		const samples = samplesOf(start, x.dur)
		samples.forEach((at, k) => {
			clock.now = T0 + at
			store.ingest(
				tx(`t${i}`, start, x.snr, { closing: k === samples.length - 1 }),
			)
		})
	})
	return count(store) > 0
}

/**
 * Reference model of one channel's airtime entry (DQ 1.4d): expires 60 000 ms after it started,
 * keeps the newest DQ_SUSTAIN_SAMPLES samples, and restarts empty when a new id would exceed
 * DQ_PTT_IDS_MAX banked ids.
 */
function airtimeModel(txs: readonly Tx[]): boolean {
	let bankAt = Number.NaN
	let banked = 0
	let bankSnrs: number[] = []
	let bankIds = 0
	let t = 0
	const median = (xs: number[]): number => {
		const s = [...xs].sort((a, b) => a - b)
		const m = s.length >> 1
		return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
	}
	const reset = (): void => {
		banked = 0
		bankSnrs = []
		bankIds = 0
		bankAt = Number.NaN
	}
	for (const x of txs) {
		const start = t + x.gap
		t = start + x.dur
		const samples = samplesOf(start, x.dur)
		const run: number[] = []
		for (const [k, at] of samples.entries()) {
			const closing = k === samples.length - 1
			if (banked > 0 && at >= bankAt + DQ_PTT_WINDOW_MS) reset()
			run.push(x.snr)
			const all = [...bankSnrs, ...run]
			if (
				banked > 0 &&
				banked + (at - start) >= DQ_SUSTAIN_MS &&
				all.length >= DQ_SUSTAIN_MIN_SAMPLES &&
				median(all) >= DQ_SUSTAIN_MEDIAN_SNR_DB
			)
				return true
			if (closing && run.length >= 2) {
				if (banked > 0 && bankIds >= DQ_PTT_IDS_MAX) reset()
				if (banked === 0) bankAt = at
				banked += at - start
				bankIds += 1
				bankSnrs.push(...run)
				bankSnrs = bankSnrs.slice(-DQ_SUSTAIN_SAMPLES)
			}
		}
	}
	return false
}

describe("short weak bursts need corroboration (DQ 1.4c)", () => {
	it("boundary: a short burst at an 18 dB best slot creates with a 15 dB track SNR, not 14.99 dB", () => {
		const a = setupStore()
		a.store.ingest(
			tx("b", 0, 4, {
				closing: true,
				blocks: DQ_SHORT_BURST_BLOCKS - 1,
				peak: DQ_CREATE_SNR_DB,
				trackSnr: DQ_CREATE_TRACK_SNR_DB,
			}),
		)
		expect(count(a.store)).toBe(1)
		const b = setupStore()
		b.store.ingest(
			tx("b", 0, 4, {
				closing: true,
				blocks: DQ_SHORT_BURST_BLOCKS - 1,
				peak: DQ_CREATE_SNR_DB,
				trackSnr: DQ_CREATE_TRACK_SNR_DB - 0.01,
			}),
		)
		expect(count(b.store)).toBe(0)
	})

	it("boundary: at 20 blocks the threshold alone creates, at 19 blocks it needs the track SNR", () => {
		const at = (blocks: number) => {
			const s = setupStore()
			s.store.ingest(
				tx("w", 0, 8, { blocks, peak: DQ_CREATE_SNR_DB, trackSnr: 8 }),
			)
			return count(s.store)
		}
		expect(at(DQ_SHORT_BURST_BLOCKS)).toBe(1)
		expect(at(DQ_SHORT_BURST_BLOCKS - 1)).toBe(0)
	})

	it("non-finite blocks or track SNR never corroborate (the safe answer)", () => {
		for (const over of [
			{ blocks: Number.NaN, trackSnr: 30 },
			{ blocks: 5, trackSnr: Number.NaN },
		]) {
			const s = setupStore()
			const o = tx("n", 0, 20, { closing: true, peak: 20, ...over })
			o.track.blocks = over.blocks
			o.track.snrDb = over.trackSnr
			s.store.ingest(o)
			if (Number.isFinite(over.trackSnr)) expect(count(s.store)).toBe(1)
			else expect(count(s.store)).toBe(0)
		}
	})

	it("a weak data burst seen once makes no record; the same burst seen three times does", () => {
		// Fixture shaped like a weak periodic burst: 9 blocks (450 ms), track SNR 13.9 dB,
		// channel SNR near 0 on the closing block, best slot 18.2 dB once and 16 to 17 dB after.
		const burst = (id: string, startedAt: number, peak: number) =>
			tx(id, startedAt, 0.04, {
				closing: true,
				blocks: 9,
				trackSnr: 13.9,
				peak,
			})
		const once = setupStore()
		once.clock.now = T0 + 450
		once.store.ingest(burst("p1", 0, 18.2))
		expect(count(once.store)).toBe(0)
		const thrice = setupStore()
		;[18.2, 16.1, 17].forEach((peak, i) => {
			thrice.clock.now = T0 + i * 3_350 + 450
			thrice.store.ingest(burst(`p${i}`, i * 3_350, peak))
		})
		expect(count(thrice.store)).toBe(1)
	})
})
