import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { PassThrough, Writable } from "node:stream"
import fc from "fast-check"
import pino from "pino"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../../src/config.js"
import { ChannelizerManager } from "../../../../src/core/channelizer/channelizer-manager.js"
import type {
	ChannelizerProcessLike,
	ChannelizerProcessOptions,
} from "../../../../src/core/channelizer/channelizer-process.js"
import type {
	ChannelizerEvent,
	ChannelizerRequest,
} from "../../../../src/core/channelizer/protocol.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"

/**
 * An unconfirmed close retires the generation (every channel, the branch, the process) only when the
 * process is wedged: it consumed no input in the window. A slow but live process keeps its generation.
 */
const logger = pino({ level: "silent" })
const caps: SourceCaps = {
	kind: "iq",
	format: "U8_IQ",
	sampleRate: 2_048_000,
	centerFreq: 162e6,
	exclusive: false,
}
const request = {
	centerHz: 162e6,
	bandwidthHz: 12_500,
	transitionHz: 2_500,
	outputRateHz: 48_000,
	format: "cu8" as const,
}

class Proc extends EventEmitter implements ChannelizerProcessLike {
	/** False: the process stops reading stdin (wedged). */
	reading = true
	readonly closes: string[] = []
	private held: (() => void)[] = []
	readonly input = new Writable({
		highWaterMark: 4096,
		write: (_chunk: Buffer, _enc, done) => {
			if (this.reading) done()
			else this.held.push(done)
		},
	})
	constructor(readonly generation: number) {
		super()
	}
	start(): Promise<void> {
		this.event({ v: 1, type: "ready", generation: this.generation, pid: 3 })
		return Promise.resolve()
	}
	stop(): Promise<void> {
		for (const done of this.held.splice(0)) done()
		this.input.destroy()
		this.emit("exit", 0, null)
		return Promise.resolve()
	}
	event(e: ChannelizerEvent) {
		this.emit("event", e)
	}
	send(r: ChannelizerRequest) {
		if (r.type === "open")
			this.event({
				v: 1,
				type: "opened",
				generation: this.generation,
				id: r.id,
				socket: `/tmp/${r.id}.sock`,
				outputRateHz: r.outputRateHz,
				format: r.format,
				filterTaps: 63,
				groupDelaySamples: 31,
			})
		else if (r.type === "close") this.closes.push(r.id) // answered by the test
	}
	closed(id: string) {
		this.event({
			v: 1,
			type: "closed",
			generation: this.generation,
			id,
			reason: "requested",
		})
	}
}

const flushImmediates = () => new Promise<void>(done => setImmediate(done))
let dir: string
const cleanups: (() => Promise<void>)[] = []
beforeEach(() => {
	dir = mkdtempSync("/tmp/wkcl-")
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"Date",
		],
	})
})
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c()
	expect(vi.getTimerCount()).toBe(0)
	vi.useRealTimers()
	rmSync(dir, { recursive: true, force: true })
})

/** `feed: false`: the test drives every input byte through `fanout.distribute`. */
function setup(feed = true) {
	const sources = Object.assign(new EventEmitter(), { getCaps: () => caps })
	const fanout = new FanoutManager(logger)
	const processes: Proc[] = []
	const m = new ChannelizerManager({
		sourceManager: sources as never,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		logger,
		openNow: Date.now,
		connect: () => Promise.resolve(new PassThrough()),
		createProcess: (o: ChannelizerProcessOptions) => {
			const p = new Proc(o.generation)
			processes.push(p)
			return p
		},
	})
	const invalidations: unknown[][] = []
	m.on("channel-invalidated", (...args: unknown[]) => invalidations.push(args))
	// 10 ms of 2.048 Msps CU8 per tick: 40 960 B.
	const ticker = feed
		? setInterval(() => fanout.distribute(Buffer.alloc(40_960)), 10)
		: undefined
	const destroy = async () => {
		clearInterval(ticker)
		await m.destroy()
	}
	cleanups.push(destroy)
	const acquire = async (id: string) => {
		const r = await m.requestChannel("rtl", id, request, caps)
		if (!r.ok) throw new Error(r.detail)
		return r
	}
	return { m, fanout, processes, invalidations, acquire, destroy }
}

it("a live process's slow close keeps the generation; same-id reuse waits for the real closed", async () => {
	const { m, processes, invalidations, acquire } = setup()
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	let released = false
	void m.releaseChannel(slot.channelId).then(() => {
		released = true
	})
	await vi.advanceTimersByTimeAsync(250)
	await flushImmediates()
	// The caller's wait is still bounded by the 250 ms budget.
	expect(released).toBe(true)
	const reuse = m.requestChannel("rtl", "slot", request, caps)
	// Three more checks (750 ms) of a process that keeps consuming input.
	for (let i = 0; i < 3; i++) {
		await vi.advanceTimersByTimeAsync(250)
		await flushImmediates()
	}
	expect(invalidations).toEqual([])
	expect(processes[0]!.closes).toEqual(["slot-g1"])
	processes[0]!.closed("slot-g1")
	expect(await reuse).toMatchObject({
		ok: true,
		generation: 1,
		channelId: "slot-g1",
	})
	expect(processes).toHaveLength(1)
	expect(steady.stream.destroyed).toBe(false)
})

