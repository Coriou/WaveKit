/**
 * The wasm NFM chain's fault handover: after a trap or a kernel error the chain continues in JS
 * from the kernel's state at the start of the faulted slice and runs that slice again, so its
 * output matches a JS chain that ran the whole stream (the reference), not a fresh one. Checked
 * field by field (`NfmKernel.state` against `WidebandNfmChain.handoverState`), on the output at
 * 48 kHz (the exact resampler path), 64 kHz (k · m = 1), 1.024 and 2.4 Msps, and as a property
 * over random fault points and chunk splits.
 */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { NfmChainState } from "../../../../../src/core/scanner/channel/wideband-nfm-wasm.js"
import {
	MAX_SLICE_SAMPLES,
	WidebandNfmChain,
	widebandNfmChainPath,
	widebandNfmKernelForTest,
} from "../../../../../src/core/scanner/channel/wideband-nfm.js"
import type { WidebandNfmOptions } from "../../../../../src/core/scanner/channel/wideband-nfm.js"
import { NfmSource } from "../wideband-nfm-fixtures.js"
import {
	WASM_LABEL,
	concat,
	lsbDiff,
	nfmWasmAvailable,
	runChain,
	testRuntime,
	wasmChain,
} from "./nfm-wasm-harness.js"
import type { ChainOutput } from "./nfm-wasm-harness.js"

const RATES = [48_000, 64_000, 1_024_000, 2_400_000] as const

function opts(fs: number, highPass = true): WidebandNfmOptions {
	return {
		inputRateHz: fs,
		offsetHz: fs === 1_024_000 || fs === 2_400_000 ? 93_750 : fs / 10,
		...(highPass ? {} : { highPass: false }),
	}
}

function scene(fs: number, seconds: number, seed = 7): Uint8Array {
	const o = opts(fs)
	return new NfmSource({
		fs,
		offsetHz: o.offsetHz,
		syllables: true,
		seed,
	}).next(Math.round(seconds * fs), true)
}

function kernelOf(chain: WidebandNfmChain) {
	const k = widebandNfmKernelForTest(chain)
	if (!k) throw new Error("no kernel")
	return k
}

/**
 * Runs `cu8` through `chain` in slices of `lengths` (in IQ pairs, cycled); the kernel traps on the
 * slice with index `faultAt` (null: never). Returns the output and the frame where the faulted
 * slice's output starts.
 */
function runWithFault(
	chain: WidebandNfmChain,
	cu8: Uint8Array,
	lengths: readonly number[],
	faultAt: number | null,
): ChainOutput & { faultFrame: number } {
	const pcm: Int16Array[] = []
	const tone: Int16Array[] = []
	let faultFrame = -1
	let frames = 0
	const n = cu8.length / 2
	for (let i = 0, at = 0; at < n; i++) {
		const len = Math.min(lengths[i % lengths.length]!, n - at)
		if (i === faultAt) {
			kernelOf(chain).trapNextRunForTest()
			faultFrame = frames
		}
		const p = chain.process(cu8.subarray(2 * at, 2 * (at + len)))
		pcm.push(p)
		tone.push(chain.toneAudio().slice())
		frames += p.length
		at += len
	}
	return { pcm: concat(pcm), tone: concat(tone), faultFrame }
}

const STAGE1 = ["phRe", "phIm", "curRe", "curIm", "nxtRe", "nxtIm"] as const
const INTS = [
	"phase",
	"sinceRenorm",
	"s2Phase",
	"s2Head",
	"chHead",
	"dmHead",
	"dmPhase",
] as const
const FLOATS = ["frac", "prevRe", "prevIm", "lastI", "lastQ", "deemph"] as const
const LINES = ["s2Line", "chLine", "dmHist"] as const

/** Largest |a − b| relative to max(1, |a|) over a state's float fields and lines. */
function stateDiff(
	a: NfmChainState,
	b: NfmChainState,
	highPass: boolean,
): number {
	let worst = 0
	const at = (x: number, y: number): void => {
		worst = Math.max(worst, Math.abs(x - y) / Math.max(1, Math.abs(x)))
	}
	for (const f of FLOATS) at(a[f], b[f])
	for (const f of LINES) {
		expect(a[f].length).toBe(b[f].length)
		for (let i = 0; i < a[f].length; i++) at(a[f][i]!, b[f][i]!)
	}
	for (let i = highPass ? 0 : 8; i < 16; i++) at(a.biquads[i]!, b.biquads[i]!)
	return worst
}

