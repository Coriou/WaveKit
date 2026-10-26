// The KISS client keeps retrying with bounded backoff until direwolf's KISS port is up, and
// stops retrying when the decoder stops. A fake KISS server on an ephemeral loopback port
// starts only after several refused attempts.
import { createServer, type Server, type Socket } from "node:net"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { DirewolfDecoder } from "../../../src/decoders/builtin/direwolf.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

const FEND = 0xc0

function address(callsign: string, last: boolean): Buffer {
	const padded = callsign.padEnd(6, " ").slice(0, 6)
	const bytes = [...padded].map(c => c.charCodeAt(0) << 1)
	bytes.push(0x60 | (last ? 1 : 0))
	return Buffer.from(bytes)
}

/** One KISS data frame carrying an AX.25 UI frame N0CALL > APRS with a status text. */
function kissFrame(): Buffer {
	const ax25 = Buffer.concat([
		address("APRS", false),
		address("N0CALL", true),
		Buffer.from([0x03, 0xf0]),
		Buffer.from(">hello", "ascii"),
	])
	return Buffer.concat([Buffer.from([FEND, 0x00]), ax25, Buffer.from([FEND])])
}

class TestDirewolf extends DirewolfDecoder {
	constructor(config: DecoderConfig) {
		super(config, pino({ level: "silent" }))
		this.reconnectBaseMs = 10
		this.reconnectMaxMs = 40
	}
	connect(): Promise<void> {
		return this.connectToOutput()
	}
	get attempts(): number {
		return this.reconnectAttempts
	}
	get pending(): boolean {
		return this.reconnectTimer !== null
	}
	markStopping(): void {
		this.isStopping = true
	}
}

async function freePort(): Promise<number> {
	const server = createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	const port = typeof address === "object" && address ? address.port : 0
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("condition not reached")
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

const decoders: TestDirewolf[] = []
const servers: Server[] = []
const sockets: Socket[] = []

afterEach(async () => {
	for (const d of decoders.splice(0)) await d.stop().catch(() => undefined)
	for (const s of sockets.splice(0)) s.destroy()
	for (const s of servers.splice(0))
		await new Promise<void>(resolve => s.close(() => resolve()))
})

function decoderOn(port: number): TestDirewolf {
	const d = new TestDirewolf({
		id: "aprs",
		type: "direwolf",
		enabled: true,
		options: { kissPort: port },
	})
	decoders.push(d)
	return d
}

describe("direwolf KISS client retry", () => {
	it("keeps retrying past the second refusal and connects once the port is up", async () => {
		const port = await freePort()
		const d = decoderOn(port)
		const outputs: DecoderOutput[] = []
		d.on("output", (o: DecoderOutput) => outputs.push(o))
		await d.connect()
		// refused again and again: the client never gives up (it used to stop at attempt 2),
		// and its backoff stays bounded (at most 40 ms here), so attempts keep coming
		const t0 = Date.now()
		await until(() => d.attempts >= 8)
		expect(Date.now() - t0).toBeLessThan(2_000)
		const server = createServer(socket => {
			sockets.push(socket)
			socket.write(kissFrame())
		})
		servers.push(server)
		await new Promise<void>(resolve =>
			server.listen(port, "127.0.0.1", resolve),
		)
		await until(() => outputs.length > 0)
		expect(outputs[0]).toMatchObject({ decoder: "aprs", type: "aprs" })
		// connected: the attempt count is reset
		expect(d.attempts).toBe(0)
	})

	it("reconnects after the KISS connection drops", async () => {
		const port = await freePort()
		let connections = 0
		const server = createServer(socket => {
			connections++
			sockets.push(socket)
			if (connections === 1) socket.destroy()
			else socket.write(kissFrame())
		})
		servers.push(server)
		await new Promise<void>(resolve =>
			server.listen(port, "127.0.0.1", resolve),
		)
		const d = decoderOn(port)
		const outputs: DecoderOutput[] = []
		d.on("output", (o: DecoderOutput) => outputs.push(o))
		await d.connect()
		await until(() => outputs.length > 0)
		expect(connections).toBeGreaterThanOrEqual(2)
	})

	it("a stopped decoder schedules nothing and never connects", async () => {
		const port = await freePort()
		const d = decoderOn(port)
		await d.connect()
		await until(() => d.attempts >= 2)
		await d.stop()
		expect(d.pending).toBe(false)
		const attempts = d.attempts
		let connected = 0
		const server = createServer(socket => {
			connected++
			sockets.push(socket)
		})
		servers.push(server)
		await new Promise<void>(resolve =>
			server.listen(port, "127.0.0.1", resolve),
		)
		await new Promise(resolve => setTimeout(resolve, 150))
		expect(connected).toBe(0)
		expect(d.attempts).toBe(attempts)
		// a connect asked while stopping is a no-op
		d.markStopping()
		await d.connect()
		expect(connected).toBe(0)
	})
})
