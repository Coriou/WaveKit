import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import * as net from "node:net"
import { PassThrough, type Readable } from "node:stream"
import pino from "pino"
import Fastify from "fastify"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import {
	SourceManager,
	ExclusiveSourceError,
	SourceCompatibilityError,
} from "../../../src/core/source-manager.js"
import { telemetryRoutes } from "../../../src/api/routes/telemetry.js"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import type {
	Decoder,
	DecoderCaps,
	DecoderStatus,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })

class ReceivingDecoder extends EventEmitter implements Decoder {
	readonly type = "test"
	readonly output = new PassThrough({ objectMode: true })
	readonly chunks: Buffer[] = []
	input: Readable | null = null
	running = false
	failStart = false
	constructor(
		readonly id: string,
		readonly caps: DecoderCaps,
	) {
		super()
	}
	private readonly receive = (chunk: Buffer) => this.chunks.push(chunk)
	async start() {
		if (this.failStart) throw new Error("Cannot start")
		this.running = true
		this.emit("started")
	}
	async stop() {
		this.running = false
		this.emit("stopped")
	}
	async restart() {
		await this.stop()
		await this.start()
	}
	attachInput(input: Readable) {
		this.input = input
		input.on("data", this.receive)
	}
	detachInput() {
		this.input?.off("data", this.receive)
		this.input = null
	}
	updateOptions(_updates: Record<string, unknown>) {}
	getOutput() {
		return this.output
	}
	getAudioOutput() {
		return null
	}
	getHealth() {
		return "running" as const
	}
	getStatus(): DecoderStatus {
		return {
			id: this.id,
			type: this.type,
			running: this.running,
			health: "running",
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}
	}
	get bytes() {
		return Buffer.concat(this.chunks).toString()
	}
}

