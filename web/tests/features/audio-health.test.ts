import { describe, expect, it } from "vitest"
import type { LiveAudioLevel, LiveAudioStatus } from "@wavekit/api-types"
import {
	audioExpected,
	audioHealthText,
	audioHealthTitle,
	AudioHealthTracker,
	breakingUpText,
	BREAKING_CLEARS_AT,
	BREAKING_MISSING_OVER,
	HEALTH_BUCKET_MS,
	HEALTH_MIN_EXPECTED_MS,
	HEALTH_WINDOW_BUCKETS,
	NO_AUDIO_HEALTH,
} from "../../src/features/listen/audio-health.ts"
import type { RingStats } from "../../src/features/listen/pcm.ts"

const WINDOW_MS = HEALTH_BUCKET_MS * HEALTH_WINDOW_BUCKETS

/** Feeds whole buckets of ring time; `dry(i)` is the dry time of bucket i. */
class Feed {
	readonly t = new AudioHealthTracker()
	renderedMs = 0
	dryMs = 0
	last = NO_AUDIO_HEALTH
	constructor() {
		this.t.noteStats(this.stats(), true)
	}
	stats(): RingStats {
		return {
			playing: true,
			bufferedMs: 200,
			underruns: 0,
			droppedSamples: 0,
			renderedMs: this.renderedMs,
			dryMs: this.dryMs,
		}
	}
	bucket(dryMs: number, expected = true): void {
		this.renderedMs += HEALTH_BUCKET_MS
		this.dryMs += dryMs
		this.last = this.t.noteStats(this.stats(), expected)
	}
	/** A window with this much missing in total, spread evenly. */
	window(missingMs: number): void {
		for (let i = 0; i < HEALTH_WINDOW_BUCKETS; i++)
			this.bucket(missingMs / HEALTH_WINDOW_BUCKETS)
	}
}

