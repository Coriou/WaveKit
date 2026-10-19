/**
 * Golden vectors for the Rust demod gates and noise meter.
 *
 * Set WAVEKIT_WRITE_DEMOD_VECTORS=1 to (re)write
 * native/wavekit-chan/tests/fixtures/demod/*.json. Otherwise the committed
 * files must equal the vectors computed here from ChannelSquelch and
 * NoiseSquelch. IQ is hex of little-endian f32 pairs so NaN bits survive;
 * quieting uses null / "inf" / "-inf" because JSON has no NaN or Infinity.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ChannelSquelch } from "../../../../src/core/channel-squelch.js"
import {
	NoiseSquelch,
	noiseReferenceCutoff,
	noiseReferenceMeanSquare,
} from "../../../../src/core/noise-squelch.js"
import { FmChannelSynth, mulberry32 } from "../fm-synth.js"

const FIXTURE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../native/wavekit-chan/tests/fixtures/demod",
)

const POWER_FLOOR_DBFS = -160

interface PowerStepIn {
	levelDbfs?: number
	iq?: Buffer
	setFloor?: number | null
}

interface PowerStepOut {
	levelDbfs: number
	open: boolean
	iqHex: string
	setFloor?: boolean
	floorDbfs?: number | null
}

interface PowerScenario {
	name: string
	thresholdDbfs: number | null
	hysteresisDb: number
	hangMs: number
	blockMs: number
	steps: PowerStepOut[]
}

interface NoiseBlockOut {
	iqHex: string
	quietingDb: number | "inf" | "-inf" | null
	open: boolean
}

function blockPowerDbfs(block: Buffer): number {
	const samples = block.length / 8
	if (!(samples > 0)) return POWER_FLOOR_DBFS
	let sum = 0
	for (let offset = 0; offset < block.length; offset += 4) {
		const value = block.readFloatLE(offset)
		if (Number.isFinite(value)) sum += value * value
	}
	const power = sum / samples
	if (!(power > 0)) return POWER_FLOOR_DBFS
	return Math.max(POWER_FLOOR_DBFS, 10 * Math.log10(power))
}

/** Constant-I tone whose power is about `levelDbfs`. The stored level is remeasured. */
function iqForLevel(levelDbfs: number, samples: number): Buffer {
	const amplitude = 10 ** (levelDbfs / 20)
	const block = Buffer.alloc(samples * 8)
	for (let i = 0; i < samples; i++) {
		block.writeFloatLE(amplitude, i * 8)
		block.writeFloatLE(0, i * 8 + 4)
	}
	return block
}

function runPower(spec: {
	name: string
	sampleRate: number
	blockMs: number
	thresholdDbfs: number | null
	hysteresisDb: number
	hangMs: number
	steps: PowerStepIn[]
}): PowerScenario {
	const samples = Math.max(
		1,
		Math.round((spec.sampleRate * spec.blockMs) / 1000),
	)
	const blockMs = (samples / spec.sampleRate) * 1000
	const gate = new ChannelSquelch({
		sampleRate: spec.sampleRate,
		blockMs: spec.blockMs,
		thresholdDbfs: spec.thresholdDbfs,
		hysteresisDb: spec.hysteresisDb,
		hangMs: spec.hangMs,
		bandwidthHz: spec.sampleRate / 2,
	})
	const steps = spec.steps.map(step => {
		const iq = Buffer.from(
			step.iq ?? iqForLevel(step.levelDbfs ?? POWER_FLOOR_DBFS, samples),
		)
		if ("setFloor" in step) gate.setNoiseFloorDbfs(step.setFloor ?? null)
		gate.process(iq)
		const recorded: PowerStepOut = {
			levelDbfs: blockPowerDbfs(iq),
			open: gate.open,
			iqHex: iq.toString("hex"),
		}
		if ("setFloor" in step) {
			recorded.setFloor = true
			recorded.floorDbfs = step.setFloor ?? null
		}
		return recorded
	})
	return {
		name: spec.name,
		thresholdDbfs: spec.thresholdDbfs,
		hysteresisDb: spec.hysteresisDb,
		hangMs: spec.hangMs,
		blockMs,
		steps,
	}
}

