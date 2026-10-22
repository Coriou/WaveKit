import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import { createIngestRecorder } from "../../../../src/core/link-burst/recorder.js"
import { createLinkAdvisor } from "../../../../src/core/link-advisory.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { WantedPlacement } from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"

afterEach(() => vi.useRealTimers())

function scenario(stall: number, phase: number, recover = true) {
	vi.useFakeTimers()
	let now = 0
	let total = 0
	const recorder = createIngestRecorder()
	recorder.configure(500, 2)
	const advisor = createLinkAdvisor({ now: () => now })
	const counter = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => new Map([["@absorber", counter]]),
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => now,
		monoNow: () => now,
		ingest: (_id, from, to) => recorder.interval(from, to),
		loopDelay: () => ({ maxMs: 16, p99Ms: 16 }),
		shortfall: () => advisor.shortfall("s", 500, 2),
		recovery: (_id, at) => recorder.recovery(at),
		setInterval: fn => {
			const timer = setInterval(fn, 2000)
			return { cancel: () => clearInterval(timer) }
		},
	})
	const advance = (at: number, bytes: number) => {
		now = at
		recorder.observeChunk(bytes, at)
		total += bytes
	}
	// Five-second metrics end at a configurable phase; none sees catch-up until later.
	for (now = 0; now <= 80000; now += 10) {
		recorder.observeChunk(10, now)
		if ((now + phase) % 5000 === 0) advisor.observe("s", 1000, 500, now)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	const placement: WantedPlacement = {
		key: "dsd-fme",
		decoderId: "dsd-fme",
		sourceId: "s",
		reach: "raw",
		costCores: 0.1,
		sampleRateHz: 500,
		channelHz: null,
		origin: "band",
		primary: true,
	}
	expect(gate.admit(placement, [], now)).toEqual({ admit: true })
	const running = [{ ...placement, admittedAtMs: now }]
	const clean = monitor.cleanAtMono("s")
	const last = 80000
	const arrival = last + stall
	// Poll during the stall, independently of socket arrivals.
	for (now = 80010; now < arrival; now += 10) {
		if ((now + phase) % 5000 === 0) advisor.observe("s", 500, 500, now)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	const metricAt =
		Math.floor((Math.ceil(arrival / 2000) * 2000 + phase) / 5000) * 5000 - phase
	if (metricAt >= arrival) advisor.observe("s", 500, 500, metricAt)
	advance(arrival, 10)
	counter.droppedBytesTotal++
	counter.droppedChunksTotal++
	const tick = Math.ceil(arrival / 2000) * 2000
	now = tick
	monitor.sampleNow()
	if (stall === 5042 && phase === 0)
		expect(advisor.shortfall("s", 500, 2)).toBe(true)
	expect(monitor.droppedSinceMono("s", last)).toBe(false)
	expect(gate.probation(running, now)).toEqual([])
	if (recover) advance(tick + 100, tick + 100 - last - total)
	// total counts only arrivals after the steady period, whose last arrival is the baseline.
	now = tick + 2000
	if (recover) recorder.observeChunk(1900, now)
	else now = arrival + 10000
	const result = monitor.sampleNow().sources.get("s")?.attribution
	if (recover) {
		expect(result).toBe("link")
		expect(monitor.droppedSinceMono("s", last)).toBe(false)
		expect(gate.probation(running, now)).toEqual([])
		expect(monitor.cleanAtMono("s")).toBe(clean)
	}
	if (stall === 5042 && phase === 0) {
		now = 90000
		advisor.observe("s", 1500, 500, now)
		expect(advisor.shortfall("s", 500, 2)).toBe(false)
	}
	monitor.stop()
	return result
}

it("attributes a 5042 ms stall despite the stale half-rate metric", () => {
	expect(scenario(5042, 0)).toBe("link")
})

// Feature: link-burst-resilience, Property 15: Catch-up attribution is independent of metric phase
// Validates: Requirements 3.4, 4.1, 4.3
it("attributes recovered stalls through the ten-second absorber capacity", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 100, max: 10000 }),
			fc.integer({ min: 0, max: 499 }).map(n => n * 10),
			(stall, phase) => {
				scenario(stall, phase)
				vi.useRealTimers()
			},
		),
		{ numRuns: 100 },
	)
})

