import { describe, expect, it } from "vitest"
import { Writable } from "node:stream"
import type { Socket } from "node:net"
import type { ServerResponse } from "node:http"
import { AudioOutput } from "../../../src/core/audio-output.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import {
	MAX_CLIENT_BUFFER_BYTES,
	iqClientBufferLimit,
} from "../../../src/core/client-buffer.js"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
type WriteCallback = (error?: Error | null) => void

// A stalled transport keeps Node's writable queue full until it resumes.
class ClientTransport extends Writable {
	readonly remoteAddress = "127.0.0.1"
	readonly remotePort = 12345
	readonly chunks: Buffer[] = []
	private pendingCallback: WriteCallback | undefined

	constructor(private stalled: boolean) {
		super({ highWaterMark: 64 * 1024 })
	}

	setNoDelay(): this {
		return this
	}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: WriteCallback,
	): void {
		this.chunks.push(Buffer.from(chunk))
		if (this.stalled) this.pendingCallback = callback
		else callback()
	}

	resumeWrites(): void {
		this.stalled = false
		const callback = this.pendingCallback
		this.pendingCallback = undefined
		callback?.()
	}
}

type TcpInternals = {
	handleClientConnection(socket: Socket): void
	distributeToClients(chunk: Buffer): void
}

function createOutput(kind: "audio" | "tuner" | "live") {
	const sources = new SourceManager(logger)
	const fanout = new FanoutManager(logger)
	if (kind === "live") {
		const output = new LiveDemodulator(
			logger,
			sources,
			fanout,
			LiveDemodConfigSchema.parse({ squelch: 0 }),
		)
		const internals = output as unknown as {
			clients: Map<
				string,
				{
					id: string
					response: ServerResponse
					remoteAddress: string
					connectedAt: Date
					bytesWritten: number
				}
			>
			handleAudioData(chunk: Buffer): void
		}
		return {
			output,
			connect(id: string, transport: ClientTransport) {
				internals.clients.set(id, {
					id,
					response: transport as unknown as ServerResponse,
					remoteAddress: "local",
					connectedAt: new Date(),
					bytesWritten: 0,
				})
			},
			write: (chunk: Buffer) => internals.handleAudioData(chunk),
			clientCount: () => output.getStatus().clientCount,
		}
	}
	const output =
		kind === "audio"
			? new AudioOutput(logger, { port: 0, format: "S16LE", sampleRate: 48000 })
			: new TunerRelay(logger, sources, fanout, {
					enabled: true,
					host: "127.0.0.1",
					port: 0,
					controlPolicy: "exclusive",
				})
	const internals = output as unknown as TcpInternals
	return {
		output,
		connect(_id: string, transport: ClientTransport) {
			internals.handleClientConnection(transport as unknown as Socket)
			// The tuner relay sends its protocol header before IQ samples.
			transport.chunks.length = 0
		},
		write: (chunk: Buffer) => internals.distributeToClients(chunk),
		clientCount: () =>
			output instanceof AudioOutput
				? output.getConnectedClients()
				: output.getStatus().clientsConnected,
	}
}

describe.each(["audio", "tuner", "live"] as const)(
	"%s output backpressure",
	kind => {
		it("disconnects a stalled client while delivering every byte to a healthy client", async () => {
			const output = createOutput(kind)
			const slow = new ClientTransport(true)
			const healthy = new ClientTransport(false)
			const disconnected: string[] = []
			output.output.on("client-disconnected", id => disconnected.push(id))
			output.connect("slow", slow)
			output.connect("healthy", healthy)
			const expected: Buffer[] = []
			try {
				for (let index = 0; index < (kind === "tuner" ? 160 : 32); index++) {
					const chunk = Buffer.alloc(64 * 1024, index)
					expected.push(chunk)
					output.write(chunk)
					expect(slow.writableLength).toBeLessThanOrEqual(
						kind === "tuner" ? iqClientBufferLimit() : MAX_CLIENT_BUFFER_BYTES,
					)
				}
				expect(slow.destroyed).toBe(true)
				expect(healthy.destroyed).toBe(false)
				expect(output.clientCount()).toBe(1)
				if (output.output instanceof TunerRelay) {
					expect(output.output.getStatus().controlClientId).toBe("client-2")
				}
				expect(
					Buffer.concat(healthy.chunks).equals(Buffer.concat(expected)),
				).toBe(true)
				await new Promise<void>(resolve => setImmediate(resolve))
				expect(disconnected).toHaveLength(1)
			} finally {
				slow.destroy()
				healthy.destroy()
			}
		})

		it("allows a brief stall to recover without dropping stream bytes", () => {
			const output = createOutput(kind)
			const client = new ClientTransport(true)
			output.connect("client", client)
			try {
				const chunks = [Buffer.alloc(64 * 1024, 1), Buffer.alloc(64 * 1024, 2)]
				for (const chunk of chunks) output.write(chunk)
				expect(client.writableNeedDrain).toBe(true)
				expect(client.destroyed).toBe(false)
				client.resumeWrites()
				const last = Buffer.alloc(64 * 1024, 3)
				output.write(last)
				// A stalled tuner header is delivered before the IQ chunks.
				const delivered = Buffer.concat(client.chunks)
				const expected = Buffer.concat([...chunks, last])
				expect(
					delivered
						.subarray(delivered.length - expected.length)
						.equals(expected),
				).toBe(true)
				expect(output.clientCount()).toBe(1)
			} finally {
				client.destroy()
			}
		})
	},
)

it("allows a tuner client to initialize for one second of IQ before reading", () => {
	const output = createOutput("tuner")
	const client = new ClientTransport(true)
	output.connect("client", client)
	try {
		for (let n = 0; n < 64; n++) output.write(Buffer.alloc(65536, n))
		expect(client.destroyed).toBe(false)
		client.resumeWrites()
		expect(client.writableLength).toBe(0)
		expect(output.clientCount()).toBe(1)
	} finally {
		client.destroy()
	}
})
