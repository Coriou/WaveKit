import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DQ_REPEAT_ENABLED,
	DQ_REPEAT_LOCAL_SNR_DB,
	DQ_REPEAT_MEDIAN_SNR_DB,
	DQ_REPEAT_PEAK_SNR_DB,
	DQ_REPEAT_PER_SOURCE,
	DQ_REPEAT_SAMPLES,
	DQ_REPEAT_WINDOW_MS,
	DQ_SUSTAIN_FLOOR_SNR_DB,
	DQ_SUSTAIN_MEDIAN_SNR_DB,
	DQ_SUSTAIN_MS,
	DQ_TDMA_DUTY,
	DQ_TDMA_DUTY_DB,
} from "../../../../src/core/scanner/detection-quality-contract.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { PendingAdmission } from "../../../../src/core/scanner/store/pending-admission.js"
import type {
	ObservationInput,
	ScannerClass,
} from "../../../../src/core/scanner/types.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

// Weak but visible signals: the duty-aware sustained median (DQ 1.4b) and repeated gate passes
// (DQ 1.4e, shipped off; tested with the switch on).

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 24, 12, 0, 0)

function setup() {
	const clock = { now: T0 }
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => clock.now,
		newId: counterIds(),
	})
	const pending = (store as unknown as { pending: PendingAdmission }).pending
	return { clock, store, pending }
}

const count = (store: DiscoveryStore): number =>
	store.snapshot().discoveries.length

/** One gate-passed snapshot of `id` at `snr` dB channel SNR with a local SNR. */
function pass(
	id: string,
	snr: number,
	over: {
		cls?: ScannerClass
		local?: number | null
		centreHz?: number
		open?: boolean
		edge?: boolean
		sourceId?: string
		epoch?: number
	} = {},
): ObservationInput {
	const o = makeObs({
		id,
		centreHz: over.centreHz ?? CH,
		startedAt: T0,
		snrDb: snr,
		blocks: 20,
		gate: "passed",
		obwHz: 9_000,
		cls: over.cls ?? "unknown",
		open: over.open ?? true,
		...(over.edge === true ? { edge: true } : {}),
		...(over.sourceId !== undefined ? { sourceId: over.sourceId } : {}),
	})
	o.track.channelSnrDb = snr
	if (over.local !== null) o.track.localSnrDb = over.local ?? 10
	if (over.epoch !== undefined) o.track.epoch = over.epoch
	return o
}

describe("duty-aware sustained median (DQ 1.4b, tdma-ms)", () => {
	it("states its arithmetic: 10 · log10(1 / 0.5) = 3.01 dB, so the 9 dB floor binds", () => {
		expect(DQ_TDMA_DUTY).toBe(0.5)
		expect(DQ_TDMA_DUTY_DB).toBeCloseTo(3.0103, 4)
		// Every run sample is ≥ the floor, and floor + correction clears the median.
		expect(DQ_SUSTAIN_FLOOR_SNR_DB + DQ_TDMA_DUTY_DB).toBeGreaterThanOrEqual(
			DQ_SUSTAIN_MEDIAN_SNR_DB,
		)
	})

	/** Ingests `id` every second at `snr`; returns the offsets that created a record. */
	function run(
		snr: number,
		cls: ScannerClass,
		n = 6,
		dutyAware = true,
	): number[] {
		const { clock, store, pending } = setup()
		pending.dutyAware = dutyAware
		const created: number[] = []
		for (let i = 0; i < n; i++) {
			clock.now = T0 + i * 1_000
			const before = count(store)
			store.ingest(pass("dmr", snr, { cls }))
			if (count(store) > before) created.push(i * 1_000)
		}
		return created
	}

	it("a tdma-ms run at the 9 dB floor creates at 3 s (9 + 3.01 = 12.01 dB)", () => {
		expect(run(DQ_SUSTAIN_FLOOR_SNR_DB, "tdma-ms")).toEqual([DQ_SUSTAIN_MS])
	})

	it("the same run under any other class stays pending (median 9 < 12 dB)", () => {
		expect(run(DQ_SUSTAIN_FLOOR_SNR_DB, "fsk4-12k5")).toEqual([])
		expect(run(11.99, "analog-fm", 10)).toEqual([])
		expect(run(DQ_SUSTAIN_MEDIAN_SNR_DB, "analog-fm")).toEqual([DQ_SUSTAIN_MS])
	})

	it("a tdma-ms run under the floor (8.99 dB) never starts: a 6 dB DMR carrier stays out", () => {
		expect(run(DQ_SUSTAIN_FLOOR_SNR_DB - 0.01, "tdma-ms", 10)).toEqual([])
		expect(run(7.3, "tdma-ms", 10)).toEqual([])
	})

	it("with the correction switched off a tdma-ms run at 11 dB stays pending", () => {
		expect(run(11, "tdma-ms", 10, false)).toEqual([])
		expect(run(11, "tdma-ms", 10, true)).toEqual([DQ_SUSTAIN_MS])
	})

	it("needs the full 3 s run like any sustained run", () => {
		expect(run(10, "tdma-ms", 3)).toEqual([])
		expect(run(10, "tdma-ms", 4)).toEqual([DQ_SUSTAIN_MS])
	})
})

