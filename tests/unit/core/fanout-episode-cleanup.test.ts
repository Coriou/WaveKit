/**
 * Drop-mode episode resources (low-water poll, one-shot 'drain' listener) end
 * with their branch, and decoder branches take the derived mark only once the
 * fanout knows its byte rate. Deterministic: fake timers, counters only.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_HIGH_WATER_MARK,
	DROP_MODE_POLL_MS,
	FanoutManager,
} from "../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const BYTES_PER_S = 2_400_000 * 2 // 2.4 Msps CU8

afterEach(() => vi.useRealTimers())

/** A fanout whose only branch is in drop-mode with its poll running. */
function congested(): { fanout: FanoutManager; branch: PassThrough } {
	const fanout = new FanoutManager(logger)
	const branch = fanout.addBranch({ id: "b", highWaterMark: 16 })
	fanout.distribute(Buffer.alloc(32))
	expect(fanout.getBranchStatus("b")?.backpressure).toBe(true)
	expect(vi.getTimerCount()).toBe(1)
	expect(branch.listenerCount("drain")).toBe(2) // writable-drain + episode
	return { fanout, branch }
}

describe("drop-mode episode cleanup", () => {
	it("leaves no timer when a backpressure handler removes the branch", async () => {
		vi.useFakeTimers()
		const fanout = new FanoutManager(logger)
		fanout.on("backpressure", (id: string) => fanout.removeBranch(id))
		const branch = fanout.addBranch({ id: "b", highWaterMark: 16 })
		fanout.distribute(Buffer.alloc(32))
		expect(fanout.getBranchIds()).toEqual([])
		expect(branch.destroyed).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
		expect(branch.listenerCount("drain")).toBe(1) // writable-drain only
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS * 10)
		expect(vi.getTimerCount()).toBe(0)
		fanout.destroy()
	})

	it("destroy() clears a running episode", () => {
		vi.useFakeTimers()
		const { fanout, branch } = congested()
		fanout.destroy()
		expect(vi.getTimerCount()).toBe(0)
		expect(branch.listenerCount("drain")).toBe(1)
	})

	it("removeBranch() clears a running episode", () => {
		vi.useFakeTimers()
		const { fanout, branch } = congested()
		fanout.removeBranch("b")
		expect(vi.getTimerCount()).toBe(0)
		expect(branch.listenerCount("drain")).toBe(1)
		fanout.destroy()
	})

	it("a stream destroyed by its consumer stops the poll", async () => {
		vi.useFakeTimers()
		const { fanout, branch } = congested()
		branch.destroy()
		await vi.advanceTimersByTimeAsync(0) // 'close' is emitted on next tick
		expect(vi.getTimerCount()).toBe(0)
		expect(branch.listenerCount("drain")).toBe(1)
		// Still registered and still refusing: the drop is counted.
		fanout.distribute(Buffer.alloc(8))
		expect(fanout.getBranchTelemetry("b")?.droppedBytesTotal).toBe(8)
		fanout.destroy()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("a stream that errors stops the poll", async () => {
		vi.useFakeTimers()
		const { fanout, branch } = congested()
		branch.destroy(new Error("consumer failed"))
		await vi.advanceTimersByTimeAsync(0)
		expect(vi.getTimerCount()).toBe(0)
		fanout.destroy()
	})

	it("the poll ends itself if it ever sees a destroyed stream", async () => {
		vi.useFakeTimers()
		const { fanout, branch } = congested()
		// Without the close listener, the poll still notices on its next tick.
		branch.removeAllListeners("close")
		branch.destroy()
		await vi.advanceTimersByTimeAsync(DROP_MODE_POLL_MS)
		expect(vi.getTimerCount()).toBe(0)
		fanout.destroy()
	})
})

class Sources extends EventEmitter {
	readonly ids = ["main", "second"]
	getAllStatus() {
		return this.ids.map(id => ({ id, connected: false }))
	}
	getStatus(id: string) {
		return this.ids.includes(id) ? { id, connected: false } : undefined
	}
	getStream() {
		return new PassThrough()
	}
}

/** DecoderManager's raw wiring (src/decoders/manager.ts): same config shape. */
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

describe("decoder branches and setByteRate", () => {
	// The router does not call setByteRate yet (pending, Main seam): until it
	// does, decoder branches keep the 256 KiB floor.
	it.each(["main", "second"])(
		"source %s: branches added after setByteRate get 250 ms; earlier ones keep theirs",
		sourceId => {
			const primary = new FanoutManager(logger)
			const router = new SourceFanoutRouter(
				new Sources() as unknown as SourceManager,
				primary,
				logger,
			)
			const fanout = router.getFanout(sourceId)
			const before = addDecoderBranch(router, "early", sourceId)
			fanout.setByteRate(BYTES_PER_S)
			const after = addDecoderBranch(router, "late", sourceId)

			const mark = (id: string) =>
				fanout.getBranchTelemetry(`decoder-${id}`)?.highWaterMark
			expect(mark("early")).toBe(DEFAULT_HIGH_WATER_MARK)
			expect(before.writableHighWaterMark).toBe(DEFAULT_HIGH_WATER_MARK)
			expect(mark("late")).toBe(1_200_000)
			expect(after.writableHighWaterMark).toBe(1_200_000)
			expect(after.readableHighWaterMark).toBe(1_200_000)
			router.destroy()
			primary.destroy()
		},
	)
})
