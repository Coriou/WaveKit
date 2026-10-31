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
import {
	ChannelizerManager,
	WEDGE_MS,
} from "../../../../src/core/channelizer/channelizer-manager.js"
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
 * An unconfirmed close never retires the generation by itself: the caller returns after 250 ms and the id stays
 * fenced until `closed`. Only the generation watchdog retires a process, when it owes work (a control reply, or stdin
 * bytes written but not acknowledged by `progress.inputBytes`) and wrote no event line for WEDGE_MS. The runtime
 * writes `progress` after main-loop work at most every 100 ms (runtime.rs `maybe_progress`), between channel steps
 * once a block has run 100 ms, so a busy process is never mistaken for a wedged one.
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
const PROGRESS_EVERY_MS = 100
/** channelizer-manager.ts WATCH_EVERY_MS: how late queued stdin can be noticed. */
const WATCH_EVERY_MS = 250

/**
 * Models wavekit-chan's main loop as a sequence of jobs, each of which completes after its duration: a long work unit
 * (`units`, e.g. one channel's DSP step of a block), a control line (a close, answered after `closeHandlingMs` when
 * `answerCloses`), or a 10 ms input turn reading up to `readPerTick` bytes of stdin. A stdin write completes once all
 * but `pipeBytes` of the unread bytes up to its end are read: 0 keeps every write pending until read (Node's
 * `writableLength` holds bytes the process already took); an OS pipe's 64 KiB completes a small write at once
 * although nothing read it. After each job that did work it writes `progress` (with the bytes read so far) at most
 * every 100 ms, like the runtime; nothing while it does no work.
 */
