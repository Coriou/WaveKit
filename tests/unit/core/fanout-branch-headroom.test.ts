/**
 * Branch marks in milliseconds of signal at a 2.4 Msps CU8
 * source. Deterministic: fake timers drive a paced source, the real fanout
 * and burst absorber, and throttled consumers; assertions are on counters.
 */
import { Writable } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { channelizerInputMark } from "../../../src/core/channelizer/channelizer-manager.js"
import {
	DEFAULT_BRANCH_BUFFER_MS,
	DROP_MODE_LOW_WATER,
	DROP_MODE_POLL_MS,
	DEFAULT_HIGH_WATER_MARK,
	FanoutManager,
	MAX_DERIVED_HIGH_WATER_MARK,
	branchHighWaterMark,
} from "../../../src/core/fanout-manager.js"
import { createBurstAbsorber } from "../../../src/core/link-burst/absorber.js"
import { createLogger } from "../../../src/utils/logger.js"

const RATE = 2_400_000
const BYTES_PER_S = RATE * 2 // CU8: 4.8 MB/s
const TICK_MS = 10
const TICK_BYTES = (BYTES_PER_S * TICK_MS) / 1000 // 48 000
const CONSUMER_PIPE = 65_536 // a child stdin/pipe buffer

/**
 * A consumer reading at `speed` × real time that, every `periodMs`, stops
 * for `stallMs` (a descheduled process on a loaded host).
 */
class ThrottledSink extends Writable {
	consumed = 0
	constructor(
		private readonly speed: number,
		private readonly stallMs: number,
		private readonly periodMs: number,
	) {
		super({ highWaterMark: CONSUMER_PIPE })
	}
	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		const phase = Date.now() % this.periodMs
		const wait =
			(chunk.length / (BYTES_PER_S * this.speed)) * 1000 +
			(phase < this.stallMs ? this.stallMs - phase : 0)
		setTimeout(() => {
			this.consumed += chunk.length
			callback()
		}, wait)
	}
}

interface Run {
	entries: number
	dropped: number
	overflow: number
	consumed: number[]
}

/** `seconds` of paced source through a 2 s absorber into one sink per mark. */
async function run(
	marks: number[],
	stallMs: number,
	seconds = 6,
	speed = 3,
): Promise<Run> {
	const log = createLogger({ level: "fatal" })
	const fanout = new FanoutManager(log)
	const absorber = createBurstAbsorber({
		fanout,
		recorder: null,
		monoNow: () => Date.now(),
		frameBytes: 2,
		log,
	})
	absorber.configure(2 * BYTES_PER_S)
	// Stalls start 100 ms in and recur every 2 s; 3x consumers recover in S/2.
	const sinks = marks.map(() => new ThrottledSink(speed, stallMs, 2000))
	marks.forEach((mark, i) => {
		fanout.addBranch({ id: `b${i}`, highWaterMark: mark }).pipe(sinks[i]!)
	})
	const chunk = Buffer.alloc(TICK_BYTES, 127)
	vi.setSystemTime(1900) // phase 1900: the first stall begins after 100 ms
	for (let t = 0; t < (seconds * 1000) / TICK_MS; t++) {
		absorber.ingest(chunk)
		await vi.advanceTimersByTimeAsync(TICK_MS)
	}
	const snap = fanout.getTelemetrySnapshot()
	const result = {
		entries: snap.branches.reduce((n, b) => n + b.backpressureEnterCount, 0),
		dropped: snap.droppedBytesTotal,
		overflow: absorber.counters().overflowBytesTotal,
		consumed: sinks.map(s => s.consumed),
	}
	absorber.dispose()
	fanout.destroy()
	return result
}

afterEach(() => vi.useRealTimers())

