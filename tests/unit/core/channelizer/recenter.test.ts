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
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

/**
 * The production wiring around the process boundary: the real SourceManager with a live connection to an in-process
 * server on an ephemeral loopback port, the real fanout and the real manager. Only the wavekit-chan process is faked.
 */
async function setup() {
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
		const proc = Object.assign(new EventEmitter(), {
			generation: o.generation,
			input: new PassThrough(),
			sent: [] as ChannelizerRequest[],
			start: () => {
				proc.emit("event", {
					v: 1,
					type: "ready",
					generation: o.generation,
					pid: 1,
				})
				return Promise.resolve()
			},
			stop: vi.fn(() => Promise.resolve()),
			send: (r: ChannelizerRequest) => {
				proc.sent.push(r)
				if (r.type === "open")
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
		connect: () => Promise.resolve(new PassThrough()),
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
			{ v: 1, type: "recenter", centerHz: 162.5e6 },
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
		expect(encodeRequest({ v: 1, type: "recenter", centerHz: 123 })).toBe(
			'{"v":1,"type":"recenter","centerHz":123}\n',
		)
		expect(() =>
			encodeRequest({ v: 1, type: "recenter", centerHz: Number.NaN }),
		).toThrow()
		expect(() =>
			encodeRequest({
				v: 1,
				type: "recenter",
				centerHz: 123,
				id: "a",
			} as ChannelizerRequest),
		).toThrow()
	})
})
