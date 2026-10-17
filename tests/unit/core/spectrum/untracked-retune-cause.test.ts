/**
 * WG10 req 2.9: one reproduction per candidate cause of an "untracked-retune" warning with no
 * external client. Goldens marked "frozen" were recorded from the code at 1e5b4c1f.
 */
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import pino from "pino"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import type {
	EngineState,
	PipelineEvent,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	packCu8,
	packF32,
	tone,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import { FS, Harness } from "./pipeline-harness.js"

const logger = pino({ level: "silent" })
type Tone = [offsetHz: number, amplitude: number]

function scene(seed: number, tones: Tone[], seconds: number): Iq {
	const n = Math.round(seconds * FS)
	const iq = gaussianNoise(mulberry32(seed), n, 0.05)
	for (const [o, a] of tones) addInto(iq, tone(n, FS, o, a))
	return iq
}
const u8 = (iq: Iq): Uint8Array => packCu8(iq.re, iq.im)
const f32 = (iq: Iq): Uint8Array => packF32(iq.re, iq.im)

/** Plays byte parts through a fresh pipeline; odd parts lose their last byte (whole samples only). */
function play(
	format: "U8_IQ" | "FLOAT32LE",
	parts: Uint8Array[],
	between?: (h: Harness, i: number) => void,
): Harness {
	const h = new Harness({ format })
	h.start({ feed: false })
	const bps = format === "U8_IQ" ? 2 : 8
	parts.forEach((b, i) => {
		if (i > 0) between?.(h, i)
		h.pushBytes(b.subarray(0, b.length - (b.length % bps)), 16_384)
	})
	return h
}

// Four weak features spread over the span (the existing alarm test's scene).
const SCENE: Tone[] = [
	[-60_000, 0.1],
	[-20_000, 0.1],
	[35_000, 0.1],
	[70_000, 0.1],
]
const moved = (tones: Tone[], by: number): Tone[] =>
	tones.map(([o, a]) => [o + by, a])
const mirrored = (tones: Tone[]): Tone[] => tones.map(([o, a]) => [-o, a])
// A strong near transmitter with its IQ image, harmonics/IM lines, and two weak bystanders.
const TX: Tone[] = [
	[34_000, 0.5],
	[-34_000, 0.05],
	[68_000, 0.03],
	[-68_000, 0.02],
	[102_000, 0.02],
]
const BYSTANDERS: Tone[] = [
	[-90_000, 0.08],
	[-110_000, 0.08],
]

describe("cause (golden): a genuine untracked retune", () => {
	it("still fires with the frozen epoch, start and Δ, classified external-control", () => {
		const h = play("U8_IQ", [
			u8(scene(1, SCENE, 10.6)),
			u8(scene(2, moved(SCENE, -25_000), 1)),
		])
		// frozen: [{ kind, epoch: 2, startSample: 2726400, deltaHz: -24999.900947779417 }]
		expect(h.of("untracked-retune")).toEqual([
			{
				kind: "untracked-retune",
				epoch: 2,
				startSample: 2_726_400,
				deltaHz: -24999.900947779417,
				suspected: "external-control",
			},
		])
	}, 30_000)
})

describe("cause 1: I/Q byte slip", () => {
	it("a real one-byte U8 slip leaves each feature at |sin(πf/fs)| and raises no alarm (frozen: none)", () => {
		// z'[k] = Q[k] + j·I[k+1]: the mirror −f gets |cos(ω/2)|, the original keeps |sin(ω/2)|
		// (−14 dB for 136.5 kHz at 2.16 Msps), so the features do not vanish and Δ is never −2f.
		const a = u8(scene(1, SCENE, 10.6))
		const b = u8(scene(2, SCENE, 1))
		expect(play("U8_IQ", [a, b.subarray(1)]).of("untracked-retune")).toEqual([])
	}, 30_000)

	it("review WG10 R1 M1: a full U8 mirror is a frozen unverified epoch on its first block, only labelled iq-byte-slip (no re-align)", () => {
		const h = play("U8_IQ", [
			u8(scene(1, SCENE, 10.6)),
			u8(scene(2, mirrored(SCENE), 1)),
		])
		// frozen: [{ epoch: 2, startSample: 2726400, deltaHz: -49997.98462638259 }]: a mirror has no
		// common shift, Δ was a coincidental pair match. A dense-band retune can look mirrored, so
		// the alarm never asks the engine to drop a byte (that would swap I/Q on an aligned stream).
		expect(h.of("untracked-retune")).toEqual([
			{
				kind: "untracked-retune",
				epoch: 2,
				startSample: 2_726_400,
				deltaHz: -49997.98462638259,
				suspected: "iq-byte-slip",
			},
		])
		expect(
			h.of("epoch-started").map(e => [e.epoch, e.startSample]),
		).toContainEqual([2, 2_726_400])
	}, 30_000)

	it("a FLOAT32 mirror is classified at once and never re-aligned", () => {
		const h = play("FLOAT32LE", [
			f32(scene(1, SCENE, 10.6)),
			f32(scene(2, mirrored(SCENE), 1)),
		])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		expect(alarms[0]).toMatchObject({
			startSample: 2_726_400,
			suspected: "iq-byte-slip",
		})
		expect(alarms[0]).not.toHaveProperty("realign")
	}, 30_000)

	it("the engine keeps I/Q parity through a real FanoutManager with odd chunks and congestion drops", async () => {
		const sources = new FakeSources()
		const fanout = new FanoutManager(logger)
		const source = new PassThrough()
		fanout.attachSource(source)
		let branch: PassThrough | null = null
		const realAdd = fanout.addBranch.bind(fanout)
		fanout.addBranch = cfg => {
			branch = realAdd(cfg)
			return branch
		}
		const inputs: PipelineInput[] = []
		const engine = new SpectrumEngine({
			sourceId: "rtl",
			sources,
			routing: { getFanout: () => fanout, releaseUnused: () => undefined },
			tuner: new FakeTuner(),
			settings: () => testSettings(),
			logger,
			createHost: (_cfg, handlers) => recordingHost(handlers, inputs),
			batchBytes: 4096,
		})
		await engine.start()
		// I bytes are < 0x80, Q bytes ≥ 0x80: a slipped pair is visible in every sample.
		let at = 0
		const chunk = (n: number): Buffer => {
			const b = Buffer.alloc(n)
			for (let i = 0; i < n; i++, at++)
				b[i] = at % 2 === 0 ? at % 128 : 128 + (at % 128)
			return b
		}
		const lengths = [1, 3, 7, 4096, 5, 11, 2049, 333]
		for (const n of lengths) source.write(chunk(n))
		await settle()
		branch!.pause()
		// Fill past the branch high-water mark: the fanout drops whole (odd) chunks.
		for (let i = 0; i < 199; i++) source.write(chunk(4095))
		await settle()
		const t = fanout.getBranchTelemetry("scanner-rtl")
		expect(t?.droppedBytesTotal ?? 0).toBeGreaterThan(0)
		branch!.resume()
		await settle()
		for (const n of lengths) source.write(chunk(n))
		await settle()
		await engine.stop()
		let pos = 0
		let checked = 0
		let slipped = 0
		for (const input of inputs) {
			if (input.kind === "gap") pos = (input.startSample + input.samples) * 2
			if (input.kind !== "bytes") continue
			expect(input.startSample * 2).toBe(pos)
			for (let i = 0; i < input.bytes.length; i += 2) {
				if (input.bytes[i]! >= 128 || input.bytes[i + 1]! < 128) slipped++
				checked++
			}
			pos += input.bytes.length
		}
		expect(slipped).toBe(0)
		expect(checked).toBeGreaterThan(4000)
		expect(inputs.some(i => i.kind === "gap")).toBe(true)
	})

	it("review WG10 R1 M1: an iq-byte-slip alarm (even one carrying the retired realign flag) drops no byte", async () => {
		const { engine, sources, fanout, inputs, handlers } = fakeEngine()
		await engine.start()
		fanout.write(Buffer.from([1, 2, 3, 4]))
		await settle()
		const legacy = {
			kind: "untracked-retune" as const,
			epoch: 9,
			startSample: 2,
			deltaHz: null,
			suspected: "iq-byte-slip" as const,
			realign: true,
		}
		handlers()!.events([legacy])
		fanout.write(Buffer.from([0xaa, 5, 6, 7, 8, 9]))
		await settle()
		await new Promise(resolve => setTimeout(resolve, 40))
		const bytes = inputs.flatMap(i => (i.kind === "bytes" ? [...i.bytes] : []))
		expect(bytes).toEqual([1, 2, 3, 4, 0xaa, 5, 6, 7, 8, 9])
		expect(engine.warnings().at(-1)?.suspected).toBe("iq-byte-slip")
		await engine.stop()
		void sources
	})
})

describe("cause 2: a strong transmitter with its images and IM lines ending together", () => {
	it("is signal-change when the transmitter keyed after startup: no new epoch, labels kept (2.9; frozen: a Δ-null unverified epoch)", () => {
		// Bystanders from the start; the transmitter keys at 2 s (past the startup window) for 10.6 s.
		// Two bystanders inside the usable span (−110 kHz is outside it): ALARM_MIN_SURVIVORS.
		const IN_VIEW: Tone[] = [
			[-90_000, 0.08],
			[-50_000, 0.08],
		]
		const end = Math.round(12.6 * FS)
		const h = play("U8_IQ", [
			u8(scene(8, IN_VIEW, 2)),
			u8(scene(3, [...TX, ...IN_VIEW], 10.6)),
			u8(scene(5, IN_VIEW, 1)),
		])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		expect(alarms[0]).toMatchObject({
			epoch: 1,
			deltaHz: null,
			suspected: "signal-change",
			newEpoch: false,
		})
		expect(alarms[0]!.startSample).toBeGreaterThan(end)
		expect(h.of("epoch-started").map(e => e.epoch)).toEqual([1])
		const late = h.tracks().filter(t => t.lastSample > end)
		expect(late.length).toBeGreaterThan(0)
		expect(
			late.every(t => t.epoch === 1 && t.tuningTrust === "commanded"),
		).toBe(true)
	}, 60_000)

	it("a strong transmitter open since startup gives no co-birth credit: its lines vanishing stay external-control", () => {
		const h = play("U8_IQ", [
			u8(scene(3, [...TX, ...BYSTANDERS], 10.6)),
			u8(scene(5, BYSTANDERS, 1)),
		])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		expect(alarms[0]).toMatchObject({ suspected: "external-control", epoch: 2 })
	}, 60_000)

	it("review R1 regression: a strong open carrier and a surviving feature, retuned beyond the view, is external-control with a new epoch", () => {
		// A weak feature from the start; a strong carrier and a line keyed together at 2 s. The
		// receiver then moves beyond the view: the new scene happens to cover only the old −60 kHz.
		const h = play("U8_IQ", [
			u8(scene(9, [[-60_000, 0.1]], 2)),
			u8(
				scene(
					10,
					[
						[-60_000, 0.1],
						[34_000, 0.5],
						[70_000, 0.05],
					],
					10.6,
				),
			),
			u8(
				scene(
					11,
					[
						[-60_000, 0.1],
						[15_000, 0.08],
					],
					1,
				),
			),
		])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		expect(alarms[0]).toMatchObject({ suspected: "external-control" })
		expect(alarms[0]).not.toHaveProperty("newEpoch")
		expect(h.of("epoch-started").some(e => e.epoch === alarms[0]!.epoch)).toBe(
			true,
		)
	}, 60_000)

	it("review WG10 R1 M2 regression: a strong open carrier with two wide persistent signals, retuned so a wide occupancy covers the old positions (Δ null), is a new unverified epoch", () => {
		// Two wide FM signals from the start; a strong carrier and two lines keyed together at 2 s
		// (past the startup window). The receiver then moves: one wide occupancy covers both old
		// wide positions, the carrier and its lines are gone. Before the fix: signal-change (the
		// open carrier counted as ended, the wide segment counted as both survivors).
		const wide = (seed: number, n: number): Iq => {
			const iq = analogFm(mulberry32(seed), n, FS, 20_000, 0.1, {
				rmsDeviationHz: 3000,
				ctcssHz: null,
			})
			addInto(
				iq,
				analogFm(mulberry32(seed + 1), n, FS, 45_000, 0.1, {
					rmsDeviationHz: 3000,
					ctcssHz: null,
				}),
			)
			return iq
		}
		const withWide = (seed: number, tones: Tone[], seconds: number): Iq => {
			const iq = scene(seed, tones, seconds)
			return addInto(iq, wide(seed + 100, iq.re.length))
		}
		// The new occupancy: random-phase tones every 1 kHz over 0..65 kHz (no impulse train); only
		// one line's mirror (+34 kHz) lands in it, so this is no I/Q mirror.
		const covered = (seed: number, seconds: number): Iq => {
			const iq = scene(seed, [], seconds)
			const rng = mulberry32(seed + 7)
			for (let o = 0; o <= 65_000; o += 1000)
				addInto(iq, tone(iq.re.length, FS, o, 0.03, 2 * Math.PI * rng()))
			return iq
		}
		const h = play("U8_IQ", [
			u8(withWide(20, [], 2)),
			u8(
				withWide(
					21,
					[
						[-34_000, 0.5],
						[-68_000, 0.05],
						[-90_000, 0.05],
					],
					10.6,
				),
			),
			u8(covered(22, 1)),
		])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		expect(alarms[0]).toMatchObject({
			deltaHz: null,
			suspected: "external-control",
		})
		expect(alarms[0]).not.toHaveProperty("newEpoch")
		expect(h.of("epoch-started").some(e => e.epoch === alarms[0]!.epoch)).toBe(
			true,
		)
		const late = h.tracks().filter(t => t.startSample > alarms[0]!.startSample)
		expect(late.every(t => t.tuningTrust === "unverified")).toBe(true)
	}, 60_000)

	it("everything vanishing (no bystander left) stays external-control with a new epoch (fail safe)", () => {
		const h = play("U8_IQ", [u8(scene(3, TX, 10.6)), u8(scene(5, [], 1))])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		expect(alarms[0]).toMatchObject({ suspected: "external-control", epoch: 2 })
		expect(alarms[0]).not.toHaveProperty("newEpoch")
	}, 30_000)

	it("weak features ending without a strong transmission stay external-control", () => {
		const weak: Tone[] = [...SCENE, [-100_000, 0.1]]
		const h = play("U8_IQ", [
			u8(scene(6, weak, 10.6)),
			u8(scene(7, weak.slice(4), 1)),
		])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		expect(alarms[0]?.suspected).toBe("external-control")
	}, 30_000)
})

describe("cause 3: a core command whose epoch lands a block late (ruled out)", () => {
	it("the engine posts the command's pending epoch before any byte that follows it", async () => {
		for (const origin of ["rest", "replay"] as const) {
			const { engine, fanout, inputs, tuner } = fakeEngine()
			await engine.start()
			fanout.write(Buffer.alloc(4096, 0x80))
			await settle()
			tuner.emit("command-sent", "rtl", "set-sample-rate", 1_024_000, origin)
			// Bytes arriving in the same tick as the command (before its microtask).
			fanout.write(Buffer.alloc(4096, 0x81))
			await settle()
			await new Promise(resolve => setTimeout(resolve, 40))
			const order = inputs
				.filter(i => i.kind === "pending-epoch" || i.kind === "bytes")
				.map(i => (i.kind === "bytes" ? `bytes:${i.bytes[0]}` : "pending"))
			const pending = order.indexOf("pending")
			expect(pending).toBeGreaterThanOrEqual(0)
			expect(order.slice(0, pending).every(o => o === "bytes:128")).toBe(true)
			expect(order.slice(pending + 1).every(o => o === "bytes:129")).toBe(true)
			await engine.stop()
		}
	})

	it("a pending epoch disarms the alarm: a retune right after a command never fires", () => {
		const h = play(
			"U8_IQ",
			[u8(scene(1, SCENE, 10.6)), u8(scene(2, moved(SCENE, -25_000), 1))],
			hh =>
				hh.pending({
					epoch: 2,
					centreHz: 446_100_000,
					centreChanged: false,
				}),
		)
		expect(h.of("untracked-retune")).toEqual([])
	}, 30_000)
})

describe("cause 4: a source reconnect (ruled out)", () => {
	it("a new stream disarms the alarm even when the scene moved across it", () => {
		const h = play(
			"U8_IQ",
			[u8(scene(1, SCENE, 10.6)), u8(scene(2, moved(SCENE, -25_000), 1))],
			hh => {
				hh.send({
					kind: "new-stream",
					stream: 2,
					centreHz: 446_100_000,
					sampleRateHz: FS,
					gainKey: "m:496",
					tuningTrust: "commanded",
				})
				hh.sample = 0
			},
		)
		expect(h.of("untracked-retune")).toEqual([])
	}, 30_000)
})

function recordingHost(
	handlers: PipelineHostHandlers,
	inputs: PipelineInput[],
): PipelineHost {
	return {
		send(input: PipelineInput, transfer?: ArrayBuffer): void {
			inputs.push(
				input.kind === "bytes"
					? { ...input, bytes: Uint8Array.from(input.bytes) }
					: input,
			)
			if (transfer) handlers.buffer(transfer)
		},
		exportState(): Promise<EngineState> {
			return Promise.resolve({
				version: 1,
				absoluteFloors: [],
				spurs: [],
				kByRange: [],
			})
		},
		utilization: () => null,
		close: () => Promise.resolve(),
	}
}

function fakeEngine() {
	const sources = new FakeSources()
	const fanout = new FakeFanout()
	const tuner = new FakeTuner()
	const inputs: PipelineInput[] = []
	let h: PipelineHostHandlers | null = null
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources,
		routing: {
			getFanout: () => fanout as never,
			releaseUnused: () => undefined,
		},
		tuner,
		settings: () => testSettings(),
		logger,
		createHost: (_cfg, handlers) => {
			h = handlers
			return recordingHost(handlers, inputs)
		},
		batchBytes: 4096,
	})
	return {
		engine,
		sources,
		fanout,
		tuner,
		inputs,
		handlers: (): { events: (ev: PipelineEvent[]) => void } | null => h,
	}
}
