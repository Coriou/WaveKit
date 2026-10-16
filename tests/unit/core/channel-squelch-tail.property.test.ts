/**
 * Property 5 (docs/specs/web-gaps-7): the power gate (`manual` and `auto`)
 * equals the pre-WG7 ChannelSquelch except where the noise-tail fix applies,
 * which is confined to blocks after the last block at or above the threshold.
 *
 * The reference is a frozen copy of the gate decision of `ChannelSquelch` at
 * the WG7 contract freeze (cccf665f), embedded below.
 */

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { ChannelSquelch } from "../../../src/core/channel-squelch.js"

const RATE = 1000
/** 10 ms blocks of 10 complex samples at 1 kHz. */
const BLOCK_SAMPLES = 10

/** Frozen pre-WG7 gate decision (cccf665f `ChannelSquelch.gateBlock`, power path). */
class FrozenPowerGate {
	private readonly blockMs: number
	private readonly hysteresisDb: number
	private readonly hangMs: number
	private thresholdDbfs: number | null
	private streamMs = 0
	private lastAboveMs = Number.NEGATIVE_INFINITY
	private gateOpen: boolean

	constructor(options: {
		sampleRate: number
		thresholdDbfs: number | null
		hysteresisDb?: number
		hangMs?: number
	}) {
		const blockSamples = Math.max(
			1,
			Math.round((options.sampleRate * 10) / 1000),
		)
		this.blockMs = (blockSamples / options.sampleRate) * 1000
		this.hysteresisDb = options.hysteresisDb ?? 2
		this.hangMs = options.hangMs ?? 250
		this.thresholdDbfs = normalizeThreshold(options.thresholdDbfs)
		this.gateOpen = this.thresholdDbfs === null
	}

	get open(): boolean {
		return this.gateOpen
	}

	setThreshold(thresholdDbfs: number | null): void {
		this.thresholdDbfs = normalizeThreshold(thresholdDbfs)
		if (this.thresholdDbfs === null) this.gateOpen = true
	}

	gateBlock(block: Buffer): void {
		const power = blockPower(block)
		this.streamMs += this.blockMs
		const threshold = this.thresholdDbfs
		if (threshold === null) return
		const levelDbfs = toDbfs(power)
		if (levelDbfs >= threshold) {
			this.gateOpen = true
			this.lastAboveMs = this.streamMs
		} else if (this.gateOpen) {
			if (levelDbfs >= threshold - this.hysteresisDb) {
				this.lastAboveMs = this.streamMs
			} else if (this.streamMs - this.lastAboveMs >= this.hangMs) {
				this.gateOpen = false
			}
		}
	}
}

function normalizeThreshold(value: number | null): number | null {
	return value === null || value >= 0 || !Number.isFinite(value) ? null : value
}

function blockPower(block: Buffer): number {
	const samples = block.length / 8
	let sum = 0
	for (let i = 0; i < block.length; i += 4) {
		const value = block.readFloatLE(i)
		if (Number.isFinite(value)) sum += value * value
	}
	return sum / samples
}

function toDbfs(power: number): number {
	if (!(power > 0)) return -160
	return Math.max(-160, 10 * Math.log10(power))
}

/** A block of constant IQ at `dbfs` (float32), and its measured level. */
function block(dbfs: number): { buf: Buffer; level: number } {
	const buf = Buffer.alloc(BLOCK_SAMPLES * 8)
	const amplitude = Math.sqrt(10 ** (dbfs / 10))
	for (let n = 0; n < BLOCK_SAMPLES; n++) buf.writeFloatLE(amplitude, n * 8)
	return { buf, level: toDbfs(blockPower(buf)) }
}

interface Step {
	/** Block level relative to the base threshold, dB. */
	offsetDb: number
	/** Threshold change before the block (auto-like drift), or null to keep it. */
	thresholdDelta: number | null
	/** Floor estimate fed to the new gate after the block (null = unknown). */
	floorOffsetDb: number | null
}

