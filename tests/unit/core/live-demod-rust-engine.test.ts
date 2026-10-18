import { describe, expect, it, vi, afterEach } from "vitest"
import type { spawn } from "node:child_process"
import { LiveDemodConfigSchema, type SourceCaps } from "../../../src/config.js"
import { RustEngine } from "../../../src/core/live-demod/rust-engine.js"
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

function install(exitOnShutdown: boolean) {
	const versions: VersionFake[] = []
	const channels: ChannelFake[] = []
	const spawnProcess = ((command: string, args: string[]) => {
		if (args[0] === "--version") {
			const proc = new VersionFake("current")
			versions.push(proc)
			return proc
		}
		const proc = new ChannelFake({ exitOnShutdown, autoExit: false })
		channels.push(proc)
		return proc
	}) as unknown as typeof spawn
	return { versions, channels, spawnProcess }
}

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
})