describe("WidebandNfmChain.adoptHandoverState bounds", () => {
	const fs = 1_024_000
	const base = (): NfmChainState => {
		const c = new WidebandNfmChain(opts(fs))
		c.process(scene(fs, 0.05))
		return c.handoverState()
	}
	const { k, m } = new WidebandNfmChain(opts(fs)).factors

	it("accepts every field at its last valid value and maps it back unchanged", () => {
		const s = base()
		s.phase = k - 1
		s.s2Phase = m - 1
		s.sinceRenorm = 4095
		s.s2Head = s.s2Line.length / 2 - 1
		s.chHead = s.chLine.length / 2 - 1
		s.dmHead = s.dmHist.length - 1
		s.dmPhase = 5
		s.frac = 0
		const c = new WidebandNfmChain(opts(fs))
		expect(c.adoptHandoverState(s)).toBe(true)
		expect(c.handoverState()).toEqual(s)
		// frac just below the step (r / 48 kHz) is in range too
		const step = c.factors.rateHz / 48_000
		expect(c.adoptHandoverState({ ...s, frac: step - 2 ** -40 })).toBe(true)
	})

	it("refuses a state past any bound and writes nothing", () => {
		const good = base()
		const c = new WidebandNfmChain(opts(fs))
		const before = c.handoverState()
		const step = c.factors.rateHz / 48_000
		const bad: Partial<NfmChainState>[] = [
			{ phase: k },
			{ phase: -1 },
			{ phase: 0.5 },
			{ s2Phase: m },
			{ sinceRenorm: 4096 },
			{ s2Head: good.s2Line.length / 2 },
			{ chHead: good.chLine.length / 2 },
			{ dmHead: good.dmHist.length },
			{ dmPhase: 6 },
			{ frac: step },
			{ frac: -(2 ** -40) },
			{ phRe: Number.NaN },
			{ deemph: Number.POSITIVE_INFINITY },
			{ s2Line: new Float64Array(good.s2Line.length - 2) },
			{ chLine: new Float64Array(good.chLine.length + 2) },
			{ dmHist: new Float64Array(good.dmHist.length).fill(Number.NaN) },
			{ biquads: new Float64Array(12) },
		]
		for (const b of bad) {
			expect(c.adoptHandoverState({ ...good, ...b })).toBe(false)
			expect(c.handoverState()).toEqual(before)
		}
	})
})

