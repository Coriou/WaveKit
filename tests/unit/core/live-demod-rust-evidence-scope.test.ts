/**
 * Evidence squelch scope (docs/specs/evidence-squelch, amendment A12): the evidence gate and
 * pre-roll apply on the csdr engine only. On the Rust engine, `squelchMode: "auto"` is the
 * stage-1 auto squelch, byte-identical to the frozen path (as AM under amendment A8), and
 * `autoSquelch.state` is "off". A fallback or restart onto csdr turns the gate on, fresh.
 */
import { createHash } from "node:crypto"
import type { ChildProcess } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MockInstance } from "vitest"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type { EvidenceSquelchFactory } from "../../../src/core/evidence-squelch/contract.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import { WaveKitError } from "../../../src/utils/errors.js"
import {
	ClientTransport,
	FakeProcess,
	createFakeFanout,
	createFakeSourceManager,
	findFreePort,
} from "./live-demodulator-continuity-fakes.js"
import {
	fakeFactory,
	mergedCalls,
	type StreamCursor,
} from "./live-demodulator-evidence-fakes.js"
import { fskBursts, toPcm, voiceLike } from "./evidence-squelch/synthetic.js"
import {
	ChannelFake,
	VersionFake,
	demodEvent,
} from "./live-demod/rust-fakes.js"
import { createLogger } from "../../../src/utils/logger.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

const RUST_RATE = 48_000
const CHUNK_SIZES = [1, 333, 4_096, 9_600]

/** A5: a factory that throws leaves every run on the frozen stage-1 path (the oracle). */
const FROZEN_PATH: EvidenceSquelchFactory = {
	createGate() {
		throw new WaveKitError("frozen-path oracle", "TEST_ORACLE")
	},
	createPreRoll() {
		throw new WaveKitError("frozen-path oracle", "TEST_ORACLE")
	},
}

interface ScopeInternals {
	run: {
		rust?: unknown
		squelch: object
		evidence?: unknown
	} | null
	options: { evidenceSquelch?: EvidenceSquelchFactory }
	registerClient(response: unknown, remoteAddress: string): unknown
	handleAudioData(chunk: Buffer): void
}

/** 1 s voice, 1 s silence, 1 s 2-FSK at 48 kHz, s16le. */
function script(): Buffer {
	const voice = voiceLike({ rate: RUST_RATE, seconds: 1, seed: 7 })
	const silence = new Float32Array(RUST_RATE)
	const fsk = fskBursts({
		rate: RUST_RATE,
		seconds: 1,
		levels: 2,
		baud: 1_200,
		burstMs: 300,
		gapMs: 100,
		seed: 11,
	})
	return Buffer.concat([
		toPcm(voice, "s16le"),
		toPcm(silence, "s16le"),
		toPcm(fsk, "s16le"),
	])
}

/** Stage 1 open for script seconds [0.2, 1.4) and [2.0, 2.8), judged at each chunk's start. */
function stageOpen(byteOffset: number): boolean {
	const seconds = byteOffset / 2 / RUST_RATE
	return (seconds >= 0.2 && seconds < 1.4) || (seconds >= 2 && seconds < 2.8)
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex")
}

