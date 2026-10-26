import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DQ_CREATE_SNR_DB,
	DQ_LOCAL_SNR_DB,
	DQ_PENDING_MEDIAN_SNR_DB,
	DQ_SUSTAIN_FLOOR_SNR_DB,
	DQ_SUSTAIN_MAX_GAP_MS,
	DQ_SUSTAIN_MEDIAN_SNR_DB,
	DQ_SUSTAIN_MIN_SAMPLES,
	DQ_SUSTAIN_MS,
	DQ_SUSTAIN_PER_SOURCE,
	DQ_SUSTAIN_SAMPLES,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	PendingAdmission,
	admissionSnrOf,
} from "../../../../src/core/scanner/store/pending-admission.js"
import type { ObservationInput } from "../../../../src/core/scanner/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

// Amendment 10 SC, detection-quality requirement 1.4b: a sustained observation promotes on duration.

const CH = 98_300_000
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0)
const TRANSIENT = { discoveryId: null, change: "transient" }

function setup() {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
	})
	return { clock, store }
}

/** One live (open) snapshot of observation `id` at `snr` dB channel SNR. */
function live(
	id: string,
	snr: number,
	over: {
		centreHz?: number
		sourceId?: string
		peak?: number
		overload?: boolean
		closing?: boolean
		epoch?: number
		obwHz?: number
	} = {},
): ObservationInput {
	const o = makeObs({
		id,
		centreHz: over.centreHz ?? CH,
		startedAt: T0,
		snrDb: snr,
		blocks: 20,
		gate: "passed",
		obwHz: over.obwHz ?? 150_000,
		open: over.closing !== true,
		...(over.sourceId !== undefined ? { sourceId: over.sourceId } : {}),
	})
	o.track.channelSnrDb = snr
	if (over.peak !== undefined) o.track.peakChannelSnrDb = over.peak
	if (over.overload === true) o.track.flags.overload = true
	if (over.epoch !== undefined) o.track.epoch = over.epoch
	return o
}

const count = (store: DiscoveryStore): number =>
	store.snapshot().discoveries.length

/** Ingests `id` at each (time offset, SNR); returns the offsets that created a record. */
function run(
	samples: readonly [number, number][],
	id = "fm",
): { created: number[]; store: DiscoveryStore } {
	const { clock, store } = setup()
	const created: number[] = []
	for (const [at, snr] of samples) {
		clock.now = T0 + at
		const before = count(store)
		store.ingest(live(id, snr))
		if (count(store) > before) created.push(at)
	}
	return { created, store }
}

/** 1 s re-ingest cadence, like ScannerService's throttled ingest. */
const every = (n: number, snr: number, stepMs = 1_000): [number, number][] =>
	Array.from({ length: n }, (_, i) => [i * stepMs, snr] as [number, number])

