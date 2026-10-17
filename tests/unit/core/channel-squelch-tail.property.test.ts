/**
 * Property 5 (docs/specs/web-gaps-7): the power gate (`manual` and `auto`)
 * equals the pre-WG7 ChannelSquelch except where the noise-tail fix applies.
 * The invariant implemented and checked here is exact: the WG7 gate on a
 * block sequence equals the pre-WG7 gate on the same sequence with every
 * "noise band block" replaced by a block below the band, where a noise band
 * block is one below the threshold, within `hysteresisDb` of it, and less
 * than `hysteresisDb` above the noise floor estimate in force for that block
 * (the last estimate fed while the gate was closed: the floor freezes while
 * the gate is open). Without a floor estimate the two gates are identical.
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

/** Lowest drifted threshold; keeps a zero block (-160 dBFS) below every band. */
const MIN_THRESHOLD = -120

const stepArb = fc.record({
	offsetDb: fc.oneof(
		fc.double({ min: 0, max: 20, noNaN: true }),
		fc.double({ min: -6, max: 0, noNaN: true }),
		fc.double({ min: -40, max: -6, noNaN: true }),
	),
	thresholdDelta: fc.option(fc.double({ min: -1, max: 1, noNaN: true }), {
		freq: 8,
	}),
	floorOffsetDb: fc.option(fc.double({ min: -8, max: 2, noNaN: true }), {
		freq: 3,
	}),
})

/** Steps in runs of 1-30 equal blocks, so band holds outlast the hang. */
const stepsArb = fc
	.array(fc.tuple(stepArb, fc.integer({ min: 1, max: 30 })), {
		minLength: 1,
		maxLength: 30,
	})
	.map(runs => runs.flatMap(([step, n]) => Array<Step>(n).fill(step)))

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
	/** Blocks the reference saw in place of a noise band block. */
	replaced: number
}

/**
 * Runs the WG7 gate on `steps` and the frozen gate on the same steps with
 * every noise band block (judged on the measured float32 level, the
 * threshold in force and the floor fed before the block) replaced by a zero
 * block, which is below every band.
 */
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
	const zero = Buffer.alloc(BLOCK_SAMPLES * 8)
	let threshold: number | null = config.baseThreshold
	let floor: number | null = null
	const run: Run = { frozen: [], fixed: [], replaced: 0 }
	steps.forEach((step, index) => {
		if (config.disableAt === index) threshold = null
		else if (config.disableAt !== null && index === config.disableAt + 20)
			threshold = config.baseThreshold
		else if (threshold !== null && step.thresholdDelta !== null)
			threshold = Math.min(
				-0.001,
				Math.max(MIN_THRESHOLD, threshold + step.thresholdDelta),
			)
		frozen.setThreshold(threshold)
		fixed.setThreshold(threshold)
		const { buf, level } = block(config.baseThreshold + step.offsetDb)
		const noiseBand =
			threshold !== null &&
			floor !== null &&
			level < threshold &&
			level >= threshold - config.hysteresisDb &&
			level < floor + config.hysteresisDb
		if (noiseBand) run.replaced++
		frozen.gateBlock(noiseBand ? zero : buf)
		fixed.process(buf)
		if (feedFloor) {
			const fed =
				step.floorOffsetDb === null
					? null
					: config.baseThreshold + step.floorOffsetDb
			// The gate samples a finite estimate only while closed (frozen while
			// open); null clears it in every state.
			if (fed === null || !fixed.open) floor = fed
			fixed.setNoiseFloorDbfs(fed)
		}
		run.frozen.push(frozen.open)
		run.fixed.push(fixed.open)
	})
	return run
}