function gaussianBlock(
	rand: () => number,
	samples: number,
	sigma: number,
): Buffer {
	const block = Buffer.alloc(samples * 8)
	for (let i = 0; i < samples; i++) {
		const u1 = Math.max(rand(), 1e-300)
		const u2 = rand()
		const radius = sigma * Math.sqrt(-2 * Math.log(u1))
		const angle = 2 * Math.PI * u2
		block.writeFloatLE(radius * Math.cos(angle), i * 8)
		block.writeFloatLE(radius * Math.sin(angle), i * 8 + 4)
	}
	return block
}

function encodeQuieting(value: number | null): number | "inf" | "-inf" | null {
	if (value === null || Number.isNaN(value)) return null
	if (value === Number.POSITIVE_INFINITY) return "inf"
	if (value === Number.NEGATIVE_INFINITY) return "-inf"
	return value
}

function sameQuieting(a: number | null, b: number | null): boolean {
	if (a === null || b === null) return a === b
	if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b
	return a === b
}

function runNoise(spec: {
	name: string
	sampleRate: number
	bandwidthHz: number
	quietingDb: number
	hysteresisDb: number
	hangMs: number
	blockMs: number
	blocks: Buffer[]
}): {
	name: string
	sampleRateHz: number
	bandwidthHz: number
	quietingDb: number
	hysteresisDb: number
	hangMs: number
	blockMs: number
	referenceMeanSquare: number
	blocks: NoiseBlockOut[]
} {
	const samples = Math.max(
		1,
		Math.round((spec.sampleRate * spec.blockMs) / 1000),
	)
	const blockMs = (samples / spec.sampleRate) * 1000
	const channel = new ChannelSquelch({
		sampleRate: spec.sampleRate,
		bandwidthHz: spec.bandwidthHz,
		blockMs: spec.blockMs,
		thresholdDbfs: -90,
		hysteresisDb: spec.hysteresisDb,
		hangMs: spec.hangMs,
		mode: "noise",
		noiseQuietingDb: spec.quietingDb,
	})
	const meter = new NoiseSquelch({
		sampleRate: spec.sampleRate,
		bandwidthHz: spec.bandwidthHz,
		quietingDb: spec.quietingDb,
		hysteresisDb: spec.hysteresisDb,
		hangMs: spec.hangMs,
	})
	const blocks = spec.blocks.map(source => {
		if (source.length !== samples * 8) {
			throw new Error(
				`${spec.name}: block is ${source.length} bytes, want ${samples * 8}`,
			)
		}
		const iq = Buffer.from(source)
		channel.process(Buffer.from(iq))
		const open = meter.processBlock(Buffer.from(iq))
		if (channel.open !== open) {
			throw new Error(
				`${spec.name}: ChannelSquelch and NoiseSquelch gates diverged`,
			)
		}
		const fromChannel = channel.noiseQuietingLevelDb
		const fromMeter = meter.lastQuietingDb
		if (!sameQuieting(fromChannel, fromMeter)) {
			throw new Error(
				`${spec.name}: quieting ${String(fromChannel)} vs ${String(fromMeter)}`,
			)
		}
		return {
			iqHex: iq.toString("hex"),
			quietingDb: encodeQuieting(fromMeter),
			open,
		}
	})
	return {
		name: spec.name,
		sampleRateHz: spec.sampleRate,
		bandwidthHz: spec.bandwidthHz,
		quietingDb: spec.quietingDb,
		hysteresisDb: spec.hysteresisDb,
		hangMs: spec.hangMs,
		blockMs,
		referenceMeanSquare: noiseReferenceMeanSquare(
			spec.sampleRate,
			spec.bandwidthHz,
		),
		blocks,
	}
}

