import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import Fastify from "fastify"
import { toApiDecoderStatus } from "../../../src/api/serializers/decoder-status.js"
import { decoderRoutes } from "../../../src/api/routes/decoders.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import pino from "pino"
import { NetworkProducerDecoder } from "../../../src/decoders/network-producer-decoder.js"
import { ExternalSdrDecoder } from "../../../src/decoders/external-sdr-decoder.js"
import { DecoderObservability } from "../../../src/decoders/decoder-observability.js"
import { BaseDecoder } from "../../../src/decoders/base-decoder.js"
import type { DecoderCaps, DecoderOutput } from "../../../src/decoders/types.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

class ObservedDecoder extends BaseDecoder {
	protected getCommand(): string {
		return "unused"
	}
	protected getArgs(): string[] {
		return []
	}
	protected getCaps(): DecoderCaps {
		return {
			input: "external",
			output: "text",
			integrationPattern: "external_sdr",
		}
	}
	protected parseOutput(): DecoderOutput | null {
		return null
	}
	disableParsing(): void {
		this.parseStdout = false
		this.parseStderr = false
	}
	publish(): void {
		this.emitOutput({
			type: "message",
			decoder: this.id,
			timestamp: new Date(),
			data: {},
		})
	}
}

describe("decoder observability", () => {
	it("counts output in fifteen wall-clock minute buckets, fills gaps and expires old output", () => {
		let now = 20 * 60_000
		const decoder = new ObservedDecoder(
			{ id: "test", type: "test", enabled: false, options: {} },
			pino({ level: "silent" }),
			() => now,
		)
		decoder.publish()
		decoder.publish()
		expect(decoder.getStatus().rateHistory).toEqual([
			...Array<number>(14).fill(0),
			2,
		])
		expect(toApiDecoderStatus(decoder.getStatus()).rateHistory).toEqual(
			decoder.getStatus().rateHistory,
		)
		now += 2 * 60_000
		expect(decoder.getStatus().rateHistory).toEqual([
			...Array<number>(12).fill(0),
			2,
			0,
			0,
		])
		now += 15 * 60_000
		expect(decoder.getStatus().rateHistory).toEqual(Array<number>(15).fill(0))
	})
})

it("retains bounded raw stdout/stderr even when parsing is disabled", async () => {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		pid: 123,
	})
	vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
	const decoder = new ObservedDecoder(
		{ id: "test", type: "test", enabled: false, options: {} },
		pino({ level: "silent" }),
	)
	decoder.disableParsing()
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	const started = decoder.start()
	child.emit("spawn")
	await started
	vi.clearAllTimers()
	vi.useRealTimers()
	child.stdout.write(
		Array.from({ length: 510 }, (_, i) => `line${i}\n`).join(""),
	)
	child.stderr.write("x".repeat(10_000))
	child.stderr.write("\nerror\n")
	expect(decoder.getLog(500)).toHaveLength(500)
	expect(decoder.getLog(1)).toEqual([{ stream: "stderr", line: "error" }])
	expect(decoder.getLog(2)[0]?.line).toHaveLength(4096)
	const copy = decoder.getLog(1)
	copy[0]!.line = "changed"
	expect(decoder.getLog(1)[0]?.line).toBe("error")
})

it("serves raw logs with default and bounded lines and unknown decoder 404", async () => {
	const getLog = vi.fn(() => [{ stream: "stderr", line: "raw" }])
	const manager = {
		getDecoder: (id: string) => (id === "test" ? { id, getLog } : undefined),
	}
	const app = Fastify()
	await app.register(decoderRoutes, {
		decoderManager: manager as unknown as DecoderManager,
	})
	try {
		const response = await app.inject("/api/decoders/test/log")
		expect(response.statusCode).toBe(200)
		expect(response.json()).toEqual({
			decoderId: "test",
			lines: [{ stream: "stderr", line: "raw" }],
		})
		expect(getLog).toHaveBeenCalledWith(200)
		for (const lines of ["1", "500"])
			expect(
				(await app.inject(`/api/decoders/test/log?lines=${lines}`)).statusCode,
			).toBe(200)
		for (const lines of ["0", "501", "1.5", "invalid"])
			expect(
				(await app.inject(`/api/decoders/test/log?lines=${lines}`)).statusCode,
			).toBe(400)
		expect((await app.inject("/api/decoders/missing/log")).statusCode).toBe(404)
	} finally {
		await app.close()
	}
})

