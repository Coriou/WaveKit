/**
 * Base Decoder Property-Based Tests
 *
 * Tests for decoder status completeness.
 * Requirements: 4.5
 */

import { describe, it, expect, vi } from "vitest"
import * as fc from "fast-check"
import { EventEmitter } from "node:events"
import { PassThrough, type Readable } from "node:stream"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import type {
	Decoder,
	DecoderCaps,
	DecoderConfig,
	DecoderHealth,
	DecoderOutput,
	DecoderStatus,
} from "../../../src/decoders/types.js"
import {
	abandonDecoderOutput,
	BaseDecoder,
	decoderOutputDrained,
} from "../../../src/decoders/base-decoder.js"
import pino from "pino"

// Only the drain test spawns; its child is a fake and nothing is executed.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }))
vi.mock("../../../src/decoders/process-tools.js", () => ({
	signalDecoder: vi.fn(),
}))

// Create a silent logger for tests
const testLogger = pino({ level: "silent" })

/**
 * Concrete implementation of BaseDecoder for testing.
 * Since BaseDecoder is abstract, we need a concrete implementation.
 */
class TestDecoder extends EventEmitter implements Decoder {
	readonly id: string
	readonly type: string
	readonly caps: DecoderCaps = {
		input: "audio_pcm",
		wantsExclusiveSource: false,
		preferredSampleRates: [48000],
		output: "text",
		integrationPattern: "pure_consumer",
	}
	private outputStream = new PassThrough({ objectMode: true })
	private _running = false
	private _pid: number | undefined
	private _startTime = 0
	private _stats = { bytesIn: 0, eventsOut: 0, errors: 0 }
	private _health: DecoderHealth = "running"
	private _restartCount = 0

	constructor(config: DecoderConfig) {
		super()
		this.id = config.id
		this.type = config.type
	}

	async start(): Promise<void> {
		this._running = true
		this._pid = Math.floor(Math.random() * 65535) + 1
		this._startTime = Date.now()
		this.emit("started")
	}

	async stop(): Promise<void> {
		this._running = false
		this._pid = undefined
		this.emit("stopped")
	}

	async restart(): Promise<void> {
		await this.stop()
		await this.start()
	}

	attachInput(_stream: Readable): void {
		// No-op for test
	}

	detachInput(): void {
		// No-op for test
	}

	getOutput(): Readable {
		return this.outputStream
	}

	getAudioOutput(): Readable | null {
		return null
	}

	// Simulate receiving bytes
	simulateBytesIn(bytes: number): void {
		this._stats.bytesIn += bytes
	}

	// Simulate emitting events
	simulateEventsOut(count: number): void {
		this._stats.eventsOut += count
	}

	// Simulate errors
	simulateErrors(count: number): void {
		this._stats.errors += count
	}

	getHealth(): DecoderHealth {
		return this._health
	}

	updateOptions(_updates: Record<string, unknown>): void {
		// No-op for test
	}

	getStatus(): DecoderStatus {
		const uptime = this._running
			? Math.floor((Date.now() - this._startTime) / 1000)
			: 0

		return {
			id: this.id,
			type: this.type,
			running: this._running,
			health: this._health,
			pid: this._pid,
			uptime,
			stats: { ...this._stats },
			lastOutputAt: undefined,
			restartCount: this._restartCount,
			version: undefined,
		}
	}
}

/**
 * Arbitrary for generating valid decoder IDs.
 */
const decoderIdArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid decoder types.
 */
const decoderTypeArb = fc
	.string({ minLength: 1, maxLength: 50 })
	.filter(s => s.trim().length > 0 && !s.includes(" "))

/**
 * Arbitrary for generating valid decoder configs.
 */
const decoderConfigArb = fc.record({
	id: decoderIdArb,
	type: decoderTypeArb,
	enabled: fc.boolean(),
	options: fc.constant({} as Record<string, unknown>),
})

/**
 * Arbitrary for generating non-negative integers for stats.
 */
const statsValueArb = fc.nat({ max: 1000000 })

