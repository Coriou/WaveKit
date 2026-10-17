/**
 * WG10 req 2.6 goldens: ChannelSquelch traces without the carrier observer
 * (manual, noise and auto on a non-FM modulation) for fixed synthetic block
 * sequences. The hashes were recorded from the frozen code (1e5b4c1f) before
 * the observer was added; any drift of gate, power, floor, threshold or
 * output bytes changes them.
 */

import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { LIVE_AUDIO_NOISE_QUIETING_DB } from "@wavekit/api-types"
import fc from "fast-check"
import { ChannelSquelch } from "../../../src/core/channel-squelch.js"
import { NoiseSquelch } from "../../../src/core/noise-squelch.js"

const RATE = 25_000
const BLOCK_SAMPLES = 250

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

type BlockKind = "noise" | "carrier" | "silence" | "overload"

/** One 10 ms channel block: noise at `db` dBFS, or a carrier (+ noise). */
function makeBlock(
	kind: BlockKind,
	db: number,
	next: () => number,
	phase: { value: number },
): Buffer {
	const buf = Buffer.alloc(BLOCK_SAMPLES * 8)
	const amp = Math.sqrt(10 ** (db / 10))
	for (let n = 0; n < BLOCK_SAMPLES; n++) {
		let i = 0
		let q = 0
		if (kind === "noise") {
			// Gaussian (Box-Muller), unit mean power scaled to amp².
			const u = Math.max(1e-12, next())
			const v = next()
			const r = Math.sqrt(-Math.log(u)) * amp
			i = r * Math.cos(2 * Math.PI * v)
			q = r * Math.sin(2 * Math.PI * v)
		} else if (kind === "carrier" || kind === "overload") {
			phase.value += (2 * Math.PI * 1_000) / RATE
			const noise = kind === "overload" ? 0.02 : amp * 0.01
			i = amp * Math.cos(phase.value) + (next() - 0.5) * noise
			q = amp * Math.sin(phase.value) + (next() - 0.5) * noise
		}
		buf.writeFloatLE(i, n * 8)
		buf.writeFloatLE(q, n * 8 + 4)
	}
	return buf
}

interface Step {
	kind: BlockKind
	db: number
}

/** Fixed sequence: idle noise, a carrier, fades, silence, overload, noise. */
function fixedSequence(): Step[] {
	const steps: Step[] = []
	const push = (kind: BlockKind, db: number, count: number) => {
		for (let k = 0; k < count; k++) steps.push({ kind, db })
	}
	push("noise", -40, 30)
	push("carrier", -10, 40)
	push("carrier", -29, 10)
	push("carrier", -31, 10)
	push("noise", -40, 40)
	push("noise", -33, 20)
	push("silence", 0, 10)
	push("overload", -1, 30)
	push("noise", -40, 30)
	push("carrier", -5, 15)
	push("noise", -45, 40)
	return steps
}

interface TraceOptions {
	mode: "manual" | "noise" | "auto"
	observer?: boolean
	seed?: number
	steps?: Step[]
	/** Chunk size in bytes fed to process (default one block). */
	chunkBytes?: number
}

/**
 * Runs a sequence through ChannelSquelch with an owner loop like the live
 * demodulator's (floor envelope, auto threshold = floor + 10 dB) and returns
 * one trace line per block plus the output bytes hash.
 */
function runTrace(options: TraceOptions): {
	lines: string[]
	outputHash: string
	opens: number
} {
	const next = rng(options.seed ?? 7)
	const phase = { value: 0 }
	const steps = options.steps ?? fixedSequence()
	const squelch = new ChannelSquelch({
		sampleRate: RATE,
		thresholdDbfs:
			options.mode === "auto" ? -0.001 : options.mode === "manual" ? -30 : -30,
		hangMs: 250,
		mode: options.mode === "noise" ? "noise" : "power",
		noiseQuietingDb: 6,
		bandwidthHz: 12_500,
		...(options.observer ? { carrierObserver: true } : {}),
	})
	const hash = createHash("sha256")
	const lines: string[] = []
	let floor: number | null = null
	let opens = 0
	const input = Buffer.concat(
		steps.map(s => makeBlock(s.kind, s.db, next, phase)),
	)
	const chunk = options.chunkBytes ?? BLOCK_SAMPLES * 8
	let blockIndex = 0
	for (let off = 0; off < input.length; off += chunk) {
		const out = squelch.process(input.subarray(off, off + chunk))
		for (const b of out) hash.update(b)
		for (let k = 0; k < out.length; k++) {
			const power = squelch.powerDbfs
			if (power !== null) {
				if (floor === null) floor = power
				else if (power < floor) floor = power
				else floor = Math.min(power, floor + (squelch.open ? 0.5 : 3) * 0.01)
			}
			squelch.setNoiseFloorDbfs(floor)
			const threshold =
				options.mode === "auto" && floor !== null ? floor + 10 : -30
			if (options.mode === "auto") squelch.setThreshold(threshold)
			if (squelch.open) opens++
			lines.push(
				`${blockIndex++} ${squelch.open ? 1 : 0} ${power?.toFixed(6)} ${floor?.toFixed(6)} ${threshold.toFixed(6)} ${squelch.noiseQuietingLevelDb?.toFixed(6) ?? "-"}`,
			)
		}
	}
	for (const b of squelch.flush()) hash.update(b)
	return { lines, outputHash: hash.digest("hex"), opens }
}

