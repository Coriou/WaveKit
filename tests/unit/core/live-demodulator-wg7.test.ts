/**
 * LiveDemodulator WG7 wiring (docs/specs/web-gaps-7, requirements 2, 3 and 4):
 * the squelch noise tail reproduction (req 4.1), noise squelch mode and tone
 * squelch gate in the runtime schema, Node-only application, status, the
 * transmission events, and the tone gate muting audio only (req 3.3).
 */

import {
	describe,
	it,
	expect,
	beforeEach,
	afterEach,
	vi,
	type MockInstance,
} from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough, Writable } from "node:stream"
import * as http from "node:http"
import type { ChildProcess } from "node:child_process"
import type {
	AnalogTransmissionEventData,
	AnalogTransmissionPayload,
} from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import type {
	LiveDemodConfig,
	LiveDemodulator as LiveDemodulatorType,
	LiveDemodulatorOptions,
} from "../../../src/core/live-demodulator.js"
import { wireAnalogTransmissions } from "../../../src/core/analog-transmission.js"
import { liveDemodSquelchGates } from "../../../src/core/live-demod-activity.js"
import { FmChannelSynth, carrierWindows } from "./fm-synth.js"
import { ctcssTone, mixInto, speechLike } from "./audio-tones/dcs-synth.js"
import { renderPcm } from "./audio-tones/synth.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

import { spawn } from "node:child_process"

const testLogger = createLogger({ level: "fatal" })
const RATE = 25_000
const BLOCK_SAMPLES = 250
let nextPid = 5_000_000

class MockChildProcess extends EventEmitter {
	stdin = new PassThrough()
	stdout = new PassThrough()
	stderr = new PassThrough()
	pid = ++nextPid
	exitCode: number | null = null
	signalCode: NodeJS.Signals | null = null

	receive(signal: NodeJS.Signals): void {
		setTimeout(() => this.exit(null, signal), 0)
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.exitCode !== null || this.signalCode !== null) return
		this.exitCode = code
		this.signalCode = signal
		this.emit("exit", code, signal)
	}
}

let processes: MockChildProcess[] = []
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>

async function findAvailablePort(): Promise<number> {
	for (;;) {
		const candidate = 20_000 + Math.floor(Math.random() * 25_000)
		const free = await new Promise<boolean>(resolve => {
			const server = http.createServer()
			server.once("error", () => resolve(false))
			server.listen(candidate, "127.0.0.1", () =>
				server.close(() => resolve(true)),
			)
		})
		if (free) return candidate
	}
}

class ClientTransport extends Writable {
	readonly chunks: Buffer[] = []
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(Buffer.from(chunk))
		cb()
	}
	received(): Buffer {
		return Buffer.concat(this.chunks)
	}
}

type Internals = {
	handleAudioData(chunk: Buffer): void
	registerClient(response: http.ServerResponse, remoteAddress: string): unknown
}

/** A constant carrier block (power `dbfs`), complex float32. */
function carrierBlock(dbfs: number): Buffer {
	const block = Buffer.alloc(BLOCK_SAMPLES * 8)
	for (let n = 0; n < BLOCK_SAMPLES; n++)
		block.writeFloatLE(10 ** (dbfs / 20), n * 8)
	return block
}

function blockDbfs(block: Buffer): number {
	let sum = 0
	for (let o = 0; o < block.length; o += 4) sum += block.readFloatLE(o) ** 2
	return 10 * Math.log10(sum / (block.length / 8))
}

/** s16le PCM at 25 kHz: CTCSS `hz` (or none) under speech-like audio. */
function tonePcm(hz: number | null, seconds: number, seed: number): Buffer {
	const audio =
		hz === null
			? new Float64Array(Math.round(seconds * RATE))
			: ctcssTone({ hz, seconds, seed, amplitude: 0.1, rate: RATE })
	mixInto(
		audio,
		speechLike({ seconds, seed: seed + 1, amplitude: 0.3, rate: RATE }),
	)
	return renderPcm(audio, RATE, "s16le").pcm
}

/** 10 ms blocks of a PCM buffer, as fresh copies (the gate mutes in place). */
function pcmBlocks(pcm: Buffer): Buffer[] {
	const out: Buffer[] = []
	const step = (RATE / 100) * 2
	for (let at = 0; at < pcm.length; at += step)
		out.push(Buffer.from(pcm.subarray(at, Math.min(pcm.length, at + step))))
	return out
}

