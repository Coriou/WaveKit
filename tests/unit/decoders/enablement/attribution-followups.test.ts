import { describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import type { Logger } from "../../../../src/utils/logger.js"
import {
	attributeInterval,
	type IntervalEvidence,
} from "../../../../src/decoders/enablement/attribution.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import {
	HOST_LOOP_DELAY_MS,
	LINK_GAP_MS,
} from "../../../../src/core/link-burst/contract.js"

const GUARD = 90

const evidence = (
	overrides: Partial<IntervalEvidence> = {},
): IntervalEvidence => ({
	complete: true,
	branchDrops: new Map([
		["heavy", 1],
		["light", 0],
	]),
	absorberOverflow: 0,
	maxGapMs: 0,
	loopDelayMaxMs: 0,
	cpuPercent: 10,
	cpuGuardPercent: GUARD,
	shortfall: false,
	upstreamDropDelta: 0,
	...overrides,
})

describe("host versus consumer for a strict subset", () => {
	it.each([
		// [label, overrides, expected]
		["healthy host, one slow sink", {}, "consumer"],
		["CPU one below the guard", { cpuPercent: GUARD - 1 }, "consumer"],
		["CPU at the guard", { cpuPercent: GUARD }, "host"],
		["CPU past the guard", { cpuPercent: GUARD + 1 }, "host"],
		[
			"loop delay one below the host bound",
			{ loopDelayMaxMs: HOST_LOOP_DELAY_MS - 1 },
			"consumer",
		],
		[
			"loop delay at the host bound",
			{ loopDelayMaxMs: HOST_LOOP_DELAY_MS },
			"host",
		],
		[
			"host overload, two of three dropping",
			{
				cpuPercent: 100,
				branchDrops: new Map([
					["heavy", 5],
					["chan", 5],
					["light", 0],
				]),
			},
			"host",
		],
		[
			"host overload, CPU unknown but loop starved",
			{ cpuPercent: null, loopDelayMaxMs: HOST_LOOP_DELAY_MS },
			"host",
		],
		["healthy loop, CPU unknown", { cpuPercent: null }, "consumer"],
		[
			"host overload with upstream loss",
			{ cpuPercent: 100, upstreamDropDelta: 1 },
			"unknown",
		],
		[
			"healthy host with upstream loss keeps consumer precedence",
			{ upstreamDropDelta: 1 },
			"consumer",
		],
	] as const)("%s", (_label, overrides, expected) => {
		expect(attributeInterval(evidence(overrides))).toBe(expected)
	})

	// Feature: link-burst-resilience, Property 7: Attribution rules (host overload subset)
	// Validates: Requirements 3.3, 3.5, 3.6
	it("a strict subset is consumer exactly without host evidence", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1000 }), {
					minLength: 2,
					maxLength: 8,
				}),
				fc.integer({ min: 0, max: 100 }),
				fc.integer({ min: 0, max: 2 * HOST_LOOP_DELAY_MS }),
				fc.integer({ min: 0, max: 2 }),
				(drops, cpu, loop, upstream) => {
					const positive = drops.filter(n => n > 0).length
					fc.pre(positive > 0 && positive < drops.length)
					const keys = drops.map((_, i) => `b${i}#0`)
					const host = cpu >= GUARD || loop >= HOST_LOOP_DELAY_MS
					const result = attributeInterval(
						evidence({
							branchDrops: new Map(keys.map((k, i) => [k, drops[i]!])),
							cpuPercent: cpu,
							loopDelayMaxMs: loop,
							upstreamDropDelta: upstream,
						}),
					)
					if (!host) expect(result).toBe("consumer")
					else expect(result).toBe(upstream > 0 ? "unknown" : "host")
					expect(result).not.toBe("link")
				},
			),
			{ numRuns: 300 },
		)
	})
})

describe("upstream loss forces unknown", () => {
	// Feature: link-burst-resilience, Property 7: Attribution rules (upstream unknown)
	// Validates: Requirements 3.4, 3.6
	it("core drops on every branch or overflow with upstream loss are unknown, whatever the host or link evidence", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.boolean(),
				fc.integer({ min: 1, max: 1_000_000 }),
				fc.integer({ min: 0, max: 10_000 }),
				fc.integer({ min: 0, max: 2 * HOST_LOOP_DELAY_MS }),
				fc.integer({ min: 0, max: 100 }),
				fc.option(fc.boolean(), { nil: null }),
				(branches, overflow, upstream, gap, loop, cpu, shortfall) => {
					const drops = new Map(
						Array.from({ length: branches }, (_, i) => [`b${i}`, 1] as const),
					)
					expect(
						attributeInterval(
							evidence({
								branchDrops: overflow ? new Map() : drops,
								absorberOverflow: overflow ? 1 : 0,
								maxGapMs: gap,
								loopDelayMaxMs: loop,
								cpuPercent: cpu,
								shortfall,
								upstreamDropDelta: upstream,
							}),
						),
					).toBe("unknown")
				},
			),
			{ numRuns: 200 },
		)
	})

	it.each([
		[0, "link"],
		[1, "unknown"],
		[2, "unknown"],
	])("upstream delta %i on a clear link burst gives %s", (upstream, code) => {
		expect(
			attributeInterval(
				evidence({
					branchDrops: new Map([
						["a", 1],
						["b", 1],
					]),
					maxGapMs: LINK_GAP_MS,
					upstreamDropDelta: upstream,
				}),
			),
		).toBe(code)
	})

	it("upstream loss without core drops is none", () => {
		expect(
			attributeInterval(
				evidence({ branchDrops: new Map([["a", 0]]), upstreamDropDelta: 9 }),
			),
		).toBe("none")
	})
})

