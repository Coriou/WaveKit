import { describe, it, expect } from "vitest"
import { createIngestRecorder } from "../../../../src/core/link-burst/recorder.js"

describe("IngestRecorder", () => {
	it("reports the exact worst gap for the open-ended percentile bucket", () => {
		const r = createIngestRecorder()
		r.observeChunk(1, 0)
		r.observeChunk(1, 60000)
		expect(r.window(60000)).toMatchObject({
			gapP99Ms: 60000,
			worstStallMs: 60000,
		})
	})
	it("counts oversized chunks in the last size bucket", () => {
		const r = createIngestRecorder()
		r.observeChunk(70000, 0)
		const { chunkSizeCounts } = r.histograms(0)
		expect(chunkSizeCounts.at(-1)).toBe(1)
		expect(chunkSizeCounts.reduce((a, b) => a + b, 0)).toBe(1)
	})
	it("rejects intervals overwritten when a reporting read closes catch-up", () => {
		const r = createIngestRecorder()
		r.observeChunk(1, 0)
		r.observeChunk(1, 400)
		r.observeChunk(1, 15900)
		r.window(16400)
		expect(r.interval(250, 500)).toBeNull()
	})
	it("retains exactly the oldest cell at the wraparound boundary", () => {
		const r = createIngestRecorder()
		r.observeChunk(1, 0)
		r.observeChunk(1, 250)
		r.observeChunk(1, 16000)
		expect(r.interval(250, 500)).toEqual({
			maxGapMs: 250,
			chunks: 1,
			catchupBytes: 0,
		})
		expect(r.interval(0, 250)).toBeNull()
	})
	it("resetArrival breaks the gap chain", () => {
		const r = createIngestRecorder()
		r.observeChunk(10, 0)
		r.observeChunk(10, 10)
		r.resetArrival()
		r.observeChunk(10, 10000)
		expect(r.window(10000).worstStallMs).toBe(10)
	})
	it("catch-up counts bytes above nominal after a long gap", () => {
		const r = createIngestRecorder()
		r.configure(1000, 2)
		r.observeChunk(10, 0)
		r.observeChunk(2000, 100)
		r.observeChunk(1000, 200)
		expect(r.window(600).catchupBytes).toBe(2000)
		expect(r.histograms(600).catchupCounts.reduce((a, b) => a + b, 0)).toBe(1)
		expect(r.window(700).catchupBytes).toBe(2000)
	})
	it("interval returns the largest gap ended in range", () => {
		const r = createIngestRecorder()
		expect(r.interval(0, 250)).toBeNull()
		r.observeChunk(1, 0)
		r.observeChunk(1, 100)
		r.observeChunk(1, 400)
		expect(r.interval(250, 500)).toEqual({
			maxGapMs: 300,
			chunks: 1,
			catchupBytes: 0,
		})
		expect(r.interval(0, 17000)).toBeNull()
	})
	it("histograms sums in-window slots and matches window()", () => {
		const r = createIngestRecorder()
		r.observeChunk(32, 0)
		r.observeChunk(64, 10)
		r.resetArrival()
		r.observeChunk(128, 600000)
		r.observeChunk(256, 600020)
		const h = r.histograms(600020)
		expect(h.gapCounts.reduce((a, b) => a + b, 0)).toBe(1)
		expect(h.chunkSizeCounts.reduce((a, b) => a + b, 0)).toBe(
			r.window(600020).chunks,
		)
		expect(r.window(600020).worstStallMs).toBe(20)
	})
	it("configure keeps history and clears pending catch-up", () => {
		const r = createIngestRecorder()
		r.observeChunk(10000, 0)
		r.observeChunk(10000, 100)
		r.configure(1000, 2)
		r.observeChunk(1, 10000)
		expect(r.window(10000)).toMatchObject({
			worstStallMs: 100,
			catchupBytes: 0,
			chunks: 3,
		})
	})
	it("observeChunk allocates nothing", () => {
		const r = createIngestRecorder()
		const feed = (start: number, count: number) => {
			for (let i = start; i < start + count; i++) r.observeChunk(32, i)
		}
		feed(0, 100000)
		const before = process.memoryUsage().heapUsed
		feed(100000, 10000)
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(65536)
	})
})
