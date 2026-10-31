import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { PassThrough } from "node:stream"
import pino from "pino"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../src/config.js"
import {
	ChannelizerManager,
	WEDGE_MS,
} from "../../../src/core/channelizer/channelizer-manager.js"
import type {
	ChannelizerProcessLike,
	ChannelizerProcessOptions,
} from "../../../src/core/channelizer/channelizer-process.js"
import type {
	ChannelizerRequest,
	ChannelizerEvent,
} from "../../../src/core/channelizer/protocol.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"

const root = `/tmp/wkc-life-${process.pid}`
const logger = pino({ level: "silent" })
const caps = (sampleRate = 2_048_000): SourceCaps => ({
	kind: "iq",
	format: "U8_IQ",
	sampleRate,
	centerFreq: 162e6,
	exclusive: false,
})
const request = {
	centerHz: 162e6,
	bandwidthHz: 45_600,
	transitionHz: 1_200,
	outputRateHz: 48_000,
	format: "cf32" as const,
}
type Open = Extract<ChannelizerRequest, { type: "open" }>
class Sources extends EventEmitter {
	current: SourceCaps | undefined = caps()
	getCaps() {
		return this.current
	}
}
class Process extends EventEmitter implements ChannelizerProcessLike {
	readonly input = new PassThrough()
	readonly sent: ChannelizerRequest[] = []
	stops = 0
	constructor(
		readonly generation: number,
		readonly sendHook: (p: Process, r: ChannelizerRequest) => void,
		readonly startHook?: (p: Process) => Promise<void>,
	) {
		super()
	}
	start(): Promise<void> {
		if (this.startHook) return this.startHook(this)
		this.ready()
		return Promise.resolve()
	}
	ready() {
		this.emit("event", {
			v: 1,
			type: "ready",
			generation: this.generation,
			pid: 42,
		})
	}
	send(r: ChannelizerRequest) {
		this.sent.push(r)
		this.sendHook(this, r)
	}
	private heartbeat: ReturnType<typeof setTimeout> | undefined
	/** Reports `progress` every 100 ms until stopped, like a runtime whose main loop keeps working (planner polls). */
	live() {
		this.heartbeat = setTimeout(() => {
			this.event({
				v: 1,
				type: "progress",
				generation: this.generation,
				inputSamples: 0,
			})
			this.live()
		}, 100)
	}
	stop(): Promise<void> {
		this.stops++
		clearTimeout(this.heartbeat)
		this.input.destroy()
		this.emit("exit", 0, null)
		return Promise.resolve()
	}
	event(e: ChannelizerEvent) {
		this.emit("event", e)
	}
	opened(r: Open) {
		this.event({
			v: 1,
			type: "opened",
			generation: this.generation,
			id: r.id,
			socket: `${root}/${r.id}.sock`,
			outputRateHz: r.outputRateHz,
			format: r.format,
			filterTaps: 730,
			groupDelaySamples: 3,
		})
	}
	rejected(
		r: Open,
		detail = "planner busy",
		reasonCode:
			| "channel-request-invalid"
			| "channel-outside-capture" = "channel-request-invalid",
	) {
		this.event({
			v: 1,
			type: "rejected",
			generation: this.generation,
			id: r.id,
			reasonCode,
			detail,
		})
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
	get opens() {
		return this.sent.filter((r): r is Open => r.type === "open")
	}
}
const managers: ChannelizerManager[] = []
function harness() {
	const sources = new Sources()
	const fanout = new FanoutManager(logger)
	const processes: Process[] = []
	const connect = vi.fn(async (_path: string) => new PassThrough())
	const h = {
		sources,
		processes,
		connect,
		onSend: (p: Process, r: ChannelizerRequest) => {
			if (r.type === "open") p.opened(r)
			else if (r.type === "close") p.closed(r.id)
		},
		onStart: undefined as ((p: Process) => Promise<void>) | undefined,
	}
	const m = new ChannelizerManager({
		sourceManager: sources as never,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: root }),
		logger,
		openNow: Date.now,
		connect,
		createProcess: (o: ChannelizerProcessOptions) => {
			const p = new Process(o.generation, (p, r) => h.onSend(p, r), h.onStart)
			processes.push(p)
			return p
		},
	})
	managers.push(m)
	return {
		...h,
		m,
		h,
		acquire: (id = "target", signal?: AbortSignal) =>
			m.requestChannel("rtl", id, request, sources.current, signal),
	}
}
const tick = () => vi.advanceTimersByTimeAsync(0)
/** Advances fake time, then lets the watchdog's setImmediate verdict (real) run. */
const settle = async (ms: number) => {
	await vi.advanceTimersByTimeAsync(ms)
	await new Promise(done => setImmediate(done))
	await tick()
}
beforeEach(() =>
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }),
)
afterEach(async () => {
	await Promise.all(managers.splice(0).map(m => m.destroy()))
	expect(vi.getTimerCount()).toBe(0)
	vi.useRealTimers()
	rmSync(root, { recursive: true, force: true })
})

