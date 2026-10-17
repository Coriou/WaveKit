/**
 * Live Demodulator auto-squelch floor re-seed after retune (WG9 req 5.6)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { MockInstance } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import { createLogger } from "../../../src/utils/logger.js"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const testLogger = createLogger({ level: "fatal" })
let nextPid = 5_000_000

class MockChildProcess extends EventEmitter {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	pid = ++nextPid
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
	}
}

let processes: MockChildProcess[] = []
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

function createMockSourceManager() {
	const emitter = new EventEmitter()
	const caps = { kind: "iq", sampleRate: 2_400_000, format: "U8_IQ" as const }
	return {
		getAllStatus: vi.fn().mockReturnValue([{ id: "rtl-pi", connected: true }]),
		getStatus: vi.fn().mockReturnValue({ id: "rtl-pi", connected: true }),
		getCaps: vi.fn(() => ({ ...caps })),
		on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			emitter.on(event, listener)
			return emitter
		}),
		off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
			emitter.off(event, listener)
			return emitter
		}),
		emitCaps(centerFreq: number) {
			emitter.emit("caps-changed", "rtl-pi", { ...caps, centerFreq })
		},
	}
}

async function findAvailablePort(): Promise<number> {
	for (;;) {
		const candidate = 20_000 + Math.floor(Math.random() * 25_000)
		const free = await new Promise<boolean>(resolve => {
			const server = http.createServer()
			server.once("error", () => resolve(false))
			server.listen(candidate, "0.0.0.0", () =>
				server.close(() => resolve(true)),
			)
		})
		if (free) return candidate
	}
}

describe("LiveDemodulator auto floor re-seed after retune (WG9 5.6)", () => {
	let liveDemod: LiveDemodulatorType
	let sourceManager: ReturnType<typeof createMockSourceManager>
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		const LiveDemodulator = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		sourceManager = createMockSourceManager()
		processes = []
		spawnMock.mockImplementation(() => {
			const proc = new MockChildProcess()
			processes.push(proc)
			return proc as unknown as ChildProcess
		})
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const proc = processes.find(p => p.pid === Math.abs(pid))
				if (!proc) {
					const err = new Error("ESRCH") as NodeJS.ErrnoException
					err.code = "ESRCH"
					throw err
				}
				setTimeout(
					() => proc.exit(null, (signal ?? "SIGTERM") as NodeJS.Signals),
					0,
				)
				return true
			})
		const config = LiveDemodConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: await findAvailablePort(),
		})
		liveDemod = new LiveDemodulator(
			testLogger,
			sourceManager,
			{
				addBranch: vi.fn().mockReturnValue(new PassThrough()),
				removeBranch: vi.fn(),
			},
			config,
			{},
		)
		await liveDemod.start()
		await liveDemod.reconfigure({ squelchMode: "auto", autoMarginDb: 6 })
	})

	afterEach(async () => {
		try {
			await liveDemod.stop()
		} catch {
			// Ignore cleanup errors
		}
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	/** Feeds 10 ms channel blocks of constant power (stream time, not wall time). */
	async function feedPower(dbfs: number, blocks: number): Promise<void> {
		const block = Buffer.alloc(250 * 8)
		for (let i = 0; i < 250; i++) block.writeFloatLE(10 ** (dbfs / 20), i * 8)
		processes[1]!.stdin.resume()
		for (let i = 0; i < blocks; i++) {
			await new Promise<void>(resolve =>
				processes[0]!.stdout.write(block, () => resolve()),
			)
		}
	}

	it("cold start golden: the first block seeds the floor, so a carrier present from the start stays closed", async () => {
		await feedPower(-60, 10)
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-60)
		expect(liveDemod.isSquelchOpen()).toBe(false)
	})

	it("opens within the usual one-block attack on a retune onto an active carrier", async () => {
		await feedPower(-80, 100)
		expect(liveDemod.isSquelchOpen()).toBe(false)
		sourceManager.emitCaps(101_000_000)
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeUndefined()
		await feedPower(-60, 1)
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-80)
		expect(liveDemod.isSquelchOpen()).toBe(true)
		// The carrier holds for its whole transmission.
		await feedPower(-60, 500)
		expect(liveDemod.isSquelchOpen()).toBe(true)
	})

	it("stays closed on a retune onto noise at the same level", async () => {
		await feedPower(-80, 100)
		sourceManager.emitCaps(101_000_000)
		await feedPower(-80, 100)
		expect(liveDemod.isSquelchOpen()).toBe(false)
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-80)
	})

	it("seeds from the new power when it is below the previous floor", async () => {
		await feedPower(-70, 100)
		sourceManager.emitCaps(101_000_000)
		await feedPower(-85, 200)
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-85, 0)
		expect(liveDemod.isSquelchOpen()).toBe(false)
	})

	it("consumes the remembered floor once: a later mode reset seeds from power alone", async () => {
		await feedPower(-80, 100)
		sourceManager.emitCaps(101_000_000)
		await feedPower(-60, 1)
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-80)
		await liveDemod.reconfigure({ squelchMode: "manual", squelch: -50 })
		await liveDemod.reconfigure({ squelchMode: "auto" })
		await feedPower(-60, 1)
		// The block power is smoothed, so it reads a little under -60; well above
		// the consumed -80 floor.
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeGreaterThan(-75)
	})

	it("keeps the first remembered floor across two retunes before any block", async () => {
		await feedPower(-80, 100)
		sourceManager.emitCaps(101_000_000)
		sourceManager.emitCaps(102_000_000)
		await feedPower(-60, 1)
		expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-80)
		expect(liveDemod.isSquelchOpen()).toBe(true)
	})

	it("state analysis: a retune onto a 10 dB noisier band opens on noise until the floor catches up", async () => {
		await feedPower(-80, 100)
		sourceManager.emitCaps(101_000_000)
		await feedPower(-70, 1)
		expect(liveDemod.isSquelchOpen()).toBe(true)
		let openBlocks = 1
		while (liveDemod.isSquelchOpen() && openBlocks < 6_000) {
			await feedPower(-70, 10)
			openBlocks += 10
		}
		// Recorded with this change: about 15.3 s of stream time (the floor rises
		// at the slower open rate while noise holds the gate). Frozen code stayed
		// closed here; this is the accepted cost of not muting a present carrier.
		expect(liveDemod.isSquelchOpen()).toBe(false)
		expect(openBlocks * 10).toBeGreaterThan(10_000)
		expect(openBlocks * 10).toBeLessThan(20_000)
	})
	// WG9 R1 M2: the re-seed is the auto threshold's; manual and noise keep frozen 5669c187 behaviour.
	for (const mode of ["manual", "noise"] as const) {
		it(`${mode} mode keeps the frozen retune reset: the first block after it seeds from its own power`, async () => {
			await liveDemod.reconfigure({ squelchMode: mode, squelch: -50 })
			await feedPower(-80, 100)
			expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-80)
			sourceManager.emitCaps(101_000_000)
			expect(liveDemod.getStatus().noiseFloorDbfs).toBeUndefined()
			await feedPower(-60, 1)
			// Smoothed block power reads a little under -60; frozen code never held -80 here.
			expect(liveDemod.getStatus().noiseFloorDbfs).toBeGreaterThan(-75)
		})

		it(`${mode} mode cold start seeds from the first block`, async () => {
			await liveDemod.reconfigure({ squelchMode: mode, squelch: -50 })
			await feedPower(-60, 10)
			expect(liveDemod.getStatus().noiseFloorDbfs).toBeCloseTo(-60)
		})

		it(`a ${mode}-mode retune leaves nothing for a later switch to auto`, async () => {
			await liveDemod.reconfigure({ squelchMode: mode, squelch: -50 })
			await feedPower(-80, 100)
			sourceManager.emitCaps(101_000_000)
			await liveDemod.reconfigure({ squelchMode: "auto" })
			await feedPower(-60, 1)
			expect(liveDemod.getStatus().noiseFloorDbfs).toBeGreaterThan(-75)
		})
	}
})