describe("the audio health figure", () => {
	it("states its arithmetic", () => {
		expect(WINDOW_MS).toBe(10_000)
		expect(BREAKING_MISSING_OVER * WINDOW_MS).toBe(1_000)
		expect(BREAKING_CLEARS_AT * WINDOW_MS).toBe(500)
		expect(HEALTH_MIN_EXPECTED_MS).toBe(WINDOW_MS / 2)
		// the longest stall seen, 1 300 ms, less the 500 ms the core catches up, is under the threshold
		expect((1_300 - 500) / WINDOW_MS).toBeLessThan(BREAKING_MISSING_OVER)
	})

	it("is breaking up just past the threshold, not at it", () => {
		const at = new Feed()
		at.window(1_000)
		expect(at.last).toMatchObject({ breaking: false, heardPct: 90 })
		const past = new Feed()
		past.window(1_010)
		expect(past.last).toMatchObject({ breaking: true, heardPct: 89 })
	})

	it("clears at the lower bound, not just above it", () => {
		const f = new Feed()
		f.window(3_000)
		expect(f.last.breaking).toBe(true)
		f.window(510)
		expect(f.last).toMatchObject({ breaking: true, heardPct: 94 })
		f.window(500)
		expect(f.last).toMatchObject({ breaking: false, heardPct: 95 })
	})

	it("forgets what left the window", () => {
		const f = new Feed()
		f.bucket(1_000)
		for (let i = 0; i < HEALTH_WINDOW_BUCKETS - 1; i++) f.bucket(0)
		expect(f.last.heardPct).toBe(90)
		f.bucket(0)
		expect(f.last.heardPct).toBe(100)
		// the total since Listen does not forget
		expect(f.last.missingMs).toBe(1_000)
	})

	it("gives no verdict under the minimum of expected audio, and does at it", () => {
		const f = new Feed()
		for (let i = 0; i < HEALTH_MIN_EXPECTED_MS / HEALTH_BUCKET_MS - 1; i++) {
			f.bucket(1_000)
			expect(f.last.heardPct).toBeNull()
			expect(f.last.breaking).toBe(false)
		}
		f.bucket(1_000)
		expect(f.last).toMatchObject({ heardPct: 0, breaking: true })
	})

	it("does not count a closed squelch, neither its time nor a dry ring in it", () => {
		const f = new Feed()
		for (let i = 0; i < 30; i++) f.bucket(1_000, false)
		expect(f.last).toEqual(NO_AUDIO_HEALTH)
	})

	it("judges an over by itself, not by the quiet around it", () => {
		const f = new Feed()
		// 5 s quiet, then 5 s open with 30% dry: 10 s of ring time, 5 s of it expected
		for (let i = 0; i < 5; i++) f.bucket(0, false)
		for (let i = 0; i < 5; i++) f.bucket(300)
		expect(f.last).toMatchObject({ heardPct: 70, breaking: true })
	})

	it("does not count the priming at the start of a Listen", () => {
		const t = new AudioHealthTracker()
		const base = {
			bufferedMs: 0,
			underruns: 0,
			droppedSamples: 0,
		}
		t.noteStats({ ...base, playing: false, renderedMs: 300, dryMs: 300 }, true)
		t.noteStats({ ...base, playing: true, renderedMs: 400, dryMs: 400 }, true)
		for (let i = 1; i <= 10; i++)
			t.noteStats(
				{ ...base, playing: true, renderedMs: 400 + i * 1_000, dryMs: 400 },
				true,
			)
		expect(
			t.noteStats(
				{ ...base, playing: true, renderedMs: 11_400, dryMs: 400 },
				true,
			),
		).toMatchObject({ heardPct: 100, missingMs: 0 })
	})

	it("only changes at a whole bucket, and returns the same object when nothing changed", () => {
		const f = new Feed()
		f.window(0)
		const before = f.last
		f.renderedMs += HEALTH_BUCKET_MS - 1
		f.dryMs += 500
		expect(f.t.noteStats(f.stats(), true)).toBe(before)
		f.renderedMs += 1
		expect(f.t.noteStats(f.stats(), true)).not.toBe(before)
		f.window(0)
		f.window(0)
		const steady = f.last
		f.bucket(0)
		expect(f.last).toBe(steady)
	})

	describe("the core's zero-fill", () => {
		const BLOCK = 960
		const route = (zeroFilledSamples: number, clockRebases = 0) => ({
			zeroFilledSamples,
			clockRebases,
		})

		it("takes its first reading as a base, and counts samples at the route's rate after", () => {
			const f = new Feed()
			f.t.noteRoute(route(5_000 * BLOCK, 7))
			f.window(0)
			f.t.noteRoute(route(5_050 * BLOCK, 9))
			f.window(0)
			expect(f.last).toMatchObject({
				missingMs: 1_000,
				coreFilledMs: 1_000,
				rebases: 2,
				heardPct: 90,
			})
		})

		it("a sample short every fifth block for 10 s is about 2 ms, not 2 000 ms", () => {
			const f = new Feed()
			f.t.noteRoute(route(0))
			f.window(0)
			// what the real router counts for this (tests/unit/core/auto-listen/catchup-stalls.test.ts)
			f.t.noteRoute(route(117))
			f.window(0)
			expect(f.last).toMatchObject({ missingMs: 0, breaking: false })
			expect(f.last.heardPct).toBeGreaterThanOrEqual(99)
		})

		it("a lower count is a restarted core, not a negative loss", () => {
			const f = new Feed()
			f.t.noteRoute(route(5_000 * BLOCK))
			f.window(0)
			f.t.noteRoute(route(10 * BLOCK))
			f.window(0)
			f.t.noteRoute(route(20 * BLOCK))
			f.window(0)
			expect(f.last).toMatchObject({ coreFilledMs: 200, rebases: 0 })
		})

		it("an older core without the sample count shows no fill, only its rebases", () => {
			const f = new Feed()
			f.t.noteRoute({ clockRebases: 1 })
			f.window(0)
			f.t.noteRoute({ clockRebases: 3 })
			f.window(0)
			expect(f.last).toMatchObject({ coreFilledMs: 0, rebases: 2 })
		})

		it("one reading credits at most the expected time it covers", () => {
			const f = new Feed()
			f.t.noteRoute(route(0))
			f.window(0)
			// exactly what it covers: 10 s
			f.t.noteRoute(route(500 * BLOCK))
			f.window(0)
			expect(f.last.coreFilledMs).toBe(10_000)
			// past it: 3 000 blocks are 60 s, the reading covers 10 s
			f.t.noteRoute(route(3_500 * BLOCK))
			f.window(0)
			expect(f.last.coreFilledMs).toBe(20_000)
			expect(f.last.heardPct).toBe(0)
		})

		it("credits nothing when no time passed between readings", () => {
			const f = new Feed()
			f.t.noteRoute(route(0))
			f.t.noteRoute(route(100_000 * BLOCK))
			f.window(0)
			expect(f.last).toMatchObject({ missingMs: 0, heardPct: 100 })
		})

		it("does not credit what the ring already counted as dry, nor closed-squelch time", () => {
			const f = new Feed()
			f.t.noteRoute(route(0))
			// 10 s expected, 4 s of it already dry
			f.window(4_000)
			f.t.noteRoute(route(500 * BLOCK))
			f.window(0)
			expect(f.last.coreFilledMs).toBe(6_000)
			expect(f.last.missingMs).toBe(10_000)
			f.t.noteRoute(route(500 * BLOCK))
			for (let i = 0; i < 10; i++) f.bucket(0, false)
			f.t.noteRoute(route(1_000 * BLOCK))
			f.window(0)
			expect(f.last.coreFilledMs).toBe(6_000)
		})

		it("missing never exceeds expected, whatever the readings say", () => {
			const f = new Feed()
			let expectedMs = 0
			let filled = 0
			f.t.noteRoute(route(0))
			for (let i = 0; i < 200; i++) {
				f.bucket(i % 7 === 0 ? 300 : 0)
				expectedMs += HEALTH_BUCKET_MS
				if (i % 3 === 0) {
					filled += (i % 11) * 10_000 * BLOCK
					f.t.noteRoute(route(filled))
				}
			}
			f.bucket(0)
			expect(f.last.missingMs).toBeLessThanOrEqual(
				expectedMs + HEALTH_BUCKET_MS,
			)
		})

		it("after a rebase the next reading is only a base", () => {
			const f = new Feed()
			f.t.noteRoute(route(0, 0))
			f.window(0)
			f.t.rebaseRoute()
			f.t.noteRoute(route(3_000 * BLOCK, 5))
			f.window(0)
			expect(f.last).toMatchObject({
				missingMs: 0,
				coreFilledMs: 0,
				rebases: 0,
				heardPct: 100,
			})
			f.t.noteRoute(route(3_050 * BLOCK, 6))
			f.window(0)
			expect(f.last).toMatchObject({ coreFilledMs: 1_000, rebases: 1 })
		})
	})
})