describe("branch marks in ms of signal", () => {
	it("derives 250 ms of signal, clamped to the 256 KiB floor and 16 MiB ceiling", () => {
		// 4.8 MB/s × 250 ms = 1 200 000 B; 2.048 MB/s × 250 ms = 512 000 B.
		expect(DEFAULT_BRANCH_BUFFER_MS).toBe(250)
		expect(branchHighWaterMark(BYTES_PER_S)).toBe(1_200_000)
		expect(branchHighWaterMark(2_048_000)).toBe(512_000)
		// Floor: at and below 1 048 576 B/s, 250 ms is at most 262 144 B.
		expect(branchHighWaterMark(1_048_576)).toBe(DEFAULT_HIGH_WATER_MARK)
		expect(branchHighWaterMark(1_048_580)).toBe(DEFAULT_HIGH_WATER_MARK + 1)
		expect(branchHighWaterMark(500_000)).toBe(DEFAULT_HIGH_WATER_MARK)
		// Ceiling: 16 MiB is 250 ms of 67 108 864 B/s.
		expect(branchHighWaterMark(67_108_864)).toBe(MAX_DERIVED_HIGH_WATER_MARK)
		expect(branchHighWaterMark(67_108_868)).toBe(MAX_DERIVED_HIGH_WATER_MARK)
		for (const bad of [null, undefined, 0, -1, NaN, Infinity])
			expect(branchHighWaterMark(bad)).toBe(DEFAULT_HIGH_WATER_MARK)
		expect(branchHighWaterMark(BYTES_PER_S, 0)).toBe(DEFAULT_HIGH_WATER_MARK)
	})

	it("sizes unsized branches from the byte rate, resizing existing ones", () => {
		const fanout = new FanoutManager(createLogger({ level: "fatal" }))
		const mark = (id: string) => fanout.getBranchTelemetry(id)?.highWaterMark
		fanout.addBranch({ id: "before" })
		expect(mark("before")).toBe(DEFAULT_HIGH_WATER_MARK)
		fanout.setByteRate(BYTES_PER_S)
		fanout.addBranch({ id: "after" })
		fanout.addBranch({ id: "ms", highWaterMarkMs: 500 })
		fanout.addBranch({ id: "bytes", highWaterMark: 65_536 })
		expect(mark("before")).toBe(1_200_000)
		expect(mark("after")).toBe(1_200_000)
		expect(mark("ms")).toBe(2_400_000)
		expect(mark("bytes")).toBe(65_536)
		// An unknown rate returns every derived mark to the floor.
		fanout.setByteRate(NaN)
		fanout.addBranch({ id: "unknown" })
		expect(mark("before")).toBe(DEFAULT_HIGH_WATER_MARK)
		expect(mark("ms")).toBe(DEFAULT_HIGH_WATER_MARK)
		expect(mark("bytes")).toBe(65_536)
		expect(mark("unknown")).toBe(DEFAULT_HIGH_WATER_MARK)
		expect(fanout.getByteRate()).toBeNull()
		fanout.destroy()
	})

	it("keeps a configured channelizer input mark as a floor", () => {
		expect(channelizerInputMark(262_144, RATE)).toBe(1_200_000)
		expect(channelizerInputMark(262_144, 1_024_000)).toBe(512_000)
		expect(channelizerInputMark(4_000_000, RATE)).toBe(4_000_000)
		expect(channelizerInputMark(65_536, 250_000)).toBe(DEFAULT_HIGH_WATER_MARK)
	})
})

describe("2.4 Msps CU8 through the absorber into stalling consumers", () => {
	// A branch congests once its PassThrough holds a mark on each side plus the
	// consumer's pipe: legacy 2 × 262 144 + 65 536 = 589 824 B = 122.9 ms;
	// derived 2 × 1 200 000 + 65 536 = 2 465 536 B = 513.7 ms of signal.
	it("legacy 256 KiB marks enter drop-mode on a 150 ms stall; derived marks do not", async () => {
		vi.useFakeTimers()
		// Legacy bound: 90 ms passes, 150 ms (past 122.9 ms) congests.
		expect(await run([DEFAULT_HIGH_WATER_MARK], 90)).toMatchObject({
			entries: 0,
			dropped: 0,
		})
		const legacy = await run([DEFAULT_HIGH_WATER_MARK], 150)
		expect(legacy.entries).toBeGreaterThan(0)
		const derived = await run([branchHighWaterMark(BYTES_PER_S)], 150)
		expect(derived).toMatchObject({ entries: 0, dropped: 0, overflow: 0 })
	})

	it("derived marks absorb a stall at the bound and congest past it", async () => {
		vi.useFakeTimers()
		const mark = branchHighWaterMark(BYTES_PER_S)
		// 450 ms < 513.7 ms (the pipe already holds one chunk, so not 510).
		const at = await run([mark], 450)
		expect(at).toMatchObject({ entries: 0, dropped: 0, overflow: 0 })
		const past = await run([mark], 600)
		expect(past.entries).toBeGreaterThan(0)
		// The absorber holds the rest; a 2x catch-up loses nothing here.
		expect(past.dropped + past.overflow).toBe(0)
	})

	it("keeps every byte flowing to all branches when one consumer stalls", async () => {
		vi.useFakeTimers()
		const mark = branchHighWaterMark(BYTES_PER_S)
		const r = await run([mark, mark, mark], 300)
		expect(r).toMatchObject({ entries: 0, dropped: 0, overflow: 0 })
		// 6 s minus the bytes still buffered (at most 2 marks + the pipe each).
		for (const consumed of r.consumed)
			expect(consumed).toBeGreaterThan(
				6 * BYTES_PER_S - 2 * mark - CONSUMER_PIPE,
			)
	})
})

