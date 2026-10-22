import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { createBurstAbsorber } from "../../../../src/core/link-burst/absorber.js"
import { createIngestRecorder } from "../../../../src/core/link-burst/recorder.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { WantedPlacement } from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"

afterEach(() => vi.useRealTimers())

function scenario(
	stall: number,
	phase: number,
	recover = true,
	missingRecovery = false,
	pastDeadline = 0,
) {
	vi.useFakeTimers()
	let now = 0
	let recoveryAvailable = true
	const recorder = createIngestRecorder()
	recorder.configure(2048000, 2)
	const log = createLogger({ level: "fatal" })
	const logs = vi.spyOn(log, "info")
	const fanout = new FanoutManager(log)
	const sibling = fanout.addBranch({ id: "sibling", highWaterMark: 262144 })
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => now,
		log,
		recorder,
	})
	absorber.configure(8192000)
	const monitor = createEfficiencyMonitor({
		log,
		sources: () => ["s"],
		branchCounters: () =>
			new Map([
				[
					"@absorber",
					{
						droppedBytesTotal: absorber.counters().overflowBytesTotal,
						droppedChunksTotal: absorber.counters().overflowChunksTotal,
					},
				],
			]),
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => now,
		monoNow: () => now,
		ingest: (_id, from, to) => recorder.interval(from, to),
		loopDelay: () => ({ maxMs: 15, p99Ms: 15 }),
		shortfall: () => true,
		recovery: (_id, at) => (recoveryAvailable ? recorder.recovery(at) : null),
		setInterval: () => ({ cancel() {} }),
	})
	const block = Buffer.alloc(65536)
	const ingest = (bytes: number) => {
		recorder.observeChunk(bytes, now)
		absorber.ingest(bytes === block.length ? block : Buffer.alloc(bytes))
	}
	for (now = 0; now <= 80000; now += 16) {
		sibling.read()
		ingest(65536)
		if (now % 2000 === 0) monitor.sampleNow()
	}
	now = 80000
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
		sampleRateHz: 2048000,
		channelHz: null,
		origin: "band",
		primary: true,
	}
	expect(gate.admit(placement, [], now)).toEqual({ admit: true })
	const running = [{ ...placement, admittedAtMs: now }]
	const clean = monitor.cleanAtMono("s")
	const coverage = monitor.coveredSinceMono("s", 0)
	const windows = monitor.lateWindows("s")
	// The first catch-up arrival precedes the poll; the rest is still blocked
	// behind paced delivery. The recorder cannot prove byte recovery yet.
	const pendingAt = 80000 + stall + phase
	for (
		now = pendingAt - Math.floor((stall + phase) / 2000) * 2000;
		now < 80000 + stall;
		now += 2000
	) {
		if (now > 80000) monitor.sampleNow()
	}
	now = 80000 + stall
	for (let bytes = Math.max(16, stall - 300) * 4096; bytes > 0; bytes -= 65536)
		ingest(Math.min(bytes, 65536))
	const drop = absorber.counters().overflowBytesTotal
	if (drop === 0) {
		// The property only needs a verdict when the bounded absorber loses bytes.
		expect(monitor.droppedSinceMono("s", 80000)).toBe(false)
		absorber.dispose()
		fanout.destroy()
		monitor.stop()
		return
	}
	now = pendingAt
	const pending = monitor.sampleNow().sources.get("s")!
	expect(pending.droppedBytesDelta).toBeNull()
	expect(monitor.latestAttribution("s")).toBeNull()
	expect(monitor.droppedSinceMono("s", 80000)).toBe(false)
	expect(gate.probation(running, now)).toEqual([])
	expect(monitor.coverageCompleteAtMono("s", 0, coverage)).toBeNull()
	expect(monitor.cleanAtMono("s")).toBe(clean)
	if (recover) {
		// Drain at twice nominal while the remaining source backlog arrives.
		for (let elapsed = 16; elapsed <= 512; elapsed += 16) {
			now = pendingAt + elapsed
			sibling.read(131072)
			vi.advanceTimersByTime(16)
			ingest(65536)
		}
		ingest((stall + phase + 512) * 4096)
		now = pendingAt + 2000
		const resolved = monitor.sampleNow().sources.get("s")!
		expect(resolved.attribution).toBe("link")
		const attributed = logs.mock.calls.filter(
			([, message]) => message === "Drop interval attributed",
		)
		let resolvedBytes = 0
		for (const [fields] of attributed) {
			expect(fields).toMatchObject({ attribution: "link" })
			if (
				typeof fields === "object" &&
				fields !== null &&
				"dropBytes" in fields &&
				typeof fields.dropBytes === "number"
			)
				resolvedBytes += fields.dropBytes
		}
		expect(resolvedBytes).toBeGreaterThanOrEqual(drop)
		expect(monitor.droppedSinceMono("s", 80000)).toBe(false)
		expect(gate.probation(running, now)).toEqual([])
		expect(monitor.cleanAtMono("s")).toBe(clean)
	} else {
		recoveryAvailable = !missingRecovery
		const deadline = missingRecovery ? 12080 : 10000 - phase
		for (now = pendingAt + 2000; now < pendingAt + deadline; now += 2000) {
			monitor.sampleNow()
			expect(monitor.lateWindows("s")).toEqual(windows)
		}
		now = pendingAt + deadline - 1
		expect(monitor.sampleNow().sources.get("s")!.droppedBytesDelta).toBeNull()
		expect(monitor.droppedSinceMono("s", 80000)).toBe(false)
		now = pendingAt + deadline + pastDeadline
		const resolved = monitor.sampleNow().sources.get("s")!
		expect(resolved.attribution).toBe("unknown")
		expect(resolved.droppedBytesDelta).toBe(drop)
		expect(monitor.droppedSinceMono("s", 80000)).toBe(true)
		expect(gate.probation(running, now)).toHaveLength(1)
		expect(monitor.cleanAtMono("s")).toBeNull()
	}
	absorber.dispose()
	fanout.destroy()
	monitor.stop()
}

it("resolves paced 2.5 second overflow with its original bytes", () =>
	scenario(2500, 100))
it("retains link attribution for a four second overflow", () =>
	scenario(4000, 0))
it("condemns an unrecovered deficit at its recovery deadline", () =>
	scenario(2500, 100, false))

it.each([0, 1])(
	"fails closed at the bounded deadline plus %i when recovery evidence disappears",
	past => {
		scenario(2500, 100, false, true, past)
	},
)

// Feature: link-burst-resilience, Property 16: Deferred overflow retains recovered link evidence
// Validates: Requirements 3.4, 4.1, 4.3, 4.4
it("resolves recovered overflow across stall lengths and tick phases", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 100, max: 4000 }),
			fc.integer({ min: 0, max: 1999 }),
			(stall, phase) => scenario(stall, phase),
		),
		{ numRuns: 100 },
	)
}, 30000)
