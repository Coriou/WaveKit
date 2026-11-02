import { describe, expect, it } from "vitest"
import {
	MAX_SLICE_SAMPLES,
	WidebandNfmChain,
	chooseFactors,
} from "../../../../src/core/scanner/channel/wideband-nfm.js"
import { CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import {
	CTCSS_TEST_HZ,
	NfmSource,
	VOICE_TONES_HZ,
	goertzel,
} from "./wideband-nfm-fixtures.js"

function run(
	fs: number,
	seconds: number,
	chunk: (i: number) => number,
	opts: { highPass?: boolean; ctcssHz?: number | null } = {},
): { pcm: Int16Array; ctcssHz: number | null } {
	const src = new NfmSource({
		fs,
		offsetHz: 93_750,
		...(opts.ctcssHz !== undefined ? { ctcssHz: opts.ctcssHz } : {}),
	})
	const chain = new WidebandNfmChain({
		inputRateHz: fs,
		offsetHz: 93_750,
		...(opts.highPass !== undefined ? { highPass: opts.highPass } : {}),
	})
	const parts: Int16Array[] = []
	const bank = new CtcssBank()
	const total = Math.round(seconds * fs)
	for (let i = 0, done = 0; done < total; i++) {
		const n = Math.min(chunk(i), total - done)
		const pcm = chain.process(src.next(n, true))
		const tone = chain.toneAudio()
		expect(tone.length).toBe(pcm.length)
		for (const t of tone) bank.pushSample(t / 32_768)
		parts.push(pcm)
		done += n
	}
	const pcm = new Int16Array(parts.reduce((a, p) => a + p.length, 0))
	let o = 0
	for (const p of parts) {
		pcm.set(p, o)
		o += p.length
	}
	return { pcm, ctcssHz: bank.result() }
}

describe("WidebandNfmChain", () => {
	it.each([1_024_000, 2_400_000])(
		"demodulates NFM at %i sps to 8 kHz audio with the voice tone and a detected 67 Hz CTCSS",
		fs => {
			const { pcm, ctcssHz } = run(fs, 1.5, () => 40_000)
			// 1.5 s at 8 kHz, within the filters' few-frame delay.
			expect(Math.abs(pcm.length - 12_000)).toBeLessThanOrEqual(4)
			// The first burst (0 to 150 ms) is VOICE_TONES_HZ[0]; skip 20 ms of filter fill.
			const first = VOICE_TONES_HZ[0]
			const at = goertzel(pcm, 8000, first, 160, 1200)
			const off = goertzel(pcm, 8000, 1900, 160, 1200)
			expect(at).toBeGreaterThan(100 * off)
			expect(ctcssHz).toBe(CTCSS_TEST_HZ)
		},
		30_000,
	)

	it("high-passes the CTCSS sub-tone out of the written audio (≥ 30 dB)", () => {
		const fs = 1_024_000
		const hp = run(fs, 1.5, () => 51_200).pcm
		const raw = run(fs, 1.5, () => 51_200, { highPass: false }).pcm
		const hpTone = goertzel(hp, 8000, CTCSS_TEST_HZ, 2000, 12_000)
		const rawTone = goertzel(raw, 8000, CTCSS_TEST_HZ, 2000, 12_000)
		expect(rawTone).toBeGreaterThan(0)
		expect(10 * Math.log10(hpTone / rawTone)).toBeLessThan(-30)
	})

	it("reports no CTCSS without a sub-tone", () => {
		const { ctcssHz } = run(1_024_000, 1.5, () => 51_200, { ctcssHz: null })
		expect(ctcssHz).toBeNull()
	})

	it("is chunk-split invariant", () => {
		const fs = 1_024_000
		const a = run(fs, 0.6, () => 51_200).pcm
		const sizes = [1, 7, 4096, 33_333, 100, MAX_SLICE_SAMPLES]
		const b = run(fs, 0.6, i => sizes[i % sizes.length]!).pcm
		expect(b).toEqual(a)
	})

	it("rejects odd or oversized slices and invalid options", () => {
		const chain = new WidebandNfmChain({ inputRateHz: 1_024_000, offsetHz: 0 })
		expect(() => chain.process(new Uint8Array(3))).toThrow()
		expect(() =>
			chain.process(new Uint8Array(2 * (MAX_SLICE_SAMPLES + 1))),
		).toThrow()
		expect(() =>
			chain.process(new Uint8Array(2 * MAX_SLICE_SAMPLES)),
		).not.toThrow()
		expect(
			() => new WidebandNfmChain({ inputRateHz: 40_000, offsetHz: 0 }),
		).toThrow()
		expect(
			() => new WidebandNfmChain({ inputRateHz: 1_024_000, offsetHz: 600_000 }),
		).toThrow()
	})
})

describe("chooseFactors", () => {
	it.each([
		[1_024_000, 7, 3],
		[2_048_000, 14, 3],
		[2_400_000, 10, 5],
		[250_000, 1, 5],
	])("splits %i sps into k %i · m %i", (fs, k, m) => {
		const f = chooseFactors(fs)
		expect([f.k, f.m]).toEqual([k, m])
		expect(f.rateHz).toBeGreaterThanOrEqual(48_000)
		expect(f.rateHz).toBeLessThan(96_000)
	})

	it("keeps 48 kHz ≤ r < 96 kHz for every rate from 48 kHz to 3.2 Msps", () => {
		for (let fs = 48_000; fs <= 3_200_000; fs += 7_919) {
			const f = chooseFactors(fs)
			expect(f.rateHz).toBeGreaterThanOrEqual(48_000)
			expect(f.rateHz * f.k * f.m).toBeCloseTo(fs, 3)
			if (f.k > 1) expect(f.rateHz).toBeLessThan(96_000)
		}
		expect(() => chooseFactors(47_999)).toThrow()
	})
})
