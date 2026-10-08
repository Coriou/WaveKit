/**
 * Tuner state restoration across a real rtl_tcp reconnect: fake rtl_tcp server,
 * real SourceManager/TunerController/TunerRelay, fake SDR++ relay client.
 * Design: docs/superpowers/specs/2026-10-08-tuner-reconnect-sync.md
 */

import * as net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../../src/utils/logger.js"
import { SourceManager } from "../../src/core/source-manager.js"
import type { SourceCaps } from "../../src/core/source-manager.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { TunerController } from "../../src/core/tuner-controller.js"
import { TunerRelay } from "../../src/core/tuner-relay.js"

const logger = createLogger({ level: "fatal" })

interface FakeConnection {
	socket: net.Socket
	frames: Array<[number, number]>
}

function frame(cmd: number, value: number): Buffer {
	const buf = Buffer.alloc(5)
	buf.writeUInt8(cmd, 0)
	buf.writeUInt32BE(value >>> 0, 1)
	return buf
}

async function startFakeRtlTcp(): Promise<{
	server: net.Server
	port: number
	connections: FakeConnection[]
}> {
	const connections: FakeConnection[] = []
	const server = net.createServer(socket => {
		const conn: FakeConnection = { socket, frames: [] }
		connections.push(conn)
		let pending = Buffer.alloc(0)
		socket.on("data", data => {
			pending = Buffer.concat([pending, Buffer.from(data)])
			while (pending.length >= 5) {
				conn.frames.push([pending.readUInt8(0), pending.readUInt32BE(1)])
				pending = pending.subarray(5)
			}
		})
		socket.on("error", () => undefined)
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address() as net.AddressInfo
	return { server, port: address.port, connections }
}

async function freePort(): Promise<number> {
	const probe = net.createServer()
	await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve))
	const { port } = probe.address() as net.AddressInfo
	await new Promise<void>(resolve => probe.close(() => resolve()))
	return port
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting")
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	vi.restoreAllMocks()
})