function traceDigest(options: TraceOptions): string {
	const t = runTrace(options)
	return createHash("sha256")
		.update(t.lines.join("\n"))
		.update(t.outputHash)
		.digest("hex")
}

const GOLDEN: Record<string, string> = {
	manual: "5c0ab0b306bc829471f663dfa79a624e283b11f347345c47633716bfbb905d48",
	"manual-chunked":
		"5c0ab0b306bc829471f663dfa79a624e283b11f347345c47633716bfbb905d48",
	noise: "86f5e07e627fefb6307015684cbb3ed84797532a91830dd6eb03fbaa15173c3e",
	"auto-non-fm":
		"47befcfa559137bf0901371bb0992fc65131016aba83f9f1dbb2eb5a4680ed1c",
	"auto-non-fm-seed2":
		"ba7edae54522f8200e54c08b4e887c411a7a2716531e9374630b0c6c811b82b6",
}

describe("ChannelSquelch goldens without the observer (WG10 req 2.6)", () => {
	const cases: [string, TraceOptions][] = [
		["manual", { mode: "manual" }],
		["manual-chunked", { mode: "manual", chunkBytes: 1_234 }],
		["noise", { mode: "noise" }],
		["auto-non-fm", { mode: "auto" }],
		["auto-non-fm-seed2", { mode: "auto", seed: 2 }],
	]
	for (const [name, opts] of cases) {
		it(`${name} trace equals the frozen-code golden`, () => {
			const digest = traceDigest(opts)
			if (process.env["WG10_PRINT_GOLDEN"])
				console.info(`GOLDEN ${name} ${digest}`)
			expect(digest).toBe(GOLDEN[name])
		})
	}
})

function blocksOf(steps: Step[], seed: number): Buffer[] {
	const next = rng(seed)
	const phase = { value: 0 }
	return steps.map(s => makeBlock(s.kind, s.db, next, phase))
}

function sameBlocks(x: Buffer[], y: Buffer[]): boolean {
	return x.length === y.length && x.every((b, k) => b.equals(y[k]!))
}

function observerSquelch(extra: { carrierObserver?: boolean } = {}) {
	return new ChannelSquelch({
		sampleRate: RATE,
		thresholdDbfs: -0.001,
		hangMs: 250,
		bandwidthHz: 12_500,
		carrierObserver: true,
		...extra,
	})
}

function replica(): NoiseSquelch {
	return new NoiseSquelch({
		sampleRate: RATE,
		bandwidthHz: 12_500,
		quietingDb: LIVE_AUDIO_NOISE_QUIETING_DB.default,
		hangMs: 250,
		hysteresisDb: 2,
	})
}