function buildGates(): { scenarios: PowerScenario[] } {
	const common = { sampleRate: 1000, blockMs: 10, hysteresisDb: 2, hangMs: 30 }
	const nanIq = iqForLevel(-28, 10)
	nanIq.writeFloatLE(Number.NaN, 2 * 8)
	nanIq.writeFloatLE(Number.POSITIVE_INFINITY, 6 * 8 + 4)
	const loud = iqForLevel(-30, 10)
	const atThreshold = blockPowerDbfs(loud)
	const seededRand = mulberry32(0x6a7e5eed)
	const seeded: PowerStepIn[] = []
	for (let i = 0; i < 24; i++) {
		const step: PowerStepIn = { levelDbfs: -70 + seededRand() * 55 }
		if (i === 4) step.setFloor = -48
		if (i === 12) step.setFloor = -60
		if (i === 18) step.setFloor = null
		seeded.push(step)
	}
	return {
		scenarios: [
			runPower({
				...common,
				name: "open-hold-close",
				thresholdDbfs: -40,
				steps: [-55, -25, -41, -55, -55, -55].map(levelDbfs => ({ levelDbfs })),
			}),
			runPower({
				...common,
				name: "hysteresis-holds",
				thresholdDbfs: -40,
				hangMs: 20,
				steps: [-55, -25, -41, -41, -41, -41].map(levelDbfs => ({ levelDbfs })),
			}),
			runPower({
				...common,
				name: "noise-tail-floor",
				thresholdDbfs: -40,
				hangMs: 20,
				steps: [
					{ levelDbfs: -70, setFloor: -42 },
					{ levelDbfs: -20 },
					{ levelDbfs: -41 },
					{ levelDbfs: -41 },
				],
			}),
			runPower({
				...common,
				name: "floor-frozen-while-open",
				thresholdDbfs: -40,
				steps: [
					{ levelDbfs: -70, setFloor: -55 },
					{ levelDbfs: -20 },
					{ levelDbfs: -41, setFloor: -36 },
					{ levelDbfs: -60 },
					{ levelDbfs: -60 },
					{ levelDbfs: -60 },
				],
			}),
			runPower({
				...common,
				name: "floor-cleared-while-open",
				thresholdDbfs: -40,
				steps: [
					{ levelDbfs: -70, setFloor: -42 },
					{ levelDbfs: -20 },
					{ levelDbfs: -41, setFloor: null },
					{ levelDbfs: -70 },
					{ levelDbfs: -70 },
					{ levelDbfs: -70 },
				],
			}),
			runPower({
				...common,
				name: "disabled-null",
				thresholdDbfs: null,
				steps: [-120, -40, -160].map(levelDbfs => ({ levelDbfs })),
			}),
			runPower({
				...common,
				name: "disabled-zero",
				thresholdDbfs: 0,
				steps: [-80, -20].map(levelDbfs => ({ levelDbfs })),
			}),
			runPower({
				...common,
				name: "disabled-positive",
				thresholdDbfs: 5,
				steps: [-80, -10].map(levelDbfs => ({ levelDbfs })),
			}),
			runPower({
				...common,
				name: "exact-threshold",
				thresholdDbfs: atThreshold,
				hangMs: 50,
				steps: [
					{ iq: iqForLevel(-55, 10) },
					{ iq: loud },
					{ iq: iqForLevel(-31, 10) },
					{ iq: iqForLevel(-55, 10) },
				],
			}),
			runPower({
				...common,
				name: "non-finite-component",
				thresholdDbfs: -40,
				steps: [{ iq: nanIq }, { levelDbfs: -70 }],
			}),
			runPower({
				name: "seeded-walk",
				sampleRate: 1000,
				blockMs: 10,
				thresholdDbfs: -35,
				hysteresisDb: 3,
				hangMs: 40,
				steps: seeded,
			}),
		],
	}
}

