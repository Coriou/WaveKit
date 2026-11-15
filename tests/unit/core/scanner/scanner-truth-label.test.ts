import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	CHANNEL_SNR_DB,
	DSD_MIN_FRAMES,
	FRAME_MS,
	MERGE_GAP_MS,
	MIN_SEGMENT_MS,
	OFF_DB,
	ON_DB,
	channelSnr,
	channelsOf,
	demodulate,
	deviationRms,
	fft,
	occupancy,
	parseDsdFme,
	parseMultimon,
	resample,
	segmentsOf,
	toS16,
	wav,
} from "../../../../scripts/bench/scanner-quality/truth-label-dsp.js"

const RATE = 256_000
const CENTRE = 455_000_000

/** CU8 of noise plus a carrier at `offsetHz` (FM-modulated by `devHz` at `toneHz`) over [a, b) s. */
function cu8(
	seconds: number,
	signal: {
		offsetHz: number
		amp: number
		from: number
		to: number
		devHz?: number
		toneHz?: number
	},
): Uint8Array {
	const n = Math.round(seconds * RATE)
	const out = new Uint8Array(2 * n)
	let seed = 1
	const rnd = (): number => {
		seed = (seed * 1_103_515_245 + 12_345) >>> 0
		return seed / 4_294_967_296 - 0.5
	}
	let phase = 0
	for (let i = 0; i < n; i++) {
		const t = i / RATE
		let re = 0.02 * rnd()
		let im = 0.02 * rnd()
		if (t >= signal.from && t < signal.to) {
			const dev =
				(signal.devHz ?? 0) * Math.sin(2 * Math.PI * (signal.toneHz ?? 0) * t)
			phase += (2 * Math.PI * (signal.offsetHz + dev)) / RATE
			re += signal.amp * Math.cos(phase)
			im += signal.amp * Math.sin(phase)
		}
		out[2 * i] = Math.max(0, Math.min(255, Math.round(re * 127.5 + 127.5)))
		out[2 * i + 1] = Math.max(0, Math.min(255, Math.round(im * 127.5 + 127.5)))
	}
	return out
}

describe("truth labelling: spectra and channels", () => {
	it("fft puts a complex tone in its bin", () => {
		const n = 64
		const re = new Float64Array(n)
		const im = new Float64Array(n)
		for (let i = 0; i < n; i++) {
			re[i] = Math.cos((2 * Math.PI * 5 * i) / n)
			im[i] = Math.sin((2 * Math.PI * 5 * i) / n)
		}
		fft(re, im)
		let best = 0
		for (let k = 1; k < n; k++)
			if (Math.hypot(re[k]!, im[k]!) > Math.hypot(re[best]!, im[best]!))
				best = k
		expect(best).toBe(5)
		expect(Math.hypot(re[5]!, im[5]!)).toBeCloseTo(n, 6)
	})

	it("finds an occupied channel snapped to the raster and its on-air stretch", () => {
		const iq = cu8(2, { offsetHz: 50_100, amp: 0.3, from: 0.5, to: 1.5 })
		const occ = occupancy(iq, RATE, CENTRE)
		// 13 spectra of 1 024 samples a frame at 256 kHz: 52 ms frames, 38 whole ones in 2 s.
		expect(occ.frameMs).toBeCloseTo(52, 6)
		expect(occ.frames.length).toBe(38)
		const channels = channelsOf(occ, [], 3_125, 0)
		expect(channels).toEqual([CENTRE + 50_000])
		const segs = segmentsOf(channelSnr(occ, CENTRE + 50_000), occ.frameMs)
		expect(segs).toHaveLength(1)
		expect(segs[0]!.startMs).toBeGreaterThanOrEqual(450)
		expect(segs[0]!.startMs).toBeLessThanOrEqual(550)
		expect(segs[0]!.endMs).toBeGreaterThanOrEqual(1_450)
		expect(segs[0]!.endMs).toBeLessThanOrEqual(1_550)
	})

	it("ignores hints with nothing on air and the DC bin", () => {
		const iq = cu8(1, { offsetHz: 1_000, amp: 0.3, from: 0, to: 1 })
		const occ = occupancy(iq, RATE, CENTRE)
		expect(channelsOf(occ, [CENTRE + 80_000], 3_125, 0)).toEqual([])
		const peak = Math.max(...channelSnr(occ, CENTRE + 80_000))
		expect(peak).toBeLessThan(CHANNEL_SNR_DB)
	})

	it("demodulates an FM tone to its deviation", () => {
		const iq = cu8(1, {
			offsetHz: 40_000,
			amp: 0.3,
			from: 0,
			to: 1,
			devHz: 2_000,
			toneHz: 1_000,
		})
		const { rateHz, freq } = demodulate(
			iq,
			RATE,
			CENTRE,
			CENTRE + 40_000,
			100,
			900,
		)
		expect(rateHz).toBe(RATE / 16)
		// A sine of 2 kHz peak deviation: RMS 2000 / √2.
		expect(deviationRms(freq)).toBeGreaterThan(1_300)
		expect(deviationRms(freq)).toBeLessThan(1_550)
		const carrier = demodulate(
			cu8(1, { offsetHz: 40_000, amp: 0.3, from: 0, to: 1 }),
			RATE,
			CENTRE,
			CENTRE + 40_000,
			100,
			900,
		)
		expect(deviationRms(carrier.freq)).toBeLessThan(200)
	})

	it("resamples by the rate ratio and writes a 16-bit mono WAV", () => {
		const x = Float64Array.from({ length: 160 }, (_, i) => i)
		const y = resample(x, 16_000, 48_000)
		expect(y.length).toBe(480)
		expect(y[3]).toBeCloseTo(1, 6)
		const pcm = toS16(Float64Array.of(10_000, -20_000, 0))
		expect([...pcm]).toEqual([32_000, -32_767, 0])
		const w = wav(pcm, 48_000)
		expect(w.length).toBe(44 + 6)
		expect(w.toString("ascii", 0, 4)).toBe("RIFF")
		expect(w.readUInt32LE(24)).toBe(48_000)
	})
})

