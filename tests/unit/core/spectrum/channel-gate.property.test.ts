import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { ChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import { createChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import {
	CHANNEL_GATE_HYSTERESIS_DB,
	CHANNEL_GATE_K_DB,
	CHANNEL_GATE_MARGIN_DB,
	CHANNEL_GATE_MAX_SLOTS,
	CHANNEL_GATE_MAX_WIDTH_HZ,
	CHANNEL_GATE_MIN_DURATION_MS,
	CHANNEL_GATE_MIN_WIDTH_HZ,
	type ChannelPlan,
	type ChannelPlanEntry,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"

const BIN_HZ = 1_000
const BINS = 48
const BLOCK_MS = 50
const TUNE = 100_000_000
const WIDTH = 12_500
const PASS_DB = CHANNEL_GATE_K_DB + CHANNEL_GATE_MARGIN_DB

function windowOf(): { lo: number; hi: number } {
	const half = (BINS / 2) * BIN_HZ
	return { lo: TUNE - half, hi: TUNE + half }
}

function slidingPlan(): ChannelPlan {
	const win = windowOf()
	return {
		sourceId: "src",
		defaultWidthHz: WIDTH,
		entries: [
			{
				startHz: win.lo,
				endHz: win.hi,
				widthHz: WIDTH,
				rasterHz: null,
				firstChannelHz: null,
				burst: false,
				rangeKey: "range",
			},
		],
	}
}

function slidingSlots(): { lo: number; hi: number; centre: number }[] {
	const win = windowOf()
	const span = win.hi - win.lo
	const step = WIDTH / 2
	// Same count as the gate: ceil(span / step − 1e-9). 48 kHz / 6 250 Hz = 7.68 → 8.
	const n = Math.ceil(span / step - 1e-9)
	const out: { lo: number; hi: number; centre: number }[] = []
	for (let i = 0; i < n; i++) {
		const lo = win.lo + i * step
		out.push({ lo, hi: lo + WIDTH, centre: lo + WIDTH / 2 })
	}
	return out
}

function gate(): ChannelGate {
	const g = createChannelGate({
		binHz: BIN_HZ,
		blockMs: BLOCK_MS,
		centreHz: TUNE,
		bins: BINS,
	})
	g.setPlan(slidingPlan())
	return g
}

/**
 * Block-averaged noise power (mean = linear floor) as dB. A 50 ms block at the
 * reference 2048-point FFT and 2.048 Msps integrates 2.048e6 × 0.05 / 2048 = 50
 * frames, so each bin is the mean of 50 exponential draws (seeded).
 */
const FRAMES_PER_BLOCK = 50

function expPowerDb(rng: () => number, floorDb: number): number {
	let acc = 0
	for (let k = 0; k < FRAMES_PER_BLOCK; k++) {
		let u = rng()
		while (u <= 0) u = rng()
		acc -= Math.log(u)
	}
	const mean = Math.pow(10, floorDb / 10)
	return 10 * Math.log10((mean * acc) / FRAMES_PER_BLOCK)
}

function binHz(i: number): number {
	return TUNE + (i - BINS / 2) * BIN_HZ
}

function binsIn(lo: number, hi: number): number[] {
	const out: number[] = []
	for (let i = 0; i < BINS; i++) {
		const c = binHz(i)
		if (c >= lo && c < hi) out.push(i)
	}
	return out
}

/** Same 1e-6 dB slack the gate uses so an exact margin still passes. */
const MARGIN_SLACK_DB = 1e-6

/**
 * Noise headroom below the 6 dB pass line for the "never passes" property. A
 * channel of ≥ 6 unmasked bins, each the mean of 50 exponential draws, has a
 * relative power spread of about 1/sqrt(300) ≈ 5.8 % (0.25 dB); 1.5 dB is
 * about six of those, over at most 12 blocks.
 */
const NOISE_HEADROOM_DB = 1.5

interface SlotRef {
	lo: number
	hi: number
	centre: number
	on: boolean
	running: boolean
	passed: boolean
	offs: number
	onBlocks: number
	best: number
	snr: number
}

function freshRef(s: { lo: number; hi: number; centre: number }): SlotRef {
	return {
		lo: s.lo,
		hi: s.hi,
		centre: s.centre,
		on: false,
		running: false,
		passed: false,
		offs: 0,
		onBlocks: 0,
		best: Number.NEGATIVE_INFINITY,
		snr: Number.NEGATIVE_INFINITY,
	}
}

/** Reference run for one slot, from the unmasked in-slot bins only. */
function stepRef(
	slot: SlotRef,
	power: Float32Array,
	floor: Float32Array,
	masked: Uint8Array,
): void {
	const members = binsIn(slot.lo, slot.hi)
	const total = members.length
	if (total <= 0) return
	let maskedCount = 0
	let p = 0
	let f = 0
	let invalid = false
	for (const i of members) {
		if ((masked[i] ?? 0) !== 0) {
			maskedCount++
			continue
		}
		const pv = power[i]
		const fv = floor[i]
		if (
			pv === undefined ||
			fv === undefined ||
			!Number.isFinite(pv) ||
			!Number.isFinite(fv)
		) {
			invalid = true
			break
		}
		// Same linear conversion as the gate: exp(dB · ln(10) / 10).
		const ln = Math.LN10 / 10
		const lp = Math.exp(pv * ln)
		const lf = Math.exp(fv * ln)
		if (!Number.isFinite(lp) || !Number.isFinite(lf)) {
			invalid = true
			break
		}
		p += lp
		f += lf
	}
	const dropRun = (): void => {
		if (!slot.running) return
		slot.running = false
		slot.passed = false
		slot.offs = 0
		slot.onBlocks = 0
		slot.best = Number.NEGATIVE_INFINITY
	}
	if (invalid) {
		dropRun()
		return
	}
	// More than half masked: the block is not tested and the run stays.
	if (maskedCount * 2 > total) return
	if (!(p > 0) || !(f > 0)) {
		dropRun()
		return
	}
	const db = 10 * Math.log10(p / f)
	if (!Number.isFinite(db)) {
		dropRun()
		return
	}
	slot.snr = db
	const k = CHANNEL_GATE_K_DB
	const on = slot.on ? !(db < k - CHANNEL_GATE_HYSTERESIS_DB) : db >= k
	slot.on = on
	if (!slot.running) {
		if (!on) return
		slot.running = true
		slot.onBlocks = 1
		slot.offs = 0
		slot.best = db
	} else if (on) {
		slot.onBlocks++
		if (db > slot.best) slot.best = db
	} else if (slot.offs === 0) {
		slot.offs = 1
		slot.onBlocks++
	} else {
		slot.running = false
		slot.passed = false
		slot.onBlocks = 0
		slot.offs = 0
		slot.best = Number.NEGATIVE_INFINITY
		return
	}
	if (slot.passed) return
	if (slot.onBlocks * BLOCK_MS < CHANNEL_GATE_MIN_DURATION_MS) return
	if (slot.best + MARGIN_SLACK_DB < k + CHANNEL_GATE_MARGIN_DB) return
	slot.passed = true
}

function clampWidth(hz: number): number {
	// [6 250, 200 000] Hz, the channel-gate width clamp.
	return Math.min(
		CHANNEL_GATE_MAX_WIDTH_HZ,
		Math.max(CHANNEL_GATE_MIN_WIDTH_HZ, hz),
	)
}

describe("channel gate properties", () => {
	// Feature: scanner-redesign, Property 1: Noise never passes the gate
	// Validates: Requirements 2.2, 2.3, 2.4
	// Spec gap: masking floor-only bins raises channel SNR. Draws where a mask
	// leaves a blip with floor-relative channel SNR ≥ 6 dB are excluded.
	it("noise and narrow blips never pass; a channel-filling signal at 6 dB passes within 7 blocks", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.double({ min: 0, max: 0.3, noNaN: true }),
				fc.double({ min: 0, max: 10, noNaN: true }),
				fc.integer({ min: 1, max: 12 }),
				fc.double({ min: 0, max: 0.45, noNaN: true }),
				fc.double({ min: -120, max: -60, noNaN: true }),
				(seed, blipFrac, blipSnr, blocks, maskP, floorDb) => {
					const rng = mulberry32(seed)
					const slots = slidingSlots()
					const blip = new Set<number>()
					const slot = slots[Math.floor(rng() * slots.length)]!
					const members = binsIn(slot.lo, slot.hi)
					const blipBins = Math.floor(blipFrac * members.length)
					for (let n = 0; n < blipBins && members.length > 0; n++) {
						const pick = members[Math.floor(rng() * members.length)]!
						blip.add(pick)
					}
					const masked = new Uint8Array(BINS)
					for (let i = 0; i < BINS; i++) if (rng() < maskP) masked[i] = 1
					// Spec gap: masking floor-only bins raises channel SNR. Skip a draw
					// whose noiseless channel SNR is within NOISE_HEADROOM_DB of 6 dB:
					// such a blip may cross the pass line on noise alone, which R 2.4
					// allows, so "never passes" holds only below that headroom.
					for (const s of slots) {
						const owned = binsIn(s.lo, s.hi)
						let maskedCount = 0
						let p = 0
						let f = 0
						for (const i of owned) {
							if (masked[i]) {
								maskedCount++
								continue
							}
							const snr = blip.has(i) ? blipSnr : 0
							f += 1
							p += Math.pow(10, snr / 10)
						}
						if (owned.length === 0 || maskedCount * 2 > owned.length) continue
						if (
							f > 0 &&
							10 * Math.log10(p / f) >= PASS_DB - NOISE_HEADROOM_DB
						) {
							fc.pre(false)
						}
					}
					const g = gate()
					const power = new Float32Array(BINS)
					const floor = new Float32Array(BINS)
					for (let b = 0; b < blocks; b++) {
						for (let i = 0; i < BINS; i++) {
							const f = floorDb + (rng() - 0.5) * 2
							floor[i] = f
							power[i] = blip.has(i) ? f + blipSnr : expPowerDb(rng, f)
						}
						g.block(power, floor, masked, b + 1)
					}
					const win = windowOf()
					for (let hz = win.lo; hz < win.hi; hz += BIN_HZ) {
						expect(g.gateOf(hz, 1).state).not.toBe("passed")
					}
				},
			),
			// Regression: a 30 % blip at 10 dB reads 5.1 dB noiseless and crossed 6 dB on noise.
			{ numRuns: 100, examples: [[12, 0.3, 10, 12, 0.3, -60]] },
		)

		fc.assert(
			fc.property(fc.double({ min: 6, max: 30, noNaN: true }), snrDb => {
				const g = gate()
				const power = new Float32Array(BINS)
				const floor = new Float32Array(BINS)
				floor.fill(-90)
				power.fill(-90 + snrDb)
				const masked = new Uint8Array(BINS)
				let passAt = -1
				for (let b = 0; b < 7; b++) {
					g.block(power, floor, masked, b + 1)
					if (g.gateOf(TUNE, 1).state === "passed") {
						passAt = b
						break
					}
				}
				// 300 ms is 6 blocks of 50 ms, so not before index 5, and by index 6.
				expect(passAt).toBeGreaterThanOrEqual(5)
				expect(passAt).toBeLessThanOrEqual(6)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-redesign, Property 1: Noise never passes the gate
	// Validates: Requirements 2.2, 2.3, 2.4
	// Each bin is masked from the rng alone, with no knowledge of the blip.
	// Overlapping slots share that one mask. A slot passes only when a
	// reference run on its unmasked bins met the duration and margin rule.
	it("independent masks agree with the reference channel SNR and pass rule", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.double({ min: 0, max: 0.3, noNaN: true }),
				fc.double({ min: 0, max: 10, noNaN: true }),
				fc.integer({ min: 1, max: 12 }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: -120, max: -60, noNaN: true }),
				(seed, blipFrac, blipSnr, blocks, maskP, floorDb) => {
					const rng = mulberry32(seed)
					const slots = slidingSlots()
					const blip = new Set<number>()
					const slot = slots[Math.floor(rng() * slots.length)]!
					const members = binsIn(slot.lo, slot.hi)
					const blipBins = Math.floor(blipFrac * members.length)
					for (let n = 0; n < blipBins && members.length > 0; n++) {
						const pick = members[Math.floor(rng() * members.length)]!
						blip.add(pick)
					}
					const masked = new Uint8Array(BINS)
					for (let i = 0; i < BINS; i++) if (rng() < maskP) masked[i] = 1
					const g = gate()
					const refs = slots.map(freshRef)
					const power = new Float32Array(BINS)
					const floor = new Float32Array(BINS)
					for (let b = 0; b < blocks; b++) {
						for (let i = 0; i < BINS; i++) {
							const f = floorDb + (rng() - 0.5) * 2
							floor[i] = f
							power[i] = blip.has(i) ? f + blipSnr : expPowerDb(rng, f)
						}
						for (const ref of refs) stepRef(ref, power, floor, masked)
						g.block(power, floor, masked, b + 1)
					}
					for (const ref of refs) {
						const got = g.gateOf(ref.centre, 1)
						expect(got.state === "passed").toBe(ref.passed)
						expect(closeDb(got.channelSnrDb, ref.snr)).toBe(true)
						expect(
							Number.isFinite(got.channelSnrDb) ||
								got.channelSnrDb === Number.NEGATIVE_INFINITY,
						).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-redesign, Property 2: The gate is channel-matched
	// Validates: Requirements 2.1, 2.2, 2.7
	it("channel SNR matches the unmasked bin sums, a half-masked slot is not tested, and call grouping does not change state", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.double({
					min: 1_000,
					max: 400_000,
					noNaN: true,
				}),
				fc.integer({ min: 2, max: 8 }),
				fc.integer({ min: 1, max: 7 }),
				(seed, widthHz, blockCount, split) => {
					const rng = mulberry32(seed)
					const win = windowOf()
					const width = clampWidth(widthHz)
					// Keep the raster centre inside the tuned window (10–90 % of the span).
					const span = win.hi - win.lo
					const centre = win.lo + (0.1 + rng() * 0.8) * span
					const plan: ChannelPlan = {
						sourceId: "src",
						defaultWidthHz: WIDTH,
						entries: [
							{
								startHz: win.lo,
								endHz: win.hi,
								widthHz,
								rasterHz: win.hi - win.lo,
								firstChannelHz: centre,
								burst: false,
								rangeKey: "range",
							},
						],
					}
					const lo = centre - width / 2
					const hi = centre + width / 2
					const owned = binsIn(lo, hi)
					const make = (): ChannelGate => {
						const g = createChannelGate({
							binHz: BIN_HZ,
							blockMs: BLOCK_MS,
							centreHz: TUNE,
							bins: BINS,
						})
						g.setPlan(plan)
						return g
					}
					const frames: {
						power: Float32Array
						floor: Float32Array
						masked: Uint8Array
					}[] = []
					for (let b = 0; b < blockCount; b++) {
						const power = new Float32Array(BINS)
						const floor = new Float32Array(BINS)
						const masked = new Uint8Array(BINS)
						for (let i = 0; i < BINS; i++) {
							floor[i] = -120 + rng() * 60
							power[i] = floor[i]! + rng() * 40 - 10
							if (rng() < 0.15) masked[i] = 1
						}
						frames.push({ power, floor, masked })
					}
					const cut = Math.min(split, blockCount - 1)
					const grouped = make()
					const straight = make()
					for (let b = 0; b < cut; b++) {
						const f = frames[b]!
						grouped.block(f.power, f.floor, f.masked, b + 1)
					}
					const mid = grouped.gateOf(centre, 1)
					for (let b = cut; b < blockCount; b++) {
						const f = frames[b]!
						grouped.block(f.power, f.floor, f.masked, b + 1)
					}
					for (let b = 0; b < blockCount; b++) {
						const f = frames[b]!
						straight.block(f.power, f.floor, f.masked, b + 1)
					}
					const a = grouped.gateOf(centre, 1)
					const b = straight.gateOf(centre, 1)
					expect(a.state).toBe(b.state)
					expect(a.passedSample).toBe(b.passedSample)
					expect(closeDb(a.channelSnrDb, b.channelSnrDb)).toBe(true)
					// Querying midway does not change the final state (grouping above
					// already split the calls; the mid read is the extra probe).
					expect(mid.state === "pending" || mid.state === "passed").toBe(true)

					const oracleGate = make()
					const first = frames[0]!
					oracleGate.block(first.power, first.floor, first.masked, 1)
					let p = 0
					let fSum = 0
					let maskedCount = 0
					for (const i of owned) {
						if (first.masked[i]) {
							maskedCount++
							continue
						}
						p += Math.pow(10, first.power[i]! / 10)
						fSum += Math.pow(10, first.floor[i]! / 10)
					}
					const tested = owned.length > 0 && maskedCount * 2 <= owned.length
					const got = oracleGate.gateOf(centre, 1)
					if (tested && fSum > 0 && p > 0) {
						const expected = 10 * Math.log10(p / fSum)
						expect(closeDb(got.channelSnrDb, expected)).toBe(true)
					}
					if (owned.length >= 2) {
						const before = oracleGate.gateOf(centre, 1)
						const heavy = new Uint8Array(BINS)
						const hot = new Float32Array(first.power)
						let keep = 0
						for (const i of owned) {
							// More than half masked: keep at most floor(n/2) − 1?
							// floor(n/2) masked is exactly half when n even (tested).
							// Mask all but floor((n-1)/2) so 2*masked > n.
							if (keep < Math.floor((owned.length - 1) / 2)) {
								keep++
								hot[i] = -20
							} else heavy[i] = 1
						}
						oracleGate.block(hot, first.floor, heavy, 2)
						const after = oracleGate.gateOf(centre, 1)
						expect(after.state).toBe(before.state)
						expect(after.passedSample).toBe(before.passedSample)
						expect(closeDb(after.channelSnrDb, before.channelSnrDb)).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-redesign, Property 2: The gate is channel-matched
	// Validates: Requirements 2.1, 2.2, 2.7
	it("a random plan never materializes more than CHANNEL_GATE_MAX_SLOTS", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc.integer({ min: 0, max: 4_200 }),
				fc.integer({ min: 0, max: 3 }),
				(seed, entryCount, mode) => {
					const rng = mulberry32(seed)
					const win = windowOf()
					const span = win.hi - win.lo
					const entries: ChannelPlanEntry[] = []
					for (let i = 0; i < entryCount; i++) {
						const raster = mode !== 2
						const distinct = mode === 0
						const jitter = mode === 3
						const start = jitter ? win.lo + (rng() - 0.2) * span : win.lo
						const end = jitter ? start + rng() * span : win.hi
						const lo = Math.min(start, end)
						const hi = Math.max(start, end)
						entries.push({
							startHz: lo,
							endHz: hi > lo ? hi : lo + 1,
							widthHz:
								CHANNEL_GATE_MIN_WIDTH_HZ +
								rng() * (CHANNEL_GATE_MAX_WIDTH_HZ - CHANNEL_GATE_MIN_WIDTH_HZ),
							rasterHz: raster ? span : null,
							firstChannelHz: raster ? win.lo + rng() * span : null,
							burst: mode === 1 ? false : rng() < 0.5,
							rangeKey: distinct ? `k${i}` : "range",
						})
					}
					const g = createChannelGate({
						binHz: BIN_HZ,
						blockMs: BLOCK_MS,
						centreHz: TUNE,
						bins: BINS,
					})
					g.setPlan({
						sourceId: "src",
						defaultWidthHz: WIDTH,
						entries,
					})
					expect(g.stats().slots).toBeLessThanOrEqual(CHANNEL_GATE_MAX_SLOTS)
					expect(g.stats().slots).toBeGreaterThanOrEqual(0)
					expect(Number.isInteger(g.stats().coarsened)).toBe(true)
					expect(g.stats().coarsened).toBeGreaterThanOrEqual(0)
				},
			),
			{ numRuns: 100 },
		)
	})
})

/** Relative 1e-6 on the dB value, and exact on the non-finite sentinels. */
function closeDb(actual: number, expected: number): boolean {
	if (Object.is(actual, expected)) return true
	if (!Number.isFinite(actual) || !Number.isFinite(expected))
		return actual === expected
	const scale = Math.max(1, Math.abs(expected))
	return Math.abs(actual - expected) <= 1e-6 * scale
}