describe("evidence squelch scope: csdr only (amendment A12)", () => {
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType
	let demod: LiveDemodulatorType | undefined
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	let autoExitAfter: number
	let channelCount: number
	const versions: VersionFake[] = []
	const channels: ChannelFake[] = []
	const shells: FakeProcess[] = []

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		autoExitAfter = 99
		channelCount = 0
		versions.length = 0
		channels.length = 0
		shells.length = 0
		spawnMock.mockImplementation((command: string, args: string[]) => {
			if (args[0] === "--version") {
				const proc = new VersionFake("current")
				versions.push(proc)
				return proc as unknown as ChildProcess
			}
			if (command === "/bin/sh") {
				const proc = new FakeProcess(args[1] ?? "")
				shells.push(proc)
				return proc as unknown as ChildProcess
			}
			channelCount += 1
			const proc = new ChannelFake({ autoExit: channelCount > autoExitAfter })
			channels.push(proc)
			return proc as unknown as ChildProcess
		})
		killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid: number, signal?: string | number) => {
				const id = Math.abs(pid)
				const proc =
					channels.find(item => item.pid === id) ??
					versions.find(item => item.pid === id) ??
					shells.find(item => item.pid === id)
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

	async function boot(
		overrides: Record<string, unknown>,
		factory: EvidenceSquelchFactory | undefined,
	): Promise<{ demod: LiveDemodulatorType; internals: ScopeInternals }> {
		const config = LiveDemodConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: await findFreePort(),
			engine: "rust",
			chanBinaryPath: "wavekit-chan-test",
			modulation: "nfm",
			squelchMode: "auto",
			...overrides,
		})
		const created = new LiveDemodulatorClass(
			createLogger({ level: "fatal" }),
			createFakeSourceManager(),
			createFakeFanout(),
			config,
			{
				httpHost: "127.0.0.1",
				restartBaseDelayMs: 1,
				restartMaxDelayMs: 8,
				...(factory !== undefined ? { evidenceSquelch: factory } : {}),
			},
		)
		demod = created
		await created.start()
		return {
			demod: created,
			internals: created as unknown as ScopeInternals,
		}
	}

	/**
	 * Plays the script on the Rust run: stage 1 follows native `gate` events, one `metrics`
	 * point (power and quieting) per chunk feeds the floor (and, if it applied, the gate's
	 * noteBlock), and the audio enters exactly as the channel socket delivers it.
	 */
	function playRust(
		d: LiveDemodulatorType,
		internals: ScopeInternals,
	): { registry: Buffer; pcm: Buffer; states: string[] } {
		const pcm: Buffer[] = []
		d.on("pcm", (chunk: Buffer) => pcm.push(Buffer.from(chunk)))
		const transport = new ClientTransport()
		internals.registerClient(transport, "c")
		const channel = channels.at(-1)
		if (channel === undefined) throw new Error("no channel")
		const bytes = script()
		const states: string[] = []
		let open = false
		let offset = 0
		for (let i = 0; offset < bytes.length; i++) {
			const size = CHUNK_SIZES[i % CHUNK_SIZES.length] ?? 1
			const end = Math.min(bytes.length, offset + size)
			const next = stageOpen(offset)
			if (next !== open) {
				open = next
				channel.emitLine(
					demodEvent("gate", { open, atOutputSample: offset / 2 }),
				)
			}
			channel.emitLine(
				demodEvent("metrics", {
					atOutputSample: offset / 2,
					powerDbfs: [open ? -40 : -80],
					quietingDb: [open ? 30 : null],
				}),
			)
			internals.handleAudioData(Buffer.from(bytes.subarray(offset, end)))
			states.push(d.getStatus().autoSquelch?.state ?? "absent")
			offset = end
		}
		return { registry: transport.received(), pcm: Buffer.concat(pcm), states }
	}

	it("Rust nfm auto: client and pcm bytes equal the stage-1-only oracle; state off", async () => {
		const played: Record<string, { registry: string; pcm: string }> = {}
		const cursor: StreamCursor = { base: 0 }
		// Discriminating fakes: a gate that never latches and a pre-roll that zeroes its range.
		// Were the evidence path applied, every client byte would be muted.
		const fakes = fakeFactory(cursor, { latchAtByte: null, rewrite: true })
		const factories: Record<string, EvidenceSquelchFactory | undefined> = {
			real: undefined,
			fakes,
			oracle: FROZEN_PATH,
		}
		for (const [name, factory] of Object.entries(factories)) {
			const { demod: d, internals } = await boot({}, factory)
			expect(d.getStatus().engine).toBe("rust")
			expect(internals.run?.rust).toBeDefined()
			const { registry, pcm, states } = playRust(d, internals)
			played[name] = { registry: sha256(registry), pcm: sha256(pcm) }
			expect(states.every(state => state === "off")).toBe(true)
			expect(d.getStatus().autoSquelch).toEqual({ state: "off" })
			await d.stop()
			demod = undefined
		}
		// Frozen stage-1 on Rust: native gating, every client byte is the pcm byte.
		const pass = sha256(script())
		expect(played["oracle"]).toEqual({ registry: pass, pcm: pass })
		expect(played["real"]).toEqual(played["oracle"])
		expect(played["fakes"]).toEqual(played["oracle"])
		// Inert: no instances on Rust (as AM under A8), so nothing was noted or held.
		expect(fakes.gates).toHaveLength(0)
		expect(fakes.preRolls).toHaveLength(0)
	}, 30_000)

	it("csdr nfm auto with the same fakes is evidence-gated (the check discriminates)", async () => {
		const cursor: StreamCursor = { base: 0 }
		const fakes = fakeFactory(cursor, { latchAtByte: null, rewrite: true })
		const { demod: d, internals } = await boot({ engine: "csdr" }, fakes)
		expect(d.getStatus().engine).toBe("csdr")
		expect(d.getStatus().autoSquelch).toEqual({ state: "waiting" })
		const run = internals.run
		if (run === null) throw new Error("no run")
		Object.defineProperty(run.squelch, "open", {
			configurable: true,
			get: () => true,
		})
		const transport = new ClientTransport()
		internals.registerClient(transport, "c")
		internals.handleAudioData(Buffer.alloc(2_000, 7))
		expect(transport.received().every(b => b === 0)).toBe(true)
		expect(fakes.gates).toHaveLength(1)
	})

	it("a rust to csdr fallback mid-run turns evidence gating on with a fresh gate", async () => {
		autoExitAfter = 1
		const cursor: StreamCursor = { base: 0 }
		const fakes = fakeFactory(cursor, { latchAtByte: null })
		const { demod: d, internals } = await boot({}, fakes)
		expect(d.getStatus().engine).toBe("rust")
		// Mid-run on Rust: audio and an open native gate change nothing.
		channels[0]?.emitLine(demodEvent("gate", { open: true, atOutputSample: 0 }))
		internals.handleAudioData(Buffer.alloc(960, 3))
		expect(d.getStatus().autoSquelch).toEqual({ state: "off" })
		expect(fakes.gates).toHaveLength(0)
		// Three short Rust runs latch csdr (process-unstable).
		channels[0]?.exit(1, null)
		await vi.waitFor(
			() => {
				expect(d.getStatus().engine).toBe("csdr")
				expect(d.getStatus().engineFallback).toBe("process-unstable")
			},
			{ timeout: 3000 },
		)
		const run = internals.run
		if (run === null) throw new Error("no run")
		expect(run.rust).toBeUndefined()
		// One fresh gate and pre-roll, built for the csdr run; nothing carried over.
		expect(fakes.gates).toHaveLength(1)
		expect(fakes.preRolls).toHaveLength(1)
		const gate = fakes.gates[0]
		const preRoll = fakes.preRolls[0]
		expect(gate?.notes).toEqual([])
		expect(gate?.seen).toBe(0)
		expect(preRoll?.calls).toEqual([])
		expect(d.getStatus().autoSquelch).toEqual({ state: "waiting" })
		// The csdr run is evidence-gated: stage-1-open audio is held as pending.
		Object.defineProperty(run.squelch, "open", {
			configurable: true,
			get: () => true,
		})
		internals.handleAudioData(Buffer.alloc(1_000, 5))
		expect(mergedCalls(preRoll?.calls ?? [])).toEqual([
			{ start: 0, end: 1_000, tag: "pending" },
		])
	}, 10_000)

	it("reconfiguring the engine flips evidence gating both ways", async () => {
		const cursor: StreamCursor = { base: 0 }
		const fakes = fakeFactory(cursor, { latchAtByte: null })
		const { demod: d, internals } = await boot({}, fakes)
		expect(d.getStatus().autoSquelch).toEqual({ state: "off" })
		await d.reconfigure({ engine: "csdr" })
		await vi.waitFor(() => expect(d.getStatus().engine).toBe("csdr"), {
			timeout: 3000,
		})
		expect(internals.run?.rust).toBeUndefined()
		expect(d.getStatus().autoSquelch).toEqual({ state: "waiting" })
		expect(fakes.gates).toHaveLength(1)
		await d.reconfigure({ engine: "rust" })
		await vi.waitFor(() => expect(d.getStatus().engine).toBe("rust"), {
			timeout: 3000,
		})
		expect(d.getStatus().autoSquelch).toEqual({ state: "off" })
		// The Rust run built no instances; the csdr gate is not reused.
		expect(fakes.gates).toHaveLength(1)
		expect(internals.run?.evidence ?? null).toBeNull()
	}, 10_000)
})