describe("repeated gate passes (DQ 1.4e)", () => {
	function holder(on = true) {
		const clock = { now: T0 }
		const p = new PendingAdmission(() => clock.now)
		p.repeatRule = on
		return { clock, p }
	}

	/** Passes of distinct ids at (time offset, SNR); returns the offsets that promoted. */
	function passes(
		xs: readonly [number, number][],
		over: Parameters<typeof pass>[2] = {},
	): number[] {
		const { clock, p } = holder()
		const out: number[] = []
		xs.forEach(([at, snr], i) => {
			clock.now = T0 + at
			if (p.repeated(pass(`o${i}`, snr, over))) out.push(at)
		})
		return out
	}

	it("ships off: the switch defaults to DQ_REPEAT_ENABLED (false) and then never promotes", () => {
		expect(DQ_REPEAT_ENABLED).toBe(false)
		const { clock, p } = holder(false)
		expect(new PendingAdmission(() => clock.now).repeatRule).toBe(false)
		for (let i = 0; i < 5; i++) {
			clock.now = T0 + i * 1_000
			expect(p.repeated(pass(`o${i}`, 14))).toBe(false)
		}
		expect(p.repeatEntries("src-1")).toHaveLength(0)
	})

	it("3 distinct passes promote on the third; 2 do not", () => {
		expect(
			passes([
				[0, 11],
				[15_000, 11],
				[30_000, 11],
			]),
		).toEqual([30_000])
		expect(
			passes([
				[0, 11],
				[15_000, 11],
			]),
		).toEqual([])
	})

	it("one observation re-sampled never counts more than once (a steady weak carrier)", () => {
		const { clock, p } = holder()
		for (let i = 0; i < 120; i++) {
			clock.now = T0 + i * 1_000
			expect(p.repeated(pass("carrier", 12))).toBe(false)
		}
		expect(p.repeatEntries("src-1")[0]!.samples).toHaveLength(1)
	})

	it("window edge: a third pass at first + 59 999 ms counts, at first + 60 000 ms the first has left", () => {
		expect(
			passes([
				[0, 11],
				[30_000, 11],
				[DQ_REPEAT_WINDOW_MS - 1, 11],
			]),
		).toEqual([DQ_REPEAT_WINDOW_MS - 1])
		expect(
			passes([
				[0, 11],
				[30_000, 11],
				[DQ_REPEAT_WINDOW_MS, 11],
			]),
		).toEqual([])
		// sliding, not fixed from the first pass: 0, 40, 70 and 90 s promote at 90 s from the
		// last three (a window fixed at 0 s would have restarted at 70 s with two passes)
		expect(
			passes([
				[0, 11],
				[40_000, 11],
				[70_000, 11],
				[90_000, 11],
			]),
		).toEqual([90_000])
	})

	it("median edge: exactly 10 dB promotes, 9.99 dB does not", () => {
		expect(
			passes([
				[0, DQ_REPEAT_PEAK_SNR_DB],
				[1_000, DQ_REPEAT_MEDIAN_SNR_DB],
				[2_000, 14],
			]),
		).toEqual([2_000])
		expect(
			passes([
				[0, DQ_REPEAT_PEAK_SNR_DB],
				[1_000, DQ_REPEAT_MEDIAN_SNR_DB - 0.01],
				[2_000, 14],
			]),
		).toEqual([])
	})

	it("peak edge: a 9 dB pass counts, an 8.99 dB pass is not recorded", () => {
		expect(
			passes([
				[0, 12],
				[1_000, 12],
				[2_000, DQ_REPEAT_PEAK_SNR_DB],
			]),
		).toEqual([2_000])
		expect(
			passes([
				[0, 12],
				[1_000, 12],
				[2_000, DQ_REPEAT_PEAK_SNR_DB - 0.01],
			]),
		).toEqual([])
	})

	it("local SNR edge: 6 dB counts, 5.99 dB or none (no channel plan) is not recorded", () => {
		const three: [number, number][] = [
			[0, 11],
			[1_000, 11],
			[2_000, 11],
		]
		expect(passes(three, { local: DQ_REPEAT_LOCAL_SNR_DB })).toEqual([2_000])
		expect(passes(three, { local: DQ_REPEAT_LOCAL_SNR_DB - 0.01 })).toEqual([])
		expect(passes(three, { local: null })).toEqual([])
	})

	it("a passband edge track never counts", () => {
		expect(
			passes(
				[
					[0, 12],
					[1_000, 12],
					[2_000, 12],
				],
				{ edge: true },
			),
		).toEqual([])
	})

	it("joins adjacent buckets (±1 × 2 500 Hz) and keeps far channels apart", () => {
		const { clock, p } = holder()
		const at = (ms: number, id: string, centreHz: number): boolean => {
			clock.now = T0 + ms
			return p.repeated(pass(id, 11, { centreHz }))
		}
		expect(at(0, "a", CH)).toBe(false)
		expect(at(1_000, "b", CH + 2_500)).toBe(false)
		expect(at(2_000, "far", CH + 25_000)).toBe(false)
		expect(at(3_000, "c", CH - 1_000)).toBe(true)
	})

	it("forget, clear, a retune and the sweep drop passes", () => {
		const { clock, p } = holder()
		p.repeated(pass("a", 11))
		clock.now += 1_000
		p.repeated(pass("b", 11))
		p.forget("src-1", "a")
		expect(p.repeatEntries("src-1")[0]!.samples.map(x => x.id)).toEqual(["b"])
		clock.now += 1_000
		expect(p.repeated(pass("c", 11))).toBe(false)
		p.repeated(pass("d", 11, { epoch: 2 }))
		expect(
			p.repeatEntries("src-1").flatMap(e => e.samples.map(x => x.id)),
		).toEqual(["d"])
		p.sweep(clock.now + DQ_REPEAT_WINDOW_MS - 1)
		expect(p.repeatEntries("src-1")).toHaveLength(1)
		p.sweep(clock.now + DQ_REPEAT_WINDOW_MS)
		expect(p.repeatEntries("src-1")).toHaveLength(0)
		p.repeated(pass("e", 11, { sourceId: "s2" }))
		p.clear("s2")
		expect(p.repeatEntries("s2")).toHaveLength(0)
	})

	it("the store creates on the third pass with the rule on, and never with it off", () => {
		for (const on of [true, false]) {
			const { clock, store, pending } = setup()
			pending.repeatRule = on
			const created: number[] = []
			for (const [i, at] of [0, 20_000, 40_000].entries()) {
				clock.now = T0 + at
				const before = count(store)
				// Each a short closed burst seen once: no other rule (1.4, 1.4b, 1.4d) promotes it.
				store.ingest(pass(`burst${i}`, 11, { open: false }))
				if (count(store) > before) created.push(at)
			}
			expect(created).toEqual(on ? [40_000] : [])
		}
	})

	it("noise-like passes (under 9 dB or under 6 dB local) never promote; bounds hold", () => {
		// Feature: weak-admission, Property 1: noise never promotes and memory stays bounded
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						dtMs: fc.integer({ min: 0, max: 20_000 }),
						bucket: fc.integer({ min: 0, max: 700 }),
						weak: fc.boolean(),
						snr: fc.double({ min: 0, max: 30, noNaN: true }),
						local: fc.double({ min: 0, max: 30, noNaN: true }),
					}),
					{ maxLength: 400 },
				),
				xs => {
					const { clock, p } = holder()
					xs.forEach((x, i) => {
						clock.now += x.dtMs
						// A weak pass fails at least one per-pass condition.
						const snr = x.weak
							? Math.min(x.snr, DQ_REPEAT_PEAK_SNR_DB - 0.01)
							: x.snr
						const local = x.weak
							? x.local
							: Math.max(x.local, DQ_REPEAT_LOCAL_SNR_DB)
						const promoted = p.repeated(
							pass(`o${i}`, snr, { centreHz: CH + x.bucket * 2_500, local }),
						)
						if (x.weak) expect(promoted).toBe(false)
						const entries = p.repeatEntries("src-1")
						expect(entries.length).toBeLessThanOrEqual(DQ_REPEAT_PER_SOURCE)
						for (const e of entries) {
							expect(e.samples.length).toBeLessThanOrEqual(DQ_REPEAT_SAMPLES)
							expect(new Set(e.samples.map(s => s.id)).size).toBe(
								e.samples.length,
							)
						}
					})
				},
			),
			{ numRuns: 100 },
		)
	})

	it("never holds more than 512 entries per source (the oldest is evicted)", () => {
		const { clock, p } = holder()
		for (let i = 0; i < DQ_REPEAT_PER_SOURCE + 10; i++) {
			clock.now += 1
			p.repeated(pass(`o${i}`, 11, { centreHz: CH + i * 10_000 }))
		}
		const entries = p.repeatEntries("src-1")
		expect(entries).toHaveLength(DQ_REPEAT_PER_SOURCE)
		expect(entries[0]!.samples[0]!.id).toBe("o10")
	})
})
