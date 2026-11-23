/**
 * The supervisor against the built `wavekit-iqhub` and an in-process fake rtl_tcp on an ephemeral
 * 127.0.0.1 port (port 0). Gated on the binary: WAVEKIT_IQHUB_BIN, else the crate's release build.
 * The only processes signalled are the hubs these tests spawned, by their own pid.
 */
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { SourceConfig } from "../../../../src/config.js"
import { spawnHubProcessFactory } from "../../../../src/core/iq-hub/hub-process.js"
import type { HubProcessFactory } from "../../../../src/core/iq-hub/hub-process.js"
import {
	HubSourceIntake,
	IQHUB_EXITED,
	IQHUB_HUNG,
	Supervisor,
} from "../../../../src/core/iq-hub/supervisor.js"
import type { SupervisorOptions } from "../../../../src/core/iq-hub/supervisor.js"
import { SourceManager } from "../../../../src/core/source-manager.js"
import { closeOf, collect, until } from "./fake-hub.js"

const BIN =
	process.env["WAVEKIT_IQHUB_BIN"] ??
	path.resolve("native/wavekit-iqhub/target/release/wavekit-iqhub")
const available = fs.existsSync(BIN)
if (!available)
	process.stderr.write(
		`real-binary hub tests skipped: no wavekit-iqhub at ${BIN} (make hub-build, or set WAVEKIT_IQHUB_BIN)\n`,
	)

const log = pino({ level: "silent" })
const HEADER = Buffer.from("RTL0\x00\x00\x00\x05\x00\x00\x00\x1d", "latin1")

function stall(ms: number): void {
	const end = performance.now() + ms
	while (performance.now() < end) {
		/* a main-thread stall */
	}
}

const config = (port: number, sampleRate = 1_024_000): SourceConfig =>
	({
		id: "rx",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate,
			exclusive: false,
		},
	}) as SourceConfig

interface Client {
	socket: net.Socket
	commands: Buffer[]
	ended: boolean
	sent: number
}

/** A fake rtl_tcp: the header, then a counting byte pattern (byte i = i & 0xff), ~2 MB/s. */
class FakeRtlTcp {
	readonly server: net.Server
	readonly clients: Client[] = []
	private timer: ReturnType<typeof setInterval> | null = null

	constructor() {
		this.server = net.createServer(socket => {
			socket.on("error", () => {})
			const client: Client = { socket, commands: [], ended: false, sent: 0 }
			this.clients.push(client)
			socket.on("data", (chunk: Buffer) =>
				client.commands.push(Buffer.from(chunk)),
			)
			socket.on("end", () => {
				client.ended = true
				socket.end()
			})
			socket.write(HEADER)
		})
		this.timer = setInterval(() => this.pump(), 2)
	}

	private pump(): void {
		for (const client of this.clients) {
			if (client.socket.destroyed || client.socket.writableEnded) continue
			if (client.socket.writableLength > 1 << 20) continue
			const chunk = Buffer.alloc(4096)
			for (let i = 0; i < chunk.length; i++) chunk[i] = (client.sent + i) & 0xff
			client.sent += chunk.length
			client.socket.write(chunk)
		}
	}

	listen(): Promise<number> {
		return new Promise(resolve =>
			this.server.listen(0, "127.0.0.1", () => {
				const address = this.server.address() as net.AddressInfo
				resolve(address.port)
			}),
		)
	}

	async close(): Promise<void> {
		if (this.timer !== null) clearInterval(this.timer)
		for (const client of this.clients) client.socket.destroy()
		await new Promise<void>(resolve => this.server.close(() => resolve()))
	}
}

function expectCounting(payload: Buffer): void {
	for (let i = 0; i < payload.length; i++)
		if (payload[i] !== (i & 0xff))
			throw new Error(`payload byte ${i} out of order`)
}

let upstream: FakeRtlTcp | null = null
const supervisors: Supervisor[] = []
const sockets: net.Socket[] = []
let manager: SourceManager | undefined

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy()
	await manager?.disconnectAll()
	manager = undefined
	await Promise.all(supervisors.splice(0).map(s => s.dispose()))
	await upstream?.close()
	upstream = null
})

function makeSupervisor(
	overrides: Partial<SupervisorOptions> = {},
): Supervisor {
	const supervisor = new Supervisor({
		sourceId: "rx",
		logger: log,
		factory: spawnHubProcessFactory(BIN),
		...overrides,
	})
	supervisors.push(supervisor)
	return supervisor
}