describe("channelizer acquisition ownership", () => {
	it("retries exact busy sequentially and grants without duplicate consumer retries", async () => {
		const { h, processes, acquire } = harness()
		h.onSend = (p, r) => {
			if (r.type === "open") {
				if (p.opens.length < 3) p.rejected(r)
				else p.opened(r)
			} else if (r.type === "close") p.closed(r.id)
		}
		const result = acquire()
		await tick()
		expect(processes[0]!.opens).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(24)
		expect(processes[0]!.opens).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(processes[0]!.opens).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(50)
		expect(await result).toMatchObject({ ok: true, generation: 1 })
		expect(processes[0]!.opens).toHaveLength(3)
	})
	it.each([
		["planner busy ", "channel-request-invalid"],
		["Planner busy", "channel-request-invalid"],
		["prototype tap limit exceeded", "channel-request-invalid"],
		["planner busy", "channel-outside-capture"],
	] as const)(
		"never retries near-match or genuine rejection %s/%s",
		async (detail, reason) => {
			const { h, processes, acquire } = harness()
			h.onSend = (p, r) => {
				if (r.type === "open") p.rejected(r, detail, reason)
			}
			const result = acquire()
			await tick()
			expect(await result).toEqual({ ok: false, reasonCode: reason, detail })
			expect(processes[0]!.opens).toHaveLength(1)
		},
	)
	it("exhausts six total sends as unavailable, preserving genuine invalid classification", async () => {
		const { h, processes, acquire } = harness()
		h.onSend = (p, r) => {
			if (r.type === "open") p.rejected(r)
		}
		const result = acquire()
		await vi.advanceTimersByTimeAsync(775)
		expect(await result).toEqual({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "planner busy retry limit reached",
		})
		expect(processes[0]!.opens).toHaveLength(6)
	})
	it("keeps the original deadline across busy and caps supersession, retiring collateral grants truthfully", async () => {
		const { h, m, sources, processes, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		const invalidations: unknown[] = []
		m.on("channel-invalidated", (...args) => invalidations.push(args))
		h.onSend = (p, r) => {
			if (r.type === "open" && p.generation === 1 && p.opens.length === 2)
				p.rejected(r)
		}
		processes[0]!.live() // still preparing the unanswered open: the watchdog keeps it
		const result = acquire()
		await vi.advanceTimersByTimeAsync(4000)
		sources.current = caps(2_400_000)
		sources.emit("caps-changed", "rtl", sources.current)
		await tick()
		expect(alive.stream.destroyed).toBe(true)
		expect(invalidations).toEqual([["rtl", 1, ["alive-g1"], "caps-changed"]])
		expect(processes).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(1000)
		expect(await result).toEqual({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "channel request timed out after 5000 ms",
		})
		expect(processes.map(p => p.opens.length)).toEqual([3, 1]) // alive + two attempts, then one supersession send
		expect(processes[1]!.stops).toBe(1)
	})
	it("includes supersession sends in the six-send cap", async () => {
		const { h, sources, processes, acquire } = harness()
		h.onSend = (p, r) => {
			if (r.type === "open") p.rejected(r)
		}
		const result = acquire()
		await vi.advanceTimersByTimeAsync(375) // five sends, fifth backoff pending
		sources.current = caps(2_400_000)
		sources.emit("caps-changed", "rtl", sources.current)
		await tick()
		expect(await result).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
		})
		expect(processes.map(p => p.opens.length)).toEqual([5, 1])
	})
	it("settles queued cancellation promptly and never sends that canceled ID", async () => {
		const { h, processes, acquire } = harness()
		h.onSend = (p, r) => {
			if (r.type === "close") p.closed(r.id)
		}
		const firstCancel = new AbortController()
		const first = acquire("first", firstCancel.signal)
		await tick()
		const queuedCancel = new AbortController()
		const queued = acquire("queued", queuedCancel.signal)
		queuedCancel.abort("PRIVATE USER REASON")
		expect(await queued).toEqual({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "channel request cancelled",
		})
		expect(processes[0]!.opens.map(r => r.id)).toEqual(["first-g1"])
		firstCancel.abort()
		await tick()
		expect(await first).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
		})
		expect(processes[0]!.opens.map(r => r.id)).toEqual(["first-g1"])
	})
	it("aborts backoff without replaying a terminal rejected request", async () => {
		const { h, processes, acquire } = harness()
		h.onSend = (p, r) => {
			if (r.type === "open") p.rejected(r)
		}
		const controller = new AbortController()
		const result = acquire("target", controller.signal)
		await tick()
		controller.abort()
		await tick()
		expect(await result).toMatchObject({
			ok: false,
			detail: "channel request cancelled",
		})
		expect(processes[0]!.opens).toHaveLength(1)
		expect(processes[0]!.sent.some(r => r.type === "close")).toBe(false)
	})
	it("rejects a late opened during closing and never treats a post-open rejection as closure", async () => {
		const { h, m, connect, processes, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		connect.mockClear()
		const invalidations: unknown[] = []
		m.on("channel-invalidated", (...args) => invalidations.push(args))
		h.onSend = () => {}
		const controller = new AbortController()
		const result = acquire("target", controller.signal)
		await tick()
		controller.abort()
		await tick()
		const p = processes[0]!
		p.opened(p.opens[1]!)
		p.rejected(p.opens[1]!) // cannot settle after opened, even before promise continuation
		await tick()
		expect(connect).not.toHaveBeenCalled()
		expect(alive.stream.destroyed).toBe(false)
		await settle(250)
		expect(await result).toMatchObject({
			ok: false,
			detail: "channel request cancelled",
		})
		// The unconfirmed close alone retires nothing; the silent process is retired once it owed it for WEDGE_MS.
		expect(alive.stream.destroyed).toBe(false)
		await settle(WEDGE_MS - 250 - 1)
		expect(invalidations).toEqual([])
		await settle(1)
		expect(alive.stream.destroyed).toBe(true)
		expect(invalidations).toEqual([["rtl", 1, ["alive-g1"], "unresponsive"]])
		expect(p.stops).toBe(1)
		expect(p.opens).toHaveLength(2) // canceled target never replayed
	})
	it("accepts only matching current-generation pending rejection as a cancellation terminal", async () => {
		const { h, processes, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		h.onSend = () => {}
		const controller = new AbortController()
		const result = acquire("target", controller.signal)
		await tick()
		controller.abort()
		await tick()
		const p = processes[0]!
		p.rejected({ ...p.opens[1]!, id: "unrelated" })
		p.event({
			v: 1,
			type: "rejected",
			id: "target-g1",
			generation: 99,
			reasonCode: "channel-request-invalid",
			detail: "planner busy",
		})
		await tick()
		expect(alive.stream.destroyed).toBe(false)
		p.rejected(p.opens[1]!)
		expect(await result).toMatchObject({
			ok: false,
			detail: "channel request cancelled",
		})
		expect(alive.stream.destroyed).toBe(false)
	})
	it("cancels after a synchronous opened reply before any connect/grant", async () => {
		const { h, connect, acquire } = harness()
		const controller = new AbortController()
		h.onSend = (p, r) => {
			if (r.type === "open") {
				p.opened(r)
				controller.abort()
			} else if (r.type === "close") p.closed(r.id)
		}
		const result = acquire("target", controller.signal)
		await tick()
		expect(await result).toMatchObject({
			ok: false,
			detail: "channel request cancelled",
		})
		expect(connect).not.toHaveBeenCalled()
	})
	it("cleans up a delayed canceled connect after same-ID replacement without stale close", async () => {
		const { h, connect, processes, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		let resolve = (_s: PassThrough) => {}
		connect.mockImplementationOnce(
			() =>
				new Promise<PassThrough>(done => {
					resolve = done
				}),
		)
		const controller = new AbortController()
		const result = acquire("target", controller.signal)
		await tick()
		controller.abort()
		await tick()
		expect(await result).toMatchObject({
			ok: false,
			detail: "channel request cancelled",
		})
		const replacement = await acquire()
		expect(replacement).toMatchObject({
			ok: true,
			generation: 1,
			channelId: "target-g1",
		})
		const late = new PassThrough()
		resolve(late)
		await tick()
		expect(late.destroyed).toBe(true)
		expect(processes[0]!.sent.filter(r => r.type === "close")).toHaveLength(1)
		expect(alive.stream.destroyed).toBe(false)
		// Acquisition signal is detached after grant; intake/release is consumer-owned.
		const grantedController = new AbortController()
		const granted = await acquire("third", grantedController.signal)
		if (!granted.ok) throw new Error("expected grant")
		grantedController.abort()
		expect(granted.stream.destroyed).toBe(false)
		h.onSend = (p, r) => {
			if (r.type === "close") p.closed(r.id)
		}
	})
	it("shares release settlement, fences same-ID reuse, and ignores late open/reject until closed", async () => {
		const { h, m, processes, acquire } = harness()
		const alive = await acquire("alive")
		const old = await acquire()
		if (!old.ok || !alive.ok) throw new Error("expected grants")
		h.onSend = (p, r) => {
			if (r.type === "open") p.opened(r)
		}
		const release = m.releaseChannel(old.channelId)
		expect(m.releaseChannel(old.channelId)).toBe(release)
		expect(old.stream.destroyed).toBe(true)
		const replacement = acquire()
		await tick()
		const p = processes[0]!
		p.opened(p.opens[1]!)
		p.rejected(p.opens[1]!)
		await tick()
		expect(p.opens).toHaveLength(2)
		p.closed(old.channelId)
		p.opened(p.opens[1]!)
		p.rejected(p.opens[1]!) // old events in the same dispatch turn cannot satisfy the new waiter
		await release
		expect(await replacement).toMatchObject({
			ok: true,
			generation: 1,
			channelId: old.channelId,
		})
		expect(alive.stream.destroyed).toBe(false)
	})
	it("a silent process owing an open reply retires every grant once after WEDGE_MS and its late events are ignored", async () => {
		const { h, m, processes, connect, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		const events: unknown[] = []
		m.on("channel-invalidated", (...args) => events.push(args))
		// Generation 1 answers nothing more; its successor answers.
		h.onSend = (p, r) => {
			if (p.generation === 2 && r.type === "open") p.opened(r)
		}
		const result = acquire()
		await settle(WEDGE_MS - 1)
		expect(events).toEqual([])
		await settle(1)
		expect(events).toEqual([["rtl", 1, ["alive-g1"], "unresponsive"]])
		expect(alive.stream.destroyed).toBe(true)
		expect(processes[0]!.stops).toBe(1)
		// The superseded acquisition retries once against the next generation.
		expect(await result).toMatchObject({ ok: true, generation: 2 })
		const old = processes[0]!
		old.opened(old.opens[1]!)
		old.rejected(old.opens[1]!)
		old.closed(old.opens[1]!.id)
		await tick()
		expect(connect).toHaveBeenCalledTimes(2) // alive and the generation-2 grant only
		expect(processes).toHaveLength(2)
		expect(events).toHaveLength(1)
	})
	it("destroy wakes busy backoff, invalidates active grants once, and never replays", async () => {
		const { h, m, processes, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		const events: unknown[] = []
		m.on("channel-invalidated", (...args) => events.push(args))
		h.onSend = (p, r) => {
			if (r.type === "open") p.rejected(r)
		}
		const result = acquire()
		await tick()
		await m.destroy()
		expect(await result).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
		})
		expect(events).toEqual([["rtl", 1, ["alive-g1"], "destroy"]])
		expect(alive.stream.destroyed).toBe(true)
		expect(processes[0]!.opens).toHaveLength(2)
	})
	it("cleans up canceled startup and ignores a later ready without adopting its process", async () => {
		const { h, m, processes, acquire } = harness()
		let ready = () => {}
		h.onStart = p =>
			new Promise<void>(done => {
				ready = () => {
					p.ready()
					done()
				}
			})
		const controller = new AbortController()
		const result = acquire("target", controller.signal)
		await tick()
		controller.abort()
		await tick()
		expect(await result).toMatchObject({
			ok: false,
			detail: "channel request cancelled",
		})
		ready()
		await tick()
		expect(processes[0]!.opens).toHaveLength(0)
		expect(processes[0]!.stops).toBe(1)
		expect(m.currentGeneration("rtl")).toBe(1)
	})
	it("retires a silent process owing a release once after WEDGE_MS, unblocks reuse, and reports the cause", async () => {
		const { h, m, processes, acquire } = harness()
		const alive = await acquire("alive")
		const old = await acquire()
		if (!alive.ok || !old.ok) throw new Error("expected grants")
		const events: unknown[] = []
		m.on("channel-invalidated", (...args) => events.push(args))
		h.onSend = (p, r) => {
			if (r.type === "open") p.opened(r)
		}
		const release = m.releaseChannel(old.channelId)
		const replacement = acquire()
		await tick()
		expect(processes).toHaveLength(1)
		await settle(250)
		await release // the caller's wait stays bounded; the id stays fenced
		expect(events).toEqual([])
		expect(alive.stream.destroyed).toBe(false)
		await settle(WEDGE_MS - 250)
		expect(await replacement).toMatchObject({ ok: true, generation: 2 })
		expect(events).toEqual([["rtl", 1, ["alive-g1"], "unresponsive"]])
		expect(alive.stream.destroyed).toBe(true)
		expect(processes[0]!.stops).toBe(1)
	})
	it("source loss wakes backoff and cancels no more than its existing supersession allowance", async () => {
		const { h, m, sources, processes, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		const events: unknown[] = []
		m.on("channel-invalidated", (...args) => events.push(args))
		h.onSend = (p, r) => {
			if (r.type === "open") p.rejected(r)
		}
		const result = acquire()
		await tick()
		sources.current = undefined
		sources.emit("disconnected", "rtl")
		await tick()
		expect(await result).toMatchObject({
			ok: false,
			reasonCode: "channel-request-invalid",
		})
		expect(events).toEqual([["rtl", 1, ["alive-g1"], "source-lost"]])
		expect(alive.stream.destroyed).toBe(true)
		expect(processes).toHaveLength(1)
		expect(processes[0]!.opens).toHaveLength(2)
	})
	it("cancels a reply delivered synchronously before the request continuation even when rejected", async () => {
		const { h, acquire } = harness()
		const controller = new AbortController()
		h.onSend = (p, r) => {
			if (r.type === "open") {
				p.rejected(r, "genuine invalid")
				controller.abort()
			}
		}
		const result = acquire("target", controller.signal)
		await tick()
		expect(await result).toEqual({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "channel request cancelled",
		})
	})
	it("never adopts an opened channel already closed in the same event dispatch turn", async () => {
		const { h, connect, acquire } = harness()
		h.onSend = (p, r) => {
			if (r.type === "open") {
				p.opened(r)
				p.closed(r.id)
			}
		}
		const result = acquire()
		await tick()
		expect(await result).toEqual({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "channel closed during acquisition",
		})
		expect(connect).not.toHaveBeenCalled()
	})
	it("a terminal close during connect cancels that acquisition without collateral retirement", async () => {
		const { connect, processes, acquire } = harness()
		const alive = await acquire("alive")
		if (!alive.ok) throw new Error("expected grant")
		let resolve = (_s: PassThrough) => {}
		connect.mockImplementationOnce(
			() =>
				new Promise<PassThrough>(done => {
					resolve = done
				}),
		)
		const result = acquire()
		await tick()
		processes[0]!.closed("target-g1")
		expect(await result).toEqual({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "channel closed during acquisition",
		})
		const late = new PassThrough()
		resolve(late)
		await tick()
		expect(late.destroyed).toBe(true)
		expect(alive.stream.destroyed).toBe(false)
		expect(processes[0]!.sent.filter(r => r.type === "close")).toHaveLength(0)
	})
})
