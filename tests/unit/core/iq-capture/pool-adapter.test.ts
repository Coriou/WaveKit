import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import {
	createPoolReplayProbes,
	type ReplayPool,
	type ReplayPoolRequest,
} from "../../../../src/core/iq-capture/pool-adapter.js"
import type { IqReplayProbeRequest } from "../../../../src/core/iq-capture/replay-queue.js"

class FakePool extends EventEmitter implements ReplayPool {
	requests: ReplayPoolRequest[] = []
	released: string[] = []
	dequeued: ReplayPoolRequest[] = []
	deferred: string | null = null
	seq = 0
	request(req: ReplayPoolRequest) {
		this.requests.push(req)
		if (this.deferred) return { deferred: this.deferred }
		const id = `p${++this.seq}`
		this.emit("probe-state", id, "starting", req)
		return { started: id }
	}
	release(id: string): Promise<void> {
		this.released.push(id)
		this.emit("probe-state", id, "stopped", this.requests.at(-1))
		return Promise.resolve()
	}
	dequeue(req: ReplayPoolRequest): boolean {
		this.dequeued.push(req)
		return true
	}
}

const mode = {
	decoderType: "dsd-fme" as const,
	protocol: "dmr" as const,
	covers: [],
	options: {},
	holdMs: 1800,
}
const request: IqReplayProbeRequest = {
	captureId: "cap-1",
	sourceId: "rtl",
	epoch: 3,
	observationId: "o_1",
	rfHz: 446_125_000,
	protocol: "dmr",
	mode,
}
const ev = (identity: boolean, crcClean = true) => ({
	protocol: "dmr" as const,
	...(identity ? { identity: { kind: "dmr-cc" as const, value: "1" } } : {}),
	metadata: {},
	crcClean,
	at: 1,
	epoch: 3,
	origin: "probe" as const,
})

function setup() {
	const pool = new FakePool()
	const timers = {
		fns: [] as (() => void)[],
		setTimeout: (fn: () => void) => (timers.fns.push(fn), timers.fns.length),
		clearTimeout: vi.fn(),
	}
	const adapter = createPoolReplayProbes(pool, {
		priority: 100,
		jobId: "iq-replay-queue",
		timers,
	})
	const start = () => {
		const res = adapter.request(request)
		if (!("run" in res)) throw new Error("deferred")
		return res.run
	}
	return { pool, adapter, timers, start }
}

describe("replay pool adapter", () => {
	it("maps the request onto a replay ProbeRequest", () => {
		const { pool, start } = setup()
		start()
		expect(pool.requests[0]).toMatchObject({
			jobId: "iq-replay-queue",
			priority: 100,
			sourceId: "rtl",
			observationId: "o_1",
			targetHz: 446_125_000,
			epoch: 3,
			protocols: ["dmr"],
			holdMs: 1800,
			modes: [mode],
			replay: { captureId: "cap-1" },
			preRollFromSample: null,
			record: false,
		})
	})

	it("an accepted identity with a clean replay-end is decoded", async () => {
		const { pool, start } = setup()
		const run = start()
		pool.emit("evidence", "p1", pool.requests[0], ev(true))
		pool.emit("replay-end", "p1")
		pool.emit("probe-state", "p1", "stopped", pool.requests[0])
		await expect(run.result).resolves.toEqual({
			outcome: "decoded",
			decoded: { protocol: "dmr", identity: { kind: "dmr-cc", value: "1" } },
		})
	})

	it.each([
		["no output", [], "no-sync"],
		["crc failures", [ev(false, false)], "crc-errors"],
		["output without identity", [ev(false)], "timeout"],
	] as const)("a clean end with %s is %s", async (_n, evs, outcome) => {
		const { pool, start } = setup()
		const run = start()
		for (const e of evs) pool.emit("evidence", "p1", pool.requests[0], e)
		pool.emit("replay-end", "p1")
		pool.emit("probe-state", "p1", "stopped", pool.requests[0])
		await expect(run.result).resolves.toEqual({ outcome, decoded: null })
	})

	it("a stop without a clean end, and a cancel, are cancelled", async () => {
		const a = setup()
		const run = a.start()
		a.pool.emit("probe-state", "p1", "stopped", a.pool.requests[0])
		await expect(run.result).resolves.toEqual({
			outcome: "cancelled",
			decoded: null,
		})
		const b = setup()
		const run2 = b.start()
		run2.cancel()
		expect(b.pool.released).toEqual(["p1"])
		await expect(run2.result).resolves.toMatchObject({ outcome: "cancelled" })
	})

	it("a probe that never exits is ended after its hold as cancelled, no verdict", async () => {
		// The replay input may have failed while the decoder never exited: only a clean
		// replay-end is a verdict.
		const { pool, timers, start } = setup()
		const run = start()
		pool.emit("evidence", "p1", pool.requests[0], ev(false))
		timers.fns[0]!()
		pool.emit("probe-state", "p1", "stopped", pool.requests[0])
		await expect(run.result).resolves.toEqual({
			outcome: "cancelled",
			decoded: null,
		})
		expect(pool.released).toEqual(["p1"])
	})

	it("a clean replay-end before the hold timer still gives the verdict", async () => {
		const { pool, timers, start } = setup()
		const run = start()
		pool.emit("evidence", "p1", pool.requests[0], ev(false))
		pool.emit("replay-end", "p1")
		timers.fns[0]!()
		pool.emit("probe-state", "p1", "stopped", pool.requests[0])
		await expect(run.result).resolves.toEqual({
			outcome: "timeout",
			decoded: null,
		})
	})

	it("a deferral withdraws the pool's queued copy and reports the reason", () => {
		const { pool, adapter } = setup()
		pool.deferred = "max-probes"
		expect(adapter.request(request)).toEqual({ deferred: "max-probes" })
		expect(pool.dequeued).toEqual([pool.requests[0]])
	})

	it("slot release listeners hear every stopped probe until they unsubscribe", () => {
		const { pool, adapter, start } = setup()
		const seen = vi.fn()
		const off = adapter.onSlotRelease(seen)
		start()
		pool.emit("probe-state", "p1", "stopped", pool.requests[0])
		pool.emit("probe-state", "other", "stopped", {})
		expect(seen).toHaveBeenCalledTimes(2)
		off()
		pool.emit("probe-state", "other", "stopped", {})
		expect(seen).toHaveBeenCalledTimes(2)
	})

	it("dispose unsubscribes and cancels active runs", async () => {
		const { pool, adapter, start } = setup()
		const run = start()
		adapter.dispose()
		await expect(run.result).resolves.toMatchObject({ outcome: "cancelled" })
		expect(pool.listenerCount("probe-state")).toBe(0)
	})

	it("an accepted identity without a clean replay-end is cancelled, the identity discarded", async () => {
		const { pool, start } = setup()
		const run = start()
		pool.emit("evidence", "p1", pool.requests[0], ev(true))
		pool.emit("probe-state", "p1", "stopped", pool.requests[0])
		await expect(run.result).resolves.toEqual({
			outcome: "cancelled",
			decoded: null,
		})
	})
})