describe.skipIf(!nfmWasmAvailable)(
	`wideband NFM wasm fault handover (${WASM_LABEL})`,
	() => {
		it("kernel state maps field by field onto a JS chain driven over the same input", () => {
			const { runtime } = testRuntime()
			for (const fs of RATES)
				for (const highPass of fs === 1_024_000 ? [true, false] : [true]) {
					const o = opts(fs, highPass)
					const cu8 = scene(fs, 0.3)
					const ref = new WidebandNfmChain(o)
					const chain = wasmChain(runtime, o)
					// slices that end mid-block: every stage carries something across the boundary
					const lengths = [9_999, 4_097, 1, 777]
					runWithFault(ref, cu8, lengths, null)
					runWithFault(chain, cu8, lengths, null)
					const kernel = kernelOf(chain)
					const ks = kernel.state("now")
					const js = ref.handoverState()
					for (const f of INTS) expect([fs, f, ks[f]]).toEqual([fs, f, js[f]])
					// stage 1 is bit for bit
					for (const f of STAGE1) expect([fs, f, ks[f]]).toEqual([fs, f, js[f]])
					expect(stateDiff(js, ks, highPass)).toBeLessThan(1e-12)
					// a JS chain that adopts the kernel's state holds exactly that state
					const adopted = new WidebandNfmChain(o)
					expect(adopted.adoptHandoverState(ks)).toBe(true)
					const back = adopted.handoverState()
					if (highPass) expect(back).toEqual(ks)
					else
						expect({ ...back, biquads: back.biquads.slice(8) }).toEqual({
							...ks,
							biquads: ks.biquads.slice(8),
						})
					// the snapshot of the next slice is the state the last one left
					chain.process(cu8.subarray(0, 2 * 1234))
					expect(kernel.state("slice-start")).toEqual(ks)
					// and the adopted chain continues as the reference does
					const more = scene(fs, 0.2, 11)
					const a = runChain(adopted, more, () => 3_000)
					const r = runChain(ref, more, () => 3_000)
					expect(lsbDiff(r.pcm, a.pcm).max).toBe(0)
					expect(lsbDiff(r.tone, a.tone).max).toBe(0)
				}
			expect(runtime.faults).toBe(0)
		}, 60_000)

		it("2.4 Msps: 59 999 samples, a trap, 1 sample: the frame the carries complete is kept", () => {
			const fs = 2_400_000
			const { runtime, log } = testRuntime()
			const cu8 = scene(fs, 0.03)
			const ref = new WidebandNfmChain(opts(fs))
			const chain = wasmChain(runtime, opts(fs))
			const head = cu8.subarray(0, 2 * 59_999)
			const last = cu8.subarray(2 * 59_999, 2 * 60_000)
			expect(chain.process(head)).toEqual(ref.process(head))
			const s = kernelOf(chain).state("now")
			// carries at the boundary: the triangle, stage 2 and the discriminator's 6:1
			expect(s.phase).toBeGreaterThan(0)
			expect(s.dmPhase).toBeGreaterThan(0)
			kernelOf(chain).trapNextRunForTest()
			const want = ref.process(last)
			expect(want.length).toBe(1)
			const got = chain.process(last)
			expect(widebandNfmChainPath(chain)).toBe("js")
			expect(got).toEqual(want)
			expect(chain.toneAudio()).toEqual(ref.toneAudio())
			expect(log.lines.at(-1)!.obj).toMatchObject({
				cause: "trap",
				handover: "state",
				k: 10,
				m: 5,
			})
		})

		it("1.024 Msps syllabic voice, a trap after 512 001 samples: the next 512 000 match a warmed JS chain", () => {
			const fs = 1_024_000
			const { runtime } = testRuntime()
			const cu8 = scene(fs, 1_024_001 / fs)
			const ref = new WidebandNfmChain(opts(fs))
			const chain = wasmChain(runtime, opts(fs))
			const head = cu8.subarray(0, 2 * 512_001)
			const tail = cu8.subarray(2 * 512_001)
			const step = () => 25_600
			runChain(ref, head, step)
			runChain(chain, head, step)
			kernelOf(chain).trapNextRunForTest()
			const want = runChain(ref, tail, step)
			const got = runChain(chain, tail, step)
			expect(widebandNfmChainPath(chain)).toBe("js")
			expect(got.pcm.length).toBe(want.pcm.length)
			expect(lsbDiff(want.pcm, got.pcm)).toEqual({ max: 0, differing: 0 })
			expect(lsbDiff(want.tone, got.tone)).toEqual({ max: 0, differing: 0 })
		})

		it("traps at slice 1, mid-stream and right after a slice ending with carries, at every rate", () => {
			for (const fs of RATES) {
				// 180 000 samples: 7 slices of these lengths (an odd 1-sample slice, a full one)
				const cu8 = scene(fs, 180_000 / fs)
				const lengths = [7_001, 12_345, 1, 3_333, MAX_SLICE_SAMPLES]
				const ref = runChain(new WidebandNfmChain(opts(fs)), cu8, () => 50_000)
				for (const faultAt of [0, 1, 2, 3, 4, 6]) {
					const { runtime, log } = testRuntime()
					const chain = wasmChain(runtime, opts(fs))
					const out = runWithFault(chain, cu8, lengths, faultAt)
					expect(out.faultFrame).toBeGreaterThanOrEqual(0)
					expect(widebandNfmChainPath(chain)).toBe("js")
					expect(lsbDiff(ref.pcm, out.pcm).max).toBe(0)
					expect(lsbDiff(ref.tone, out.tone).max).toBe(0)
					expect(log.lines.at(-1)!.obj).toMatchObject({ handover: "state" })
				}
			}
		}, 60_000)

		it("a kernel error code mid-stream hands over the same way (cause status)", () => {
			const fs = 1_024_000
			const { runtime, log } = testRuntime()
			const cu8 = scene(fs, 0.2)
			const ref = runChain(new WidebandNfmChain(opts(fs)), cu8, () => 25_600)
			const chain = wasmChain(runtime, opts(fs))
			const head = runChain(chain, cu8.subarray(0, 2 * 100_001), () => 25_600)
			kernelOf(chain).failForTest(5)
			const tail = runChain(chain, cu8.subarray(2 * 100_001), () => 25_600)
			expect(concat([head.pcm, tail.pcm])).toEqual(ref.pcm)
			expect(concat([head.tone, tail.tone])).toEqual(ref.tone)
			expect(log.lines.at(-1)!.obj).toMatchObject({
				cause: "status",
				error: "NFM kernel run: output",
				handover: "state",
			})
		})

		it("a state the kernel left out of range is refused: the slice runs on a fresh JS chain (handover reset)", () => {
			const fs = 1_024_000
			const { runtime, log } = testRuntime()
			const cu8 = scene(fs, 0.1)
			const chain = wasmChain(runtime, opts(fs))
			chain.process(cu8.subarray(0, 2 * 10_001))
			const kernel = kernelOf(chain)
			// A corrupted phase in the kernel's control block (slot 12): nfm_run refuses it (E_STATE)
			// and the slice-start copy holds it too.
			const ctl = (kernel as unknown as { ctlU32: Uint32Array }).ctlU32
			ctl[12] = chain.factors.k
			const rest = cu8.subarray(2 * 10_001)
			const got = chain.process(rest)
			expect(got).toEqual(new WidebandNfmChain(opts(fs)).process(rest))
			expect(log.lines.at(-1)!.obj).toMatchObject({
				cause: "status",
				error: "NFM kernel run: state",
				handover: "reset",
			})
		})

		it("the inherited JS buffers are made on fallback only", () => {
			for (const fs of RATES) {
				const { runtime } = testRuntime()
				const chain = wasmChain(runtime, opts(fs))
				const cu8 = scene(fs, 0.2)
				runChain(chain, cu8, () => MAX_SLICE_SAMPLES)
				expect(chain.jsBufferBytes).toBe(0)
				const outCap = kernelOf(chain).outCap
				kernelOf(chain).trapNextRunForTest()
				chain.process(cu8.subarray(0, 2 * MAX_SLICE_SAMPLES))
				const { k, m } = chain.factors
				const demodIn = 8 * (Math.ceil(MAX_SLICE_SAMPLES / (k * m)) + 2)
				// the 48 kHz buffer, and the tone copy of at most one call's frames
				expect(chain.jsBufferBytes).toBeGreaterThan(demodIn)
				expect(chain.jsBufferBytes).toBeLessThanOrEqual(demodIn + 2 * outCap)
			}
		}, 60_000)

		it("snapshot bytes per chain (copied once per process call)", () => {
			const { runtime } = testRuntime()
			const bytes = RATES.map(fs => {
				const kernel = kernelOf(wasmChain(runtime, opts(fs)))
				return [fs, kernel.snapshotBytes, kernel.memoryBytes]
			})
			expect(bytes).toEqual([
				[48_000, 6_512, 524_288],
				[64_000, 6_512, 524_288],
				[1_024_000, 7_152, 458_752],
				[2_400_000, 7_792, 458_752],
			])
		})

		it("property: random chunk splits and a random fault slice match the JS reference", () => {
			const rates = [64_000, 1_024_000, 2_400_000] as const
			const inputs = rates.map(fs => scene(fs, 0.15, 3))
			const refs = rates.map((fs, i) =>
				runChain(new WidebandNfmChain(opts(fs)), inputs[i]!, () => 40_000),
			)
			/** Slice count of `lengths` (cycled) over `n` IQ pairs. */
			const slices = (lengths: readonly number[], n: number): number => {
				let count = 0
				for (let at = 0; at < n; count++) at += lengths[count % lengths.length]!
				return count
			}
			// Feature: wideband-nfm-wasm, Property: fault handover continuity
			fc.assert(
				fc.property(
					fc.integer({ min: 0, max: rates.length - 1 }).chain(r =>
						fc.tuple(
							fc.constant(r),
							// tiny slices (carries at every boundary) and up to 100 ms ones
							fc.array(
								fc.oneof(
									fc.integer({ min: 1, max: 16 }),
									fc.integer({
										min: 1,
										max: Math.min(MAX_SLICE_SAMPLES, rates[r]! / 10),
									}),
								),
								{ minLength: 1, maxLength: 12 },
							),
							fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
						),
					),
					([r, lengths, where]) => {
						const cu8 = inputs[r]!
						const faultAt = Math.floor(where * slices(lengths, cu8.length / 2))
						const { runtime } = testRuntime()
						const chain = wasmChain(runtime, opts(rates[r]!))
						const out = runWithFault(chain, cu8, lengths, faultAt)
						const ref = refs[r]!
						return (
							runtime.faults === 1 &&
							widebandNfmChainPath(chain) === "js" &&
							lsbDiff(ref.pcm, out.pcm).max <= 1 &&
							lsbDiff(ref.tone, out.tone).max <= 1
						)
					},
				),
				{ numRuns: 100 },
			)
		}, 120_000)
	},
)
