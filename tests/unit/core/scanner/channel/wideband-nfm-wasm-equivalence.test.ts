/**
 * The wasm NFM chain against the JS chain (the reference) over realistic scenes: pcm and tone
 * within ±1 LSB, and the recorder's verdicts on them (voice gate, on-air meter, CTCSS bank, tone
 * class evidence) identical. The wasm chain is fed odd chunk splits from 1 sample to
 * MAX_SLICE_SAMPLES; the JS chain the recorder's 25 ms slices. WAVEKIT_NFM_EVIDENCE=1 prints the
 * per-scene differences to stderr.
 */
import process from "node:process"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	MAX_SLICE_SAMPLES,
	WidebandNfmChain,
	widebandNfmChainPath,
} from "../../../../../src/core/scanner/channel/wideband-nfm.js"
import {
	CTCSS_TEST_HZ,
	FskSource,
	NfmSource,
} from "../wideband-nfm-fixtures.js"
import {
	WASM_LABEL,
	concat,
	lsbDiff,
	nfmWasmAvailable,
	runChain,
	testRuntime,
	verdicts,
	wasmChain,
} from "./nfm-wasm-harness.js"
import type { ChainOutput } from "./nfm-wasm-harness.js"

const ODD_CHUNKS = [
	1,
	3,
	997,
	25_600,
	MAX_SLICE_SAMPLES,
	7_777,
	MAX_SLICE_SAMPLES - 1,
	2,
	60_000,
]

function evidence(line: string): void {
	if (process.env["WAVEKIT_NFM_EVIDENCE"] === "1")
		process.stderr.write(`[nfm-evidence] ${line}\n`)
}

interface Segment {
	seconds: number
	/** Draws `n` CU8 IQ pairs. */
	draw: (n: number) => Uint8Array
}