class ObservedNetworkDecoder extends NetworkProducerDecoder {
	protected getCommand(): string {
		return "unused"
	}
	protected getArgs(): string[] {
		return []
	}
	protected getCaps(): DecoderCaps {
		return {
			input: "external",
			output: "text",
			integrationPattern: "network_producer",
		}
	}
	protected parseNetworkData(): DecoderOutput[] {
		return [
			{ type: "message", decoder: this.id, timestamp: new Date(), data: {} },
		]
	}
}
class ObservedExternalDecoder extends ExternalSdrDecoder {
	protected getCommand(): string {
		return "unused"
	}
	protected getArgs(): string[] {
		return []
	}
	protected getCaps(): DecoderCaps {
		return {
			input: "external",
			output: "text",
			integrationPattern: "external_sdr",
		}
	}
	protected parseOutput(): DecoderOutput {
		return {
			type: "message",
			decoder: this.id,
			timestamp: new Date(),
			data: {},
		}
	}
}

it("counts network messages without inventing process logs", () => {
	let now = 60_000
	const decoder = new ObservedNetworkDecoder(
		{
			id: "network",
			type: "test",
			enabled: false,
			options: {},
			outputHost: "unused",
			outputPort: 0,
			outputProtocol: "tcp",
		},
		pino({ level: "silent" }),
		() => now,
	)
	// Exercise the network input boundary without opening a socket.
	const input = decoder as unknown as { handleNetworkData(data: Buffer): void }
	input.handleNetworkData(Buffer.from("frame"))
	expect(decoder.getStatus().rateHistory?.at(-1)).toBe(1)
	expect(decoder.getStatus().stats.eventsOut).toBe(1)
	expect(decoder.getLog()).toEqual([])
	now += 60_000
	input.handleNetworkData(Buffer.from("frame"))
	expect(decoder.getStatus().rateHistory?.slice(-2)).toEqual([1, 1])
})

it.each(["network", "external"])(
	"captures %s process streams with bounded logs",
	async kind => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			stdin: new PassThrough(),
			pid: 123,
		})
		vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess)
		const config = { id: kind, type: "test", enabled: false, options: {} }
		const logger = pino({ level: "silent" })
		const decoder =
			kind === "network"
				? new ObservedNetworkDecoder(
						{
							...config,
							outputHost: "unused",
							outputPort: 0,
							outputProtocol: "tcp",
						},
						logger,
						() => 60_000,
					)
				: new ObservedExternalDecoder(
						{ ...config, deviceSerial: "test", frequencies: [] },
						logger,
						() => 60_000,
					)
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const started = decoder.start()
		child.emit("spawn")
		await started
		vi.clearAllTimers()
		vi.useRealTimers()
		child.stdout.write("stdout\\n".replace("\\n", "\n"))
		child.stderr.write("stderr\n")
		expect(decoder.getLog()).toEqual([
			{ stream: "stdout", line: "stdout" },
			{ stream: "stderr", line: "stderr" },
		])
		if (kind === "external") {
			expect(decoder.getStatus().stats.eventsOut).toBe(2)
			expect(decoder.getStatus().rateHistory?.at(-1)).toBe(2)
		}
		child.stdout.write("x".repeat(10_000) + "\n")
		expect(decoder.getLog(1)[0]?.line).toHaveLength(4096)
	},
)

it("preserves split UTF8/CRLF and flushes a bounded partial line at EOF", async () => {
	const observations = new DecoderObservability()
	const stream = new PassThrough()
	observations.captureLog(stream, "stderr")
	const bytes = Buffer.from("é\r\n")
	stream.write(bytes.subarray(0, 1))
	stream.write(bytes.subarray(1))
	stream.end("tail")
	await new Promise<void>(resolve => stream.on("end", resolve))
	expect(observations.getLog()).toEqual([
		{ stream: "stderr", line: "é" },
		{ stream: "stderr", line: "tail" },
	])
})
