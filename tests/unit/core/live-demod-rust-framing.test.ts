/**
 * A18 framed Rust runs through the live demodulator (docs/specs/evidence-squelch requirements
 * 9.1, 9.6, 9.8, 9.9, 9.12, 9.13): negotiation, the evidence gate on framed runs, stdout
 * ordering independence, and the two fail-safe classes.
 */
import type { ChildProcess } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MockInstance } from "vitest"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type {
	EvidenceGateOptions,
	EvidenceSquelchFactory,
} from "../../../src/core/evidence-squelch/contract.js"
import { EvidenceGate } from "../../../src/core/evidence-squelch/evidence-gate.js"
import { PreRoll } from "../../../src/core/evidence-squelch/pre-roll.js"
import { WKAF_FLAG_GATE_OPEN } from "../../../src/core/evidence-squelch/framed-audio-parser.js"
import type { LiveDemodulator as LiveDemodulatorType } from "../../../src/core/live-demodulator.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	ClientTransport,
	FakeProcess,
	createFakeFanout,
	createFakeSourceManager,
	findFreePort,
} from "./live-demodulator-continuity-fakes.js"
import {
	ChannelFake,
	VersionFake,
	controlMessages,
	demodEvent,
} from "./live-demod/rust-fakes.js"
import {
	chunked,
	encodeFramed,
	orderedReference,
	overSteps,
	type OverSegment,
	type Step,
} from "./evidence-squelch/framed-harness.js"
import { voiceLike } from "./evidence-squelch/synthetic.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

