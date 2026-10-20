import { afterEach, describe, expect, it, vi } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { CENTRE, FS, Harness, yieldToRpc } from "./pipeline-harness.js"

const OFFSETS = [-60_000, -20_000, 35_000, 70_000]
const SIGMA = 0.05

function scene(
	seed: number,
	offsets: number[],
	seconds: number,
	sigma = SIGMA,
): Iq {
	const n = Math.round(seconds * FS)
	const iq = gaussianNoise(mulberry32(seed), n, sigma)
	for (const o of offsets) addInto(iq, tone(n, FS, o, 0.1))
	return iq
}
function play(
	parts: Iq[],
	deps: { provisionalWindowMs?: number } = {},
): Harness {
	const h = new Harness({ format: "FLOAT32LE" }, deps)
	h.start({ feed: false })
	for (const p of parts) h.push(p, 16_384)
	return h
}

describe("untracked-retune alarm in the pipeline", () => {
	afterEach(yieldToRpc)
	it("keeps the parked epoch when weak emitters flicker and a strong transmission unkeys", () => {
		const parked = (
			seed: number,
			weak: boolean,
			keyed: boolean,
			seconds: number,
		): Iq => {
			const n = Math.round(seconds * FS)
			const iq = gaussianNoise(mulberry32(seed), n, SIGMA)
			if (weak)
				for (const offset of [-60_000, -20_000])
					addInto(iq, tone(n, FS, offset, 0.015))
			if (keyed) addInto(iq, tone(n, FS, 35_000, 0.1))
			return iq
		}
		const h = play([
			parked(100, true, true, 10.6),
			parked(101, false, false, 1),
			parked(102, true, true, 1),
			parked(103, false, false, 1),
		])
		const persistent = h
			.tracks()
			.filter(t => t.lastSample - t.startSample >= 10 * FS)
		expect(persistent.length).toBeGreaterThanOrEqual(3)
		expect(h.of("untracked-retune")).toEqual([])
		expect(h.of("epoch-started")).toHaveLength(1)
	}, 60_000)

	it.each([0.05, 1.05])(
		"requires a full strength window before scene loss (%s seconds)",
		seconds => {
			const mixed = (seed: number, amplitude: number, duration: number): Iq => {
				const n = Math.round(duration * FS)
				const iq = gaussianNoise(mulberry32(seed), n, SIGMA)
				for (const offset of [-60_000, -20_000])
					addInto(iq, tone(n, FS, offset, amplitude))
				addInto(iq, tone(n, FS, 35_000, 0.1))
				return iq
			}
			const h = play([
				mixed(100, 0.015, 10.6),
				mixed(101, 0.02, seconds),
				scene(102, [], 1),
			])
			if (seconds < 1) {
				expect(h.of("untracked-retune")).toEqual([])
				expect(h.of("epoch-started")).toHaveLength(1)
			} else {
				expect(h.of("untracked-retune")).toEqual([
					expect.objectContaining({
						suspected: "external-control",
					}),
				])
				expect(h.of("epoch-started")).toHaveLength(2)
			}
		},
		60_000,
	)

	it.each(["absent", "weak", "rf-carrier"] as const)(
		"restarts strength qualification during pending classification: %s",
		kind => {
			const offsets = [-70_000, -40_000, -15_000, 35_000, 70_000]
			const h = new Harness({ format: "FLOAT32LE" })
			h.start({ feed: false })
			if (kind === "rf-carrier") {
				const p = h.pipeline as unknown as {
					tracker: { longLived: () => [] }
					spurs: { rfCarriers: () => { rfHz: number; widthBins: number }[] }
				}
				vi.spyOn(p.tracker, "longLived").mockReturnValue([])
				vi.spyOn(p.spurs, "rfCarriers").mockReturnValue(
					offsets.map(offset => ({ rfHz: CENTRE + offset, widthBins: 3 })),
				)
			}
			const push = (
				seed: number,
				seconds: number,
				faded: number,
				all = false,
				surviving = 0.1,
			) => {
				const n = Math.round(seconds * FS)
				const iq = gaussianNoise(mulberry32(seed), n, 0.005)
				if (!all)
					for (const [i, offset] of offsets.entries())
						addInto(iq, tone(n, FS, offset, i < 3 ? faded : surviving))
				h.push(iq, 16_384)
			}
			push(201, 10.6, 0.1)
			push(202, 0.1, 0, false, kind === "weak" ? 0.0015 : 0.1)
			// The old reference remains available, but its qualification must not freeze.
			const state = h.pipeline as unknown as {
				alarmWaitedBlocks: number
				prevPersistent: unknown[]
				alarmStrength: Map<string, number>
			}
			expect(state.alarmWaitedBlocks).toBeGreaterThan(0)
			expect(state.prevPersistent).toHaveLength(5)
			expect(
				[...state.alarmStrength.values()].filter(n => n >= 20).length,
			).toBeLessThanOrEqual(2)
			expect(h.of("untracked-retune")).toEqual([])
			push(203, 0.05, 0.1)
			push(204, 1, 0, true)
			expect(
				h.of("untracked-retune").filter(e => e.newEpoch !== false),
			).toEqual([])
			expect(h.of("epoch-started")).toHaveLength(1)
		},
		60_000,
	)

	it.each([0.05, 1.05])(
		"requires RF carriers to qualify before a startup scene vanishes (%s seconds)",
		seconds => {
			const h = new Harness({ format: "FLOAT32LE" })
			h.start({ feed: false })
			const p = h.pipeline as unknown as {
				spurs: { rfCarriers: () => { rfHz: number; widthBins: number }[] }
			}
			vi.spyOn(p.spurs, "rfCarriers").mockReturnValue(
				OFFSETS.map(offset => ({ rfHz: CENTRE + offset, widthBins: 3 })),
			)
			h.push(scene(211, OFFSETS, seconds, 0.005), 16_384)
			const state = h.pipeline as unknown as { prevPersistent: unknown[] }
			expect(state.prevPersistent).toHaveLength(seconds < 1 ? 0 : 4)
			h.push(scene(212, [], 2, 0.005), 16_384)
			expect(h.of("untracked-retune")).toEqual(
				seconds < 1
					? []
					: [
							expect.objectContaining({
								suspected: "external-control",
								epoch: 2,
							}),
						],
			)
			expect(h.of("epoch-started")).toHaveLength(seconds < 1 ? 1 : 2)
		},
		60_000,
	)

	it.each(["asymmetric", "exclusion", "dc", "line"] as const)(
		"measures only actual usable segment bins: %s",
		kind => {
			const h = new Harness({ format: "FLOAT32LE" })
			h.start({ feed: false })
			// Exercise the pipeline measurement with an asymmetric segment and a lifetime
			// centroid to its left. A powerful neighbour must not supply its strength.
			const p = h.pipeline as unknown as {
				tracker: {
					longLived: () => {
						trackId: string
						rfHz: number
						widthHz: number
						startBin: number
						endBin: number
						ageSamples: number
					}[]
				}
				detector: { unmasked: () => Uint8Array; kFor: (bin: number) => number }
				powerDb: Float32Array
				floorDb: Float32Array
				lineMask: Uint8Array
				ep: { centreHz: number }
				persistentFeatures: (
					segs: [],
					ep: { centreHz: number },
				) => { marginDb: number }[]
			}
			vi.spyOn(p.tracker, "longLived").mockReturnValue([
				{
					trackId: "t",
					rfHz: p.ep.centreHz - 20_000,
					widthHz: 5000,
					startBin: 110,
					endBin: 115,
					ageSamples: 11 * FS,
				},
			])
			const mask = new Uint8Array(256).fill(1)
			vi.spyOn(p.detector, "unmasked").mockReturnValue(mask)
			vi.spyOn(p.detector, "kFor").mockReturnValue(10)
			p.floorDb.fill(-100)
			p.powerDb.fill(-82) // 8 dB margin: detectable, insufficient for the alarm.
			const neighbour = kind === "asymmetric" ? 108 : 112
			p.powerDb[neighbour] = -30
			if (kind === "line") p.lineMask[neighbour] = 1
			else if (kind !== "asymmetric") mask[neighbour] = 0
			for (let i = 0; i < 25; i++)
				expect(p.persistentFeatures([], p.ep)).toEqual([])
			// Current segment power, including its asymmetric right edge, does qualify.
			p.powerDb[114] = -70
			for (let i = 0; i < 19; i++)
				expect(p.persistentFeatures([], p.ep)).toEqual([])
			expect(p.persistentFeatures([], p.ep)).toHaveLength(1)
		},
	)

	it("starts an unverified epoch with the apparent shift when the whole scene moves", () => {
		// The tuner moved up 25 kHz without the core seeing it: every RF feature appears 25 kHz lower.
		const h = play([
			scene(1, OFFSETS, 10.6),
			scene(
				2,
				OFFSETS.map(o => o - 25_000),
				1,
			),
		])
		const alarms = h.of("untracked-retune")
		expect(alarms).toHaveLength(1)
		const a = alarms[0]!
		expect(a.deltaHz).not.toBeNull()
		expect(Math.abs((a.deltaHz ?? 0) + 25_000)).toBeLessThanOrEqual(1000)
		const started = h.of("epoch-started").find(e => e.epoch === a.epoch)
		expect(started).toEqual({
			kind: "epoch-started",
			epoch: a.epoch,
			startSample: a.startSample,
			settleMode: "none",
		})
		const retuned = h.of("track-close").filter(e => e.endReason === "retune")
		expect(retuned.length).toBeGreaterThanOrEqual(4)
		const after = h.of("track-open").filter(e => e.track.epoch === a.epoch)
		expect(after.length).toBeGreaterThan(0)
		expect(
			after.every(
				e =>
					e.track.tuningTrust === "unverified" &&
					e.track.startSample >= a.startSample,
			),
		).toBe(true)
	}, 60_000)

	it("does not alarm when one carrier switches off", () => {
		const h = play([scene(3, OFFSETS, 10.6), scene(4, OFFSETS.slice(1), 1)])
		expect(h.of("untracked-retune")).toEqual([])
		expect(h.of("track-close").map(e => e.endReason)).toContain("quiet")
	}, 60_000)

	it("never alarms with fewer than three persistent features", () => {
		const two = [-20_000, 35_000]
		const h = play([
			scene(5, two, 10.6),
			scene(
				6,
				two.map(o => o - 25_000),
				1,
			),
		])
		expect(h.of("untracked-retune")).toEqual([])
	}, 60_000)

	it("does not count tracks younger than 10 s as persistent", () => {
		const h = play([
			scene(7, OFFSETS, 5),
			scene(
				8,
				OFFSETS.map(o => o - 25_000),
				1,
			),
		])
		expect(h.of("untracked-retune")).toEqual([])
	}, 60_000)

	it("does not count carriers dropped as provisional lines as vanished", () => {
		// Steady tones become provisional lines after the line window and leave the segments; nothing moved.
		const h = play([scene(9, OFFSETS, 14)], { provisionalWindowMs: 12_000 })
		expect(h.of("untracked-retune")).toEqual([])
	}, 60_000)
})