function buildNoise(): {
	scenarios: ReturnType<typeof runNoise>[]
} {
	const sampleRate = 8000
	const bandwidthHz = sampleRate / 2
	const samples = 80
	const rand = mulberry32(0x51ad01)
	const synth = new FmChannelSynth({
		sampleRate,
		bandwidthHz,
		seed: 0x51ad,
		cnrDb: 30,
		deviationHz: 1500,
		offsetHz: 250,
		phase: 0.3,
		audio: "silence",
		blockMs: 10,
		noiseTaps: 15,
	})
	const punched = gaussianBlock(rand, samples, 0.5)
	punched.writeFloatLE(Number.NaN, 40 * 8)
	const scaleRand = mulberry32(0x0c0ffee)
	const tailRand = mulberry32(0xabc)
	return {
		scenarios: [
			runNoise({
				name: "mixed-carrier",
				sampleRate,
				bandwidthHz,
				quietingDb: 6,
				hysteresisDb: 2,
				hangMs: 30,
				blockMs: 10,
				blocks: [
					gaussianBlock(rand, samples, 0.4),
					gaussianBlock(rand, samples, 0.4),
					gaussianBlock(rand, samples, 0.4),
					Buffer.from(synth.next()),
					Buffer.from(synth.next()),
					Buffer.from(synth.next()),
					Buffer.from(synth.next()),
					punched,
					gaussianBlock(rand, samples, 0.8),
					gaussianBlock(rand, samples, 0.8),
					gaussianBlock(rand, samples, 0.8),
					gaussianBlock(rand, samples, 0.8),
				],
			}),
			runNoise({
				name: "scale-free",
				sampleRate,
				bandwidthHz,
				quietingDb: 6,
				hysteresisDb: 2,
				hangMs: 30,
				blockMs: 10,
				blocks: [0.2, 0.02, 1.5].map(sigma =>
					gaussianBlock(scaleRand, samples, sigma),
				),
			}),
			runNoise({
				name: "zeros-then-noise",
				sampleRate,
				bandwidthHz,
				quietingDb: 6,
				hysteresisDb: 2,
				hangMs: 30,
				blockMs: 10,
				blocks: [
					Buffer.alloc(samples * 8),
					gaussianBlock(tailRand, samples, 0.5),
					gaussianBlock(tailRand, samples, 0.5),
				],
			}),
		],
	}
}

function commit(name: string, value: unknown, maxBytes = 180 * 1024): string {
	const text = `${JSON.stringify(value, null, "\t")}\n`
	expect(Buffer.byteLength(text)).toBeLessThan(maxBytes)
	const path = join(FIXTURE_DIR, name)
	if (process.env["WAVEKIT_WRITE_DEMOD_VECTORS"] === "1") {
		mkdirSync(FIXTURE_DIR, { recursive: true })
		writeFileSync(path, text)
	}
	expect(readFileSync(path, "utf8")).toBe(text)
	return text
}

/**
 * Channel IQ for `noise-bandwidth.json`. The Rust baseline generator in
 * `native/wavekit-chan/tests/noise_baseline.rs` repeats these steps.
 *
 * 1. `mulberry32(seed)` (audio-tones/synth.ts).
 * 2. One complex Box-Muller sample per input. FM scales each component by
 *    `sqrt(10^(-cnr/10) / 2)`; white, coloured and DC use scale 1.
 * 3. Coloured: `y = 0.5 y + sqrt(0.75) x` on I and on Q, starting from 0.
 * 4. DC: add 0.01 to I.
 * 5. FM, from input index `carrierAtSample`: `phase += 2π · 2500 · sin(2π · tone · t) / 48000`,
 *    then add `e^{j phase}`.
 * 6. 63-tap Blackman low-pass at `noiseReferenceCutoff`, unity DC (the reference
 *    filter in noise-squelch.ts). Output sample n uses inputs n..n+62.
 * 7. Float32 LE, then 480-sample blocks. `NoiseSquelch` measures each block.
 */
const BANDWIDTH_RATE_HZ = 48_000
const BANDWIDTH_BLOCK_SAMPLES = 480
const BANDWIDTH_TAPS = 63
const BANDWIDTH_DEVIATION_HZ = 2_500

