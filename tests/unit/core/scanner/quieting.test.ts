/**
 * Carrier quieting of a scanner analog file (quieting.ts QuietingMeter, fed by SpeechContentMeter
 * with `quieting: true`): the static level (90th percentile of 20 ms second-difference block
 * levels), quieted blocks and frames at least 8 dB under it, the periodic share of the quieted
 * frames (from 16 of them) and a quieted run of 15 blocks (300 ms). All signals are modelled.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	QUIET_DROP_DB,
	QUIET_MIN_FRAMES,
	QUIET_RUN_BLOCKS,
} from "../../../../src/core/scanner/channel/quieting.js"
import { ONSET_BLOCK_SAMPLES } from "../../../../src/core/scanner/channel/onset-trim.js"
import {
	SPEECH_SHORT_MIN_FRAMES,
	SpeechContentMeter,
} from "../../../../src/core/scanner/channel/speech-content.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"

const RATE = 8_000

/** One 20 ms block per level (dB under the static): an alternating ±A pattern (exact block level). */
const STATIC_A = 8_000
function blocks(levelsDb: readonly (number | "gap")[]): Int16Array {
	const out = new Int16Array(levelsDb.length * ONSET_BLOCK_SAMPLES)
	for (const [b, db] of levelsDb.entries()) {
		const a = db === "gap" ? 0 : Math.round(STATIC_A * 10 ** (-db / 20))
		for (let i = 0; i < ONSET_BLOCK_SAMPLES; i++) {
			const at = b * ONSET_BLOCK_SAMPLES + i
			out[at] = at % 2 === 0 ? a : -a
		}
	}
	return out
}
const run = (n: number, db: number | "gap"): (number | "gap")[] =>
	Array<number | "gap">(n).fill(db)

/** Modelled open-squelch static: seeded white noise, σ = 6 000. */
function staticPcm(n: number, seed = 3): Int16Array {
	const rng = mulberry32(seed)
	const out = new Int16Array(n)
	for (let i = 0; i < n; i++) {
		const u = Math.max(1e-12, rng())
		const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
		out[i] = Math.max(-32_768, Math.min(32_767, Math.round(6_000 * g)))
	}
	return out
}
/** A modelled quieted over: harmonics 3 to 5 of a 125 Hz pitch (lag 64), low in high frequencies. */
function voicedPcm(n: number): Int16Array {
	const out = new Int16Array(n)
	for (let i = 0; i < n; i++) {
		const t = (2 * Math.PI * 125 * i) / RATE
		out[i] = Math.round(
			3_000 * Math.sin(3 * t) +
				2_500 * Math.sin(4 * t) +
				2_000 * Math.sin(5 * t),
		)
	}
	return out
}
const join = (...parts: Int16Array[]): Int16Array => {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}
function read(pcm: Int16Array, chunk = 800) {
	const m = new SpeechContentMeter({ quieting: true })
	for (let i = 0; i < pcm.length; i += chunk)
		m.push(pcm.subarray(i, Math.min(pcm.length, i + chunk)))
	return m.quieting()
}

