import fc from "fast-check"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Fft } from "../../../../src/core/spectrum/fft.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	heavyTailedNoise,
	meanPower,
	mulberry32,
	ookBursts,
	tone,
	zerosIq,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import { BLOCK, CENTRE, FS, Harness, yieldToRpc } from "./pipeline-harness.js"

const SIGMA = 0.01
const K_SHORT = 8.5
const TOTAL = Math.round(0.4 * FS)

/** A 5 ms OOK burst whose in-burst power is `snrDb` above the noise in 12.5 kHz. */
function ookBurst(
	seed: number,
	offsetHz: number,
	startMs: number,
	snrDb: number,
): Iq {
	const sig = ookBursts(mulberry32(seed), TOTAL, FS, offsetHz, 1, {
		bursts: [{ startMs, durationMs: 5 }],
	})
	const from = Math.round((startMs * FS) / 1000)
	const p = meanPower(sig, from, from + Math.round(0.005 * FS))
	const target = 10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / FS)
	const g = Math.sqrt(target / p)
	for (let i = 0; i < TOTAL; i++) {
		sig.re[i] = (sig.re[i] ?? 0) * g
		sig.im[i] = (sig.im[i] ?? 0) * g
	}
	return sig
}

/** A 5 ms carrier burst (deterministic level) whose power is `snrDb` above the noise in 12.5 kHz. */
function toneBurst(offsetHz: number, startMs: number, snrDb: number): Iq {
	const amp = Math.sqrt(10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / FS))
	const sig = zerosIq(TOTAL)
	addInto(
		sig,
		tone(Math.round(0.005 * FS), FS, offsetHz, amp),
		Math.round((startMs * FS) / 1000),
	)
	return sig
}

function run(
	signal: Iq,
	seed: number,
	over: ConstructorParameters<typeof Harness>[0] = {},
): Harness {
	const iq = gaussianNoise(mulberry32(seed), signal.re.length, SIGMA)
	addInto(iq, signal)
	const h = new Harness({ format: "FLOAT32LE", ...over })
	h.start({ feed: false })
	h.push(iq, 8192)
	return h
}

const near = (h: Harness, hz: number, tol = 2000): TrackSnapshot[] =>
	h.tracks().filter(t => Math.abs(t.centreHz - (CENTRE + hz)) <= tol)
const surfacesBurst = (t: TrackSnapshot) => t.maxBlockSnrDb >= t.thresholdDb + 3

