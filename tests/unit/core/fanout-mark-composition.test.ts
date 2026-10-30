/**
 * How a branch's marks compose: the construction mark, the soft mark a
 * source-rate change sets (setByteRate), the decoder startup mark
 * (activateBranch) and the link-burst absorber that holds a congested
 * branch's input. Deterministic: fake timers, counters only.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_HIGH_WATER_MARK,
	DROP_MODE_POLL_MS,
	FanoutManager,
} from "../../../src/core/fanout-manager.js"
import { createBurstAbsorber } from "../../../src/core/link-burst/absorber.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const KiB = 1024
const MiB = 1024 * KiB
// 2.4 Msps CU8: 4.8 MB/s, a 1 200 000 B mark (250 ms) per side.
const CU8_2400K = 4_800_000
const MARK_2400K = 1_200_000
// 1.5 s of it for 5 s, as startupBuffer() sizes a decoder's raw branch.
const STARTUP = { highWaterMark: 7_200_000, durationMs: 5000 }
const chunk = Buffer.alloc(64 * KiB)

afterEach(() => vi.useRealTimers())

function setup(rate: number | null = CU8_2400K) {
	const fanout = new FanoutManager(logger)
	fanout.setByteRate(rate)
	const branch = fanout.addBranch({ id: "b", deferred: true })
	const send = (bytes: number) => {
		for (let sent = 0; sent < bytes; sent += chunk.length)
			fanout.distribute(chunk)
	}
	const telemetry = () => fanout.getBranchTelemetry("b")!
	const buffered = () => branch.readableLength + branch.writableLength
	return { fanout, branch, send, telemetry, buffered }
}

describe("startup mark over a derived construction mark", () => {
	it("bounds the whole buffer, both sides, by the startup mark", () => {
		vi.useFakeTimers()
		const f = setup()
		expect(f.branch.readableHighWaterMark).toBe(MARK_2400K)
		f.fanout.activateBranch("b", STARTUP)
		// A consumer that is ready but not reading: 4 MiB fits.
		f.send(4 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBe(0)
		// A second 4 MiB (8 388 608 B in all) is beyond 7 200 000 B: the
		// readable side's 1.2 MB does not extend the startup mark.
		f.send(4 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBeGreaterThan(0)
		// Within one chunk of the mark; a full readable side also counts its
		// last chunk on the writable side until it is read.
		expect(f.buffered()).toBeLessThanOrEqual(
			STARTUP.highWaterMark + 2 * chunk.length,
		)
		expect(f.telemetry().totalBytesWritten).toBe(8 * MiB)
		f.fanout.destroy()
	})

	it("ends a startup drop-mode episode at the low water of its writable share", async () => {
		vi.useFakeTimers()
		const f = setup()
		f.fanout.activateBranch("b", STARTUP)
		f.send(8 * MiB)
		expect(f.telemetry().backpressureActive).toBe(true)
		// The writable side's share is 7 200 000 - 1 200 000 B. Reading half
		// the buffer leaves it non-empty (no 'drain' yet): the poll ends it.
		while (f.buffered() > STARTUP.highWaterMark / 2) f.branch.read(64 * KiB)
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		expect(f.telemetry().backpressureActive).toBe(false)
		const before = f.telemetry().droppedBytesTotal
		f.send(64 * KiB)
		expect(f.telemetry().droppedBytesTotal).toBe(before)
		f.fanout.destroy()
	})

	it("keeps the startup mark through a rate drop, then drains to the new mark", async () => {
		vi.useFakeTimers()
		const f = setup()
		f.fanout.activateBranch("b", STARTUP)
		f.send(2 * MiB)
		// 2.048 Msps CU8: the normal mark falls to 1 024 000 B.
		f.fanout.setByteRate(4_096_000)
		expect(f.telemetry().highWaterMark).toBe(1_024_000)
		// Still inside the startup period: the startup mark is the effective one.
		f.send(4 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBe(0)
		f.send(2 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBeGreaterThan(0)
		// The period ends with a backlog over the resized mark: it drains first.
		await vi.advanceTimersByTimeAsync(STARTUP.durationMs)
		f.branch.resume()
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		f.branch.pause()
		expect(f.buffered()).toBe(0)
		const before = f.telemetry().droppedBytesTotal
		// Then the resized normal mark applies, per side: writable side under
		// 1 024 000 B on top of the readable side's 1 200 000 B.
		f.send(2 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBe(before)
		f.send(1 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBeGreaterThan(before)
		f.fanout.destroy()
	})

	it("ends the startup period early when a rate rise lifts the normal mark past it", () => {
		vi.useFakeTimers()
		const f = setup()
		f.fanout.activateBranch("b", STARTUP)
		expect(vi.getTimerCount()).toBe(1)
		// 40 MB/s: a 10 000 000 B normal mark, above the 7 200 000 B startup mark.
		f.fanout.setByteRate(40_000_000)
		expect(vi.getTimerCount()).toBe(0)
		expect(f.telemetry().highWaterMark).toBe(10_000_000)
		// The larger soft mark applies to the writable side: 8 MiB fits.
		f.send(8 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBe(0)
		f.send(4 * MiB)
		expect(f.telemetry().droppedBytesTotal).toBeGreaterThan(0)
		f.fanout.destroy()
	})
})

describe("drop-mode episodes across a resize", () => {
	it("exits an episode entered at the floor mark once the mark grows", async () => {
		vi.useFakeTimers()
		const f = setup(null)
		f.fanout.activateBranch("b")
		expect(f.telemetry().highWaterMark).toBe(DEFAULT_HIGH_WATER_MARK)
		while (!f.telemetry().backpressureActive) f.send(chunk.length)
		const drains: string[] = []
		f.fanout.on("drain", (id: string) => drains.push(id))
		const writable = f.branch.writableLength
		f.fanout.setByteRate(CU8_2400K)
		// Nothing was read: the writable side is far below half the grown mark.
		expect(writable).toBeLessThanOrEqual(MARK_2400K / 2)
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		expect(f.telemetry().backpressureActive).toBe(false)
		expect(drains).toEqual(["b"])
		expect(vi.getTimerCount()).toBe(0)
		// The grown mark accepts until the writable side reaches 1 200 000 B.
		const before = f.telemetry().droppedBytesTotal
		while (f.branch.writableLength + chunk.length < MARK_2400K)
			f.send(chunk.length)
		expect(f.telemetry().droppedBytesTotal).toBe(before)
		expect(f.telemetry().backpressureActive).toBe(false)
		f.send(2 * chunk.length)
		expect(f.telemetry().backpressureActive).toBe(true)
		expect(f.telemetry().droppedBytesTotal).toBeGreaterThan(before)
		f.fanout.destroy()
	})
})

describe("resizing while the burst absorber holds the branch", () => {
	function withAbsorber(rate: number | null) {
		const f = setup(rate)
		f.fanout.activateBranch("b")
		const absorber = createBurstAbsorber({
			fanout: f.fanout,
			recorder: null,
			monoNow: () => Date.now(),
			frameBytes: 2,
			log: logger,
		})
		absorber.configure(2 * CU8_2400K)
		return { ...f, absorber }
	}

	it("a grown mark releases the held input into the branch without a drop", async () => {
		vi.useFakeTimers()
		const f = withAbsorber(null)
		while (f.absorber.counters().heldBytes === 0) f.absorber.ingest(chunk)
		expect(f.telemetry().backpressureActive).toBe(true)
		f.fanout.setByteRate(CU8_2400K)
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		expect(f.telemetry().backpressureActive).toBe(false)
		expect(f.absorber.counters().heldBytes).toBe(0)
		expect(f.telemetry().droppedBytesTotal).toBe(0)
		expect(f.absorber.counters().overflowBytesTotal).toBe(0)
		f.absorber.dispose()
		f.fanout.destroy()
	})

	it("a shrunk mark congests the branch into the absorber, which drains it back", async () => {
		vi.useFakeTimers()
		const f = withAbsorber(CU8_2400K)
		// 1.75 MiB: the readable side fills its 1.2 MB, the writable side
		// holds the rest, under its 1.2 MB construction mark.
		for (let i = 0; i < 28; i++) f.absorber.ingest(chunk)
		expect(f.telemetry().backpressureActive).toBe(false)
		expect(f.absorber.counters().heldBytes).toBe(0)
		expect(f.branch.writableLength).toBeGreaterThan(512_000)
		// 1.024 Msps CU8: a 512 000 B mark, below the writable backlog.
		f.fanout.setByteRate(2_048_000)
		expect(f.telemetry().highWaterMark).toBe(512_000)
		// The branch is congested at the shrunk mark: the absorber holds.
		f.absorber.ingest(chunk)
		f.absorber.ingest(chunk)
		expect(f.absorber.counters().heldBytes).toBe(2 * chunk.length)
		// The consumer catches up. Below a shrunk soft mark the stream emits
		// no 'drain' (write() never refused at its construction mark): the next
		// source chunk, well inside the laggard bound, releases the hold.
		let consumed = 0
		f.branch.on("data", (data: Buffer) => (consumed += data.length))
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		expect(consumed).toBe(28 * chunk.length)
		expect(f.absorber.counters().heldBytes).toBe(2 * chunk.length)
		f.absorber.ingest(chunk)
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		expect(f.absorber.counters().heldBytes).toBe(0)
		expect(f.telemetry().droppedBytesTotal).toBe(0)
		expect(consumed).toBe(31 * chunk.length)
		f.absorber.dispose()
		f.fanout.destroy()
	})
})