describe("tuner reconnect synchronization over rtl_tcp", () => {
	it("replays accepted API and relay state after reconnect; newer relay commands win", async () => {
		// Minimum jittered backoff (2 s) keeps the reconnect quick and deterministic.
		vi.spyOn(Math, "random").mockReturnValue(0)

		const upstream = await startFakeRtlTcp()
		cleanups.push(
			() =>
				new Promise<void>(resolve => upstream.server.close(() => resolve())),
		)
		const sourceManager = new SourceManager(logger)
		cleanups.push(() => sourceManager.disconnectAll())
		const tuner = new TunerController(logger, sourceManager)
		const relayPort = await freePort()
		const relay = new TunerRelay(
			logger,
			sourceManager,
			new FanoutManager(logger),
			{
				enabled: true,
				host: "127.0.0.1",
				port: relayPort,
				sourceId: "rtl-1",
				controlPolicy: "exclusive",
			},
		)

		// Same wiring as src/index.ts.
		sourceManager.on("connected", id => {
			tuner.initializeSource(id, sourceManager.getCaps(id))
			tuner.synchronizeOnConnect(id)
		})
		relay.on("command-received", event => {
			if (event.sourceId)
				tuner.applyExternalCommand(event.sourceId, event.command, event.value)
		})
		relay.on("control-changed", () => {
			tuner.syncExternalControl(
				"rtl-1",
				Boolean(relay.getStatus().controlClientId),
			)
		})

		await sourceManager.connect({
			id: "rtl-1",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: upstream.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 2_048_000,
				centerFreq: 100_000_000,
				exclusive: false,
			},
		})
		await waitFor(() => upstream.connections.length === 1)
		const first = upstream.connections[0]!
		expect(first.frames).toEqual([]) // config defaults are never pushed

		await tuner.setSampleRate("rtl-1", 2_400_000)
		await tuner.setFrequency("rtl-1", 145_000_000)
		await waitFor(() => first.frames.length === 2)

		await relay.start()
		cleanups.push(() => relay.stop())
		const sdrpp = net.connect(relayPort, "127.0.0.1")
		sdrpp.on("error", () => undefined)
		cleanups.push(() => void sdrpp.destroy())
		await waitFor(() => tuner.getState("rtl-1")?.controlMode === "external")
		sdrpp.write(frame(0x01, 162_000_000))
		await waitFor(() => first.frames.length === 3)

		const capsEvents: SourceCaps[] = []
		sourceManager.on("caps-changed", (_id, caps) => capsEvents.push(caps))

		first.socket.destroy()
		await waitFor(() => sourceManager.getStatus("rtl-1")?.connected === false)

		// SDR++ keeps its relay socket and retunes gain while upstream is down.
		sdrpp.write(frame(0x04, 300))
		await waitFor(() => tuner.getState("rtl-1")?.gain === 300)

		await waitFor(() => upstream.connections.length === 2)
		const second = upstream.connections[1]!
		await waitFor(() => second.frames.length === 3)
		expect(second.frames).toEqual([
			[0x02, 2_400_000],
			[0x01, 162_000_000],
			[0x04, 300],
		])
		expect(capsEvents).toEqual([]) // unchanged state: no decoder restart

		sdrpp.write(frame(0x01, 163_000_000))
		await waitFor(() => second.frames.length === 4)
		expect(second.frames[3]).toEqual([0x01, 163_000_000])

		const state = tuner.getState("rtl-1")
		expect(state?.frequency).toBe(163_000_000)
		expect(state?.controlMode).toBe("external")
		expect(state?.lastError).toBeUndefined()
		expect(capsEvents).toHaveLength(1)
		expect(capsEvents[0]?.centerFreq).toBe(163_000_000)
		expect(upstream.connections).toHaveLength(2)
	}, 20_000)

	it("reset policy writes nothing after reconnect and returns caps to the configured baseline once", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)

		const upstream = await startFakeRtlTcp()
		cleanups.push(
			() =>
				new Promise<void>(resolve => upstream.server.close(() => resolve())),
		)
		const sourceManager = new SourceManager(logger)
		cleanups.push(() => sourceManager.disconnectAll())
		const tuner = new TunerController(logger, sourceManager, {
			reconnectPolicy: "reset",
		})
		sourceManager.on("connected", id => {
			tuner.initializeSource(id, sourceManager.getCaps(id))
			tuner.synchronizeOnConnect(id)
		})

		await sourceManager.connect({
			id: "rtl-1",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: upstream.port,
			loop: false,
			playbackSpeed: 1,
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 2_048_000,
				exclusive: false,
			},
		})
		await waitFor(() => upstream.connections.length === 1)
		const first = upstream.connections[0]!

		await tuner.setSampleRate("rtl-1", 2_160_000)
		await tuner.setFrequency("rtl-1", 446_866_968)
		await waitFor(() => first.frames.length === 2)
		expect(sourceManager.getCaps("rtl-1")?.sampleRate).toBe(2_160_000)

		const capsEvents: SourceCaps[] = []
		sourceManager.on("caps-changed", (_id, caps) => capsEvents.push(caps))
		first.socket.destroy()
		await waitFor(() => upstream.connections.length === 2)
		await waitFor(() => capsEvents.length === 1)
		// Give any stray replay time to arrive before asserting silence.
		await new Promise(resolve => setTimeout(resolve, 100))

		expect(upstream.connections[1]!.frames).toEqual([])
		expect(capsEvents).toHaveLength(1)
		const caps = sourceManager.getCaps("rtl-1")
		expect(caps?.sampleRate).toBe(2_048_000)
		expect(caps?.centerFreq).toBeUndefined()
		expect(caps?.format).toBe("U8_IQ")
		expect(tuner.getState("rtl-1")?.sampleRate).toBe(2_048_000)
	}, 20_000)
})
