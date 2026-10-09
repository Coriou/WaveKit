/**
 * Signal-flat check: a subsampled IQ level that stays below the threshold for
 * the hold time is flagged (warning only). Incident 2026-10-09: an external
 * SDR++ client left the dongle at near-zero gain (u8 IQ std about 0.6 LSB)
 * while IQ kept flowing at the declared rate.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	SIGNAL_FLAT_HOLD_MS,
	SIGNAL_FLAT_HYSTERESIS_DB,
	SIGNAL_FLAT_THRESHOLD_DBFS,
	SIGNAL_LEVEL_MIN_DBFS,
	SignalLevelTracker,
	iqComponentFormatFor,
	meanSquareToDbfs,
} from "../../../src/core/signal-level.js"

const TICK = 5_000
const HOLD_TICKS = SIGNAL_FLAT_HOLD_MS / TICK
const U8 = iqComponentFormatFor({ kind: "iq", format: "U8_IQ" })!
const S16 = iqComponentFormatFor({ kind: "iq", format: "S16_IQ" })!

/** u8 IQ whose components sit `dev` LSB either side of 127.5 (dev ∈ k + 0.5). */
function u8Chunk(dev: number, length = 64 * 1024): Buffer {
	const chunk = Buffer.alloc(length)
	for (let i = 0; i < length; i++)
		chunk[i] = i % 2 === 0 ? 127.5 - dev : 127.5 + dev
	return chunk
}

function s16Chunk(value: number, length = 64 * 1024): Buffer {
	const chunk = Buffer.alloc(length)
	for (let i = 0; i + 1 < length; i += 2) chunk.writeInt16LE(value, i)
	return chunk
}

/** −48.1 dBFS: the incident's near-zero gain (0.5 LSB RMS). */
const FLAT = u8Chunk(0.5)
/** −24.6 dBFS: an ordinary antenna noise floor (7.5 LSB RMS). */
const NORMAL = u8Chunk(7.5)
/** −38.6 dBFS: above the threshold but inside the hysteresis band. */
const MARGINAL = u8Chunk(1.5)

function u8Tracker(): SignalLevelTracker {
	const tracker = new SignalLevelTracker()
	tracker.setFormat(U8)
	return tracker
}

/** Feeds one chunk per tick (or nothing for null); returns the transitions. */
function run(
	tracker: SignalLevelTracker,
	start: number,
	chunks: Array<Buffer | null>,
) {
	return chunks.map((chunk, i) => {
		if (chunk) tracker.feed(chunk)
		return tracker.observe({ atMs: start + (i + 1) * TICK, elapsedMs: TICK })
	})
}

const times = (n: number, chunk: Buffer | null) =>
	Array.from({ length: n }, () => chunk)

describe("iqComponentFormatFor", () => {
	it("interprets only the IQ formats sources deliver", () => {
		expect(U8).toEqual({ bytes: 1, zero: 127.5, fullScale: 127.5 })
		expect(S16).toEqual({ bytes: 2, zero: 0, fullScale: 32768 })
		expect(
			iqComponentFormatFor({ kind: "audio_pcm", format: "S16LE" }),
		).toBeUndefined()
		expect(
			iqComponentFormatFor({ kind: "audio_pcm", format: "FLOAT32LE" }),
		).toBeUndefined()
		expect(iqComponentFormatFor({ kind: "iq", format: "auto" })).toBeUndefined()
		expect(
			iqComponentFormatFor({ kind: "recording", format: "U8_IQ" }),
		).toBeUndefined()
	})
})