interface Internals {
	run: {
		rust?: {
			framing: string
			groupDelaySamples: number
			parser: { push(chunk: Buffer): void } | null
		}
	} | null
	rustRuns: { rustFailures: number }
	registerClient(response: unknown, remoteAddress: string): unknown
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const RATE = 48_000
const zeros = (seconds: number): Float32Array =>
	new Float32Array(Math.round(RATE * seconds))
const closed = (seconds: number): OverSegment => ({
	pcm: zeros(seconds),
	open: false,
	quietingDb: Number.NaN,
})
const over = (seconds: number, seed: number): OverSegment => ({
	pcm: voiceLike({ rate: RATE, seconds, seed, level: 0.8 }),
	open: true,
	quietingDb: 30,
})

describe("A18 framed Rust runs", () => {
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType
	let demod: LiveDemodulatorType | undefined
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	let versionMode: "current" | "framing"
	let echo: boolean
	const versions: VersionFake[] = []
	const channels: ChannelFake[] = []
	const shells: FakeProcess[] = []

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		versionMode = "framing"
		echo = true
		versions.length = 0
		channels.length = 0
		shells.length = 0
		spawnMock.mockImplementation((command: string, args: string[]) => {
			if (args[0] === "--version") {
				const proc = new VersionFake(versionMode)
				versions.push(proc)
				return proc as unknown as ChildProcess
			}
			if (command === "/bin/sh") {
				const proc = new FakeProcess(args[1] ?? "")
				shells.push(proc)
				return proc as unknown as ChildProcess
			}
			const proc = new ChannelFake({ echoFraming: echo, groupDelaySamples: 37 })
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

	/** Real gate and pre-roll; the options are captured for the reference. */
	function capturingFactory(): EvidenceSquelchFactory & {
		options: EvidenceGateOptions[]
	} {
		const options: EvidenceGateOptions[] = []
		return {
			options,
			createGate(o) {
				options.push(o)
				return new EvidenceGate(o)
			},
			createPreRoll(o) {
				return new PreRoll(o)
			},
		}
	}

	async function boot(factory?: EvidenceSquelchFactory): Promise<{
		d: LiveDemodulatorType
		internals: Internals
		client: ClientTransport
	}> {
		const config = LiveDemodConfigSchema.parse({
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: await findFreePort(),
			engine: "rust",
			chanBinaryPath: "wavekit-chan-test",
			modulation: "nfm",
			squelchMode: "auto",
		})
		const d = new LiveDemodulatorClass(
			createLogger({ level: "fatal" }),
			createFakeSourceManager(),
			createFakeFanout(),
			config,
			{
				httpHost: "127.0.0.1",
				restartBaseDelayMs: 60_000,
				restartMaxDelayMs: 60_000,
				...(factory !== undefined ? { evidenceSquelch: factory } : {}),
			},
		)
		demod = d
		await d.start()
		const internals = d as unknown as Internals
		const client = new ClientTransport()
		internals.registerClient(client, "c")
		return { d, internals, client }
	}

	function openMessage(): Record<string, unknown> {
		const channel = channels.at(-1)
		const open = controlMessages(channel?.controlText ?? "").find(
			m => m["type"] === "open",
		)
		if (open === undefined) throw new Error("no open")
		return open
	}

	function push(internals: Internals, chunks: readonly Buffer[]): void {
		const parser = internals.run?.rust?.parser
		if (!parser) throw new Error("no framed parser")
		for (const chunk of chunks) parser.push(chunk)
	}

	describe("negotiation (9.1)", () => {
		it("protocol 2: the open has no audioFraming (protocol-2 bytes); the run is unframed, autoSquelch off", async () => {
			versionMode = "current"
			const { d, internals } = await boot()
			const open = openMessage()
			expect(open).not.toHaveProperty("audioFraming")
			expect(Object.keys(open)).toEqual([
				"v",
				"type",
				"id",
				"kind",
				"centerHz",
				"bandwidthHz",
				"modulation",
				"format",
				"queueBytes",
				"audio",
				"squelch",
				"metrics",
			])
			expect(internals.run?.rust?.framing).toBe("none")
			expect(d.getStatus().autoSquelch).toEqual({ state: "off" })
		})

		it("protocol 3 without the echo: framing requested, the run is raw PCM (A12)", async () => {
			echo = false
			const { d, internals, client } = await boot()
			expect(openMessage()["audioFraming"]).toBe("wkaf1")
			expect(internals.run?.rust?.framing).toBe("none")
			expect(d.getStatus().autoSquelch).toEqual({ state: "off" })
			const raw = Buffer.alloc(960, 0x21)
			await vi.waitFor(() => expect(channels.at(-1)?.audio).not.toBeNull())
			channels.at(-1)?.audio?.write(raw)
			await vi.waitFor(() => expect(client.received().length).toBe(960))
			expect(client.received().equals(raw)).toBe(true)
		})

		it("protocol 3 with the echo: framed run, evidence gate on (waiting), Rust lag as the guard", async () => {
			const factory = capturingFactory()
			const { d, internals } = await boot(factory)
			expect(internals.run?.rust?.framing).toBe("active")
			expect(d.getStatus().autoSquelch).toEqual({ state: "waiting" })
			expect(factory.options.at(-1)?.drainLagSamples).toBe(37)
		})
	})

	describe("framed verdicts (9.8, 9.12)", () => {
		const long = overSteps([closed(0.3), over(2, 7), closed(0.6)])
		// Latches late in the over: an early stdout close would land while still waiting.
		const short = overSteps([closed(0.3), over(1.1, 7), closed(0.6)])
		/** Stdout events of the over, Rust-shaped: gate edges and one metrics point per block. */
		function stdoutEvents(
			steps: readonly Step[],
		): Array<{ pos: number; event: Record<string, unknown> }> {
			const out: Array<{ pos: number; event: Record<string, unknown> }> = []
			let pos = 0
			let gate = false
			for (const step of steps) {
				if (step.kind === "pcm") pos += step.bytes.length / 2
				else if (step.kind === "gate" && step.open !== gate) {
					gate = step.open
					out.push({
						pos,
						event: demodEvent("gate", { open: gate, atOutputSample: pos }),
					})
				} else if (step.kind === "block")
					out.push({
						pos,
						event: demodEvent("metrics", {
							atOutputSample: pos - 480,
							powerDbfs: [step.powerDbfs],
							// Opposite carrier evidence: were stdout metrics noted, verdicts would change.
							quietingDb: [Number.isNaN(step.quietingDb) ? 30 : null],
						}),
					})
			}
			return out
		}

		// Stdout leads or lags the socket audio by 0.2 s (or is absent): verdicts never move.
		for (const [order, skew, steps] of [
			["stdout 0.2 s before the audio", -9_600, long],
			["stdout 0.2 s after the audio", 9_600, long],
			["short over, stdout 0.2 s before the audio", -9_600, short],
			["short over, stdout 0.2 s after the audio", 9_600, short],
			["no stdout", null, long],
		] as const)
			it(`${order}: client bytes equal the ordered reference`, async () => {
				const factory = capturingFactory()
				const { d, internals, client } = await boot(factory)
				const options = factory.options.at(-1)
				if (options === undefined) throw new Error("no gate")
				const channel = channels.at(-1)
				if (channel === undefined) throw new Error("no channel")
				const states = new Set<string>()
				const bytes = encodeFramed(steps)
				const events = skew === null ? [] : stdoutEvents(steps)
				let next = 0
				let offset = 0
				for (const chunk of chunked(
					bytes,
					Array.from(
						{ length: Math.ceil(bytes.length / 4_093) },
						(_, i) => i * 4_093,
					),
				)) {
					// Stream bytes are about two per sample (framing adds ~3 %).
					const now = offset / 2
					let wrote = false
					while (
						next < events.length &&
						(events[next]?.pos ?? 0) + (skew ?? 0) <= now
					) {
						const e = events[next]
						if (e) channel.emitLine(e.event)
						next++
						wrote = true
					}
					if (wrote) await tick()
					push(internals, [chunk])
					offset += chunk.length
					states.add(d.getStatus().autoSquelch?.state ?? "absent")
				}
				for (; next < events.length; next++) {
					const e = events[next]
					if (e) channel.emitLine(e.event)
				}
				await tick()
				if (skew !== null) expect(d.getStatus().squelchOpen).toBe(false)
				const ref = orderedReference(steps, options)
				expect(ref.latches.length).toBe(1)
				expect(client.received().equals(ref.client)).toBe(true)
				expect(states).toEqual(new Set(["waiting", "open"]))
			}, 30_000)

		it("a RESET and a DROP clear held audio as the reference does", async () => {
			for (const kind of ["reset", "drop"] as const) {
				const s: Step[] = overSteps(
					[closed(0.3), over(2, 9), closed(0.4)],
					[
						{
							at: 14_400 + 30_000,
							step: { kind, count: 480, flags: WKAF_FLAG_GATE_OPEN },
						},
					],
				)
				const factory = capturingFactory()
				const { internals, client } = await boot(factory)
				const options = factory.options.at(-1)
				if (options === undefined) throw new Error("no gate")
				push(internals, chunked(encodeFramed(s), [1, 7_777, 60_001]))
				expect([
					kind,
					client.received().equals(orderedReference(s, options).client),
				]).toEqual([kind, true])
				await demod?.stop()
				demod = undefined
			}
		}, 30_000)
	})

	describe("fail safe (9.6)", () => {
		it("a marker error mid-over drops held audio; the rest is Rust PCM as delivered, autoSquelch off", async () => {
			const { d, internals, client } = await boot(capturingFactory())
			const head = encodeFramed([
				{ kind: "gate", open: true },
				{ kind: "pcm", bytes: Buffer.alloc(9_600, 0x31) },
			])
			push(internals, [head])
			expect(d.getStatus().autoSquelch?.state).toBe("waiting")
			const before = client.received().length
			const bad = Buffer.concat([
				Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]),
				Buffer.from([1, 0, 0, 0, 4, 0, 0, 0, 0x41, 0x42, 0x43, 0x44]),
			])
			push(internals, [bad])
			expect(internals.run?.rust?.framing).toBe("failed")
			expect(d.getStatus().autoSquelch).toEqual({ state: "off" })
			// The held 0x31 bytes never play; the PCM after the error passes as delivered.
			const after = client.received().subarray(before)
			expect(after.equals(Buffer.from([0x41, 0x42, 0x43, 0x44]))).toBe(true)
			expect(client.received().includes(0x31)).toBe(false)
		})

		it("echo then raw PCM (or a corrupt preamble): no client byte, one failure, one crash count", async () => {
			const errors: Error[] = []
			const { d, internals, client } = await boot()
			d.on("error", (e: Error) => errors.push(e))
			const channel = channels.at(-1)
			if (channel === undefined) throw new Error("no channel")
			const engine = internals.run?.rust
			await vi.waitFor(() => expect(channel.audio).not.toBeNull())
			channel.audio?.on("error", () => undefined)
			channel.audio?.write(Buffer.alloc(19_200, 0x55))
			await vi.waitFor(() => expect(errors.length).toBe(1))
			expect(internals.rustRuns.rustFailures).toBe(1)
			// The existing Rust failure path, reached through the framing fault.
			expect(engine?.framing).toBe("failed")
			expect(internals.run).toBeNull()
			// Socket close and child exit of the same run add nothing.
			channel.audio?.destroy()
			channel.exit(1, null)
			await tick()
			await tick()
			expect(errors.length).toBe(1)
			expect(internals.rustRuns.rustFailures).toBe(1)
			expect(client.received().includes(0x55)).toBe(false)
		})
	})
})