describe("ChannelSquelch carrier observer (WG10 req 2.6)", () => {
	it("is absent by default: blockQuieted() is always false", () => {
		const squelch = new ChannelSquelch({ sampleRate: RATE, thresholdDbfs: -30 })
		expect(squelch.hasCarrierObserver).toBe(false)
		for (const b of blocksOf([{ kind: "carrier", db: -10 }], 1))
			squelch.process(b)
		expect(squelch.blockQuieted()).toBe(false)
	})

	it("reports a carrier block as quieted and a noise block as not", () => {
		const squelch = observerSquelch()
		expect(squelch.blockQuieted()).toBe(false)
		const [carrier, noise] = blocksOf(
			[
				{ kind: "carrier", db: -10 },
				{ kind: "noise", db: -40 },
			],
			3,
		)
		squelch.process(carrier!)
		expect(squelch.blockQuieted()).toBe(true)
		squelch.process(noise!)
		expect(squelch.blockQuieted()).toBe(false)
	})

	it("fails closed on NaN and silent blocks (not quieted, gate closed)", () => {
		const squelch = observerSquelch()
		const nan = Buffer.alloc(BLOCK_SAMPLES * 8)
		for (let k = 0; k < BLOCK_SAMPLES * 2; k++)
			nan.writeFloatLE(Number.NaN, k * 4)
		squelch.process(nan)
		expect(squelch.blockQuieted()).toBe(false)
		expect(squelch.open).toBe(false)
		squelch.process(Buffer.alloc(BLOCK_SAMPLES * 8))
		expect(squelch.blockQuieted()).toBe(false)
		expect(squelch.open).toBe(false)
	})

	it("opens on a carrier present at start before any floor exists", () => {
		const squelch = observerSquelch()
		const [carrier] = blocksOf([{ kind: "carrier", db: -2 }], 4)
		squelch.process(carrier!)
		expect(squelch.open).toBe(true)
		// The frozen power path with the auto start threshold stays closed.
		const plain = observerSquelch({ carrierObserver: false })
		plain.process(carrier!)
		expect(plain.open).toBe(false)
	})

	it("noise does not open the gate before a floor exists", () => {
		const squelch = observerSquelch()
		for (const b of blocksOf(
			Array.from({ length: 50 }, () => ({ kind: "noise" as const, db: -3 })),
			5,
		)) {
			squelch.process(b)
			expect(squelch.open).toBe(false)
		}
	})

	it("hands over to the power path once a floor exists, and back on null", () => {
		const squelch = observerSquelch()
		const blocks = blocksOf(
			[
				{ kind: "carrier", db: -10 },
				{ kind: "noise", db: -40 },
			],
			6,
		)
		squelch.process(blocks[0]!)
		expect(squelch.open).toBe(true)
		squelch.setNoiseFloorDbfs(-40)
		squelch.setThreshold(-30)
		// Power path: a carrier at -10 dBFS stays open; a noise block holds by hang.
		squelch.process(blocks[0]!)
		expect(squelch.open).toBe(true)
		for (let k = 0; k < 30; k++) squelch.process(blocks[1]!)
		expect(squelch.open).toBe(false)
		squelch.setNoiseFloorDbfs(null)
		squelch.process(blocks[0]!)
		expect(squelch.open).toBe(true)
	})

	it("setCarrierObserver toggles the observer at runtime", () => {
		const [carrier] = blocksOf([{ kind: "carrier", db: -2 }], 12)
		const squelch = observerSquelch({ carrierObserver: false })
		expect(squelch.hasCarrierObserver).toBe(false)
		squelch.setCarrierObserver(true)
		expect(squelch.hasCarrierObserver).toBe(true)
		squelch.process(carrier!)
		expect(squelch.blockQuieted()).toBe(true)
		expect(squelch.open).toBe(true)
		// Dropped (owner switched to manual): no quieting, frozen power path.
		squelch.setCarrierObserver(false)
		expect(squelch.hasCarrierObserver).toBe(false)
		expect(squelch.blockQuieted()).toBe(false)
		const fresh = observerSquelch({ carrierObserver: false })
		const dropped = observerSquelch()
		dropped.setCarrierObserver(false)
		for (const b of blocksOf(fixedSequence(), 13)) {
			expect(sameBlocks(dropped.process(b), fresh.process(b))).toBe(true)
			expect(dropped.open).toBe(fresh.open)
			expect(dropped.blockQuieted()).toBe(false)
		}
	})

	it("blockQuieted() during measure reflects the block just processed", () => {
		// The live demodulator calls process(block) then its measure callback.
		const squelch = observerSquelch()
		const steps: Step[] = [
			{ kind: "noise", db: -40 },
			{ kind: "carrier", db: -10 },
			{ kind: "noise", db: -40 },
			{ kind: "carrier", db: -10 },
		]
		const seen: boolean[] = []
		for (const b of blocksOf(steps, 8)) {
			squelch.process(b)
			seen.push(squelch.blockQuieted())
		}
		expect(seen).toEqual([false, true, false, true])
	})

	it("an observer in noise mode does not change the noise-mode gate", () => {
		const steps = fixedSequence()
		const a = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -30,
			mode: "noise",
			bandwidthHz: 12_500,
		})
		const b = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -30,
			mode: "noise",
			bandwidthHz: 12_500,
			carrierObserver: true,
		})
		for (const block of blocksOf(steps, 9)) {
			expect(sameBlocks(b.process(block), a.process(block))).toBe(true)
			expect(b.open).toBe(a.open)
		}
	})

	it("with a floor set, the observer leaves the power-path trace unchanged", () => {
		const steps = fixedSequence()
		const a = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -30,
			bandwidthHz: 12_500,
		})
		const b = new ChannelSquelch({
			sampleRate: RATE,
			thresholdDbfs: -30,
			bandwidthHz: 12_500,
			carrierObserver: true,
		})
		a.setNoiseFloorDbfs(-40)
		b.setNoiseFloorDbfs(-40)
		for (const block of blocksOf(steps, 10)) {
			expect(sameBlocks(b.process(block), a.process(block))).toBe(true)
			expect(b.open).toBe(a.open)
		}
	})
})

