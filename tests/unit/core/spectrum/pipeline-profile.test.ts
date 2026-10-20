import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { SpectrumPipeline } from "../../../../src/core/spectrum/pipeline.js"
import type {
	EngineState,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import {
	MainToWorkerSchema,
	WorkerToMainSchema,
} from "../../../../src/core/spectrum/worker-protocol.js"
import {
	gaussianNoise,
	mulberry32,
	packF32,
} from "../../../mocks/scanner/signals.js"
import {
	BLOCK,
	CENTRE,
	FS,
	Harness,
	N,
	pipelineConfig,
} from "./pipeline-harness.js"

const baseGolden = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("./fixtures/pipeline-export-base.json", import.meta.url),
		),
		"utf8",
	),
) as EngineState

/** Serialized export: the base fixture has no undefined keys. */
function exported(state: EngineState): EngineState {
	return JSON.parse(JSON.stringify(state)) as EngineState
}

const STAGES = [
	"window",
	"fft",
	"power",
	"frameDb",
	"floor",
	"detector",
	"gate",
	"tracker",
	"wire",
] as const

interface ProfileShape {
	blocks: number
	busyMs: number
	stages: Record<(typeof STAGES)[number], number>
}

function feed(pipeline: SpectrumPipeline, bytes: Uint8Array): void {
	const send = (input: PipelineInput): void => {
		pipeline.handle(input)
	}
	send({
		kind: "masks",
		exclusions: [],
		cfarRanges: [],
		burstRanges: [],
		rasters: [],
		obwHz: [],
		inWindow: true,
	})
	send({ kind: "spectrum-feed", enabled: true })
	send({
		kind: "new-stream",
		stream: 1,
		centreHz: CENTRE,
		sampleRateHz: FS,
		gainKey: "m:496",
		tuningTrust: "commanded",
	})
	const step = 4096 * 8
	let sample = 0
	for (let off = 0; off < bytes.length; off += step) {
		const part = bytes.subarray(off, Math.min(bytes.length, off + step))
		send({ kind: "bytes", startSample: sample, bytes: part })
		sample += part.length / 8
	}
}

function profileOf(state: EngineState): ProfileShape | undefined {
	if (!Object.hasOwn(state, "profile")) return undefined
	return (state as EngineState & { profile?: ProfileShape }).profile
}

function withoutProfile(state: EngineState): EngineState {
	if (!Object.hasOwn(state, "profile")) return state
	const { profile: _profile, ...rest } = state as EngineState & {
		profile?: ProfileShape
	}
	return rest
}

const iq = gaussianNoise(mulberry32(20261018), 100 * BLOCK, 0.05)
const bytes = packF32(iq.re, iq.im)

