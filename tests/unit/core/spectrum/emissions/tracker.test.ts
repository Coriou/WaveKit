import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import type { Segment } from "../../../../../src/core/spectrum/emissions/segmenter.js"
import { Tracker } from "../../../../../src/core/spectrum/emissions/tracker.js"
import type { TrackerBlock } from "../../../../../src/core/spectrum/emissions/tracker.js"
import {
	binPowerDb,
	POWER_FLOOR_DB,
	powerScale,
} from "../../../../../src/core/spectrum/fft.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../../src/core/spectrum/types.js"

/** The open-track field these tests read. */
interface OpenEnv {
	envSum: number
}

const N = 256
const BIN_HZ = 1000
const CENTRE = 446_100_000
const FLOOR = -60
const BLOCK = 12_800

function tracker(
	over: Partial<ConstructorParameters<typeof Tracker>[0]> = {},
): Tracker {
	const t = new Tracker({
		sourceId: "s1",
		binHz: BIN_HZ,
		blockMs: 50,
		hangBlocks: 3,
		maxTracks: 4,
		maxTrackBlocks: 100,
		idPrefix: "t",
		...over,
	})
	t.beginEpoch({
		stream: 1,
		epoch: 1,
		centreHz: CENTRE,
		tuningTrust: "commanded",
	})
	return t
}
/** A block whose PSD carries flat emissions `[startBin, endBin, dBFS]`. */
function block(
	index: number,
	emissions: [number, number, number][],
	over: Partial<TrackerBlock> = {},
): { segs: Segment[]; b: TrackerBlock } {
	const powerDb = new Float32Array(N).fill(FLOOR)
	const floorDb = new Float32Array(N).fill(FLOOR)
	for (const [a, e, db] of emissions)
		for (let i = a; i < e; i++) powerDb[i] = db
	const on = new Uint8Array(N)
	for (let i = 0; i < N; i++) on[i] = (powerDb[i] ?? 0) > FLOOR + 4 ? 1 : 0
	const segs = segment(on, powerDb, floorDb, {
		gapBins: 2,
		usableStartBin: 26,
		usableEndBin: 231,
		exclusionEdges: [],
		rasterBinEdges: [],
		skirtDb: 30,
		inWindow: false,
	})
	return {
		segs,
		b: {
			endSample: (index + 1) * BLOCK,
			powerDb,
			floorDb,
			blockFloorDb: FLOOR,
			thresholdDb: 4,
			gap: false,
			overload: false,
			...over,
		},
	}
}
function run(
	t: Tracker,
	index: number,
	emissions: [number, number, number][],
	over: Partial<TrackerBlock> = {},
): PipelineEvent[] {
	const { segs, b } = block(index, emissions, over)
	return t.block(segs, b)
}
function tracksOf(
	events: PipelineEvent[],
	kind: "track-open" | "track-update" | "track-close",
): TrackSnapshot[] {
	return events.flatMap(e => (e.kind === kind ? [e.track] : []))
}