describe("ChannelSquelch overload in manual mode (WG10 req 2.6)", () => {
	it("near-full-scale IQ opens, holds and closes like any carrier", () => {
		for (const db of [-3, -1, 0, 0.5]) {
			const steps: Step[] = [
				...Array.from({ length: 20 }, () => ({
					kind: "noise" as const,
					db: -40,
				})),
				...Array.from({ length: 30 }, () => ({
					kind: "overload" as const,
					db,
				})),
				...Array.from({ length: 40 }, () => ({
					kind: "noise" as const,
					db: -40,
				})),
			]
			const squelch = new ChannelSquelch({
				sampleRate: RATE,
				thresholdDbfs: -30,
				hangMs: 250,
			})
			squelch.setNoiseFloorDbfs(-40)
			const gate: number[] = []
			const out: Buffer[] = []
			for (const b of blocksOf(steps, 11)) {
				out.push(...squelch.process(b))
				gate.push(squelch.open ? 1 : 0)
			}
			// Opens on the first overload block (index 20), holds through it,
			// closes when 250 ms (25 blocks) passed since the last one (49).
			expect(gate.indexOf(1)).toBe(20)
			expect(gate.lastIndexOf(1)).toBe(49 + 24)
			expect(gate.slice(20, 74).every(g => g === 1)).toBe(true)
			// Passed IQ keeps its magnitude (no clipping or overflow).
			for (const buf of out.slice(20, 50)) {
				for (let n = 0; n < BLOCK_SAMPLES; n++) {
					const m = Math.hypot(
						buf.readFloatLE(n * 8),
						buf.readFloatLE(n * 8 + 4),
					)
					expect(Number.isFinite(m)).toBe(true)
					expect(Math.abs(20 * Math.log10(m) - db)).toBeLessThan(0.5)
				}
			}
		}
	})
})

describe("Property 6 (ChannelSquelch side)", () => {
	// Feature: web-gaps-10, Property 6: A carrier never seeds the floor
	// Validates: Requirements 2.6
	it("quieted blocks never seed or raise the owner floor; no floor -> gate follows quieting", () => {
		const stepArb = fc.record({
			kind: fc.constantFrom<BlockKind>(
				"noise",
				"carrier",
				"silence",
				"overload",
			),
			db: fc.double({ min: -60, max: 0, noNaN: true }),
		})
		fc.assert(
			fc.property(
				fc.array(stepArb, { minLength: 1, maxLength: 40 }),
				fc.integer({ min: 1, max: 1_000_000 }),
				(steps, seed) => {
					const squelch = observerSquelch()
					const ref = replica()
					const plain = new ChannelSquelch({
						sampleRate: RATE,
						thresholdDbfs: -0.001,
						hangMs: 250,
						bandwidthHz: 12_500,
					})
					let floor: number | null = null
					for (const block of blocksOf(steps, seed)) {
						squelch.process(block)
						plain.process(block)
						const refOpen = ref.processBlock(block)
						const q = ref.lastQuietingDb
						const quieted =
							q !== null && q >= LIVE_AUDIO_NOISE_QUIETING_DB.default
						expect(squelch.blockQuieted()).toBe(quieted)
						expect(plain.blockQuieted()).toBe(false)
						if (floor === null) expect(squelch.open).toBe(refOpen)
						const power = squelch.powerDbfs
						const before = floor
						if (power !== null) {
							if (floor === null) {
								if (!squelch.blockQuieted()) floor = power
							} else if (power < floor) floor = power
							else if (!squelch.blockQuieted())
								floor = Math.min(power, floor + 0.03)
						}
						if (quieted) {
							if (before === null) expect(floor).toBeNull()
							else expect(floor!).toBeLessThanOrEqual(before)
						}
						squelch.setNoiseFloorDbfs(floor)
						if (floor !== null) squelch.setThreshold(floor + 10)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
