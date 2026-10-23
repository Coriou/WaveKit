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
		// Seed complete, lossless history before exercising paced fanout.
		recorder.observeChunk(65536, now)
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
		const deadline = missingRecovery ? 12200 : 10000 - phase
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

function intervalScenario(initialCpu = 10, initialLoop = 15) {
	let includeSibling = true
	let now = 0
	let shortfall: boolean | null = null
	let sequence = 1
	let gap = 1000
	let cpu = initialCpu
	let loop = initialLoop
	const totals = { absorber: 0, absorberChunks: 0, a: 0 }
	const log = createLogger({ level: "fatal" })
	const logs = vi.spyOn(log, "info")
	const monitor = createEfficiencyMonitor({
		log,
		sources: () => ["s"],
		branchCounters: () =>
			new Map([
				[
					"@absorber",
					{
						droppedBytesTotal: totals.absorber,
						droppedChunksTotal: totals.absorberChunks,
					},
				],
				["a", { droppedBytesTotal: totals.a, droppedChunksTotal: 0 }],
				...(includeSibling
					? [["b", { droppedBytesTotal: 0, droppedChunksTotal: 0 }] as const]
					: []),
			]),
		topology: () => "fixed",
		cpu: {
			get normalisedPercent() {
				return cpu
			},
		},
		now: () => now,
		monoNow: () => now,
		ingest: () => ({ maxGapMs: gap, catchupBytes: 0, chunks: 100 }),
		loopDelay: () => ({ maxMs: loop, p99Ms: loop }),
		shortfall: () => true,
		recovery: () => ({
			sequence,
			completedSequence: 0,
			failedSequence: 0,
			maxGapMs: 1000,
			shortfall,
		}),
		setInterval: () => ({ cancel() {} }),
	})
	const tick = (at: number) => {
		now = at
		return monitor.sampleNow().sources.get("s")!
	}
	for (now = 0; now <= 16000; now += 2000) monitor.sampleNow()
	totals.absorber = 100
	totals.absorberChunks = 3
	tick(18000)
	return {
		removeSibling: () => {
			includeSibling = false
		},
		evidence: (nextGap: number, nextCpu: number) => {
			loop = 15
			gap = nextGap
			cpu = nextCpu
		},
		monitor,
		tick,
		totals,
		logs,
		recover: (value: boolean | null, nextSequence = sequence) => {
			shortfall = value
			sequence = nextSequence
		},
	}
}

it("keeps independent consumer loss in its original late window during pending recovery", () => {
	const h = intervalScenario()
	h.tick(20000)
	h.totals.a = 7
	expect(h.tick(22000)).toMatchObject({
		attribution: "consumer",
		droppedBytesDelta: 7,
	})
	h.recover(false)
	expect(h.tick(24000)).toMatchObject({
		attribution: "link",
		droppedBytesDelta: 100,
	})
	for (const at of [26000, 28000, 30000]) h.tick(at)
	expect(h.monitor.lateWindows("s").slice(-2)).toEqual([
		expect.objectContaining({
			startMono: 10000,
			endMono: 20000,
			condemning: false,
			linkOrUnknownDrops: true,
		}),
		expect.objectContaining({
			startMono: 20000,
			endMono: 30000,
			condemning: true,
		}),
	])
	h.monitor.stop()
})

it("resolves expired overflow independently of a concurrent consumer loss", () => {
	const h = intervalScenario()
	h.tick(20000)
	h.totals.a = 7
	h.recover(true)
	expect(h.tick(22000)).toMatchObject({
		attribution: "consumer",
		droppedBytesDelta: 7,
	})
	expect(h.logs).toHaveBeenCalledWith(
		expect.objectContaining({
			attribution: "unknown",
			dropBytes: 100,
			intervalMono: 18000,
		}),
		"Drop interval attributed",
	)
	expect(h.logs).toHaveBeenCalledWith(
		expect.objectContaining({
			attribution: "consumer",
			dropBytes: 7,
			intervalMono: 22000,
		}),
		"Drop interval attributed",
	)
	expect(h.monitor.droppedBetweenMono("s", 18000, 18000)).toBe(true)
	expect(h.monitor.droppedBetweenMono("s", 22000, 22000)).toBe(true)
	for (const at of [24000, 26000, 28000, 30000]) h.tick(at)
	expect(h.monitor.lateWindows("s").slice(-2)).toEqual([
		expect.objectContaining({
			startMono: 10000,
			endMono: 20000,
			condemning: false,
			linkOrUnknownDrops: true,
		}),
		expect.objectContaining({
			startMono: 20000,
			endMono: 30000,
			condemning: true,
		}),
	])
	h.monitor.stop()
})

it("rate limits completed recovery logs when a new loss arrives on the same tick", () => {
	const h = intervalScenario()
	h.recover(false)
	h.totals.absorber++
	h.tick(20000)
	h.recover(null, 2)
	h.totals.absorber += 100
	h.tick(22000)
	h.recover(false)
	h.totals.absorber++
	h.tick(24000)
	const links = h.logs.mock.calls.filter(
		([fields, message]) =>
			message === "Drop interval attributed" &&
			typeof fields === "object" &&
			fields !== null &&
			"attribution" in fields &&
			fields.attribution === "link",
	)
	expect(links).toHaveLength(1)
	h.monitor.stop()
})