describe("spectrum pipeline profile", () => {
	it("omits profile from export-state and matches the base export fixture", () => {
		const harness = new Harness({ format: "FLOAT32LE" })
		harness.start()
		harness.pushBytes(bytes)
		const golden = harness.pipeline.exportEngineState()
		expect(golden).not.toHaveProperty("profile")
		expect(Object.hasOwn(golden, "profile")).toBe(false)
		expect(exported(golden)).toEqual(baseGolden)

		const plain = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
			},
		)
		feed(plain, bytes)
		const state = plain.exportEngineState()
		expect(state).not.toHaveProperty("profile")
		expect(exported(state)).toEqual(baseGolden)
		expect(JSON.stringify(state)).not.toContain('"profile"')
	})

	it("samples one block in sampleEvery and reports every stage", () => {
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{ now: () => 0, profile: { sampleEvery: 10 } },
		)
		feed(pipeline, bytes)
		const state = pipeline.exportEngineState()
		const profile = profileOf(state)
		expect(profile).toBeDefined()
		expect(profile?.blocks).toBe(10)
		expect(profile?.busyMs).toBeGreaterThanOrEqual(0)
		for (const stage of STAGES) {
			expect(profile?.stages[stage]).toBeGreaterThanOrEqual(0)
		}
		expect(profile?.stages.gate).toBe(0)

		const harness = new Harness({ format: "FLOAT32LE" })
		harness.start()
		harness.pushBytes(bytes)
		expect(withoutProfile(state)).toEqual(harness.pipeline.exportEngineState())
	})

	it("charges per-frame dB conversion separately from tracker work", () => {
		let clock = 0
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
				profile: { sampleEvery: 1 },
				profileNow: () => ++clock,
			},
		)
		feed(pipeline, bytes.subarray(0, BLOCK * 8))
		const tracker = (pipeline as unknown as { tracker: object }).tracker
		// Force the frame conversion path independently of detector thresholds.
		Object.defineProperty(tracker, "openCount", { get: () => 1 })
		pipeline.handle({
			kind: "bytes",
			startSample: BLOCK,
			bytes: bytes.subarray(BLOCK * 8, 3 * BLOCK * 8),
		})
		const profile = profileOf(pipeline.exportEngineState())
		expect(profile?.stages.frameDb).toBeGreaterThan(0)
		expect(profile?.stages.tracker).toBeGreaterThan(0)
	})

	it("round-trips profile on the export-state reply only when present", () => {
		const base = {
			version: 1 as const,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		}
		const plain = WorkerToMainSchema.parse({
			type: "engine-state",
			requestId: 1,
			state: base,
		})
		expect(plain.type).toBe("engine-state")
		if (plain.type !== "engine-state") return
		expect(plain.state).not.toHaveProperty("profile")
		expect(plain.state).toEqual(base)

		const stages = {
			window: 0,
			fft: 1,
			power: 0,
			frameDb: 0,
			floor: 0,
			detector: 0,
			gate: 0,
			tracker: 0,
			wire: 0,
		}
		const withProfile = WorkerToMainSchema.parse({
			type: "engine-state",
			requestId: 2,
			state: { ...base, profile: { blocks: 10, busyMs: 1, stages } },
		})
		expect(withProfile.type).toBe("engine-state")
		if (withProfile.type !== "engine-state") return
		expect(withProfile.state).toEqual({
			...base,
			profile: { blocks: 10, busyMs: 1, stages },
		})

		const init = MainToWorkerSchema.parse({
			type: "init",
			config: pipelineConfig({ fftSize: 512 }),
			profile: { sampleEvery: 10 },
		})
		expect(init.type).toBe("init")
		if (init.type !== "init") return
		expect(init.profile).toEqual({ sampleEvery: 10 })
	})

	it("rejects a profile whose numbers are not finite", () => {
		const base = {
			version: 1 as const,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		}
		const stages = {
			window: 0,
			fft: 0,
			power: 0,
			frameDb: 0,
			floor: 0,
			detector: 0,
			gate: 0,
			tracker: 0,
			wire: 0,
		}
		for (const busyMs of [Number.POSITIVE_INFINITY, Number.NaN]) {
			const parsed = WorkerToMainSchema.safeParse({
				type: "engine-state",
				requestId: 3,
				state: { ...base, profile: { blocks: 1, busyMs, stages } },
			})
			expect(parsed.success).toBe(false)
		}
		const infStage = WorkerToMainSchema.safeParse({
			type: "engine-state",
			requestId: 4,
			state: {
				...base,
				profile: {
					blocks: 1,
					busyMs: 1,
					stages: { ...stages, floor: Number.POSITIVE_INFINITY },
				},
			},
		})
		expect(infStage.success).toBe(false)
		const nanStage = WorkerToMainSchema.safeParse({
			type: "engine-state",
			requestId: 5,
			state: {
				...base,
				profile: {
					blocks: 1,
					busyMs: 1,
					stages: { ...stages, window: Number.NaN },
				},
			},
		})
		expect(nanStage.success).toBe(false)
	})

	it("does not read the profile clock when profiling is off", () => {
		let calls = 0
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
				profileNow: () => {
					calls++
					return 0
				},
			},
		)
		feed(pipeline, bytes)
		expect(calls).toBe(0)
		expect(pipeline.wireSpanOpen()).toBe(false)
		pipeline.chargeWireSpan(5)
		expect(pipeline.exportEngineState()).not.toHaveProperty("profile")
	})

	it("stage time sums to busy, including finalization after a gap", () => {
		let t = 0
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
				profile: { sampleEvery: 1 },
				profileNow: () => t,
			},
		)
		const floor = (
			pipeline as unknown as {
				floor: {
					blockFloor: (powerDb: Float32Array, unmasked: Uint8Array) => number
				}
			}
		).floor
		const orig = floor.blockFloor.bind(floor)
		floor.blockFloor = (powerDb, unmasked) => {
			t += 100
			return orig(powerDb, unmasked)
		}
		const frame = bytes.subarray(0, N * 8)
		const send = (input: PipelineInput): void => {
			pipeline.handle(input)
		}
		send({
			kind: "masks",
			exclusions: [],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
		})
		send({ kind: "spectrum-feed", enabled: true })
		send({
			kind: "new-stream",
			stream: 1,
			centreHz: CENTRE,
			sampleRateHz: FS,
			gainKey: "m:496",
			tuningTrust: "commanded",
		})
		// One frame, a gap into the next block, then one more frame.
		// Finalization of the first block runs before the second frame's span.
		send({ kind: "bytes", startSample: 0, bytes: frame })
		send({ kind: "gap", startSample: N, samples: BLOCK })
		send({ kind: "bytes", startSample: N + BLOCK, bytes: frame })
		const profile = profileOf(pipeline.exportEngineState())
		expect(profile).toBeDefined()
		expect(profile?.blocks).toBe(1)
		expect(profile?.stages.floor).toBeCloseTo(100, 6)
		expect(profile?.busyMs).toBeCloseTo(100, 6)
		expect(stageSum(profile!)).toBeCloseTo(profile!.busyMs, 6)
	})

	it("counts a full block's finalization once", () => {
		let t = 0
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
				profile: { sampleEvery: 1 },
				profileNow: () => t,
			},
		)
		const floor = (
			pipeline as unknown as {
				floor: {
					blockFloor: (powerDb: Float32Array, unmasked: Uint8Array) => number
				}
			}
		).floor
		const orig = floor.blockFloor.bind(floor)
		floor.blockFloor = (powerDb, unmasked) => {
			t += 100
			return orig(powerDb, unmasked)
		}
		const pipelineBytes = bytes.subarray(0, BLOCK * 8)
		feed(pipeline, pipelineBytes)
		const profile = profileOf(pipeline.exportEngineState())
		expect(profile?.blocks).toBe(1)
		expect(profile?.stages.floor).toBeGreaterThan(0)
		expect(stageSum(profile!)).toBeCloseTo(profile!.busyMs, 6)
		expect(profile?.busyMs).toBeCloseTo(profile!.stages.floor, 6)
	})

	it("charges frameless chunk work on a sampled block to window and busy", () => {
		let t = 0
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
				profile: { sampleEvery: 1 },
				profileNow: () => t,
			},
		)
		const frame = bytes.subarray(0, N * 8)
		const send = (input: PipelineInput): void => {
			pipeline.handle(input)
		}
		send({
			kind: "masks",
			exclusions: [],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
		})
		send({ kind: "spectrum-feed", enabled: true })
		send({
			kind: "new-stream",
			stream: 1,
			centreHz: CENTRE,
			sampleRateHz: FS,
			gainKey: "m:496",
			tuningTrust: "commanded",
		})
		const frames = (
			pipeline as unknown as {
				frames: { append: (part: Uint8Array) => void }
			}
		).frames
		const orig = frames.append.bind(frames)
		frames.append = (part: Uint8Array) => {
			t += 100
			orig(part)
		}
		send({ kind: "bytes", startSample: 0, bytes: frame })
		const before = profileOf(pipeline.exportEngineState())
		const one = bytes.subarray(0, 8)
		send({ kind: "bytes", startSample: N, bytes: one })
		const after = profileOf(pipeline.exportEngineState())
		expect(after).toBeDefined()
		expect(
			(after?.stages.window ?? 0) - (before?.stages.window ?? 0),
		).toBeCloseTo(100, 6)
		expect((after?.busyMs ?? 0) - (before?.busyMs ?? 0)).toBeCloseTo(100, 6)
		expect(stageSum(after!)).toBeCloseTo(after!.busyMs, 6)
	})

	it("adds a worker wire span to wire and busy", () => {
		const pipeline = new SpectrumPipeline(
			pipelineConfig({ format: "FLOAT32LE" }),
			{
				now: () => 0,
				profile: { sampleEvery: 10 },
				profileNow: () => 0,
			},
		)
		const send = (input: PipelineInput): void => {
			pipeline.handle(input)
			if (pipeline.wireSpanOpen()) pipeline.chargeWireSpan(7)
		}
		send({
			kind: "masks",
			exclusions: [],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
		})
		send({ kind: "spectrum-feed", enabled: true })
		send({
			kind: "new-stream",
			stream: 1,
			centreHz: CENTRE,
			sampleRateHz: FS,
			gainKey: "m:496",
			tuningTrust: "commanded",
		})
		const step = 4096 * 8
		let sample = 0
		for (let off = 0; off < bytes.length; off += step) {
			const part = bytes.subarray(off, Math.min(bytes.length, off + step))
			send({ kind: "bytes", startSample: sample, bytes: part })
			sample += part.length / 8
		}
		const profile = profileOf(pipeline.exportEngineState())
		expect(profile?.blocks).toBe(10)
		expect(profile?.stages.wire).toBeCloseTo(70, 6)
		expect(profile?.busyMs).toBeCloseTo(70, 6)
		expect(stageSum(profile!)).toBeCloseTo(profile!.busyMs, 6)
	})
})

function stageSum(profile: ProfileShape): number {
	return STAGES.reduce((sum, stage) => sum + profile.stages[stage], 0)
}