describe("what the core expects to be audible", () => {
	const status = (over: Partial<LiveAudioStatus> = {}) =>
		({ running: true, squelchOpen: true, ...over }) as LiveAudioStatus
	const level = (over: Partial<LiveAudioLevel> = {}) =>
		({ squelchOpen: true, ...over }) as LiveAudioLevel
	const route = { active: "analog" } as NonNullable<
		LiveAudioStatus["autoRoute"]
	>

	it("on /auto follows the route's selection", () => {
		const s = status({ autoRoute: route })
		expect(
			audioExpected(s, level({ autoRoute: { active: "none" } }), true),
		).toBe(false)
		expect(
			audioExpected(s, level({ autoRoute: { active: "digital" } }), true),
		).toBe(true)
		expect(audioExpected(s, null, true)).toBe(true)
	})

	it("on a plain stream follows the squelch and its gates", () => {
		const s = status()
		expect(audioExpected(s, level(), false)).toBe(true)
		expect(audioExpected(s, level({ squelchOpen: false }), false)).toBe(false)
		expect(
			audioExpected(s, level({ autoSquelch: { state: "waiting" } }), false),
		).toBe(false)
		expect(
			audioExpected(
				status({ toneSquelch: { state: "waiting" } }),
				level(),
				false,
			),
		).toBe(false)
		expect(audioExpected(null, null, false)).toBe(true)
	})
})

describe("what the card and Audio options say", () => {
	const health = (over = {}) => ({ ...NO_AUDIO_HEALTH, ...over })

	it("the card only speaks while breaking up", () => {
		expect(breakingUpText(health({ heardPct: 95 }))).toBeNull()
		expect(breakingUpText(health({ breaking: true, heardPct: 71 }))).toBe(
			"Breaking up · 71% heard",
		)
	})

	it("Audio options stays quiet with nothing missing, and agrees with the card", () => {
		expect(audioHealthText(health())).toBeNull()
		expect(audioHealthText(health({ heardPct: 71, missingMs: 17_400 }))).toBe(
			"71% heard · 17.4 s missing",
		)
		expect(audioHealthText(health({ missingMs: 800 }))).toBe("0.8 s missing")
	})

	it("the detail names what the core reported", () => {
		const text = audioHealthTitle(
			health({ coreFilledMs: 12_300, rebases: 2, missingMs: 13_000 }),
		)
		expect(text).toContain("12.3 s")
		expect(text).toContain("2 times")
		expect(audioHealthTitle(health({ rebases: 1 }))).toContain("1 time.")
	})
})
