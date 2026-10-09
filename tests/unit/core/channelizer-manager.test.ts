import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest"
import { EventEmitter } from "node:events"
import { mkdirSync, rmSync } from "node:fs"
import { PassThrough, Writable } from "node:stream"
import pino from "pino"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import {
	CRASH_LIMIT,
	CRASH_WINDOW_MS,
	ChannelizerManager,
	type ChannelizerManagerDeps,
} from "../../../src/core/channelizer/channelizer-manager.js"
import {
	ChannelizerProcess,
	type ChannelizerProcessLike,
	type ChannelizerProcessOptions,
} from "../../../src/core/channelizer/channelizer-process.js"
import type { ChannelizerRequest } from "../../../src/core/channelizer/protocol.js"
import type { Logger } from "../../../src/utils/logger.js"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../src/config.js"
import { writeExecutable } from "../../mocks/executables.js"
import { FAKE_WAVEKIT_CHAN } from "../../mocks/fake-wavekit-chan.js"

const logger = pino({ level: "silent" })
// Short and under /tmp: macOS caps a Unix socket path at ~104 bytes.
const root = `/tmp/wkc-mgr-${process.pid}`
const bin = `${root}/wavekit-chan`
const caps = (sampleRate = 2_048_000, centerFreq = 162e6): SourceCaps => ({
	kind: "iq",
	format: "U8_IQ",
	sampleRate,
	centerFreq,
	exclusive: false,
})
const req = (centerHz = 162e6) => ({
	centerHz,
	bandwidthHz: 45_600,
	transitionHz: 1_200,
	outputRateHz: 48_000,
	format: "cf32" as const,
})

class Sources extends EventEmitter {
	caps = new Map<string, SourceCaps>([["rtl", caps()]])
	getCaps(id: string) {
		return this.caps.get(id)
	}
}

let sources: Sources
let fanout: FanoutManager
let released: string[]
const managers: ChannelizerManager[] = []
function manager(
	overrides: Partial<ReturnType<typeof ChannelizerConfigSchema.parse>> = {},
	extra: Partial<
		Pick<
			ChannelizerManagerDeps,
			"createProcess" | "connect" | "now" | "logger" | "openTimeoutMs"
		>
	> = {},
) {
	const m = new ChannelizerManager({
		sourceManager: sources as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: (id: string) => {
				released.push(id)
			},
		},
		config: ChannelizerConfigSchema.parse({
			enabled: true,
			binaryPath: bin,
			socketDir: `${root}/s`,
			...overrides,
		}),
		logger,
		...extra,
	})
	managers.push(m)
	return m
}
/** Real ChannelizerProcess around the fake binary, recording every request the manager sends. */
function recordingProcess(
	sent: ChannelizerRequest[],
	procs: ChannelizerProcessLike[] = [],
) {
	return (o: ChannelizerProcessOptions, l: Logger): ChannelizerProcessLike => {
		const p = new ChannelizerProcess(o, l)
		const send = p.send.bind(p)
		p.send = r => {
			sent.push(r)
			send(r)
		}
		procs.push(p)
		return p
	}
}
/**
 * Real processes around the fake whose first `start()` resolves only after `release()`: the window in which a
 * caps change, a source loss or `destroy()` races a spawn. Records each spawn's options and each exit's generation.
 */
function holdFirstStart() {
	let release = () => {}
	const gate = new Promise<void>(resolve => {
		release = resolve
	})
	let markStarted = () => {}
	const started = new Promise<void>(resolve => {
		markStarted = resolve
	})
	const spawns: ChannelizerProcessOptions[] = []
	const exits: number[] = []
	const createProcess = (
		o: ChannelizerProcessOptions,
		l: Logger,
	): ChannelizerProcessLike => {
		const p = new ChannelizerProcess(o, l)
		p.once("exit", () => exits.push(o.generation))
		if (spawns.push(o) === 1) {
			const start = p.start.bind(p)
			p.start = () =>
				start().then(() => {
					markStarted()
					return gate
				})
		}
		return p
	}
	return { createProcess, release: () => release(), started, spawns, exits }
}
beforeAll(() => {
	rmSync(root, { recursive: true, force: true })
	mkdirSync(root, { recursive: true })
	writeExecutable(bin, FAKE_WAVEKIT_CHAN)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
	sources = new Sources()
	fanout = new FanoutManager(logger)
	released = []
})
afterEach(async () => {
	// Every test's processes are gone before the next one starts (and before afterAll removes the binary).
	await Promise.all(managers.splice(0).map(m => m.destroy()))
	delete process.env["FAKE_CHAN_MODE"]
	delete process.env["FAKE_CHAN_STALL_MS"]
})

