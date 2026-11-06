import { EventEmitter, once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../../src/config.js"
import { ChannelizerManager } from "../../../../src/core/channelizer/channelizer-manager.js"
import type { ChannelizerProcessOptions } from "../../../../src/core/channelizer/channelizer-process.js"
import {
	encodeRequest,
	type ChannelizerRequest,
} from "../../../../src/core/channelizer/protocol.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../../src/core/source-manager.js"

const logger = pino({ level: "silent" })
const CAPS: SourceCaps = {
	kind: "iq",
	format: "U8_IQ",
	sampleRate: 2_048_000,
	centerFreq: 162e6,
	exclusive: false,
}
const REQUEST = {
	centerHz: 162e6,
	bandwidthHz: 45_600,
	transitionHz: 1200,
	outputRateHz: 48_000,
	format: "cf32" as const,
}

interface FakeProcess extends EventEmitter {
	generation: number
	input: PassThrough
	sent: ChannelizerRequest[]
	stop: ReturnType<typeof vi.fn>
	ready: () => void
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/**
 * The production wiring around the process boundary: the real SourceManager with a live connection to an in-process
 * server on an ephemeral loopback port, the real fanout and the real manager. Only the wavekit-chan process is faked.
 */
async function setup(
	options: {
		connect?: () => Promise<PassThrough>
		/** The fake answers no `open`. */
		silentOpen?: boolean
		/** `start` waits for `ready()`. */
		holdStart?: boolean
	} = {},
) {
	const peers: Socket[] = []
	const server: Server = createServer(socket => {
		peers.push(socket)
		socket.on("error", () => {})
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const address = server.address()
	if (!address || typeof address === "string")
		throw new Error("Missing address")
	cleanup.push(
		() =>
			new Promise<void>(resolve => {
				for (const peer of peers) peer.destroy()
				server.close(() => resolve())
			}),
	)
	const sources = new SourceManager(logger)
	cleanup.push(() => sources.disconnectAll())
	const accepted = once(server, "connection")
	await sources.connect({
		id: "s",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: address.port,
		loop: false,
		playbackSpeed: 1,
		caps: { ...CAPS },
	})
	await accepted
	const dir = mkdtempSync("/tmp/ch-rc-")
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
	const processes: FakeProcess[] = []
	const createProcess = (o: ChannelizerProcessOptions) => {
		let started: () => void = () => {}
		const ready = () => {
			proc.emit("event", {
				v: 1,
				type: "ready",
				generation: o.generation,
				pid: 1,
			})
			started()
		}
		const proc = Object.assign(new EventEmitter(), {
			generation: o.generation,
			input: new PassThrough(),
			sent: [] as ChannelizerRequest[],
			ready,
			start: () =>
				new Promise<void>(resolve => {
					started = resolve
					if (!options.holdStart) ready()
				}),
			stop: vi.fn(() => Promise.resolve()),
			send: (r: ChannelizerRequest) => {
				proc.sent.push(r)
				if (r.type === "open" && !options.silentOpen)
					proc.emit("event", {
						v: 1,
						type: "opened",
						id: r.id,
						generation: o.generation,
						socket: "fake",
						outputRateHz: r.outputRateHz,
						format: r.format,
						filterTaps: 10,
						groupDelaySamples: 5,
					})
				if (r.type === "close")
					proc.emit("event", {
						v: 1,
						type: "closed",
						id: r.id,
						generation: o.generation,
						reason: "requested",
					})
			},
		})
		processes.push(proc)
		return proc
	}
	const fanout = new FanoutManager(logger)
	const manager = new ChannelizerManager({
		sourceManager: sources,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		logger,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess,
		connect: options.connect ?? (() => Promise.resolve(new PassThrough())),
	})
	cleanup.push(() => manager.destroy())
	const invalidated: unknown[][] = []
	manager.on("channel-invalidated", (...args: unknown[]) =>
		invalidated.push(args),
	)
	const request = (centerHz = 162e6, decoderId = "d") =>
		manager.requestChannel(
			"s",
			decoderId,
			{ ...REQUEST, centerHz },
			sources.getCaps("s"),
		)
	return { sources, manager, fanout, processes, invalidated, request }
}

describe("a capture-centre move", () => {
	it("re-wires the channels on the same process, branch and generation", async () => {
		const { sources, fanout, processes, invalidated, request } = await setup()
		const before = await request()
		if (!before.ok) throw new Error(before.detail)
		const order: string[] = []
		before.stream.on("close", () => order.push("stream-closed"))
		const proc = processes[0]!
		const sentBefore = proc.sent.length
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		expect(invalidated).toEqual([
			["s", before.generation, [before.channelId], "caps-changed"],
		])
		// `close` before `recenter`, so the process never retunes a channel it is about to close.
		expect(proc.sent.slice(sentBefore)).toEqual([
			{ v: 1, type: "close", id: before.channelId },
			{ v: 1, type: "recenter", centerHz: 162.5e6, atInputBytes: 0 },
		])
		expect(proc.stop).not.toHaveBeenCalled()
		expect(fanout.getBranchIds()).toEqual(["channelizer-s"])
		await vi.waitFor(() => expect(order).toEqual(["stream-closed"]))
		// The decoder's re-request lands on the same process and generation.
		const after = await request()
		if (!after.ok) throw new Error(after.detail)
		expect(after.generation).toBe(before.generation)
		expect(after.channelId).toBe(before.channelId)
		expect(processes).toHaveLength(1)
	})

	it("costs no restart across a sweep with no channels open", async () => {
		const { sources, manager, processes, invalidated, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		invalidated.length = 0
		sources.updateSourceCaps("s", { centerFreq: 170e6 })
		invalidated.length = 0
		const proc = processes[0]!
		const sentBefore = proc.sent.length
		for (let hop = 1; hop <= 200; hop++)
			sources.updateSourceCaps("s", { centerFreq: 170e6 + hop * 1e6 })
		expect(proc.sent.slice(sentBefore)).toHaveLength(200)
		expect(proc.sent.at(-1)).toEqual({
			v: 1,
			type: "recenter",
			centerHz: 370e6,
			atInputBytes: 0,
		})
		expect(invalidated).toEqual([])
		expect(proc.stop).not.toHaveBeenCalled()
		expect(processes).toHaveLength(1)
		expect(manager.currentGeneration("s")).toBe(1)
	})

	it("follows the reconnect reconciliation too", async () => {
		const { sources, processes, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		sources.setTuningCaps("s", { sampleRate: 2_048_000, centerFreq: 163e6 })
		const proc = processes[0]!
		expect(proc.sent.at(-1)).toEqual({
			v: 1,
			type: "recenter",
			centerHz: 163e6,
			atInputBytes: 0,
		})
		expect(proc.stop).not.toHaveBeenCalled()
	})

	it("writes nothing when the centre is unchanged or unknown", async () => {
		const { sources, processes, invalidated, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		const proc = processes[0]!
		const sentBefore = proc.sent.length
		sources.updateSourceCaps("s", { centerFreq: 162e6 }) // same value: no event at all
		sources.updateSourceCaps("s", { exclusive: true }) // an event, same rate and centre
		sources.setTuningCaps("s", { sampleRate: 2_048_000 }) // centre now unknown
		expect(proc.sent).toHaveLength(sentBefore)
		expect(invalidated).toEqual([])
		expect(proc.stop).not.toHaveBeenCalled()
	})

	it("sends the new centre before a request opens against it", async () => {
		const { sources, processes, request } = await setup()
		const first = await request(162e6, "a")
		if (!first.ok) throw new Error(first.detail)
		sources.updateSourceCaps("s", { centerFreq: 170e6 })
		const second = await request(170.1e6, "b")
		if (!second.ok) throw new Error(second.detail)
		const types = processes[0]!.sent.map(r => r.type)
		expect(types.lastIndexOf("recenter")).toBeLessThan(
			types.lastIndexOf("open"),
		)
		expect(processes).toHaveLength(1)
	})

	it("refuses a channel the new centre cannot hold, without touching the process", async () => {
		const { sources, processes, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		sources.updateSourceCaps("s", { centerFreq: 170e6 })
		const refused = await request(162e6)
		expect(refused.ok).toBe(false)
		if (!refused.ok) expect(refused.reasonCode).toBe("channel-outside-capture")
		expect(processes).toHaveLength(1)
		expect(processes[0]!.stop).not.toHaveBeenCalled()
	})
})

describe("the position of a centre move", () => {
	const OLD = 0x11
	const NEW = 0x22
	const read = async (input: PassThrough, bytes: number): Promise<Buffer> => {
		const got: Buffer[] = []
		let length = 0
		for await (const chunk of input) {
			got.push(chunk as Buffer)
			length += (chunk as Buffer).length
			if (length >= bytes) break
		}
		return Buffer.concat(got)
	}

	it("counts the bytes queued in the branch, not those already handed on", async () => {
		const { sources, fanout, processes, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		const proc = processes[0]!
		// 250 ms at 2.048 Msps, held upstream: nothing reads the process's stdin.
		const held = 1_024_000
		fanout.distribute(Buffer.alloc(held, OLD))
		const telemetry = fanout.getBranchTelemetry("channelizer-s")!
		expect(telemetry.droppedBytesTotal).toBe(0)
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		expect(proc.sent.at(-1)).toEqual({
			v: 1,
			type: "recenter",
			centerHz: 162.5e6,
			atInputBytes: held,
		})
		fanout.distribute(Buffer.alloc(4096, NEW))
		const bytes = await read(proc.input, held + 4096)
		expect(bytes.indexOf(NEW)).toBe(held)
		expect(bytes.subarray(held).every(b => b === NEW)).toBe(true)
	})

	it("leaves out the bytes the branch dropped, so it is the process's own stdin position", async () => {
		const { sources, fanout, processes, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		const proc = processes[0]!
		// A chunk larger than the 1 024 000-byte mark: the branch congests, and the later chunks are lost.
		const chunk = 1_100_000
		const chunks = 3
		for (let k = 0; k < chunks; k++) fanout.distribute(Buffer.alloc(chunk, OLD))
		const { droppedBytesTotal } = fanout.getBranchTelemetry("channelizer-s")!
		expect(droppedBytesTotal).toBeGreaterThan(0)
		const delivered = chunks * chunk - droppedBytesTotal
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		expect(proc.sent.at(-1)).toEqual({
			v: 1,
			type: "recenter",
			centerHz: 162.5e6,
			atInputBytes: delivered,
		})
		// Reading drains the branch; its 'drain' ends drop-mode, so the next chunk is written.
		const reading = read(proc.input, delivered + 4096)
		await vi.waitFor(
			() => {
				if (fanout.getBranchTelemetry("channelizer-s")!.backpressureActive)
					throw new Error("still dropping")
			},
			{ timeout: 5000 },
		)
		fanout.distribute(Buffer.alloc(4096, NEW))
		const bytes = await reading
		// What stdin actually carries: the position is the first new-centre byte, drops and all.
		expect(bytes.indexOf(NEW)).toBe(delivered)
		expect(bytes.length).toBe(delivered + 4096)
	})

	it("moves on with each hop and never runs backwards", async () => {
		const { sources, fanout, processes, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		const positions: number[] = []
		for (let hop = 1; hop <= 5; hop++) {
			fanout.distribute(Buffer.alloc(100 * hop, OLD))
			sources.updateSourceCaps("s", { centerFreq: 162e6 + hop * 1e5 })
			const line = processes[0]!.sent.at(-1)
			if (line?.type !== "recenter") throw new Error("no recenter")
			positions.push(line.atInputBytes)
		}
		expect(positions).toEqual([100, 300, 600, 1000, 1500])
	})

	it.each([
		["no branch", () => undefined],
		[
			"a count behind what the branch emitted",
			() => ({ totalBytesWritten: 0, droppedBytesTotal: 1 }),
		],
		[
			"a count past safe integers",
			() => ({ totalBytesWritten: 2 ** 60, droppedBytesTotal: 0 }),
		],
	])("retires the generation with %s", async (_name, telemetry) => {
		const { sources, fanout, manager, processes, invalidated, request } =
			await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		vi.spyOn(fanout, "getBranchTelemetry").mockImplementation(
			() =>
				telemetry() as unknown as ReturnType<
					FanoutManager["getBranchTelemetry"]
				>,
		)
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		expect(invalidated).toEqual([
			["s", grant.generation, [grant.channelId], "caps-changed"],
		])
		expect(processes[0]!.stop).toHaveBeenCalledTimes(1)
		expect(processes[0]!.sent.some(r => r.type === "recenter")).toBe(false)
		vi.mocked(fanout.getBranchTelemetry).mockRestore()
		const next = await request(162.5e6)
		if (!next.ok) throw new Error(next.detail)
		expect(next.generation).toBe(grant.generation + 1)
		expect(manager.currentGeneration("s")).toBe(grant.generation + 1)
	})

	it("retires the generation when the branch no longer takes writes", async () => {
		const { sources, fanout, processes, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		fanout.distribute(Buffer.alloc(64, OLD))
		// The real count still answers, one chunk ahead of a stream that will never pass it on.
		const branch = (
			fanout as unknown as {
				branches: Map<string, { stream: PassThrough }>
			}
		).branches.get("channelizer-s")!
		branch.stream.destroy()
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		expect(processes[0]!.stop).toHaveBeenCalledTimes(1)
		expect(processes[0]!.sent.some(r => r.type === "recenter")).toBe(false)
	})

	it("retires the generation when the process refuses the move", async () => {
		const { manager, processes, invalidated, request } = await setup()
		const grant = await request()
		if (!grant.ok) throw new Error(grant.detail)
		const proc = processes[0]!
		proc.emit("event", {
			v: 1,
			type: "recenter-refused",
			generation: grant.generation,
			reason: "too-many-pending",
		})
		expect(invalidated).toEqual([
			["s", grant.generation, [grant.channelId], "recenter-refused"],
		])
		expect(proc.stop).toHaveBeenCalledTimes(1)
		const next = await request()
		if (!next.ok) throw new Error(next.detail)
		expect(next.generation).toBe(grant.generation + 1)
		expect(manager.currentGeneration("s")).toBe(next.generation)
	})
})

describe("an acquisition in flight when the centre moves", () => {
	it("answers a request waiting for its connection instead of granting it", async () => {
		const held: { connect: (socket: PassThrough) => void }[] = []
		const { sources, processes, invalidated, request } = await setup({
			connect: () =>
				new Promise<PassThrough>(resolve => {
					held.push({ connect: resolve })
				}),
		})
		const pending = request()
		await vi.waitFor(() => expect(held).toHaveLength(1))
		const proc = processes[0]!
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		const socket = new PassThrough()
		held[0]!.connect(socket)
		const result = await pending
		expect(result).toEqual({
			ok: false,
			reasonCode: "channelizer-unavailable",
			detail: "capture centre moved during the channel request",
			race: true,
		})
		await vi.waitFor(() => expect(socket.destroyed).toBe(true))
		// The stale channel closes before the process moves: open, close, recenter and nothing else.
		expect(proc.sent.map(r => r.type)).toEqual(["open", "close", "recenter"])
		expect(invalidated).toEqual([])
		expect(proc.stop).not.toHaveBeenCalled()
	})

	it("answers a request waiting for its `opened`, and the reply closes it", async () => {
		const { sources, processes, request } = await setup({ silentOpen: true })
		const pending = request()
		await vi.waitFor(() =>
			expect(processes[0]?.sent.some(r => r.type === "open")).toBe(true),
		)
		const proc = processes[0]!
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		const result = await pending
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.race).toBe(true)
		expect(proc.sent.map(r => r.type)).toEqual(["open", "close", "recenter"])
		expect(proc.stop).not.toHaveBeenCalled()
	})

	it("answers a request whose spawn the move landed in", async () => {
		const { sources, processes, request } = await setup({ holdStart: true })
		const pending = request()
		await vi.waitFor(() => expect(processes).toHaveLength(1))
		const proc = processes[0]!
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		proc.ready()
		const result = await pending
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.race).toBe(true)
		expect(proc.sent).toEqual([
			{ v: 1, type: "recenter", centerHz: 162.5e6, atInputBytes: 0 },
		])
	})

	it("lets the consumer's next request, computed for the new centre, through on the same process", async () => {
		const held: ((socket: PassThrough) => void)[] = []
		let hold = true
		const { sources, processes, request } = await setup({
			connect: () =>
				hold
					? new Promise<PassThrough>(resolve => {
							held.push(resolve)
						})
					: Promise.resolve(new PassThrough()),
		})
		const pending = request()
		await vi.waitFor(() => expect(held).toHaveLength(1))
		sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
		hold = false
		expect((await pending).ok).toBe(false)
		const next = await request(162.5e6)
		if (!next.ok) throw new Error(next.detail)
		expect(next.generation).toBe(1)
		expect(processes).toHaveLength(1)
	})
})

describe("a real change of the input still restarts", () => {
	it("on a sample-rate change", async () => {
		const { sources, processes, invalidated, request } = await setup()
		const before = await request()
		if (!before.ok) throw new Error(before.detail)
		sources.updateSourceCaps("s", { sampleRate: 2_400_000 })
		expect(invalidated).toEqual([
			["s", before.generation, [before.channelId], "caps-changed"],
		])
		expect(processes[0]!.stop).toHaveBeenCalledTimes(1)
		const after = await request()
		if (!after.ok) throw new Error(after.detail)
		expect(after.generation).toBe(before.generation + 1)
		expect(processes).toHaveLength(2)
	})

	it("on a format change", async () => {
		const { sources, processes, invalidated, request } = await setup()
		const before = await request()
		if (!before.ok) throw new Error(before.detail)
		sources.updateSourceCaps("s", { format: "S16_IQ" } as Partial<SourceCaps>)
		expect(invalidated).toHaveLength(1)
		expect(processes[0]!.stop).toHaveBeenCalledTimes(1)
	})
})

describe("the recenter line", () => {
	it("is strict and finite, as protocol.rs parses it", () => {
		const line = { v: 1, type: "recenter", centerHz: 123, atInputBytes: 4096 }
		expect(encodeRequest(line as ChannelizerRequest)).toBe(
			'{"v":1,"type":"recenter","centerHz":123,"atInputBytes":4096}\n',
		)
		for (const bad of [
			{ ...line, centerHz: Number.NaN },
			{ ...line, atInputBytes: -1 },
			{ ...line, atInputBytes: 1.5 },
			// At the bound, then past it: a JSON number stays exact only up to here.
			{ ...line, atInputBytes: Number.MAX_SAFE_INTEGER + 1 },
			{ ...line, id: "a" },
			{ v: 1, type: "recenter", centerHz: 123 },
		])
			expect(() => encodeRequest(bad as ChannelizerRequest)).toThrow()
		expect(
			encodeRequest({
				...line,
				atInputBytes: Number.MAX_SAFE_INTEGER,
			} as ChannelizerRequest),
		).toContain(`"atInputBytes":${Number.MAX_SAFE_INTEGER}`)
	})
})
