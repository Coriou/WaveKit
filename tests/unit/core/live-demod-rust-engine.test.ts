import { describe, expect, it, vi, afterEach } from "vitest"
import type { spawn } from "node:child_process"
import { LiveDemodConfigSchema, type SourceCaps } from "../../../src/config.js"
import type { DemodSquelch } from "../../../src/core/live-demod/engine.js"
import {
	HANDSHAKE_EARLY_MAX,
	RustEngine,
} from "../../../src/core/live-demod/rust-engine.js"
import {
	encodeOpen,
	encodeSquelch,
} from "../../../src/core/live-demod/rust-protocol.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	ChannelFake,
	VersionFake,
	demodEvent,
	manualClock,
} from "./live-demod/rust-fakes.js"

const caps: SourceCaps = {
	kind: "iq",
	sampleRate: 48_000,
	format: "U8_IQ",
	exclusive: false,
}

function config() {
	return LiveDemodConfigSchema.parse({
		engine: "rust",
		modulation: "nfm",
		bandwidth: 12500,
		squelch: 0,
		audioFormat: "s16le",
	})
}

function install(
	exitOnShutdown: boolean,
	channel?: { emitReady?: boolean; readyRepeat?: number },
) {
	const versions: VersionFake[] = []
	const channels: ChannelFake[] = []
	const spawnProcess = ((command: string, args: string[]) => {
		if (args[0] === "--version") {
			const proc = new VersionFake("current")
			versions.push(proc)
			return proc
		}
		const proc = new ChannelFake({
			exitOnShutdown,
			autoExit: false,
			...(channel?.emitReady !== undefined
				? { emitReady: channel.emitReady }
				: {}),
			...(channel?.readyRepeat !== undefined
				? { readyRepeat: channel.readyRepeat }
				: {}),
		})
		channels.push(proc)
		return proc
	}) as unknown as typeof spawn
	return { versions, channels, spawnProcess }
}

function decodedSquelch(update: DemodSquelch): Record<string, unknown> {
	return JSON.parse(encodeSquelch(update)) as Record<string, unknown>
}

describe("squelch noiseFloorDbfs", () => {
	it("omits the floor, clears it with null, or sets a number", () => {
		const absent = decodedSquelch({ mode: "power", thresholdDbfs: -40 })
		expect(Object.hasOwn(absent, "noiseFloorDbfs")).toBe(false)
		expect(
			decodedSquelch({
				mode: "power",
				thresholdDbfs: -40,
				noiseFloorDbfs: null,
			})["noiseFloorDbfs"],
		).toBeNull()
		expect(
			decodedSquelch({
				mode: "power",
				thresholdDbfs: -40,
				noiseFloorDbfs: -45.5,
			})["noiseFloorDbfs"],
		).toBe(-45.5)
	})

	it("omits noiseFloorDbfs from open even when the caller set it", () => {
		const line = encodeOpen({
			config: config(),
			centerHz: 100_000_000,
			squelch: {
				mode: "power",
				thresholdDbfs: -40,
				hysteresisDb: 2,
				hangMs: 250,
				noiseFloorDbfs: null,
			},
		})
		const open = JSON.parse(line) as { squelch: Record<string, unknown> }
		expect(open.squelch["mode"]).toBe("power")
		expect(open.squelch["thresholdDbfs"]).toBe(-40)
		expect(Object.hasOwn(open.squelch, "noiseFloorDbfs")).toBe(false)
	})
})