function mixSeed(kind: number, bandwidthHz: number, salt: number): number {
	const mixed =
		(Math.imul(salt, 0x9e3779b1) ^
			Math.imul(kind, 0x85ebca6b) ^
			Math.imul(bandwidthHz, 0xc2b2ae35)) >>>
		0
	return mixed === 0 ? 1 : mixed
}

function blackmanLowPass(cutoff: number, length: number): Float64Array {
	const taps = new Float64Array(length)
	const mid = (length - 1) / 2
	let sum = 0
	for (let k = 0; k < length; k++) {
		const x = k - mid
		const sinc =
			x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
		const w =
			0.42 -
			0.5 * Math.cos((2 * Math.PI * k) / (length - 1)) +
			0.08 * Math.cos((4 * Math.PI * k) / (length - 1))
		taps[k] = sinc * w
		sum += sinc * w
	}
	for (let k = 0; k < length; k++) taps[k] = (taps[k] ?? 0) / sum
	return taps
}

function bandwidthIq(spec: {
	bandwidthHz: number
	seed: number
	kind: "white" | "coloured" | "dc" | "fm"
	cnrDb: number | null
	toneHz: number | null
	carrierAtSample: number
	samples: number
}): Buffer {
	const cutoff = noiseReferenceCutoff(BANDWIDTH_RATE_HZ, spec.bandwidthHz)
	const taps = blackmanLowPass(cutoff, BANDWIDTH_TAPS)
	const total = spec.samples + BANDWIDTH_TAPS - 1
	const rand = mulberry32(spec.seed)
	const xi = new Float64Array(total)
	const xq = new Float64Array(total)
	let arI = 0
	let arQ = 0
	let phase = 0
	const noiseScale =
		spec.kind === "fm" ? Math.sqrt(10 ** (-(spec.cnrDb ?? 0) / 10) / 2) : 1
	const coloured = spec.kind === "coloured"
	const dc = spec.kind === "dc" ? 0.01 : 0
	const sqrt075 = Math.sqrt(0.75)
	for (let n = 0; n < total; n++) {
		const u = Math.max(rand(), 1e-300)
		const v = rand()
		const radius = Math.sqrt(-2 * Math.log(u))
		const angle = 2 * Math.PI * v
		let i = noiseScale * radius * Math.cos(angle)
		let q = noiseScale * radius * Math.sin(angle)
		if (coloured) {
			arI = 0.5 * arI + sqrt075 * i
			arQ = 0.5 * arQ + sqrt075 * q
			i = arI
			q = arQ
		}
		i += dc
		if (spec.kind === "fm" && n >= spec.carrierAtSample) {
			const t = n / BANDWIDTH_RATE_HZ
			phase +=
				(2 *
					Math.PI *
					BANDWIDTH_DEVIATION_HZ *
					Math.sin(2 * Math.PI * (spec.toneHz ?? 0) * t)) /
				BANDWIDTH_RATE_HZ
			i += Math.cos(phase)
			q += Math.sin(phase)
		}
		xi[n] = i
		xq[n] = q
	}
	const out = Buffer.alloc(spec.samples * 8)
	for (let n = 0; n < spec.samples; n++) {
		let i = 0
		let q = 0
		for (let k = 0; k < BANDWIDTH_TAPS; k++) {
			const h = taps[k] ?? 0
			i += h * (xi[n + k] ?? 0)
			q += h * (xq[n + k] ?? 0)
		}
		out.writeFloatLE(i, n * 8)
		out.writeFloatLE(q, n * 8 + 4)
	}
	return out
}