function build(fs: number, segments: readonly Segment[]): Uint8Array {
	const parts = segments.map(s => s.draw(Math.round(s.seconds * fs)))
	const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

interface Scene {
	name: string
	offsets: { 1_024_000: number; 2_400_000: number }
	segments: (fs: number, offsetHz: number) => Segment[]
	/** Sanity: what the JS chain's verdicts must show, so the scene tests something. */
	expect?: (v: ReturnType<typeof verdicts>) => void
}

const SCENES: readonly Scene[] = [
	{
		name: "NFM QSO with CTCSS (two overs and a gap)",
		offsets: { 1_024_000: 93_750, 2_400_000: -412_500 },
		segments: (fs, offsetHz) => {
			const src = new NfmSource({ fs, offsetHz, syllables: true, seed: 3 })
			return [
				{ seconds: 1.9, draw: n => src.next(n, true) },
				{ seconds: 0.3, draw: n => src.next(n, false) },
				{ seconds: 1.6, draw: n => src.next(n, true) },
			]
		},
		expect: v => {
			expect(v.gateVoiced).toBe(true)
			expect(v.ctcssHz).toBe(CTCSS_TEST_HZ)
		},
	},
	{
		name: "voice ID (speech-like, no CTCSS)",
		offsets: { 1_024_000: -250_000, 2_400_000: 1_000_000 },
		segments: (fs, offsetHz) => {
			const src = new NfmSource({
				fs,
				offsetHz,
				syllables: true,
				ctcssHz: null,
				seed: 11,
			})
			return [{ seconds: 2.5, draw: n => src.next(n, true) }]
		},
		expect: v => {
			expect(v.gateVoiced).toBe(true)
			expect(v.ctcssHz).toBeNull()
		},
	},
	{
		name: "unmodulated carrier",
		offsets: { 1_024_000: 12_500, 2_400_000: -25_000 },
		segments: (fs, offsetHz) => {
			const src = new NfmSource({
				fs,
				offsetHz,
				voice: false,
				ctcssHz: null,
				seed: 5,
			})
			return [{ seconds: 2, draw: n => src.next(n, true) }]
		},
		expect: v => expect(v.ctcssHz).toBeNull(),
	},
	{
		name: "noise only",
		offsets: { 1_024_000: 300_000, 2_400_000: 600_000 },
		segments: (fs, offsetHz) => {
			const src = new NfmSource({ fs, offsetHz, noiseSigma: 0.08, seed: 9 })
			return [{ seconds: 2, draw: n => src.next(n, false) }]
		},
	},
	{
		name: "digital-like 4FSK burst",
		offsets: { 1_024_000: -93_750, 2_400_000: 150_000 },
		segments: (fs, offsetHz) => {
			const idle = new NfmSource({ fs, offsetHz, seed: 13 })
			const fsk = new FskSource({ fs, offsetHz, seed: 17 })
			return [
				{ seconds: 0.2, draw: n => idle.next(n, false) },
				{ seconds: 1.8, draw: n => fsk.next(n, true) },
			]
		},
	},
]

function compare(
	label: string,
	js: ChainOutput,
	wasm: ChainOutput,
): ReturnType<typeof verdicts> {
	expect(wasm.pcm.length).toBe(js.pcm.length)
	const pcm = lsbDiff(js.pcm, wasm.pcm)
	const tone = lsbDiff(js.tone, wasm.tone)
	evidence(
		`${label}: ${js.pcm.length} frames; pcm max ${pcm.max} LSB (${pcm.differing} differ), tone max ${tone.max} LSB (${tone.differing} differ)`,
	)
	expect(pcm.max).toBeLessThanOrEqual(1)
	expect(tone.max).toBeLessThanOrEqual(1)
	const vj = verdicts(js)
	expect(verdicts(wasm)).toEqual(vj)
	return vj
}

describe.skipIf(!nfmWasmAvailable)(
	`wideband NFM chain equivalence (${WASM_LABEL})`,
	() => {
		for (const scene of SCENES)
			for (const fs of [1_024_000, 2_400_000] as const)
				it(`${scene.name} at ${fs} sps: ±1 LSB and identical verdicts`, () => {
					const offsetHz = scene.offsets[fs]
					const cu8 = build(fs, scene.segments(fs, offsetHz))
					const { runtime } = testRuntime()
					const js = runChain(
						new WidebandNfmChain({ inputRateHz: fs, offsetHz }),
						cu8,
						() => (25 * fs) / 1000,
					)
					const chain = wasmChain(runtime, { inputRateHz: fs, offsetHz })
					const wasm = runChain(
						chain,
						cu8,
						i => ODD_CHUNKS[i % ODD_CHUNKS.length]!,
					)
					expect(widebandNfmChainPath(chain)).toBe("wasm")
					expect(runtime.faults).toBe(0)
					const v = compare(`${scene.name} @ ${fs}`, js, wasm)
					scene.expect?.(v)
				}, 120_000)

		it.each([1_024_000, 2_400_000])(
			"a retune mid-stream (new chains at a new offset) at %i sps keeps the verdicts",
			fs => {
				const a = new NfmSource({ fs, offsetHz: 200_000, syllables: true })
				const b = new NfmSource({
					fs,
					offsetHz: -137_500,
					syllables: true,
					ctcssHz: 88.5,
					seed: 21,
				})
				const first = a.next(Math.round(1.2 * fs), true)
				const second = b.next(Math.round(2.6 * fs), true)
				const { runtime } = testRuntime()
				const slice = (25 * fs) / 1000
				const js = [
					runChain(
						new WidebandNfmChain({ inputRateHz: fs, offsetHz: 200_000 }),
						first,
						() => slice,
					),
					runChain(
						new WidebandNfmChain({ inputRateHz: fs, offsetHz: -137_500 }),
						second,
						() => slice,
					),
				]
				const wasm = [
					runChain(
						wasmChain(runtime, { inputRateHz: fs, offsetHz: 200_000 }),
						first,
						i => ODD_CHUNKS[i % ODD_CHUNKS.length]!,
					),
					runChain(
						wasmChain(runtime, { inputRateHz: fs, offsetHz: -137_500 }),
						second,
						i => ODD_CHUNKS[(i + 3) % ODD_CHUNKS.length]!,
					),
				]
				compare(`retune first chain @ ${fs}`, js[0]!, wasm[0]!)
				const v = compare(`retune second chain @ ${fs}`, js[1]!, wasm[1]!)
				expect(v.ctcssHz).toBe(88.5)
				const joined = (o: ChainOutput[]): ChainOutput => ({
					pcm: concat(o.map(x => x.pcm)),
					tone: concat(o.map(x => x.tone)),
				})
				expect(verdicts(joined(wasm))).toEqual(verdicts(joined(js)))
			},
			120_000,
		)

		it("the high-pass off option matches too", () => {
			const fs = 1_024_000
			const src = new NfmSource({ fs, offsetHz: 50_000 })
			const cu8 = src.next(fs, true)
			const { runtime } = testRuntime()
			const opts = { inputRateHz: fs, offsetHz: 50_000, highPass: false }
			const js = runChain(new WidebandNfmChain(opts), cu8, () => 25_600)
			const wasm = runChain(wasmChain(runtime, opts), cu8, () => 9_999)
			expect(lsbDiff(js.pcm, wasm.pcm).max).toBeLessThanOrEqual(1)
			expect(lsbDiff(js.tone, wasm.tone).max).toBeLessThanOrEqual(1)
		})

		it("other rates: 64 kHz (k · m = 1), 250 kHz and 3.2 Msps stay within ±1 LSB", () => {
			for (const fs of [64_000, 250_000, 3_200_000]) {
				const offsetHz = fs / 8
				const src = new NfmSource({ fs, offsetHz, syllables: true })
				const cu8 = src.next(Math.round(0.8 * fs), true)
				const { runtime } = testRuntime()
				const js = runChain(
					new WidebandNfmChain({ inputRateHz: fs, offsetHz }),
					cu8,
					() => 25_000,
				)
				const chain = wasmChain(runtime, { inputRateHz: fs, offsetHz })
				const wasm = runChain(chain, cu8, () => MAX_SLICE_SAMPLES)
				expect(widebandNfmChainPath(chain)).toBe("wasm")
				const d = lsbDiff(js.pcm, wasm.pcm)
				evidence(`rate ${fs}: pcm max ${d.max} (${d.differing} differ)`)
				expect(d.max).toBeLessThanOrEqual(1)
				expect(lsbDiff(js.tone, wasm.tone).max).toBeLessThanOrEqual(1)
			}
		}, 120_000)

		it("chunk splits do not change the wasm chain's output (property)", () => {
			// Feature: wideband-nfm-wasm, Property 1: chunk-split invariance
			// Validates: the wasm chain's state carries across process calls exactly
			const fs = 1_024_000
			const offsetHz = -62_500
			const cu8 = new NfmSource({ fs, offsetHz, syllables: true }).next(
				Math.round(0.35 * fs),
				true,
			)
			const { runtime } = testRuntime()
			const whole = runChain(
				wasmChain(runtime, { inputRateHz: fs, offsetHz }),
				cu8,
				() => MAX_SLICE_SAMPLES,
			)
			const js = runChain(
				new WidebandNfmChain({ inputRateHz: fs, offsetHz }),
				cu8,
				() => 25_600,
			)
			expect(lsbDiff(js.pcm, whole.pcm).max).toBeLessThanOrEqual(1)
			fc.assert(
				fc.property(
					fc.array(fc.integer({ min: 1, max: MAX_SLICE_SAMPLES }), {
						minLength: 1,
						maxLength: 40,
					}),
					fc.integer({ min: 1, max: 64 }),
					(sizes, small) => {
						// Mostly the drawn sizes, with runs of tiny slices between them.
						const chunks = sizes.flatMap(s => [s, small, 1])
						const split = runChain(
							wasmChain(runtime, { inputRateHz: fs, offsetHz }),
							cu8,
							i => chunks[i % chunks.length]!,
						)
						expect(split.pcm).toEqual(whole.pcm)
						expect(split.tone).toEqual(whole.tone)
					},
				),
				{ numRuns: 100 },
			)
			expect(runtime.faults).toBe(0)
		}, 300_000)
	},
)
