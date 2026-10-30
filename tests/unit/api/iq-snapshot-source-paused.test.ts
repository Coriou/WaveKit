/**
 * An IQ snapshot and a paused receiver feed (SourceManager.pause): a pause mid-snapshot detaches
 * the capture and frees the process slot (the core keeps no failed state), a snapshot while
 * paused is refused 503, and after resume a snapshot completes with its exact bytes.
 * Real SourceManager on a fake rtl_tcp server (ephemeral loopback port).
 */
import * as net from "node:net"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { afterEach, expect, it } from "vitest"
import { iqSnapshotRoutes } from "../../../src/api/routes/iq-snapshot.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../src/core/source-manager.js"

const logger = pino({ level: "silent" })
const RATE = 10_000

async function fakeRtlTcp() {
	const sockets: net.Socket[] = []
	const server = net.createServer(socket => {
		sockets.push(socket)
		socket.on("error", () => undefined)
		socket.on("end", () => socket.end())
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		const iq = setInterval(() => {
			if (socket.writable) socket.write(Buffer.alloc(1000, 127))
		}, 10)
		socket.on("close", () => clearInterval(iq))
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as net.AddressInfo).port,
		close: async () => {
			for (const s of sockets) s.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting")
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function harness() {
	const upstream = await fakeRtlTcp()
	cleanups.push(() => upstream.close())
	const sources = new SourceManager(logger)
	cleanups.push(() => sources.disconnectAll())
	const stream = await sources.connect({
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: upstream.port,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: RATE,
			centerFreq: 100_000_000,
			exclusive: false,
		},
	})
	const fanout = new FanoutManager(logger)
	fanout.attachSource(stream)
	cleanups.push(async () => {
		fanout.detachSource()
		fanout.destroy()
	})
	const app: FastifyInstance = Fastify()
	await app.register(iqSnapshotRoutes, {
		sourceManager: sources,
		fanoutFor: () => fanout,
		access: {
			authorizeMetadataMutation: () => undefined,
			leaseDownload: (_request, raw, cancel) => {
				let released = false
				const release = () => {
					if (released) return
					released = true
					cancel()
				}
				raw.once("finish", release)
				return {
					kind: "attached",
					active: () => !released,
					release: () => {
						release()
						raw.destroy()
					},
				}
			},
		},
	})
	cleanups.push(() => app.close())
	await waitFor(() => sources.getStatus("rtl")?.activity.state === "streaming")
	return { sources, fanout, app }
}

const snapshot = (app: FastifyInstance, seconds: number) =>
	app
		.inject({
			method: "POST",
			url: "/api/sources/rtl/iq-snapshot",
			payload: { seconds, format: "cu8" },
		})
		.then(
			r => ({
				status: r.statusCode,
				bytes: r.rawPayload.length,
				code:
					r.statusCode === 200 ? null : (r.json() as { code?: string }).code,
			}),
			() => ({ status: 0, bytes: 0, code: null }),
		)

it("a pause mid-snapshot detaches it; paused refuses; after resume a snapshot completes", async () => {
	const { sources, fanout, app } = await harness()
	// 5 s at 10 kS/s CU8 is 100 kB; the fake sends 100 kB/s, so the pause lands mid-capture.
	const pending = snapshot(app, 5)
	await waitFor(() => fanout.getTelemetrySnapshot().branches.length === 1)
	await sources.pause("rtl")
	await pending
	// Detached on the pause's "disconnected"; the process slot is free again.
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)

	expect(await snapshot(app, 0.1)).toMatchObject({
		status: 503,
		code: "SOURCE_DISCONNECTED",
	})
	expect(fanout.getTelemetrySnapshot().branches).toHaveLength(0)

	await sources.resume("rtl")
	await waitFor(() => sources.getStatus("rtl")?.activity.state === "streaming")
	// 0.1 s at 10 kS/s, two bytes per CU8 sample.
	expect(await snapshot(app, 0.1)).toEqual({
		status: 200,
		bytes: 2000,
		code: null,
	})
})