const harness = (
	overrides: Partial<Parameters<typeof createEfficiencyMonitor>[0]> = {},
) => {
	let mono = 0
	let gap = 0
	let loop = 0
	let cpu = 10
	let upstream: number | null = 0
	const branches = new Map<
		string,
		{
			droppedBytesTotal: number
			droppedChunksTotal: number
			active?: boolean
		}
	>([
		["heavy#0", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
		["light#0", { droppedBytesTotal: 0, droppedChunksTotal: 0 }],
	])
	const cpuReader = {
		get normalisedPercent() {
			return cpu
		},
	}
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () => branches,
		topology: () => "fixed",
		cpu: cpuReader,
		cpuGuardPercent: GUARD,
		now: () => 0,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
		ingest: () => ({ maxGapMs: gap, catchupBytes: 0, chunks: 1 }),
		loopDelay: () => ({ maxMs: loop, p99Ms: 0 }),
		shortfall: () => false,
		upstreamDroppedTotal: () => upstream,
		log: { info: vi.fn() } as unknown as Logger,
		...overrides,
	})
	return {
		monitor,
		branches,
		set(v: { gap?: number; loop?: number; cpu?: number }) {
			gap = v.gap ?? gap
			loop = v.loop ?? loop
			cpu = v.cpu ?? cpu
		},
		upstream(n: number | null) {
			upstream = n
		},
		drop(...keys: string[]) {
			for (const key of keys) {
				const value = branches.get(key)!
				value.droppedBytesTotal += 65536
				value.droppedChunksTotal++
			}
		},
		tick(at: number) {
			mono = at
			return monitor.sampleNow().sources.get("s")?.attribution
		},
	}
}

describe("monitor: host-overload subset and upstream evidence", () => {
	it("a slow sink on a healthy host stays consumer", () => {
		const h = harness()
		h.tick(0)
		h.tick(2000)
		h.drop("heavy#0")
		expect(h.tick(4000)).toBe("consumer")
	})

	it("host overload with a surviving light branch is host, and consumer again once the host recovers", () => {
		const h = harness()
		h.tick(0)
		h.tick(2000)
		h.set({ cpu: 100 })
		h.drop("heavy#0")
		expect(h.tick(4000)).toBe("host")
		h.set({ cpu: GUARD - 1, loop: HOST_LOOP_DELAY_MS })
		h.drop("heavy#0")
		expect(h.tick(6000)).toBe("host")
		h.set({ loop: 0 })
		h.drop("heavy#0")
		expect(h.tick(8000)).toBe("consumer")
	})

	it("an upstream rise coinciding with an all-branch link burst is unknown, not link", () => {
		const h = harness()
		h.upstream(100)
		h.tick(0)
		h.tick(2000)
		// Control: the same burst with flat upstream is link.
		h.set({ gap: LINK_GAP_MS + 100 })
		h.drop("heavy#0", "light#0")
		expect(h.tick(4000)).toBe("link")
		h.set({ gap: 0 })
		h.tick(6000)
		h.set({ gap: LINK_GAP_MS + 100 })
		h.upstream(101)
		h.drop("heavy#0", "light#0")
		expect(h.tick(8000)).toBe("unknown")
		expect(h.monitor.droppedSinceMono("s", 8000)).toBe(true)
		expect(h.monitor.linkDropsSince("s", 8000)).toBe(false)
	})

	it("upstream loss outranks host evidence and the host-overload subset", () => {
		const h = harness()
		h.upstream(0)
		h.tick(0)
		h.tick(2000)
		h.set({ cpu: 100 })
		h.upstream(3)
		h.drop("heavy#0", "light#0")
		expect(h.tick(4000)).toBe("unknown")
		h.upstream(4)
		h.drop("heavy#0")
		expect(h.tick(6000)).toBe("unknown")
	})

	it("upstream loss with no core drop is none", () => {
		const h = harness()
		h.upstream(0)
		h.tick(0)
		h.tick(2000)
		h.upstream(50)
		expect(h.tick(4000)).toBe("none")
	})

	it("upstream loss during a held gap loss resolves it unknown, not link", () => {
		const recovery = {
			sequence: 1,
			completedSequence: 0,
			failedSequence: 0,
			maxGapMs: 5042,
			shortfall: null as boolean | null,
		}
		const h = harness({ recovery: () => ({ ...recovery }) })
		h.upstream(0)
		h.tick(0)
		h.tick(2000)
		h.set({ gap: 5042, loop: 16 })
		h.drop("heavy#0", "light#0")
		h.tick(4000)
		h.set({ gap: 0, loop: 0 })
		h.upstream(7)
		recovery.shortfall = false
		recovery.completedSequence = 1
		expect(h.tick(6000)).toBe("unknown")
		expect(h.monitor.linkDropsSince("s", 0)).toBe(false)
		expect(h.monitor.droppedSinceMono("s", 0)).toBe(true)
	})
})