describe("Tracker", () => {
	it("opens, updates at 2 blocks, and closes quiet after the hang", () => {
		const t = tracker()
		const opened = tracksOf(run(t, 0, [[140, 149, -20]]), "track-open")
		expect(opened).toHaveLength(1)
		expect(opened[0]!.blocks).toBe(1)
		expect(opened[0]!.startSample).toBe(0)
		const updated = tracksOf(run(t, 1, [[140, 149, -20]]), "track-update")
		expect(updated.map(u => u.blocks)).toEqual([2])
		expect(run(t, 2, [])).toEqual([])
		expect(run(t, 3, [])).toEqual([])
		const closing = run(t, 4, [])
		expect(closing).toHaveLength(1)
		const c = closing[0]!
		expect(c.kind === "track-close" && c.endReason).toBe("quiet")
		if (c.kind !== "track-close") return
		expect(c.track.lastSample).toBe(2 * BLOCK)
		expect(c.track.centreHz).toBeCloseTo(CENTRE + (144 - N / 2) * BIN_HZ, 0)
		expect(c.track.obwHz).toBe(9000)
		expect(c.track.obwMethod).toBe("-20dB")
		expect(c.track.peakDbfs).toBe(-20)
		expect(c.track.maxBlockSnrDb).toBe(40)
		expect(c.track.snrDb).toBeCloseTo(40, 1)
		expect(c.track.floorDbfs).toBe(FLOOR)
		expect(c.track.spectralShape).toBe("flat")
		expect(c.track.tuningTrust).toBe("commanded")
	})

	it("measureFrom restarts an open track's centre from a later sample (blocks before it no longer count)", () => {
		const t = tracker()
		// Two blocks centred on bin 140.5, then the same emission (overlapping) on bin 144.5.
		const id = tracksOf(run(t, 0, [[136, 146, -20]]), "track-open")[0]!.trackId
		run(t, 1, [[136, 146, -20]])
		// Another epoch's or stream's request, and one not past the start, change nothing.
		t.measureFrom({ stream: 1, epoch: 2, trackId: id, sample: 2 * BLOCK })
		t.measureFrom({ stream: 2, epoch: 1, trackId: id, sample: 2 * BLOCK })
		t.measureFrom({ stream: 1, epoch: 1, trackId: id, sample: 0 })
		const mixed = t.snapshotOf(id)!
		expect(mixed.measuredFromSample).toBeUndefined()
		expect(mixed.centreHz).toBeCloseTo(CENTRE + (140.5 - N / 2) * BIN_HZ, 0)
		t.measureFrom({ stream: 1, epoch: 1, trackId: id, sample: 2 * BLOCK })
		run(t, 2, [[140, 150, -20]])
		const update = tracksOf(run(t, 3, [[140, 150, -20]]), "track-update")
		const after = update.at(-1) ?? t.snapshotOf(id)!
		expect(after.trackId).toBe(id)
		expect(after.measuredFromSample).toBe(2 * BLOCK)
		// Only the blocks after the request: bin 144.5, not the mean over all four (142.5).
		expect(after.centreHz).toBeCloseTo(CENTRE + (144.5 - N / 2) * BIN_HZ, 0)
		// Without the request the centre would mix all four blocks.
		const plain = tracker()
		const pid = tracksOf(run(plain, 0, [[136, 146, -20]]), "track-open")[0]!
			.trackId
		run(plain, 1, [[136, 146, -20]])
		run(plain, 2, [[140, 150, -20]])
		run(plain, 3, [[140, 150, -20]])
		expect(plain.snapshotOf(pid)!.centreHz).toBeCloseTo(
			CENTRE + (142.5 - N / 2) * BIN_HZ,
			0,
		)
	})

	it("measureFrom publishes the track once its restarted measurement holds a whole block, not at the next periodic update", () => {
		// Updates fall on blocks 2, 5 (class settle), 20 and every 20th: blocks 4 and 6 have none.
		const t = tracker()
		const plain = tracker()
		const id = tracksOf(run(t, 0, [[140, 150, -20]]), "track-open")[0]!.trackId
		run(plain, 0, [[140, 150, -20]])
		for (const i of [1, 2]) {
			run(t, i, [[140, 150, -20]])
			run(plain, i, [[140, 150, -20]])
		}
		// The engine asks at the newest block it saw (2), already accumulated: from block 3 on.
		t.measureFrom({ stream: 1, epoch: 1, trackId: id, sample: 2 * BLOCK })
		const first = tracksOf(run(t, 3, [[140, 150, -20]]), "track-update")
		expect(first).toHaveLength(1)
		expect(first[0]!.trackId).toBe(id)
		expect(first[0]!.measuredFromSample).toBe(3 * BLOCK)
		expect(first[0]!.lastSample - first[0]!.measuredFromSample!).toBe(BLOCK)
		// Without the request, block 4 publishes nothing; and the update comes once, not per block.
		expect(tracksOf(run(plain, 3, [[140, 150, -20]]), "track-update")).toEqual(
			[],
		)
		run(t, 4, [[140, 150, -20]])
		expect(tracksOf(run(t, 5, [[140, 150, -20]]), "track-update")).toEqual([])
	})

	it("measureFrom restarts the width and shape claims too: OBW (-20 dB and on-bins) from the blocks past the request only", () => {
		// The same emission, wide on the blocks before the request, narrow after it (strong: -20 dB
		// OBW from the mean spectrum over the on-bin span; weak: the widest block's on-bins).
		for (const [db, method] of [
			[-20, "-20dB"],
			[-50, "on-bins"],
		] as const) {
			const t = tracker()
			const id = tracksOf(run(t, 0, [[120, 160, db]]), "track-open")[0]!.trackId
			run(t, 1, [[120, 160, db]])
			t.measureFrom({ stream: 1, epoch: 1, trackId: id, sample: 2 * BLOCK })
			run(t, 2, [[140, 147, db]])
			run(t, 3, [[140, 147, db]])
			const after = t.snapshotOf(id)!
			expect(after.measuredFromSample).toBe(2 * BLOCK)
			expect(after.obwMethod).toBe(method)
			expect(after.obwHz).toBe(7000)
			// The same narrow blocks alone (never wide) read the same.
			const plain = tracker()
			const pid = tracksOf(run(plain, 0, [[140, 147, db]]), "track-open")[0]!
				.trackId
			run(plain, 1, [[140, 147, db]])
			expect(plain.snapshotOf(pid)!.obwHz).toBe(after.obwHz)
			expect(plain.snapshotOf(pid)!.spectralShape).toBe(after.spectralShape)
		}
	})

	it("reports on-bin width below 20 dB SNR", () => {
		const t = tracker()
		run(t, 0, [[140, 147, -50]])
		const closing = [...run(t, 1, []), ...run(t, 2, []), ...run(t, 3, [])]
		const c = tracksOf(closing, "track-close")[0]!
		expect(c.obwMethod).toBe("on-bins")
		expect(c.obwHz).toBe(7000)
	})

	it("never holds more than maxTracks open; the rest are transients", () => {
		const t = tracker({ maxTracks: 2 })
		const ev = run(t, 0, [
			[60, 66, -20],
			[100, 106, -25],
			[150, 156, -30],
		])
		expect(tracksOf(ev, "track-open")).toHaveLength(2)
		expect(t.openCount).toBe(2)
		const transients = ev.filter(e => e.kind === "transient")
		expect(transients).toHaveLength(1)
		expect(
			transients[0]!.kind === "transient" && transients[0]!.centreHz,
		).toBeCloseTo(CENTRE + (152.5 - N / 2) * BIN_HZ, 0)
	})

	it("turns a truncated new segment into a transient and makes truncation sticky on an open track", () => {
		const t = tracker()
		const first = run(t, 0, [[26, 30, -20]])
		expect(tracksOf(first, "track-open")).toHaveLength(0)
		expect(first.some(e => e.kind === "transient")).toBe(true)
		run(t, 1, [[40, 49, -20]])
		const widened = run(t, 2, [[27, 49, -20]])
		const upd = tracksOf(widened, "track-update")
		expect(upd).toHaveLength(1)
		expect(upd[0]!.flags.truncated).toBe(true)
		run(t, 3, [[40, 49, -20]])
		const closed = tracksOf(
			[...run(t, 4, []), ...run(t, 5, []), ...run(t, 6, [])],
			"track-close",
		)
		expect(closed[0]!.flags.truncated).toBe(true)
	})

	it("does not open tracks in gap blocks and closes with endReason gap after a gap hang", () => {
		const t = tracker()
		expect(
			tracksOf(run(t, 0, [[140, 149, -20]], { gap: true }), "track-open"),
		).toHaveLength(0)
		run(t, 1, [[140, 149, -20]])
		run(t, 2, [], { gap: true })
		run(t, 3, [], { gap: true })
		const ev = run(t, 4, [], { gap: true })
		expect(
			ev.map(e => (e.kind === "track-close" ? e.endReason : e.kind)),
		).toEqual(["gap"])
	})

	it("splits a track at maxTrackBlocks with endReason max-duration and keeps following it", () => {
		const t = tracker({ maxTrackBlocks: 3 })
		run(t, 0, [[140, 149, -20]])
		run(t, 1, [[140, 149, -20]])
		const ev = run(t, 2, [[140, 149, -20]])
		const closed = ev.find(e => e.kind === "track-close")
		const reopened = tracksOf(ev, "track-open")
		expect(closed?.kind === "track-close" && closed.endReason).toBe(
			"max-duration",
		)
		expect(reopened).toHaveLength(1)
		expect(reopened[0]!.trackId).not.toBe(
			closed?.kind === "track-close" ? closed.track.trackId : "",
		)
		expect(reopened[0]!.startSample).toBe(2 * BLOCK)
	})

	it("closes every open track with endReason retune on a new epoch", () => {
		const t = tracker()
		run(t, 0, [
			[60, 66, -20],
			[140, 149, -20],
		])
		const ev = t.beginEpoch({
			stream: 1,
			epoch: 2,
			centreHz: CENTRE + 1e6,
			tuningTrust: "commanded",
		})
		expect(
			ev.map(e => (e.kind === "track-close" ? e.endReason : e.kind)),
		).toEqual(["retune", "retune"])
		expect(t.openCount).toBe(0)
	})

	it("builds a 1 ms envelope from frames and measures the TDMA signature", () => {
		const t = tracker({ hangBlocks: 10 })
		const framePower = new Float64Array(N)
		let last: PipelineEvent[] = []
		for (let blk = 0; blk < 12; blk++) {
			if (blk > 0) {
				for (let f = 0; f < 50; f++) {
					const ms = blk * 50 + f
					const on = ms % 60 < 27.5
					framePower.fill(10 ** (FLOOR / 10))
					for (let i = 140; i < 149; i++)
						framePower[i] = 10 ** ((on ? -20 : FLOOR) / 10)
					t.frame(framePower, 1, ms * 256)
				}
			}
			last = run(t, blk, [[140, 149, -24]])
		}
		const snap = [
			...tracksOf(last, "track-update"),
			...tracksOf(t.closeAll("job-end"), "track-close"),
		].at(-1)!
		expect(snap.acf30).toBeLessThanOrEqual(-0.5)
		expect(snap.acf60).toBeGreaterThanOrEqual(0.5)
		expect(snap.dutyCycle).toBeCloseTo(27.5 / 60, 1)
	})

	describe("Tracker.frame in linear power", () => {
		/** The removed path's per-bin value: powerToDb's Float32 store, then 10 ** (dB / 10). */
		const viaDb = (acc: number, scale: number): number =>
			10 ** (Math.fround(binPowerDb(acc, scale)) / 10)
		const openTrack = (): { t: Tracker; first: () => OpenEnv } => {
			const t = tracker({ hangBlocks: 10 })
			run(t, 0, [[140, 149, -24]])
			return {
				t,
				first: () => (t as unknown as { open: OpenEnv[] }).open[0]!,
			}
		}
		const SCALE = powerScale(N, 1)

		// Feature: spectrum-frame-path, Property 1: linear frame sum within the Float32 dB rounding of the old sum
		// Validates: docs/PERFORMANCE.md, Spectrum frame path
		it("differs from the dB path by at most its Float32 rounding", () => {
			// Half an ulp of a Float32 in [128, 256) is 2⁻¹⁶ / 2 = 7.63e-6 dB, 7.63e-6·ln 10 / 10 =
			// 1.76e-6 relative in power. A sum of positive terms keeps the largest relative error.
			const BOUND = 1.76e-6 + 1e-12
			fc.assert(
				fc.property(
					fc.array(fc.double({ min: -220, max: 40, noNaN: true }), {
						minLength: 9,
						maxLength: 9,
					}),
					dbs => {
						const a = openTrack()
						const b = openTrack()
						const linear = new Float64Array(N)
						const old = new Float64Array(N)
						dbs.forEach((db, k) => {
							const acc = 10 ** (db / 10) / SCALE
							linear[140 + k] = acc
							old[140 + k] = viaDb(acc, SCALE)
						})
						a.t.frame(linear, SCALE, 0)
						b.t.frame(old, 1, 0)
						const x = a.first().envSum
						const y = b.first().envSum
						expect(Math.abs(x - y) / y).toBeLessThanOrEqual(BOUND)
					},
				),
				{ numRuns: 200 },
			)
		})

		it("reads the dB path's floor for NaN, zero, negative and sub-floor sums, and +∞ stays +∞", () => {
			for (const v of [
				Number.NaN,
				0,
				-1,
				1e-300,
				1e-20 / SCALE / 2,
				Number.NEGATIVE_INFINITY,
			]) {
				const { t, first } = openTrack()
				const acc = new Float64Array(N)
				acc[140] = v
				t.frame(acc, SCALE, 0)
				// nine bins: 140 holds `v`, the other eight are 0
				let sum = 0
				for (let k = 0; k < 9; k++) sum += viaDb(k === 0 ? v : 0, SCALE)
				expect(first().envSum).toBe(sum)
				expect(viaDb(0, SCALE)).toBe(10 ** (POWER_FLOOR_DB / 10))
			}
			const { t, first } = openTrack()
			const acc = new Float64Array(N)
			acc[140] = Number.POSITIVE_INFINITY
			t.frame(acc, SCALE, 0)
			expect(first().envSum).toBe(viaDb(Number.POSITIVE_INFINITY, SCALE))
		})

		it("a bin exactly at the floor and one ulp above it", () => {
			const floor = 10 ** (POWER_FLOOR_DB / 10)
			const { t, first } = openTrack()
			const acc = new Float64Array(N)
			acc.fill(floor)
			acc[140] = floor * (1 + Number.EPSILON)
			t.frame(acc, 1, 0)
			let sum = acc[140]!
			for (let k = 0; k < 8; k++) sum += floor
			expect(first().envSum).toBe(sum)
			expect(acc[140]).toBeGreaterThan(floor)
		})
	})

	it("trackBinsMask marks the current bins of tracks with enough blocks", () => {
		const t = tracker()
		run(t, 0, [[60, 66, -20]])
		run(t, 1, [
			[60, 66, -20],
			[140, 149, -20],
		])
		const m = new Uint8Array(N)
		t.trackBinsMask(m, 2)
		expect(Array.from(m.slice(60, 66))).toEqual([1, 1, 1, 1, 1, 1])
		expect(m[140]).toBe(0)
		t.trackBinsMask(m, 1)
		expect(m[140]).toBe(1)
	})
})

