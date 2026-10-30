import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import {
	ABSORBER_RECOVERY_MS,
	createBurstAbsorber,
} from "../../../../src/core/link-burst/absorber.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { FakeFanout } from "./fake-fanout.js"

afterEach(() => vi.useRealTimers())
it("requires sustained recovery and immediately excludes a cooldown relapse", () => {
	vi.useFakeTimers()
	const fanout = new FakeFanout()
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => fanout.tick,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(8192)
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	fanout.tick = 500
	vi.advanceTimersByTime(500)
	fanout.drain("a")
	fanout.tick += ABSORBER_RECOVERY_MS - 1
	absorber.ingest(Buffer.alloc(2))
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	expect(absorber.counters().heldBytes).toBe(0)
	fanout.drain("a")
	fanout.tick += ABSORBER_RECOVERY_MS
	absorber.ingest(Buffer.alloc(2))
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	expect(absorber.counters().heldBytes).toBe(0)
	absorber.dispose()
})

// Feature: link-burst-resilience, Property 7: Healthy sibling isolation
// Validates: Requirements 1.5, 9.2
it("never drops a sibling consuming at least the source rate", async () => {
	vi.useFakeTimers()
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async rate => {
			vi.setSystemTime(0)
			const log = createLogger({ level: "fatal" })
			const fanout = new FanoutManager(log)
			const slow = fanout.addBranch({ id: "slow", highWaterMark: 262144 })
			const sibling = fanout.addBranch({ id: "sibling", highWaterMark: 262144 })
			const absorber = createBurstAbsorber({
				fanout,
				frameBytes: 2,
				monoNow: () => Date.now(),
				log,
				recorder: null,
			})
			absorber.configure(8192000)
			for (let tick = 0; tick < 112; tick++) {
				// 65536 bytes / 16 ms = 2.048 Msps CU8. Drain a bounded
				// amount before each source arrival, including during catch-up.
				sibling.read(65536 * rate)
				if (tick < 100 && tick % 32 === 0) slow.read(65536)
				await vi.advanceTimersByTimeAsync(16)
				absorber.ingest(Buffer.alloc(65536))
			}
			expect(fanout.getBranchTelemetry("sibling")?.droppedBytesTotal).toBe(0)
			expect(
				fanout.getBranchTelemetry("slow")!.droppedBytesTotal,
			).toBeGreaterThan(0)
			absorber.dispose()
			fanout.destroy()
		}),
		{ numRuns: 100 },
	)
}, 30_000)

it("reincludes only after recovery and forgets cooldown after its boundary", () => {
	vi.useFakeTimers()
	const fanout = new FakeFanout()
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => fanout.tick,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(8192)
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	fanout.tick = 500
	vi.advanceTimersByTime(500)
	fanout.drain("a")
	fanout.tick = 5500
	absorber.ingest(Buffer.alloc(2))
	fanout.tick = 10500
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	expect(absorber.counters().heldBytes).toBe(2)
	absorber.flush("disconnect")
	absorber.ingest(Buffer.alloc(2))
	expect(absorber.counters().heldBytes).toBe(2)
	absorber.dispose()
})

it("paces a long catch-up into a twice-rate sibling while the sink pauses", async () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const log = createLogger({ level: "fatal" })
	const fanout = new FanoutManager(log)
	const slow = fanout.addBranch({ id: "slow", highWaterMark: 262144 })
	const sibling = fanout.addBranch({ id: "sibling", highWaterMark: 262144 })
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => Date.now(),
		log,
		recorder: null,
	})
	absorber.configure(8192000)
	for (let tick = 0; tick < 1400; tick++) {
		const received: Buffer | null = sibling.read(131072)
		if (received)
			for (let offset = 0; offset < received.length; offset += 65536)
				expect(Date.now() - received.readDoubleLE(offset)).toBeLessThanOrEqual(
					516,
				)
		if (tick < 100 && tick % 32 === 0) slow.read(65536)
		if (tick >= 500) slow.read()
		await vi.advanceTimersByTimeAsync(16)
		const chunk = Buffer.alloc(65536)
		chunk.writeDoubleLE(Date.now())
		absorber.ingest(chunk)
		if (tick > 120 && tick < 500) expect(absorber.counters().heldBytes).toBe(0)
	}
	expect(fanout.getBranchTelemetry("sibling")?.droppedBytesTotal).toBe(0)
	expect(absorber.counters().overflowBytesTotal).toBe(0)
	expect(absorber.counters().window.maxLaggardExcludeMs).toBeLessThanOrEqual(
		516,
	)
	// After five seconds of healthy consumption and the cooldown, a new
	// paused-sink episode must receive a fresh bounded wait.
	for (let tick = 0; tick < 12; tick++) {
		sibling.read()
		await vi.advanceTimersByTimeAsync(16)
		absorber.ingest(Buffer.alloc(65536))
	}
	expect(absorber.counters().heldBytes).toBeGreaterThan(0)
	absorber.dispose()
	fanout.destroy()
})

it("observes the startup writable mark and resumes on its drain", async () => {
	const log = createLogger({ level: "fatal" })
	const fanout = new FanoutManager(log)
	const stream = fanout.addBranch({
		id: "startup",
		highWaterMark: 4,
		deferred: true,
	})
	// The startup mark bounds both sides: 12 - 4 leaves the writable side 8.
	fanout.activateBranch("startup", { highWaterMark: 12, durationMs: 10000 })
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => 0,
		log,
		recorder: null,
	})
	absorber.configure(128)
	absorber.ingest(Buffer.alloc(4))
	absorber.ingest(Buffer.alloc(4))
	absorber.ingest(Buffer.alloc(2))
	expect(absorber.counters().heldBytes).toBe(2)
	stream.resume()
	await new Promise<void>(resolve => setImmediate(resolve))
	expect(absorber.counters().heldBytes).toBe(0)
	expect(fanout.getBranchTelemetry("startup")?.droppedBytesTotal).toBe(0)
	absorber.dispose()
	fanout.destroy()
})

it("forgets exclusions when a branch is removed and its id is reused", () => {
	vi.useFakeTimers()
	const fanout = new FakeFanout()
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => fanout.tick,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(128)
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	fanout.tick = 500
	vi.advanceTimersByTime(500)
	fanout.active.delete("a")
	fanout.congested.delete("a")
	fanout.emit("branch-removed", "a")
	fanout.active.add("a")
	fanout.emit("branch-added", "a")
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	expect(absorber.counters().heldBytes).toBe(2)
	absorber.dispose()
})

it("does not extend recovery or cooldown across idle source time", () => {
	vi.useFakeTimers()
	const fanout = new FakeFanout()
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes: 2,
		monoNow: () => fanout.tick,
		log: createLogger({ level: "fatal" }),
		recorder: null,
	})
	absorber.configure(128)
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	fanout.tick = 500
	vi.advanceTimersByTime(500)
	fanout.drain("a")
	fanout.tick = 10501
	fanout.congest("a")
	absorber.ingest(Buffer.alloc(2))
	expect(absorber.counters().heldBytes).toBe(2)
	absorber.dispose()
})