function buildBandwidthNoise() {
	const bandwidths = [2_500, 6_250, 12_500, 25_000]
	const kinds: {
		kind: "white" | "coloured" | "dc" | "fm"
		code: number
		blocks: number
		carrierAtBlock: number
		cnrDb: number | null
		toneHz: number | null
	}[] = [
		{
			kind: "white",
			code: 0,
			blocks: 3,
			carrierAtBlock: 0,
			cnrDb: null,
			toneHz: null,
		},
		{
			kind: "coloured",
			code: 1,
			blocks: 3,
			carrierAtBlock: 0,
			cnrDb: null,
			toneHz: null,
		},
		{
			kind: "dc",
			code: 2,
			blocks: 3,
			carrierAtBlock: 0,
			cnrDb: null,
			toneHz: null,
		},
		{
			kind: "fm",
			code: 3,
			blocks: 4,
			carrierAtBlock: 2,
			cnrDb: 6,
			toneHz: 1_000,
		},
		{
			kind: "fm",
			code: 4,
			blocks: 4,
			carrierAtBlock: 2,
			cnrDb: 6,
			toneHz: 2_500,
		},
		{
			kind: "fm",
			code: 5,
			blocks: 4,
			carrierAtBlock: 2,
			cnrDb: 10,
			toneHz: 1_000,
		},
		{
			kind: "fm",
			code: 6,
			blocks: 4,
			carrierAtBlock: 2,
			cnrDb: 10,
			toneHz: 2_500,
		},
	]
	const scenarios: Array<
		ReturnType<typeof runNoise> & {
			kind: "white" | "coloured" | "dc" | "fm"
			kindCode: number
			seed: number
			cnrDb: number | null
			toneHz: number | null
			carrierAtSample: number
			deviationHz: number
		}
	> = []
	for (const bandwidthHz of bandwidths) {
		for (const kind of kinds) {
			const seed = mixSeed(kind.code, bandwidthHz, 1)
			const carrierAtSample = kind.carrierAtBlock * BANDWIDTH_BLOCK_SAMPLES
			const iq = bandwidthIq({
				bandwidthHz,
				seed,
				kind: kind.kind,
				cnrDb: kind.cnrDb,
				toneHz: kind.toneHz,
				carrierAtSample,
				samples: kind.blocks * BANDWIDTH_BLOCK_SAMPLES,
			})
			const blocks = []
			const bytes = BANDWIDTH_BLOCK_SAMPLES * 8
			for (let block = 0; block < kind.blocks; block++) {
				blocks.push(
					Buffer.from(iq.subarray(block * bytes, (block + 1) * bytes)),
				)
			}
			const tone = kind.toneHz === null ? "" : `-tone${kind.toneHz}`
			const cnr = kind.cnrDb === null ? "" : `-cnr${kind.cnrDb}`
			const measured = runNoise({
				name: `${bandwidthHz}-${kind.kind}${cnr}${tone}`,
				sampleRate: BANDWIDTH_RATE_HZ,
				bandwidthHz,
				quietingDb: 6,
				hysteresisDb: 2,
				hangMs: 0,
				blockMs: 10,
				blocks,
			})
			scenarios.push({
				...measured,
				kind: kind.kind,
				kindCode: kind.code,
				seed,
				cnrDb: kind.cnrDb,
				toneHz: kind.toneHz,
				carrierAtSample,
				deviationHz: BANDWIDTH_DEVIATION_HZ,
			})
		}
	}
	return {
		sampleRateHz: BANDWIDTH_RATE_HZ,
		blockSamples: BANDWIDTH_BLOCK_SAMPLES,
		filterTaps: BANDWIDTH_TAPS,
		deviationHz: BANDWIDTH_DEVIATION_HZ,
		scenarios,
	}
}

describe("demod golden vectors", () => {
	it("matches the committed ChannelSquelch and NoiseSquelch vectors", () => {
		const gates = commit("gates.json", buildGates())
		const noise = commit("noise-meter.json", buildNoise())
		expect(Buffer.byteLength(gates) + Buffer.byteLength(noise)).toBeLessThan(
			200 * 1024,
		)
	})

	it("matches NoiseSquelch quieting at 2.5, 6.25, 12.5 and 25 kHz", () => {
		commit("noise-bandwidth.json", buildBandwidthNoise(), 2 * 1024 * 1024)
	})
})