describe("RustEngine process", () => {
	const engines: RustEngine[] = []
	const channels: ChannelFake[] = []

	afterEach(async () => {
		for (const engine of engines) await engine.stop()
		engines.length = 0
		for (const channel of channels) await channel.dispose()
		channels.length = 0
		vi.restoreAllMocks()
	})

	it("drops hostile event lines and still applies a later gate", async () => {
		const installed = install(true)
		channels.push(...installed.channels)
		const gates: boolean[] = []
		const engine = new RustEngine({
			binaryPath: "wavekit-chan",
			logger: createLogger({ level: "fatal" }),
			spawnProcess: installed.spawnProcess,
		})
		engines.push(engine)
		const { PassThrough } = await import("node:stream")
		const started = await engine.start({
			config: config(),
			caps,
			input: new PassThrough(),
			squelch: { mode: "off" },
			handlers: {
				onAudio: () => undefined,
				onGate: open => gates.push(open),
				onMetrics: () => undefined,
				onDown: () => undefined,
			},
		})
		expect(started).toMatchObject({ ok: true, rate: 48000 })
		channels.push(...installed.channels)
		const channel = installed.channels[0]
		expect(channel).toBeDefined()
		const oversize = `${"x".repeat(64 * 1024 + 1)}\n`
		channel?.stdout.write(oversize)
		channel?.stdout.write("not-json\n")
		channel?.stdout.write(
			`${JSON.stringify({ v: 1, type: "gate", id: "live-demod", generation: 1, open: "no", atOutputSample: 0 })}\n`,
		)
		channel?.emitLine(demodEvent("gate", { open: true, atOutputSample: 480 }))
		expect(engine.droppedEvents).toBe(3)
		expect(gates).toEqual([true])
	})

	it("SIGKILLs the process group when shutdown is ignored", async () => {
		const installed = install(false)
		channels.push(...installed.channels)
		const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			const id = Math.abs(Number(pid))
			const proc =
				installed.channels.find(item => item.pid === id) ??
				installed.versions.find(item => item.pid === id)
			if (!proc) {
				const error = new Error("ESRCH") as NodeJS.ErrnoException
				error.code = "ESRCH"
				throw error
			}
			proc.receive(signal as NodeJS.Signals)
			return true
		})
		const clock = manualClock()
		const engine = new RustEngine({
			binaryPath: "wavekit-chan",
			logger: createLogger({ level: "fatal" }),
			spawnProcess: installed.spawnProcess,
			clock,
			stopKillMs: 2000,
		})
		engines.push(engine)
		const { PassThrough } = await import("node:stream")
		const started = await engine.start({
			config: config(),
			caps,
			input: new PassThrough(),
			squelch: { mode: "off" },
			handlers: {
				onAudio: () => undefined,
				onGate: () => undefined,
				onMetrics: () => undefined,
				onDown: () => undefined,
			},
		})
		expect(started.ok).toBe(true)
		const channel = installed.channels[0]
		expect(channel).toBeDefined()
		const stopping = engine.stop()
		clock.advance(2000)
		await stopping
		expect(channel?.controlText).toContain('"type":"shutdown"')
		expect(kill).toHaveBeenCalledWith(-(channel?.pid ?? 0), "SIGKILL")
		expect(channel?.signals).toContain("SIGKILL")
		channel?.emitLine(demodEvent("gate", { open: true, atOutputSample: 1 }))
		expect(channel?.exitCode !== null || channel?.signalCode !== null).toBe(
			true,
		)
	})

	it("classifies a ready timeout as binary-unavailable, not a crash", async () => {
		const installed = install(true, { emitReady: false })
		channels.push(...installed.channels)
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			const id = Math.abs(Number(pid))
			const proc =
				installed.channels.find(item => item.pid === id) ??
				installed.versions.find(item => item.pid === id)
			if (!proc) {
				const error = new Error("ESRCH") as NodeJS.ErrnoException
				error.code = "ESRCH"
				throw error
			}
			proc.receive(signal as NodeJS.Signals)
			return true
		})
		const clock = manualClock()
		const engine = new RustEngine({
			binaryPath: "wavekit-chan",
			logger: createLogger({ level: "fatal" }),
			spawnProcess: installed.spawnProcess,
			clock,
			openTimeoutMs: 50,
			probeTimeoutMs: 5_000,
		})
		engines.push(engine)
		const { PassThrough } = await import("node:stream")
		const pending = engine.start({
			config: config(),
			caps,
			input: new PassThrough(),
			squelch: { mode: "off" },
			handlers: {
				onAudio: () => undefined,
				onGate: () => undefined,
				onMetrics: () => undefined,
				onDown: () => undefined,
			},
		})
		await vi.waitFor(() => expect(installed.channels).toHaveLength(1))
		channels.push(...installed.channels)
		clock.advance(50)
		await expect(pending).resolves.toEqual({
			ok: false,
			fallback: "binary-unavailable",
		})
	})

	it("classifies an exit before ready as a crash", async () => {
		const installed = install(true, { emitReady: false })
		channels.push(...installed.channels)
		const engine = new RustEngine({
			binaryPath: "wavekit-chan",
			logger: createLogger({ level: "fatal" }),
			spawnProcess: installed.spawnProcess,
			openTimeoutMs: 5_000,
		})
		engines.push(engine)
		const { PassThrough } = await import("node:stream")
		const pending = engine.start({
			config: config(),
			caps,
			input: new PassThrough(),
			squelch: { mode: "off" },
			handlers: {
				onAudio: () => undefined,
				onGate: () => undefined,
				onMetrics: () => undefined,
				onDown: () => undefined,
			},
		})
		await vi.waitFor(() => expect(installed.channels).toHaveLength(1))
		channels.push(...installed.channels)
		installed.channels[0]?.exit(1, null)
		await expect(pending).resolves.toEqual({ ok: false, crashed: true })
	})

	it("bounds handshake events and discards them after start", async () => {
		const readyRepeat = HANDSHAKE_EARLY_MAX + 23
		const installed = install(true, { readyRepeat })
		channels.push(...installed.channels)
		const retuned: number[] = []
		const engine = new RustEngine({
			binaryPath: "wavekit-chan",
			logger: createLogger({ level: "fatal" }),
			spawnProcess: installed.spawnProcess,
		})
		engines.push(engine)
		const { PassThrough } = await import("node:stream")
		const started = await engine.start({
			config: config(),
			caps,
			input: new PassThrough(),
			squelch: { mode: "off" },
			handlers: {
				onAudio: () => undefined,
				onGate: () => undefined,
				onMetrics: () => undefined,
				onDown: () => undefined,
				onRetuned: at => retuned.push(at),
			},
		})
		expect(started).toMatchObject({ ok: true })
		channels.push(...installed.channels)
		// The matcher consumes the first ready. The rest hit the handshake cap.
		expect(engine.droppedEvents).toBe(readyRepeat - 1 - HANDSHAKE_EARLY_MAX)
		expect(engine.bufferedHandshake).toBe(0)
		const channel = installed.channels[0]
		expect(channel).toBeDefined()
		if (!channel) return
		for (let i = 0; i < 5; i++) {
			channel.stdout.write(
				`${JSON.stringify({ v: 1, type: "ready", generation: 1, pid: channel.pid })}\n`,
			)
			channel.emitLine(
				demodEvent("opened", {
					socket: "/tmp/ignored.sock",
					outputRateHz: 48000,
					format: "s16le",
					kind: "demod",
					filterTaps: 1,
					groupDelaySamples: 0,
				}),
			)
			channel.emitLine(
				demodEvent("rejected", {
					reasonCode: "channel-request-invalid",
					detail: "late",
				}),
			)
			channel.emitLine(demodEvent("retuned", { atOutputSample: 480 * (i + 1) }))
		}
		expect(engine.bufferedHandshake).toBe(0)
		expect(engine.droppedEvents).toBe(readyRepeat - 1 - HANDSHAKE_EARLY_MAX)
		expect(retuned).toEqual([480, 960, 1440, 1920, 2400])
	})
})