describe("SignalLevelTracker", () => {
	it("measures u8 IQ about 127.5 relative to 127.5 full scale", () => {
		const tracker = u8Tracker()
		run(tracker, 0, [u8Chunk(0.5)])
		// 20·log10(0.5 / 127.5) = −48.13
		expect(tracker.levelDbfs).toBe(-48.1)
		run(tracker, TICK, [u8Chunk(127.5)])
		expect(tracker.levelDbfs).toBe(0)
		// The incident: std 0.6 LSB is about −46.5 dBFS, under the default.
		expect(meanSquareToDbfs((0.6 / 127.5) ** 2)).toBeCloseTo(-46.55, 1)
		expect(meanSquareToDbfs((0.6 / 127.5) ** 2)).toBeLessThan(
			SIGNAL_FLAT_THRESHOLD_DBFS,
		)
	})

	it("measures s16 IQ relative to 32768 and floors digital silence", () => {
		const tracker = new SignalLevelTracker()
		tracker.setFormat(S16)
		run(tracker, 0, [s16Chunk(-328)])
		expect(tracker.levelDbfs).toBe(-40) // 20·log10(328 / 32768) = −39.99
		run(tracker, TICK, [s16Chunk(0)])
		expect(tracker.levelDbfs).toBe(SIGNAL_LEVEL_MIN_DBFS)
	})

	it("keeps component alignment across odd chunk boundaries", () => {
		const tracker = new SignalLevelTracker({ stride: 1 })
		tracker.setFormat(S16)
		const whole = s16Chunk(16384, 4096)
		for (const [a, b] of [
			[0, 1],
			[1, 2001],
			[2001, 4096],
		] as const)
			tracker.feed(whole.subarray(a, b))
		tracker.observe({ atMs: TICK, elapsedMs: TICK })
		expect(tracker.levelDbfs).toBe(-6) // 20·log10(0.5)
	})

	it("subsamples instead of reading every byte", () => {
		const tracker = u8Tracker()
		// Only every 1021st component is read: a non-zero component between
		// two read positions does not move the level.
		const chunk = u8Chunk(0.5, 2042)
		chunk[500] = 255
		run(tracker, 0, [chunk])
		expect(tracker.levelDbfs).toBe(-48.1)
	})

	it("raises the flag once the level has stayed low for the hold time", () => {
		const tracker = u8Tracker()
		const events = run(tracker, 0, times(HOLD_TICKS, FLAT))
		expect(events).toEqual([...times(HOLD_TICKS - 1, null), "flagged"])
		expect(tracker.flat).toEqual({
			levelDbfs: -48.1,
			thresholdDbfs: SIGNAL_FLAT_THRESHOLD_DBFS,
			since: new Date(0),
		})
	})

	it("does not raise on brief dips", () => {
		const tracker = u8Tracker()
		const pattern = [...times(HOLD_TICKS - 1, FLAT), NORMAL]
		const events = run(tracker, 0, [...pattern, ...pattern, ...pattern])
		expect(events.every(e => e === null)).toBe(true)
		expect(tracker.flat).toBeUndefined()
		expect(tracker.levelDbfs).toBe(-24.6)
	})

	it("clears with hysteresis: a marginal recovery keeps the flag", () => {
		const tracker = u8Tracker()
		run(tracker, 0, times(HOLD_TICKS, FLAT))
		expect(tracker.flat).toBeDefined()
		// Above −40 but below −37: still flat.
		const marginal = run(tracker, SIGNAL_FLAT_HOLD_MS, times(10, MARGINAL))
		expect(marginal.every(e => e === null)).toBe(true)
		expect(tracker.flat?.levelDbfs).toBe(-38.6)
		expect(-38.6).toBeLessThan(
			SIGNAL_FLAT_THRESHOLD_DBFS + SIGNAL_FLAT_HYSTERESIS_DB,
		)
		// A clear recovery must also hold.
		const recovered = run(tracker, 100_000, times(HOLD_TICKS, NORMAL))
		expect(recovered).toEqual([...times(HOLD_TICKS - 1, null), "cleared"])
		expect(tracker.flat).toBeUndefined()
	})

	it("a source with no bytes never raises it", () => {
		const tracker = u8Tracker()
		const events = run(tracker, 0, times(HOLD_TICKS * 3, null))
		expect(events.every(e => e === null)).toBe(true)
		expect(tracker.levelDbfs).toBeUndefined()
		// A gap breaks a low run.
		const gapped = run(tracker, 0, [
			...times(HOLD_TICKS - 1, FLAT),
			null,
			...times(HOLD_TICKS - 1, FLAT),
		])
		expect(gapped.every(e => e === null)).toBe(true)
	})

	it("never measures formats it cannot interpret", () => {
		const tracker = new SignalLevelTracker()
		tracker.setFormat(undefined)
		const events = run(tracker, 0, times(HOLD_TICKS * 2, FLAT))
		expect(events.every(e => e === null)).toBe(true)
		expect(tracker.levelDbfs).toBeUndefined()
	})

	it("reset and format changes forget the flag and the run", () => {
		const tracker = u8Tracker()
		run(tracker, 0, times(HOLD_TICKS, FLAT))
		expect(tracker.reset()).toBe(true)
		expect(tracker.flat).toBeUndefined()
		expect(tracker.levelDbfs).toBeUndefined()
		expect(tracker.reset()).toBe(false)

		run(tracker, 0, times(HOLD_TICKS - 1, FLAT))
		expect(tracker.setFormat(U8)).toBe(false) // unchanged: run kept
		expect(run(tracker, 0, [FLAT])).toEqual(["flagged"])
		expect(tracker.setFormat(S16)).toBe(true)
		expect(tracker.flat).toBeUndefined()
	})

	it("honours a configured threshold and hold", () => {
		const tracker = new SignalLevelTracker({
			thresholdDbfs: -20,
			holdMs: 10_000,
		})
		tracker.setFormat(U8)
		expect(run(tracker, 0, times(2, NORMAL))).toEqual([null, "flagged"])
		expect(tracker.flat?.thresholdDbfs).toBe(-20)
	})

	it("flags a constant level iff it is below the threshold for the hold", () => {
		// Feature: source-signal-flat, Property 1: flag iff level < threshold for the hold time
		// Validates: signal-flat warning
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 32767 }), value => {
				const tracker = new SignalLevelTracker()
				tracker.setFormat(S16)
				const chunk = s16Chunk(value, 8 * 1024)
				const events = run(tracker, 0, times(HOLD_TICKS, chunk))
				const level = Math.round(20 * Math.log10(value / 32768) * 10) / 10
				expect(tracker.levelDbfs).toBe(level)
				expect(events.includes("flagged")).toBe(
					level < SIGNAL_FLAT_THRESHOLD_DBFS,
				)
			}),
			{ numRuns: 100 },
		)
	})

	it("never flags without an unbroken low run of the hold time", () => {
		// Feature: source-signal-flat, Property 2: brief dips and gaps never raise the flag
		// Validates: signal-flat warning
		fc.assert(
			fc.property(
				fc.array(
					fc.constantFrom<"flat" | "normal" | "none">("flat", "normal", "none"),
					{
						maxLength: 40,
					},
				),
				pattern => {
					const tracker = u8Tracker()
					const chunks = pattern.map(p =>
						p === "flat" ? FLAT : p === "normal" ? NORMAL : null,
					)
					const events = run(tracker, 0, chunks)
					let longest = 0
					let current = 0
					for (const p of pattern) {
						current = p === "flat" ? current + 1 : 0
						longest = Math.max(longest, current)
					}
					expect(events.includes("flagged")).toBe(longest >= HOLD_TICKS)
				},
			),
			{ numRuns: 100 },
		)
	})
})