describe("ChannelSquelch noise-tail fix", () => {
	// Feature: web-gaps-7, Property 5: Manual and auto squelch unchanged
	// Validates: Requirements 2.1, 4.2
	it("equals the pre-WG7 gate with noise band blocks moved below the band", () => {
		let replaced = 0
		fc.assert(
			fc.property(configArb, stepsArb, (config, steps) => {
				const run = runBoth(config, steps, true)
				replaced += run.replaced
				expect(run.fixed).toEqual(run.frozen)
			}),
			{ numRuns: 200 },
		)
		// The generator does exercise the rule.
		expect(replaced).toBeGreaterThan(0)
	})

	// Feature: web-gaps-7, Property 5: Manual and auto squelch unchanged
	// Validates: Requirements 2.1, 4.2
	it("is identical to the pre-WG7 gate without a floor estimate", () => {
		fc.assert(
			fc.property(configArb, stepsArb, (config, steps) => {
				const run = runBoth(config, steps, false)
				expect(run.replaced).toBe(0)
				expect(run.fixed).toEqual(run.frozen)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-7, Property 5: Manual and auto squelch unchanged
	// Validates: Requirements 2.1, 4.2
	it("is identical to the pre-WG7 gate when every band block is at least hysteresis above the floor", () => {
		fc.assert(
			fc.property(configArb, stepsArb, (config, raw) => {
				// Floors at most -2h - 0.01 dB below the base threshold and no drift:
				// every band block (>= threshold - h) is >= floor + h + 0.01 dB, a
				// margin float32 rounding (~1e-6 dB) cannot cross.
				const h = config.hysteresisDb
				const steps = raw.map(s => ({
					...s,
					thresholdDelta: null,
					floorOffsetDb:
						s.floorOffsetDb === null
							? null
							: Math.min(s.floorOffsetDb, -2 * h - 0.01),
				}))
				const run = runBoth(config, steps, true)
				expect(run.replaced).toBe(0)
				expect(run.fixed).toEqual(run.frozen)
			}),
			{ numRuns: 100 },
		)
	})

	it("keeps an ongoing transmission open through a fade into the band without a floor", () => {
		// Review repro: threshold -50, -49, -60, [-51 x 30], -49 stays open.
		const fixed = new ChannelSquelch({ sampleRate: RATE, thresholdDbfs: -50 })
		const frozen = new FrozenPowerGate({ sampleRate: RATE, thresholdDbfs: -50 })
		const levels = [-49, -60, ...Array<number>(30).fill(-51), -49]
		for (const level of levels) {
			fixed.process(block(level).buf)
			frozen.gateBlock(block(level).buf)
			expect(fixed.open).toBe(true)
			expect(frozen.open).toBe(true)
		}
	})

	it("keeps a band fade open when it is at least hysteresis above the floor", () => {
		const fixed = new ChannelSquelch({ sampleRate: RATE, thresholdDbfs: -50 })
		const levels = [-49, -60, ...Array<number>(30).fill(-51), -49]
		for (const level of levels) {
			fixed.process(block(level).buf)
			fixed.setNoiseFloorDbfs(-53.5)
			expect(fixed.open).toBe(true)
		}
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

	/**
	 * R1 regression: the owner's floor estimate (the live demodulator's lower
	 * envelope) rises while the gate is open. One transmission on a channel
	 * with noise at N: idle noise in [N - 1, N - 0.5] dB, a carrier that
	 * starts above the threshold T and otherwise fades only within the hold
	 * band (so the pre-WG7 gate holds it) and at least h + 0.01 dB above the
	 * loudest idle block (so it is never noise to the closed-gate floor),
	 * then tail noise in [N - 1, N + 0.5] dB. T lies in (N + h - 0.49,
	 * N + h + 0.5], so the band [T - h, T) reaches into the tail noise. The
	 * fed floor follows the envelope rule with an open rise of 0.4-40 dB/s.
	 */
	const channelArb = fc
		.record({
			noiseDbfs: fc.double({ min: -90, max: -30, noNaN: true }),
			hysteresisDb: fc.constantFrom(1, 2, 3),
			hangMs: fc.constantFrom(50, 100, 250),
			thresholdFrac: fc.double({ min: 0, max: 1, noNaN: true }),
			openRiseDbPerS: fc.double({ min: 0.4, max: 40, noNaN: true }),
			idle: fc.array(fc.double({ min: -1, max: -0.5, noNaN: true }), {
				minLength: 1,
				maxLength: 100,
			}),
			carrier: fc.array(
				fc.tuple(
					fc.record({
						above: fc.boolean(),
						frac: fc.double({ min: 0, max: 1, noNaN: true }),
					}),
					fc.integer({ min: 1, max: 30 }),
				),
				{ minLength: 1, maxLength: 40 },
			),
			tail: fc.array(fc.double({ min: -1, max: 0.5, noNaN: true }), {
				minLength: 1,
				maxLength: 100,
			}),
		})
		.map(c => {
			const h = c.hysteresisDb
			const n = c.noiseDbfs
			const threshold = n + h - 0.47 + c.thresholdFrac * 0.97
			// 0.01 dB margins clear float32 level rounding (~1e-6 dB).
			const fadedMin = Math.max(n - 0.5 + h + 0.01, threshold - h + 0.01)
			const fadedMax = threshold - 0.01
			const levels: number[] = c.idle.map(d => n + d)
			levels.push(threshold + 1)
			for (const [b, count] of c.carrier) {
				const level = b.above
					? threshold + 0.01 + b.frac * 20
					: fadedMin + b.frac * Math.max(0, fadedMax - fadedMin)
				for (let k = 0; k < count; k++) levels.push(level)
			}
			for (const d of c.tail) levels.push(n + d)
			return { ...c, threshold, levels }
		})

	/** Pre-WG7 gate plus the hold rule judged on a floor fed every block (R0). */
	class LiveFloorGate extends FrozenPowerGate {
		floor: number | null = null
		private readonly h: number
		private readonly t: number
		constructor(options: {
			sampleRate: number
			thresholdDbfs: number
			hysteresisDb: number
			hangMs: number
		}) {
			super(options)
			this.h = options.hysteresisDb
			this.t = options.thresholdDbfs
		}
		gate(level: number, buf: Buffer, zero: Buffer): void {
			const noiseBand =
				this.floor !== null &&
				level < this.t &&
				level >= this.t - this.h &&
				level < this.floor + this.h
			this.gateBlock(noiseBand ? zero : buf)
		}
	}

	// Feature: web-gaps-7, Property 5: Manual and auto squelch unchanged
	// Validates: Requirements 2.1, 4.2
	it("with a floor rising while open, equals the pre-WG7 gate on every block up to the last above-threshold block", () => {
		let r0Chops = 0
		let earlierCloses = 0
		fc.assert(
			fc.property(channelArb, c => {
				const options = {
					sampleRate: RATE,
					thresholdDbfs: c.threshold,
					hysteresisDb: c.hysteresisDb,
					hangMs: c.hangMs,
				}
				const reference = new FrozenPowerGate(options)
				const fixed = new ChannelSquelch(options)
				const r0 = new LiveFloorGate(options)
				const zero = Buffer.alloc(BLOCK_SAMPLES * 8)
				let fixedFloor: number | null = null
				let r0Floor: number | null = null
				let lastAbove = -1
				const ref: boolean[] = []
				const got: boolean[] = []
				const r0Open: boolean[] = []
				c.levels.forEach((dbfs, index) => {
					const { buf, level } = block(dbfs)
					if (level >= c.threshold) lastAbove = index
					reference.gateBlock(buf)
					fixed.process(buf)
					r0.gate(level, buf, zero)
					// The live demodulator's lower envelope (measureRun).
					const envelope = (floor: number | null, open: boolean): number =>
						floor === null || level < floor
							? level
							: Math.min(level, floor + (open ? c.openRiseDbPerS : 1) * 0.01)
					fixedFloor = envelope(fixedFloor, fixed.open)
					fixed.setNoiseFloorDbfs(fixedFloor)
					r0Floor = envelope(r0Floor, r0.open)
					r0.floor = r0Floor
					ref.push(reference.open)
					got.push(fixed.open)
					r0Open.push(r0.open)
				})
				expect(lastAbove).toBeGreaterThanOrEqual(0)
				expect(got.slice(0, lastAbove + 1)).toEqual(ref.slice(0, lastAbove + 1))
				// After it the fix only closes earlier (the tail), never later.
				for (let i = lastAbove + 1; i < got.length; i++)
					if (got[i]) expect(ref[i]).toBe(true)
				if (
					got
						.slice(lastAbove + 1)
						.some((open, i) => open !== ref[lastAbove + 1 + i])
				)
					earlierCloses++
				if (r0Open.slice(0, lastAbove + 1).some((open, i) => open !== ref[i]))
					r0Chops++
			}),
			{ numRuns: 300 },
		)
		// The generator exercises both the R0 chop (a floor fed while open
		// closes the gate mid-transmission) and the tail fix itself.
		expect(r0Chops).toBeGreaterThan(0)
		expect(earlierCloses).toBeGreaterThan(0)
	})

	it("freezes the hold-rule floor while open and follows the estimate again once closed", () => {
		const fixed = new ChannelSquelch({ sampleRate: RATE, thresholdDbfs: -30 })
		for (let b = 0; b < 20; b++) {
			fixed.process(block(-40).buf)
			fixed.setNoiseFloorDbfs(-40)
		}
		// Open; the fed floor climbs to just under the band block level.
		fixed.process(block(-29).buf)
		fixed.setNoiseFloorDbfs(-31)
		for (let b = 0; b < 100; b++) {
			fixed.process(block(-31.5).buf)
			fixed.setNoiseFloorDbfs(-31.6)
			expect(fixed.open).toBe(true)
		}
		// Carrier gone: closes one hang after the last held block.
		for (let b = 0; b < 25; b++) {
			fixed.process(block(-40).buf)
			fixed.setNoiseFloorDbfs(-40)
		}
		expect(fixed.open).toBe(false)
		// Closed, the floor follows the estimate: a raised floor now drops band blocks.
		fixed.setNoiseFloorDbfs(-32)
		fixed.process(block(-29).buf)
		expect(fixed.open).toBe(true)
		for (let b = 0; b < 25; b++) fixed.process(block(-31.5).buf)
		expect(fixed.open).toBe(false)
	})
})
