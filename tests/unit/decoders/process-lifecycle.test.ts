import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { once } from "node:events"
import { PassThrough } from "node:stream"
import { createServer } from "node:net"
import { createSocket } from "node:dgram"
import pino from "pino"
import { BaseDecoder } from "../../../src/decoders/base-decoder.js"
import { ExternalSdrDecoder } from "../../../src/decoders/external-sdr-decoder.js"
import { NetworkProducerDecoder } from "../../../src/decoders/network-producer-decoder.js"
import type { DecoderCaps, DecoderOutput } from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const caps: DecoderCaps = {
	input: "external",
	output: "text",
	integrationPattern: "pure_consumer",
}
const config = { id: "test", type: "test", enabled: true, options: {} }
const program =
	'process.stdin.resume(); console.log("ready"); setInterval(() => {}, 1000)'
const stubbornProgram = 'process.on("SIGTERM", () => {}); ' + program

class Consumer extends BaseDecoder {
	command = process.execPath
	program = program
	constructor() {
		super(config, logger)
	}
	protected getCommand() {
		return this.command
	}
	protected getArgs() {
		return ["-e", this.program]
	}
	protected getCaps() {
		return caps
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	async ready() {
		await once(this.process!.stdout!, "data")
	}
	forceKill() {
		this.process?.kill("SIGKILL")
	}
}
class External extends ExternalSdrDecoder {
	command = process.execPath
	program = program
	constructor() {
		super({ ...config, deviceSerial: "0", frequencies: [100000000] }, logger)
	}
	protected getCommand() {
		return this.command
	}
	protected getArgs() {
		return ["-e", this.program]
	}
	protected getCaps() {
		return caps
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	async ready() {
		await once(this.process!.stdout!, "data")
	}
	forceKill() {
		this.process?.kill("SIGKILL")
	}
}
class Network extends NetworkProducerDecoder {
	command = process.execPath
	program = program
	constructor(port = 0, protocol: "tcp" | "udp" = "tcp") {
		super(
			{
				...config,
				outputHost: "127.0.0.1",
				outputPort: port,
				outputProtocol: protocol,
			},
			logger,
		)
	}
	protected getCommand() {
		return this.command
	}
	protected getArgs() {
		return ["-e", this.program]
	}
	protected getCaps() {
		return caps
	}
	protected parseNetworkData(): DecoderOutput[] {
		return []
	}
	async ready() {
		await once(this.process!.stdout!, "data")
	}
	forceKill() {
		this.process?.kill("SIGKILL")
	}
	connectNow() {
		return this.connectToOutput()
	}
	disconnectNow() {
		this.disconnectFromOutput()
	}
}

const active: Array<Consumer | External | Network> = []
afterEach(async () => {
	vi.useRealTimers()
	for (const decoder of active.splice(0)) {
		decoder.forceKill()
		await decoder.stop()
	}
})

for (const Decoder of [Consumer, External, Network]) {
	describe(`${Decoder.name} process lifecycle`, () => {
		it("rejects missing executables without reporting started or getting stuck running", async () => {
			const decoder = new Decoder()
			active.push(decoder)
			decoder.command = "/wavekit/nonexistent-decoder"
			const started = vi.fn()
			decoder.on("started", started)
			await expect(decoder.start()).rejects.toThrow()
			expect(started).not.toHaveBeenCalled()
			expect(decoder.getStatus().running).toBe(false)
			await decoder.stop()
			decoder.command = process.execPath
			await decoder.start()
			expect(started).toHaveBeenCalledOnce()
		})

		it("escalates SIGTERM to SIGKILL when the child ignores termination", async () => {
			const decoder = new Decoder()
			active.push(decoder)
			decoder.program = stubbornProgram
			await decoder.start()
			await decoder.ready()
			vi.useFakeTimers()
			const exited = once(decoder, "exit")
			const stopped = decoder.stop()
			await vi.advanceTimersByTimeAsync(5001)
			await stopped
			expect(await exited).toEqual([null, "SIGKILL"])
			expect(decoder.getStatus().running).toBe(false)
		})
	})
}

for (const Decoder of [Consumer, Network]) {
	it(`${Decoder.name} counts input once and removes detached listeners`, async () => {
		const decoder = new Decoder()
		active.push(decoder)
		const input = new PassThrough()
		decoder.attachInput(input)
		await decoder.start()
		input.write(Buffer.alloc(32))
		expect(decoder.getStatus().stats.bytesIn).toBe(32)
		decoder.detachInput()
		expect(input.listenerCount("data")).toBe(0)
		expect(input.listenerCount("error")).toBe(0)
		decoder.attachInput(input)
		input.write(Buffer.alloc(16))
		expect(decoder.getStatus().stats.bytesIn).toBe(48)
	})
}

it("keeps retrying TCP after multiple refused connections and recovers when output becomes available", async () => {
	const reservation = createServer()
	reservation.listen(0, "127.0.0.1")
	await once(reservation, "listening")
	const address = reservation.address()
	if (!address || typeof address === "string")
		throw new Error("Missing TCP port")
	await new Promise<void>(resolve => reservation.close(() => resolve()))
	const decoder = new Network(address.port)
	active.push(decoder)
	vi.useFakeTimers()
	await decoder.start()
	await decoder.ready()
	const outputServer = createServer()
	try {
		await vi.advanceTimersByTimeAsync(500)
		await vi.waitFor(() => expect(decoder.getReconnectAttempts()).toBe(1))
		await vi.advanceTimersByTimeAsync(2000)
		await vi.waitFor(() => expect(decoder.getReconnectAttempts()).toBe(2))
		await vi.advanceTimersByTimeAsync(4000)
		await vi.waitFor(() => expect(decoder.getReconnectAttempts()).toBe(3))
		outputServer.listen(address.port, "127.0.0.1")
		await once(outputServer, "listening")
		await vi.advanceTimersByTimeAsync(8000)
		await vi.waitFor(() =>
			expect(decoder.isCurrentlyReconnecting()).toBe(false),
		)
		expect(decoder.getReconnectAttempts()).toBe(0)
	} finally {
		vi.useRealTimers()
		await decoder.stop()
		await new Promise<void>(resolve => outputServer.close(() => resolve()))
	}
})

it("rejects UDP bind failures instead of leaving the connection attempt pending", async () => {
	const occupied = createSocket("udp4")
	occupied.bind(0, "127.0.0.1")
	await once(occupied, "listening")
	const decoder = new Network(occupied.address().port, "udp")
	active.push(decoder)
	try {
		await expect(decoder.connectNow()).rejects.toThrow()
	} finally {
		decoder.disconnectNow()
		occupied.close()
	}
})

it.skipIf(process.platform === "win32")(
	"kills a TERM-resistant grandchild with its decoder process group",
	async () => {
		const decoder = new Consumer()
		active.push(decoder)
		decoder.program = `
 const {spawn} = require('node:child_process');
 process.on('SIGTERM', () => {});
 const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)']);
 child.stdout.once('data', () => console.log(child.pid));
 setInterval(()=>{},1000);
 `
		await decoder.start()
		const [data] = await once(
			(
				decoder as unknown as {
					process: ChildProcess
				}
			).process.stdout!,
			"data",
		)
		const childPid = Number(String(data).trim())
		expect(childPid).toBeGreaterThan(1)
		vi.useFakeTimers()
		const stopping = decoder.stop()
		await vi.advanceTimersByTimeAsync(5001)
		await stopping
		vi.useRealTimers()
		await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), {
			timeout: 2000,
		})
	},
)
