/**
 * The wasm NFM chain's runtime: path selection and its one log line, fault isolation (a real wasm
 * trap and a kernel error code), the per-process fault bound, the fixed memory per chain and that
 * nothing retains a chain after its session drops it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import v8 from "node:v8"
import vm from "node:vm"
import { afterAll, describe, expect, it } from "vitest"
import {
	NFM_RESERVED_PAGES,
	nfmKernelLayout,
	nfmOutCap,
	recorderDspChoice,
} from "../../../../../src/core/scanner/channel/wideband-nfm-wasm.js"
import {
	MAX_SLICE_SAMPLES,
	NFM_WASM_MAX_FAULTS,
	WidebandNfmChain,
	chooseFactors,
	createWidebandNfmChain,
	discriminatorTables,
	widebandNfmChainPath,
	widebandNfmKernelForTest,
} from "../../../../../src/core/scanner/channel/wideband-nfm.js"
import type { WidebandNfmChain as Chain } from "../../../../../src/core/scanner/channel/wideband-nfm.js"
import { FmAudioDemod } from "../../../../../src/core/scanner/channel/fm-audio.js"
import { NfmSource } from "../wideband-nfm-fixtures.js"
import {
	WASM_LABEL,
	lsbDiff,
	nfmWasmAvailable,
	runChain,
	testRuntime,
	wasmChain,
} from "./nfm-wasm-harness.js"

const FS = 1_024_000
const OPTS = { inputRateHz: FS, offsetHz: 93_750 }
const SLICE = 25_600

const tmp = mkdtempSync(path.join(os.tmpdir(), "wk-nfm-runtime-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function kernel(chain: Chain) {
	const k = widebandNfmKernelForTest(chain)
	if (!k) throw new Error("no kernel")
	return k
}

describe("wideband NFM chain selection", () => {
	it("reads WAVEKIT_RECORDER_DSP as auto unless js or wasm", () => {
		expect(recorderDspChoice(undefined)).toBe("auto")
		expect(recorderDspChoice("js")).toBe("js")
		expect(recorderDspChoice("wasm")).toBe("wasm")
		expect(recorderDspChoice("WASM")).toBe("auto")
	})

	it("js: JS chains, the path logged once with the reason", () => {
		const { runtime, log } = testRuntime("js")
		const a = runtime.chain(OPTS)
		const b = createWidebandNfmChain(OPTS, runtime)
		expect(a).toBeInstanceOf(WidebandNfmChain)
		expect(widebandNfmChainPath(a)).toBe("js")
		expect(widebandNfmChainPath(b)).toBe("js")
		expect(log.lines).toEqual([
			{
				level: "info",
				obj: { path: "js", reason: "WAVEKIT_RECORDER_DSP=js" },
				msg: "wideband NFM chain path",
			},
		])
	})

	it("a missing artefact gives JS (info under auto, a warning when wasm was asked for)", () => {
		const missing = path.join(tmp, "absent.wasm")
		const auto = testRuntime("auto", missing)
		expect(widebandNfmChainPath(auto.runtime.chain(OPTS))).toBe("js")
		expect(auto.log.lines).toEqual([
			{
				level: "info",
				obj: { path: "js", reason: "wideband-nfm.wasm not found" },
				msg: "wideband NFM chain path",
			},
		])
		const wanted = testRuntime("wasm", missing)
		wanted.runtime.chain(OPTS)
		wanted.runtime.chain(OPTS)
		expect(wanted.log.lines).toHaveLength(1)
		expect(wanted.log.lines[0]!.level).toBe("warn")
	})

	it("an invalid artefact gives JS with the reason", () => {
		const junk = path.join(tmp, "junk.wasm")
		writeFileSync(junk, Buffer.from("not wasm"))
		const { runtime, log } = testRuntime("auto", junk)
		expect(widebandNfmChainPath(runtime.chain(OPTS))).toBe("js")
		expect(log.lines[0]!.obj).toEqual({
			path: "js",
			reason: "the module does not validate here (no wasm SIMD?)",
		})
	})

	it("refuses the options the JS chain refuses, on either path", () => {
		const { runtime } = testRuntime()
		expect(() => runtime.chain({ inputRateHz: 40_000, offsetHz: 0 })).toThrow()
		expect(() => runtime.chain({ inputRateHz: FS, offsetHz: FS })).toThrow()
		expect(runtime.faults).toBe(0)
	})

	it("the discriminator tables are fm-audio.ts's, bit for bit", () => {
		const demod = new FmAudioDemod() as unknown as {
			taps: Float64Array
			scale: number
			alpha: number
		}
		const t = discriminatorTables()
		expect(Array.from(t.taps)).toEqual(Array.from(demod.taps))
		expect(t.scale).toBe(demod.scale)
		expect(t.alpha).toBe(demod.alpha)
	})

	it("memory per chain: fixed pages from the factors and MAX_SLICE_SAMPLES", () => {
		for (const [fs, pages] of [
			[64_000, 8],
			[1_024_000, 7],
			[2_400_000, 7],
		] as const) {
			const { k, m } = chooseFactors(fs)
			const dims = {
				k,
				m,
				stage2Taps: 10 * m + 1,
				channelTaps: 63,
				demodTaps: 127,
				maxIn: MAX_SLICE_SAMPLES,
			}
			const l = nfmKernelLayout(dims)
			expect(l.ctl).toBe(NFM_RESERVED_PAGES * 65_536)
			expect(l.pages).toBe(pages)
			// pcm frames: at most one 48 kHz sample per r sample, 6:1, carries included
			expect(nfmOutCap(dims)).toBe(
				Math.floor((5 + Math.ceil(MAX_SLICE_SAMPLES / (k * m)) + 2) / 6) + 1,
			)
		}
	})
})

describe.skipIf(!nfmWasmAvailable)(
	`wideband NFM wasm runtime (${WASM_LABEL})`,
	() => {
		it("auto with the artefact: a wasm chain, logged once", () => {
			const { runtime, log } = testRuntime()
			const chain = runtime.chain(OPTS)
			runtime.chain(OPTS)
			expect(widebandNfmChainPath(chain)).toBe("wasm")
			expect(chain).toBeInstanceOf(WidebandNfmChain)
			expect(log.lines).toEqual([
				{
					level: "info",
					obj: {
						path: "wasm",
						reason: "the kernel validated and instantiated",
					},
					msg: "wideband NFM chain path",
				},
			])
		})

		it("rejects an odd or oversized slice as the JS chain does, without a fault", () => {
			const { runtime } = testRuntime()
			const chain = wasmChain(runtime, OPTS)
			expect(() => chain.process(new Uint8Array(3))).toThrow(
				"Invalid wideband NFM slice",
			)
			expect(() =>
				chain.process(new Uint8Array(2 * (MAX_SLICE_SAMPLES + 1))),
			).toThrow("Invalid wideband NFM slice")
			const full = new Uint8Array(2 * MAX_SLICE_SAMPLES).fill(127)
			expect(chain.process(full)).toEqual(
				new WidebandNfmChain(OPTS).process(full),
			)
			expect(chain.process(new Uint8Array(0)).length).toBe(0)
			expect(widebandNfmChainPath(chain)).toBe("wasm")
			expect(runtime.faults).toBe(0)
		})

		it("a trap mid-session: no throw, the chain continues in JS from the slice's start state", () => {
			const { runtime, log } = testRuntime()
			const src = new NfmSource({
				fs: FS,
				offsetHz: OPTS.offsetHz,
				syllables: true,
			})
			const head = src.next(Math.round(0.5 * FS), true)
			const tail = src.next(Math.round(0.5 * FS), true)
			const chain = wasmChain(runtime, OPTS)
			const before = runChain(chain, head, () => SLICE)
			const refChain = new WidebandNfmChain(OPTS)
			const ref = runChain(refChain, head, () => SLICE)
			expect(lsbDiff(ref.pcm, before.pcm).max).toBeLessThanOrEqual(1)
			kernel(chain).trapNextRunForTest()
			const after = runChain(chain, tail, () => SLICE)
			expect(widebandNfmChainPath(chain)).toBe("js")
			// No transient: the faulted slice and the rest match a JS chain that ran the whole
			// stream (wideband-nfm-wasm-handover.test.ts covers the rates and fault points).
			const cont = runChain(refChain, tail, () => SLICE)
			expect(lsbDiff(cont.pcm, after.pcm).max).toBeLessThanOrEqual(1)
			expect(lsbDiff(cont.tone, after.tone).max).toBeLessThanOrEqual(1)
			expect(runtime.faults).toBe(1)
			const warns = log.lines.filter(l => l.level === "warn")
			expect(warns).toEqual([
				{
					level: "warn",
					obj: {
						cause: "trap",
						error: "RuntimeError",
						k: 7,
						m: 3,
						handover: "state",
						faults: 1,
						maxFaults: NFM_WASM_MAX_FAULTS,
					},
					msg: "wideband NFM wasm fault: the chain continues in JS",
				},
			])
		})

		it("a kernel error code is a fault too (cause status)", () => {
			const { runtime, log } = testRuntime()
			const chain = wasmChain(runtime, OPTS)
			kernel(chain).failForTest(3)
			const src = new NfmSource({ fs: FS, offsetHz: OPTS.offsetHz })
			const cu8 = src.next(SLICE, true)
			const pcm = chain.process(cu8)
			expect(pcm).toEqual(new WidebandNfmChain(OPTS).process(cu8))
			expect(widebandNfmChainPath(chain)).toBe("js")
			expect(log.lines.at(-1)!.obj).toMatchObject({
				cause: "status",
				error: "NFM kernel run: state",
			})
		})

		it(`after ${NFM_WASM_MAX_FAULTS} faults a process makes JS chains only (logged once)`, () => {
			const { runtime, log } = testRuntime()
			const chains = Array.from({ length: NFM_WASM_MAX_FAULTS + 1 }, () =>
				wasmChain(runtime, OPTS),
			)
			const cu8 = new NfmSource({ fs: FS, offsetHz: OPTS.offsetHz }).next(
				SLICE,
				true,
			)
			for (const c of chains) {
				kernel(c).trapNextRunForTest()
				expect(() => c.process(cu8)).not.toThrow()
				expect(widebandNfmChainPath(c)).toBe("js")
			}
			expect(runtime.faults).toBe(NFM_WASM_MAX_FAULTS + 1)
			expect(runtime.disabled).toBe(true)
			expect(widebandNfmChainPath(runtime.chain(OPTS))).toBe("js")
			const warns = log.lines.filter(l => l.level === "warn")
			// one line per fault up to the bound, then the bound's line once; the 4th fault is silent
			expect(warns.map(w => w.msg)).toEqual([
				"wideband NFM wasm fault: the chain continues in JS",
				"wideband NFM wasm fault: the chain continues in JS",
				"wideband NFM wasm fault: the chain continues in JS",
				"wideband NFM wasm disabled for this process: new chains run in JS",
			])
		})

		it("memory stays fixed over many slices, including full MAX_SLICE_SAMPLES ones at k · m = 1", () => {
			const { runtime } = testRuntime()
			for (const fs of [64_000, FS, 2_400_000]) {
				const chain = wasmChain(runtime, { inputRateHz: fs, offsetHz: fs / 10 })
				const k = kernel(chain)
				const bytes = k.memoryBytes
				expect(bytes).toBe(k.layout.pages * 65_536)
				const src = new NfmSource({ fs, offsetHz: fs / 10 })
				for (let i = 0; i < 6; i++) {
					const pcm = chain.process(src.next(MAX_SLICE_SAMPLES, true))
					expect(pcm.length).toBeLessThanOrEqual(k.outCap)
					expect(k.memoryBytes).toBe(bytes)
				}
				expect(widebandNfmChainPath(chain)).toBe("wasm")
			}
			expect(runtime.faults).toBe(0)
		}, 60_000)

		it("1000 chains made and dropped: none is retained", async () => {
			v8.setFlagsFromString("--expose-gc")
			const gc = vm.runInNewContext("gc") as () => void
			const { runtime } = testRuntime()
			const cu8 = new NfmSource({ fs: FS, offsetHz: OPTS.offsetHz }).next(
				4096,
				true,
			)
			const refs: WeakRef<object>[] = []
			for (let i = 0; i < 1000; i++) {
				const chain = wasmChain(runtime, OPTS)
				chain.process(cu8)
				if (i % 50 === 0) refs.push(new WeakRef(chain))
			}
			for (let round = 0; round < 5; round++) {
				await new Promise(resolve => setImmediate(resolve))
				gc()
			}
			expect(refs.filter(r => r.deref() !== undefined)).toHaveLength(0)
			expect(runtime.faults).toBe(0)
		}, 60_000)
	},
)