async function dial(supervisor: Supervisor, port: number, sampleRate?: number) {
	const socket = new net.Socket({ allowHalfOpen: true })
	sockets.push(socket)
	const received = collect(socket)
	const closed = closeOf(socket)
	const connected = new Promise<void>(resolve =>
		socket.once("connect", resolve),
	)
	supervisor.dial(socket, config(port, sampleRate), "127.0.0.1", port)
	return { socket, received, closed, connected }
}

describe.skipIf(!available)(
	"hub supervisor against the real wavekit-iqhub",
	() => {
		it("connect, header, payload, commands upstream in order, and Node's end reaches the receiver", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			const supervisor = makeSupervisor()
			const { socket, received, closed, connected } = await dial(
				supervisor,
				port,
			)
			await connected
			// Pipe handles accept SourceManager's socket options.
			expect(() => socket.setKeepAlive(true, 5000)).not.toThrow()
			expect(() => socket.setNoDelay(true)).not.toThrow()
			expect(() => socket.setTimeout(0)).not.toThrow()
			await until(() => received.bytes().length >= 12 + 65_536)
			const bytes = received.bytes()
			expect(bytes.subarray(0, 12)).toEqual(HEADER)
			expectCounting(bytes.subarray(12))
			const client = upstream.clients[0]
			if (!client) throw new Error("no upstream client")
			const local = supervisor.localPortOf(socket)
			expect(local).toBe(client.socket.remotePort)
			const commands = [
				Buffer.from([0x01, 0x05, 0xf5, 0xe1, 0x00]),
				Buffer.from([0x02, 0x00, 0x0f, 0xa0, 0x00]),
				Buffer.alloc(200, 0x0d),
			]
			for (const command of commands) socket.write(command)
			const expected = Buffer.concat(commands)
			await until(
				() => Buffer.concat(client.commands).length >= expected.length,
			)
			expect(Buffer.concat(client.commands)).toEqual(expected)
			socket.end()
			await until(() => client.ended)
			const result = await closed
			expect(result.error).toBeNull()
			expectCounting(received.bytes().subarray(12))
		}, 20_000)

		it("a refused port is ECONNREFUSED, as a net connect", async () => {
			const probe = net.createServer()
			const port = await new Promise<number>(resolve =>
				probe.listen(0, "127.0.0.1", () =>
					resolve((probe.address() as net.AddressInfo).port),
				),
			)
			await new Promise<void>(resolve => probe.close(() => resolve()))
			const supervisor = makeSupervisor()
			const { closed } = await dial(supervisor, port)
			const result = await closed
			expect(result.error?.code).toBe("ECONNREFUSED")
			expect(result.events).toEqual(["error", "close"])
		}, 20_000)

		it("a peer reset destroys with ECONNRESET after the data; a peer close ends cleanly", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			const supervisor = makeSupervisor()
			const one = await dial(supervisor, port)
			await one.connected
			await until(() => one.received.bytes().length > 12 + 8192)
			upstream.clients[0]?.socket.resetAndDestroy()
			const reset = await one.closed
			expect(reset.error?.code).toBe("ECONNRESET")
			expectCounting(one.received.bytes().subarray(12))

			const two = await dial(supervisor, port)
			await two.connected
			await until(() => two.received.bytes().length > 12 + 8192)
			upstream.clients[1]?.socket.end()
			const eof = await two.closed
			expect(eof.error).toBeNull()
			expectCounting(two.received.bytes().subarray(12))
		}, 20_000)

		it("a killed hub fails its dial IQHUB_EXITED; the next dial spawns a new hub", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			const supervisor = makeSupervisor()
			const one = await dial(supervisor, port)
			await one.connected
			const pid = supervisor.pid
			if (pid === null) throw new Error("no hub pid")
			process.kill(pid, "SIGKILL")
			const result = await one.closed
			expect(result.error?.code).toBe(IQHUB_EXITED)
			const two = await dial(supervisor, port)
			await two.connected
			await until(() => two.received.bytes().length > 12 + 4096)
			expect(supervisor.pid).not.toBe(pid)
			expectCounting(two.received.bytes().subarray(12))
		}, 20_000)

		it("a stopped hub is killed and its dial fails IQHUB_HUNG", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			const supervisor = makeSupervisor({
				watchdog: { hungAfterMs: 1000, checkEveryMs: 100 },
			})
			const one = await dial(supervisor, port)
			await one.connected
			const pid = supervisor.pid
			if (pid === null) throw new Error("no hub pid")
			process.kill(pid, "SIGSTOP")
			const result = await one.closed
			expect(result.error?.code).toBe(IQHUB_HUNG)
			await until(() => supervisor.pid === null)
		}, 20_000)

		it("a stalled Node main thread does not kill a live hub", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			// 3 s threshold, 3.5 s stall: the stall still outlasts the threshold, and a loaded
			// runner that deschedules the hub child for a second does not kill it.
			const supervisor = makeSupervisor({
				watchdog: { hungAfterMs: 3000, checkEveryMs: 100 },
			})
			const one = await dial(supervisor, port)
			await one.connected
			const pid = supervisor.pid
			const stallEnd = Date.now() + 3500
			while (Date.now() < stallEnd) {
				/* a 3.5 s main-thread stall */
			}
			await new Promise(resolve => setTimeout(resolve, 300))
			expect(supervisor.pid).toBe(pid)
			expect(one.socket.destroyed).toBe(false)
			const before = one.received.bytes().length
			await until(() => one.received.bytes().length > before + 4096)
		}, 20_000)

		it("a ready line waiting behind a 1 s main-thread stall is read before the 300 ms deadline acts", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			const real = spawnHubProcessFactory(BIN)
			let spawnedPid: number | null = null
			// The stall starts once the child (and its pid) exists, before any event line is read.
			const stalling: HubProcessFactory = async (options, handlers) => {
				const proc = await real(options, handlers)
				spawnedPid = proc.pid
				stall(1000)
				return proc
			}
			const supervisor = makeSupervisor({
				factory: stalling,
				readyTimeoutMs: 300,
			})
			const one = await dial(supervisor, port)
			await one.connected
			expect(supervisor.pid).toBe(spawnedPid)
			await until(() => one.received.bytes().length > 12 + 4096)
			expectCounting(one.received.bytes().subarray(12))
		}, 20_000)

		it("a configured line waiting behind a 1 s stall on a rate change is read before the deadline acts", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			const supervisor = makeSupervisor({
				readyTimeoutMs: 300,
				configureWaitMs: 0,
			})
			const one = await dial(supervisor, port)
			await one.connected
			const pid = supervisor.pid
			// Past the 3.2 Msps the hub is sized for: a real reconfigure.
			const two = await dial(supervisor, port, 4_000_000)
			// The configure is sent (and its deadline armed) in the dial's microtasks.
			await new Promise(resolve => setImmediate(resolve))
			stall(1000)
			await two.connected
			expect(supervisor.pid).toBe(pid)
			await until(() => two.received.bytes().length > 12 + 4096)
			expectCounting(two.received.bytes().subarray(12))
		}, 20_000)

		it("SourceManager through the hub intake: header info, payload, tuner write, local port", async () => {
			upstream = new FakeRtlTcp()
			const port = await upstream.listen()
			const intake = new HubSourceIntake({
				logger: log,
				factory: spawnHubProcessFactory(BIN),
			})
			manager = new SourceManager(log, { intake })
			const stream = await manager.connect(config(port))
			const chunks: Buffer[] = []
			stream.on("data", (chunk: Buffer) => chunks.push(chunk))
			await until(() => Buffer.concat(chunks).length >= 32_768)
			expectCounting(Buffer.concat(chunks))
			expect(manager.getRtlTcpInfo("rx")).toMatchObject({
				tunerType: 5,
				gainCount: 29,
			})
			const client = upstream.clients[0]
			if (!client) throw new Error("no upstream client")
			expect(manager.connectionLocalPort("rx")).toBe(client.socket.remotePort)
			manager.writeToSource("rx", Buffer.from([0x01, 0x05, 0xf5, 0xe1, 0x00]))
			await until(() => Buffer.concat(client.commands).length >= 5)
			expect(Buffer.concat(client.commands)).toEqual(
				Buffer.from([0x01, 0x05, 0xf5, 0xe1, 0x00]),
			)
			await manager.disconnectAll()
			manager = undefined
			await until(() => client.ended || client.socket.destroyed)
		}, 20_000)
	},
)