async function openSource() {
	const sockets: net.Socket[] = []
	const server = net.createServer(socket => sockets.push(socket))
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address() as net.AddressInfo
	return {
		port: address.port,
		sockets,
		send(bytes: string) {
			sockets.at(-1)!.write(Buffer.from(bytes))
		},
		async close() {
			for (const socket of sockets) socket.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}

let sources: SourceManager
let primary: FanoutManager
let routing: SourceFanoutRouter
let manager: DecoderManager
let registry: DecoderRegistry
const servers: Awaited<ReturnType<typeof openSource>>[] = []
const sharedCaps: DecoderCaps = {
	input: "audio_pcm",
	output: "text",
	integrationPattern: "pure_consumer",
}

beforeEach(() => {
	sources = new SourceManager(logger)
	primary = new FanoutManager(logger)
	routing = new SourceFanoutRouter(sources, primary, logger, "first")
	registry = new DecoderRegistry()
	registry.register(
		"test",
		config =>
			new ReceivingDecoder(config.id, {
				...sharedCaps,
				...(config.options["exclusive"] ? { wantsExclusiveSource: true } : {}),
				...(config.options["input"] === "iq" ? { input: "iq" as const } : {}),
				...(config.options["input"] === "external"
					? { input: "external" as const }
					: {}),
			}),
		sharedCaps,
	)
	manager = new DecoderManager(registry, primary, logger, {
		validateVersions: false,
	})
	manager.setSourceManager(sources, routing)
})
afterEach(async () => {
	await manager.destroy()
	routing.destroy()
	primary.destroy()
	await sources.disconnectAll()
	await Promise.all(servers.splice(0).map(server => server.close()))
})

async function connect(id: string) {
	const server = await openSource()
	servers.push(server)
	await sources.connect({
		id,
		type: "sdrpp-network",
		host: "127.0.0.1",
		port: server.port,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "audio_pcm",
			format: "S16LE",
			sampleRate: 48000,
			exclusive: false,
		},
	})
	await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
	return server
}
function create(
	id: string,
	sourceId?: string,
	options: Record<string, unknown> = {},
) {
	return manager.createDecoder({
		id,
		type: "test",
		enabled: true,
		sourceId,
		options,
	}) as ReceivingDecoder
}

describe("Source-aware stdin routing", () => {
	it("isolates two source streams and keeps legacy and monitor consumers on the primary", async () => {
		const first = await connect("first")
		const second = await connect("second")
		const firstDecoder = create("one", "first")
		const secondDecoder = create("two", "second")
		const legacy = create("legacy")
		const monitor: Buffer[] = []
		primary
			.addBranch({ id: "audio-monitor" })
			.on("data", chunk => monitor.push(chunk))
		await manager.startAll()
		first.send("AAAA")
		second.send("BBBB")
		await vi.waitFor(() => {
			expect(firstDecoder.bytes).toBe("AAAA")
			expect(secondDecoder.bytes).toBe("BBBB")
			expect(legacy.bytes).toBe("AAAA")
			expect(Buffer.concat(monitor).toString()).toBe("AAAA")
		})
		expect(sources.getAssignedSource("two")).toBe("second")
		expect(sources.getAssignedSource("legacy")).toBe("first")
		expect(routing.getBranchTelemetry("decoder-two")).toMatchObject({
			sourceId: "second",
			decoderId: "two",
			totalBytesWritten: 4,
		})
		expect(routing.getTelemetrySnapshot().totalBytesWritten).toBe(16)
	})

	it("rebinds only the selected source after removal and recreation, restoring ownership", async () => {
		const first = await connect("first")
		let second = await connect("second")
		const one = create("one", "first")
		const two = create("two", "second")
		await manager.startAll()
		const branch = two.input
		second.send("BB")
		await vi.waitFor(() => expect(two.bytes).toBe("BB"))
		await sources.disconnect("second")
		expect(sources.getAssignedSource("two")).toBeUndefined()
		first.send("AA")
		await vi.waitFor(() => expect(one.bytes).toBe("AA"))
		second = await connect("second")
		second.send("CC")
		await vi.waitFor(() => expect(two.bytes).toBe("BBCC"))
		expect(two.input).toBe(branch)
		expect(sources.getAssignedSource("two")).toBe("second")
		expect(one.bytes).toBe("AA")
	})

	it("keeps branches alive through a transient disconnect and reconnects without duplicate deliveries", async () => {
		await connect("first")
		const second = await connect("second")
		const two = create("two", "second")
		await manager.startDecoder("two")
		const branch = two.input
		second.sockets[0]!.destroy()
		await vi.waitFor(() =>
			expect(sources.getStatus("second")?.connected).toBe(false),
		)
		await vi.waitFor(() => expect(second.sockets).toHaveLength(2), {
			timeout: 6000,
		})
		await vi.waitFor(() =>
			expect(sources.getStatus("second")?.connected).toBe(true),
		)
		second.send("CC")
		await vi.waitFor(() => expect(two.bytes).toBe("CC"))
		expect(two.input).toBe(branch)
		expect(routing.getBranchTelemetry("decoder-two")?.totalBytesWritten).toBe(2)
	}, 10000)

	it("enforces source ownership and compatibility before creating a branch, and cleans up failed starts", async () => {
		await connect("first")
		await connect("second")
		create("exclusive", "second", { exclusive: true })
		create("shared", "second")
		create("wrong-input", "first", { input: "iq" })
		await manager.startDecoder("exclusive")
		await expect(manager.startDecoder("shared")).rejects.toBeInstanceOf(
			ExclusiveSourceError,
		)
		await expect(manager.startDecoder("wrong-input")).rejects.toBeInstanceOf(
			SourceCompatibilityError,
		)
		expect(routing.getTelemetrySnapshot().branches).toHaveLength(1)
		await manager.stopDecoder("exclusive")
		expect(sources.isSourceAvailable("second")).toBe(true)
		const shared = manager.getDecoder("shared") as ReceivingDecoder
		shared.failStart = true
		await expect(manager.startDecoder("shared")).rejects.toThrow("Cannot start")
		expect(sources.getAssignedSource("shared")).toBeUndefined()
		expect(routing.getTelemetrySnapshot().branches).toHaveLength(0)
		shared.failStart = false
		await manager.startDecoder("shared")
		expect(sources.getAssignedSource("shared")).toBe("second")
	})

	it("does not attach external decoders or silently route unknown sources to primary", async () => {
		await connect("first")
		create("external", "missing", { input: "external" })
		create("unknown", "missing")
		await manager.startDecoder("external")
		await expect(manager.startDecoder("unknown")).rejects.toThrow(
			"Source missing not found",
		)
		expect(routing.getTelemetrySnapshot().branches).toHaveLength(0)
	})

	it("publishes all source branches through telemetry and source-consumer endpoints", async () => {
		const first = await connect("first")
		const second = await connect("second")
		create("one", "first")
		create("two", "second")
		await manager.startAll()
		first.send("AA")
		second.send("BB")
		await vi.waitFor(() =>
			expect(routing.getTelemetrySnapshot().totalBytesWritten).toBe(4),
		)
		const app = Fastify()
		try {
			await app.register(telemetryRoutes, { fanoutManager: routing })
			await app.register(sourceRoutes, {
				sourceManager: sources,
				fanoutManager: routing,
			})
			const snapshot = await app.inject("/api/telemetry/fanout")
			expect(snapshot.json().branches).toHaveLength(2)
			const branch = await app.inject(
				"/api/telemetry/fanout/branches/decoder-two",
			)
			expect(branch.json()).toMatchObject({
				sourceId: "second",
				totalBytesWritten: 2,
			})
			const sourceResponse = await app.inject("/api/sources")
			expect(sourceResponse.json()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "first", consumers: 1 }),
					expect.objectContaining({ id: "second", consumers: 1 }),
				]),
			)
		} finally {
			await app.close()
		}
	})

	it("selects the first dynamically added source for legacy consumers when no primary was configured", async () => {
		routing.destroy()
		routing = new SourceFanoutRouter(sources, primary, logger)
		manager.setSourceManager(sources, routing)
		const legacy = create("legacy")
		await manager.startDecoder("legacy")
		const dynamic = await connect("dynamic")
		dynamic.send("DD")
		await vi.waitFor(() => expect(legacy.bytes).toBe("DD"))
		expect(sources.getAssignedSource("legacy")).toBe("dynamic")
		expect(routing.getBranchTelemetry("decoder-legacy")?.sourceId).toBe(
			"dynamic",
		)
	})

	it("updates each selected source and legacy decoder when multiple sources change rates together", async () => {
		await connect("first")
		await connect("second")
		const one = create("one", "first")
		const two = create("two", "second")
		const legacy = create("legacy")
		await manager.startAll()
		const updateOne = vi.spyOn(one, "updateOptions")
		const updateTwo = vi.spyOn(two, "updateOptions")
		const updateLegacy = vi.spyOn(legacy, "updateOptions")
		sources.updateSourceCaps("first", { sampleRate: 96000 })
		sources.updateSourceCaps("second", { sampleRate: 24000 })
		await vi.waitFor(() => {
			expect(updateOne).toHaveBeenCalledWith({ inputSampleRate: 96000 })
			expect(updateTwo).toHaveBeenCalledWith({ inputSampleRate: 24000 })
			expect(updateLegacy).toHaveBeenCalledWith({ inputSampleRate: 96000 })
		})
		expect(updateOne).toHaveBeenCalledTimes(1)
		expect(updateTwo).toHaveBeenCalledTimes(1)
	})

	it("uses one primary fanout when an explicit decoder starts before the first source connects", async () => {
		routing.destroy()
		routing = new SourceFanoutRouter(sources, primary, logger)
		manager.setSourceManager(sources, routing)
		const server = await openSource()
		servers.push(server)
		const connection = sources.connect({
			id: "dynamic",
			type: "sdrpp-network",
			host: "127.0.0.1",
			port: server.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "audio_pcm",
				format: "S16LE",
				sampleRate: 48000,
				exclusive: false,
			},
		})
		const early = create("early", "dynamic")
		await manager.startDecoder("early")
		await connection
		await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
		const late = create("late", "dynamic")
		const legacy = create("legacy")
		await manager.startDecoder("late")
		await manager.startDecoder("legacy")
		server.send("DD")
		await vi.waitFor(() => {
			expect(early.bytes).toBe("DD")
			expect(late.bytes).toBe("DD")
			expect(legacy.bytes).toBe("DD")
		})
		expect(primary.getBranchIds()).toHaveLength(3)
		expect(routing.getTelemetrySnapshot().branches).toHaveLength(3)
		await manager.stopDecoder("early")
		await manager.startDecoder("early")
		server.send("EE")
		await vi.waitFor(() => expect(early.bytes).toBe("DDEE"))
		expect(routing.getBranchTelemetry("decoder-early")?.sourceId).toBe(
			"dynamic",
		)
	})

	it("restores exclusive ownership before a recreated source delivers bytes", async () => {
		await connect("first")
		const server = await connect("second")
		const one = create("one", "second")
		const two = create("two", "second")
		await manager.startAll()
		await sources.disconnect("second")
		await sources.connect({
			id: "second",
			type: "sdrpp-network",
			host: "127.0.0.1",
			port: server.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "audio_pcm",
				format: "S16LE",
				sampleRate: 48000,
				exclusive: true,
			},
		})
		await vi.waitFor(() => expect(server.sockets).toHaveLength(2))
		server.send("CC")
		await vi.waitFor(() => expect(one.bytes).toBe("CC"))
		expect(two.bytes).toBe("")
		expect(two.input).toBeNull()
		expect(two.running).toBe(false)
		expect(sources.getAssignedSource("one")).toBe("second")
		expect(sources.getAssignedSource("two")).toBeUndefined()
		expect(routing.getTelemetrySnapshot().branches).toHaveLength(1)
	})

	it("removes routing listeners and secondary branches on cleanup", async () => {
		await connect("first")
		await connect("second")
		const decoder = create("two", "second")
		await manager.startDecoder("two")
		const branch = decoder.input
		await manager.destroy()
		routing.destroy()
		expect(branch?.destroyed).toBe(true)
		expect(sources.listenerCount("connected")).toBe(0)
		expect(sources.listenerCount("disconnected")).toBe(0)
		expect(sources.listenerCount("removed")).toBe(0)
		expect(sources.getAllAssignments().size).toBe(0)
	})
})