const stepArb = (bandOnly: boolean) =>
	fc.record({
		offsetDb: bandOnly
			? fc.oneof(
					fc.double({ min: 0, max: 20, noNaN: true }),
					fc.double({ min: -40, max: -6, noNaN: true }),
				)
			: fc.oneof(
					fc.double({ min: 0, max: 20, noNaN: true }),
					fc.double({ min: -6, max: 0, noNaN: true }),
					fc.double({ min: -40, max: -6, noNaN: true }),
				),
		thresholdDelta: fc.option(fc.double({ min: -1, max: 1, noNaN: true }), {
			freq: 8,
		}),
		floorOffsetDb: fc.option(fc.double({ min: -30, max: 5, noNaN: true }), {
			freq: 3,
		}),
	})

const configArb = fc.record({
	baseThreshold: fc.double({ min: -90, max: -20, noNaN: true }),
	hysteresisDb: fc.constantFrom(1, 2, 3),
	hangMs: fc.constantFrom(50, 100, 250),
	/** Mimics a manual gate toggled off and back on (`squelch` 0 ↔ value). */
	disableAt: fc.option(fc.nat({ max: 200 }), { freq: 4 }),
})

interface Run {
	frozen: boolean[]
	fixed: boolean[]
	levels: number[]
	thresholds: (number | null)[]
}

function runBoth(
	config: {
		baseThreshold: number
		hysteresisDb: number
		hangMs: number
		disableAt: number | null
	},
	steps: Step[],
	feedFloor: boolean,
): Run {
	const options = {
		sampleRate: RATE,
		thresholdDbfs: config.baseThreshold,
		hysteresisDb: config.hysteresisDb,
		hangMs: config.hangMs,
	}
	const frozen = new FrozenPowerGate(options)
	const fixed = new ChannelSquelch(options)
	let threshold: number | null = config.baseThreshold
	const run: Run = { frozen: [], fixed: [], levels: [], thresholds: [] }
	steps.forEach((step, index) => {
		if (config.disableAt === index) threshold = null
		else if (config.disableAt !== null && index === config.disableAt + 20)
			threshold = config.baseThreshold
		else if (threshold !== null && step.thresholdDelta !== null)
			threshold = Math.min(-0.001, threshold + step.thresholdDelta)
		frozen.setThreshold(threshold)
		fixed.setThreshold(threshold)
		const { buf, level } = block(config.baseThreshold + step.offsetDb)
		frozen.gateBlock(buf)
		fixed.process(buf)
		if (feedFloor)
			fixed.setNoiseFloorDbfs(
				step.floorOffsetDb === null
					? null
					: config.baseThreshold + step.floorOffsetDb,
			)
		run.frozen.push(frozen.open)
		run.fixed.push(fixed.open)
		run.levels.push(level)
		run.thresholds.push(threshold)
	})
	return run
}