describe("DiscoveryStore sustained admission (DQ 1.4b)", () => {
	it("a continuous 12 dB broadcast re-ingested every second creates one record at 3 s", () => {
		const { created, store } = run(every(8, 12))
		expect(created).toEqual([3_000])
		expect(count(store)).toBe(1)
	})

	it("boundary: a run of exactly 3 000 ms promotes, 2 999 ms does not", () => {
		expect(
			run([
				[0, 13],
				[1_000, 13],
				[2_000, 13],
				[DQ_SUSTAIN_MS, 13],
			]).created,
		).toEqual([DQ_SUSTAIN_MS])
		expect(
			run([
				[0, 13],
				[1_000, 13],
				[2_000, 13],
				[DQ_SUSTAIN_MS - 1, 13],
			]).created,
		).toEqual([])
	})

	it("boundary: a run median of exactly 12 dB promotes, 11.99 dB does not", () => {
		expect(run(every(4, DQ_SUSTAIN_MEDIAN_SNR_DB)).created).toEqual([3_000])
		expect(run(every(10, DQ_SUSTAIN_MEDIAN_SNR_DB - 0.01)).created).toEqual([])
	})

	it("boundary: a 9 dB sample keeps the run, 8.99 dB restarts it", () => {
		const keep: [number, number][] = [
			[0, 14],
			[1_000, DQ_SUSTAIN_FLOOR_SNR_DB],
			[2_000, 14],
			[3_000, 14],
		]
		expect(run(keep).created).toEqual([3_000])
		const restart: [number, number][] = [
			[0, 14],
			[1_000, DQ_SUSTAIN_FLOOR_SNR_DB - 0.01],
			[2_000, 14],
			[3_000, 14],
			[4_000, 14],
			[5_000, 14],
		]
		// The run restarts at 2 000 ms and needs 3 000 ms more.
		expect(run(restart).created).toEqual([5_000])
	})

	it("boundary: a 2 500 ms gap keeps the run, 2 501 ms restarts it", () => {
		expect(
			run([
				[0, 13],
				[DQ_SUSTAIN_MAX_GAP_MS, 13],
				[3_000, 13],
			]).created,
		).toEqual([3_000])
		const gap = DQ_SUSTAIN_MAX_GAP_MS + 1
		expect(
			run([
				[0, 13],
				[gap, 13],
				[gap + 1_000, 13],
				[gap + 2_000, 13],
				[gap + 3_000, 13],
			]).created,
		).toEqual([gap + 3_000])
	})

	it("boundary: 3 samples over 3 s promote, 2 cannot (the gap rule restarts them)", () => {
		expect(DQ_SUSTAIN_MIN_SAMPLES).toBe(3)
		expect(
			run([
				[0, 13],
				[1_500, 13],
				[3_000, 13],
			]).created,
		).toEqual([3_000])
		expect(
			run([
				[0, 13],
				[3_000, 13],
			]).created,
		).toEqual([])
	})

	it("keeps the newest 8 samples: weak early samples age out of the median", () => {
		// 8 samples at 9.5 dB (median 9.5), then 13 dB ones: the 9.5s leave the window.
		const samples: [number, number][] = [
			...every(DQ_SUSTAIN_SAMPLES, 9.5),
			...every(5, 13).map(
				([at, snr]) =>
					[at + DQ_SUSTAIN_SAMPLES * 1_000, snr] as [number, number],
			),
		]
		// Medians: 4 x 9.5 + 4 x 13 = 11.25 (no), 3 x 9.5 + 5 x 13 = 13 at the 5th 13 dB sample.
		expect(run(samples).created).toEqual([12_000])
	})

	it("distinct ids never sustain: each is its own run", () => {
		const { clock, store } = setup()
		for (let i = 0; i < 20; i++) {
			clock.now = T0 + i * 1_000
			expect(store.ingest(live(`n${i}`, 13))).toEqual(TRANSIENT)
		}
		expect(count(store)).toBe(0)
	})

	it("a closing observation's run ends; a retune clears runs; overload never sustains", () => {
		const { clock, store } = setup()
		const feed = (o: ObservationInput, at: number) => {
			clock.now = T0 + at
			return store.ingest(o)
		}
		feed(live("a", 13), 0)
		feed(live("a", 13, { closing: true }), 1_000)
		feed(live("a", 13), 2_000)
		feed(live("a", 13), 3_000)
		expect(count(store)).toBe(0)
		feed(live("b", 13), 4_000)
		feed(live("b", 13), 5_000)
		feed(live("b", 13, { epoch: 2 }), 6_000) // retune: the run starts again
		feed(live("b", 13, { epoch: 2 }), 7_000)
		feed(live("b", 13, { epoch: 2 }), 8_000)
		expect(count(store)).toBe(0)
		for (let i = 0; i < 6; i++)
			feed(live("c", 20, { overload: true }), 10_000 + i * 1_000)
		expect(count(store)).toBe(0)
	})

	it("judges a wide track at its peak channel: 8 dB sum with an 18 dB best slot creates", () => {
		const { store } = setup()
		store.ingest(live("wide", 8, { peak: DQ_CREATE_SNR_DB }))
		expect(count(store)).toBe(1)
		const s2 = setup()
		s2.store.ingest(live("wide", 8, { peak: DQ_CREATE_SNR_DB - 0.01 }))
		expect(count(s2.store)).toBe(0)
	})

	it("admissionSnrOf reads the higher of the channel sum and the peak slot", () => {
		const o = live("x", 8, { peak: 14 })
		expect(admissionSnrOf(o.track)).toBe(14)
		o.track.peakChannelSnrDb = 6
		expect(admissionSnrOf(o.track)).toBe(8)
		o.track.peakChannelSnrDb = Number.NaN
		expect(admissionSnrOf(o.track)).toBe(8)
		o.track.channelSnrDb = Number.NEGATIVE_INFINITY
		o.track.peakChannelSnrDb = 30
		expect(admissionSnrOf(o.track)).toBe(Number.NEGATIVE_INFINITY)
	})

	it("bounds: 512 runs per source; the 513th evicts the oldest", () => {
		const clock = { now: T0 }
		const p = new PendingAdmission(() => clock.now)
		for (let i = 0; i < DQ_SUSTAIN_PER_SOURCE; i++)
			p.sustained(live(`r${i}`, 13))
		expect(p.runCount("src-1")).toBe(DQ_SUSTAIN_PER_SOURCE)
		p.sustained(live("extra", 13))
		expect(p.runCount("src-1")).toBe(DQ_SUSTAIN_PER_SOURCE)
		expect(p.runOf("src-1", "r0")).toBeUndefined()
		expect(p.runOf("src-1", "r1")).toBeDefined()
		expect(p.runOf("src-1", "extra")).toBeDefined()
		// Another source has its own budget.
		p.sustained(live("other", 13, { sourceId: "src-2" }))
		expect(p.runCount("src-1")).toBe(DQ_SUSTAIN_PER_SOURCE)
		expect(p.runCount("src-2")).toBe(1)
	})

	it("sweep drops runs idle for more than the gap", () => {
		const clock = { now: T0 }
		const p = new PendingAdmission(() => clock.now)
		p.sustained(live("a", 13))
		p.sweep(T0 + DQ_SUSTAIN_MAX_GAP_MS)
		expect(p.runCount()).toBe(1)
		p.sweep(T0 + DQ_SUSTAIN_MAX_GAP_MS + 1)
		expect(p.runCount()).toBe(0)
	})

	// Feature: detection-quality, Property 23: Pure noise never promotes
	// Validates: Requirements 1.3, 1.4, 1.4b
	it("noise at or under 11.99 dB, any id reuse and any cadence, never creates a record", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.integer({ min: 0, max: 3 }),
						step: fc.integer({ min: 0, max: 4_000 }),
						snr: fc.double({ min: 0, max: 11.99, noNaN: true }),
						offset: fc.integer({ min: -1_000, max: 1_000 }),
						closing: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 60 },
				),
				ops => {
					const { clock, store } = setup()
					for (const op of ops) {
						clock.now += op.step
						store.ingest(
							live(`n${op.id}`, op.snr, {
								centreHz: CH + op.offset,
								closing: op.closing,
							}),
						)
					}
					expect(count(store)).toBe(0)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: detection-quality, Property 24: Sustained promotion
	// Validates: Requirements 1.4b
	it("one observation creates iff a run (samples >= 9 dB, gaps <= 2.5 s) spans 3 s with median >= 12 dB", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						step: fc.integer({ min: 0, max: 3_000 }),
						snr: fc.oneof(
							fc.constantFrom(8.99, 9, 11.99, 12),
							fc.double({
								min: 7,
								max: DQ_PENDING_MEDIAN_SNR_DB - 0.01,
								noNaN: true,
							}),
						),
					}),
					{ minLength: 1, maxLength: 16 },
				),
				ops => {
					const { clock, store } = setup()
					// Reference model of 1.4b; one id, so the repeat rule (3 distinct ids) never fires.
					let expected = false
					let first = Number.NaN
					let last = Number.NaN
					let snrs: number[] = []
					for (const op of ops) {
						clock.now += op.step
						store.ingest(live("one", op.snr))
						if (expected) continue
						if (op.snr < DQ_SUSTAIN_FLOOR_SNR_DB) {
							snrs = []
							first = Number.NaN
							continue
						}
						if (snrs.length === 0 || clock.now - last > DQ_SUSTAIN_MAX_GAP_MS) {
							snrs = []
							first = clock.now
						}
						last = clock.now
						snrs.push(op.snr)
						if (snrs.length > DQ_SUSTAIN_SAMPLES) snrs.shift()
						const s = [...snrs].sort((a, b) => a - b)
						const mid = s.length >> 1
						const median =
							s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
						if (
							clock.now - first >= DQ_SUSTAIN_MS &&
							snrs.length >= DQ_SUSTAIN_MIN_SAMPLES &&
							median >= DQ_SUSTAIN_MEDIAN_SNR_DB
						)
							expected = true
					}
					expect(count(store) > 0).toBe(expected)
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("DiscoveryStore local floor, DC and channel keys (DQ 1.15, 1.16)", () => {
	it("boundary: a local SNR of 6 dB creates, 5.99 dB never does (even at 30 dB channel SNR)", () => {
		const a = setup()
		const ok = live("l1", 30)
		ok.track.localSnrDb = DQ_LOCAL_SNR_DB
		a.store.ingest(ok)
		expect(count(a.store)).toBe(1)
		const b = setup()
		const flat = live("l2", 30)
		flat.track.localSnrDb = DQ_LOCAL_SNR_DB - 0.01
		b.store.ingest(flat)
		expect(count(b.store)).toBe(0)
		// A supplied non-finite local SNR is rejected (fail closed).
		for (const bad of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			const c = setup()
			const o = live("l3", 30)
			o.track.localSnrDb = bad
			c.store.ingest(o)
			expect(count(c.store)).toBe(0)
		}
		// Absent (no channel plan): no local check, an explicit compatibility rule.
		const d = setup()
		d.store.ingest(live("l4", 30))
		expect(count(d.store)).toBe(1)
	})

	it("a refused sample ends the sustained run: 13/8/13/13 dB with local 10/5/10/10 creates nothing at 3 s", () => {
		const { clock, store } = setup()
		const samples: [number, number, number][] = [
			[0, 13, 10],
			[1_000, 8, 5],
			[2_000, 13, 10],
			[3_000, 13, 10],
		]
		for (const [at, snr, local] of samples) {
			clock.now = T0 + at
			const o = live("r", snr)
			o.track.localSnrDb = local
			store.ingest(o)
		}
		expect(count(store)).toBe(0)
		// The run restarted at 2 s: it promotes at 5 s, not before.
		for (const at of [4_000, 5_000]) {
			clock.now = T0 + at
			const o = live("r", 13)
			o.track.localSnrDb = 10
			store.ingest(o)
			expect(count(store)).toBe(at === 5_000 ? 1 : 0)
		}
	})

	it("DC and invalid refusals end the run too", () => {
		const { clock, store } = setup()
		const feed = (at: number, o: ObservationInput) => {
			clock.now = T0 + at
			store.ingest(o)
		}
		feed(0, live("x", 13))
		feed(1_000, { ...live("x", 13), dcCentred: true })
		feed(2_000, live("x", 13))
		feed(3_000, live("x", 13))
		expect(count(store)).toBe(0)
		const bad = live("x", 13)
		bad.track.centreHz = Number.NaN
		feed(4_000, bad)
		feed(5_000, live("x", 13))
		expect(count(store)).toBe(0)
	})

	it("a DC-centred evidence-less observation never creates, even sustained or at 30 dB", () => {
		const { clock, store } = setup()
		for (let i = 0; i < 6; i++) {
			clock.now = T0 + i * 1_000
			store.ingest({ ...live("dc", 30), dcCentred: true })
		}
		expect(count(store)).toBe(0)
	})

	it("off every raster tolerance, observations key to the coarsest channel raster's channel", () => {
		const clock = { now: T0 }
		const raster = { spacingHz: 25_000, firstChannelHz: 136_000_000 }
		const store = new DiscoveryStore({
			maxDiscoveries: 1000,
			now: () => clock.now,
			newId: counterIds(),
			rasters: () => [raster],
			channelRasters: () => [
				{ spacingHz: 12_500, firstChannelHz: 136_000_000 },
				raster,
			],
		})
		// 136.875 MHz channel: measured centres drift 9 to 12 kHz off (beyond 25 000 / 4).
		for (const [i, off] of [9_000, -11_000, 12_000, -9_500].entries()) {
			clock.now = T0 + i * 1_000
			const o = live(`c${i}`, 20, {
				centreHz: 136_875_000 + off,
				obwHz: 20_000,
			})
			store.ingest(o)
		}
		const ds = store.snapshot().discoveries
		expect(ds).toHaveLength(1)
		expect(ds[0]!.frequencyHz).toBe(136_875_000)
		// 12 501 Hz off is the next channel.
		clock.now = T0 + 10_000
		store.ingest(
			live("next", 20, { centreHz: 136_875_000 + 12_501, obwHz: 20_000 }),
		)
		expect(
			store
				.snapshot()
				.discoveries.map(d => d.frequencyHz)
				.sort(),
		).toEqual([136_875_000, 136_900_000])
	})
})
