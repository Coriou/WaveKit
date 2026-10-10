import { describe, expect, it } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	tone,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { FS, Harness } from "./pipeline-harness.js"

const OFFSETS = [-60_000, -20_000, 35_000, 70_000]
const SIGMA = 0.05

function scene(seed: number, offsets: number[], seconds: number): Iq {
	const n = Math.round(seconds * FS)
	const iq = gaussianNoise(mulberry32(seed), n, SIGMA)
	for (const o of offsets) addInto(iq, tone(n, FS, o, 0.1))
	return iq
}
function play(parts: Iq[]): Harness {
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ feed: false })
	for (const p of parts) h.push(p, 16_384)
	return h
}

describe("untracked-retune alarm in the pipeline", () => {
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
})