describe("QuietingMeter (modelled)", () => {
	it("states its bounds: 8 dB under the static, 15 blocks of 20 ms (300 ms), 16 quieted frames (the meter's partial floor)", () => {
		expect(QUIET_DROP_DB).toBe(8)
		expect(QUIET_RUN_BLOCKS).toBe(15)
		expect((QUIET_RUN_BLOCKS * ONSET_BLOCK_SAMPLES * 1000) / RATE).toBe(300)
		expect(QUIET_MIN_FRAMES).toBe(SPEECH_SHORT_MIN_FRAMES)
	})

	it("only when asked for: a plain meter reads none, and asking changes no speech reading", () => {
		const pcm = join(staticPcm(16_000), voicedPcm(8_000), staticPcm(16_000, 4))
		const plain = new SpeechContentMeter()
		const asked = new SpeechContentMeter({ quieting: true })
		plain.push(pcm)
		asked.push(pcm)
		expect(plain.quieting()).toBeNull()
		expect(asked.quieting()).not.toBeNull()
		expect(asked.result()).toEqual(plain.result())
		expect(new SpeechContentMeter({ quieting: true }).quieting()).toBeNull()
	})

	it("static only: no quieted run and no quieted share", () => {
		const q = read(staticPcm(10 * RATE))!
		expect(q.quietedRun).toBe(false)
		expect(q.quietedPeriodicShare).toBeNull()
		expect(q.quietedFrames).toBeLessThan(QUIET_MIN_FRAMES)
	})

	it("a 1 s pitched over between static: a quieted run and a pitched quieted share, the whole file's share far lower", () => {
		const pcm = join(
			staticPcm(3 * RATE),
			voicedPcm(RATE),
			staticPcm(3 * RATE, 5),
		)
		const m = new SpeechContentMeter({ quieting: true })
		m.push(pcm)
		const q = m.quieting()!
		expect(q.quietedRun).toBe(true)
		expect(q.quietedFrames).toBeGreaterThanOrEqual(28)
		expect(q.quietedPeriodicShare!).toBeGreaterThan(0.9)
		expect(m.result().periodicShare).toBeLessThan(0.2)
	})

	it("under 16 quieted frames the quieted share is null (whole-file share stands)", () => {
		// 0.4 s quieted: 12 frames of 32 ms, 20 blocks of 20 ms (a run).
		const q = read(
			join(staticPcm(3 * RATE), voicedPcm(3_200), staticPcm(3 * RATE, 6)),
		)!
		expect(q.quietedFrames).toBeLessThan(QUIET_MIN_FRAMES)
		expect(q.quietedPeriodicShare).toBeNull()
		expect(q.quietedRun).toBe(true)
	})

	it("the run bound: 14 quieted blocks no run, 15 a run (blocks 20 dB under the static)", () => {
		expect(
			read(blocks([...run(60, 0), ...run(14, 20), ...run(60, 0)]))!.quietedRun,
		).toBe(false)
		expect(
			read(blocks([...run(60, 0), ...run(15, 20), ...run(60, 0)]))!.quietedRun,
		).toBe(true)
	})

	it("the drop bound: blocks 7 dB under the static are not quieted, 9 dB under are", () => {
		expect(
			read(blocks([...run(60, 0), ...run(40, 7), ...run(60, 0)]))!.quietedRun,
		).toBe(false)
		expect(
			read(blocks([...run(60, 0), ...run(40, 9), ...run(60, 0)]))!.quietedRun,
		).toBe(true)
	})

	it("a gap the recorder filled with silence breaks a run and is not a quieted block", () => {
		const q = read(
			blocks([
				...run(60, 0),
				...run(10, 20),
				...run(1, "gap"),
				...run(10, 20),
				...run(60, 0),
			]),
		)!
		expect(q.quietedRun).toBe(false)
		// A long gap alone is no quieting either.
		expect(
			read(blocks([...run(60, 0), ...run(40, "gap"), ...run(60, 0)]))!
				.quietedRun,
		).toBe(false)
	})

	// Feature: noise-recordings, Property 4: quieting reading is chunking-invariant and bounded
	// Validates: Requirements 1
	it("property: the reading does not depend on how the audio is chunked, and its share is in [0, 1] or null", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 3 * RATE }),
				fc.integer({ min: 0, max: RATE }),
				fc.integer({ min: 1, max: 4_000 }),
				fc.integer({ min: 1, max: 1_000 }),
				(lead, voiced, chunkA, seed) => {
					const pcm = join(
						staticPcm(lead, seed),
						voicedPcm(voiced),
						staticPcm(RATE, seed + 1),
					)
					const a = read(pcm, chunkA)
					const b = read(pcm, 4_096)
					expect(a).toEqual(b)
					if (a?.quietedPeriodicShare != null) {
						expect(a.quietedPeriodicShare).toBeGreaterThanOrEqual(0)
						expect(a.quietedPeriodicShare).toBeLessThanOrEqual(1)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