describe("drop-mode logging", () => {
	function capture() {
		const lines: { level: number; msg: string }[] = []
		const logger = pino(
			{ level: "debug" },
			{ write: (line: string) => lines.push(JSON.parse(line) as never) },
		)
		return { logger, lines }
	}
	const warnings = (lines: { level: number; msg: string }[]) =>
		lines.filter(l => l.level >= 40).map(l => l.msg)

	it("warns once per episode on the first dropped chunk, not on entry", async () => {
		const { logger, lines } = capture()
		const fanout = new FanoutManager(logger)
		const branch = fanout.addBranch({ id: "b", highWaterMark: 16 })
		fanout.distribute(Buffer.alloc(32)) // fills the writable side: drop-mode
		expect(fanout.getBranchStatus("b")?.backpressure).toBe(true)
		expect(warnings(lines)).toEqual([])
		expect(lines.map(l => l.msg)).toContain(
			"Branch congested, entering drop-mode",
		)
		fanout.distribute(Buffer.alloc(8))
		fanout.distribute(Buffer.alloc(8))
		expect(warnings(lines)).toEqual(["Branch congested, dropping input"])
		expect(fanout.getBranchTelemetry("b")).toMatchObject({
			droppedBytesTotal: 16,
			droppedChunksTotal: 2,
			backpressureEnterCount: 1,
		})
		branch.resume() // drain ends the episode
		await new Promise(resolve => setImmediate(resolve))
		expect(fanout.getBranchStatus("b")?.backpressure).toBe(false)
		fanout.distribute(Buffer.alloc(32))
		fanout.distribute(Buffer.alloc(8))
		expect(warnings(lines)).toEqual([
			"Branch congested, dropping input",
			"Branch congested, dropping input",
		])
		fanout.destroy()
	})
})

describe("drop-mode low-water exit", () => {
	it("resumes at half the mark without waiting for an empty writable side", async () => {
		vi.useFakeTimers()
		const fanout = new FanoutManager(createLogger({ level: "fatal" }))
		const drains: number[] = []
		const branch = fanout.addBranch({ id: "b", highWaterMark: 100 })
		fanout.on("drain", () => drains.push(branch.writableLength))
		// 30-byte chunks until the writable side reaches the mark (drop-mode).
		let writes = 0
		while (!fanout.getBranchStatus("b")?.backpressure && writes < 100) {
			fanout.distribute(Buffer.alloc(30))
			writes++
			await vi.advanceTimersByTimeAsync(0)
		}
		expect(fanout.getBranchStatus("b")?.backpressure).toBe(true)
		expect(branch.writableLength).toBeGreaterThanOrEqual(100)
		// Consume 30 bytes at a time; each poll compares the writable side to
		// half the mark (50).
		let resumedAt: number | null = null
		for (let i = 0; i < 20 && resumedAt === null; i++) {
			branch.read(30)
			await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
			if (!fanout.getBranchStatus("b")?.backpressure)
				resumedAt = branch.writableLength
		}
		// Resumed with data still on the writable side: Node's 'drain' (empty)
		// had not fired, the low-water poll ended the episode.
		expect(resumedAt).not.toBeNull()
		expect(resumedAt!).toBeGreaterThan(0)
		expect(resumedAt!).toBeLessThanOrEqual(100 * DROP_MODE_LOW_WATER)
		expect(drains).toEqual([resumedAt])
		// The next chunk is written, not dropped, and starts no new episode.
		fanout.distribute(Buffer.alloc(10))
		expect(fanout.getBranchTelemetry("b")).toMatchObject({
			droppedBytesTotal: 0,
			backpressureEnterCount: 1,
		})
		fanout.destroy()
	})
})
