/**
 * Production wiring of branch marks in signal time: the router learns a
 * source's caps (connect, caps-changed) and sizes its fanout's derived marks,
 * including those of branches that already exist. Branches use the shape
 * DecoderManager's raw wiring adds (src/decoders/manager.ts). Deterministic:
 * fake timers and stream counters only.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_HIGH_WATER_MARK,
	DROP_MODE_LOW_WATER,
	DROP_MODE_POLL_MS,
	FanoutManager,
	MAX_DERIVED_HIGH_WATER_MARK,
} from "../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
/** 250 ms of CU8 at 2.4 Msps: 2 400 000 × 2 B × 0.25 s. */
const MARK_2400K = 1_200_000
/** 250 ms of CU8 at 1.024 Msps: 1 024 000 × 2 B × 0.25 s. */
const MARK_1024K = 512_000
/** 10 ms of CU8 at 2.4 Msps, a typical rtl_tcp read. */
const CHUNK = 48_000

afterEach(() => vi.useRealTimers())

interface Caps {
	kind: "iq"
	format: string
	sampleRate: number
}

/** A SourceManager fake: caps are read through getCaps, as in production. */
class Sources extends EventEmitter {
	readonly ids = ["main", "second"]
	readonly connected = new Set<string>()
	readonly caps = new Map<string, Caps>()
	readonly streams = new Map<string, PassThrough>()
	getAllStatus() {
		return this.ids.map(id => ({ id, connected: this.connected.has(id) }))
	}
	getStatus(id: string) {
		return this.ids.includes(id)
			? { id, connected: this.connected.has(id) }
			: undefined
	}
	getStream(id: string) {
		let stream = this.streams.get(id)
		if (!stream) this.streams.set(id, (stream = new PassThrough()))
		return stream
	}
	getCaps(id: string) {
		return this.caps.get(id)
	}
	connect(id: string, sampleRate: number, format = "U8_IQ") {
		this.caps.set(id, { kind: "iq", format, sampleRate })
		this.connected.add(id)
		this.emit("connected", id)
	}
	retune(id: string, sampleRate: number, format = "U8_IQ") {
		const caps = { kind: "iq" as const, format, sampleRate }
		this.caps.set(id, caps)
		this.emit("caps-changed", id, caps)
	}
}

function setup() {
	const sources = new Sources()
	const primary = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		primary,
		logger,
	)
	return {
		sources,
		router,
		dispose() {
			router.destroy()
			primary.destroy()
		},
	}
}

/** DecoderManager's raw wiring: same config shape. */
function addDecoderBranch(
	router: SourceFanoutRouter,
	decoderId: string,
	sourceId: string,
): PassThrough {
	return router.getFanout(sourceId).addBranch({
		id: `decoder-${decoderId}`,
		decoderId,
		sourceId,
		deferred: true,
	})
}

const mark = (router: SourceFanoutRouter, sourceId: string, id: string) =>
	router.getFanout(sourceId).getBranchTelemetry(id)?.highWaterMark