describe("truth labelling: on-air stretches", () => {
	const frames = (db: number[]): Float64Array => Float64Array.from(db)

	it("opens at ON_DB, closes below OFF_DB, joins short gaps, drops short stretches", () => {
		const on = ON_DB + 1
		const mid = (ON_DB + OFF_DB) / 2
		const gap = Math.floor(MERGE_GAP_MS / FRAME_MS)
		const s = segmentsOf(
			frames([
				0,
				on,
				mid,
				on,
				...Array<number>(gap).fill(0),
				on,
				0,
				0,
				0,
				0,
				0,
				0,
				on,
				0,
			]),
		)
		expect(s).toEqual([{ startMs: FRAME_MS, endMs: (5 + gap) * FRAME_MS }])
	})

	it("closes a stretch still open at the end", () => {
		expect(segmentsOf(frames([0, 0, 20, 20, 20, 20]))).toEqual([
			{ startMs: 2 * FRAME_MS, endMs: 6 * FRAME_MS },
		])
	})

	it("returns sorted, disjoint stretches no shorter than MIN_SEGMENT_MS, gaps over MERGE_GAP_MS", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -5, max: 30, noNaN: true }), {
					maxLength: 400,
				}),
				db => {
					const s = segmentsOf(Float64Array.from(db))
					for (let i = 0; i < s.length; i++) {
						expect(s[i]!.endMs - s[i]!.startMs).toBeGreaterThanOrEqual(
							MIN_SEGMENT_MS,
						)
						expect(s[i]!.startMs).toBeGreaterThanOrEqual(0)
						expect(s[i]!.endMs).toBeLessThanOrEqual(db.length * FRAME_MS)
						if (i > 0)
							expect(s[i]!.startMs - s[i - 1]!.endMs).toBeGreaterThan(
								MERGE_GAP_MS,
							)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("truth labelling: decoder output", () => {
	const line = (cc: string, extra = ""): string =>
		`20:37:35 Sync: +DMR  [slot1]  slot2  | Color Code=${cc} | CSBK${extra}`

	it("takes the colour code most frames carry, at DSD_MIN_FRAMES or more", () => {
		const text = [line("10"), line("10"), line("10"), line("07")].join("\n")
		expect(parseDsdFme(text)).toEqual({ cc: "10", frames: 3 })
		const short = Array<string>(DSD_MIN_FRAMES - 1)
			.fill(line("10"))
			.join("\n")
		expect(parseDsdFme(short)).toEqual({ cc: null, frames: 0 })
	})

	it("skips CRC errors, unknown codes and lines without a DMR sync", () => {
		const text = [
			line("10", " (CRC ERR)"),
			line("10", " (CRC ERR)"),
			line("10", " (CRC ERR)"),
			line("XX"),
			line("XX"),
			line("XX"),
			"Color Code=10",
			"Color Code=10",
			"Color Code=10",
		].join("\n")
		expect(parseDsdFme(text).frames).toBe(0)
		// A code that changes every frame is a sync match on noise.
		expect(
			parseDsdFme([line("08"), line("15"), line("11")].join("\n")).frames,
		).toBe(0)
	})

	it("reads POCSAG addresses from multimon-ng", () => {
		const text =
			"POCSAG1200: Address:  123456  Function: 0  Alpha:   x\nPOCSAG512: Address: 42  Function: 3\nFLEX: nothing"
		expect(parseMultimon(text)).toEqual(["123456", "42"])
		expect(parseMultimon("")).toEqual([])
	})
})
