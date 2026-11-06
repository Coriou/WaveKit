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
import { createBurstAbsorber } from "../../../../src/core/link-burst/absorber.js"
import { ABSORBER_LAGGARD_MS } from "../../../../src/core/link-burst/contract.js"
import type { IngestRecorder } from "../../../../src/core/link-burst/contract.js"
import { SourceFanoutRouter } from "../../../../src/core/source-fanout-router.js"
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

/** The `recenter` lines of this turn's moves are out once the turn's stack has returned. */
const posted = (): Promise<void> => Promise.resolve()
/** A branch with a `data` listener flows, and passes each later write on inside the write, from the next turn. */
const flowing = (): Promise<void> =>
	new Promise(resolve => {
		setImmediate(resolve)
	})

/** Only the wavekit-chan process is fake. */
function fakeProcesses(
	options: {
		/** The fake answers no `open`. */
		silentOpen?: boolean
		/** `start` waits for `ready()`. */
		holdStart?: boolean
	} = {},
) {
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
	return { processes, createProcess }
}

/**
 * The production router, fanout, absorber and manager on a source the router takes for a network link. Nothing connects:
 * the source is a local stream under a reserved hostname, and the test feeds the absorber as the router's ingest would.
 */
function setupWithAbsorber() {
	let caps: SourceCaps = { ...CAPS }
	const sources = Object.assign(new EventEmitter(), {
		getAllStatus: () => [{ id: "s", connected: true }],
		getStatus: () => ({ connected: true }),
		getStream: () => new PassThrough(),
		getCaps: () => caps,
		getConfig: () => ({
			host: "example.invalid",
			type: "rtl_tcp",
			burstAbsorber: { seconds: 2 },
		}),
	})
	const recorder = {
		configure: () => {},
		resetArrival: () => {},
		observeChunk: () => {},
		noteHolding: () => {},
	} as unknown as IngestRecorder
	const clock = { now: 1_000 }
	const fanout = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		fanout,
		logger,
		"s",
		{
			linkBurst: {
				createRecorder: () => recorder,
				createAbsorber: (_id, deps) => createBurstAbsorber(deps),
				monoNow: () => clock.now,
			},
		},
	)
	const absorber = router.linkBurst("s")?.absorber
	if (!absorber) throw new Error("no absorber on a network source")
	const dir = mkdtempSync("/tmp/ch-rc-")
	const { processes, createProcess } = fakeProcesses()
	const manager = new ChannelizerManager({
		sourceManager: sources as unknown as SourceManager,
		routing: router,
		logger,
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		createProcess,
		connect: () => Promise.resolve(new PassThrough()),
	})
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
	cleanup.push(() => {
		router.destroy()
		fanout.destroy()
	})
	cleanup.push(() => manager.destroy())
	const request = (centerHz = 162e6) =>
		manager.requestChannel(
			"s",
			"d",
			{ ...REQUEST, centerHz },
			sources.getCaps(),
		)
	const move = (centerFreq: number) => {
		caps = { ...caps, centerFreq }
		sources.emit("caps-changed", "s", caps)
	}
	return { clock, fanout, absorber, processes, request, move }
}

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
	const { processes, createProcess } = fakeProcesses(options)
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
		await posted()
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
		await posted()
		invalidated.length = 0
		const proc = processes[0]!
		const sentBefore = proc.sent.length
		for (let hop = 1; hop <= 200; hop++)
			sources.updateSourceCaps("s", { centerFreq: 170e6 + hop * 1e6 })
		await posted()
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
		await posted()
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
		await posted()
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
		await posted()
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
			await posted()
			const line = processes[0]!.sent.at(-1)
			if (line?.type !== "recenter") throw new Error("no recenter")
			positions.push(line.atInputBytes)
		}
		expect(positions).toEqual([100, 300, 600, 1000, 1500])
	})

	describe("that lands inside a distribution", () => {
		/** What the position would read now, in the two counts it adds up. */
		const countedNow = (fanout: FanoutManager, held = 0): number => {
			const t = fanout.getBranchTelemetry("channelizer-s")!
			return t.totalBytesWritten - t.droppedBytesTotal + held
		}

		it("counts the chunk an earlier branch's callback found in neither count", async () => {
			const { sources, fanout, processes, request } = await setup()
			let onChunk: (() => void) | undefined
			fanout.addBranch({ id: "early" }).on("data", () => onChunk?.())
			const grant = await request()
			if (!grant.ok) throw new Error(grant.detail)
			await flowing()
			fanout.distribute(Buffer.alloc(4096, OLD))
			let found = -1
			onChunk = () => {
				onChunk = undefined
				found = countedNow(fanout)
				sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
			}
			fanout.distribute(Buffer.alloc(2048, OLD))
			// The earlier branch got the chunk first: the count still lacks it.
			expect(found).toBe(4096)
			await posted()
			const proc = processes[0]!
			expect(proc.sent.at(-1)).toEqual({
				v: 1,
				type: "recenter",
				centerHz: 162.5e6,
				atInputBytes: 6144,
			})
			fanout.distribute(Buffer.alloc(4096, NEW))
			const bytes = await read(proc.input, 6144 + 4096)
			expect(bytes.indexOf(NEW)).toBe(6144)
		})

		it("keeps the request a listener makes inside it after the line, at that position", async () => {
			const { sources, fanout, manager, processes, request } = await setup()
			let onChunk: (() => void) | undefined
			fanout.addBranch({ id: "early" }).on("data", () => onChunk?.())
			const grant = await request(162e6, "a")
			if (!grant.ok) throw new Error(grant.detail)
			await flowing()
			let reopened: ReturnType<typeof request> | undefined
			manager.on("channel-invalidated", () => {
				reopened = request(162.5e6, "b")
			})
			onChunk = () => {
				onChunk = undefined
				sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
			}
			fanout.distribute(Buffer.alloc(2048, OLD))
			const proc = processes[0]!
			const after = await reopened
			if (!after?.ok) throw new Error("no reopened channel")
			expect(proc.sent.slice(1)).toEqual([
				{ v: 1, type: "close", id: grant.channelId },
				{ v: 1, type: "recenter", centerHz: 162.5e6, atInputBytes: 2048 },
				expect.objectContaining({ type: "open", centerHz: 162.5e6 }),
			])
		})

		it("writes two moves of one turn in order, at one position", async () => {
			const { sources, fanout, processes, request } = await setup()
			let onChunk: (() => void) | undefined
			fanout.addBranch({ id: "early" }).on("data", () => onChunk?.())
			const grant = await request()
			if (!grant.ok) throw new Error(grant.detail)
			await flowing()
			onChunk = () => {
				onChunk = undefined
				sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
				sources.updateSourceCaps("s", { centerFreq: 162.7e6 })
			}
			fanout.distribute(Buffer.alloc(2048, OLD))
			await posted()
			expect(processes[0]!.sent.slice(-2)).toEqual([
				{ v: 1, type: "recenter", centerHz: 162.5e6, atInputBytes: 2048 },
				{ v: 1, type: "recenter", centerHz: 162.7e6, atInputBytes: 2048 },
			])
		})

		it("retires the generation when the position is gone by then", async () => {
			const { sources, fanout, manager, processes, request } = await setup()
			const grant = await request()
			if (!grant.ok) throw new Error(grant.detail)
			const real = fanout.getBranchTelemetry.bind(fanout)
			const spy = vi
				.spyOn(fanout, "getBranchTelemetry")
				.mockImplementationOnce(real)
				.mockImplementation(() => undefined)
			sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
			const proc = processes[0]!
			expect(proc.stop).not.toHaveBeenCalled()
			await posted()
			expect(proc.stop).toHaveBeenCalledTimes(1)
			expect(proc.sent.some(r => r.type === "recenter")).toBe(false)
			spy.mockRestore()
			const next = await request(162.5e6)
			if (!next.ok) throw new Error(next.detail)
			expect(next.generation).toBe(grant.generation + 1)
			expect(manager.currentGeneration("s")).toBe(next.generation)
		})

		it("writes nothing for a generation the same turn retired", async () => {
			const { sources, processes, request } = await setup()
			const grant = await request()
			if (!grant.ok) throw new Error(grant.detail)
			sources.updateSourceCaps("s", { centerFreq: 162.5e6 })
			sources.updateSourceCaps("s", { sampleRate: 2_400_000 })
			await posted()
			const proc = processes[0]!
			expect(proc.stop).toHaveBeenCalledTimes(1)
			expect(proc.sent.some(r => r.type === "recenter")).toBe(false)
		})
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

	describe("with IQ held in the burst absorber", () => {
		const position = (proc: FakeProcess): number => {
			const line = proc.sent.at(-1)
			if (line?.type !== "recenter") throw new Error("no recenter")
			return line.atInputBytes
		}
		const congestedBy = (setup: ReturnType<typeof setupWithAbsorber>) => {
			const slow = setup.fanout.addBranch({ id: "slow", highWaterMark: 1024 })
			setup.absorber.ingest(Buffer.alloc(4096, OLD))
			return slow
		}

		it("is the position when nothing is held", async () => {
			const setup = setupWithAbsorber()
			const grant = await setup.request()
			if (!grant.ok) throw new Error(grant.detail)
			setup.absorber.ingest(Buffer.alloc(4096, OLD))
			expect(setup.absorber.counters().heldBytes).toBe(0)
			setup.move(162.5e6)
			await posted()
			expect(position(setup.processes[0]!)).toBe(4096)
		})

		it("keeps the held bytes before the position when a reopened channel sees them drain", async () => {
			const setup = setupWithAbsorber()
			const grant = await setup.request()
			if (!grant.ok) throw new Error(grant.detail)
			const proc = setup.processes[0]!
			const slow = congestedBy(setup)
			const held = 8192
			setup.absorber.ingest(Buffer.alloc(held, OLD))
			expect(setup.absorber.counters().heldBytes).toBe(held)
			setup.move(162.5e6)
			await posted()
			const at = position(proc)
			expect(at).toBe(4096 + held)
			const reopened = await setup.request(162.5e6)
			if (!reopened.ok) throw new Error(reopened.detail)
			expect(reopened.generation).toBe(grant.generation)
			// The other branch drains: what the absorber held goes out now, after the move.
			slow.resume()
			await vi.waitFor(() =>
				expect(setup.absorber.counters().heldBytes).toBe(0),
			)
			setup.absorber.ingest(Buffer.alloc(4096, NEW))
			const bytes = await read(proc.input, at + 4096)
			expect(bytes.indexOf(NEW)).toBe(at)
		})

		it("moves on with each hop as the held bytes grow", async () => {
			const setup = setupWithAbsorber()
			const grant = await setup.request()
			if (!grant.ok) throw new Error(grant.detail)
			congestedBy(setup)
			const positions: number[] = []
			for (let hop = 1; hop <= 3; hop++) {
				setup.absorber.ingest(Buffer.alloc(1000, OLD))
				setup.move(162e6 + hop * 1e5)
				await posted()
				positions.push(position(setup.processes[0]!))
			}
			expect(positions).toEqual([5096, 6096, 7096])
		})

		// The absorber takes the chunk off its held count, then the fanout hands it to `early` first: for that callback
		// the chunk is in neither count, 4 096 where 12 288 old-centre bytes ultimately arrive.
		it("is never early when the release's first branch triggers the move", async () => {
			const setup = setupWithAbsorber()
			let onChunk: (() => void) | undefined
			setup.fanout.addBranch({ id: "early" }).on("data", () => onChunk?.())
			const grant = await setup.request()
			if (!grant.ok) throw new Error(grant.detail)
			const proc = setup.processes[0]!
			await flowing()
			const slow = congestedBy(setup)
			const held = 8192
			setup.absorber.ingest(Buffer.alloc(held, OLD))
			expect(setup.absorber.counters().heldBytes).toBe(held)
			let found = -1
			onChunk = () => {
				onChunk = undefined
				const t = setup.fanout.getBranchTelemetry("channelizer-s")!
				found =
					t.totalBytesWritten -
					t.droppedBytesTotal +
					setup.absorber.counters().heldBytes
				setup.move(162.5e6)
			}
			slow.resume()
			await vi.waitFor(() =>
				expect(setup.absorber.counters().heldBytes).toBe(0),
			)
			expect(found).toBe(4096)
			const at = position(proc)
			expect(at).toBe(4096 + held)
			setup.absorber.ingest(Buffer.alloc(4096, NEW))
			const bytes = await read(proc.input, at + 4096)
			expect(bytes.indexOf(NEW)).toBe(at)
			expect(bytes.subarray(0, at).every(b => b === OLD)).toBe(true)
		})

		// The branch itself lags, so the absorber's release drops the held bytes for it. The count cannot know that at the
		// move: the position is late by what was dropped, which costs new-centre input and never lets old-centre IQ past.
		it("errs late, never early, when the branch loses held bytes on their release", async () => {
			const setup = setupWithAbsorber()
			const grant = await setup.request()
			if (!grant.ok) throw new Error(grant.detail)
			const proc = setup.processes[0]!
			const branchState = () =>
				setup.fanout.getBranchTelemetry("channelizer-s")!
			// A chunk past the 1 024 000-byte mark goes on to the unread stdin; the next one stays in the branch, full.
			const chunk = 1_100_000
			setup.fanout.distribute(Buffer.alloc(chunk, OLD))
			await vi.waitFor(() =>
				expect(branchState().backpressureActive).toBe(false),
			)
			setup.fanout.distribute(Buffer.alloc(chunk, OLD))
			expect(branchState().backpressureActive).toBe(true)
			const first = 2 * chunk
			const held = 8192
			setup.absorber.ingest(Buffer.alloc(held, OLD))
			expect(setup.absorber.counters().heldBytes).toBe(held)
			setup.move(162.5e6)
			await posted()
			const at = position(proc)
			expect(at).toBe(first + held)
			// Past the laggard bound, at its next look, the absorber stops waiting for this branch and drops for it.
			setup.clock.now += ABSORBER_LAGGARD_MS
			setup.fanout.addBranch({ id: "later" })
			expect(setup.absorber.counters().heldBytes).toBe(0)
			expect(branchState().droppedBytesTotal).toBe(held)
			const tail = 2 * held
			const reading = read(proc.input, first + tail)
			await vi.waitFor(
				() => expect(branchState().backpressureActive).toBe(false),
				{
					timeout: 5000,
				},
			)
			setup.absorber.ingest(Buffer.alloc(tail, NEW))
			const bytes = await reading
			expect(bytes.indexOf(NEW)).toBe(first)
			expect(at).toBeGreaterThan(first)
			expect(bytes.subarray(at).every(b => b === NEW)).toBe(true)
			expect(bytes.length).toBeGreaterThan(at)
		})

		it.each([
			["not a number", Number.NaN],
			["negative", -2],
			["past safe integers", 2 ** 60],
		])(
			"retires the generation with a held count %s",
			async (_name, heldBytes) => {
				const setup = setupWithAbsorber()
				const grant = await setup.request()
				if (!grant.ok) throw new Error(grant.detail)
				const counters = setup.absorber.counters()
				vi.spyOn(setup.absorber, "counters").mockReturnValue({
					...counters,
					heldBytes,
				})
				setup.move(162.5e6)
				const proc = setup.processes[0]!
				expect(proc.stop).toHaveBeenCalledTimes(1)
				expect(proc.sent.some(r => r.type === "recenter")).toBe(false)
			},
		)
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