describe("ChannelizerManager", () => {
	it("spawns one process for concurrent requests and names channels per generation", async () => {
		const m = manager()
		const [a, b] = await Promise.all([
			m.requestChannel("rtl", "ais", req(), caps()),
			m.requestChannel("rtl", "vdl", req(162.1e6), caps()),
		])
		expect(a.ok && b.ok).toBe(true)
		expect(m.currentGeneration("rtl")).toBe(1)
		expect(fanout.getBranchIds()).toEqual(["channelizer-rtl"])
		if (a.ok) expect(a.channelId).toBe("ais-g1")
		if (b.ok) expect(b.channelId).toBe("vdl-g1")
		if (a.ok)
			expect(a.realised).toEqual({
				outputRateHz: 48_000,
				format: "cf32",
				groupDelaySamples: 5,
			})
	})
	it("sends an open whose queueBytes is channelQueueMs of output samples", async () => {
		const sent: ChannelizerRequest[] = []
		const m = manager(
			{ channelQueueMs: 250 },
			{ createProcess: recordingProcess(sent) },
		)
		expect((await m.requestChannel("rtl", "ais", req(), caps())).ok).toBe(true)
		expect(sent.find(r => r.type === "open")).toMatchObject({
			id: "ais-g1",
			queueBytes: 96_000,
		}) // addendum §6 table
	})
	// Feature: core-channelizer, Property 2: Admission rule (no side effects)
	// Validates: addendum §12.2
	it("rejects outside requests before spawning anything", async () => {
		const m = manager()
		const r = await m.requestChannel("rtl", "ais", req(163e6), caps())
		expect(r).toMatchObject({
			ok: false,
			reasonCode: "channel-outside-capture",
		})
		expect(fanout.getBranchIds()).toEqual([])
		expect(m.currentGeneration("rtl")).toBe(0)
	})
	it("rejects non-CU8 sources as channel-request-invalid", async () => {
		// Review Focus 5
		sources.caps.set("rtl", { ...caps(), format: "FLOAT32LE" })
		const m = manager()
		expect(
			await m.requestChannel("rtl", "ais", req(), undefined),
		).toMatchObject({
			ok: false,
			reasonCode: "channel-request-invalid",
		})
		expect(m.currentGeneration("rtl")).toBe(0)
	})
	it("rejects a queue budget beyond the process cap as channel-request-invalid without spawning", async () => {
		// 2 s of 5 Msps cf32 is 80 MB, past MAX_QUEUE_BYTES (64 MiB); the request itself is admissible.
		sources.caps.set("rtl", caps(10_000_000))
		const m = manager({ channelQueueMs: 2000 })
		const wide = {
			centerHz: 162e6,
			bandwidthHz: 4e6,
			transitionHz: 4e5,
			outputRateHz: 5_000_000,
			format: "cf32" as const,
		}
		expect(await m.requestChannel("rtl", "ais", wide, undefined)).toMatchObject(
			{
				ok: false,
				reasonCode: "channel-request-invalid",
				detail: expect.stringMatching(/queueBytes/),
			},
		)
		expect(m.currentGeneration("rtl")).toBe(0)
		expect(fanout.getBranchIds()).toEqual([])
	})
	it("reports channelizer-unavailable for an over-long socket path", async () => {
		// Review Focus 2
		const m = manager({ socketDir: `${root}/${"x".repeat(120)}` })
		expect(await m.requestChannel("rtl", "ais", req(), caps())).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: expect.stringMatching(/socket path too long/),
		})
		expect(m.currentGeneration("rtl")).toBe(0)
	})
	it("reports channelizer-unavailable when the binary is missing", async () => {
		const m = manager({ binaryPath: `${root}/missing` })
		expect(await m.requestChannel("rtl", "ais", req(), caps())).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
		})
		expect(fanout.getBranchIds()).toEqual([])
	})
	it("reports channelizer-unavailable and stops a process whose ready carries another generation", async () => {
		const procs: ChannelizerProcessLike[] = []
		const exited: unknown[] = []
		const m = manager(
			{},
			{
				createProcess: (o, l) => {
					// The fake echoes --generation, so this child reports generation 8 for an expected 1.
					const p = new ChannelizerProcess(
						{ ...o, generation: o.generation + 7 },
						l,
					)
					p.once("exit", (code: number | null) => exited.push(code))
					procs.push(p)
					return p
				},
			},
		)
		expect(await m.requestChannel("rtl", "ais", req(), caps())).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: expect.stringMatching(/generation 8.*expected 1/),
		})
		expect(fanout.getBranchIds()).toEqual([])
		await m.destroy()
		expect(exited).toHaveLength(1)
		expect(m.unexpectedExitCount("rtl")).toBe(0)
	})
	// Feature: core-channelizer, Property 10: Invalidation
	// Validates: addendum §4, §12.10
	it("invalidates once per channel before destroying sockets, then respawns on demand", async () => {
		const m = manager()
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		const order: string[] = []
		a.stream.on("close", () => order.push("socket-closed"))
		const events: unknown[] = []
		m.on("channel-invalidated", (...args: unknown[]) => {
			events.push(args)
			order.push("invalidated")
		})
		sources.caps.set("rtl", caps(2_048_000, 163e6))
		sources.emit("caps-changed", "rtl", caps(2_048_000, 163e6))
		sources.emit("caps-changed", "rtl", caps(2_048_000, 163e6))
		await vi.waitFor(() => expect(order).toContain("socket-closed"))
		expect(events).toEqual([["rtl", 1, ["ais-g1"]]])
		expect(order[0]).toBe("invalidated")
		expect(fanout.getBranchIds()).toEqual([])
		expect(released).toContain("rtl")
		// Feature: core-channelizer, Property 9: Generation stamping
		// Validates: addendum §4, §12.9
		const b = await m.requestChannel(
			"rtl",
			"ais",
			req(163e6),
			caps(2_048_000, 163e6),
		)
		expect(b.ok && b.generation).toBe(2)
		if (b.ok) expect(b.channelId).toBe("ais-g2")
	})
	it("ignores caps-changed that keeps the process's rate and centre", async () => {
		const m = manager()
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		expect(a.ok).toBe(true)
		const events: unknown[] = []
		m.on("channel-invalidated", (...args: unknown[]) => events.push(args))
		sources.emit("caps-changed", "rtl", caps())
		expect(events).toEqual([])
		expect(fanout.getBranchIds()).toEqual(["channelizer-rtl"])
	})
	it.each(["disconnected", "removed"])(
		"invalidates every channel when the source is %s",
		async event => {
			const m = manager()
			const [a, b] = await Promise.all([
				m.requestChannel("rtl", "ais", req(), caps()),
				m.requestChannel("rtl", "vdl", req(162.1e6), caps()),
			])
			expect(a.ok && b.ok).toBe(true)
			const events: unknown[] = []
			m.on("channel-invalidated", (...args: unknown[]) => events.push(args))
			sources.emit(event, "rtl")
			expect(events).toEqual([["rtl", 1, ["ais-g1", "vdl-g1"]]])
			expect(fanout.getBranchIds()).toEqual([])
			expect(released).toEqual(["rtl"])
		},
	)
	// Feature: core-channelizer, Property 12: Input-gap marking (Node side)
	// Validates: addendum §4, §12.12; plan A2
	it("sends mark-gap at the seam after real branch drops", async () => {
		process.env["FAKE_CHAN_MODE"] = "stall-input"
		process.env["FAKE_CHAN_STALL_MS"] = "3000"
		const sent: ChannelizerRequest[] = []
		const src = new PassThrough()
		try {
			const m = manager(
				{ inputHighWaterMark: 65_536 },
				{ createProcess: recordingProcess(sent) },
			)
			const a = await m.requestChannel("rtl", "ais", req(), caps())
			expect(a.ok).toBe(true)
			const seams: number[] = []
			fanout.on("backpressure", (id: string) => {
				const t =
					id === "channelizer-rtl" ? fanout.getBranchTelemetry(id) : undefined
				if (t) seams.push(t.totalBytesWritten - t.droppedBytesTotal)
			})
			const gaps: unknown[][] = []
			m.on("channel-discontinuity", (...args: unknown[]) => gaps.push(args))
			fanout.attachSource(src)
			// The fake reads nothing for 3 s after `opened`. The OS pipe, the child stdin and the 64 KiB branch fill up
			// after a few hundred KiB, then FanoutManager drops. 4 MiB is far past that.
			const chunk = 65_536
			const chunks = 64
			for (let k = 0; k < chunks; k++) {
				src.write(Buffer.alloc(chunk, k))
				await new Promise(resolve => setImmediate(resolve))
			}
			const dropped =
				fanout.getBranchTelemetry("channelizer-rtl")?.droppedBytesTotal ?? 0
			expect(dropped).toBeGreaterThan(0)
			expect(seams.length).toBe(1) // one backpressure episode: the branch stays in drop mode until drain
			const seam = seams[0] ?? -1
			expect(seam + dropped).toBe(chunk * chunks) // every byte was either delivered before the seam or dropped
			// When the stall ends, the fake reads, the branch emits drain, and the manager sends mark-gap.
			await vi.waitFor(
				() => expect(sent.some(r => r.type === "mark-gap")).toBe(true),
				{ timeout: 10_000 },
			)
			expect(sent.find(r => r.type === "mark-gap")).toEqual({
				v: 1,
				type: "mark-gap",
				atInputByte: seam,
				droppedInputBytes: dropped,
			})
			// The fake echoes the request as a pass-through channel would: input-gap at the seam sample.
			await vi.waitFor(() => expect(gaps.length).toBeGreaterThan(0), {
				timeout: 5_000,
			})
			expect(gaps[0]).toEqual([
				"ais-g1",
				1,
				Math.floor(seam / 2),
				Math.floor(dropped / 2),
				"input-gap",
			])
		} finally {
			src.destroy()
		}
	}, 20_000)
	it("logs process stats at info as channelizer stats", async () => {
		const lines: Record<string, unknown>[] = []
		const sink = new Writable({
			write(chunk: Buffer, _enc, done) {
				lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
				done()
			},
		})
		const procs: ChannelizerProcessLike[] = []
		const m = manager(
			{},
			{
				logger: pino({ level: "info" }, sink),
				createProcess: recordingProcess([], procs),
			},
		)
		expect((await m.requestChannel("rtl", "ais", req(), caps())).ok).toBe(true)
		// The real binary emits stats every 5 s; drive one line through the process's event channel instead of waiting.
		procs[0]!.emit("event", {
			v: 1,
			type: "stats",
			generation: 1,
			inputSamples: 42,
			channels: [],
		})
		expect(lines.find(l => l["msg"] === "channelizer stats")).toMatchObject({
			level: 30,
			sourceId: "rtl",
			generation: 1,
			inputSamples: 42,
		})
	})
	it("logs channel discontinuities at warn with the cause", async () => {
		const lines: Record<string, unknown>[] = []
		const sink = new Writable({
			write(chunk: Buffer, _enc, done) {
				lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
				done()
			},
		})
		const procs: ChannelizerProcessLike[] = []
		const m = manager(
			{},
			{
				logger: pino({ level: "info" }, sink),
				createProcess: recordingProcess([], procs),
			},
		)
		expect((await m.requestChannel("rtl", "ais", req(), caps())).ok).toBe(true)
		// Task 35 (scripts/capacity/summarize.py) counts these lines by cause.
		procs[0]!.emit("event", {
			v: 1,
			type: "discontinuity",
			id: "ais-g1",
			generation: 1,
			sampleIndex: 4096,
			droppedSamples: 512,
			cause: "queue-overflow",
		})
		expect(lines.find(l => l["msg"] === "Channel discontinuity")).toMatchObject(
			{
				level: 40,
				sourceId: "rtl",
				channelId: "ais-g1",
				generation: 1,
				sampleIndex: 4096,
				droppedSamples: 512,
				cause: "queue-overflow",
			},
		)
	})
	it("stops the process and frees the branch when the last channel is released", async () => {
		const sent: ChannelizerRequest[] = []
		const procs: ChannelizerProcessLike[] = []
		const m = manager({}, { createProcess: recordingProcess(sent, procs) })
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		const exited = new Promise(resolve => procs[0]!.once("exit", resolve))
		await m.releaseChannel(a.channelId)
		expect(fanout.getBranchIds()).toEqual([])
		expect(released).toEqual(["rtl"])
		expect(a.stream.destroyed).toBe(true)
		expect(sent.filter(r => r.type === "close")).toEqual([
			{ v: 1, type: "close", id: "ais-g1" },
		])
		await exited
		expect(m.unexpectedExitCount("rtl")).toBe(0)
	})
	it("keeps the process for a request still pending when the other channel is released", async () => {
		let release: (() => void) | null = null
		const createProcess = (
			o: ChannelizerProcessOptions,
			l: Logger,
		): ChannelizerProcessLike => {
			const p = new ChannelizerProcess(o, l)
			const send = p.send.bind(p)
			p.send = r => {
				if (r.type === "open" && r.id === "vdl-g1") {
					release = () => send(r)
					return
				}
				send(r)
			}
			return p
		}
		const m = manager({}, { createProcess })
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		const pending = m.requestChannel("rtl", "vdl", req(162.1e6), caps())
		await vi.waitFor(() => expect(release).not.toBeNull())
		await m.releaseChannel(a.channelId)
		expect(fanout.getBranchIds()).toEqual(["channelizer-rtl"])
		release!()
		expect(await pending).toMatchObject({
			ok: true,
			channelId: "vdl-g1",
			generation: 1,
		})
		expect(m.currentGeneration("rtl")).toBe(1)
	})
	it("rejects a second channel with the same id on one generation", async () => {
		const m = manager()
		expect((await m.requestChannel("rtl", "ais", req(), caps())).ok).toBe(true)
		expect(
			await m.requestChannel("rtl", "ais", req(162.1e6), caps()),
		).toMatchObject({
			ok: false,
			reasonCode: "channel-request-invalid",
			detail: expect.stringMatching(/ais-g1/),
		})
		expect(fanout.getBranchIds()).toEqual(["channelizer-rtl"])
	})
	it("reports channelizer-unavailable, never a throw, when the socket dir cannot be created", async () => {
		// The parent is a regular file, so mkdir fails with ENOTDIR on every OS without needing a permission setup.
		// On a Mac the real-world case is EACCES on the default /var/run/wavekit/chan.
		const m = manager({ socketDir: `${bin}/not-a-dir` })
		await expect(
			m.requestChannel("rtl", "ais", req(), caps()),
		).resolves.toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: expect.stringMatching(/socket dir/),
		})
		expect(fanout.getBranchIds()).toEqual([])
		expect(m.currentGeneration("rtl")).toBe(0)
	})
	it("retries a request whose source was invalidated while it was pending", async () => {
		let held: (() => void) | null = null
		let spawns = 0
		const createProcess = (
			o: ChannelizerProcessOptions,
			l: Logger,
		): ChannelizerProcessLike => {
			const p = new ChannelizerProcess(o, l)
			const send = p.send.bind(p)
			const first = ++spawns === 1
			p.send = r => {
				if (first && r.type === "open") {
					held = () => send(r) // generation 1 never answers before it is invalidated
					return
				}
				send(r)
			}
			return p
		}
		const m = manager({}, { createProcess })
		const pending = m.requestChannel("rtl", "ais", req(), caps())
		await vi.waitFor(() => expect(held).not.toBeNull())
		sources.caps.set("rtl", caps(2_400_000)) // rate change, same centre: the request stays admissible
		sources.emit("caps-changed", "rtl", caps(2_400_000))
		expect(await pending).toMatchObject({
			ok: true,
			generation: 2,
			channelId: "ais-g2",
		}) // superseded and retried, not parked as unavailable
	})
	it("never ends the decoder-facing stream when the process dies; invalidation destroys it instead", async () => {
		process.env["FAKE_CHAN_MODE"] = "crash-after-open"
		const m = manager()
		const invalidated = new Promise(resolve =>
			m.once("channel-invalidated", resolve),
		)
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		let ended = false
		a.stream.on("end", () => {
			ended = true
		})
		a.stream.resume() // flowing, so an end would be observed
		const closed = new Promise(resolve => a.stream.once("close", resolve))
		await invalidated
		await closed
		expect(ended).toBe(false) // the socket saw EOF; the PassThrough handed to the decoder did not end
	})
	it("does not count an exit 0 after input-eof as a crash", async () => {
		const procs: ChannelizerProcessLike[] = []
		const m = manager({}, { createProcess: recordingProcess([], procs) })
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		const invalidated = new Promise(resolve =>
			m.once("channel-invalidated", resolve),
		)
		// What an ended input branch does. (FanoutManager does not end branches when its source ends; it only logs.)
		// The fake emits input-eof, then exits 0.
		procs[0]!.input.end()
		await invalidated
		expect(m.unexpectedExitCount("rtl")).toBe(0)
	})
	it("stops respawning a crash-looping wavekit-chan after CRASH_LIMIT exits within CRASH_WINDOW_MS", async () => {
		process.env["FAKE_CHAN_MODE"] = "crash-after-open"
		let clock = 1_000_000
		const m = manager({}, { now: () => clock })
		// Each spawn crashes once, 50 ms after `opened`. A crash that lands mid-connect makes the request retry
		// (one more spawn and crash), so count exits rather than assuming exactly one per request.
		while (m.unexpectedExitCount("rtl") < CRASH_LIMIT) {
			const before = m.unexpectedExitCount("rtl")
			await m.requestChannel("rtl", "ais", req(), caps()) // ok, or unavailable if the crash beats the connect
			await vi.waitFor(
				() => expect(m.unexpectedExitCount("rtl")).toBeGreaterThan(before),
				{ timeout: 5_000 },
			)
			clock += 1_000
		}
		const spawned = m.currentGeneration("rtl")
		expect(spawned).toBeGreaterThanOrEqual(CRASH_LIMIT)
		const held = await m.requestChannel("rtl", "ais", req(), caps())
		expect(held).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: expect.stringMatching(/exited unexpectedly \d+ times in 60 s/),
		})
		expect(m.currentGeneration("rtl")).toBe(spawned) // nothing spawned while held
		expect(fanout.getBranchIds()).toEqual([])
		clock += CRASH_WINDOW_MS // every recorded exit has left the window
		await m.requestChannel("rtl", "ais", req(), caps())
		expect(m.currentGeneration("rtl")).toBe(spawned + 1)
	}, 30_000)
	it("destroy() awaits every process exit and refuses later requests", async () => {
		const procs: ChannelizerProcessLike[] = []
		const exits: unknown[] = []
		const m = manager(
			{},
			{
				createProcess: (o, l) => {
					const p = new ChannelizerProcess(o, l)
					p.once("exit", (code: number | null) => exits.push(code))
					procs.push(p)
					return p
				},
			},
		)
		expect((await m.requestChannel("rtl", "ais", req(), caps())).ok).toBe(true)
		await m.destroy()
		expect(exits).toEqual([0])
		expect(fanout.getBranchIds()).toEqual([])
		expect(await m.requestChannel("rtl", "ais", req(), caps())).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
		})
		expect(procs).toHaveLength(1)
	})
	it("cleans up even when a channel-invalidated listener throws, without throwing into the source emitter", async () => {
		const exits: number[] = []
		const m = manager(
			{},
			{
				createProcess: (o, l) => {
					const p = new ChannelizerProcess(o, l)
					p.once("exit", () => exits.push(o.generation))
					return p
				},
			},
		)
		const a = await m.requestChannel("rtl", "ais", req(), caps())
		if (!a.ok) throw new Error("expected ok")
		m.on("channel-invalidated", () => {
			throw new Error("listener bug")
		})
		expect(() => sources.emit("disconnected", "rtl")).not.toThrow()
		expect(a.stream.destroyed).toBe(true)
		expect(fanout.getBranchIds()).toEqual([])
		expect(released).toEqual(["rtl"])
		await vi.waitFor(() => expect(exits).toEqual([1]))
	})
	it("keeps source and decoder ids that sanitise alike apart", async () => {
		sources.caps.set("a/b", caps())
		sources.caps.set("a_b", caps())
		const dirs: string[] = []
		const m = manager(
			{},
			{
				createProcess: (o, l) => {
					dirs.push(o.socketDir)
					return new ChannelizerProcess(o, l)
				},
			},
		)
		const bySource = await Promise.all([
			m.requestChannel("a/b", "ais", req(), caps()),
			m.requestChannel("a_b", "ais", req(), caps()),
		])
		expect(bySource.map(r => r.ok)).toEqual([true, true])
		expect(new Set(dirs).size).toBe(2) // two live processes never share (and so never rm) one socket dir
		expect(dirs.find(d => d.endsWith("/a_b-g1"))).toBeDefined() // an already-safe id is kept as is
		const long = "d".repeat(60)
		const byDecoder = await Promise.all(
			["x/y", "x_y", long, `${long.slice(1)}e`].map((id, k) =>
				m.requestChannel("rtl", id, req(162e6 + k * 100e3), caps()),
			),
		)
		const ids = byDecoder.map(r => (r.ok ? r.channelId : r.detail))
		expect(ids[0]).toMatch(/^x_y-[0-9a-f]{8}-g1$/)
		expect(ids[1]).toBe("x_y-g1")
		expect(new Set(ids).size).toBe(4)
		for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
	})
	it("supersedes a spawn that raced a caps change and retries against the new caps", async () => {
		const h = holdFirstStart()
		const m = manager({}, { createProcess: h.createProcess })
		const pending = m.requestChannel("rtl", "ais", req(), caps())
		await h.started
		sources.caps.set("rtl", caps(2_400_000))
		sources.emit("caps-changed", "rtl", caps(2_400_000))
		h.release()
		expect(await pending).toMatchObject({
			ok: true,
			generation: 2,
			channelId: "ais-g2",
		})
		expect(h.spawns.map(o => o.inputRateHz)).toEqual([2_048_000, 2_400_000])
		expect(fanout.getBranchIds()).toEqual(["channelizer-rtl"])
		await vi.waitFor(() => expect(h.exits).toEqual([1]))
	})
	it("supersedes a spawn that raced a disconnect", async () => {
		const h = holdFirstStart()
		const m = manager({}, { createProcess: h.createProcess })
		const pending = m.requestChannel("rtl", "ais", req(), caps())
		await h.started
		sources.emit("disconnected", "rtl")
		h.release()
		expect(await pending).toMatchObject({ ok: true, generation: 2 })
		await vi.waitFor(() => expect(h.exits).toEqual([1]))
	})
	it("drops a spawn that raced the source's removal", async () => {
		const h = holdFirstStart()
		const m = manager({}, { createProcess: h.createProcess })
		const pending = m.requestChannel("rtl", "ais", req(), caps())
		await h.started
		sources.caps.delete("rtl")
		sources.emit("removed", "rtl")
		h.release()
		expect(await pending).toMatchObject({
			ok: false,
			reasonCode: "channel-request-invalid",
		}) // the retry finds no source
		expect(m.currentGeneration("rtl")).toBe(1)
		expect(fanout.getBranchIds()).toEqual([])
		expect(released).toEqual(["rtl"])
		await vi.waitFor(() => expect(h.exits).toEqual([1]))
	})
	it("retires a spawn that completes after destroy() began, and destroy() awaits its exit", async () => {
		const h = holdFirstStart()
		const m = manager({}, { createProcess: h.createProcess })
		const pending = m.requestChannel("rtl", "ais", req(), caps())
		await h.started
		const destroyed = m.destroy()
		h.release()
		expect(await pending).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: expect.stringMatching(/destroyed/),
		})
		await destroyed
		expect(h.exits).toEqual([1])
		expect(fanout.getBranchIds()).toEqual([])
	})
	it("closes the orphaned channel and stops the idle process when open times out", async () => {
		const sent: ChannelizerRequest[] = []
		const exits: number[] = []
		const createProcess = (
			o: ChannelizerProcessOptions,
			l: Logger,
		): ChannelizerProcessLike => {
			const p = new ChannelizerProcess(o, l)
			p.once("exit", () => exits.push(o.generation))
			const send = p.send.bind(p)
			p.send = r => {
				sent.push(r)
				if (r.type !== "open") send(r) // the process never answers the open
			}
			return p
		}
		const m = manager({}, { createProcess, openTimeoutMs: 300 })
		expect(await m.requestChannel("rtl", "ais", req(), caps())).toMatchObject({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "no opened/rejected within 300 ms",
		})
		expect(sent).toContainEqual({ v: 1, type: "close", id: "ais-g1" })
		expect(fanout.getBranchIds()).toEqual([])
		expect(released).toEqual(["rtl"])
		await vi.waitFor(() => expect(exits).toEqual([1]))
	})
})