describe("short-burst path", () => {
	// these tests run synchronously for ~50 s in total; yield a macrotask between them so vitest's worker RPC is not starved
	beforeEach(yieldToRpc)

	it("opens a burst track for a 5 ms OOK burst at +10 dB SNR", () => {
		// Feature: signal-discovery-scanner, Property 20: Short bursts
		// Validates: spec § 4.10
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 0x7fffffff }),
				fc
					.integer({ min: -900, max: 900 })
					.map(x => x * 100)
					.filter(x => Math.abs(x) >= 8000),
				fc.integer({ min: 120, max: 300 }),
				(seed, offset, startMs) => {
					const h = run(ookBurst(seed, offset, startMs, 10), seed)
					// P20 is about the opening snapshot: a burst straddling a block edge can be extended one block by
					// the long detector's hysteresis tail, and that non-burst segment clears `burst` on later snapshots
					const hits = h
						.of("track-open")
						.map(e => e.track)
						.filter(t => Math.abs(t.centreHz - (CENTRE + offset)) <= 2000)
					expect(hits.length).toBeGreaterThan(0)
					for (const t of hits) {
						expect(t.flags.burst).toBe(true)
						expect(t.thresholdDb).toBe(K_SHORT)
					}
				},
			),
			// fixed seed (spec § 13); the example straddles a 5 ms sub-block and the 300 ms block edge (296–301 ms),
			// which fixed sub-blocks split and the sliding window (Step 8) integrates whole
			{ numRuns: 100, seed: 20_001, examples: [[1, 16_700, 296]] },
		)
	}, 120_000)

	it("surfaces a block-aligned +10 dB OOK burst by the burst rule, as one burst track", () => {
		for (const seed of [31, 32, 33]) {
			const h = run(ookBurst(seed, 30_000, 200, 10), seed)
			const hits = near(h, 30_000)
			expect(new Set(hits.map(t => t.trackId)).size).toBe(1)
			expect(hits.some(surfacesBurst)).toBe(true)
		}
	})

	it.each([12, 13, 15])(
		"finds a 10 dB-diluted 5 ms burst on the short path that the long path misses (seed %i)",
		seed => {
			// −1 dB in 12.5 kHz: 8.8–11.4 dB per-bin S/N over 5 ms measured (≈ 10 dB mean, k_short 8.5; with 5 frames the
			// spread is ≈ ±2 dB, so seeds 11 and 14 miss it and no single level suits every seed), ≈ 0 dB over 50 ms
			// (total 3.0 dB, still below k 4). Seeds 12, 13, 15 measured long-path 0 tracks, short-path 1 burst track.
			const sig = toneBurst(30_000, 200, -1)
			expect(
				near(run(sig, seed, { shortIntegrationMs: null }), 30_000),
			).toEqual([])
			const short = near(run(sig, seed), 30_000)
			expect(short.length).toBeGreaterThan(0)
			expect(short.every(t => t.flags.burst)).toBe(true)
		},
	)

	function heavyTail(seed: number, eventsPerMhzMin: number): Harness {
		const rng = mulberry32(seed)
		const h = new Harness({ format: "FLOAT32LE" })
		h.start({ feed: false })
		for (let s = 0; s < 60; s++) {
			h.push(
				heavyTailedNoise(rng, FS, SIGMA, {
					fs: FS,
					eventsPerMhzSec: eventsPerMhzMin / 60,
					excessDb: 8,
					eventMs: 5,
				}),
				16_384,
			)
		}
		return h
	}

	it.each([1, 2, 3])(
		"opens no burst track that passes the surfacing rule from calibrated heavy-tailed noise (seed %i)",
		seed => {
			// Feature: signal-discovery-scanner, Property 20: Short bursts
			// Validates: spec § 4.10
			const h = heavyTail(seed, 1)
			expect(h.tracks().filter(t => t.flags.burst && surfacesBurst(t))).toEqual(
				[],
			)
		},
		60_000,
	)

	it("sees 60× more heavy-tail events as burst tracks, few of which pass the rule", () => {
		const h = heavyTail(4, 60)
		const bursts = h
			.of("track-open")
			.map(e => e.track)
			.filter(t => t.flags.burst)
		// 8 dB events sit just below k_short; at this seed only a few cross it (1 with fixed sub-blocks, measured)
		expect(bursts.length).toBeGreaterThanOrEqual(1)
		const closed = h
			.of("track-close")
			.map(e => e.track)
			.filter(t => t.flags.burst)
		expect(
			closed.filter(surfacesBurst).length / Math.max(1, closed.length),
		).toBeLessThanOrEqual(0.2)
	}, 60_000)

	it("treats a continuous tone that starts late in a block as one ordinary track", () => {
		const n = 20 * BLOCK
		const start = 2 * BLOCK + Math.round(0.045 * FS) // 5 ms before the block ends
		const sig = zerosIq(n + 30 * BLOCK) // 30 quiet blocks after the tone, so the track closes inside the data
		addInto(sig, tone(n - start, FS, 25_000, 0.05), start)
		const h = run(sig, 8)
		const hits = near(h, 25_000)
		expect(new Set(hits.map(t => t.trackId)).size).toBe(1)
		const closed = h
			.of("track-close")
			.map(e => e.track)
			.filter(t => Math.abs(t.centreHz - (CENTRE + 25_000)) <= 2000)
		expect(closed).toHaveLength(1)
		expect(closed[0]!.flags.burst).toBe(false)
		expect(closed[0]!.blocks).toBeGreaterThanOrEqual(15)
	})

	it("never flags a TDMA 4FSK transmission as a burst", () => {
		const n = Math.round(1.2 * FS)
		const amp = Math.sqrt(10 ** 3 * SIGMA * SIGMA * (12_500 / FS))
		const h = run(
			fsk4Burst(mulberry32(21), n, FS, -40_000, amp, { tdma: true }),
			21,
		)
		const hits = near(h, -40_000, 3000)
		expect(hits.length).toBeGreaterThan(0)
		expect(hits.every(t => !t.flags.burst)).toBe(true)
	})

	it("reuses the long path's frame powers: no extra FFT for the short path, twice the FFTs with 50 % overlap", () => {
		const iq = gaussianNoise(mulberry32(5), 20 * BLOCK, SIGMA)
		const count = (over: ConstructorParameters<typeof Harness>[0]) => {
			const spy = vi.spyOn(Fft.prototype, "transform")
			const h = new Harness({ format: "FLOAT32LE", ...over })
			h.start({ feed: false })
			h.push(iq, 8192)
			const calls = spy.mock.calls.length
			spy.mockRestore()
			return calls
		}
		const off = count({ shortIntegrationMs: null })
		expect(count({})).toBe(off)
		const overlapped = count({ overlap: 0.5 })
		expect(overlapped).toBeGreaterThanOrEqual(2 * off - 1)
		expect(overlapped).toBeLessThanOrEqual(2 * off)
	})

	it("keeps block boundaries, the floor and a tone's level with 50 % overlap", () => {
		const n = 12 * BLOCK
		const sig = tone(n, FS, 20_000, 0.05)
		const a = new Harness({ format: "FLOAT32LE" })
		const b = new Harness({ format: "FLOAT32LE", overlap: 0.5 })
		for (const h of [a, b]) {
			h.start()
			const iq = gaussianNoise(mulberry32(9), n, SIGMA)
			addInto(iq, sig)
			h.push(iq, 8192)
		}
		const sa = a.of("block-summary").map(e => e.summary)
		const sb = b.of("block-summary").map(e => e.summary)
		// with overlap the frame starting N/2 before the data ends overhangs it, so b can finish one block fewer
		expect(sb.length).toBeGreaterThanOrEqual(sa.length - 1)
		expect(sb.map(s => s.endSample)).toEqual(
			sa.slice(0, sb.length).map(s => s.endSample),
		)
		const last = sb.length - 1
		expect(
			Math.abs(sb[last]!.floorDbfs - sa[last]!.floorDbfs),
		).toBeLessThanOrEqual(0.5)
		expect(
			Math.abs(Math.max(...sb[last]!.bins) - Math.max(...sa[last]!.bins)),
		).toBeLessThanOrEqual(0.5)
		expect(sb.every(s => !s.overload)).toBe(true)
	})
})
