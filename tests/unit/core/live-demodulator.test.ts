/**
 * Live Demodulator Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import { createLogger } from "../../../src/utils/logger.js"
import type {
	LiveDemodConfig,
	LiveDemodulator as LiveDemodulatorType,
} from "../../../src/core/live-demodulator.js"

vi.mock("node:child_process", () => {
	return {
		spawn: vi.fn(),
	}
})

import { spawn } from "node:child_process"

const testLogger = createLogger({ level: "fatal" })

class MockChildProcess extends EventEmitter {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	killed = false

	kill(signal?: NodeJS.Signals): boolean {
		this.killed = true
		setTimeout(() => {
			this.emit("exit", 0, signal ?? "SIGTERM")
		}, 0)
		return true
	}
}

function createMockFanoutManager() {
	const branch = new PassThrough()
	return {
		addBranch: vi.fn().mockReturnValue(branch),
		removeBranch: vi.fn(),
	}
}

function createMockSourceManager() {
	return {
		getAllStatus: vi.fn().mockReturnValue([
			{
				id: "rtl-pi",
				connected: true,
			},
		]),
		getStatus: vi.fn().mockReturnValue({
			id: "rtl-pi",
			connected: true,
		}),
		getCaps: vi.fn().mockReturnValue({
			kind: "iq",
			sampleRate: 2_400_000,
			format: "U8_IQ",
		}),
	}
}

async function findAvailablePort(startPort: number): Promise<number> {
	return new Promise(resolve => {
		const server = http.createServer()
		server.unref()
		server.on("error", () => {
			resolve(findAvailablePort(startPort + 1))
		})
		server.listen(startPort, "127.0.0.1", () => {
			const address = server.address()
			const port =
				typeof address === "object" && address ? address.port : startPort
			server.close(() => resolve(port))
		})
	})
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 1000,
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (condition()) return
		await delay(10)
	}
	throw new Error("Timed out waiting for condition")
}

describe("LiveDemodulator", () => {
	let LiveDemodulatorClass: new (...args: any[]) => LiveDemodulatorType
	let liveDemod: LiveDemodulatorType
	let mockProcess: MockChildProcess | null = null
	let port: number

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: any[]
		) => LiveDemodulatorType
		port = await findAvailablePort(19000)
		const fanoutManager = createMockFanoutManager()
		const sourceManager = createMockSourceManager()

		;(spawn as unknown as { mockImplementation: Function }).mockImplementation(
			() => {
				mockProcess = new MockChildProcess()
				return mockProcess as unknown as ChildProcess
			},
		)

		const config: LiveDemodConfig = {
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: port,
			modulation: "nfm",
			bandwidth: 12500,
			squelch: 0,
			noiseReduction: "off",
			lowPass: 0,
			highPass: 0,
			gain: 10,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: true,
		}

		liveDemod = new LiveDemodulatorClass(
			testLogger,
			sourceManager as any,
			fanoutManager as any,
			config,
		)
	})

	afterEach(async () => {
		try {
			await liveDemod.stop()
		} catch {
			// Ignore cleanup errors
		}
		mockProcess = null
		;(spawn as unknown as { mockReset: Function }).mockReset()
	})

	it("starts HTTP server and streams audio to clients", async () => {
		await liveDemod.start()
		const chunks: Buffer[] = []
		const response = new PassThrough()
		response.on("data", chunk => chunks.push(Buffer.from(chunk)))
		;(
			liveDemod as unknown as {
				clients: Map<
					string,
					{
						id: string
						response: http.ServerResponse
						remoteAddress: string
						connectedAt: Date
						bytesWritten: number
					}
				>
			}
		).clients.set("client-1", {
			id: "client-1",
			response: response as unknown as http.ServerResponse,
			remoteAddress: "local",
			connectedAt: new Date(),
			bytesWritten: 0,
		})

		const payload = Buffer.from(Int16Array.from([100, -100]).buffer)
		;(
			liveDemod as unknown as { handleAudioData: (chunk: Buffer) => void }
		).handleAudioData(payload)

		await waitFor(() => chunks.length > 0)

		const writtenBuffer = Buffer.concat(chunks)
		expect(writtenBuffer.length).toBe(payload.length)
		expect(writtenBuffer.equals(payload)).toBe(true)
		expect(liveDemod.getStatus().bytesStreamed).toBeGreaterThan(0)
		expect(liveDemod.getStatus().clientCount).toBe(1)
	})

	it("applies squelch when configured", async () => {
		await liveDemod.reconfigure({ squelch: -20 })
		await liveDemod.start()
		const chunks: Buffer[] = []
		const response = new PassThrough()
		response.on("data", chunk => chunks.push(Buffer.from(chunk)))
		;(
			liveDemod as unknown as {
				clients: Map<
					string,
					{
						id: string
						response: http.ServerResponse
						remoteAddress: string
						connectedAt: Date
						bytesWritten: number
					}
				>
			}
		).clients.set("client-1", {
			id: "client-1",
			response: response as unknown as http.ServerResponse,
			remoteAddress: "local",
			connectedAt: new Date(),
			bytesWritten: 0,
		})

		const payload = Buffer.from(Int16Array.from([100, 100, 100]).buffer)
		;(
			liveDemod as unknown as { handleAudioData: (chunk: Buffer) => void }
		).handleAudioData(payload)

		await waitFor(() => chunks.length > 0)

		const writtenBuffer = Buffer.concat(chunks)
		expect(writtenBuffer.equals(Buffer.alloc(payload.length))).toBe(true)
		expect(liveDemod.getStatus().clientCount).toBe(1)
	})

	it("restarts pipeline on reconfigure when running", async () => {
		await liveDemod.start()
		expect(
			(spawn as unknown as { mock: { calls: unknown[] } }).mock.calls,
		).toHaveLength(1)

		await liveDemod.reconfigure({ gain: 5 })
		expect(
			(spawn as unknown as { mock: { calls: unknown[] } }).mock.calls,
		).toHaveLength(2)
	})

	it("calculates effective sample rate from bandwidth", () => {
		const status = liveDemod.getStatus()
		expect(status.decimationFactor).toBe(96)
		expect(Math.round(status.effectiveSampleRate)).toBe(25000)
	})
})