describe("ChannelSquelch noise-tail fix", () => {
	// Feature: web-gaps-7, Property 5: Manual and auto squelch unchanged
	// Validates: Requirements 2.1, 4.2
	it("differs from the pre-WG7 gate only by closing earlier after the last block at or above the threshold", () => {
		fc.assert(
			fc.property(
				configArb,
				fc.array(stepArb(false), { minLength: 1, maxLength: 300 }),
				(config, steps) => {
					const run = runBoth(config, steps, true)
					for (let k = 0; k < steps.length; k++) {
						const threshold = run.thresholds[k] ?? null
						const level = run.levels[k] ?? -160
						// At or above the threshold (or disabled) both are open.
						if (threshold === null || level >= threshold) {
							expect(run.fixed[k]).toBe(true)
							expect(run.frozen[k]).toBe(true)
						}
						// The fix only closes earlier: open now implies open before.
						if (run.fixed[k]) expect(run.frozen[k]).toBe(true)
						if (run.fixed[k] !== run.frozen[k]) {
							// Confined to blocks after a block at/above the threshold
							// with none since: the gate was opened by an earlier block.
							let j = k - 1
							while (j >= 0) {
								const t = run.thresholds[j] ?? null
								if (t === null || (run.levels[j] ?? -160) >= t) break
								j--
							}
							expect(j).toBeGreaterThanOrEqual(0)
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-7, Property 5: Manual and auto squelch unchanged
	// Validates: Requirements 2.1, 4.2
	it("is identical, gate and output bytes, when no block falls in the hysteresis band", () => {
		fc.assert(
			fc.property(
				configArb,
				fc.array(stepArb(true), { minLength: 1, maxLength: 300 }),
				(config, steps) => {
					// Threshold drift is at most ±1 dB per block; band blocks are > 6 dB below.
					const run = runBoth(
						config,
						steps.map(s => ({ ...s, thresholdDelta: null })),
						true,
					)
					expect(run.fixed).toEqual(run.frozen)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-7, Property 5: Manual and auto squelch unchanged
	// Validates: Requirements 2.1, 4.2
	it("is identical without a floor estimate while band blocks directly follow blocks at the threshold", () => {
		fc.assert(
			fc.property(
				configArb,
				fc.array(stepArb(false), { minLength: 1, maxLength: 300 }),
				(config, raw) => {
					// A band block is kept only while every block since the last one at
					// the threshold was in the band too (a carrier fading in the band);
					// otherwise it is moved below the band. Offsets stay 0.05 dB clear
					// of the band edges so float32 levels classify the same way.
					const h = config.hysteresisDb
					const steps: Step[] = []
					let held = false
					for (const step of raw) {
						let offsetDb = step.offsetDb
						if (Math.abs(offsetDb) < 0.05) offsetDb = 0.05
						if (Math.abs(offsetDb + h) < 0.05) offsetDb = -h - 0.05
						const inBand = offsetDb < 0 && offsetDb >= -h
						if (inBand && !held) offsetDb = -40
						held = offsetDb >= 0 || (inBand && held)
						steps.push({ offsetDb, thresholdDelta: null, floorOffsetDb: null })
					}
					const run = runBoth({ ...config, disableAt: null }, steps, false)
					expect(run.fixed).toEqual(run.frozen)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("closes exactly one hang after the last block at the threshold when the band lies in the noise", () => {
		// Threshold 2 dB above a -50 dBFS floor: the 2 dB band reaches the floor.
		const fixed = new ChannelSquelch({ sampleRate: RATE, thresholdDbfs: -48 })
		const frozen = new FrozenPowerGate({ sampleRate: RATE, thresholdDbfs: -48 })
		const noise = [-49.6, -49.8, -49.9, -50.1, -49.7]
		for (let b = 0; b < 30; b++) {
			const { buf } = block(noise[b % noise.length] ?? -50)
			fixed.process(buf)
			frozen.gateBlock(buf)
			fixed.setNoiseFloorDbfs(-50.2)
		}
		for (let b = 0; b < 20; b++) {
			fixed.process(block(-30).buf)
			frozen.gateBlock(block(-30).buf)
			fixed.setNoiseFloorDbfs(-50.2)
		}
		let fixedClose = -1
		let frozenClose = -1
		for (let b = 0; b < 300; b++) {
			const { buf } = block(noise[b % noise.length] ?? -50)
			fixed.process(buf)
			frozen.gateBlock(buf)
			fixed.setNoiseFloorDbfs(-50.2)
			if (fixedClose < 0 && !fixed.open) fixedClose = (b + 1) * 10
			if (frozenClose < 0 && !frozen.open) frozenClose = (b + 1) * 10
		}
		expect(fixedClose).toBe(250)
		// Before WG7 the noise sat in the band and the gate never closed.
		expect(frozenClose).toBe(-1)
	})
})
