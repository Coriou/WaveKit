import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import type { SpectrumFrameEventData } from "@wavekit/api-types"
import type { EngineEpoch } from "../../../../src/core/spectrum/spectrum-engine.js"
import type { BlockSummary } from "../../../../src/core/spectrum/types.js"
import { makeProfile } from "../../../../src/core/spectrum/spectrum-averaging.js"
import {
	appendSummary,
	buildBackfillFrames,
	limitBackfillFrames,
	liveFrames,
	normaliseBackfillMs,
	spectrumFrameJsonLength,
	summaryRingCapacity,
	type SummaryStamp,
} from "../../../../src/core/spectrum/spectrum-backfill.js"
import { BACKFILL_LIMITS } from "../../../../src/core/spectrum/subscribe-options.js"

function epochOf(stream: number, epoch: number, centreHz: number): EngineEpoch {
	return {
		stream,
		epoch,
		startSample: 0,
		centreHz,
		sampleRateHz: 1_024_000,
		gainKey: "na",
		tuningTrust: "commanded",
		settleMode: "none",
	}
}

function stamp(opts: {
	stream?: number
	epoch?: number
	atMs: number
	bins: number[]
	centreHz?: number
	floorDbfs?: number
	tracks?: BlockSummary["tracks"]
}): SummaryStamp {
	const stream = opts.stream ?? 0
	const epoch = opts.epoch ?? 1
	const centreHz = opts.centreHz ?? 446_000_000
	const summary: BlockSummary = {
		sourceId: "rtl",
		stream,
		epoch,
		endSample: opts.atMs,
		centreHz,
		sampleRateHz: 1_024_000,
		binHz: 1000,
		startHz: centreHz - 8_000,
		bins: opts.bins,
		floorDbfs: opts.floorDbfs ?? -90,
		thresholdDb: 10,
		tracks: opts.tracks ?? [],
		masks: { dcHz: centreHz, dcGuardHz: 1500, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
	return { summary, epoch: epochOf(stream, epoch, centreHz), atMs: opts.atMs }
}

function bytesOf(frames: readonly SpectrumFrameEventData[]): number {
	return frames.reduce((sum, frame) => sum + spectrumFrameJsonLength(frame), 0)
}

describe("spectrum backfill", () => {
	it("rounds and clamps backfillMs", () => {
		expect(normaliseBackfillMs(undefined)).toEqual({ ms: 0, adjusted: false })
		expect(normaliseBackfillMs(0)).toEqual({ ms: 0, adjusted: false })
		expect(normaliseBackfillMs(1500)).toEqual({ ms: 1500, adjusted: false })
		expect(normaliseBackfillMs(1500.4)).toEqual({ ms: 1500, adjusted: true })
		expect(normaliseBackfillMs(-20)).toEqual({ ms: 0, adjusted: true })
		expect(normaliseBackfillMs(50_000)).toEqual({
			ms: BACKFILL_LIMITS.maxMs,
			adjusted: true,
		})
	})

	it("sizes the ring from the integration period and drops by age, capacity and epoch", () => {
		expect(summaryRingCapacity(50)).toBe(Math.ceil(10_000 / 50) + 1)
		expect(summaryRingCapacity(1000)).toBe(11)
		const ring: SummaryStamp[] = []
		for (let i = 0; i < 20; i++)
			appendSummary(ring, stamp({ atMs: i, bins: [-80] }), 1000, 100)
		expect(ring).toHaveLength(11)
		expect(ring[0]!.atMs).toBe(9)
		expect(ring.at(-1)!.atMs).toBe(19)

		const aged: SummaryStamp[] = []
		appendSummary(aged, stamp({ atMs: 0, bins: [-80] }), 50, 10_000)
		appendSummary(aged, stamp({ atMs: 10_000, bins: [-70] }), 50, 20_000)
		expect(aged.map(s => s.atMs)).toEqual([10_000])

		const cleared: SummaryStamp[] = []
		appendSummary(cleared, stamp({ epoch: 1, atMs: 1, bins: [-80] }), 50, 1)
		appendSummary(cleared, stamp({ epoch: 2, atMs: 2, bins: [-70] }), 50, 2)
		expect(cleared.map(s => s.summary.epoch)).toEqual([2])
		appendSummary(
			cleared,
			stamp({ stream: 3, epoch: 2, atMs: 3, bins: [-60] }),
			50,
			3,
		)
		expect(cleared.map(s => s.summary.stream)).toEqual([3])
	})

	it("drops the oldest frames once the JSON budget is exceeded and keeps the newest", () => {
		const frames = Array.from(
			{ length: 5 },
			(_, i) =>
				({
					sourceId: "rtl",
					profile: "25:2048",
					epoch: 1,
					tuningTrust: "commanded",
					centerHz: i,
					sampleRateHz: 1,
					binHz: 1,
					nativeBinHz: 1,
					startHz: 0,
					binCount: 1,
					bins: "AA==",
					binEncoding: "u8-halfdb-127.5",
					floorDbfs: i,
					thresholdDb: 1,
					tracks: [],
					masks: { dcHz: 0, dcGuardHz: 0, spurRanges: [] },
					backfill: true,
					at: new Date(i).toISOString(),
				}) satisfies SpectrumFrameEventData,
		)
		const one = spectrumFrameJsonLength(frames[0]!)
		const kept = limitBackfillFrames(frames, 4, one * 2)
		expect(kept.map(f => f.floorDbfs)).toEqual([3, 4])
		expect(bytesOf(kept)).toBeLessThanOrEqual(one * 2)
	})

	it("drops oldest backfill frames to satisfy the 512 KiB cap", () => {
		const tracks = Array.from({ length: 80 }, (_, i) => ({
			startHz: i,
			endHz: i + 1,
			flags: { burst: false, iqImage: false, edge: false },
		}))
		const ring: SummaryStamp[] = []
		for (let i = 0; i < 70; i++)
			ring.push(
				stamp({
					atMs: 1_000 + i,
					bins: Array.from({ length: 32 }, () => -80),
					floorDbfs: i,
					tracks,
				}),
			)
		const frames = buildBackfillFrames({
			ring,
			now: 2_000,
			backfillMs: 10_000,
			stream: 0,
			epoch: 1,
			snapshot: null,
			profile: makeProfile(25, 2048),
			sourceId: "rtl",
			integrationMs: 50,
			sampleRateHz: 1_024_000,
			fftSize: 1024,
		})
		expect(frames.length).toBeGreaterThan(0)
		expect(frames.length).toBeLessThan(70)
		expect(bytesOf(frames)).toBeLessThanOrEqual(BACKFILL_LIMITS.maxBytes)
		expect(frames.at(-1)?.floorDbfs).toBe(69)
		expect(frames[0]?.floorDbfs).toBeGreaterThan(0)
	})

	// Feature: web-gaps-1, Property 1: Backfill bounds and order
	// Validates: Requirements 1.2, 1.3, 1.4, 1.5
	it("keeps backfill inside the window, the epoch, 64 frames and 512 KiB, oldest first", () => {
		const stampArb = fc
			.record({
				stream: fc.integer({ min: 0, max: 2 }),
				epoch: fc.integer({ min: 1, max: 3 }),
				age: fc.integer({ min: 0, max: 12_000 }),
				floor: fc.integer({ min: -120, max: -10 }),
				bin: fc.double({
					min: -100,
					max: -1,
					noNaN: true,
					noDefaultInfinity: true,
				}),
			})
			.map(({ stream, epoch, age, floor, bin }) =>
				stamp({
					stream,
					epoch,
					atMs: 100_000 - age,
					bins: [bin, -80],
					centreHz: stream === 0 && epoch === 1 ? 446_000_000 : 100_000,
					floorDbfs: floor,
				}),
			)
		fc.assert(
			fc.property(
				fc.array(stampArb, { minLength: 0, maxLength: 40 }),
				fc.integer({ min: 0, max: 10_000 }),
				(ring, backfillMs) => {
					const snapshot = stamp({
						atMs: 100_000,
						bins: [-50, -80],
						floorDbfs: -7,
					})
					const ordered = [...ring].sort((a, b) => a.atMs - b.atMs)
					const frames = buildBackfillFrames({
						ring: [...ordered, snapshot],
						now: 100_000,
						backfillMs,
						stream: 0,
						epoch: 1,
						snapshot: snapshot.summary,
						profile: makeProfile(25, 128),
						sourceId: "rtl",
						integrationMs: 50,
						sampleRateHz: 1_024_000,
						fftSize: 1024,
					})
					expect(frames.length).toBeLessThanOrEqual(BACKFILL_LIMITS.maxFrames)
					expect(bytesOf(frames)).toBeLessThanOrEqual(BACKFILL_LIMITS.maxBytes)
					let prev = -Infinity
					for (const frame of frames) {
						expect(frame.backfill).toBe(true)
						expect(frame.snapshot).toBeUndefined()
						expect(frame.epoch).toBe(1)
						expect(frame.centerHz).toBe(446_000_000)
						const at = Date.parse(frame.at)
						expect(at).toBeGreaterThanOrEqual(100_000 - backfillMs)
						expect(at).toBeGreaterThanOrEqual(prev)
						expect(frame.floorDbfs).not.toBe(-7)
						prev = at
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-1, Property 2: Backfill equals live
	// Validates: Requirements 1.3
	it("matches live frames when both are aligned from the newest completed run", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5 }),
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: 1, max: 8 }),
				fc.array(
					fc.array(
						fc.double({
							min: -110,
							max: -5,
							noNaN: true,
							noDefaultInfinity: true,
						}),
						{ minLength: 4, maxLength: 4 },
					),
					{ minLength: 31, maxLength: 31 },
				),
				(n, k, averaging, binPool) => {
					const count = k * n + 1
					const stamps = Array.from({ length: count }, (_, i) =>
						stamp({ atMs: 1_000 + i * 50, bins: binPool[i]! }),
					)
					const profile = makeProfile(20 / n, 32, averaging)
					const live = liveFrames(stamps, profile, "rtl", 50, 1_024_000, 1024)
					const backfill = buildBackfillFrames({
						ring: stamps,
						now: stamps.at(-1)!.atMs,
						backfillMs: 10_000,
						stream: 0,
						epoch: 1,
						snapshot: stamps.at(-1)!.summary,
						profile,
						sourceId: "rtl",
						integrationMs: 50,
						sampleRateHz: 1_024_000,
						fftSize: 1024,
					})
					expect(live).toHaveLength(Math.floor(stamps.length / n))
					expect(backfill).toHaveLength(k)
					for (let i = 0; i < k; i++) {
						expect(backfill[i]!.bins).toBe(live[i]!.bins)
						expect(backfill[i]!.at).toBe(live[i]!.at)
						expect(backfill[i]!.backfill).toBe(true)
						expect(live[i]!.backfill).toBeUndefined()
					}
					expect(
						backfill.some(
							f => f.at === new Date(stamps.at(-1)!.atMs).toISOString(),
						),
					).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	})
})