describe("LiveDemodulator WG7", () => {
	let LiveDemodulatorClass: new (...args: unknown[]) => LiveDemodulatorType
	let liveDemod: LiveDemodulatorType
	let port: number
	let killSpy: MockInstance<(pid: number, signal?: string | number) => true>
	const fanoutManager = {
		addBranch: vi.fn(() => new PassThrough()),
		removeBranch: vi.fn(),
	}
	const sourceManager = Object.assign(new EventEmitter(), {
		getAllStatus: () => [{ id: "rtl-pi", connected: true }],
		getStatus: () => ({ id: "rtl-pi", connected: true }),
		getCaps: () => ({ kind: "iq", sampleRate: 2_400_000, format: "U8_IQ" }),
	})

	function create(
		overrides: Record<string, unknown> = {},
		options: LiveDemodulatorOptions = {},
	): LiveDemodulatorType {
		const config = LiveDemodConfigSchema.parse({
			engine: "csdr",
			enabled: true,
			sourceId: "rtl-pi",
			httpPort: port,
			squelchMode: "manual",
			...overrides,
		})
		return new LiveDemodulatorClass(
			testLogger,
			sourceManager,
			fanoutManager,
			config,
			{ httpHost: "127.0.0.1", ...options },
		)
	}

	function internals(): Internals {
		return liveDemod as unknown as Internals
	}

	function front(): MockChildProcess {
		const proc = processes.at(-2)
		if (!proc) throw new Error("pipeline not started")
		return proc
	}

	/** Writes channel IQ blocks to the front, waiting for each to pass the squelch. */
	async function feedAsync(block: Buffer, count = 1): Promise<void> {
		const back = processes.at(-1)
		if (back && !back.stdin.readableFlowing) back.stdin.resume()
		for (let i = 0; i < count; i++)
			await new Promise<void>(resolve =>
				front().stdout.write(Buffer.from(block), () => resolve()),
			)
	}

	/** Writes channel IQ blocks to the front; the back drains (no backpressure stall). */
	function feed(block: Buffer, count = 1): void {
		const back = processes.at(-1)
		if (back && !back.stdin.readableFlowing) back.stdin.resume()
		for (let i = 0; i < count; i++) front().stdout.write(Buffer.from(block))
	}

	beforeEach(async () => {
		const module = await import("../../../src/core/live-demodulator.js")
		LiveDemodulatorClass = module.LiveDemodulator as unknown as new (
			...args: unknown[]
		) => LiveDemodulatorType
		port = await findAvailablePort()
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
				proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
				return true
			})
		liveDemod = create()
	})

	afterEach(async () => {
		try {
			await liveDemod.stop()
		} catch {
			// ignore
		}
		killSpy.mockRestore()
		spawnMock.mockReset()
	})

	describe("noise tail (req 4.1)", () => {
		/**
		 * Back-chain delay model: the back chain at the defaults is
		 * `csdr fmdemod | dcblock | gain | limit | convert` (live-demod-pipeline.ts),
		 * all CSDR AnyLength stages with no retained window; each runner reads at
		 * most 1024 elements per iteration. We model the whole chain as releasing
		 * audio in 1024-sample batches: a sample leaves once its batch is complete,
		 * so the extra wall delay is at most 1024 samples (40.96 ms at 25 kHz).
		 */
		const BATCH = 1024
		const BACK_CHAIN_DELAY_MS = (BATCH / RATE) * 1000
		const CARRIER_ON_MS = 3000
		const CARRIER_OFF_MS = 4000
		const TOTAL_BLOCKS = 560

		/**
		 * Feeds a 20 dB CNR NFM channel (speech FM) with the carrier in
		 * [3000, 4000) ms and returns the unmuted noise after carrier loss in ms:
		 * from the carrier stop (at the IQ input) to the moment the back chain
		 * releases the last unmuted sample.
		 */
		function measureTail(seed: number): number {
			const synth = new FmChannelSynth({
				sampleRate: RATE,
				bandwidthHz: 12_500,
				seed,
				cnrDb: 20,
				carrier: carrierWindows([[CARRIER_ON_MS, CARRIER_OFF_MS]], RATE),
			})
			const gated: Buffer[] = []
			processes.at(-1)!.stdin.on("data", (chunk: Buffer) => gated.push(chunk))
			let opened = false
			for (let b = 0; b < TOTAL_BLOCKS; b++) {
				front().stdout.write(Buffer.from(synth.next()))
				if (b * 10 >= CARRIER_ON_MS && liveDemod.isSquelchOpen()) opened = true
			}
			expect(opened).toBe(true)
			const iq = Buffer.concat(gated)
			expect(iq.length).toBe(TOTAL_BLOCKS * BLOCK_SAMPLES * 8)
			// Back chain: FM discriminator. The muted vector is constant, so its
			// discriminator output is exactly 0; anything else is passed audio.
			let lastUnmuted = -1
			let pi = 0
			let pq = 0
			for (let n = 0; n < iq.length / 8; n++) {
				const i = iq.readFloatLE(n * 8)
				const q = iq.readFloatLE(n * 8 + 4)
				const d = Math.atan2(q * pi - i * pq, i * pi + q * pq)
				if (d !== 0 && n * 8 >= (CARRIER_OFF_MS / 1000) * RATE * 8)
					lastUnmuted = n
				pi = i
				pq = q
			}
			const carrierOff = (CARRIER_OFF_MS / 1000) * RATE
			if (lastUnmuted < carrierOff) return 0
			const released = Math.ceil((lastUnmuted + 1) / BATCH) * BATCH
			return ((released - carrierOff) / RATE) * 1000
		}

		/**
		 * An operator's threshold just above the idle noise: `marginDb` above the
		 * loudest idle block (3 s), so idle stays silent. Before the fix the 2 dB
		 * hold band then reached into the noise: at 1.5 dB the 8 seeds measured
		 * 0.26-1.61+ s of noise (median 0.9 s; 1.61 s = never closed in the run),
		 * at 0.1 dB the gate never closed.
		 */
		function justSilentThreshold(seed: number, marginDb: number): number {
			const synth = new FmChannelSynth({
				sampleRate: RATE,
				bandwidthHz: 12_500,
				seed,
				cnrDb: 20,
				carrier: carrierWindows([[CARRIER_ON_MS, CARRIER_OFF_MS]], RATE),
			})
			let max = Number.NEGATIVE_INFINITY
			for (let b = 0; b < CARRIER_ON_MS / 10; b++)
				max = Math.max(max, blockDbfs(synth.next()))
			return Math.ceil((max + marginDb) * 10) / 10
		}

		const SEEDS = [1, 2, 3, 4, 5]
		const BOUND_MS = 250 + 10 + BACK_CHAIN_DELAY_MS

		it("manual at the just-silent threshold: noise after carrier loss is at most hang + block + back-chain delay", async () => {
			const tails: number[] = []
			for (const marginDb of [0.1, 1.5]) {
				for (const seed of SEEDS) {
					await liveDemod.stop().catch(() => undefined)
					liveDemod = create({ squelch: justSilentThreshold(seed, marginDb) })
					await liveDemod.start()
					tails.push(measureTail(seed))
				}
			}
			for (const tail of tails) expect(tail).toBeLessThanOrEqual(BOUND_MS)
		})

		it("auto at the default margin: the same bound", async () => {
			const tails: number[] = []
			for (const seed of SEEDS.slice(0, 4)) {
				await liveDemod.stop().catch(() => undefined)
				liveDemod = create({ squelchMode: "auto" })
				await liveDemod.start()
				tails.push(measureTail(seed))
			}
			for (const tail of tails) expect(tail).toBeLessThanOrEqual(BOUND_MS)
		})

		/**
		 * R1 regression (req 2.1, 4.2): the run's floor estimate rises while the
		 * gate is open (0.4 dB/s); fed live into the hold rule it climbed under
		 * a held carrier until band blocks no longer held. Manual -30 dBFS, idle
		 * -40 dBFS for 2 s, then 40 s of a marginal fading carrier alternating
		 * 200 ms at -29 dBFS (above) and 300 ms at -31.5 dBFS (in the 2 dB band):
		 * the pre-WG7 gate (no floor) never closes, nor may the fixed one (it
		 * closed 67 times before the floor was frozen while open).
		 */
		async function fadingCarrierCloses(withFloor: boolean): Promise<number> {
			const { ChannelSquelch } =
				await import("../../../src/core/channel-squelch.js")
			const spy = withFloor
				? null
				: vi
						.spyOn(ChannelSquelch.prototype, "setNoiseFloorDbfs")
						.mockImplementation(() => undefined)
			try {
				await liveDemod.stop().catch(() => undefined)
				liveDemod = create({ squelch: -30 })
				await liveDemod.start()
				let opened = false
				let closes = 0
				liveDemod.on("squelch-changed", (open: boolean) => {
					if (open) opened = true
					else if (opened) closes++
				})
				await feedAsync(carrierBlock(-40), 200)
				for (let c = 0; c < 80; c++) {
					await feedAsync(carrierBlock(-29), 20)
					await feedAsync(carrierBlock(-31.5), 30)
				}
				expect(opened).toBe(true)
				expect(liveDemod.isSquelchOpen()).toBe(true)
				return closes
			} finally {
				spy?.mockRestore()
			}
		}

		it("manual holds a marginal fading carrier through the hysteresis band as before WG7", async () => {
			expect(await fadingCarrierCloses(false)).toBe(0)
			expect(await fadingCarrierCloses(true)).toBe(0)
		})
	})

	describe("runtime schema (req 2.1, 2.3, 3.1)", () => {
		it("accepts noise mode on nfm and wfm with the runtime quieting default", async () => {
			liveDemod = create({ squelchMode: "noise" })
			expect(liveDemod.getStatus().config.squelchMode).toBe("noise")
			expect(liveDemod.getStatus().config.noiseQuietingDb).toBe(6)
			liveDemod = create({
				squelchMode: "noise",
				modulation: "wfm",
				bandwidth: 150_000,
				noiseQuietingDb: 30,
			})
			expect(liveDemod.getStatus().config.noiseQuietingDb).toBe(30)
			liveDemod = create({ noiseQuietingDb: 1 })
			expect(liveDemod.getStatus().config.noiseQuietingDb).toBe(1)
		})

		it("refuses noise mode on AM, tone squelch on WFM and non-standard tones", async () => {
			const parse = (overrides: Record<string, unknown>) => () =>
				create(overrides)
			expect(parse({ squelchMode: "noise", modulation: "am" })).toThrow()
			expect(
				parse({
					modulation: "wfm",
					bandwidth: 150_000,
					toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
				}),
			).toThrow()
			expect(
				parse({ toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1001 } }),
			).toThrow()
			expect(
				parse({
					toneSquelch: { kind: "dcs", code: "024", polarity: "normal" },
				}),
			).toThrow()
			await liveDemod.start()
			for (const update of [
				{ squelchMode: "noise", modulation: "am" },
				{ noiseQuietingDb: 0.9 },
				{ noiseQuietingDb: 30.1 },
				{ noiseQuietingDb: Number.NaN },
				{ toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1001 } },
				{ toneSquelch: { kind: "dcs", code: "024", polarity: "normal" } },
				{ toneSquelch: { kind: "none", frequencyTenthsHz: 885 } },
			]) {
				await expect(
					liveDemod.reconfigure(update as Partial<LiveDemodConfig>),
				).rejects.toThrow()
			}
			expect(liveDemod.getStatus().config.squelchMode).toBe("manual")
		})

		it("refuses a PATCH that moves a noise-mode or tone config to a modulation it does not support", async () => {
			liveDemod = create({
				squelchMode: "noise",
				toneSquelch: { kind: "dcs", code: "023", polarity: "normal" },
			})
			await liveDemod.start()
			await expect(
				liveDemod.reconfigure({ modulation: "am" }),
			).rejects.toThrow()
			await expect(
				liveDemod.reconfigure({ modulation: "wfm", bandwidth: 150_000 }),
			).rejects.toThrow()
			expect(liveDemod.getStatus().config.modulation).toBe("nfm")
			expect(spawnMock).toHaveBeenCalledTimes(2)
		})

		it("applies squelch mode, quieting and tone changes without restarting CSDR", async () => {
			await liveDemod.start()
			await liveDemod.reconfigure({ squelchMode: "noise" })
			await liveDemod.reconfigure({ noiseQuietingDb: 12 })
			await liveDemod.reconfigure({
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
			})
			await liveDemod.reconfigure({ toneSquelch: { kind: "none" } })
			await liveDemod.reconfigure({ squelchMode: "auto" })
			expect(spawnMock).toHaveBeenCalledTimes(2)
		})
	})

	describe("noise mode (req 2.1, 2.4)", () => {
		it("gates on FM quieting, keeps silent and NaN IQ closed, and passes bandwidth to the squelch", async () => {
			liveDemod = create({ squelchMode: "noise", squelch: -40 })
			await liveDemod.start()
			expect(liveDemod.isSquelchOpen()).toBe(false)
			await feedAsync(Buffer.alloc(BLOCK_SAMPLES * 8), 50)
			expect(liveDemod.isSquelchOpen()).toBe(false)
			const nan = Buffer.alloc(BLOCK_SAMPLES * 8)
			for (let o = 0; o < nan.length; o += 4) nan.writeFloatLE(Number.NaN, o)
			await feedAsync(nan, 50)
			expect(liveDemod.isSquelchOpen()).toBe(false)
			const synth = new FmChannelSynth({
				sampleRate: RATE,
				bandwidthHz: 12_500,
				seed: 11,
				cnrDb: 20,
				carrier: carrierWindows([[500, 1500]], RATE),
			})
			const states: boolean[] = []
			for (let b = 0; b < 200; b++) {
				await feedAsync(synth.next())
				states.push(liveDemod.isSquelchOpen())
			}
			expect(states.slice(0, 50).some(Boolean)).toBe(false)
			expect(states.slice(55, 150).every(Boolean)).toBe(true)
			expect(states.at(-1)).toBe(false)
			const squelch = (
				liveDemod as unknown as {
					run: { squelch: { mode: string; noiseQuietingDb: number } }
				}
			).run.squelch
			expect(squelch.mode).toBe("noise")
			expect(squelch.noiseQuietingDb).toBe(6)
			// The configured squelch stays the reported threshold.
			expect(liveDemod.getStatus().thresholdDbfs).toBe(-40)
		})

		it("emits transmissions with squelchMode noise, the quieting in effect and the configured threshold", async () => {
			liveDemod = create({
				squelchMode: "noise",
				squelch: -40,
				noiseQuietingDb: 8,
			})
			const events: AnalogTransmissionEventData[] = []
			const payloads: AnalogTransmissionPayload[] = []
			// WG10 activity hygiene: a transmission under ANALOG_TRANSMISSION_MIN_MS is not
			// published, so the carrier lasts 1 s on the tracker clock.
			let t = 1_700_000_000_000
			const tracker = wireAnalogTransmissions({
				source: liveDemod,
				frequencyAt: () => null,
				broadcast: event => events.push(event),
				sink: () => payload => payloads.push(payload),
				now: () => t,
			})
			// Noise mode gates even with squelch 0 (operator activity, transmissions).
			expect(liveDemodSquelchGates({ squelchMode: "noise", squelch: 0 })).toBe(
				true,
			)
			await liveDemod.start()
			// WG10 req 3.8: span audio counts blocks, so the carrier lasts 600 ms of blocks.
			feed(carrierBlock(-30), 60)
			t += 1000
			feed(Buffer.alloc(BLOCK_SAMPLES * 8), 40)
			tracker.stop()
			expect(events.map(e => e.state)).toEqual(["open", "closed"])
			for (const event of events) {
				expect(event.squelchMode).toBe("noise")
				expect(event.noiseQuietingDb).toBe(8)
				expect(event.thresholdDbfs).toBe(-40)
			}
			expect(events[1]?.closeReason).toBe("squelch")
			expect(payloads).toHaveLength(1)
			expect(payloads[0]).toMatchObject({
				squelchMode: "noise",
				noiseQuietingDb: 8,
				thresholdDbfs: -40,
			})
		})

		it("a mode switch mid-transmission closes it with config", async () => {
			liveDemod = create({ squelch: -50 })
			const events: AnalogTransmissionEventData[] = []
			let t = 1_700_000_000_000
			const tracker = wireAnalogTransmissions({
				source: liveDemod,
				frequencyAt: () => null,
				broadcast: event => events.push(event),
				sink: () => null,
				now: () => t,
			})
			await liveDemod.start()
			// WG10 req 3.8: 600 ms of carrier blocks, so the span is announced before the switch.
			feed(carrierBlock(-30), 60)
			expect(liveDemod.isSquelchOpen()).toBe(true)
			// WG10 activity hygiene: long enough to be published (ANALOG_TRANSMISSION_MIN_MS).
			t += 1000
			await liveDemod.reconfigure({ squelchMode: "noise" })
			expect(liveDemod.isSquelchOpen()).toBe(false)
			expect(events.map(e => [e.state, e.closeReason])).toEqual([
				["open", null],
				["closed", "config"],
			])
			expect(events[0]?.squelchMode).toBe("manual")
			expect(events[0]?.noiseQuietingDb).toBeUndefined()
			// Back to manual: the power gate reopens on the carrier.
			await liveDemod.reconfigure({ squelchMode: "manual" })
			feed(carrierBlock(-30), 2)
			expect(liveDemod.isSquelchOpen()).toBe(true)
			tracker.stop()
		})
	})

	describe("tone squelch gate (req 3.2-3.4)", () => {
		const CTCSS_885 = { kind: "ctcss", frequencyTenthsHz: 885 } as const

		it("reports off, waiting and open, and mutes client audio until the tone is heard", async () => {
			expect(liveDemod.getStatus().toneSquelch).toBeUndefined()
			await liveDemod.start()
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "off" })
			await liveDemod.reconfigure({ toneSquelch: CTCSS_885 })
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "waiting" })
			const client = new ClientTransport()
			internals().registerClient(
				client as unknown as http.ServerResponse,
				"local",
			)
			// Squelch 0 (manual, off): the tone alone decides.
			const blocks = pcmBlocks(tonePcm(88.5, 1.5, 3))
			let openAtBlock = -1
			blocks.forEach((block, index) => {
				internals().handleAudioData(block)
				if (
					openAtBlock < 0 &&
					liveDemod.getStatus().toneSquelch?.state === "open"
				)
					openAtBlock = index
			})
			expect(openAtBlock).toBeGreaterThan(0)
			expect(openAtBlock).toBeLessThanOrEqual(100)
			const heard = client.received()
			const step = (RATE / 100) * 2
			// Up to and including the opening block: silence; afterwards: audio.
			expect(heard.subarray(0, openAtBlock * step).every(b => b === 0)).toBe(
				true,
			)
			expect(heard.subarray((openAtBlock + 1) * step).some(b => b !== 0)).toBe(
				true,
			)
			expect(heard.length).toBe(blocks.reduce((n, b) => n + b.length, 0))
		})

		it("an adjacent standard tone never opens it", async () => {
			liveDemod = create({ toneSquelch: CTCSS_885 })
			await liveDemod.start()
			const client = new ClientTransport()
			internals().registerClient(
				client as unknown as http.ServerResponse,
				"local",
			)
			for (const block of pcmBlocks(tonePcm(91.5, 1.5, 4)))
				internals().handleAudioData(block)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "waiting" })
			expect(client.received().every(b => b === 0)).toBe(true)
		})

		it("closes at once when the squelch closes and is rebuilt on a tone change", async () => {
			liveDemod = create({ squelch: -50, toneSquelch: CTCSS_885 })
			await liveDemod.start()
			feed(carrierBlock(-30), 2)
			for (const block of pcmBlocks(tonePcm(88.5, 1.2, 5)))
				internals().handleAudioData(block)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "open" })
			feed(carrierBlock(-80), 30)
			expect(liveDemod.isSquelchOpen()).toBe(false)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "waiting" })
			const client = new ClientTransport()
			internals().registerClient(
				client as unknown as http.ServerResponse,
				"local",
			)
			// Squelch closed: muted even with the tone present.
			feed(carrierBlock(-30), 2)
			internals().handleAudioData(pcmBlocks(tonePcm(88.5, 0.1, 6))[0]!)
			expect(client.received().every(b => b === 0)).toBe(true)
			for (const block of pcmBlocks(tonePcm(88.5, 1.2, 7)))
				internals().handleAudioData(block)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "open" })
			await liveDemod.reconfigure({
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1000 },
			})
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "waiting" })
			expect(spawnMock).toHaveBeenCalledTimes(2)
		})

		it("PCM draining while the squelch is closed does not re-arm the gate", async () => {
			const CTCSS_100 = { kind: "ctcss", frequencyTenthsHz: 1000 } as const
			liveDemod = create({ squelch: -50, toneSquelch: CTCSS_100 })
			await liveDemod.start()
			feed(carrierBlock(-30), 2)
			for (const block of pcmBlocks(tonePcm(100, 1.2, 11)))
				internals().handleAudioData(block)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "open" })
			feed(carrierBlock(-80), 30)
			expect(liveDemod.isSquelchOpen()).toBe(false)
			// 1 s of the right tone still leaving the back chain after the close.
			for (const block of pcmBlocks(tonePcm(100, 1, 12)))
				internals().handleAudioData(block)
			feed(carrierBlock(-30), 2)
			expect(liveDemod.isSquelchOpen()).toBe(true)
			const client = new ClientTransport()
			internals().registerClient(
				client as unknown as http.ServerResponse,
				"local",
			)
			internals().handleAudioData(pcmBlocks(tonePcm(103.5, 0.1, 13))[0]!)
			expect(client.received().length).toBe((RATE / 100) * 2)
			expect(client.received().every(b => b === 0)).toBe(true)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "waiting" })
		})

		it("keeps f32le sample framing across chunks delivered while the squelch is closed", async () => {
			const pcm = Buffer.alloc(RATE * 2 * 4)
			for (let n = 0; n < RATE * 2; n++)
				pcm.writeFloatLE(0.1 * Math.sin((2 * Math.PI * 100 * n) / RATE), n * 4)
			for (const split of [0, 1, 2, 3]) {
				await liveDemod.stop().catch(() => undefined)
				liveDemod = create({
					squelch: -50,
					audioFormat: "f32le",
					toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1000 },
				})
				await liveDemod.start()
				feed(carrierBlock(-80), 2)
				expect(liveDemod.isSquelchOpen()).toBe(false)
				internals().handleAudioData(Buffer.alloc(split))
				feed(carrierBlock(-30), 2)
				expect(liveDemod.isSquelchOpen()).toBe(true)
				internals().handleAudioData(
					Buffer.concat([Buffer.alloc(split ? 4 - split : 0), pcm]),
				)
				expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "open" })
			}
		})

		for (const format of ["s16le", "f32le"] as const) {
			for (const how of ["enable", "change"] as const) {
				it(`${format}: a gate built mid-sample (${how}) starts at the stream's framing`, async () => {
					const width = format === "s16le" ? 2 : 4
					const samples = RATE * 2
					const pcm = Buffer.alloc(samples * width)
					for (let n = 0; n < samples; n++) {
						const v = 0.1 * Math.sin((2 * Math.PI * 100 * n) / RATE)
						if (format === "s16le")
							pcm.writeInt16LE(Math.round(v * 32_767), n * 2)
						else pcm.writeFloatLE(v, n * 4)
					}
					liveDemod = create({
						audioFormat: format,
						...(how === "change"
							? { toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 } }
							: {}),
					})
					await liveDemod.start()
					// One byte of a sample, then the gate is built or replaced.
					internals().handleAudioData(Buffer.alloc(1))
					await liveDemod.reconfigure({
						toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1000 },
					})
					internals().handleAudioData(
						Buffer.concat([Buffer.alloc(width - 1), pcm]),
					)
					expect(liveDemod.getStatus().toneSquelch).toEqual({
						state: "open",
					})
				})
			}
		}

		it("applies the gate per 10 ms slice of a large chunk, not by its final state", async () => {
			liveDemod = create({
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1000 },
			})
			await liveDemod.start()
			const client = new ClientTransport()
			internals().registerClient(
				client as unknown as http.ServerResponse,
				"local",
			)
			// One 62,500-byte chunk: 250 ms of the wrong tone, then 1 s of the right one.
			const chunk = Buffer.concat([
				tonePcm(103.5, 0.25, 14),
				tonePcm(100, 1, 15),
			])
			expect(chunk.length).toBe(62_500)
			const original = Buffer.from(chunk)
			const seen: Buffer[] = []
			liveDemod.on("pcm", (pcm: Buffer) => seen.push(Buffer.from(pcm)))
			internals().handleAudioData(chunk)
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "open" })
			// pcm listeners saw the whole chunk unmuted.
			expect(seen).toHaveLength(1)
			expect(seen[0]!.equals(original)).toBe(true)
			const heard = client.received()
			expect(heard.length).toBe(62_500)
			// The wrong tone and the right tone's first 500 ms (before 2 blocks) stay muted.
			const mutedBytes = (RATE / 1000) * 750 * 2
			expect(heard.subarray(0, mutedBytes).every(b => b === 0)).toBe(true)
			// Once open, the rest passes unchanged.
			const step = (RATE / 100) * 2
			let firstPassed = -1
			for (let at = 0; at < heard.length; at += step)
				if (heard.subarray(at, at + step).some(b => b !== 0)) {
					firstPassed = at
					break
				}
			expect(firstPassed).toBeGreaterThanOrEqual(mutedBytes)
			expect(
				heard.subarray(firstPassed).equals(original.subarray(firstPassed)),
			).toBe(true)
		})

		it("mutes everything when the gate cannot run at the channel rate", async () => {
			// 3 kHz bandwidth: 6 kHz demod rate, below the gate's 8 kHz minimum.
			liveDemod = create({ bandwidth: 3000, toneSquelch: CTCSS_885 })
			await liveDemod.start()
			expect(liveDemod.getStatus().toneSquelch).toEqual({ state: "waiting" })
			const client = new ClientTransport()
			internals().registerClient(
				client as unknown as http.ServerResponse,
				"local",
			)
			internals().handleAudioData(Buffer.from([1, 2, 3, 4]))
			expect(client.received()).toEqual(Buffer.alloc(4))
		})

		it("transmission events and tone results equal the run without the gate (property 7, integration)", async () => {
			async function runOnce(withGate: boolean) {
				let clock = Date.parse("2026-10-16T00:00:00Z")
				let ids = 0
				liveDemod = create({
					squelch: -50,
					...(withGate ? { toneSquelch: CTCSS_885 } : {}),
				})
				const events: AnalogTransmissionEventData[] = []
				const pcmSeen: Buffer[] = []
				const tracker = wireAnalogTransmissions({
					source: liveDemod,
					frequencyAt: () => null,
					broadcast: event => events.push(event),
					sink: () => null,
					now: () => clock,
					randomUUID: () => `id-${++ids}`,
				})
				liveDemod.on("pcm", (chunk: Buffer) => pcmSeen.push(Buffer.from(chunk)))
				await liveDemod.start()
				const client = new ClientTransport()
				internals().registerClient(
					client as unknown as http.ServerResponse,
					"local",
				)
				feed(carrierBlock(-30), 2)
				const blocks = pcmBlocks(tonePcm(88.5, 2, 9))
				for (const block of blocks) {
					// WG10 req 3.8: one carrier block per 10 ms of PCM (the tracker matches PCM to blocks).
					feed(carrierBlock(-30))
					clock += 10
					internals().handleAudioData(block)
				}
				feed(carrierBlock(-80), 30)
				clock += 300
				tracker.stop()
				await liveDemod.stop()
				return {
					events,
					pcm: Buffer.concat(pcmSeen),
					heard: client.received(),
				}
			}
			const plain = await runOnce(false)
			const gated = await runOnce(true)
			expect(gated.events).toEqual(plain.events)
			expect(plain.events.at(-1)?.tone?.ctcssHz).toBe(88.5)
			// pcm listeners see the unmuted audio; clients hear the muted start.
			expect(gated.pcm.equals(plain.pcm)).toBe(true)
			expect(plain.heard.equals(plain.pcm)).toBe(true)
			expect(gated.heard.length).toBe(plain.heard.length)
			expect(gated.heard.subarray(0, 5000).every(b => b === 0)).toBe(true)
			expect(gated.heard.equals(plain.heard)).toBe(false)
			expect(
				gated.heard.subarray(-5000).equals(plain.heard.subarray(-5000)),
			).toBe(true)
		})

		it("mutes whole samples only when chunks start mid-sample (R1)", async () => {
			liveDemod = create({
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 1000 },
			})
			await liveDemod.start()
			const client = new ClientTransport()
			internals().registerClient(
				client as unknown as http.ServerResponse,
				"local",
			)
			const seen: Buffer[] = []
			liveDemod.on("pcm", (pcm: Buffer) => seen.push(Buffer.from(pcm)))
			// Configured tone, a neighbouring tone, the configured tone again:
			// the gate opens, closes and reopens inside odd-aligned chunks.
			const original = Buffer.concat([
				tonePcm(100, 1.5, 4),
				tonePcm(103.5, 1.5, 5),
				tonePcm(100, 1.5, 6),
			])
			// 1 byte first, then 501-byte chunks: every other chunk starts mid-sample.
			const cuts = [0, 1]
			for (let at = 1; at < original.length; at += 501)
				cuts.push(Math.min(original.length, at + 501))
			for (let k = 0; k + 1 < cuts.length; k++)
				internals().handleAudioData(
					Buffer.from(original.subarray(cuts[k], cuts[k + 1])),
				)
			// pcm listeners get the unmuted bytes.
			expect(Buffer.concat(seen).equals(original)).toBe(true)
			const heard = client.received()
			expect(heard.length).toBe(original.length)
			// Each sample is passed whole or zeroed whole: every zeroed run
			// starts and ends on a sample boundary.
			let split = 0
			let passed = 0
			let zeroed = 0
			let runs = 0
			let previousZeroed = false
			for (let i = 0; i < heard.length; i += 2) {
				const changed =
					heard[i] !== original[i] || heard[i + 1] !== original[i + 1]
				if (changed && heard.readInt16LE(i) !== 0) split++
				if (changed) zeroed++
				else passed++
				if (changed && !previousZeroed) runs++
				// A sample that is 0 in the source does not end a zeroed run.
				if (changed) previousZeroed = true
				else if (original.readInt16LE(i) !== 0) previousZeroed = false
			}
			expect(split).toBe(0)
			expect(passed).toBeGreaterThan(0)
			expect(zeroed).toBeGreaterThan(0)
			// Muted at the start, open, muted on the wrong tone, open again.
			expect(runs).toBeGreaterThanOrEqual(2)
		})
	})
})