describe("tracker channel gate", () => {
	/** One block's measurement. Non-finite SNR is not a measurement. */
	const meas = (channelSnrDb: number, minDurationMs = 300) => ({
		channelSnrDb,
		kDb: 3,
		marginDb: 3,
		minDurationMs,
		valid: Number.isFinite(channelSnrDb),
	})

	it("stays pending until the track's own blocks meet 300 ms", () => {
		const t = tracker()
		t.setGatePlan(true)
		const first = run(t, 0, [[140, 149, -20]])
		const id = tracksOf(first, "track-open")[0]!.trackId
		t.publishGate(() => meas(20), first, 0)
		expect(t.snapshotOf(id)?.gate).toBe("pending")
		for (let i = 1; i < 4; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(20), ev, 0)
		}
		// 4 × 50 ms is 200 ms. One block of the slot's history does not count.
		const snap = t.snapshotOf(id)
		expect(snap?.gate).toBe("pending")
		expect(snap?.gatePassedSample).toBeUndefined()
	})

	it("omits gate fields when no plan is set", () => {
		const t = tracker()
		const open = tracksOf(run(t, 0, [[100, 110, -40]]), "track-open")[0]!
		expect("gate" in open).toBe(false)
		expect("channelSnrDb" in open).toBe(false)
		expect("gatePassedSample" in open).toBe(false)
	})

	it("ignores setGate until a plan is set", () => {
		const t = tracker()
		const open = tracksOf(run(t, 0, [[100, 110, -40]]), "track-open")[0]!
		t.setGate(open.trackId, meas(9))
		const snap = t.snapshotOf(open.trackId)!
		expect("gate" in snap).toBe(false)
	})

	it("keeps passed sticky and reports the latest finite measurement", () => {
		const t = tracker()
		t.setGatePlan(true)
		let id = ""
		for (let i = 0; i < 6; i++) {
			const ev = run(t, i, [[100, 110, -40]])
			if (i === 0) id = tracksOf(ev, "track-open")[0]!.trackId
			t.publishGate(() => meas(7.5), ev, 0)
		}
		const ev = run(t, 6, [[100, 110, -40]])
		t.publishGate(() => meas(1.2), ev, 0)
		expect(t.snapshotOf(id)).toMatchObject({
			gate: "passed",
			channelSnrDb: 1.2,
			gatePassedSample: 6 * BLOCK,
		})
	})

	it("omits a non-finite channel SNR and closes a never-passed track below", () => {
		const t = tracker()
		t.setGatePlan(true)
		const open = tracksOf(run(t, 0, [[100, 110, -40]]), "track-open")[0]!
		for (const snr of [
			Number.NEGATIVE_INFINITY,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		])
			t.setGate(open.trackId, meas(snr))
		const pending = t.snapshotOf(open.trackId)!
		expect(pending.gate).toBe("pending")
		expect("channelSnrDb" in pending).toBe(false)
		const closed = [...run(t, 1, []), ...run(t, 2, []), ...run(t, 3, [])]
		const close = tracksOf(closed, "track-close")[0]!
		expect(close.gate).toBe("below")
		expect("channelSnrDb" in close).toBe(false)
		expect("gatePassedSample" in close).toBe(false)
	})

	it("closes a passed track still passed, with the original sample", () => {
		const t = tracker()
		t.setGatePlan(true)
		let id = ""
		for (let i = 0; i < 6; i++) {
			const ev = run(t, i, [[100, 110, -40]])
			if (i === 0) id = tracksOf(ev, "track-open")[0]!.trackId
			t.publishGate(() => meas(8), ev, 0)
		}
		expect(t.snapshotOf(id)?.gatePassedSample).toBe(6 * BLOCK)
		const closed = [...run(t, 6, []), ...run(t, 7, []), ...run(t, 8, [])]
		const close = tracksOf(closed, "track-close")[0]!
		expect(close.gate).toBe("passed")
		expect(close.gatePassedSample).toBe(6 * BLOCK)
		expect(close.channelSnrDb).toBe(8)
	})

	it("a second off ends the run, so later on blocks start again", () => {
		const t = tracker({ hangBlocks: 6 })
		t.setGatePlan(true)
		let id = ""
		const step = (i: number, on: boolean) => {
			const ev = run(t, i, on ? [[140, 149, -20]] : [])
			if (i === 0) id = tracksOf(ev, "track-open")[0]!.trackId
			t.publishGate(() => meas(20), ev, 0)
		}
		for (let i = 0; i < 2; i++) step(i, true)
		step(2, false)
		step(3, false)
		for (let i = 4; i < 8; i++) step(i, true)
		expect(t.snapshotOf(id)?.gate).toBe("pending")
		expect(t.snapshotOf(id)?.gatePassedSample).toBeUndefined()
	})

	it("does not give a new track the pass of an earlier emission in the slot", () => {
		const t = tracker({ hangBlocks: 12 })
		t.setGatePlan(true)
		const at = (hz: number) => meas(hz < CENTRE + 25_000 ? 20 : 2.6)
		let strongId = ""
		for (let i = 0; i < 8; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(hz => at(hz), ev, 0)
			if (i === 0) strongId = tracksOf(ev, "track-open")[0]!.trackId
			if (i === 5) {
				expect(t.snapshotOf(strongId)).toMatchObject({
					gate: "passed",
					gatePassedSample: 6 * BLOCK,
				})
			}
		}
		const ev = run(t, 8, [[160, 169, -45]])
		const extra = t.publishGate(hz => at(hz), ev, 0)
		const opened = tracksOf(ev, "track-open")
		expect(opened).toHaveLength(1)
		const neu = opened[0]!
		expect(neu.blocks).toBe(1)
		expect(neu.gate).toBe("pending")
		expect(neu.channelSnrDb).toBe(2.6)
		expect("gatePassedSample" in neu).toBe(false)
		expect(neu.startSample).toBeGreaterThan(6 * BLOCK)
		expect(
			[...tracksOf(extra, "track-update"), neu].some(
				u => u.trackId === neu.trackId && u.gate === "passed",
			),
		).toBe(false)
		expect(t.snapshotOf(strongId)?.gate).toBe("passed")
	})

	it("does not paint a hanging or closed track with a later emission's pass", () => {
		const t = tracker({ hangBlocks: 10 })
		t.setGatePlan(true)
		const opened = run(t, 0, [[140, 149, -20]])
		t.publishGate(() => meas(4), opened, 0)
		const aId = tracksOf(opened, "track-open")[0]!.trackId
		for (let i = 1; i <= 4; i++) {
			const ev = run(t, i, [])
			t.publishGate(() => meas(18), ev, 0)
			const hanging = t.snapshotOf(aId)
			expect(hanging?.gate).toBe("pending")
			expect("gatePassedSample" in (hanging ?? {})).toBe(false)
		}
		let bId = ""
		for (let i = 5; i <= 10; i++) {
			const ev = run(t, i, [[180, 189, -20]])
			const extra = t.publishGate(() => meas(18), ev, 0)
			if (i === 5) bId = tracksOf(ev, "track-open")[0]!.trackId
			if (i < 10) expect(t.snapshotOf(aId)?.gate).toBe("pending")
			if (i !== 10) continue
			const closed = tracksOf(ev, "track-close")
			expect(closed).toHaveLength(1)
			const a = closed[0]!
			expect(a.trackId).toBe(aId)
			expect(a.gate).toBe("below")
			expect(a.lastSample).toBe(BLOCK)
			expect("gatePassedSample" in a).toBe(false)
			const b = t.snapshotOf(bId)
			expect(b?.gate).toBe("passed")
			expect(b?.gatePassedSample).toBe(11 * BLOCK)
			expect(b?.startSample).toBe(5 * BLOCK)
			expect(b!.gatePassedSample).toBeGreaterThanOrEqual(b!.startSample)
			expect(b!.gatePassedSample).toBeLessThanOrEqual(b!.lastSample)
			expect(
				tracksOf(extra, "track-update").some(
					u => u.trackId === aId && u.gate === "passed",
				),
			).toBe(false)
		}
	})

	it("a tolerated off block keeps the run but does not count toward the duration", () => {
		// DQ 1.8 changed this: the tolerated off used to complete the 300 ms pass.
		const t = tracker({ hangBlocks: 4 })
		t.setGatePlan(true)
		let id = ""
		for (let i = 0; i < 5; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			if (i === 0) id = tracksOf(ev, "track-open")[0]!.trackId
			t.publishGate(() => meas(20), ev, 0)
		}
		expect(t.snapshotOf(id)?.gate).toBe("pending")
		// 5 strong × 50 ms is 250 ms. The miss is the one tolerated off: the run lives on.
		const off = run(t, 5, [])
		let calls = 0
		t.publishGate(
			() => {
				calls++
				return meas(20)
			},
			off,
			0,
		)
		expect(calls).toBe(1)
		expect(t.snapshotOf(id)?.gate).toBe("pending")
		// The sixth strong block reaches 300 ms and passes.
		t.publishGate(() => meas(20), run(t, 6, [[140, 149, -20]]), 0)
		expect(t.snapshotOf(id)).toMatchObject({
			gate: "passed",
			gatePassedSample: 7 * BLOCK,
		})
	})

	it("a passed rollover successor starts passed at its first sample", () => {
		const t = tracker({ maxTrackBlocks: 8 })
		t.setGatePlan(true)
		let opened: TrackSnapshot | undefined
		let closed: TrackSnapshot | undefined
		for (let i = 0; i < 8; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(20), ev, 0)
			if (i !== 7) continue
			closed = tracksOf(ev, "track-close")[0]
			opened = tracksOf(ev, "track-open")[0]
		}
		expect(closed?.gate).toBe("passed")
		expect(opened?.gate).toBe("passed")
		expect(opened?.gatePassedSample).toBe(opened?.startSample)
		expect(opened?.startSample).toBe(7 * BLOCK)
	})

	it("a continuous rollover keeps the emission's observed blocks", () => {
		const t = tracker({ maxTrackBlocks: 4 })
		t.setGatePlan(true)
		let successor = ""
		for (let i = 0; i < 6; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(20), ev, 0)
			if (i === 3) {
				const neu = tracksOf(ev, "track-open")[0]!
				successor = neu.trackId
				expect(neu.gate).not.toBe("passed")
				expect(neu.blocks).toBe(1)
			}
		}
		// Three of its own blocks. The predecessor's count is what meets 300 ms.
		const snap = t.snapshotOf(successor)
		expect(snap?.blocks).toBe(3)
		expect(snap?.gate).toBe("passed")
		expect(snap?.gatePassedSample).toBe(6 * BLOCK)
	})

	it("a rollover across a gap starts a fresh run", () => {
		const t = tracker({ maxTrackBlocks: 4 })
		t.setGatePlan(true)
		for (let i = 0; i < 3; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(20), ev, 0)
		}
		t.noteGateBreak()
		let successor = ""
		for (let i = 3; i < 6; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(20), ev, 0)
			if (i !== 3) continue
			successor = tracksOf(ev, "track-open")[0]!.trackId
		}
		expect(t.snapshotOf(successor)?.blocks).toBe(3)
		expect(t.snapshotOf(successor)?.gate).toBe("pending")
		expect(t.snapshotOf(successor)?.gatePassedSample).toBeUndefined()
	})

	it("a second off before rollover does not hand the pass to the successor", () => {
		const t = tracker({ maxTrackBlocks: 10 })
		t.setGatePlan(true)
		let closed: TrackSnapshot | undefined
		let opened: TrackSnapshot | undefined
		for (let i = 0; i < 10; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(i < 6 ? 8 : 1), ev, 0)
			if (i !== 9) continue
			closed = tracksOf(ev, "track-close")[0]
			opened = tracksOf(ev, "track-open")[0]
		}
		expect(closed?.gate).toBe("passed")
		expect(closed?.gatePassedSample).toBe(6 * BLOCK)
		expect(opened?.gate).toBe("pending")
		expect(opened?.gatePassedSample).toBeUndefined()
		expect(opened?.startSample).toBe(9 * BLOCK)
	})

	it("a fresh run after an invalid block qualifies the successor on its own", () => {
		const t = tracker({ maxTrackBlocks: 10, hangBlocks: 4 })
		t.setGatePlan(true)
		let predecessor = ""
		let successor = ""
		let pred: TrackSnapshot | undefined
		const invalid = {
			channelSnrDb: Number.NaN,
			kDb: 3,
			marginDb: 3,
			minDurationMs: 300,
			valid: false,
		}
		for (let i = 0; i < 13; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			if (i === 0) predecessor = tracksOf(ev, "track-open")[0]!.trackId
			t.publishGate(() => (i === 6 ? invalid : meas(8)), ev, 0)
			if (i !== 9) continue
			pred = tracksOf(ev, "track-close")[0]
			const neu = tracksOf(ev, "track-open")[0]!
			successor = neu.trackId
			expect(neu.gate).toBe("pending")
			expect(neu.gatePassedSample).toBeUndefined()
		}
		expect(pred?.trackId).toBe(predecessor)
		expect(pred?.gate).toBe("passed")
		expect(pred?.gatePassedSample).toBe(6 * BLOCK)
		const snap = t.snapshotOf(successor)
		expect(snap?.gate).toBe("passed")
		// The invalid block ended the passed run. The fresh run's sixth on-block
		// is this successor's third, at the end of block 13.
		expect(snap?.gatePassedSample).toBe(13 * BLOCK)
		expect(snap?.gatePassedSample).toBeGreaterThan(snap?.startSample ?? 0)
		const quiet = [
			...run(t, 13, []),
			...run(t, 14, []),
			...run(t, 15, []),
			...run(t, 16, []),
		]
		const succClose = tracksOf(quiet, "track-close").find(
			c => c.trackId === successor,
		)
		expect(succClose?.gate).toBe("passed")
		expect(succClose?.gatePassedSample).toBe(13 * BLOCK)
	})

	it("an invalid rollover block opens the successor on a fresh run", () => {
		const t = tracker({ maxTrackBlocks: 8 })
		t.setGatePlan(true)
		const invalid = {
			channelSnrDb: Number.NaN,
			kDb: 3,
			marginDb: 3,
			minDurationMs: 300,
			valid: false,
		}
		let opened: TrackSnapshot | undefined
		let closed: TrackSnapshot | undefined
		for (let i = 0; i < 8; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => (i === 7 ? invalid : meas(8)), ev, 0)
			if (i !== 7) continue
			closed = tracksOf(ev, "track-close")[0]
			opened = tracksOf(ev, "track-open")[0]
		}
		expect(closed?.gate).toBe("passed")
		expect(closed?.gatePassedSample).toBe(6 * BLOCK)
		expect(opened?.gate).toBe("pending")
		expect(opened?.gatePassedSample).toBeUndefined()
		for (let i = 8; i < 13; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(8), ev, 0)
		}
		expect(t.snapshotOf(opened?.trackId ?? "")?.gate).toBe("pending")
		const ev = run(t, 13, [[140, 149, -20]])
		t.publishGate(() => meas(8), ev, 0)
		const snap = t.snapshotOf(opened?.trackId ?? "")
		expect(snap?.gate).toBe("passed")
		expect(snap?.gatePassedSample).toBe(14 * BLOCK)
	})

	it("a successor whose own channel measures invalid does not inherit the run", () => {
		const t = tracker({ maxTrackBlocks: 8 })
		t.setGatePlan(true)
		const invalid = {
			channelSnrDb: Number.NaN,
			kDb: 3,
			marginDb: 3,
			minDurationMs: 300,
			valid: false,
		}
		let first: number | null = null
		// Valid near the predecessor's centre, invalid (masked) a few bins away.
		const gateOf = (centreHz: number) => {
			first ??= centreHz
			return Math.abs(centreHz - first) > 3 * BIN_HZ ? invalid : meas(8)
		}
		let opened: TrackSnapshot | undefined
		let closed: TrackSnapshot | undefined
		for (let i = 0; i < 8; i++) {
			// On the rollover block the emission shifts so the successor's own
			// geometry lands on the masked channel.
			const ev = run(t, i, [i === 7 ? [146, 152, -20] : [140, 149, -20]])
			t.publishGate(gateOf, ev, 0)
			if (i !== 7) continue
			closed = tracksOf(ev, "track-close")[0]
			opened = tracksOf(ev, "track-open")[0]
		}
		expect(closed?.gate).toBe("passed")
		expect(opened).toBeDefined()
		expect(t.snapshotOf(opened?.trackId ?? "")?.gate).toBe("pending")
	})

	it("keeps no predecessor reference across rollovers without a plan", () => {
		const t = tracker({ maxTrackBlocks: 3 })
		for (let i = 0; i < 101; i++) run(t, i, [[140, 149, -20]])
		const open = (t as unknown as { open: { rolloverFrom: unknown }[] }).open
		expect(open.length).toBe(1)
		expect(open[0]?.rolloverFrom).toBeNull()
	})

	it("paints a pass that lands on the block a track closes", () => {
		const t = tracker({ maxTrackBlocks: 6 })
		t.setGatePlan(true)
		let close: TrackSnapshot | undefined
		let opened: TrackSnapshot | undefined
		for (let i = 0; i < 6; i++) {
			const ev = run(t, i, [[140, 149, -20]])
			t.publishGate(() => meas(20), ev, 0)
			if (i !== 5) continue
			close = tracksOf(ev, "track-close")[0]
			opened = tracksOf(ev, "track-open")[0]
		}
		expect(close?.blocks).toBe(6)
		expect(close?.gate).toBe("passed")
		expect(close?.gatePassedSample).toBe(6 * BLOCK)
		expect(opened?.gate).toBe("passed")
		// The pass landed on this shared block, after the successor opened.
		expect(opened?.gatePassedSample).toBe(6 * BLOCK)
		expect(opened?.gatePassedSample).toBeGreaterThan(opened?.startSample ?? 0)
	})
})

it("publishes early classification snapshots and the existing cadence", () => {
	const t = tracker()
	const updates: number[] = []
	for (let i = 0; i < 41; i++)
		for (const e of run(t, i, [[100, 110, -30]]))
			if (e.kind === "track-update") updates.push(e.track.blocks)
	expect(updates).toEqual([2, 5, 20, 40])
})