it("closes a recovered episode between polls before waiting on the next stall", () => {
	const recorder = createIngestRecorder()
	recorder.configure(500, 2)
	let now = 0
	const counter = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => new Map([["@absorber", counter]]),
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => now,
		monoNow: () => now,
		ingest: (_id, from, to) => recorder.interval(from, to),
		loopDelay: () => ({ maxMs: 16, p99Ms: 16 }),
		shortfall: () => false,
		recovery: (_id, at) => recorder.recovery(at),
		setInterval: () => ({ cancel() {} }),
	})
	for (now = 0; now <= 20000; now += 10) {
		recorder.observeChunk(10, now)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	const clean = monitor.cleanAtMono("s")
	now = 22000
	monitor.sampleNow()
	now = 24000
	recorder.observeChunk(10, now)
	counter.droppedBytesTotal++
	monitor.sampleNow()
	recorder.observeChunk(4490, 24500)
	recorder.observeChunk(10, 25500)
	counter.droppedBytesTotal++
	for (now = 25600; now <= 36000; now += 100) {
		recorder.observeChunk(now === 34500 ? 1090 : 100, now)
		if (now % 2000 === 0) {
			monitor.sampleNow()
			expect(monitor.droppedSinceMono("s", 20000)).toBe(false)
		}
	}
	expect(monitor.latestAttribution("s")).toBe("link")
	expect(monitor.cleanAtMono("s")).toBe(clean)
})

it("a recovered successor cannot excuse an expired sustained deficit", () => {
	const recorder = createIngestRecorder()
	recorder.configure(500, 2)
	let now = 0
	const counter = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => new Map([["@absorber", counter]]),
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => now,
		monoNow: () => now,
		ingest: (_id, from, to) => recorder.interval(from, to),
		loopDelay: () => ({ maxMs: 16, p99Ms: 16 }),
		shortfall: () => false,
		recovery: (_id, at) => recorder.recovery(at),
		setInterval: () => ({ cancel() {} }),
	})
	for (now = 0; now <= 20000; now += 10) {
		recorder.observeChunk(10, now)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	for (now = 22000; now <= 24000; now += 2000) monitor.sampleNow()
	recorder.observeChunk(10, 24500)
	counter.droppedBytesTotal++
	for (now = 24510; now <= 34400; now += 10) {
		recorder.observeChunk(10, now)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	// The old deficit expires exactly as a new, fully delivered 100 ms gap arrives.
	recorder.observeChunk(100, 34500)
	for (now = 34510; now <= 36000; now += 10) recorder.observeChunk(10, now)
	now = 36000
	expect(monitor.sampleNow().sources.get("s")?.attribution).toBe("unknown")
	expect(monitor.droppedSinceMono("s", 20000)).toBe(true)
	expect(monitor.cleanAtMono("s")).toBeNull()
})

it("late catch-up between polls cannot erase an expired deficit", () => {
	const recorder = createIngestRecorder()
	recorder.configure(500, 2)
	let now = 0
	const counter = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => new Map([["@absorber", counter]]),
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => now,
		monoNow: () => now,
		ingest: (_id, from, to) => recorder.interval(from, to),
		loopDelay: () => ({ maxMs: 16, p99Ms: 16 }),
		shortfall: () => false,
		recovery: (_id, at) => recorder.recovery(at),
		setInterval: () => ({ cancel() {} }),
	})
	for (now = 0; now <= 20000; now += 10) {
		recorder.observeChunk(10, now)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	for (now = 22000; now <= 24000; now += 2000) monitor.sampleNow()
	recorder.observeChunk(10, 24500)
	counter.droppedBytesTotal++
	for (now = 24510; now <= 34400; now += 10) {
		recorder.observeChunk(10, now)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	for (now = 34410; now <= 34990; now += 10) recorder.observeChunk(10, now)
	// Recovery deadline was 34500. Late catch-up and a successor both occur between polls.
	recorder.observeChunk(5000, 35000)
	recorder.observeChunk(100, 35100)
	for (now = 35110; now <= 36000; now += 10) recorder.observeChunk(10, now)
	expect(recorder.recovery(36000)?.failedSequence).toBeGreaterThan(0)
	now = 36000
	expect(monitor.sampleNow().sources.get("s")?.attribution).toBe("unknown")
	expect(monitor.droppedSinceMono("s", 20000)).toBe(true)
	expect(monitor.cleanAtMono("s")).toBeNull()
})
