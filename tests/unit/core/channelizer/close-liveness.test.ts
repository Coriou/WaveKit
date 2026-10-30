import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { PassThrough, Writable } from "node:stream"
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

function setup() {
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
	const feed = setInterval(() => fanout.distribute(Buffer.alloc(40_960)), 10)
	cleanups.push(async () => {
		clearInterval(feed)
		await m.destroy()
	})
	const acquire = async (id: string) => {
		const r = await m.requestChannel("rtl", id, request, caps)
		if (!r.ok) throw new Error(r.detail)
		return r
	}
	return { m, processes, invalidations, acquire }
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
