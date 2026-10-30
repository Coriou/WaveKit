/**
 * Evidence squelch A19 (2026-10-24): on the csdr engine the run's squelch mutes closed
 * envelope-demodulator output (`muteZeros`) for am, dsb and cw only; FM, SSB and raw keep the
 * hold vector, and the Rust engine (and the csdr default) are unchanged.
 */
import type { ChildProcess } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MockInstance } from "vitest"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import type { ChannelSquelch } from "../../../src/core/channel-squelch.js"
import {
	ClientTransport,
	FakeProcess,
	createFakeFanout,
	createFakeSourceManager,
	findFreePort,
} from "./live-demodulator-continuity-fakes.js"
import { ChannelFake, VersionFake } from "./live-demod/rust-fakes.js"
import { createLogger } from "../../../src/utils/logger.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

interface Internals {
	run: {
		rust?: unknown
		squelch: ChannelSquelch
		stream: { rate: number; format: string }
	} | null
	registerClient(response: unknown, remoteAddress: string): unknown
	handleAudioData(chunk: Buffer): void
}

describe("live demodulator AM closed mute (A19)", () => {
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType
	let demod: LiveDemodulatorType | undefined
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	const procs: { pid: number; receive(signal: NodeJS.Signals): void }[] = []
	const channels: ChannelFake[] = []

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		procs.length = 0
		channels.length = 0
		spawnMock.mockImplementation((command: string, args: string[]) => {
			if (args[0] === "--version") {
				const proc = new VersionFake("current")
				procs.push(proc)
				return proc as unknown as ChildProcess
			}
			if (command === "/bin/sh") {
				const proc = new FakeProcess(args[1] ?? "")
				procs.push(proc)
				return proc as unknown as ChildProcess
			}
			const proc = new ChannelFake({ autoExit: false })
			channels.push(proc)
			procs.push(proc)
			return proc as unknown as ChildProcess
		})
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const proc = procs.find(item => item.pid === Math.abs(pid))
				if (!proc) {
					const error = new Error("ESRCH") as NodeJS.ErrnoException
					error.code = "ESRCH"
					throw error
				}
				proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
				return true
			})
	})

	afterEach(async () => {
		try {
			await demod?.stop()
		} catch {
			// cleanup only
		}
		demod = undefined
		for (const channel of channels) await channel.dispose()
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	async function boot(overrides: Record<string, unknown>): Promise<Internals> {
		const config = LiveDemodConfigSchema.parse({
			engine: "csdr",
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: await findFreePort(),
			...overrides,
		})
		const created = new LiveDemodulatorClass(
			createLogger({ level: "fatal" }),
			createFakeSourceManager(),
			createFakeFanout(),
			config,
			{ httpHost: "127.0.0.1", restartBaseDelayMs: 1, restartMaxDelayMs: 8 },
		)
		demod = created
		await created.start()
		return created as unknown as Internals
	}

	for (const modulation of ["am", "dsb", "cw"]) {
		it(`${modulation} on the csdr engine mutes closed output`, async () => {
			const internals = await boot({ modulation })
			expect(internals.run?.rust).toBeUndefined()
			expect(internals.run?.squelch.mutesClosedPcm).toBe(true)
		})
	}

	for (const modulation of ["nfm", "wfm", "usb", "lsb", "raw"]) {
		it(`${modulation} keeps the hold vector`, async () => {
			const internals = await boot({
				modulation,
				...(modulation === "raw" ? { bandwidth: 0 } : {}),
			})
			expect(internals.run?.squelch.mutesClosedPcm).toBe(false)
		})
	}

	it("an omitted engine parses absent (Rust at runtime) and Rust AM runs are unchanged (no closed mute)", async () => {
		expect(LiveDemodConfigSchema.parse({}).engine).toBeUndefined()
		const internals = await boot({
			modulation: "am",
			engine: "rust",
			chanBinaryPath: "wavekit-chan-test",
		})
		expect(internals.run?.rust).toBeDefined()
		expect(internals.run?.squelch.mutesClosedPcm).toBe(false)
	})

	it("closed AM PCM reaches clients and pcm listeners as zeros; open PCM passes", async () => {
		const internals = await boot({
			modulation: "am",
			squelchMode: "manual",
			squelch: -40,
		})
		const run = internals.run
		if (run === null) throw new Error("no run")
		const transport = new ClientTransport()
		internals.registerClient(transport, "c")
		const pcm: Buffer[] = []
		demod?.on("pcm", (chunk: Buffer) => pcm.push(Buffer.from(chunk)))
		const blockSamples = Math.max(1, Math.round(run.stream.rate * 0.01))
		// One closed block (zeros in: power below the threshold), then one open block.
		const closed = Buffer.concat(
			run.squelch.process(Buffer.alloc(blockSamples * 8)),
		)
		expect(closed.every(b => b === 0)).toBe(true)
		const carrier = Buffer.alloc(blockSamples * 8)
		for (let n = 0; n < blockSamples; n++) carrier.writeFloatLE(0.5, n * 8)
		run.squelch.process(carrier)
		expect(run.squelch.open).toBe(true)
		// The back chain's PCM for both blocks, split at an odd byte.
		const audio = Buffer.alloc(blockSamples * 2 * 2, 0x11)
		const cut = blockSamples * 2 + 1
		internals.handleAudioData(Buffer.from(audio.subarray(0, cut)))
		internals.handleAudioData(Buffer.from(audio.subarray(cut)))
		const heard = Buffer.concat(pcm)
		expect(heard.length).toBe(audio.length)
		expect(heard.subarray(0, blockSamples * 2).every(b => b === 0)).toBe(true)
		expect(heard.subarray(blockSamples * 2).every(b => b === 0x11)).toBe(true)
		await new Promise(resolve => setImmediate(resolve))
		const received = transport.received()
		expect(received.subarray(0, blockSamples * 2).every(b => b === 0)).toBe(
			true,
		)
		expect(received.subarray(blockSamples * 2).every(b => b === 0x11)).toBe(
			true,
		)
	})
})
