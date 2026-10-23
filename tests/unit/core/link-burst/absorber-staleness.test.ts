import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { FakeFanout } from "./fake-fanout.js"
import { createBurstAbsorber } from "../../../../src/core/link-burst/absorber.js"
import { createLogger } from "../../../../src/utils/logger.js"
function setup(frameBytes = 2, capacity = 128) {
	const fanout = new FakeFanout()
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes,
		monoNow: () => fanout.tick,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(capacity)
	return {
		fanout,
		absorber,
		time: (now: number) => {
			fanout.tick = now
		},
	}
}
import { ABSORBER_LAGGARD_MS } from "../../../../src/core/link-burst/contract.js"
import { attributeInterval } from "../../../../src/decoders/enablement/attribution.js"

const evidence = {
	complete: true,
	absorberOverflow: 0,
	maxGapMs: 16,
	loopDelayMaxMs: 1,
	cpuPercent: 10,
	cpuGuardPercent: 80,
	shortfall: false,
	upstreamDropDelta: 0,
}
afterEach(() => vi.useRealTimers())
it.each([500, 501])(
	"excludes a lone consumer at %i ms and returns to pass-through",
	end => {
		vi.useFakeTimers()
		const { fanout, absorber, time } = setup(2, 8_192_000)
		fanout.active.delete("b")
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(65_536))
		time(499)
		vi.advanceTimersByTime(499)
		expect(absorber.counters().heldBytes).toBe(65_536)
		time(500)
		vi.advanceTimersByTime(1)
		time(end)
		expect(absorber.counters().heldBytes).toBe(0)
		expect(fanout.drops.get("a")).toBe(65_536)
		const chunk = Buffer.alloc(2)
		absorber.ingest(chunk)
		expect(fanout.delivered.at(-1)).toBe(chunk)
		expect(attributeInterval({ ...evidence, branchDrops: fanout.drops })).toBe(
			"consumer",
		)
		expect(absorber.counters().window.peakHeldMs).toBe(500)
		absorber.dispose()
	},
)
it("releases all congested branches and retains host attribution evidence", () => {
	vi.useFakeTimers()
	const { fanout, absorber, time } = setup()
	fanout.congest("a")
	fanout.congest("b")
	absorber.ingest(Buffer.alloc(4))
	time(500)
	vi.advanceTimersByTime(500)
	expect(absorber.counters().heldBytes).toBe(0)
	expect([...fanout.drops.values()]).toEqual([4, 4])
	expect(
		attributeInterval({
			...evidence,
			loopDelayMaxMs: 60,
			branchDrops: fanout.drops,
		}),
	).toBe("host")
	expect(attributeInterval({ ...evidence, branchDrops: fanout.drops })).toBe(
		"unknown",
	)
	absorber.dispose()
})
// Feature: link-burst-resilience, Property 6: Bounded holding under arbitrary congestion
// Validates: Requirements 1.5, 9.2
it("bounds held age even when congestion rotates between branches", () => {
	vi.useFakeTimers()
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					delta: fc.integer({ min: 0, max: 700 }),
					a: fc.boolean(),
					b: fc.boolean(),
				}),
				{ minLength: 1, maxLength: 12 },
			),
			actions => {
				vi.setSystemTime(0)
				const fanout = new FakeFanout()
				const absorber = createBurstAbsorber({
					fanout,
					frameBytes: 2,
					monoNow: () => Date.now(),
					log: createLogger({ level: "fatal" }),
					recorder: null,
				})
				absorber.configure(4096)
				let holdingStart: number | null = null
				for (const action of actions) {
					vi.advanceTimersByTime(action.delta)
					if (absorber.counters().heldBytes === 0) holdingStart = null
					if (holdingStart !== null)
						expect(Date.now() - holdingStart).toBeLessThan(ABSORBER_LAGGARD_MS)
					expect(absorber.counters().window.peakHeldMs).toBeLessThanOrEqual(
						ABSORBER_LAGGARD_MS,
					)
					for (const [id, congested] of [
						["a", action.a],
						["b", action.b],
					] as const) {
						if (congested) fanout.congest(id)
						else fanout.drain(id)
					}
					if (absorber.counters().heldBytes === 0) holdingStart = null
					absorber.ingest(Buffer.alloc(2))
					if (absorber.counters().heldBytes > 0) holdingStart ??= Date.now()
				}
				absorber.dispose()
			},
		),
		{ numRuns: 100 },
	)
})

it("counts released lone-branch drops through FanoutManager", () => {
	vi.useFakeTimers()
	let now = 0
	const log = createLogger({ level: "fatal" })
	const fanout = new FanoutManager(log)
	fanout.addBranch({ id: "slow", highWaterMark: 2 })
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => now,
		log,
		recorder: null,
	})
	absorber.configure(8_192_000)
	absorber.ingest(Buffer.alloc(4))
	absorber.ingest(Buffer.alloc(65_536))
	expect(fanout.getBranchTelemetry("slow")?.droppedBytesTotal).toBe(0)
	now = 500
	vi.advanceTimersByTime(500)
	expect(absorber.counters().heldBytes).toBe(0)
	expect(fanout.getBranchTelemetry("slow")?.droppedBytesTotal).toBe(65_536)
	absorber.ingest(Buffer.alloc(2))
	expect(fanout.getBranchTelemetry("slow")?.droppedBytesTotal).toBe(65_538)
	absorber.dispose()
	fanout.destroy()
})

it.each([
	{ maxGapMs: null },
	{ loopDelayMaxMs: null },
	{ cpuPercent: null },
	{ shortfall: null },
	{ upstreamDropDelta: 1 },
	{ absorberOverflow: null },
	{ complete: false },
])(
	"does not infer a lone consumer from incomplete or upstream-loss evidence %j",
	overrides => {
		expect(
			attributeInterval({
				...evidence,
				branchDrops: new Map([["a", 4]]),
				...overrides,
			}),
		).toBe("unknown")
	},
)

it("uses the continuous-congestion deadline when holding starts later", () => {
	vi.useFakeTimers()
	const { fanout, absorber, time } = setup()
	fanout.congest("a")
	time(400)
	vi.advanceTimersByTime(400)
	absorber.ingest(Buffer.alloc(4))
	time(499)
	vi.advanceTimersByTime(99)
	expect(absorber.counters().heldBytes).toBe(4)
	time(500)
	vi.advanceTimersByTime(1)
	expect(absorber.counters().heldBytes).toBe(0)
	absorber.dispose()
})
