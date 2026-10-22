import { describe, it, expect, vi, afterEach } from "vitest"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	ABSORBER_RELEASE_STEP_BLOCKS,
	createBurstAbsorber,
} from "../../../../src/core/link-burst/absorber.js"
import { ABSORBER_RELEASE_BYTES } from "../../../../src/core/link-burst/contract.js"
import { FakeFanout } from "./fake-fanout.js"

export function setup(frameBytes = 2, capacity = 128) {
	const fanout = new FakeFanout()
	let now = 0
	const log = createLogger({ level: "fatal" })
	const absorber = createBurstAbsorber({
		fanout,
		frameBytes,
		monoNow: () => now,
		log,
		recorder: null,
	})
	absorber.configure(capacity)
	return {
		fanout,
		absorber,
		log,
		time: (value: number) => {
			now = value
		},
	}
}

describe("BurstAbsorber", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})
	it.each([0, 4])(
		"caps a drain with %i extra bytes at the step boundary",
		extra => {
			vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] })
			const step = ABSORBER_RELEASE_STEP_BLOCKS * ABSORBER_RELEASE_BYTES
			const { absorber, fanout } = setup(4, step + extra)
			const stream = Buffer.alloc(step + extra, 73)
			fanout.congest("a")
			absorber.ingest(stream)
			fanout.drain("a")
			expect(fanout.delivered).toHaveLength(4)
			expect(absorber.counters().heldBytes).toBe(extra)
			expect(vi.getTimerCount()).toBe(extra ? 1 : 0)
			vi.runAllTimers()
			expect(Buffer.concat(fanout.delivered).equals(stream)).toBe(true)
			expect(absorber.counters().heldBytes).toBe(0)
			expect(vi.getTimerCount()).toBe(0)
		},
	)
	it("releases in ordered steps and keeps one continuation across further triggers", () => {
		vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] })
		const step = ABSORBER_RELEASE_STEP_BLOCKS * ABSORBER_RELEASE_BYTES
		const stream = Buffer.alloc(step * 7, 17)
		const tail = Buffer.from([1, 2, 3, 4])
		const { absorber, fanout } = setup(4, stream.length + tail.length)
		fanout.congest("a")
		absorber.ingest(stream)
		fanout.drain("a")
		expect(fanout.delivered).toHaveLength(4)
		expect(vi.getTimerCount()).toBe(1)
		absorber.ingest(tail)
		expect(fanout.delivered).toHaveLength(8)
		for (const event of ["drain", "branch-added", "branch-removed"]) {
			const before = fanout.delivered.length
			fanout.emit(event, "b")
			expect(fanout.delivered.length - before).toBe(4)
			expect(vi.getTimerCount()).toBe(1)
		}
		vi.advanceTimersToNextTimer()
		expect(fanout.delivered).toHaveLength(24)
		expect(vi.getTimerCount()).toBe(1)
		vi.runAllTimers()
		expect(
			Buffer.concat(fanout.delivered).equals(Buffer.concat([stream, tail])),
		).toBe(true)
		expect(absorber.counters().heldBytes).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})
	it("pauses a queued continuation when a gating branch becomes congested", () => {
		vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] })
		const step = ABSORBER_RELEASE_STEP_BLOCKS * ABSORBER_RELEASE_BYTES
		const stream = Buffer.concat(
			Array.from({ length: 13 }, (_, index) =>
				Buffer.alloc(ABSORBER_RELEASE_BYTES, index),
			),
		)
		const { absorber, fanout } = setup(4, stream.length)
		const schedule = vi.spyOn(globalThis, "setImmediate")
		fanout.congest("a")
		absorber.ingest(stream)
		fanout.drain("a")
		expect(
			Buffer.concat(fanout.delivered).equals(stream.subarray(0, step)),
		).toBe(true)
		expect(vi.getTimerCount()).toBe(1)
		expect(schedule).toHaveBeenCalledTimes(1)

		fanout.congest("b")
		vi.advanceTimersToNextTimer()
		expect(
			Buffer.concat(fanout.delivered).equals(stream.subarray(0, step)),
		).toBe(true)
		expect(absorber.counters().heldBytes).toBe(stream.length - step)
		expect(vi.getTimerCount()).toBe(0)
		expect(schedule).toHaveBeenCalledTimes(1)

		fanout.drain("b")
		expect(
			Buffer.concat(fanout.delivered).equals(stream.subarray(0, step * 2)),
		).toBe(true)
		expect(vi.getTimerCount()).toBe(1)
		vi.runAllTimers()
		expect(Buffer.concat(fanout.delivered).equals(stream)).toBe(true)
		expect(absorber.counters().heldBytes).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
		expect(fanout.drops.size).toBe(0)
	})
	it.each(["flush", "configure", "dispose"] as const)(
		"%s cancels a pending continuation",
		action => {
			vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] })
			const size = (ABSORBER_RELEASE_STEP_BLOCKS + 1) * ABSORBER_RELEASE_BYTES
			const { absorber, fanout } = setup(4, size)
			const schedule = vi.spyOn(globalThis, "setImmediate")
			const cancel = vi.spyOn(globalThis, "clearImmediate")
			fanout.congest("a")
			absorber.ingest(Buffer.alloc(size))
			fanout.drain("a")
			expect(vi.getTimerCount()).toBe(1)
			if (action === "flush") absorber.flush("disconnect")
			else if (action === "configure") absorber.configure(size)
			else absorber.dispose()
			expect(cancel).toHaveBeenCalledWith(schedule.mock.results[0]?.value)
			expect(vi.getTimerCount()).toBe(0)
			vi.runAllTimers()
			if (action === "dispose") schedule.mock.calls[0]?.[0]()
			expect(fanout.delivered).toHaveLength(4)
			expect(absorber.counters().flushedBytesTotal).toBe(ABSORBER_RELEASE_BYTES)
		},
	)

	it("holding absorber releases once a startup branch drained", () => {
		const { fanout, absorber } = setup()
		fanout.congest("a")
		absorber.ingest(Buffer.from([1, 2]))
		fanout.congested.clear()
		absorber.ingest(Buffer.from([3, 4]))
		expect(Buffer.concat(fanout.delivered)).toEqual(Buffer.from([1, 2, 3, 4]))
	})
	it.each([2, 4])(
		"holds partial frames until complete for frame %i",
		frameBytes => {
			const { fanout, absorber } = setup(frameBytes)
			fanout.congest("a")
			absorber.ingest(Buffer.from([1, 2, 3]))
			fanout.drain("a")
			absorber.ingest(Buffer.from([4, 5, 6, 7, 8]))
			expect(Buffer.concat(fanout.delivered)).toEqual(
				Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
			)
			for (const chunk of fanout.delivered)
				expect(chunk.length % frameBytes).toBe(0)
		},
	)
	it("flush counts flushedBytes and is not overflow", () => {
		const { fanout, absorber } = setup()
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(7))
		absorber.flush("disconnect")
		expect(absorber.counters()).toMatchObject({
			flushedBytesTotal: 7,
			overflowBytesTotal: 0,
			heldBytes: 0,
		})
	})
	it("configure(0) frees and passes through", () => {
		const { fanout, absorber } = setup()
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(4))
		absorber.configure(0)
		const chunk = Buffer.alloc(3)
		absorber.ingest(chunk)
		expect(fanout.delivered[0]).toBe(chunk)
		expect(absorber.counters().flushedBytesTotal).toBe(4)
	})
	it("peakHeldMs measures the longest holding episode", () => {
		const { fanout, absorber, time } = setup()
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(4))
		time(300)
		fanout.drain("a")
		expect(absorber.counters().window.peakHeldMs).toBe(300)
	})
	it("maxLaggardExcludeMs records congested-to-excluded time", () => {
		const { fanout, absorber, time } = setup()
		expect(absorber.counters().window.maxLaggardExcludeMs).toBeNull()
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(4))
		time(510)
		absorber.ingest(Buffer.alloc(4))
		expect(absorber.counters().window.maxLaggardExcludeMs).toBe(510)
	})
	it("a laggard becomes gating when its last sibling is removed", () => {
		const { fanout, absorber, time } = setup()
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(4))
		time(500)
		absorber.ingest(Buffer.alloc(4))
		fanout.active.delete("b")
		fanout.emit("branch-removed", "b")
		const before = fanout.delivered.length
		absorber.ingest(Buffer.alloc(4))
		expect(fanout.delivered).toHaveLength(before)
		expect(absorber.counters().heldBytes).toBe(4)
	})
	it("overflow episode logs start and end once", () => {
		const { fanout, absorber, log } = setup(2, 4)
		const spy = vi.spyOn(log, "info")
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(8))
		absorber.ingest(Buffer.alloc(6))
		fanout.drain("a")
		expect(spy).toHaveBeenCalledTimes(2)
		expect(spy.mock.calls[1]?.[0]).toMatchObject({
			overflowBytes: 10,
			overflowChunks: 2,
		})
	})
	it("window counters forget slots older than 10 min", () => {
		const { fanout, absorber, time } = setup(2, 4)
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(8))
		absorber.flush("rate")
		time(600_000)
		expect(absorber.counters().window.absorbedBytes).toBe(0)
		expect(absorber.counters().overflowBytesTotal).toBe(4)
	})
	it("rotates slots and expires latency and counters without losing totals", () => {
		const { fanout, absorber, time } = setup(2, 4)
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(8))
		time(510)
		absorber.ingest(Buffer.alloc(2))
		fanout.drain("a")
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(2))
		absorber.flush("rate")
		const initial = absorber.counters()
		expect(initial.window).toEqual({
			peakHeldBytes: 4,
			absorbedBytes: 6,
			overflowBytes: 6,
			flushedBytes: 2,
			peakHeldMs: 510,
			maxLaggardExcludeMs: 510,
		})
		for (let now = 10_000; now < 600_000; now += 10_000) {
			time(now)
			expect(absorber.counters().window).toEqual(initial.window)
		}
		time(600_000)
		expect(absorber.counters()).toEqual({
			...initial,
			window: {
				peakHeldBytes: 0,
				absorbedBytes: 0,
				overflowBytes: 0,
				flushedBytes: 0,
				peakHeldMs: 0,
				maxLaggardExcludeMs: null,
			},
		})
	})
	it("tracks an open holding episode across slots and expires its ending slot", () => {
		const { fanout, absorber, time } = setup(2, 4)
		fanout.active.delete("b")
		time(9_000)
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(4))
		for (let now = 10_000; now <= 620_000; now += 10_000) {
			time(now)
			expect(absorber.counters().window.peakHeldMs).toBe(now - 9_000)
			expect(absorber.counters().window.peakHeldBytes).toBe(4)
		}
		expect(absorber.counters().window.absorbedBytes).toBe(0)
		fanout.drain("a")
		const totals = absorber.counters()
		for (let now = 630_000; now < 1_220_000; now += 10_000) {
			time(now)
			expect(absorber.counters().window.peakHeldMs).toBe(611_000)
		}
		time(1_220_000)
		expect(absorber.counters()).toEqual({
			...totals,
			window: {
				peakHeldBytes: 0,
				absorbedBytes: 0,
				overflowBytes: 0,
				flushedBytes: 0,
				peakHeldMs: 0,
				maxLaggardExcludeMs: null,
			},
		})
	})
	it("bounds synchronous drain recursion and stops on gating congestion", () => {
		const { fanout, absorber } = setup(2, 200_000)
		const stream = Buffer.from(
			Array.from(
				{ length: 200_000 },
				(_, i) => (i * 73 + Math.floor(i / 251)) % 256,
			),
		)
		fanout.congest("a")
		absorber.ingest(stream)
		fanout.script.push(() => {
			fanout.drain("a")
			fanout.congest("b")
		})
		fanout.drain("a")
		expect(fanout.delivered).toHaveLength(1)
		expect(fanout.delivered[0]?.equals(stream.subarray(0, 65_536))).toBe(true)
		expect(absorber.counters().heldBytes).toBe(stream.length - 65_536)
		fanout.script.push(
			() => fanout.drain("b"),
			() => fanout.drain("a"),
		)
		fanout.drain("b")
		expect(fanout.maxDistributionDepth).toBe(1)
		expect(fanout.distributionDepth).toBe(0)
		expect(fanout.delivered.map(chunk => chunk.length)).toEqual([
			65_536, 65_536, 65_536, 3392,
		])
		expect(Buffer.concat(fanout.delivered).equals(stream)).toBe(true)
		expect(absorber.counters().heldBytes).toBe(0)
	})
	it("rejoins an excluded branch on drain and gates after re-congestion", () => {
		const { fanout, absorber, time } = setup()
		fanout.congest("a")
		absorber.ingest(Buffer.from([1, 2]))
		time(500)
		absorber.ingest(Buffer.from([3, 4]))
		expect(Buffer.concat(fanout.delivered)).toEqual(Buffer.from([1, 2, 3, 4]))
		fanout.drain("a")
		fanout.congest("a")
		time(600)
		absorber.ingest(Buffer.from([5, 6]))
		expect(absorber.counters().heldBytes).toBe(2)
		expect(fanout.delivered).toHaveLength(1)
		time(999)
		absorber.ingest(Buffer.from([7, 8]))
		expect(absorber.counters().heldBytes).toBe(4)
		fanout.drain("a")
		expect(Buffer.concat(fanout.delivered)).toEqual(
			Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
		)
		expect(absorber.counters().heldBytes).toBe(0)
	})

	it("same-capacity reconfigure flushes without reallocating and dispose removes listeners", () => {
		const { absorber, fanout } = setup()
		fanout.congest("a")
		absorber.ingest(Buffer.alloc(3))
		const spy = vi.spyOn(Buffer, "allocUnsafeSlow")
		absorber.configure(128)
		expect(spy).not.toHaveBeenCalled()
		spy.mockRestore()
		expect(absorber.counters().flushedBytesTotal).toBe(3)
		absorber.dispose()
		for (const event of [
			"backpressure",
			"drain",
			"branch-added",
			"branch-removed",
		])
			expect(fanout.listenerCount(event)).toBe(0)
	})
	it("steady-state pass-through allocates nothing", () => {
		const { absorber, fanout } = setup()
		const schedule = vi.spyOn(globalThis, "setImmediate")
		const chunk = Buffer.alloc(4)
		const spy = vi.spyOn(Buffer, "allocUnsafe")
		for (let i = 0; i < 1000; i++) absorber.ingest(chunk)
		expect(spy).not.toHaveBeenCalled()
		expect(schedule).not.toHaveBeenCalled()
		expect(fanout.delivered).toHaveLength(1000)
		expect(fanout.delivered.every(value => value === chunk)).toBe(true)
		spy.mockRestore()
	})
})