class Proc extends EventEmitter implements ChannelizerProcessLike {
	/** False: the main loop stops (wedged): no job completes, nothing is written. */
	reading = true
	/** 1 MiB per 10 ms turn: far faster than any feed. */
	readPerTick = 1 << 20
	/** Unread bytes the OS pipe holds: a write whose end fits completes, read or not. */
	pipeBytes = 0
	/** Long work units queued ahead of the next job, in ms. */
	readonly units: number[] = []
	/** True: the loop answers closes itself, in FIFO order after queued units. False: the test answers. */
	answerCloses = false
	/** How long handling one close keeps the loop silent (the pre-fix bounded writer join). */
	closeHandlingMs = 0
	readonly closes: string[] = []
	readonly progressAt: number[] = []
	inputBytes = 0
	private readonly writes: {
		left: number
		done: () => void
		completed: boolean
	}[] = []
	private readonly controls: string[] = []
	private work = 0
	private progressWork = 0
	private lastProgress = -Infinity
	private loop: ReturnType<typeof setTimeout> | undefined
	private stopped = false
	readonly input = new Writable({
		highWaterMark: 4096,
		write: (chunk: Buffer, _enc, done) => {
			this.writes.push({ left: chunk.length, done, completed: false })
			this.settle()
		},
	})
	constructor(readonly generation: number) {
		super()
	}
	start(): Promise<void> {
		this.next()
		this.event({ v: 1, type: "ready", generation: this.generation, pid: 3 })
		return Promise.resolve()
	}
	stop(): Promise<void> {
		this.stopped = true
		clearTimeout(this.loop)
		for (const w of this.writes.splice(0)) if (!w.completed) w.done()
		this.input.destroy()
		this.emit("exit", 0, null)
		return Promise.resolve()
	}
	private next() {
		if (this.stopped) return
		const unit = this.units.shift()
		const close =
			unit === undefined && this.answerCloses
				? this.controls.shift()
				: undefined
		const ms = unit ?? (close !== undefined ? this.closeHandlingMs : 10)
		this.loop = setTimeout(() => {
			if (!this.reading) {
				// Wedged: this job never completes; look again later so a test may resume it.
				if (unit !== undefined) this.units.unshift(unit)
				if (close !== undefined) this.controls.unshift(close)
				this.loop = setTimeout(() => this.next(), 10)
				return
			}
			if (unit !== undefined) this.work++
			else if (close !== undefined) {
				this.work++
				this.closed(close)
			} else this.read()
			this.maybeProgress()
			this.next()
		}, ms)
	}
	private read() {
		let budget = this.readPerTick
		while (budget > 0 && this.writes.length > 0) {
			const w = this.writes[0]!
			const n = Math.min(budget, w.left)
			w.left -= n
			budget -= n
			this.inputBytes += n
			if (w.left === 0) {
				this.writes.shift()
				if (!w.completed) w.done()
			}
		}
		this.settle()
		if (budget < this.readPerTick) this.work++
	}
	/** Completes every write whose end is now within the pipe's unread bytes. */
	private settle() {
		let unread = 0
		for (const w of this.writes) {
			unread += w.left
			if (unread > this.pipeBytes) break
			if (!w.completed) {
				w.completed = true
				w.done()
			}
		}
	}
	private maybeProgress() {
		const now = Date.now()
		if (
			this.work === this.progressWork ||
			now - this.lastProgress < PROGRESS_EVERY_MS
		)
			return
		this.lastProgress = now
		this.progressWork = this.work
		this.progressAt.push(now)
		this.event({
			v: 1,
			type: "progress",
			generation: this.generation,
			inputSamples: Math.floor(this.inputBytes / 2),
			inputBytes: this.inputBytes,
		})
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
			this.closes.push(r.id)
			this.controls.push(r.id)
		}
	}
	closed(id: string) {
		const k = this.controls.indexOf(id)
		if (k >= 0) this.controls.splice(k, 1)
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
function setup(feed = true, openTimeoutMs?: number) {
	const sources = Object.assign(new EventEmitter(), { getCaps: () => caps })
	const fanout = new FanoutManager(logger)
	const processes: Proc[] = []
	const m = new ChannelizerManager({
		sourceManager: sources as never,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		logger,
		openNow: Date.now,
		...(openTimeoutMs !== undefined ? { openTimeoutMs } : {}),
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

/** Advances `ms` in 10 ms steps (a last partial step for the rest), letting each verdict's setImmediate run. */
async function run(ms: number, stop = () => false) {
	for (let t = 0; t < ms && !stop(); t += 10) {
		await vi.advanceTimersByTimeAsync(Math.min(10, ms - t))
		await flushImmediates()
	}
}

it("a live process's slow close keeps the generation; same-id reuse waits for the real closed", async () => {
	const { m, processes, invalidations, acquire } = setup()
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	let released = false
	void m.releaseChannel(slot.channelId).then(() => {
		released = true
	})
	await run(250)
	// The caller's wait is still bounded by the 250 ms budget.
	expect(released).toBe(true)
	const reuse = m.requestChannel("rtl", "slot", request, caps)
	// Well past WEDGE_MS of a process that keeps consuming input.
	await run(2 * WEDGE_MS)
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

it("a close queued behind two 150 ms work units keeps the generation and is answered after them", async () => {
	const { m, processes, invalidations, acquire } = setup()
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	const proc = processes[0]!
	proc.answerCloses = true
	await run(200) // the loop has reported progress before
	// The close arrives just as the loop starts the first unit: no line for the first 150 ms.
	proc.units.push(150, 150)
	const sentAt = Date.now()
	let closedAt: number | undefined
	proc.on("event", (e: ChannelizerEvent) => {
		if (e.type === "closed") closedAt = Date.now()
	})
	const release = m.releaseChannel(slot.channelId)
	await run(WEDGE_MS)
	await release
	expect(closedAt).toBeDefined()
	expect(closedAt! - sentAt).toBeGreaterThanOrEqual(300)
	expect(invalidations).toEqual([])
	expect(steady.stream.destroyed).toBe(false)
	expect(processes).toHaveLength(1)
})

it("a close whose handling stalls the loop 300 ms with another channel open keeps both", async () => {
	const { m, processes, invalidations, acquire } = setup()
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	const proc = processes[0]!
	proc.answerCloses = true
	proc.closeHandlingMs = 300 // the writer join the runtime used to do inside close
	await run(200)
	const release = m.releaseChannel(slot.channelId)
	await run(WEDGE_MS)
	await release
	expect(proc.closes).toEqual(["slot-g1"])
	expect(invalidations).toEqual([])
	expect(steady.stream.destroyed).toBe(false)
	expect(processes).toHaveLength(1)
	expect(await m.requestChannel("rtl", "slot", request, caps)).toMatchObject({
		ok: true,
		generation: 1,
	})
})

it("a wedged process owing a close is retired at WEDGE_MS after the send, not before", async () => {
	const { m, processes, invalidations, acquire } = setup(false)
	const steady = await acquire("steady")
	const slot = await acquire("slot")
	const proc = processes[0]!
	proc.reading = false
	await run(WEDGE_MS * 2) // nothing owed: silence alone is not a wedge
	expect(invalidations).toEqual([])
	void m.releaseChannel(slot.channelId)
	await run(WEDGE_MS - 1)
	expect(invalidations).toEqual([])
	expect(steady.stream.destroyed).toBe(false)
	await run(1)
	expect(invalidations).toEqual([["rtl", 1, ["steady-g1"], "unresponsive"]])
	expect(steady.stream.destroyed).toBe(true)
	expect(processes).toHaveLength(1) // retirement itself never respawns
})

it("a close sent right after another was answered gets its own full window", async () => {
	const { m, processes, invalidations, acquire } = setup(false)
	await acquire("steady")
	const first = await acquire("first")
	const second = await acquire("second")
	const proc = processes[0]!
	const release = m.releaseChannel(first.channelId)
	await run(30)
	proc.closed("first-g1") // answered; the watchdog has not sampled since
	await release
	proc.reading = false
	await run(100) // idle and owing nothing: not part of the next window
	void m.releaseChannel(second.channelId)
	await run(WEDGE_MS - 1)
	expect(invalidations).toEqual([])
	await run(1)
	expect(invalidations).toEqual([["rtl", 1, ["steady-g1"], "unresponsive"]])
})

it("a wedged process with input queued in its stdin is retired within WEDGE_MS + one watch period", async () => {
	const { processes, invalidations, acquire } = setup()
	const steady = await acquire("steady")
	await run(200)
	processes[0]!.reading = false
	const wedgedAt = Date.now()
	await run(WEDGE_MS + WATCH_EVERY_MS + 20, () => invalidations.length > 0)
	expect(invalidations).toEqual([["rtl", 1, ["steady-g1"], "unresponsive"]])
	expect(Date.now() - wedgedAt).toBeGreaterThanOrEqual(
		WEDGE_MS - PROGRESS_EVERY_MS,
	)
	expect(steady.stream.destroyed).toBe(true)
})

/** A Linux pipe's default capacity: a write that fits completes although the process never reads it. */
const PIPE_BYTES = 65_536

it("a wedged process with a final 4 KiB in its OS pipe is retired although Node's writableLength is 0", async () => {
	const { fanout, processes, invalidations, acquire } = setup(false)
	const steady = await acquire("steady")
	const proc = processes[0]!
	proc.pipeBytes = PIPE_BYTES
	fanout.distribute(Buffer.alloc(40_960))
	await run(200) // read and acknowledged
	expect(proc.inputBytes).toBe(40_960)
	proc.reading = false
	fanout.distribute(Buffer.alloc(4096)) // the last write; nothing more is fed
	await flushImmediates()
	expect(proc.input.writableLength).toBe(0) // the pipe took it: Node's buffers show nothing owed
	const wroteAt = Date.now()
	await run(WEDGE_MS - 10)
	expect(invalidations).toEqual([])
	await run(WATCH_EVERY_MS + 30, () => invalidations.length > 0)
	expect(invalidations).toEqual([["rtl", 1, ["steady-g1"], "unresponsive"]])
	// Silence counts from when the owed bytes were first sampled, never from before the write.
	expect(Date.now() - wroteAt).toBeGreaterThanOrEqual(WEDGE_MS)
	expect(steady.stream.destroyed).toBe(true)
	expect(proc.inputBytes).toBe(40_960)
})

it("a live process that drains a final 4 KiB from its OS pipe acknowledges it and is kept while idle", async () => {
	const { m, fanout, processes, invalidations, acquire } = setup(false)
	const steady = await acquire("steady")
	const proc = processes[0]!
	proc.pipeBytes = PIPE_BYTES
	fanout.distribute(Buffer.alloc(40_960))
	await run(200)
	fanout.distribute(Buffer.alloc(4096))
	await flushImmediates()
	expect(proc.input.writableLength).toBe(0)
	await run(10 * WEDGE_MS)
	expect(proc.inputBytes).toBe(40_960 + 4096)
	const s = (
		m as unknown as {
			active: Map<string, { inputWritten: number; inputAcked: number }>
		}
	).active.get("rtl")!
	expect([s.inputWritten, s.inputAcked]).toEqual([45_056, 45_056])
	// The acknowledgement came with the last line; idle since, owing nothing.
	expect(proc.progressAt.at(-1)!).toBeLessThan(Date.now() - 9 * WEDGE_MS)
	expect(invalidations).toEqual([])
	expect(steady.stream.destroyed).toBe(false)
})

it("one block of 16 channel steps of 180 ms (2.9 s, longer than WEDGE_MS) keeps a generation that owes input", async () => {
	// The reviewed repro: 16 wideband channels took 2.88 s for one 32 768-sample block. The runtime reports between
	// channel steps once the block has run 100 ms, so each 180 ms step ends with a line; input stays owed meanwhile.
	const { fanout, processes, invalidations, acquire } = setup(false)
	const steady = await acquire("steady")
	const proc = processes[0]!
	proc.pipeBytes = PIPE_BYTES
	fanout.distribute(Buffer.alloc(40_960))
	await run(200)
	proc.units.push(...Array<number>(16).fill(180))
	fanout.distribute(Buffer.alloc(65_536)) // owed while the block runs
	const start = Date.now()
	await run(16 * 180 + 500)
	expect(proc.units).toEqual([])
	expect(invalidations).toEqual([])
	// From the block's start, no line later than one step plus the 10 ms turn in flight when it began.
	const lines = proc.progressAt.filter(t => t >= start)
	const gaps = lines.map((t, k) => t - (k === 0 ? start : lines[k - 1]!))
	expect(lines.length).toBeGreaterThanOrEqual(16)
	expect(Math.max(...gaps)).toBeLessThanOrEqual(190)
	expect(proc.inputBytes).toBe(40_960 + 65_536)
	expect(steady.stream.destroyed).toBe(false)
})

it("an idle process that owes nothing is never retired", async () => {
	const { processes, invalidations, acquire } = setup(false)
	const steady = await acquire("steady")
	await run(10 * WEDGE_MS)
	expect(processes[0]!.progressAt).toEqual([]) // no work, so no line at all
	expect(invalidations).toEqual([])
	expect(steady.stream.destroyed).toBe(false)
})

it("a reply read in the same loop turn as a late watchdog timer (event-loop stall) never retires", async () => {
	const { m, processes, invalidations, acquire } = setup(false)
	await acquire("steady")
	const slot = await acquire("slot")
	processes[0]!.reading = false
	void m.releaseChannel(slot.channelId)
	// The watchdog's timers fire late, in the timers phase (synchronous advance: no turn passes).
	vi.advanceTimersByTime(WEDGE_MS + 500)
	processes[0]!.closed("slot-g1") // the `closed` line the stalled loop reads in this turn
	await flushImmediates()
	await run(WATCH_EVERY_MS)
	expect(invalidations).toEqual([])
	expect(processes).toHaveLength(1)
})

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
	await run(WEDGE_MS + 400) // `closed` is delayed past a whole watchdog window
	// The process read input all along, yet the stdin write it is inside never completed.
	expect(proc.inputBytes - readAtSend).toBeGreaterThanOrEqual(800_000)
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

it("property: a working process is never retired, whatever its unit lengths; a wedged one owing work is, within one window", async () => {
	// Feature: channelizer generation watchdog, Property 1: no retire while the main loop completes work units shorter than WEDGE_MS; retire once it stops with work owed
	// Validates: generation watchdog (owed work and no event line for WEDGE_MS)
	await fc.assert(
		fc.asyncProperty(
			// 512 B to 16 KiB per 10 ms turn: down to 51 200 B/s, far below the source rate.
			fc.integer({ min: 512, max: 16_384 }),
			// Long units queued with the close (DSP blocks, the old writer join). The last line before a unit can be up
			// to one PROGRESS_EVERY (+ a 10 ms turn) old, so a unit stays silent-safe below WEDGE_MS - 2 × 100 = 1800 ms.
			fc.array(fc.integer({ min: 1, max: WEDGE_MS - 2 * PROGRESS_EVERY_MS }), {
				maxLength: 3,
			}),
			// How long the close waits for an answer while the process works, then how it ends.
			fc.integer({ min: 0, max: 3000 }),
			fc.boolean(),
			async (readPerTick, units, liveMs, wedge) => {
				const ctx = setup(false)
				const { m, fanout, processes, invalidations, acquire } = ctx
				try {
					const steady = await acquire("steady")
					const slot = await acquire("slot")
					const proc = processes[0]!
					proc.readPerTick = readPerTick
					// Enough to read through every unit, liveMs and a window: the process never runs dry.
					fanout.distribute(Buffer.alloc(readPerTick * 1000))
					await flushImmediates()
					proc.units.push(...units)
					void m.releaseChannel(slot.channelId)
					await run(liveMs + units.reduce((a, b) => a + b, 0))
					expect(invalidations).toEqual([])
					if (wedge) {
						proc.reading = false
						// The close is still owed: retired one window after the last line it wrote.
						await run(WEDGE_MS + 20, () => invalidations.length > 0)
						expect(invalidations).toEqual([
							["rtl", 1, ["steady-g1"], "unresponsive"],
						])
						expect(steady.stream.destroyed).toBe(true)
					} else {
						proc.closed("slot-g1")
						await run(WEDGE_MS)
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
}, 240_000) // 100 runs of up to 9 s fake time each in 10 ms steps; far longer on a loaded host

type Internals = {
	active: Map<string, { closing: Map<string, { waiters: Set<unknown> }> }>
}
const fenceOf = (m: ChannelizerManager, id: string) =>
	(m as unknown as Internals).active.get("rtl")!.closing.get(id)!

it("same-id acquisitions that give up while a close is fenced leave no waiter behind", async () => {
	const { m, processes, invalidations, acquire } = setup()
	await acquire("steady")
	const slot = await acquire("slot")
	void m.releaseChannel(slot.channelId) // `closed` is withheld; the process stays live
	await run(250)
	const fence = fenceOf(m, "slot-g1")
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

it("same-id acquisitions whose deadline expires while a close is fenced leave no waiter behind", async () => {
	const OPEN_TIMEOUT_MS = 1000
	const { m, processes, invalidations, acquire } = setup(true, OPEN_TIMEOUT_MS)
	await acquire("steady")
	const slot = await acquire("slot")
	void m.releaseChannel(slot.channelId) // `closed` is withheld; the process stays live
	await run(250)
	const fence = fenceOf(m, "slot-g1")
	for (let i = 0; i < 3; i++) {
		const r = m.requestChannel("rtl", "slot", request, caps)
		await flushImmediates()
		expect(fence.waiters.size).toBe(1)
		await run(OPEN_TIMEOUT_MS - 10)
		expect(fence.waiters.size).toBe(1)
		await run(10)
		expect(await r).toMatchObject({
			ok: false,
			detail: `channel request timed out after ${OPEN_TIMEOUT_MS} ms`,
		})
		expect(fence.waiters.size).toBe(0)
	}
	expect(invalidations).toEqual([])
	processes[0]!.closed("slot-g1")
	expect(await m.requestChannel("rtl", "slot", request, caps)).toMatchObject({
		ok: true,
		generation: 1,
	})
})