it("retains every deferred loss timestamp across late-window boundaries", () => {
	const h = intervalScenario()
	const unknown = h.monitor.attributionCounts("s")!.counts10m.unknown
	h.tick(20000)
	h.totals.absorber += 100
	h.tick(22000)
	h.recover(true)
	h.tick(24000)
	expect(h.monitor.attributionCounts("s")!.counts10m.unknown).toBe(unknown + 2)
	expect(h.monitor.droppedBetweenMono("s", 18000, 18000)).toBe(true)
	expect(h.monitor.droppedBetweenMono("s", 22000, 22000)).toBe(true)
	for (const at of [26000, 28000, 30000]) h.tick(at)
	expect(h.monitor.lateWindows("s").slice(-2)).toEqual([
		expect.objectContaining({
			startMono: 10000,
			endMono: 20000,
			linkOrUnknownDrops: true,
		}),
		expect.objectContaining({
			startMono: 20000,
			endMono: 30000,
			linkOrUnknownDrops: true,
		}),
	])
	h.monitor.stop()
})

it.each([false, true])(
	"bounds rapid-poll deferred losses, overflow=%s",
	overflow => {
		const h = intervalScenario()
		for (let i = 1; i <= (overflow ? 8 : 7); i++) {
			h.totals.absorber++
			h.tick(18000 + i * 100)
		}
		expect(h.monitor.droppedSinceMono("s", 18000)).toBe(overflow)
		h.recover(false)
		h.tick(19000)
		expect(h.monitor.droppedSinceMono("s", 18000)).toBe(overflow)
		expect(h.monitor.latestAttribution("s")).toBe(overflow ? "unknown" : "link")
		h.monitor.stop()
	},
)

it.each([10, 95])(
	"does not lend a pending gap to an independent loss at CPU %i",
	cpu => {
		const h = intervalScenario()
		h.tick(20000)
		h.evidence(0, cpu)
		h.totals.absorber += 7
		const code = cpu === 95 ? "host" : "unknown"
		expect(h.tick(22000)).toMatchObject({
			attribution: code,
			droppedBytesDelta: 7,
		})
		expect(h.monitor.droppedBetweenMono("s", 22000, 22000)).toBe(true)
		h.recover(false)
		expect(h.tick(24000)).toMatchObject({
			attribution: "link",
			droppedBytesDelta: 100,
		})
		expect(h.monitor.attributionCounts("s")!.counts10m.link).toBe(1)
		expect(h.monitor.attributionCounts("s")!.counts10m.host).toBe(
			cpu === 95 ? 1 : 0,
		)
		for (const at of [26000, 28000, 30000]) h.tick(at)
		expect(h.monitor.lateWindows("s").slice(-2)).toEqual([
			expect.objectContaining({
				startMono: 10000,
				endMono: 20000,
				condemning: false,
				linkOrUnknownDrops: true,
			}),
			expect.objectContaining({
				startMono: 20000,
				endMono: 30000,
				condemning: cpu === 95,
				linkOrUnknownDrops: cpu !== 95,
			}),
		])
		h.monitor.stop()
	},
)

it("uses each deferred interval's own host evidence when recovery fails", () => {
	const h = intervalScenario()
	h.tick(20000)
	h.evidence(240, 95)
	h.totals.absorber += 7
	expect(h.tick(22000).droppedBytesDelta).toBeNull()
	h.recover(true)
	expect(h.tick(24000)).toMatchObject({
		attribution: "host",
		droppedBytesDelta: 7,
	})
	expect(h.logs).toHaveBeenCalledWith(
		expect.objectContaining({
			attribution: "unknown",
			dropBytes: 100,
			intervalMono: 18000,
		}),
		"Drop interval attributed",
	)
	expect(h.logs).toHaveBeenCalledWith(
		expect.objectContaining({
			attribution: "host",
			dropBytes: 7,
			intervalMono: 22000,
		}),
		"Drop interval attributed",
	)
	h.monitor.stop()
})

it("keeps original deferred deltas when recovery resolves during an incomparable read", () => {
	const h = intervalScenario()
	h.removeSibling()
	h.recover(false)
	expect(h.tick(20000)).toMatchObject({
		attribution: "unknown",
		droppedBytesDelta: 100,
		droppedChunksDelta: 3,
	})
	h.monitor.stop()
})

it.each([
	[90, 15],
	[10, 100],
])(
	"resolves deferred loss using original host evidence CPU %i loop %i",
	(cpu, loop) => {
		const h = intervalScenario(cpu, loop)
		h.evidence(0, 10)
		h.recover(false)
		expect(h.tick(20000)).toMatchObject({
			attribution: "host",
			droppedBytesDelta: 100,
		})
		expect(h.monitor.droppedBetweenMono("s", 18000, 18000)).toBe(true)
		h.monitor.stop()
	},
)