describe.each(["main", "second"])("source %s", sourceId => {
	it("a connect with 2.4 Msps CU8 caps gives decoder branches 250 ms", () => {
		const { sources, router, dispose } = setup()
		// Registration precedes connection: caps are unknown yet.
		const early = addDecoderBranch(router, "early", sourceId)
		expect(mark(router, sourceId, "decoder-early")).toBe(
			DEFAULT_HIGH_WATER_MARK,
		)
		sources.connect(sourceId, 2_400_000)
		const late = addDecoderBranch(router, "late", sourceId)

		expect(mark(router, sourceId, "decoder-early")).toBe(MARK_2400K)
		expect(mark(router, sourceId, "decoder-late")).toBe(MARK_2400K)
		// A new branch's stream is built at the mark; an earlier one keeps its
		// construction mark and the fanout enforces the resized one.
		expect(late.writableHighWaterMark).toBe(MARK_2400K)
		expect(early.writableHighWaterMark).toBe(DEFAULT_HIGH_WATER_MARK)
		dispose()
	})

	it("existing branches follow 1.024 → 2.4 → 1.024 Msps; explicit marks stay", () => {
		const { sources, router, dispose } = setup()
		sources.connect(sourceId, 1_024_000)
		addDecoderBranch(router, "d", sourceId)
		router
			.getFanout(sourceId)
			.addBranch({ id: "snapshot", sourceId, highWaterMark: 1 })
		expect(mark(router, sourceId, "decoder-d")).toBe(MARK_1024K)

		sources.retune(sourceId, 2_400_000)
		expect(mark(router, sourceId, "decoder-d")).toBe(MARK_2400K)
		sources.retune(sourceId, 1_024_000)
		expect(mark(router, sourceId, "decoder-d")).toBe(MARK_1024K)
		expect(mark(router, sourceId, "snapshot")).toBe(1)
		dispose()
	})

	it("clamps at and past both bounds; audio caps take the floor", () => {
		const { sources, router, dispose } = setup()
		sources.connect(sourceId, 2_400_000)
		addDecoderBranch(router, "d", sourceId)
		const at = (sampleRate: number, format = "U8_IQ") => {
			sources.retune(sourceId, sampleRate, format)
			return mark(router, sourceId, "decoder-d")
		}
		// Floor: 262 144 B is 250 ms of 1 048 576 B/s, CU8 at 524 288 sps.
		expect(at(524_288)).toBe(DEFAULT_HIGH_WATER_MARK)
		expect(at(524_289)).toBe(DEFAULT_HIGH_WATER_MARK + 1) // ⌈262 144.5⌉
		expect(at(250_000)).toBe(DEFAULT_HIGH_WATER_MARK)
		// Ceiling: 16 MiB is 250 ms of 67 108 864 B/s, CS16 at 16 777 216 sps.
		expect(at(16_777_216, "S16_IQ")).toBe(MAX_DERIVED_HIGH_WATER_MARK)
		expect(at(20_000_000, "S16_IQ")).toBe(MAX_DERIVED_HIGH_WATER_MARK)
		expect(at(48_000, "S16LE")).toBe(DEFAULT_HIGH_WATER_MARK)
		dispose()
	})
})

/**
 * Feeds CHUNK-sized chunks with no reader until the branch enters drop-mode;
 * returns the writable backlog before and after the entering write.
 */
function fillUntilCongested(
	fanout: FanoutManager,
	branch: PassThrough,
	id: string,
): { before: number; after: number } {
	for (let i = 0; i < 200; i++) {
		const before = branch.writableLength
		fanout.distribute(Buffer.alloc(CHUNK))
		if (fanout.getBranchStatus(id)?.backpressure)
			return { before, after: branch.writableLength }
	}
	throw new Error("branch never congested")
}

describe("a resized mark governs congestion", () => {
	it("grown 512 000 → 1 200 000: drop-mode waits for the new mark", () => {
		vi.useFakeTimers()
		const { sources, router, dispose } = setup()
		sources.connect("main", 1_024_000)
		const branch = addDecoderBranch(router, "d", "main")
		const fanout = router.getFanout("main")
		fanout.activateBranch("decoder-d")
		sources.retune("main", 2_400_000)

		const { before, after } = fillUntilCongested(fanout, branch, "decoder-d")
		// write() said false from 512 000 on; only the resized mark counts.
		expect(before).toBeLessThan(MARK_2400K)
		expect(after).toBeGreaterThanOrEqual(MARK_2400K)
		dispose()
	})

	it("shrunk 1 200 000 → 512 000: drop-mode at the new mark, the poll ends it", async () => {
		vi.useFakeTimers()
		const { sources, router, dispose } = setup()
		sources.connect("main", 2_400_000)
		const branch = addDecoderBranch(router, "d", "main")
		const fanout = router.getFanout("main")
		fanout.activateBranch("decoder-d")
		sources.retune("main", 1_024_000)

		const { before, after } = fillUntilCongested(fanout, branch, "decoder-d")
		expect(before).toBeLessThan(MARK_1024K)
		expect(after).toBeGreaterThanOrEqual(MARK_1024K)
		// Below the construction mark there is no pending 'drain'.
		expect(branch.writableNeedDrain).toBe(false)
		expect(fanout.getBranchTelemetry("decoder-d")?.droppedChunksTotal).toBe(0)
		fanout.distribute(Buffer.alloc(CHUNK))
		expect(fanout.getBranchTelemetry("decoder-d")?.droppedChunksTotal).toBe(1)

		// The consumer reads; the low-water poll ends the episode once the
		// writable backlog is at or below 0.5 × 512 000 = 256 000 bytes.
		branch.resume()
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		expect(branch.writableLength).toBeLessThanOrEqual(
			MARK_1024K * DROP_MODE_LOW_WATER,
		)
		expect(fanout.getBranchStatus("decoder-d")?.backpressure).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
		dispose()
	})
})