it("a reply read in the same loop turn as a late timer (event-loop stall) never retires", async () => {
	const { m, processes, invalidations, acquire } = setup()
	await acquire("steady")
	const slot = await acquire("slot")
	// No input consumed in the window (stdin stalled first): only the reply can save it.
	processes[0]!.reading = false
	await vi.advanceTimersByTimeAsync(100)
	const release = m.releaseChannel(slot.channelId)
	// The 250 ms timer fires late, in the timers phase (synchronous advance: no turn passes).
	vi.advanceTimersByTime(300)
	processes[0]!.closed("slot-g1") // the `closed` line the stalled loop reads in this turn
	await flushImmediates()
	await release
	expect(invalidations).toEqual([])
	expect(processes).toHaveLength(1)
})

it("a process that stops consuming input with a close pending is retired as wedged", async () => {
	const { m, processes, invalidations, acquire } = setup()
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	void m.releaseChannel(slot.channelId)
	await vi.advanceTimersByTimeAsync(250)
	await flushImmediates()
	expect(invalidations).toEqual([]) // alive so far
	processes[0]!.reading = false
	// Branch and stdin buffers fill, then nothing more is consumed: the next full window retires.
	for (let i = 0; i < 4 && invalidations.length === 0; i++) {
		await vi.advanceTimersByTimeAsync(250)
		await flushImmediates()
	}
	expect(invalidations).toEqual([
		["rtl", 1, ["steady-g1"], "close-unconfirmed"],
	])
	expect(steady.stream.destroyed).toBe(true)
})

/**
 * Reaches the wedge verdict for a close sent after `before` bytes were consumed and `after` more bytes were consumed,
 * then stdin stalls on `stalled` (the first held write) while `flood` piles onto the branch behind it.
 */
async function verdictAfterBackpressure(
	before: number[],
	after: number[],
	stalled: number,
	flood: number[],
) {
	const ctx = setup(false)
	const { m, fanout, processes, invalidations, acquire } = ctx
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	for (const n of before) fanout.distribute(Buffer.alloc(n))
	await flushImmediates()
	void m.releaseChannel(slot.channelId) // `closed` is withheld
	for (const n of after) fanout.distribute(Buffer.alloc(n))
	await flushImmediates()
	processes[0]!.reading = false
	fanout.distribute(Buffer.alloc(stalled))
	await flushImmediates()
	for (const n of flood) fanout.distribute(Buffer.alloc(n))
	await flushImmediates()
	await vi.advanceTimersByTimeAsync(250)
	await flushImmediates()
	const first = [...invalidations]
	// Nothing more is consumed: the next window is a wedge.
	await vi.advanceTimersByTimeAsync(250)
	await flushImmediates()
	return { ctx, first, second: [...invalidations], steady }
}

it("input consumed before stdin backpressure counts as progress (branch buffers never move the mark back)", async () => {
	const { first, second, steady } = await verdictAfterBackpressure(
		[32_768],
		[32_768],
		4096,
		Array.from({ length: 16 }, () => 65_536),
	)
	expect(first).toEqual([])
	expect(second).toEqual([["rtl", 1, ["steady-g1"], "close-unconfirmed"]])
	expect(steady.stream.destroyed).toBe(true)
})

it("property: the progress mark is monotonic under backpressure with variable chunk sizes", async () => {
	// Feature: channelizer close liveness, Property 1: no retire while input progressed since the close; retire once it stops
	// Validates: wedge check of an unconfirmed close
	// The branch mark at 2.048 Msps CU8 is 250 ms of 4 096 000 B/s = 1 024 000 B; a flood totalling at least
	// 1 048 576 B fills it, so a chunk stalls inside the branch's PassThrough (the double-counted state).
	const floodTotal = 1_048_576
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.integer({ min: 1, max: 131_072 }), { maxLength: 6 }),
			// Consumed after the close: 1 B to 64 KiB, no more than the stalled branch chunk can mask.
			fc.array(fc.integer({ min: 1, max: 32_768 }), {
				minLength: 1,
				maxLength: 2,
			}),
			// At or past the fake stdin's 4096-byte mark, so the pipe pauses the branch.
			fc.integer({ min: 4096, max: 131_072 }),
			fc.array(fc.integer({ min: 1, max: 131_072 }), { maxLength: 24 }),
			async (before, after, stalled, head) => {
				const flood = [...head]
				let total = flood.reduce((a, n) => a + n, 0)
				for (let i = 0; total < floodTotal; i++) {
					const n = 32_768 + ((i * 24_593) % 98_305) // 32 KiB to 128 KiB, varied
					flood.push(n)
					total += n
				}
				const { ctx, first, second } = await verdictAfterBackpressure(
					before,
					after,
					stalled,
					flood,
				)
				try {
					expect(first).toEqual([])
					expect(second).toEqual([
						["rtl", 1, ["steady-g1"], "close-unconfirmed"],
					])
				} finally {
					cleanups.splice(cleanups.indexOf(ctx.destroy), 1)
					await ctx.destroy()
				}
			},
		),
		{ numRuns: 100 },
	)
})
