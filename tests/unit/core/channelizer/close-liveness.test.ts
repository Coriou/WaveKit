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
 * process is wedged: it wrote no event line in the window. A slow but live process keeps its generation:
 * while a control line waits behind input, its main loop reports `progress` (runtime.rs `maybe_progress`).
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

/** runtime.rs PROGRESS_EVERY. */
const PROGRESS_EVERY_MS = 50

/**
 * Models wavekit-chan's main loop: every 10 ms it reads up to `readPerTick` bytes of stdin. A stdin write
 * completes only once all of it is read, so Node's `writableLength` holds bytes the process already took.
 * While a close is owed and input was read, it writes `progress` like the runtime.
 */
class Proc extends EventEmitter implements ChannelizerProcessLike {
	/** False: the main loop stops (wedged). */
	reading = true
	/** 1 MiB per 10 ms turn: far faster than any feed. */
	readPerTick = 1 << 20
	readonly closes: string[] = []
	inputBytes = 0
	private readonly writes: { left: number; done: () => void }[] = []
	private readonly owed = new Set<string>()
	private owedSince = 0
	private lastProgress: number | undefined
	private progressInput = 0
	private loop: ReturnType<typeof setInterval> | undefined
	readonly input = new Writable({
		highWaterMark: 4096,
		write: (chunk: Buffer, _enc, done) => {
			this.writes.push({ left: chunk.length, done })
		},
	})
	constructor(readonly generation: number) {
		super()
	}
	start(): Promise<void> {
		this.loop = setInterval(() => this.turn(), 10)
		this.event({ v: 1, type: "ready", generation: this.generation, pid: 3 })
		return Promise.resolve()
	}
	stop(): Promise<void> {
		clearInterval(this.loop)
		for (const w of this.writes.splice(0)) w.done()
		this.input.destroy()
		this.emit("exit", 0, null)
		return Promise.resolve()
	}
	private turn() {
		if (!this.reading) return
		let budget = this.readPerTick
		while (budget > 0 && this.writes.length > 0) {
			const w = this.writes[0]!
			const n = Math.min(budget, w.left)
			w.left -= n
			budget -= n
			this.inputBytes += n
			if (w.left === 0) {
				this.writes.shift()
				w.done()
			}
		}
		const now = Date.now()
		const due = (t: number) => now - t >= PROGRESS_EVERY_MS
		const input = Math.floor(this.inputBytes / 2)
		if (
			this.owed.size > 0 &&
			due(this.owedSince) &&
			(this.lastProgress === undefined || due(this.lastProgress)) &&
			input > this.progressInput
		) {
			this.lastProgress = now
			this.progressInput = input
			this.event({
				v: 1,
				type: "progress",
				generation: this.generation,
				inputSamples: input,
			})
		}
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
		else if (r.type === "close") {
			// Answered by the test.
			this.closes.push(r.id)
			if (this.owed.size === 0) this.owedSince = Date.now()
			this.owed.add(r.id)
		}
	}
	closed(id: string) {
		this.owed.delete(id)
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

/** Advances `ms` in 10 ms steps, letting each verdict's setImmediate run. */
async function run(ms: number, stop = () => false) {
	for (let t = 0; t < ms && !stop(); t += 10) {
		await vi.advanceTimersByTimeAsync(10)
		await flushImmediates()
	}
}

it("a slow reader inside one large pending stdin write keeps its generation (Node's writableLength stays flat)", async () => {
	const { m, fanout, processes, invalidations, acquire } = setup(false)
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	const proc = processes[0]!
	proc.readPerTick = 4096 // 4 KiB per 10 ms
	fanout.distribute(Buffer.alloc(8 << 20)) // one 8 MiB chunk
	await flushImmediates()
	const release = m.releaseChannel(slot.channelId)
	const pendingAtSend = proc.input.writableLength
	const readAtSend = proc.inputBytes
	await run(400) // `closed` is delayed by 400 ms
	// The process read input all along, yet the stdin write it is inside never completed.
	expect(proc.inputBytes - readAtSend).toBeGreaterThanOrEqual(150_000)
	expect(proc.input.writableLength).toBe(pendingAtSend)
	proc.closed("slot-g1")
	await release
	await run(500)
	expect(invalidations).toEqual([])
	expect(processes).toHaveLength(1)
	expect(steady.stream.destroyed).toBe(false)
	const again = await m.requestChannel("rtl", "slot", request, caps)
	expect(again).toMatchObject({ ok: true, generation: 1 })
})

it("property: a live reader never retires; one that stops with the close unanswered retires within two windows", async () => {
	// Feature: channelizer close liveness, Property 1: no retire while the process reads input; retire once it stops
	// Validates: wedge check of an unconfirmed close
	await fc.assert(
		fc.asyncProperty(
			// 512 B to 16 KiB per 10 ms turn: down to 51 200 B/s, far below the source rate.
			fc.integer({ min: 512, max: 16_384 }),
			// Split of the input the process reads; the first chunk always lands (empty branch).
			fc.array(fc.integer({ min: 1, max: 262_144 }), { maxLength: 8 }),
			// How long the process stays live with the close unanswered, then how it ends.
			fc.integer({ min: 0, max: 1000 }),
			fc.boolean(),
			async (readPerTick, extra, liveMs, wedge) => {
				const ctx = setup(false)
				const { m, fanout, processes, invalidations, acquire } = ctx
				try {
					const steady = await acquire("steady")
					const slot = await acquire("slot")
					const proc = processes[0]!
					proc.readPerTick = readPerTick
					// 200 turns (2 s) of reading, past liveMs + two windows: the process never runs dry.
					fanout.distribute(Buffer.alloc(readPerTick * 200))
					for (const n of extra) fanout.distribute(Buffer.alloc(n))
					await flushImmediates()
					void m.releaseChannel(slot.channelId)
					await run(liveMs)
					expect(invalidations).toEqual([])
					if (wedge) {
						proc.reading = false
						// The window in progress may still see the last progress line; the next one cannot.
						await run(2 * 250 + 20, () => invalidations.length > 0)
						expect(invalidations).toEqual([
							["rtl", 1, ["steady-g1"], "close-unconfirmed"],
						])
						expect(steady.stream.destroyed).toBe(true)
					} else {
						proc.closed("slot-g1")
						await run(600)
						expect(invalidations).toEqual([])
						expect(steady.stream.destroyed).toBe(false)
					}
				} finally {
					cleanups.splice(cleanups.indexOf(ctx.destroy), 1)
					await ctx.destroy()
				}
			},
		),
		{ numRuns: 100 },
	)
}, 60_000) // 100 runs of up to 1.5 s fake time each; about 2 s idle, far more on a loaded host

type Internals = {
	active: Map<string, { closing: Map<string, { waiters: Set<unknown> }> }>
}

it("same-id acquisitions that give up while a close is fenced leave no waiter behind", async () => {
	const { m, processes, invalidations, acquire } = setup()
	await acquire("steady")
	const slot = await acquire("slot")
	void m.releaseChannel(slot.channelId) // `closed` is withheld; the process stays live
	await run(250)
	const fence = (m as unknown as Internals).active
		.get("rtl")!
		.closing.get("slot-g1")!
	for (let i = 0; i < 50; i++) {
		const abort = new AbortController()
		const r = m.requestChannel("rtl", "slot", request, caps, abort.signal)
		await flushImmediates()
		expect(fence.waiters.size).toBe(1)
		abort.abort()
		expect(await r).toMatchObject({ ok: false })
		expect(fence.waiters.size).toBe(0)
	}
	expect(invalidations).toEqual([])
	processes[0]!.closed("slot-g1")
	expect(await m.requestChannel("rtl", "slot", request, caps)).toMatchObject({
		ok: true,
		generation: 1,
	})
})