describe("Property-Based Tests", () => {
	/**
	 * Feature: wavekit-core, Property 10: Decoder Status Completeness
	 * Validates: Requirements 4.5
	 *
	 * For any decoder managed by Decoder_Manager, calling getStatus(id) should
	 * return an object containing all required fields: id, type, running, uptime,
	 * and stats (with bytesIn, eventsOut, errors).
	 */
	describe("Property 10: Decoder Status Completeness", () => {
		it("should return status with all required fields for any decoder config", () => {
			fc.assert(
				fc.property(decoderConfigArb, config => {
					const decoder = new TestDecoder(config)
					const status = decoder.getStatus()

					// Verify all required fields exist
					expect(status).toHaveProperty("id")
					expect(status).toHaveProperty("type")
					expect(status).toHaveProperty("running")
					expect(status).toHaveProperty("uptime")
					expect(status).toHaveProperty("stats")

					// Verify stats has all required sub-fields
					expect(status.stats).toHaveProperty("bytesIn")
					expect(status.stats).toHaveProperty("eventsOut")
					expect(status.stats).toHaveProperty("errors")

					// Verify field types
					expect(typeof status.id).toBe("string")
					expect(typeof status.type).toBe("string")
					expect(typeof status.running).toBe("boolean")
					expect(typeof status.uptime).toBe("number")
					expect(typeof status.stats.bytesIn).toBe("number")
					expect(typeof status.stats.eventsOut).toBe("number")
					expect(typeof status.stats.errors).toBe("number")

					// Verify id and type match config
					return status.id === config.id && status.type === config.type
				}),
				{ numRuns: 100 },
			)
		})

		it("should return correct running state and uptime when not started", () => {
			fc.assert(
				fc.property(decoderConfigArb, config => {
					const decoder = new TestDecoder(config)
					const status = decoder.getStatus()

					// When not started, running should be false and uptime should be 0
					return status.running === false && status.uptime === 0
				}),
				{ numRuns: 100 },
			)
		})

		it("should return correct running state when started", async () => {
			await fc.assert(
				fc.asyncProperty(decoderConfigArb, async config => {
					const decoder = new TestDecoder(config)
					await decoder.start()
					const status = decoder.getStatus()

					// When started, running should be true and pid should be defined
					return (
						status.running === true &&
						status.pid !== undefined &&
						typeof status.pid === "number"
					)
				}),
				{ numRuns: 100 },
			)
		})

		it("should track stats correctly for any combination of values", () => {
			fc.assert(
				fc.property(
					decoderConfigArb,
					statsValueArb,
					statsValueArb,
					statsValueArb,
					(config, bytesIn, eventsOut, errors) => {
						const decoder = new TestDecoder(config)

						// Simulate activity
						decoder.simulateBytesIn(bytesIn)
						decoder.simulateEventsOut(eventsOut)
						decoder.simulateErrors(errors)

						const status = decoder.getStatus()

						// Verify stats match simulated values
						return (
							status.stats.bytesIn === bytesIn &&
							status.stats.eventsOut === eventsOut &&
							status.stats.errors === errors
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return non-negative values for all numeric fields", () => {
			fc.assert(
				fc.property(
					decoderConfigArb,
					statsValueArb,
					statsValueArb,
					statsValueArb,
					(config, bytesIn, eventsOut, errors) => {
						const decoder = new TestDecoder(config)

						decoder.simulateBytesIn(bytesIn)
						decoder.simulateEventsOut(eventsOut)
						decoder.simulateErrors(errors)

						const status = decoder.getStatus()

						// All numeric fields should be non-negative
						return (
							status.uptime >= 0 &&
							status.stats.bytesIn >= 0 &&
							status.stats.eventsOut >= 0 &&
							status.stats.errors >= 0
						)
					},
				),
				{ numRuns: 100 },
			)
		})

		it("should return status with pid undefined when not running", () => {
			fc.assert(
				fc.property(decoderConfigArb, config => {
					const decoder = new TestDecoder(config)
					const status = decoder.getStatus()

					// When not running, pid should be undefined
					return status.running === false && status.pid === undefined
				}),
				{ numRuns: 100 },
			)
		})
	})
})

/** A BaseDecoder that records every line it parses. */
class LineDecoder extends BaseDecoder {
	readonly lines: string[] = []
	protected getCommand(): string {
		return "unused"
	}
	protected getArgs(): string[] {
		return []
	}
	protected getCaps(): DecoderCaps {
		return {
			input: "audio_pcm",
			wantsExclusiveSource: false,
			preferredSampleRates: [48000],
			output: "text",
			integrationPattern: "pure_consumer",
		}
	}
	protected parseOutput(line: string): DecoderOutput | null {
		this.lines.push(line)
		return null
	}
}

/** A child that reports `spawn` at once and exits only when the test says; its streams end separately. */
function fakeChild() {
	return Object.assign(new EventEmitter(), {
		pid: 7,
		stdin: null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
		killed: false,
	})
}

describe("output drain", () => {
	it("settles after the exited child's last lines are parsed, not at its exit; each run has its own", async () => {
		const decoder = new LineDecoder(
			{ id: "drain", type: "test", enabled: true, options: {} },
			testLogger,
		)
		// Nothing was spawned: settled at once, as for a decoder that is not a BaseDecoder.
		await decoder.outputDrained()
		await decoderOutputDrained(
			new TestDecoder({ id: "x", type: "x", enabled: true, options: {} }),
		)

		const child = fakeChild()
		vi.mocked(spawn).mockImplementationOnce(() => {
			queueMicrotask(() => child.emit("spawn"))
			return child as unknown as ChildProcess
		})
		await decoder.start()
		const drained = decoderOutputDrained(decoder)
		let settled = false
		void drained.then(() => {
			settled = true
		})
		const order: string[] = []
		decoder.on("exit", () => order.push("exit"))
		child.emit("exit", 0, null)
		child.stdout.write("first\n")
		child.stderr.write("second\nlast without newline")
		await new Promise(resolve => setImmediate(resolve))
		expect(order).toEqual(["exit"])
		expect(decoder.lines).toEqual(["first", "second"])
		expect(settled).toBe(false)
		child.stderr.end()
		await new Promise(resolve => setImmediate(resolve))
		// One stream is still open.
		expect(settled).toBe(false)
		child.stdout.end()
		await drained
		expect(decoder.lines).toEqual(["first", "second", "last without newline"])

		// A new run gets a new drain; a stream destroyed without ending settles it too.
		const next = fakeChild()
		vi.mocked(spawn).mockImplementationOnce(() => {
			queueMicrotask(() => next.emit("spawn"))
			return next as unknown as ChildProcess
		})
		await decoder.start()
		const nextDrained = decoder.outputDrained()
		expect(nextDrained).not.toBe(drained)
		let nextSettled = false
		void nextDrained.then(() => {
			nextSettled = true
		})
		next.emit("exit", 0, null)
		next.stdout.end()
		await new Promise(resolve => setImmediate(resolve))
		expect(nextSettled).toBe(false)
		next.stderr.destroy()
		await nextDrained
	})

	it("abandoned: an output that never ends is closed, its drain settles and no later line is parsed", async () => {
		const decoder = new LineDecoder(
			{ id: "abandon", type: "test", enabled: true, options: {} },
			testLogger,
		)
		// Nothing spawned, or not a BaseDecoder: nothing to do.
		decoder.abandonOutput()
		abandonDecoderOutput(
			new TestDecoder({ id: "x", type: "x", enabled: true, options: {} }),
		)
		const child = fakeChild()
		vi.mocked(spawn).mockImplementationOnce(() => {
			queueMicrotask(() => child.emit("spawn"))
			return child as unknown as ChildProcess
		})
		await decoder.start()
		const drained = decoder.outputDrained()
		let settled = false
		void drained.then(() => {
			settled = true
		})
		child.emit("exit", 0, null)
		child.stdout.write("before\n")
		await new Promise(resolve => setImmediate(resolve))
		expect(settled).toBe(false)
		abandonDecoderOutput(decoder)
		await drained
		expect(child.stdout.destroyed).toBe(true)
		expect(child.stderr.destroyed).toBe(true)
		child.stderr.write("after\n")
		await new Promise(resolve => setImmediate(resolve))
		expect(decoder.lines).toEqual(["before"])
		// Idempotent.
		decoder.abandonOutput()
	})
})

describe("stop: SIGKILL after stopKillAfterMs", () => {
	it.each([
		[5_000, undefined],
		[1_000, 1_000],
	])(
		"sends SIGKILL at %i ms, not 1 ms before (stopKillAfterMs %s)",
		async (killAt, set) => {
			const { signalDecoder } =
				await import("../../../src/decoders/process-tools.js")
			const signals = vi.mocked(signalDecoder)
			signals.mockClear()
			const decoder = new LineDecoder(
				{ id: "kill", type: "test", enabled: true, options: {} },
				testLogger,
			)
			if (set !== undefined) decoder.stopKillAfterMs = set
			const child = fakeChild()
			vi.mocked(spawn).mockImplementationOnce(() => {
				queueMicrotask(() => child.emit("spawn"))
				return child as unknown as ChildProcess
			})
			await decoder.start()
			vi.useFakeTimers()
			try {
				// The child ignores SIGTERM.
				const stopped = decoder.stop()
				expect(signals.mock.calls.map(c => c[1])).toEqual(["SIGTERM"])
				await vi.advanceTimersByTimeAsync(killAt - 1)
				expect(signals.mock.calls.map(c => c[1])).toEqual(["SIGTERM"])
				await vi.advanceTimersByTimeAsync(1)
				expect(signals.mock.calls.map(c => c[1])).toEqual([
					"SIGTERM",
					"SIGKILL",
				])
				child.emit("exit", null, "SIGKILL")
				await stopped
			} finally {
				vi.useRealTimers()
			}
		},
	)
})

describe("stop: shortenStopKill on a pending stop", () => {
	it.each([
		// [ms after SIGTERM when shortened, SIGKILL due]; 3 s: due 1 s passed, at once
		[200, 1_000],
		[1_000, 1_000],
		[3_000, 3_000],
	])(
		"shortened %i ms after SIGTERM: SIGKILL at %i ms, not 1 ms before; never later than the armed 5 s",
		async (shortenAt, killAt) => {
			const { signalDecoder } =
				await import("../../../src/decoders/process-tools.js")
			const { resetDecoderStopKill, shortenDecoderStopKill } =
				await import("../../../src/decoders/base-decoder.js")
			const signals = vi.mocked(signalDecoder)
			signals.mockClear()
			const decoder = new LineDecoder(
				{ id: "kill-pending", type: "test", enabled: true, options: {} },
				testLogger,
			)
			const child = fakeChild()
			vi.mocked(spawn).mockImplementationOnce(() => {
				queueMicrotask(() => child.emit("spawn"))
				return child as unknown as ChildProcess
			})
			await decoder.start()
			vi.useFakeTimers()
			try {
				const stopped = decoder.stop()
				await vi.advanceTimersByTimeAsync(shortenAt)
				shortenDecoderStopKill(decoder, 1_000)
				// A longer value never delays the pending kill.
				decoder.shortenStopKill(4_000)
				shortenDecoderStopKill(decoder, 1_000)
				expect(signals.mock.calls.map(c => c[1])).toEqual(["SIGTERM"])
				// Past due already: SIGKILL at once.
				if (killAt > shortenAt) {
					await vi.advanceTimersByTimeAsync(killAt - shortenAt - 1)
					expect(signals.mock.calls.map(c => c[1])).toEqual(["SIGTERM"])
				}
				await vi.advanceTimersByTimeAsync(killAt > shortenAt ? 1 : 0)
				expect(signals.mock.calls.map(c => c[1])).toEqual([
					"SIGTERM",
					"SIGKILL",
				])
				child.emit("exit", null, "SIGKILL")
				await stopped
				expect(decoder.stopKillAfterMs).toBe(1_000)
				resetDecoderStopKill(decoder)
				expect(decoder.stopKillAfterMs).toBe(5_000)
			} finally {
				vi.useRealTimers()
			}
		},
	)
})
